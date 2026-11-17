// End-to-end test of the watcher: a real server on a temporary profile reacts to file changes with targeted
// partial indexes, and events that arrive while an index is running are not lost.
// Uso: node scripts/test-index-watch.mjs — cartelle, profilo e porta temporanei; l'app installata non viene toccata.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const app = join(import.meta.dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'vb-watch-'));
const root = join(tmp, 'root');
const profile = join(tmp, 'profile');
mkdirSync(join(root, 'proj/src'), { recursive: true });
mkdirSync(join(root, 'other'), { recursive: true });
mkdirSync(profile);
writeFileSync(join(root, 'proj/package.json'), '{"name":"proj"}');
writeFileSync(join(root, 'proj/src/a.ts'), 'import "./b.ts";\n');
writeFileSync(join(root, 'proj/src/b.ts'), 'export const b = 1;\n');
writeFileSync(join(root, 'other/notes.md'), '# notes\n');
writeFileSync(join(profile, 'settings.json'), JSON.stringify({ roots: [root], language: 'en', setupComplete: true }));

const port = await new Promise((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
let logs = '';
const child = spawn(process.execPath, ['src/cli.ts', 'serve', '--port', String(port)], {
  cwd: app, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, VISUAL_BRAIN_DATA_DIR: profile, VISUAL_BRAIN_LANGUAGE: 'en', VB_ENGINE: process.env.VB_ENGINE || 'ts',
    // structural changes wait for a quiet spell and a gap after the last such pass: seconds here, minutes in the app
    VB_WATCH_STRUCTURAL_QUIET_MS: '300', VB_WATCH_STRUCTURAL_GAP_MS: '4000', VB_WATCH_STRUCTURAL_MAX_MS: '8000' },
});
child.stdout.on('data', (d) => { logs += d; });
child.stderr.on('data', (d) => { logs += d; });

const api = async (path) => (await fetch(`http://127.0.0.1:${port}${path}`)).json();
const waitFor = async (what, fn, ms = 20000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}\n${logs.slice(-1500)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};
let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  await waitFor('server up', async () => { try { return (await fetch(`http://127.0.0.1:${port}/api/health`)).ok; } catch { return false; } });
  // each finished run logs one `[index] N voci` line
  const doneCount = () => (logs.match(/\[index\] \d+ voci/g) ?? []).length;
  await waitFor('first index', () => doneCount() >= 1);
  const indexLines = () => [...logs.matchAll(/\[index\] (\d+) voci/g)].map((m) => Number(m[1]));
  const firstSeen = indexLines()[0];
  ok(firstSeen >= 8, `initial index reads the whole tree (${firstSeen} entries)`);

  // one file changed: a partial index of a single entry, not of the whole tree
  const before = doneCount();
  appendFileSync(join(root, 'proj/src/b.ts'), 'export const c = 2;\n');
  await waitFor('partial index after edit', () => doneCount() > before);
  const edit = indexLines().at(-1);
  ok(edit < firstSeen && edit <= 2, `a one-file edit reindexes ${edit} entries, not ${firstSeen}`);

  // a burst of events collapses into one run; a new nested folder is picked up and attached to its parent
  const burstBefore = doneCount();
  for (let i = 0; i < 20; i++) writeFileSync(join(root, 'other', `f${i}.md`), `# ${i}\n`);
  mkdirSync(join(root, 'proj/new/deeper'), { recursive: true });
  writeFileSync(join(root, 'proj/new/deeper/z.ts'), 'export const z = 1;\n');
  await waitFor('burst indexed', async () => {
    const r = await api(`/api/search?q=${encodeURIComponent('f19.md')}`).catch(() => null);
    return doneCount() > burstBefore && JSON.stringify(r ?? {}).includes('f19.md');
  });
  const runs = doneCount() - burstBefore;
  ok(runs <= 2, `21 writes became ${runs} index run(s)`);
  const z = await waitFor('nested file searchable', async () => { const r = await api(`/api/search?q=${encodeURIComponent('z.ts')}`); return JSON.stringify(r).includes('z.ts'); });
  ok(z, 'a file in a new nested folder is indexed');

  // a deletion is a tombstone: no walk, the node disappears
  const delBefore = doneCount();
  rmSync(join(root, 'other/notes.md'));
  await waitFor('deletion indexed', () => doneCount() > delBefore);
  ok(indexLines().at(-1) === 0, `a deleted file costs no walk (${indexLines().at(-1)} entries)`);

  // a new path right after a structural pass waits for the gap (agents create files all the time); a file that came and
  // went before the watcher looked (an editor's temporary copy) costs nothing
  const lateBefore = doneCount();
  writeFileSync(join(root, 'other/late.md'), '# late\n');
  writeFileSync(join(root, 'other/.late.md.tmp'), 'x'); rmSync(join(root, 'other/.late.md.tmp'));
  await new Promise((r) => setTimeout(r, 1800)); // past the old 1.2 s quiet period, short of the gap
  ok(doneCount() === lateBefore, 'a new file waits instead of starting a full pass at once');
  await waitFor('late file indexed', async () => JSON.stringify(await api(`/api/search?q=${encodeURIComponent('late.md')}`)).includes('late.md'));
  ok(doneCount() === lateBefore + 1, `the new file and the temporary one cost one pass (${doneCount() - lateBefore})`);

  // writes while an index is running are queued and applied afterwards
  const busyBefore = doneCount();
  appendFileSync(join(root, 'proj/src/a.ts'), 'export const busy = 1;\n');   // rewritten in place: indexed at once
  await new Promise((r) => setTimeout(r, 1500)); // quiet period elapsed: the run is in flight
  writeFileSync(join(root, 'other/second.md'), '# second\n');
  await waitFor('new file indexed', async () => JSON.stringify(await api(`/api/search?q=${encodeURIComponent('second.md')}`)).includes('second.md'));
  ok(doneCount() >= busyBefore + 2, 'a write during an index is not lost');
  console.log(`test-index-watch: ${checks} controlli ok`);
} finally {
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 300));
  rmSync(tmp, { recursive: true, force: true });
}
