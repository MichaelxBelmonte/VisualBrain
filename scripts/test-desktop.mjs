// First-run and persistence tests against the actual bundled runtime, with invented files only.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
const runtime = resolve(process.argv.find(a => a.startsWith('--runtime='))?.slice(10) || 'app/runtime');
const arch = process.argv.find(a => a.startsWith('--arch='))?.slice(7) || process.arch;
const preview = process.argv.includes('--preview');
const temp = await realpath(await mkdtemp(join(tmpdir(), 'vb-desktop-')));
const profile = join(temp, 'profile'), fixture = join(temp, 'Documenti'), other = join(temp, 'Other');
let child, ended, logs = '';
const sleep = ms => new Promise(ok => setTimeout(ok, ms));
const probe = createServer();
await new Promise((ok, fail) => { probe.once('error', fail); probe.listen(0, '127.0.0.1', ok); });
const port = probe.address().port;
await new Promise(ok => probe.close(ok));
const base = `http://127.0.0.1:${port}`;
const request = async (path, body, status = 200) => {
  const r = await fetch(base + path, { signal: AbortSignal.timeout(2000), ...(body ? { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  assert.equal(r.status, status, await r.clone().text()); return r.json();
};
const start = async () => {
  child = spawn(join(runtime, `node-${arch}`), ['src/cli.ts', 'serve', '--port', String(port), '--no-watch'], {
    cwd: join(runtime, 'server'), env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME, ZDOTDIR: temp, TMPDIR: temp, VISUAL_BRAIN_DATA_DIR: profile, VISUAL_BRAIN_LANGUAGE: 'en', VISUAL_BRAIN_INSTANCE: 'desktop-test' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  ended = new Promise(ok => { child.once('exit', ok); child.once('error', ok); });
  child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b);
  // Match the desktop launcher's budget; Rosetta also prepares the newly copied private PTY runtime.
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) { try { await request('/api/health'); return; } catch {} if (child.exitCode !== null || child.signalCode !== null) break; await sleep(100); }
  throw Error(`Runtime failed (exit=${child.exitCode}, signal=${child.signalCode}): ` + logs);
};
const stop = async () => { if (child && child.exitCode === null) child.kill('SIGTERM'); await ended; };
const indexed = async () => {
  for (let i = 0; i < 100; i++) { const s = await request('/api/status'); if (!s.indexing && s.stats.nodes > 0) return s; await sleep(100); }
  throw Error('Index did not finish: ' + logs);
};
try {
  await mkdir(join(fixture, 'Appunti'), { recursive: true });
  await mkdir(join(fixture, '.private')); await mkdir(other);
  await writeFile(join(fixture, 'README.md'), '# Progetto di prova\n[Nota](Appunti/nota.md)\n');
  await writeFile(join(fixture, 'Appunti/nota.md'), '# Appunti personali di prova\n');
  await writeFile(join(fixture, '.private/hidden.txt'), 'Invented private fixture');
  await writeFile(join(other, 'Other.md'), '# Another folder\n');
  await writeFile(join(temp, '.zshrc'), '');
  await start();
  assert.equal((await request('/api/health')).profile, profile);
  assert.equal((await request('/api/status')).stats.nodes, 0);
  assert.deepEqual((await request('/api/preferences')).roots, []);
  assert.equal((await request('/api/preferences')).setupComplete, false);
  assert.ok((await fetch(base)).ok);
  console.log('PASS self-contained Node runtime, empty first run, no automatic scan');
  if (preview) {
    console.log(`PREVIEW ${base}\nFOLDER ${fixture}\nPROFILE ${profile}\nPress Ctrl+C to stop.`);
    await new Promise(ok => { process.once('SIGINT', ok); process.once('SIGTERM', ok); });
  } else {
    const denied = await fetch(base + '/api/preferences', { headers: { origin: 'https://example.com' } });
    assert.equal(denied.status, 403);
    assert.equal((await fetch(base + '/api/preferences', { method: 'PUT', body: '{}' })).status, 415);
    await request('/api/preferences', { roots: [], language: 'en' }, 400);
    await request('/api/preferences', { roots: [fixture], language: 'de' }, 400);
    assert.equal((await request('/api/preferences')).setupComplete, false);
    const folders = await request('/api/folders?path=' + encodeURIComponent(fixture));
    assert.deepEqual(folders.folders, ['Appunti']);
    await request('/api/preferences', { roots: [fixture, join(fixture, 'Appunti')], language: 'en' });
    const s = await indexed(); assert.equal(s.config.language, 'en');
    assert.deepEqual((await request('/api/preferences')).roots, [fixture]);
    const graph = await request('/api/graph?view=folders');
    assert.ok(graph.nodes.length > 0);
    assert.equal((await request('/api/path?p=' + encodeURIComponent(fixture))).path, fixture);
    assert.equal((await request('/api/search?q=hidden')).results.length, 0);
    assert.ok(!(await readdir(join(runtime, 'server'))).includes('data'), 'runtime remains read-only');
    console.log('PASS selected folders only, nested roots deduplicated, private folders excluded, request boundaries');
    const rootNode = await request('/api/path?p=' + encodeURIComponent(fixture));
    const launch = await fetch(base + '/api/launch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: rootNode.id, agent: 'shell', mode: 'embedded' }) });
    assert.equal(launch.status, 201, await launch.clone().text());
    const terminal = await launch.json();
    assert.equal(terminal.info.alive, true); assert.equal(terminal.info.cwd, fixture);
    assert.equal((await fetch(base + '/api/terminals/' + terminal.info.id, { method: 'DELETE' })).status, 200);
    console.log(`PASS bundled native terminal addon (${arch})`);
    await stop(); await start();
    assert.equal((await request('/api/preferences')).language, 'en');
    assert.equal((await request('/api/preferences')).setupComplete, true);
    assert.equal((await request('/api/status')).stats.nodes, s.stats.nodes);
    await request('/api/preferences', { roots: [other], language: 'it' }); await indexed();
    assert.equal((await request('/api/search?q=README')).results.length, 0);
    assert.equal((await request('/api/search?q=Other.md')).results.length, 1);
    assert.equal(JSON.parse(await readFile(join(profile, 'settings.json'))).language, 'it');
    assert.equal(await readFile(join(fixture, 'README.md'), 'utf8'), '# Progetto di prova\n[Nota](Appunti/nota.md)\n');
    console.log('PASS language and index survive restart, roots replace correctly, original files unchanged');
  }
} finally { await stop(); await rm(temp, { recursive: true, force: true }); }
