// A failed batch must leave pre-existing sessions intact and remove its own PTYs.
import assert from 'node:assert/strict';
import { startSquad } from '../src/server/sessions.ts';
import { Teams } from '../src/server/team.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const temp = mkdtempSync(join(tmpdir(), 'vb-squad-'));
const teams = new Teams(temp);
try {
const existing = { info: { id: 'existing', nodeId: 2, agent: 'claude', alive: true } };
const sessions = new Map([['existing', existing]]);
const released = [];
let count = 0;
const ctx = {
  cfg: { dataDir: temp, host: '127.0.0.1', port: 4747, agents: { claude: 'fake-agent' } },
  cache: { nodes: new Map() },
  teams,
  terms: {
    get: id => sessions.get(id),
    list: () => [...sessions.values()].map(s => s.info),
    spawn: opts => {
      if (++count === 3) throw new Error('simulated PTY failure');
      const term = { info: { id: opts.id, agent: opts.agent, nodeId: opts.nodeId, role: opts.role, cwd: opts.cwd, alive: true } };
      sessions.set(opts.id, term); return term;
    },
    kill: id => sessions.delete(id),
  },
};
const release = teams.release.bind(teams);
teams.release = (node, id) => { released.push([node, id]); return release(node, id); };
const detail = { id: 1, name: 'fixture', path: '/tmp', kind: 'dir', cls: 'folder', bytes: 0, files: 0, edges: [], children: [], notes: [] };
await assert.rejects(() => startSquad(ctx, detail, { id: 1, prompt: 'A single objective', members: [{ agent: 'claude' }, { agent: 'claude' }, { agent: 'claude' }] }), /simulated PTY failure/);
assert.equal(count, 3);
assert.equal(released.length, 2);
assert.deepEqual([...sessions.values()], [existing]);
assert.ok(released.every(([node]) => node === 1));
console.log('PASS failed squad launch removes only its own PTYs and preserves existing sessions');

// With an orchestrator already running, a team only adds operators linked to it (no 409), within the node limit.
sessions.clear(); count = -100;
const orch = { info: { id: 'orch', nodeId: 1, agent: 'claude', role: 'orchestrator', alive: true } };
sessions.set('orch', orch);
const spawned = [];
const spawn = ctx.terms.spawn;
ctx.terms.spawn = opts => { spawned.push(opts); return spawn(opts); };
const added = (await startSquad(ctx, detail, { id: 1, prompt: '', members: [{ agent: 'claude' }, { agent: 'claude' }, { agent: 'claude' }] })).sessions;
assert.equal(added.length, 3);
assert.ok(added.every(s => s.role === 'operator') && spawned.every(o => o.role === 'operator' && o.parentId === 'orch'));
await assert.rejects(() => startSquad(ctx, detail, { id: 1, prompt: '', members: [{ agent: 'claude' }] }), /limite del nodo/);
console.log('PASS a team started next to a running orchestrator adds operators linked to it, within the limit');

// A remote spawn yields to other requests: concurrent squads must still obey the same node's capacity.
sessions.clear(); sessions.set('orch', orch); count = -100;
const synchronousSpawn = ctx.terms.spawn;
ctx.terms.spawn = async opts => { await new Promise(r => setTimeout(r, 10)); return synchronousSpawn(opts); };
const concurrent = await Promise.allSettled([
  startSquad(ctx, detail, { id: 1, members: [{ agent: 'claude' }, { agent: 'claude' }] }),
  startSquad(ctx, detail, { id: 1, members: [{ agent: 'claude' }, { agent: 'claude' }] }),
]);
assert.equal(concurrent.filter(r => r.status === 'fulfilled').length, 1);
assert.equal(concurrent.filter(r => r.status === 'rejected').length, 1);
assert.equal(sessions.size, 3);
console.log('PASS concurrent remote spawns cannot overfill the squad');

} finally { rmSync(temp, { recursive: true, force: true }); }
