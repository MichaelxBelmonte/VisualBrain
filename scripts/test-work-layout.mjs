// Session boxes are a UI layer: they must preserve file nodes and nest correctly.
import assert from 'node:assert/strict';
import { Store } from '../src/ui/state.ts';
import { computeLayout } from '../src/ui/layout.ts';

const store = new Store();
const node = { id: 10, name: 'project', path: '/fixture/project', kind: 'dir', cls: 'project', size: 0, bytes: 1, files: 1, depth: 0, mtime: 0, importance: 1, indeg: 0, outdeg: 0, aggregate: false, parentId: null, childCount: 1 };
store.nodes.set(10, node);
store.nodes.set(11, { ...node, id: 11, name: 'README.md', path: '/fixture/project/README.md', kind: 'file', cls: 'doc', parentId: 10, childCount: 0 });
store.setSessions(['reviewer', 'operator', 'orchestrator'].map((role, i) => ({ id: `session-${i}`, nodeId: 10, role, agent: 'codex', model: 'test-model', cwd: '/fixture/project', title: role, alive: true, createdAt: i })), null);
const fonts = { box: '', file: '', sub: '', tag: '', group: '', small: '' };
const layout = () => computeLayout(store, s => s.length * 6, fonts, 1.6);
const closed = layout();
assert.equal(closed.boxes.get(10).sessionCount, 3);
assert.equal(closed.boxes.size, 2);
assert.ok(closed.boxes.get(10).sessionBadgeW > 0);
store.sessionsExpanded.add(10);
const open = layout();
assert.equal(open.boxes.size, 5);
const children = open.boxes.get(10).children;
assert.deepEqual(children.filter(b => b.node.cls === 'session').map(b => store.graphSession(b.id).role), ['orchestrator', 'operator', 'reviewer']);
for (const b of children) assert.equal(b.parent.id, 10);
for (let i = 0; i < children.length; i++) for (let j = i + 1; j < children.length; j++) {
  const a = children[i], b = children[j];
  assert.ok(a.tx + a.w <= b.tx || b.tx + b.w <= a.tx || a.ty + a.h <= b.ty || b.ty + b.h <= a.ty, 'Nested boxes do not overlap');
}
assert.equal(store.nodes.size, 2);
console.log('PASS badges, nesting, role order and non-overlap without mutating indexed nodes');

store.nodes = new Map([[11, { ...node, id: 11, kind: 'file', cls: 'code', childCount: 0 }]]);
store.setSessions([{ id: 'file-session', nodeId: 11, agent: 'claude', role: 'orchestrator', cwd: '/fixture', title: 'test', alive: true, createdAt: 0 }], null);
store.sessionsExpanded.add(11);
store.filters.compact = true;
const compact = layout();
assert.equal(compact.boxes.get(store.sessionIds.get('file-session')).parent.id, 11);
console.log('PASS compact view keeps sessions attached to their file node');
