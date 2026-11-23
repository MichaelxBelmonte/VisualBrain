// Lavoro: tasks the person edits, moves and deletes. Field rules, permissions, notices to the assignee, the person
// starting an assigned task, boards from before the new fields, and the board event. Simulated PTYs, no providers.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { handleApi } from '../src/server/api.ts';
import { Teams, taskFields } from '../src/server/team.ts';
import { setWorkState } from '../src/server/team-delivery.ts';
import { newActivity } from '../src/server/activity.ts';
import { DEFAULTS } from '../src/server/config.ts';

// --- Field rules (pure).
assert.deepEqual(taskFields({ title: '  Rifai il menu  ' }), { title: 'Rifai il menu' });
assert.deepEqual(taskFields({ description: '', priority: 'normal', labels: [] }), { clear: ['description', 'priority', 'labels'] }, 'empty means absent');
assert.deepEqual(taskFields({ labels: ['UI', 'ui', ' bug '] }).labels, ['UI', 'bug'], 'labels trimmed, duplicates dropped regardless of case');
assert.equal(taskFields({ priority: 'high' }).priority, 'high');
assert.throws(() => taskFields({ priority: 'urgent' }), /Priorità/);
assert.throws(() => taskFields({ labels: Array(9).fill('a') }), /Etichette/);
assert.throws(() => taskFields({ labels: ['x'.repeat(25)] }), /Etichette/);
assert.throws(() => taskFields({ title: '   ' }), /Testo richiesto/);
assert.throws(() => taskFields({ order: Number.NaN }), /Ordine/);
assert.throws(() => taskFields({ description: 'x'.repeat(4001) }));
console.log('PASS task fields: trimmed, bounded, empty values stored as absent');

const dir = mkdtempSync(join(tmpdir(), 'vb-team-edit-'));
try {
  // A board written before 0.2.65: no description, priority, labels or createdAt.
  mkdirSync(join(dir, 'teams'), { recursive: true });
  writeFileSync(join(dir, 'teams', '7.json'), JSON.stringify({ messages: [], tasks: [{ id: 'old00001', title: 'Vecchio', scope: [], assignedTo: null, status: 'pending', result: '', createdBy: 'user', updatedAt: 1 }], summary: '', policy: { autoSpawn: false, maxAgents: 4 } }));
  const terminals = new Map();
  const store = {
    persistent: true,
    list: () => [...terminals.values()].map(t => t.info),
    get: id => terminals.get(id),
    spawn(opts) {
      const info = { id: opts.id, role: opts.role, agent: opts.agent, nodeId: opts.nodeId, alive: true, cwd: opts.cwd, parentId: opts.parentId, createdAt: Date.now(), title: opts.role, workState: 'idle' };
      const term = { info, activity: newActivity(), teamToken: opts.teamToken, seenMessage: opts.seenMessage ?? 0, proc: { write() {} } };
      terminals.set(opts.id, term);
      return term;
    },
  };
  const teams = new Teams(dir), saved = [];
  teams.onSave = (nodeId, team) => saved.push(`${nodeId}:${team}`);
  const node = { id: 7, name: 'Fixture', path: dir, kind: 'dir', cls: 'folder', parentId: null, bytes: 0, files: 0 };
  const ctx = { cfg: { ...DEFAULTS, dataDir: dir, language: 'it' },
    cache: { nodes: new Map([[7, node]]), incident: () => [], evidence: () => new Map(), children: new Map(), areas: [] },
    db: { get: () => undefined, all: () => [] }, teams, terms: store };
  async function call(method, path, payload, id) {
    const req = Readable.from(method === 'GET' ? [] : [Buffer.from(JSON.stringify(id ? { ...payload, from: id } : payload ?? {}))]);
    req.method = method; req.url = path;
    req.headers = id ? { authorization: 'Bearer ' + terminals.get(id).teamToken } : {};
    let status, body;
    await handleApi(ctx, req, { writeHead(s) { status = s; }, end(text) { body = JSON.parse(text); } });
    return { status, body };
  }
  const ok = async (...args) => { const r = await call(...args); assert.ok(r.status >= 200 && r.status < 300, `${args[0]} ${args[1]} -> ${r.status}: ${r.body?.error ?? ''}`); return r.body; };

  const old = (await ok('GET', '/api/work/7')).tasks[0];
  assert.equal(old.title, 'Vecchio');
  assert.equal(old.description, undefined, 'an old board reads as before');

  const squad = await ok('POST', '/api/launch-squad', { id: 7, prompt: 'Rifai la bacheca.', members: [{ agent: 'codex', role: 'orchestrator' }, { agent: 'codex', role: 'operator' }] });
  const [orc, op] = squad.sessions.map(s => s.id);
  for (const id of [orc, op]) { await ok('GET', '/api/work/7?session=' + id, undefined, id); setWorkState(terminals.get(id).info, 'idle', 'hook'); }
  const messagesTo = async id => (await ok('GET', '/api/work/7')).messages.filter(m => m.to === id).map(m => m.text);

  // The person creates with the new fields.
  const task = await ok('POST', '/api/work/7/tasks', { from: 'user', title: 'Bacheca modificabile', description: 'Titolo in linea', priority: 'high', labels: ['ui'], assignedTo: op });
  assert.equal(task.priority, 'high'); assert.deepEqual(task.labels, ['ui']); assert.equal(task.description, 'Titolo in linea'); assert.ok(task.createdAt);
  const path = '/api/work/7/tasks/' + task.id;

  // Editing the content tells the assignee; moving the card does not.
  const before = (await messagesTo(op)).length;
  const edited = await ok('PATCH', path, { from: 'user', title: 'Bacheca modificabile e semplice', description: 'Titolo e descrizione in linea' });
  assert.equal(edited.title, 'Bacheca modificabile e semplice');
  assert.equal(edited.status, 'pending', 'an edit leaves the status alone');
  let to = await messagesTo(op);
  assert.equal(to.length, before + 1);
  assert.match(to.at(-1), /modificato: Bacheca modificabile e semplice\. Rileggi la descrizione/);
  await ok('PATCH', path, { from: 'user', order: 3 });
  await ok('PATCH', path, { from: 'user', priority: 'normal', labels: [] });
  const plain = (await ok('GET', '/api/work/7')).tasks.find(t => t.id === task.id);
  assert.equal(plain.order, 3); assert.equal(plain.priority, undefined); assert.equal(plain.labels, undefined);
  assert.equal((await messagesTo(op)).length, before + 1, 'order, priority and labels are not news for the agent');
  console.log('PASS the person edits title, description, priority, labels and position; only content changes reach the assignee');

  // Permissions: an operator neither edits nor deletes; the orchestrator edits, never deletes.
  assert.equal((await call('PATCH', path, { title: 'Mio' }, op)).status, 403);
  assert.equal((await call('DELETE', path, {}, op)).status, 403);
  assert.equal((await call('DELETE', path, {}, orc)).status, 403);
  const byOrc = await ok('PATCH', path, { labels: ['ui', 'urgente'] }, orc);
  assert.deepEqual(byOrc.labels, ['ui', 'urgente']);
  assert.equal((await call('PATCH', path, { from: 'user', priority: 'subito' })).status, 400);
  console.log('PASS operators cannot edit or delete; the orchestrator edits; only the person deletes');

  // The person moves an assigned card to «In corso»: it stays there and the owner is told to begin.
  const started = await ok('PATCH', path, { from: 'user', status: 'working' });
  assert.equal(started.status, 'working', 'the person starts an assigned task');
  assert.match((await messagesTo(op)).at(-1), /avviato dall’utente\. Inizia ora/);
  // An unassigned task still cannot be «working» without an owner, and the orchestrator still cannot claim for others.
  const loose = await ok('POST', '/api/work/7/tasks', { from: 'user', title: 'Senza nessuno' });
  assert.equal((await ok('PATCH', '/api/work/7/tasks/' + loose.id, { from: 'user', status: 'working' })).status, 'pending');
  const forOp = await ok('POST', '/api/work/7/tasks', { title: 'Per OP', assignedTo: op }, orc);
  assert.equal((await ok('PATCH', '/api/work/7/tasks/' + forOp.id, { status: 'working' }, orc)).status, 'pending', 'the orchestrator still cannot start it for the owner');
  console.log('PASS the person starts an assigned task for its owner; unassigned and orchestrator moves keep the old rule');

  // Delete: the owner is told to stop; the task is gone, the others stay.
  await ok('DELETE', path, { from: 'user' });
  const after = (await ok('GET', '/api/work/7')).tasks;
  assert.ok(!after.some(t => t.id === task.id));
  assert.ok(after.some(t => t.id === loose.id) && after.some(t => t.id === 'old00001'));
  assert.match((await messagesTo(op)).at(-1), /eliminato dall’utente\. Interrompi/);
  assert.equal((await call('DELETE', path, { from: 'user' })).status, 404);
  console.log('PASS delete: removed for good, the owner stops, a second delete is 404');

  assert.ok(saved.includes('7:1'), 'every save is heard, for the board event');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
