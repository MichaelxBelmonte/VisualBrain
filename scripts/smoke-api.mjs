// Smoke test dell'API su una copia isolata dei sorgenti e una fixture inventata (scritto da Sol/Codex, 13/10/2026). Uso: node scripts/smoke-api.mjs [--app-root DIR]
// Smoke isolato: copia solo sorgenti server/shared/CLI; nessuna configurazione o seed reale.
import { mkdtemp, mkdir, writeFile, readFile, cp, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer, createConnection } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

const args = process.argv.slice(2);
const preview = args.includes('--preview');
if (preview) args.splice(args.indexOf('--preview'), 1);
if (preview && !process.stdin.isTTY) { console.error('--preview richiede un terminale interattivo (TTY).'); process.exit(1); }
if (args.length && (args.length !== 2 || args[0] !== '--app-root')) {
  console.error('Uso: node smoke-api.mjs [--app-root DIR]'); process.exit(1);
}
const appRoot = resolve(args[1] ?? process.cwd());
const temp = await mkdtemp(join(tmpdir(), 'vb-smoke-api-'));
let child, exitPromise, logs = '';
const checks = [];
const pass = (name, detail) => { checks.push({ name, result: 'pass', detail }); console.log(`PASS ${name}`); };
try {
  const probe = createServer();
  await new Promise((ok, fail) => { probe.once('error', fail); probe.listen(0, '127.0.0.1', ok); });
  const port = probe.address().port;
  await new Promise((ok, fail) => probe.close(err => err ? fail(err) : ok()));
  const isolatedApp = join(temp, 'app');
  const fixture = join(temp, 'fixture');
  await mkdir(join(isolatedApp, 'src'), { recursive: true });
  for (const dir of ['server', 'shared']) await cp(join(appRoot, 'src', dir), join(isolatedApp, 'src', dir), { recursive: true });
  await cp(join(appRoot, 'src/cli.ts'), join(isolatedApp, 'src/cli.ts'));
  if (preview) await cp(join(appRoot, 'dist/ui'), join(isolatedApp, 'dist/ui'), { recursive: true });
  await writeFile(join(isolatedApp, 'package.json'), '{"type":"module"}');
  await symlink(join(appRoot, 'node_modules'), join(isolatedApp, 'node_modules'), 'dir');
  await mkdir(join(fixture, 'docs'), { recursive: true });
  await mkdir(join(fixture, 'dati'));
  const files = { 'a.py': 'import b\nprint(b.VALUE)\n', 'b.py': 'VALUE = 42\n',
    'README.md': '# Fixture inventata\n[Nota](docs/note.md)\n', 'docs/note.md': '# Nota inventata\n',
    '.env': 'FAKE_VALUE=not-a-real-secret\n', 'dati/uno.csv': 'x\n1\n',
    'dati/due.csv': 'x\n2\n', 'dati/tre.csv': 'x\n3\n' };
  for (const [name, content] of Object.entries(files)) await writeFile(join(fixture, name), content);
  await symlink('dati', join(fixture, 'alias'));
  const launchLog = join(temp, 'fake-agent-launches.jsonl');
  const inputLog = join(temp, 'fake-agent-input.jsonl');
  const fakeAgent = join(isolatedApp, 'fake-agent.cjs');
  await writeFile(fakeAgent, `#!${process.execPath}\nconst fs=require('node:fs'); fs.appendFileSync(${JSON.stringify(launchLog)},JSON.stringify(process.argv.slice(2))+'\\n'); console.log('FAKE_AGENT_READY'); process.stdin.on('data',b=>fs.appendFileSync(${JSON.stringify(inputLog)},JSON.stringify(b.toString())+'\\n'));\n`, { mode: 0o755 });
  await writeFile(join(isolatedApp, 'brain.config.json'), JSON.stringify({ language: 'it', agents: { claude: fakeAgent, codex: fakeAgent, hermes: fakeAgent } }));
  await writeFile(join(temp, '.zshrc'), '');
  const dbPath = join(temp, 't.db');
  child = spawn(process.execPath, [join(isolatedApp, 'src/cli.ts'), 'serve', '--db', dbPath,
    '--root', fixture, '--no-watch', '--port', String(port), '--index'], {
    cwd: isolatedApp, env: { PATH: process.env.PATH ?? '', TMPDIR: temp, ZDOTDIR: temp }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', b => { logs = (logs + b.toString()).slice(-12000); });
  exitPromise = new Promise(ok => { child.once('exit', (code, signal) => ok({ code, signal })); child.once('error', error => ok({ error: error.message })); });
  const base = `http://127.0.0.1:${port}`;
  async function request(path, options = {}, expected = 200) {
    const response = await fetch(base + path, { ...options, signal: AbortSignal.timeout(1500) });
    assert.equal(response.status, expected, `${path}: status`);
    return response.json();
  }
  const deadline = Date.now() + 30000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw Error(`Server terminato: ${logs}`);
    try { const s = await request('/api/status'); if (!s.indexing && s.stats.nodes > 0) { ready = true; break; } } catch {}
    await new Promise(ok => setTimeout(ok, 150));
  }
  assert.ok(ready, `Server non pronto entro 30 s: ${logs}`);
  pass('status indicizzato');
  // The installed 0.1 desktop launcher uses HTTP/1.0 and omits the port in Host.
  const rawRequest = (headers) => new Promise((ok, fail) => {
    const socket = createConnection({ host: '127.0.0.1', port }, () => socket.write(headers));
    let response = '';
    socket.setTimeout(3000, () => socket.destroy(Error('Legacy startup probe timed out')));
    socket.on('data', data => response += data);
    socket.on('end', () => ok(response)); socket.on('error', fail);
  });
  assert.match(await rawRequest('GET /api/graph?view=projects HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n'), /^HTTP\/1\.1 200/);
  assert.match(await rawRequest('GET /api/graph?view=projects HTTP/1.0\r\nHost: example.com\r\n\r\n'), /^HTTP\/1\.1 403/);
  assert.match(await rawRequest('GET /api/graph?view=projects HTTP/1.0\r\nHost: 127.0.0.1\r\nOrigin: https://example.com\r\n\r\n'), /^HTTP\/1\.1 403/);
  pass('avvio app 0.1 con Host senza porta, mantenendo il blocco delle origini esterne');
  const graph = await request('/api/graph');
  assert.ok(graph.nodes.length > 0);
  for (const n of graph.nodes) { assert.equal(typeof n.kind, 'string'); assert.equal(typeof n.cls, 'string'); assert.equal(typeof n.importance, 'number'); }
  pass('graph kind/cls/importance');
  const byPath = p => request('/api/path?p=' + encodeURIComponent(join(fixture, p)));
  const a = await byPath('a.py'), b = await byPath('b.py');
  const detail = await request(`/api/node/${a.id}`);
  assert.ok(Array.isArray(detail.ancestors) && detail.ancestors.length > 0);
  pass('ancestors a.py');
  const search = await request('/api/search?q=note');
  assert.ok(search.results.some(n => n.path === join(fixture, 'docs/note.md')));
  pass('search note.md');
  const edge = await request('/api/edges', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ srcPath: a.path, dstPath: b.path, kind: 'manual', origin: 'agent:smoke', verified: false, evidence: { note: 'fixture inventata' } }) }, 201);
  assert.ok((await request(`/api/node/${a.id}`)).edges.some(e => e.id === edge.id));
  pass('POST edge presente nel dettaglio');
  await request(`/api/edges/${edge.id}`, { method: 'DELETE' });
  assert.ok(!(await request(`/api/node/${a.id}`)).edges.some(e => e.id === edge.id));
  pass('DELETE edge rimosso');
  const secret = await byPath('.env');
  const secretDetail = await request(`/api/node/${secret.id}`);
  assert.equal(secret.cls, 'secret'); assert.equal(secretDetail.lines, null);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM refs WHERE node_id = ?').get(secret.id).n, 0); } finally { db.close(); }
  pass('.env sintetico secret, lines null, zero refs');
  const post = (path, body, expected = 201, token) => request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }, expected);
  const patch = (path, body, expected = 200, token) => request(path, { method: 'PATCH', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }, expected);
  const models = await request('/api/models');
  assert.ok(Array.isArray(models.codex) && models.claude.some(m => m.id === 'sonnet'));
  const orch = (await post('/api/launch', { id: a.id, agent: 'claude', mode: 'embedded', model: 'sonnet', effort: 'low', role: 'orchestrator' })).info;
  const worker = (await post('/api/launch', { id: a.id, agent: 'codex', mode: 'embedded', model: 'fixture-model', effort: 'medium', role: 'operator', parentId: orch.id, task: 'Check a.py only' })).info;
  const reviewer = (await post('/api/launch', { id: a.id, agent: 'hermes', mode: 'embedded', role: 'reviewer', parentId: orch.id })).info;
  const other = (await post('/api/launch', { id: b.id, agent: 'claude', mode: 'embedded', role: 'orchestrator' })).info;
  assert.equal(worker.parentId, orch.id); assert.equal(worker.model, 'fixture-model');
  await post('/api/launch', { id: a.id, agent: 'claude', mode: 'embedded', role: 'orchestrator' }, 409);
  await post('/api/launch', { id: a.id, agent: 'claude', mode: 'embedded', effort: 'made-up' }, 400);
  const launches = async () => { try { return (await readFile(launchLog, 'utf8')).trim().split('\n').map(s => JSON.parse(s)); } catch { return []; } };
  const launchDeadline = Date.now() + 5000;
  while ((await launches()).length < 4 && Date.now() < launchDeadline) await new Promise(ok => setTimeout(ok, 25));
  const records = await launches(); assert.equal(records.length, 4);
  const record = id => records.find(args => args.at(-1).includes(`sessione ${id}.`));
  const token = id => record(id).at(-1).match(/Bearer ([a-z0-9-]+)/)[1];
  assert.equal(record(worker.id)[record(worker.id).indexOf('--model') + 1], 'fixture-model');
  assert.ok(!record(worker.id).at(-1).includes('Relazioni nel grafo'));
  assert.ok(!(await request('/api/terminals')).some(t => 'teamToken' in t));
  pass('modello, effort e ruoli su tre CLI, contesto mirato, token non esposto nell’elenco');
  const teamPath = `/api/work/${a.id}`;
  const actorGet = (nodeId, id, expected = 200) => request(`/api/work/${nodeId}?session=${id}`, { headers: { authorization: `Bearer ${token(id)}` } }, expected);
  await request(`${teamPath}?session=${worker.id}`, {}, 403);
  await actorGet(b.id, worker.id, 403);
  await patch(teamPath, { from: worker.id, summary: 'Not allowed' }, 403, token(worker.id));
  await patch(teamPath, { from: orch.id, maxAgents: 8 }, 403, token(orch.id));
  await post(`${teamPath}/spawn`, { from: orch.id, agent: 'claude', role: 'operator', task: 'Delegated' }, 403, token(orch.id));
  const task = await post(`${teamPath}/tasks`, { from: orch.id, title: 'One owner only', scope: ['a.py'] }, 201, token(orch.id));
  const claims = await Promise.all([worker, reviewer].map(s => fetch(base + `${teamPath}/tasks/${task.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${token(s.id)}` }, body: JSON.stringify({ from: s.id, status: 'working' }) })));
  assert.deepEqual(claims.map(r => r.status).sort(), [200, 409]);
  const ownerId = (await request(teamPath)).tasks.find(t => t.id === task.id).assignedTo;
  await patch(`${teamPath}/tasks/${task.id}`, { from: ownerId, status: 'done', result: 'Verified a.py; no changes' }, 200, token(ownerId));
  assert.ok((await actorGet(a.id, orch.id)).messages.some(m => m.text.includes(task.id)));
  pass('autenticazione, isolamento dei nodi, policy manuale, incarico rivendicato atomicamente e risultato all’orchestratore');
  await actorGet(a.id, worker.id); // Ack all previous messages before marking idle.
  await post(`${teamPath}/state`, { from: worker.id, state: 'idle' }, 200, token(worker.id));
  await post(`${teamPath}/messages`, { from: orch.id, to: worker.id, text: 'Focused handoff' }, 201, token(orch.id));
  const inbox = await actorGet(a.id, worker.id);
  assert.equal(inbox.messages.at(-1).text, 'Focused handoff');
  assert.equal((await actorGet(a.id, worker.id)).messages.length, 0);
  const inputDeadline = Date.now() + 3000;
  let input = '';
  while (Date.now() < inputDeadline) { try { input = await readFile(inputLog, 'utf8'); } catch {} if (input.includes('Visual Brain:')) break; await new Promise(ok => setTimeout(ok, 25)); }
  assert.ok(input.includes('Visual Brain:'));
  assert.equal((await request('/api/terminals')).find(s => s.id === worker.id).workState, 'working');
  pass('messaggi mirati, lettura incrementale e notifica PTY solo alla sessione in attesa');
  await post(`${teamPath}/messages`, { from: orch.id, to: other.id, text: 'Not linked yet' }, 403, token(orch.id));
  const link = await post('/api/team-links', { srcNodeId: a.id, dstNodeId: b.id, srcSessionId: orch.id, dstSessionId: other.id });
  const duplicateLink = await post('/api/team-links', { srcNodeId: b.id, dstNodeId: a.id, srcSessionId: other.id, dstSessionId: orch.id });
  assert.equal(link.id, duplicateLink.id);
  await post(`${teamPath}/messages`, { from: worker.id, to: other.id, text: 'Wrong endpoint' }, 403, token(worker.id));
  await post(`${teamPath}/messages`, { from: orch.id, to: other.id, text: 'Cross-node result' }, 201, token(orch.id));
  assert.ok((await actorGet(b.id, other.id)).messages.some(m => m.text === 'Cross-node result'));
  await request(`/api/team-links/${link.id}`, { method: 'DELETE' });
  await post(`${teamPath}/messages`, { from: orch.id, to: other.id, text: 'Removed channel' }, 403, token(orch.id));
  pass('canali espliciti tra nodi, deduplicazione, controllo endpoint e rimozione');
  await patch(teamPath, { autoSpawn: true, maxAgents: 4 });
  const delegated = (await post(`${teamPath}/spawn`, { from: orch.id, agent: 'claude', model: 'haiku', role: 'operator', task: 'Read b.py' }, 201, token(orch.id))).info;
  assert.equal(delegated.parentId, orch.id);
  await post(`${teamPath}/spawn`, { from: orch.id, agent: 'claude', role: 'operator', task: 'Over cap' }, 409, token(orch.id));
  await request(`/api/terminals/${delegated.id}`, { method: 'DELETE' });
  assert.ok((await request(teamPath)).tasks.some(t => t.title === 'Read b.py' && t.assignedTo === null && t.status === 'pending'));
  assert.ok(JSON.parse(await readFile(join(isolatedApp, 'data/teams', `${a.id}.json`), 'utf8')).tasks.some(t => t.status === 'done'));
  await request(`/api/terminals/${orch.id}`, { method: 'DELETE' });
  const replacement = (await post('/api/launch', { id: a.id, agent: 'claude', mode: 'embedded', role: 'orchestrator' })).info;
  assert.equal((await request('/api/terminals')).find(t => t.id === worker.id).parentId, replacement.id);
  await request(`/api/terminals/${replacement.id}`, { method: 'DELETE' });
  for (const s of [orch, worker, reviewer, other]) await request(`/api/terminals/${s.id}`, { method: 'DELETE' });
  pass('delegazione abilitata dall’utente, limite agenti, recupero incarichi, cambio orchestratore e persistenza della bacheca');
  const roster = [
    { agent: 'claude', model: 'sonnet', effort: 'high' },
    { agent: 'codex', model: 'fixture-model', effort: 'low' },
    { agent: 'claude', model: 'haiku', effort: 'low' },
    { agent: 'hermes', effort: 'medium' },
  ];
  await post('/api/launch-squad', { id: a.id, members: [...roster.slice(0, 3), { agent: 'claude', effort: 'invalid' }] }, 400);
  assert.equal((await request('/api/terminals')).length, 0, 'invalid member must not start partial squad');
  await patch(`/api/work/${b.id}`, { maxAgents: 3 });
  await post('/api/launch-squad', { id: b.id, members: roster }, 409);
  assert.equal((await request('/api/terminals')).length, 0, 'capacity checked before any launch');
  await patch(`/api/work/${b.id}`, { maxAgents: 4 });
  const squad = (await post('/api/launch-squad', { id: a.id, prompt: 'One shared objective', members: roster })).sessions;
  assert.equal(squad.length, 4);
  assert.equal(squad[0].role, 'orchestrator');
  assert.equal(squad[0].task, 'One shared objective');
  for (let i = 1; i < 4; i++) {
    assert.equal(squad[i].parentId, squad[0].id);
    assert.equal(squad[i].role, 'operator');
    assert.equal(squad[i].agent, roster[i].agent);
    assert.equal(squad[i].effort, roster[i].effort);
    assert.ok(!squad[i].task, 'objective only sent to orchestrator');
  }
  await post('/api/launch-squad', { id: a.id, members: roster }, 409);
  assert.equal((await request('/api/terminals')).length, 4, 'double launch cannot duplicate a squad');
  for (const session of squad) await request(`/api/terminals/${session.id}`, { method: 'DELETE' });
  pass('avvio unico 1 + 3, modelli misti, parent automatici, prevalidazione, limiti e nessun duplicato');
  const launch = id => request('/api/launch', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, agent: 'shell', mode: 'embedded', cols: 100, rows: 25 }) }, 201);
  const sessions = [];
  for (let i = 0; i < 24; i++) sessions.push((await launch(i % 2 ? a.id : b.id)).info);
  assert.equal(new Set(sessions.map(t => t.id)).size, 24);
  const restored = await request('/api/terminals');
  assert.equal(restored.length, 24);
  assert.ok(restored.every(t => t.alive && t.cwd === fixture && [a.id, b.id].includes(t.nodeId)));
  pass('24 terminali su due nodi, elenco ripristinabile e cwd corretto');
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws/term?id=' + sessions[0].id);
  const suffix = String(Date.now());
  const marker = 'VB_WORKSPACE_' + suffix;
  const output = new Promise((ok, fail) => {
    let text = '';
    const timeout = setTimeout(() => fail(Error('Nessun output dalla PTY')), 5000);
    ws.on('error', fail);
    ws.on('message', data => { text += String(data); if (text.includes(marker)) { clearTimeout(timeout); ok(text); } });
  });
  await new Promise((ok, fail) => { ws.once('open', ok); ws.once('error', fail); });
  ws.send(JSON.stringify({ type: 'resize', cols: 90, rows: 20 }));
  ws.send(JSON.stringify({ type: 'input', data: `printf '%s%s\\n' 'VB_WORKSPACE_' '${suffix}'\r` }));
  await output;
  ws.close();
  const replay = new WebSocket(base.replace('http:', 'ws:') + '/ws/term?id=' + sessions[0].id);
  await new Promise((ok, fail) => {
    let text = '';
    const timeout = setTimeout(() => fail(Error('Replay PTY assente')), 5000);
    replay.on('error', fail);
    replay.on('message', data => { text += String(data); if (text.includes(marker)) { clearTimeout(timeout); ok(); } });
  });
  replay.close();
  pass('input, ridimensionamento e riconnessione con replay PTY');
  for (const session of sessions) await request('/api/terminals/' + session.id, { method: 'DELETE' });
  assert.equal((await request('/api/terminals')).length, 0);
  pass('chiusura delle 24 sessioni');
  const imported = detail.edges.some(e => e.kind === 'imports' && e.src === a.id && e.dst === b.id);
  checks.push({ name: 'import a.py → b.py', result: imported ? 'pass' : 'informativo', detail: imported ? 'presente' : 'atteso dopo extract; non bloccante' });
  console.log(imported ? 'PASS import a.py → b.py' : 'INFO import a.py → b.py atteso dopo extract');
  if (preview) {
    const first = (await post('/api/launch', { id: a.id, agent: 'claude', mode: 'embedded', role: 'orchestrator', model: 'sonnet', effort: 'high' })).info;
    await post('/api/launch', { id: a.id, agent: 'codex', mode: 'embedded', role: 'operator', parentId: first.id, model: 'fixture-model', effort: 'low', task: 'Controlla a.py' });
    await post('/api/launch', { id: a.id, agent: 'hermes', mode: 'embedded', role: 'reviewer', parentId: first.id, task: 'Verifica il risultato' });
    await post('/api/launch', { id: b.id, agent: 'claude', mode: 'embedded', role: 'orchestrator', model: 'haiku' });
    console.log(`PREVIEW ${base} — fake agents only; send Enter to stop`);
    process.stdin.resume();
    await new Promise(ok => process.stdin.once('data', ok));
    process.stdin.pause();
  }
} catch (error) {
  process.exitCode = 1;
  checks.push({ name: 'smoke', result: 'fail', detail: error.message });
  console.error(error.message);
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    const exited = await Promise.race([exitPromise.then(() => true), new Promise(ok => setTimeout(() => ok(false), 1500))]);
    if (!exited) { child.kill('SIGKILL'); await exitPromise; }
  }
  await rm(temp, { recursive: true, force: true });
  console.log(JSON.stringify({ appRoot, checks, success: process.exitCode !== 1 }, null, 2));
}
