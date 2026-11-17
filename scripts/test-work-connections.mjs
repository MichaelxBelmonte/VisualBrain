// Independent review test for Operativa connections (team links) and side-by-side sessions.
// Part 1 exercises the link model in src/server/team.ts on a temporary data dir: no server, no app, no AI.
// Uso: node scripts/test-work-connections.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { Teams } = await import(join(ROOT, 'src/server/team.ts'));

const dir = mkdtempSync(join(tmpdir(), 'vb-work-links-'));
const manyDir = mkdtempSync(join(tmpdir(), 'vb-work-links-many-'));
let passed = 0;
const ok = (name) => { passed++; console.log(`PASS ${name}`); };
const session = (id, nodeId, role, alive = true) => ({ id, nodeId, role, alive, agent: 'claude', cwd: '/fixture', title: id, createdAt: 0 });

try {
  const teams = new Teams(dir);
  const orchA = session('a-orch', 1, 'orchestrator');
  const opA = session('a-op', 1, 'operator');
  const orchB = session('b-orch', 2, 'orchestrator');
  const opB = session('b-op', 2, 'operator');
  const opC = session('c-op', 3, 'operator');

  // same node always talks, other nodes only through a link
  assert.ok(teams.canTalk(orchA, opA));
  assert.ok(!teams.canTalk(orchA, orchB));
  ok('without links, only sessions of the same node talk');

  // node-level link: orchestrators only
  const nodeLink = teams.link({ srcNodeId: 1, dstNodeId: 2, srcSessionId: null, dstSessionId: null });
  assert.ok(teams.canTalk(orchA, orchB) && teams.canTalk(orchB, orchA));
  assert.ok(!teams.canTalk(opA, orchB) && !teams.canTalk(orchA, opB));
  ok('node-level link connects the two orchestrators, in both directions, and nobody else');

  // reverse duplicate returns the same link
  const again = teams.link({ srcNodeId: 2, dstNodeId: 1, srcSessionId: null, dstSessionId: null });
  assert.equal(again.id, nodeLink.id);
  assert.equal(teams.getLinks().length, 1);
  ok('the same link in reverse is not duplicated');

  // session-level link
  const sessLink = teams.link({ srcNodeId: 1, dstNodeId: 3, srcSessionId: 'a-op', dstSessionId: 'c-op' });
  assert.ok(teams.canTalk(opA, opC) && teams.canTalk(opC, opA));
  assert.ok(!teams.canTalk(orchA, opC));
  ok('session-level link connects exactly those two sessions');

  // a link survives in links.json; a new instance (server restart) reads it back
  const persisted = JSON.parse(readFileSync(join(dir, 'teams', 'links.json'), 'utf8'));
  assert.equal(persisted.length, 2);
  assert.equal(new Teams(dir).getLinks().length, 2);
  ok('links persist across a restart');

  // a terminated session keeps its link on disk: canTalk does not check liveness, callers must (peers filter alive)
  const deadOpC = session('c-op', 3, 'operator', false);
  assert.ok(teams.canTalk(opA, deadOpC), 'canTalk ignores liveness: the API filters peers by alive');
  ok('link to a terminated session stays stored (UI must show it as inactive, API must filter it)');

  // unlink removes only that link and is idempotent
  teams.unlink(sessLink.id);
  assert.ok(!teams.canTalk(opA, opC));
  assert.ok(teams.canTalk(orchA, orchB));
  teams.unlink(sessLink.id);
  teams.unlink('missing');
  assert.equal(teams.getLinks().length, 1);
  ok('unlink removes only the chosen link; repeated or unknown ids are harmless');

  // limit
  const many = new Teams(manyDir);
  for (let i = 0; i < 500; i++) many.link({ srcNodeId: 1, dstNodeId: 1000 + i, srcSessionId: null, dstSessionId: null });
  assert.throws(() => many.link({ srcNodeId: 1, dstNodeId: 99999, srcSessionId: null, dstSessionId: null }), /Troppi collegamenti/);
  ok('at most 500 links');
} finally {
  rmSync(dir, { recursive: true, force: true });
  rmSync(manyDir, { recursive: true, force: true });
}

// Part 2: pure UI helpers (src/ui/work-links.ts, src/ui/work-tiles.ts), no DOM.
const { connectionGroups } = await import(join(ROOT, 'src/ui/work-links.ts'));
const tiles = await import(join(ROOT, 'src/ui/work-tiles.ts'));
const L = (id, s, d, ss = null, ds = null) => ({ id, srcNodeId: s, dstNodeId: d, srcSessionId: ss, dstSessionId: ds });

{
  const links = [L('a', 1, 2), L('b', 2, 3), L('c', 7, 8), L('self', 5, 5, 'x', 'y')];
  const g = connectionGroups(links);
  assert.deepEqual(g.get(3).nodeIds, [1, 2, 3]);
  assert.equal(g.get(1), g.get(3));
  assert.ok(!g.has(5), 'a same-node link is not a cross-node group');
  const shuffled = connectionGroups([...links].reverse());
  for (const id of [1, 2, 3, 7, 8]) assert.deepEqual(shuffled.get(id), g.get(id));
  ok('connection groups are transitive, ignore same-node links and do not depend on input order');
}

{
  const sel0 = { ids: [], focus: null };
  const known = new Set(['a', 'b', 'c', 'd', 'e']);
  let sel = sel0;
  for (const id of ['a', 'b', 'c', 'd']) sel = tiles.toggleTile(sel, id, known);
  const full = tiles.toggleTile(sel, 'e', known);
  assert.equal(full.change, 'full');
  assert.deepEqual(full.ids, ['a', 'b', 'c', 'd']);
  assert.equal(tiles.toggleTile(sel, 'zz', known).change, 'unknown');
  ok(`at most ${tiles.MAX_TILES} tiles; a fifth is refused, unknown sessions are ignored`);

  sel = { ids: ['a', 'b', 'c'], focus: 'b' };
  assert.deepEqual(tiles.removeTile(sel, 'b'), { ids: ['a', 'c'], focus: 'c' });
  assert.deepEqual(tiles.removeTile(sel, 'a'), { ids: ['b', 'c'], focus: 'b' });
  assert.deepEqual(tiles.reconcileTiles({ ids: ['a', 'x', 'c'], focus: 'x' }, new Set(['a', 'c'])).ids, ['a', 'c']);
  ok('removing a view keeps the focus on a neighbour; sessions that disappear leave the grid');

  const markers = [0, 1, 2, 3].map(i => tiles.tileMarker(i));
  assert.equal(new Set(markers.map(m => m.shape)).size, 4);
  assert.equal(new Set(markers.map(m => m.number)).size, 4);
  ok('tile markers differ by number and shape, not only by colour');
}

{
  const infos = [
    { id: 'o1', nodeId: 1, alive: true, createdAt: 1, role: 'orchestrator' },
    { id: 'p2', nodeId: 2, alive: true, createdAt: 2, role: 'operator' },
    { id: 'o2', nodeId: 2, alive: true, createdAt: 3, role: 'orchestrator' },
    { id: 'dead', nodeId: 3, alive: false, createdAt: 4, role: 'operator' },
  ];
  const s = tiles.groupSuggestion(1, [L('n', 1, 2), L('d', 1, 3, null, 'dead')], infos);
  assert.ok(s.ids.includes('o1') && s.ids.includes('o2'), 'node-level link proposes the orchestrators');
  assert.ok(!s.ids.includes('p2'));
  assert.deepEqual(s.inactive, ['dead']);
  ok('"Affianca collegati" proposes the live channel endpoints and reports terminated ones');
}

console.log(`test-work-connections: ${passed} controlli ok`);
