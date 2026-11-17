// brain_explore over a small invented graph: node card, link order, hidden links, depth 2, search, shortest path, relative targets.
// Uso: node scripts/test-explore.mjs — nessun server, nessuna app.
import assert from 'node:assert/strict';
import { explore, resolveTarget } from '../src/server/explore.ts';

const node = (id, path, kind = 'file', cls = 'code', parentId = 1) => ({ id, path, name: path.split('/').pop(), kind, cls, size: 10, bytes: 10, files: 0, depth: 2, mtime: Date.UTC(2026, 9, 1), importance: 0.5, indeg: 0, outdeg: 0, aggregate: false, parentId, childCount: 0 });
const nodes = new Map([
  [1, { ...node(1, '/w/app', 'dir', 'project', null), files: 4 }],
  [2, node(2, '/w/app/main.ts')], [3, node(3, '/w/app/util.ts')], [4, node(4, '/w/app/README.md', 'file', 'doc')],
  [5, node(5, '/w/app/old.ts')], [6, node(6, '/w/lib/deep.ts')], [7, node(7, '/w/lone.txt', 'file', 'doc', null)],
]);
const edge = (id, src, dst, kind, verified = true, confidence = 1, extra = {}) => ({ id, src, dst, kind, verified, confidence, origin: 'index', count: 1, evidence: [], hidden: false, ...extra });
const edges = [
  edge(1, 2, 3, 'imports', true, 1, { evidence: [{ line: 3, snippet: "import { x } from './util'" }] }),
  edge(2, 4, 2, 'mention', false, 0.4),
  edge(3, 2, 5, 'imports', true, 1, { hidden: true }),
  edge(4, 3, 6, 'refpath', true, 0.9),
];
const g = { nodes, links: (id) => edges.filter(e => e.src === id || e.dst === id), evidence: (ids) => new Map(edges.filter(e => ids.includes(e.id)).map(e => [e.id, e.evidence])), children: new Map([[1, [2, 3, 4, 5]]]), find: (q) => [...nodes.values()].filter(n => n.name.includes(q)), notes: (id) => (id === 2 ? [{ text: 'entry point', origin: 'user' }] : []) };

const main = explore(g, { from: 2 });
assert.equal(main.node.path, '/w/app/main.ts', 'no target: the session node');
assert.equal(main.node.modified, '2026-10-01');
assert.equal(main.node.parent, '/w/app');
assert.deepEqual(main.links.map(l => [l.dir, l.kind, l.path, l.verified]), [['out', 'imports', '/w/app/util.ts', true], ['in', 'mention', '/w/app/README.md', false]], 'verified first, hidden links left out');
assert.equal(main.links[0].evidence, "riga 3: import { x } from './util'");
assert.deepEqual(main.notes, [{ text: 'entry point', origin: 'user' }]);
assert.equal(main.around, undefined);

const deep = explore(g, { from: 2, depth: 2 });
assert.deepEqual(deep.around, [{ via: '/w/app/util.ts', kind: 'refpath', path: '/w/lib/deep.ts', verified: true }]);

const project = explore(g, { from: 2, target: '/w/app/' });
assert.deepEqual(project.children.map(c => c.name), ['main.ts', 'util.ts', 'README.md', 'old.ts']);
assert.equal(project.node.files, 4);

assert.equal(resolveTarget(g, 'util.ts', 2)?.id, 3, 'relative to the folder of a file node');
assert.equal(resolveTarget(g, 'README.md', 1)?.id, 4, 'relative to a folder node');
assert.equal(resolveTarget(g, '6', 2)?.id, 6, 'node id');
assert.equal(resolveTarget(g, '../lib/deep.ts', 2)?.id, 6);

assert.deepEqual(explore(g, { from: 2, query: 'util' }).results.map(r => r.path), ['/w/app/util.ts']);
assert.match(explore(g, { query: 'nothing' }).hint, /Nessun nodo/);

assert.deepEqual(explore(g, { from: 2, target: 'README.md', to: '/w/lib/deep.ts' }).path, [
  { path: '/w/app/README.md' }, { link: 'mention', dir: 'out', verified: false }, { path: '/w/app/main.ts' },
  { link: 'imports', dir: 'out', verified: true }, { path: '/w/app/util.ts' }, { link: 'refpath', dir: 'out', verified: true }, { path: '/w/lib/deep.ts' },
]);
assert.equal(explore(g, { from: 2, to: '/w/lone.txt' }).path, null, 'no chain of visible links');
assert.equal(explore(g, { from: 2, to: '/w/app/old.ts' }).path, null, 'hidden links are not followed');
assert.throws(() => explore(g, { from: 2, target: '/w/none' }), /Nodo non trovato/);
console.log('PASS brain_explore: node card, ordered links with evidence, depth 2, relative targets, search and shortest path over visible links');
