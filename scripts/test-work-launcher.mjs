// Launch window: "Uguale per tutti" gives every member the same agent, model and effort; roles and names stay.
// Uso: node scripts/test-work-launcher.mjs — nessun server, nessuna app.
import assert from 'node:assert/strict';
import { allSame, sameForAll } from '../src/ui/work-launcher.ts';

const roster = [
  { agent: 'claude', model: 'opus', effort: 'high', role: 'orchestrator', name: 'ORC' },
  { agent: 'codex', model: 'gpt-5', effort: 'low', role: 'operator' },
  { agent: 'claude', model: '', effort: 'auto', role: 'reviewer', name: 'REV' },
  { agent: 'codex', model: 'x', effort: 'medium', role: 'operator' },
];

assert.equal(allSame(roster, 3), false);
assert.equal(allSame(roster, 1), true, 'one member is always "uguale per tutti"');
assert.equal(allSame([], 0), true);

const same = sameForAll(roster, 3);
for (const c of same.slice(0, 3)) assert.deepEqual([c.agent, c.model, c.effort], ['claude', 'opus', 'high']);
assert.deepEqual(same.map(c => c.role), ['orchestrator', 'operator', 'reviewer', 'operator'], 'roles stay');
assert.equal(same[2].name, 'REV', 'names stay');
assert.deepEqual(same[3], roster[3], 'members past the count are untouched');
assert.equal(allSame(same, 3), true);
assert.notEqual(same, roster, 'pure: a new array');
assert.equal(roster[1].agent, 'codex', 'pure: the input is not changed');
console.log('PASS "Uguale per tutti": same agent/model/effort for every member, roles and names kept, input untouched');
