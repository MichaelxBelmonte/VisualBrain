// First start: the map is published (index:map) as soon as the tree is scanned, while extraction and edges are still running;
// later passes do not send it. Uso: node scripts/test-first-map.mjs [--files N]
// Server, profilo, cartelle e porta sono temporanei; l'app installata e i dati reali non vengono toccati.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { api } from '../src/ui/api.ts';
import WebSocket from 'ws';
import { DEFAULTS } from '../src/server/config.ts';
import { Db } from '../src/server/db.ts';
import { runIndex } from '../src/server/index.ts';
import { GraphCache } from '../src/server/cache.ts';
import { rank } from '../src/server/rank.ts';

const app = join(import.meta.dirname, '..');
const FILES = Number(process.argv[process.argv.indexOf('--files') + 1]) || 4000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.deepEqual(a, b, m); };

const tmp = mkdtempSync(join(tmpdir(), 'vb-map-'));
const root = join(tmp, 'root'), profile = join(tmp, 'profile');
mkdirSync(join(root, 'lib'), { recursive: true }); mkdirSync(profile);
for (let i = 0; i < FILES; i++) {
  const body = [`import { f${(i + 1) % FILES} } from './m${(i + 1) % FILES}.ts';`];
  for (let k = 0; k < 60; k++) body.push(`export function h_${i}_${k}(a: number) { return f${(i + 1) % FILES}(a) + ${k}; } // ${'x'.repeat(60)}`);
  writeFileSync(join(root, `lib/m${i}.ts`), body.join('\n') + '\n');
}
writeFileSync(join(profile, 'settings.json'), JSON.stringify({ roots: [root], language: 'en', setupComplete: true }));
const port = await new Promise((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
let logs = '';
const child = spawn(process.execPath, ['src/cli.ts', 'serve', '--port', String(port)], {
  cwd: app, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, VISUAL_BRAIN_DATA_DIR: profile, VISUAL_BRAIN_LANGUAGE: 'en', VB_ENGINE: 'ts' },
});
child.stdout.on('data', (d) => { logs += d; }); child.stderr.on('data', (d) => { logs += d; });
const base = `http://127.0.0.1:${port}`;
const get = async (path) => (await fetch(base + path)).json();
const waitFor = async (what, fn, ms = 120000) => {
  const t0 = Date.now();
  for (;;) { if (await fn()) return; if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}\n${logs.slice(-1500)}`); await sleep(50); }
};
try {
  // listen before the first pass starts: the server begins indexing right at startup
  let ws;
  await waitFor('server up', async () => { try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; } }, 20000);
  const events = [];
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws/events`, { headers: { origin: base } });
  await new Promise((r) => ws.once('open', r));
  const t0 = Date.now();
  let atMap = null, doneStats = null;
  ws.on('message', async (d) => {
    const m = JSON.parse(String(d));
    if (m.type === 'index:map' || m.type === 'index:done') events.push({ type: m.type, at: Date.now() - t0 });
    if (m.type === 'index:done') doneStats = m.stats;
    if (m.type === 'index:map') atMap = { stats: m.stats, graph: await get('/api/graph?min=0') };
  });
  await waitFor('first pass done', () => events.some((e) => e.type === 'index:done'));
  await waitFor('map snapshot', () => atMap !== null, 5000);
  const map = events.find((e) => e.type === 'index:map'), done = events.find((e) => e.type === 'index:done');
  console.log(`  ${FILES} files: map after ${map?.at} ms, complete after ${done.at} ms`);
  ok(map && map.at <= done.at, 'index:map arrives before index:done on the first pass');
  ok(atMap.stats.files >= FILES && atMap.graph.nodes.length > 0, 'at that moment the files and a graph with nodes are already served');
  ok(atMap.stats.edges === 0, 'the map comes before the edges');
  const final = doneStats;
  ok(final.edges > 0, 'edges are there once the pass is complete');

  // a later pass (a new file) does not announce a map again
  const before = events.length;
  writeFileSync(join(root, 'lib/late.ts'), 'export const late = 1;\n');
  await waitFor('second pass', () => events.length > before, 60000);
  await sleep(500);
  ok(events.slice(before).every((e) => e.type === 'index:done'), 'later passes only send index:done');
  ws.close();

  // Before the database is ranked (first pass, no edges) the cache ranks the loaded nodes itself: it must give exactly what the
  // stored ranking gives, and a database that is already ranked must be loaded as stored (no second ranking in memory).
  const dir = join(tmp, 'rank'); mkdirSync(join(dir, 'a/deep'), { recursive: true }); mkdirSync(join(dir, 'b'), { recursive: true });
  for (let i = 0; i < 40; i++) writeFileSync(join(dir, i % 2 ? 'a/deep' : 'b', `f${i}.${i % 3 ? 'ts' : 'md'}`), `export const v${i} = ${i};\n`.repeat(1 + (i % 7) * 20));
  writeFileSync(join(dir, 'a/readme.md'), '# readme\n');
  const db = new Db(join(tmp, 'rank.db'));
  const cfg = structuredClone(DEFAULTS);
  Object.assign(cfg, { roots: [dir], dataDir: join(tmp, 'rank-profile'), engine: 'ts', excludePaths: [], setupComplete: true, desktopMode: false, llm: { ...cfg.llm, provider: 'none' } });
  await runIndex(db, cfg);
  db.exec('UPDATE nodes SET importance = 0, pagerank = 0, indeg = 0, outdeg = 0'); db.exec('DELETE FROM edges');
  const realNow = Date.now; Date.now = () => 1792000000000;
  const early = new GraphCache(); early.load(db, cfg);
  rank(db);
  const stored = new GraphCache(); stored.load(db, cfg); Date.now = realNow;
  ok([...early.nodes.values()].some((n) => n.importance > 0), 'an unranked database still gets an ordering in the cache');
  let same = true;
  for (const [id, n] of stored.nodes) { const e = early.nodes.get(id); if (!e || e.importance !== n.importance || e.indeg !== n.indeg || e.outdeg !== n.outdeg) same = false; }
  ok(same && early.nodes.size === stored.nodes.size, 'the in-memory ranking equals the stored one');
  eq([...early.children.entries()], [...stored.children.entries()], 'children come in the same order');
  db.exec('UPDATE nodes SET importance = 0.5 WHERE kind = \'file\'');
  const kept = new GraphCache(); kept.load(db, cfg);
  ok([...kept.nodes.values()].filter((n) => n.kind === 'file').every((n) => n.importance === 0.5), 'a ranked database is loaded as stored');
  db.close();
  console.log(`PASS first start publishes the map early (${checks} checks)`);
} finally {
  child.kill('SIGKILL');
  rmSync(tmp, { recursive: true, force: true });
}

// Hold hydration in the test child so each race can be exercised even with just two indexed nodes.
const savedDir = mkdtempSync(join(tmpdir(), 'vb-saved-map-'));
const savedRoot = join(savedDir, 'root');
const savedProfile = join(savedDir, 'profile');
mkdirSync(savedRoot); mkdirSync(savedProfile);
const savedFile = join(savedProfile, 'startup-map.json');
const dbFile = join(savedProfile, 'brain.db');
writeFileSync(join(savedProfile, 'settings.json'), JSON.stringify({ roots: [savedRoot], setupComplete: true }));
const seed = new Db(dbFile);
seed.run("INSERT INTO nodes (id,path,name,kind) VALUES (1,?,'root','dir')", savedRoot);
seed.run("INSERT INTO nodes (id,parent_id,path,name,kind) VALUES (2,1,?,'old','file')", join(savedRoot, 'old'));
seed.close();
const gate = join(savedDir, 'gate.mjs');
writeFileSync(gate, `
  import { GraphCache } from ${JSON.stringify(pathToFileURL(join(app, 'src/server/cache.ts')).href)};
  const load = GraphCache.prototype.loadAsync;
  const resume = new Promise(resolve => process.once('message', resolve));
  GraphCache.prototype.loadAsync = async function(...args) { await resume; return load.apply(this, args); };
`);
const key = '/api/graph?view=projects&detail=map&min=0.25';
let testServer;
const sockets = new Set();
async function boot() {
  testServer = spawn(process.execPath, ['--import', gate, 'src/cli.ts', 'serve', '--no-watch', '--port', String(port)], {
    cwd: app, env: { ...process.env, VISUAL_BRAIN_DATA_DIR: savedProfile }, stdio: ['ignore','pipe','pipe','ipc'],
  });
  let output = '';
  for (const stream of [testServer.stdout,testServer.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-2000); });
  await waitFor('saved-map test server', () => {
    if (testServer.exitCode !== null) throw Error(output);
    return output.includes('Visual Brain: ' + base);
  }, 20000);
}
async function stop() {
  for (const ws of sockets) ws.terminate();
  sockets.clear();
  if (testServer && testServer.exitCode === null && !testServer.signalCode) {
    const ended = once(testServer, 'exit'); testServer.kill('SIGTERM'); await ended;
  }
}
async function observe(query = '') {
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws/events' + query);
  sockets.add(ws);
  const messages = [];
  ws.on('message', frame => messages.push(JSON.parse(frame)));
  await once(ws, 'open');
  return messages;
}
const fetchLocal = path => fetch(base + path);
async function pending(request) {
  assert.equal(await Promise.race([request.then(() => 'answered'), sleep(40).then(() => 'waiting')]), 'waiting');
}
async function cold() {
  await boot();
  const response = fetchLocal(key);
  await pending(response);
  testServer.send('load');
  const r = await response;
  assert.equal(r.status, 200); assert.equal(r.headers.get('x-vb-map-preview'), null);
  const json = await r.text();
  await stop();
  return json;
}
try {
  const first = await cold();
  const saved = readFileSync(savedFile, 'utf8');
  for (const broken of ['{', JSON.stringify({ ...JSON.parse(saved), version: -1 }), JSON.stringify({ ...JSON.parse(saved), json: '{}' })]) {
    writeFileSync(savedFile, broken);
    assert.equal(await cold(), first);
  }
  await boot();
  const stableEvents = await observe();
  const restored = await fetchLocal('/api/graph?min=0.25&detail=map&view=projects');
  const id = restored.headers.get('x-vb-map-preview');
  assert.ok(id); assert.equal(await restored.text(), first);
  const status = await fetchLocal('/api/status');
  assert.deepEqual((await status.json()).stats, JSON.parse(first).stats);
  assert.equal(status.headers.get('x-vb-map-preview'), id);
  const detailRequests = ['/api/node/2','/api/search?q=old','/api/work/2',key+'&expanded=2'].map(fetchLocal);
  await Promise.all(detailRequests.map(pending));
  testServer.send('load');
  for (const r of await Promise.all(detailRequests)) { assert.equal(r.status, 200); assert.equal(r.headers.get('x-vb-map-preview'), null); }
  assert.equal(JSON.parse(readFileSync(savedFile, 'utf8')).query, JSON.parse(saved).query, 'a temporary expanded view does not replace the initial view');
  assert.equal(await (await fetchLocal(key)).text(), first);
  assert.equal(stableEvents.length, 0);
  await stop();

  const changed = new Db(dbFile);
  changed.run("UPDATE nodes SET name='new',path=? WHERE id=2", join(savedRoot, 'new')); changed.close();
  await boot();
  const active = await observe();
  assert.equal(await (await fetchLocal(key)).text(), first);
  // The UI fetches relative URLs. Exercise its real fetch client on this disposable server.
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (url, options) => originalFetch(new URL(url, base), options);
    const args = { expanded: [], kinds: null, min: .25, symlinks: false, externals: false, extra: [] };
    assert.equal((await api.graph(args)).nodes[0].name, 'old');
    const reconnect = api.graphEventQuery();
    assert.equal(new URLSearchParams(reconnect).get('preview'), id);
    testServer.send('load');
    await waitFor('preview correction', () => active.some(event => event.type === 'index:map'), 5000);
    const late = await observe(reconnect);
    await waitFor('correction replay', () => late.some(event => event.type === 'index:map'), 5000);
    assert.equal((await api.graph(args)).nodes[0].name, 'new');
    assert.equal(api.graphEventQuery(), '');
    const upToDate = await observe(api.graphEventQuery());
    await sleep(50); assert.equal(upToDate.length, 0);
  } finally { globalThis.fetch = originalFetch; }
  await stop();
  await boot();
  const replaced = await fetchLocal(key);
  assert.ok(replaced.headers.get('x-vb-map-preview')); assert.equal((await replaced.json()).nodes[0].name, 'new');
  testServer.send('load');
  console.log('PASS persisted first map: miss, match, corrupt/version, parameter mismatch, gated details, offline edit, live/late correction and clean reconnect');
} finally {
  await stop();
  rmSync(savedDir, { recursive: true, force: true });
}
