// Responsiveness test: while a heavy index runs, HTTP, a live terminal (PTY heartbeat over the WebSocket) and writes
// to the same database (notes) must keep working. Runs the same load with the index in the worker and, for comparison,
// inline (VB_INDEX_INLINE=1). Uso: node scripts/test-index-responsive.mjs [--files N]
// Server, profilo, cartelle e porta sono temporanei; l'app installata e i dati reali non vengono toccati.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import WebSocket from 'ws';

const app = join(import.meta.dirname, '..');
const FILES = Number(process.argv[process.argv.indexOf('--files') + 1]) || 6000;
const MAX_STALL_MS = 500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

/** Synthetic TypeScript with imports, identifiers and long lines: enough extraction work to occupy a core for seconds. */
function source(i) {
  const lines = [`import { shared${i % 50} } from './mod${(i + 1) % 200}.ts';`, `import type { T${i % 30} } from '../lib/types.ts';`];
  for (let k = 0; k < 120; k++) lines.push(`export function handler_${i}_${k}(input: T${i % 30}, opt = '${'x'.repeat(40)}') { return shared${i % 50}(input) + "${'v'.repeat(30)}" + ${k}; } // see ./mod${k % 200}.ts`);
  return lines.join('\n') + '\n';
}

async function scenario(label, env) {
  const tmp = mkdtempSync(join(tmpdir(), 'vb-resp-'));
  const root = join(tmp, 'root');
  const profile = join(tmp, 'profile');
  let termId;
  mkdirSync(join(root, 'small'), { recursive: true });
  mkdirSync(profile);
  writeFileSync(join(root, 'small/readme.md'), '# small\n');
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({ roots: [root], language: 'en', setupComplete: true }));
  const port = await new Promise((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  let logs = '';
  const child = spawn(process.execPath, ['src/cli.ts', 'serve', '--port', String(port)], {
    cwd: app, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, VISUAL_BRAIN_DATA_DIR: profile, VISUAL_BRAIN_LANGUAGE: 'en', VB_ENGINE: 'ts', ...env },
  });
  child.stdout.on('data', (d) => { logs += d; });
  child.stderr.on('data', (d) => { logs += d; });
  const base = `http://127.0.0.1:${port}`;
  const get = async (path) => (await fetch(base + path)).json();
  const runs = () => (logs.match(/\[index\] \d+ voci/g) ?? []).length;
  const waitFor = async (what, fn, ms = 60000) => {
    const t0 = Date.now();
    for (;;) {
      if (await fn()) return;
      if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}\n${logs.slice(-1500)}`);
      await sleep(50);
    }
  };
  try {
    await waitFor('server up', async () => { try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; } }, 20000);
    await waitFor('first index', () => runs() >= 1);
    const node = await get(`/api/path?p=${encodeURIComponent(join(root, 'small'))}`);
    ok(node && node.id, 'the small tree is indexed');

    // a live terminal that prints a heartbeat about every 25 ms, independent of the server
    const launched = await (await fetch(`${base}/api/launch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: node.id, agent: 'shell', mode: 'embedded' }) })).json();
    termId = launched.info?.id;
    ok(termId, 'a shell terminal is open');
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/term?id=${termId}`, { headers: { origin: base } });
    await new Promise((r) => ws.once('open', r));
    const beats = [];
    ws.on('message', (d) => { if (String(d).includes('HB')) beats.push(Date.now()); });
    ws.send(JSON.stringify({ type: 'input', data: `perl -MTime::HiRes=usleep -e '$|=1; while(1){print "HB\\n"; usleep(25000)}'\r` }));
    await waitFor('heartbeat', () => beats.length > 10, 10000);

    // the load: thousands of new files appear; the watcher turns them into one heavy partial index
    const before = runs();
    mkdirSync(join(root, 'heavy/lib'), { recursive: true });
    writeFileSync(join(root, 'heavy/lib/types.ts'), 'export interface T0 {}\n');
    for (let i = 0; i < FILES; i++) writeFileSync(join(root, `heavy/mod${i % 200}-${i}.ts`), source(i));
    const t0 = Date.now();
    const health = [];
    const noteResults = [];
    let stop = false;
    const prober = (async () => {
      while (!stop) {
        const t = Date.now();
        try { await fetch(`${base}/api/health`); health.push(Date.now() - t); } catch { health.push(Infinity); }
        await sleep(20);
      }
    })();
    const noter = (async () => {
      let n = 0;
      while (!stop) {
        try {
          const r = await fetch(`${base}/api/nodes/${node.id}/notes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: `concurrent ${n++}`, origin: 'user' }) });
          noteResults.push(r.status);
        } catch { noteResults.push(0); }
        await sleep(15);
      }
    })();
    await waitFor('heavy index finished', () => runs() > before, 120000);
    await sleep(300);
    stop = true;
    await Promise.all([prober, noter]);
    const indexMs = Date.now() - t0;
    const gaps = beats.slice(1).map((t, i) => t - beats[i]).filter((_, i) => beats[i] >= t0);
    const stall = Math.max(0, ...gaps);
    const slowHealth = Math.max(0, ...health);
    const noteOk = noteResults.filter((s) => s === 201).length;
    const notes = (await get(`/api/node/${node.id}`)).notes.filter((n) => n.text.startsWith('concurrent')).length;
    console.log(`  ${label}: heavy cycle ${indexMs} ms · worst /api/health ${slowHealth} ms · worst terminal gap ${stall} ms · notes ${noteOk}/${noteResults.length} accepted, ${notes} stored`);
    ws.close();
    return { label, indexMs, stall, slowHealth, noteResults, noteOk, notes };
  } finally {
    // Server shutdown now preserves PTYs: explicitly close only this fixture's heartbeat terminal.
    if (termId) await fetch(`${base}/api/terminals/${termId}`, { method: 'DELETE', signal: AbortSignal.timeout(2000) }).catch(() => {});
    child.kill('SIGTERM');
    await sleep(300);
    rmSync(tmp, { recursive: true, force: true });
  }
}

const worker = await scenario('worker', { VB_INDEX_INLINE: '' });
ok(worker.indexMs > 1500, `the load is heavy enough to matter (${worker.indexMs} ms)`);
ok(worker.slowHealth < MAX_STALL_MS, `/api/health stays responsive while indexing (${worker.slowHealth} ms)`);
ok(worker.stall < MAX_STALL_MS, `the terminal heartbeat keeps flowing while indexing (worst gap ${worker.stall} ms)`);
ok(worker.noteResults.length > 3 && worker.noteOk === worker.noteResults.length, `every concurrent note write succeeded (${worker.noteOk}/${worker.noteResults.length})`);
ok(worker.notes === worker.noteOk, 'and every accepted note is stored');
if (!process.argv.includes('--no-compare')) await scenario('inline (before)', { VB_INDEX_INLINE: '1' });
console.log(`test-index-responsive: ${checks} controlli ok`);
