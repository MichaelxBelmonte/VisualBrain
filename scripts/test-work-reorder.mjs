// No server or DOM: wrapped terminal-grid drops (drop slot maths and the real pointer listeners).
import assert from 'node:assert/strict';
import { bindReorder, gridDropTarget } from '../src/ui/work-reorder.ts';

const rects = [{ left: 0, top: 0, width: 200, height: 150 }, { left: 210, top: 0, width: 200, height: 150 }, { left: 0, top: 160, width: 200, height: 150 }];
assert.equal(gridDropTarget(rects, 211, 60), 1, 'move horizontally before a tile');
assert.equal(gridDropTarget(rects, 400, 60), 2, 'move horizontally after a tile');
assert.equal(gridDropTarget(rects, 30, 190), 2, 'move down to the next row');
assert.equal(gridDropTarget(rects, 190, 200), null, 'move to the final slot');
assert.equal(gridDropTarget([], 1, 1), null);

// Minimal event surface: exercise the actual pointer listeners without browser dependencies.
const classes = () => {
  const set = new Set();
  return { add: (...names) => names.forEach(n => set.add(n)), remove: (...names) => names.forEach(n => set.delete(n)), contains: n => set.has(n) };
};
class Element extends EventTarget {
  style = {}; classList = classes(); isConnected = true;
  constructor(id, rect = rects[0]) { super(); this.id = id; this.rect = rect; }
  closest() { return null; }
  getBoundingClientRect() { return this.rect; }
}
const oldDocument = globalThis.document, oldWindow = globalThis.window;
globalThis.document = new EventTarget(); document.body = { classList: classes() };
globalThis.window = new EventTarget();
const fire = (target, type, props = {}) => {
  const event = new Event(type, { cancelable: true });
  for (const [key, value] of Object.entries({ button: 0, pointerId: 1, clientX: 0, clientY: 0, ...props })) Object.defineProperty(event, key, { value });
  target.dispatchEvent(event); return event;
};
try {
  const rows = rects.map((r, i) => new Element(String(i), r));
  const handles = rows.map((r, i) => new Element(`handle-${i}`));
  let moved = null;
  const unbind = bindReorder({ rows, idOf: r => r.id, layout: 'grid', handleOf: r => handles[rows.indexOf(r)], onMove: (id, before) => { moved = [id, before]; } });
  fire(handles[0], 'pointerdown', { clientX: 50, clientY: 50 });
  fire(document, 'pointermove', { clientX: 400, clientY: 50 });
  fire(document, 'pointerup');
  assert.deepEqual(moved, ['0', '2'], 'horizontal grid drag commits the intended slot');
  moved = null;
  fire(handles[0], 'pointerdown', { clientX: 50, clientY: 50 });
  fire(document, 'pointermove', { clientX: 400, clientY: 50 });
  fire(document, 'pointercancel');
  assert.equal(moved, null, 'cancellation does not reorder terminals');
  unbind();
} finally {
  await new Promise(resolve => setTimeout(resolve, 1));
  globalThis.document = oldDocument; globalThis.window = oldWindow;
}
console.log('PASS wrapped grid drop slots, pointer commit and cancel');
