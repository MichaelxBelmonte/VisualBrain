// Session rename (server) and the link helpers used by "Collega a…" in the terminals view. No server, no app, no AI.
// Uso: node scripts/test-work-rename-link.mjs
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { Terminals } = await import(join(ROOT, 'src/server/terminals.ts'));
const { handleApi } = await import(join(ROOT, 'src/server/api.ts'));
const { linkBetween, linkRequest } = await import(join(ROOT, 'src/ui/work-links.ts'));
const { setLanguage, ui } = await import(join(ROOT, 'src/ui/i18n.ts'));

const terms = new Terminals(() => {});
const term = terms.spawn({ agent: 'shell', cwd: '/tmp', file: '/bin/sh', args: ['-c', 'sleep 5'], title: 'shell', nodeId: 1 });
try {
  assert.equal(terms.rename(term.info.id, '  Costi   app  ')?.name, 'Costi app');
  assert.equal(terms.get(term.info.id).info.name, 'Costi app');
  assert.equal(terms.rename(term.info.id, 'x'.repeat(200))?.name.length, 60);
  assert.equal(terms.rename(term.info.id, '   ')?.name, undefined);
  assert.equal(terms.rename('missing', 'a'), undefined);
  console.log('PASS rename: trimmed, capped at 60, empty restores the generated label, unknown id ignored');

  // The HTTP route: users rename, agents (Authorization header) cannot, bad bodies and unknown ids are refused.
  const call = async (path, method, body, headers = {}) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]); req.method = method; req.url = path; req.headers = headers;
    let status, response; await handleApi({ terms }, req, { writeHead(code) { status = code; }, end(text) { response = JSON.parse(text); } });
    return { status, body: response };
  };
  const path = `/api/terminals/${term.info.id}`;
  const ok1 = await call(path, 'PATCH', { name: 'Costi' });
  assert.equal(ok1.status, 200); assert.equal(ok1.body.name, 'Costi');
  assert.equal((await call(path, 'PATCH', { name: 'Altro' }, { authorization: 'Bearer x' })).status, 403);
  assert.equal(terms.get(term.info.id).info.name, 'Costi');
  assert.equal((await call(path, 'PATCH', { name: 5 })).status, 400);
  assert.equal((await call('/api/terminals/nope', 'PATCH', { name: 'a' })).status, 404);
  console.log('PASS PATCH /api/terminals/:id: user only, validated, 404 for unknown sessions');
} finally { terms.killAll(); }

const side = (id, nodeId, role, alive = true) => ({ id, nodeId, role, alive });
const orchA = side('a-orch', 1, 'orchestrator'), opA = side('a-op', 1, 'operator');
const orchB = side('b-orch', 2, 'orchestrator'), opB = side('b-op', 2, 'operator'), shellB = side('b-sh', 2, undefined);
const deadC = side('c-op', 3, 'operator', false);
const all = [orchA, opA, orchB, opB, shellB, deadC];

assert.deepEqual(linkRequest(orchA, orchB), { srcNodeId: 1, srcSessionId: null, dstNodeId: 2, dstSessionId: null });
assert.deepEqual(linkRequest(opA, orchB), { srcNodeId: 1, srcSessionId: 'a-op', dstNodeId: 2, dstSessionId: null });
assert.equal(linkRequest(orchA, opA), null);
const links = [{ id: 'l1', ...linkRequest(opA, orchB) }];
assert.equal(linkBetween(links, opA, orchB)?.id, 'l1');
assert.equal(linkBetween(links, orchB, opA)?.id, 'l1');
assert.equal(linkBetween(links, orchA, orchB), undefined);
assert.equal(linkBetween(links, opA, opB), undefined);
console.log('PASS link helpers: orchestrator = node side, same stored shape as the map, found in both directions');

setLanguage('en');
assert.equal(ui`<button data-rename>Rinomina sessione</button><button data-link>Collega a…</button>`, '<button data-rename>Rename session</button><button data-link>Connect to…</button>');
setLanguage('it');
console.log('PASS i18n of the new labels');

// Rail order: manual order, with connected nodes kept side by side.
const { orderNodes, moveNode } = await import(join(ROOT, 'src/ui/work-links.ts'));
const link = (a, b) => ({ id: `${a}-${b}`, srcNodeId: a, dstNodeId: b, srcSessionId: null, dstSessionId: null });
const ids = (xs) => xs.map(x => x.id);
assert.deepEqual(ids(orderNodes([1, 2, 3, 4], [], [])), [1, 2, 3, 4]);
assert.deepEqual(ids(orderNodes([1, 2, 3, 4], [], [link(1, 3)])), [1, 3, 2, 4]);
assert.deepEqual(ids(orderNodes([1, 2, 3, 4], [4, 3, 2, 1], [link(1, 4)])), [4, 1, 3, 2]);
assert.deepEqual(orderNodes([1, 2, 3], [], [link(1, 3)]).map(x => [x.clusterStart, x.clusterSize]), [[true, 2], [false, 2], [false, 1]]);
assert.deepEqual(ids(orderNodes([1, null, 2], [9, 2], [])), [2, 1, null]);
assert.deepEqual(moveNode([1, 2, 3, 4], 4, 2), [1, 4, 2, 3]);
assert.deepEqual(moveNode([1, 2, 3], 1, null), [2, 3, 1]);
assert.deepEqual(moveNode([1, 2, 3], 1, 99), [2, 3, 1]);
console.log('PASS rail order: manual order kept, connected nodes adjacent, drag moves one node');

assert.deepEqual(ids(orderNodes([1, 2, 3, 4], [4, 3, 2, 1], [link(1, 4)], true)), [4, 3, 2, 1], 'sidebar manual order is not overridden by communication links');
console.log('PASS free sidebar order preserves the requested position even for linked nodes');
