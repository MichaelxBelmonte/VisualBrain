// Filter before limiting, plain-folder code, durable team configurations and restore without real agents.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Db } from '../src/server/db.ts';
import { GraphCache } from '../src/server/cache.ts';
import { DEFAULTS } from '../src/server/config.ts';
import { handleApi } from '../src/server/api.ts';
import { Teams } from '../src/server/team.ts';
import { startSquad, startSession } from '../src/server/sessions.ts';
import { codeTree, localCodeSearch } from '../src/server/code.ts';

const temp = realpathSync(mkdtempSync(join(tmpdir(), 'vb-project-workflows-')));
const db = new Db(join(temp, 'fixture.db'));
try {
  const folder = join(temp, 'local'); mkdirSync(folder); mkdirSync(join(folder, 'src'));
  writeFileSync(join(folder, 'src', 'hello.ts'), 'const needle = 42;\n');
  writeFileSync(join(folder, '.env'), 'needle=secret');
  mkdirSync(join(folder, 'node_modules')); writeFileSync(join(folder, 'node_modules', 'vendor.js'), 'needle');
  writeFileSync(join(temp, 'outside.txt'), 'needle outside'); symlinkSync(join(temp, 'outside.txt'), join(folder, 'escape.txt'));
  const insert = (name, kind, cls, importance = 0) => {
    const path = name === 'fixture' ? folder : join(folder, name);
    db.run('INSERT INTO nodes(path,name,kind,cls,importance) VALUES (?,?,?,?,?)', path, name, kind, cls, importance);
    const id = db.get('SELECT id FROM nodes WHERE path=?', path).id;
    db.run('INSERT INTO nodes_fts(rowid,name,path) VALUES (?,?,?)', id, name, path); return id;
  };
  const nodeId = insert('fixture', 'dir', 'project');
  for (let i = 0; i < 450; i++) insert(`needle-${i}.ts`, 'file', 'code', 1);
  const dirId = insert('needle-folder', 'dir', 'folder');
  const projectId = insert('needle-project', 'dir', 'project');
  const objectId = insert('needle-object', 'external', 'other');
  const cfg = { ...DEFAULTS, language: 'it', dataDir: join(temp, 'profile'), roots: [folder] };
  const cache = new GraphCache(); cache.load(db, cfg);
  const sessions = new Map(); let spawns = 0, failAt = Infinity;
  const terms = {
    list: () => [...sessions.values()].map(s => s.info), get: id => sessions.get(id),
    spawn: opts => {
      if (++spawns === failAt) throw Error('simulated spawn failure');
      const term = { info: { ...opts, alive: true, createdAt: Date.now() } };
      delete term.info.args; delete term.info.env; delete term.info.file;
      sessions.set(opts.id, term); return term;
    },
    rename: (id, name) => { const term = sessions.get(id); term.info.name = name; return term.info; },
    kill: id => sessions.delete(id), flush: async () => {},
  };
  const ctx = { db, cfg, cache, terms, teams: new Teams(cfg.dataDir), changed() {} };
  const request = async (path, method = 'GET', body, headers = {}) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { url: path, method, headers });
    let status, data;
    await handleApi(ctx, req, { writeHead(n) { status = n; }, end(text) { data = JSON.parse(text); } });
    return { status, data };
  };
  assert.deepEqual((await request('/api/search?q=needle&filter=folders&limit=40')).data.results.map(n => n.id).sort(), [dirId, projectId].sort());
  assert.deepEqual((await request('/api/search?q=needle&filter=projects')).data.results.map(n => n.id), [projectId]);
  assert.deepEqual((await request('/api/search?q=needle&filter=objects')).data.results.map(n => n.id), [objectId]);
  assert.equal((await request('/api/search?q=needle&filter=code&limit=2')).data.results.length, 2);
  assert.equal((await request('/api/search?q=needle&filter=INVALID')).status, 400);
  db.exec('DELETE FROM nodes_fts');
  assert.equal((await request('/api/search?q=needle&filter=folders')).data.results.length, 2, 'LIKE fallback also filters before its limit');
  console.log('PASS search filters survive 450 higher-ranked files, including fallback and invalid values');

  const tree = await codeTree(folder, false);
  assert.equal(tree.git, false); assert.deepEqual(tree.files, ['.env', 'src/hello.ts']);
  const result = await localCodeSearch(folder, 'needle', ['.env']);
  assert.deepEqual(result.hits.map(h => h.path), ['src/hello.ts']);
  assert.equal((await request(`/api/git/${nodeId}/code/tree`)).data.git, false);
  assert.equal((await request(`/api/git/${nodeId}/code/file?path=src/hello.ts`)).data.text, 'const needle = 42;\n');
  assert.equal((await request(`/api/git/${nodeId}/code/file?path=escape.txt`)).status, 400);
  assert.equal((await request(`/api/git/${nodeId}/code/search?q=needle`)).data.hits.length, 1);
  console.log('PASS local folder tree, code and search without Git; generated folders, secrets and escaping symlinks excluded');

  const detail = { ...cache.nodes.get(nodeId), edges: [], children: [], notes: [], neighbors: [] };
  const members = [
    { agent: 'codex', role: 'orchestrator', model: 'gpt-test', effort: 'high', name: 'Lead' },
    { agent: 'claude', role: 'operator', model: 'sonnet', effort: 'high' },
    { agent: 'codex', role: 'reviewer', model: 'gpt-test', effort: 'low', name: 'Review' },
  ];
  await startSquad(ctx, detail, { id: nodeId, members });
  let saved = new Teams(cfg.dataDir).get(nodeId).savedSquads[0];
  assert.equal(saved.members.length, 3); assert.deepEqual(saved.members.map(m => m.role), ['orchestrator', 'operator', 'reviewer']);
  assert.equal(saved.members[0].name, 'Lead'); assert.equal(saved.members[2].effort, 'low');
  assert.ok(!JSON.stringify(saved).includes('teamToken'));
  const id = saved.id;
  ctx.teams.saveSquad(nodeId, folder, detail.name, terms.list());
  assert.equal(ctx.teams.get(nodeId).savedSquads[0].id, id, 'unchanged configuration is deduplicated');
  assert.equal((await request(`/api/github/${nodeId}/connect`, 'POST', { repository: 'owner/repo' }, { authorization: 'Bearer fake' })).status, 403);
  assert.equal((await request('/api/github/repos', 'GET', undefined, { authorization: 'Bearer fake' })).status, 403);

  // Simulate a full computer restart: no PTYs, a newly constructed board store, only persisted data.
  sessions.clear(); ctx.teams = new Teams(cfg.dataDir);
  ctx.teams.update(nodeId, { maxAgents: 1, worktrees: true });
  const restored = await startSquad(ctx, detail, { id: nodeId, savedId: saved.id, members: saved.members });
  assert.equal(restored.sessions.length, 3);
  assert.deepEqual(restored.sessions.map(s => s.role), ['orchestrator', 'operator', 'reviewer']);
  assert.equal(restored.sessions[0].name, 'Lead');
  assert.equal(ctx.teams.get(nodeId).policy.maxAgents, 4);
  assert.equal(ctx.teams.get(nodeId).policy.worktrees, false);
  const before = spawns;
  await assert.rejects(startSquad(ctx, detail, { id: nodeId, savedId: saved.id, members: saved.members }), /già agenti attivi/);
  assert.equal(spawns, before);
  sessions.clear();
  ctx.teams.update(nodeId, { maxAgents: 2 });
  failAt = spawns + 2;
  await assert.rejects(startSquad(ctx, detail, { id: nodeId, savedId: saved.id, members: saved.members }), /simulated spawn failure/);
  assert.equal(sessions.size, 0); assert.equal(ctx.teams.get(nodeId).policy.maxAgents, 2, 'restore failure rolls back previous policy');
  assert.ok(new Teams(cfg.dataDir).get(nodeId).savedSquads.some(s => s.id === saved.id));
  failAt = Infinity;
  await startSession(ctx, detail, { id: nodeId, agent: 'codex', role: 'operator', mode: 'embedded', model: 'gpt-test', effort: 'high' });
  saved = new Teams(cfg.dataDir).get(nodeId).savedSquads[0];
  assert.equal(saved.members[0].role, 'operator');
  sessions.clear(); await startSquad(ctx, detail, { id: nodeId, savedId: saved.id, members: saved.members });
  assert.equal(terms.list()[0].role, 'operator', 'explicit operator-only configurations keep their roles');
  sessions.clear();
  const save = ctx.teams.saveSquad.bind(ctx.teams);
  ctx.teams.saveSquad = () => { throw Error('disk unavailable'); };
  await assert.rejects(startSquad(ctx, detail, { id: nodeId, members: [{ agent: 'codex' }] }), /disk unavailable/);
  assert.equal(sessions.size, 0, 'a failed configuration save does not leave an unreported squad running');
  await assert.rejects(startSession(ctx, detail, { id: nodeId, agent: 'codex', mode: 'embedded' }), /disk unavailable/);
  assert.equal(sessions.size, 0, 'a failed configuration save does not leave an unreported single agent running');
  ctx.teams.saveSquad = save;
  console.log('PASS full-restart recovery preserves models, roles, names and policy; duplicate starts and failed batches are safe');
} finally { db.close(); rmSync(temp, { recursive: true, force: true }); }
