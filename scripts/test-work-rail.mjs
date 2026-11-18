// Disposable DOM/storage stubs: no browser, server, PTY, or user settings are touched.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bindRailResize, railStep, railWidthLimits } from '../src/ui/work-rail.ts';

const classes = () => {
  const names = new Set();
  return { add: (...values) => values.forEach(v => names.add(v)), remove: (...values) => values.forEach(v => names.delete(v)), contains: v => names.has(v) };
};
class Element extends EventTarget {
  clientWidth = 1200; isConnected = true; classList = classes(); attributes = new Map(); properties = new Map();
  style = { setProperty: (key, value) => this.properties.set(key, value) };
  setAttribute(key, value) { this.attributes.set(key, value); }
}
class Observer {
  static instances = [];
  disconnected = false;
  constructor(callback) { this.callback = callback; Observer.instances.push(this); }
  observe(target) { this.target = target; }
  disconnect() { this.disconnected = true; }
}
const old = Object.fromEntries(['window', 'document', 'localStorage', 'ResizeObserver'].map(key => [key, globalThis[key]]));
globalThis.window = Object.assign(new EventTarget(), { innerWidth: 1200 });
globalThis.document = Object.assign(new EventTarget(), { body: { classList: classes() } });
globalThis.ResizeObserver = Observer;
const memory = new Map();
let writes = 0, denied = false;
globalThis.localStorage = {
  getItem(key) { if (denied) throw Error('disabled'); return memory.get(key) ?? null; },
  setItem(key, value) { if (denied) throw Error('disabled'); memory.set(key, value); writes++; },
};
const fire = (target, type, props = {}) => {
  const event = new Event(type, { cancelable: true });
  for (const [key, value] of Object.entries({ button: 0, pointerId: 1, clientX: 100, ...props })) Object.defineProperty(event, key, { value });
  target.dispatchEvent(event); return event;
};
const fixture = () => {
  const root = new Element(), handle = new Element();
  const cleanup = bindRailResize(root, handle);
  return { root, handle, cleanup, width: () => Number.parseInt(root.properties.get('--work-rail-width')), observer: Observer.instances.at(-1) };
};
try {
  // ↑/↓/Home/End in the rail: the highlight moves across the visible sessions and never wraps.
  assert.deepEqual([railStep(3, 0, 'ArrowDown'), railStep(3, 1, 'ArrowDown'), railStep(3, 2, 'ArrowDown')], [1, 2, null], '↓ stops on the last session');
  assert.deepEqual([railStep(3, 2, 'ArrowUp'), railStep(3, 1, 'ArrowUp'), railStep(3, 0, 'ArrowUp')], [1, 0, 'search'], '↑ on the first session goes back to the search field');
  assert.deepEqual([railStep(3, 1, 'Home'), railStep(3, 1, 'End'), railStep(0, -1, 'ArrowDown'), railStep(3, 1, 'Enter')], [0, 2, null, null]);
  // From a node row (no session highlighted): the first session under it, or the last one above it.
  assert.deepEqual([railStep(4, -1, 'ArrowDown', 2), railStep(4, -1, 'ArrowUp', 2), railStep(4, -1, 'ArrowUp', 0), railStep(4, -1, 'ArrowDown', -1), railStep(4, -1, 'ArrowUp', -1)], [2, 1, 'search', null, 3]);
  {
    const source = readFileSync(new URL('../src/ui/terminal.ts', import.meta.url), 'utf8');
    const key = source.slice(source.indexOf('private railKey('), source.indexOf('markExit(id: string)'));
    assert.match(key, /if \(e\.altKey \|\| e\.ctrlKey \|\| e\.metaKey \|\| e\.isComposing\) return;/, 'Alt+arrows stay with the explicit reorder, shortcuts are left alone');
    assert.doesNotMatch(key, /this\.activate\(/, 'moving the highlight never opens a session: the open terminal stays the same');
    assert.match(key, /rows\[at\]\.focus\(\{ preventScroll: true \}\); rows\[at\]\.scrollIntoView\(\{ block: 'nearest' \}\)/);
    assert.match(key, /t\.term!\.focus\(\); t\.term!\.input\(e\.key, true\)/, 'a character typed on the open session row reaches its terminal');
    assert.match(source, /const id = el\.dataset\.session!, stay = e\.detail > 0 && !window\.matchMedia\('\(max-width: 760px\)'\)\.matches;\n\s+this\.activate\(id, !stay\);/, 'a pointer click keeps the keyboard in the list; Enter gives it to the terminal');
    assert.match(source, /\?\? rows\[Math\.min\(focusedAt, rows\.length - 1\)\]\)\?\.focus\(\{ preventScroll: true \}\)/, 'the highlight keeps its place when its session leaves the list');
    // The detail of the highlighted session lives under its own row: no docked box, no copy-paste of /model, no new
    // session passed off as a change of model.
    assert.doesNotMatch(source, /work-rail-preview|data-preview-native|data-preview-model|navigator\.clipboard\?\.writeText\('\/model'\)|nativeModel|changeModel/, 'the docked preview and its two buttons are gone');
    assert.match(source, /<div class="work-session-detail" hidden><\/div><\/div>` \}\);/, 'each row carries its own detail, empty until the row is open or highlighted');
    assert.match(source, /const model = highlighted \|\| this\.active === info\.id \? this\.modelLine\(info\) : '';/, 'the model is shown on the open row and on the highlighted one');
    assert.match(source, /const data = highlighted && !onScreen && this\.railPreviewData\?\.id === info\.id \? this\.railPreviewData\.preview : null;/, 'the last words only for a highlighted session whose terminal is not on screen');
    assert.match(source, /if \(box\.dataset\.shown === html\) return;/, 'a poll that changes nothing leaves the row (and an open choice list) alone');
    assert.match(source, /if \(select\?\.dataset\.modelSelect\) void this\.switchModel\(select\.dataset\.modelSelect, select\.value\);/, 'the choice is made in place');
    assert.match(source, /choices\.map\(c => `<option value="\$\{esc\(c\.id\)\}"\$\{c\.id === current \? ' selected' : ''\}>/, 'the selector shows what the CLI confirmed, never what was only asked');
    assert.match(source, /const current = info\.modelChoice \?\? '';/);
    assert.match(source, /void this\.answerModel\(button\.dataset\.modelConfirm \?\? button\.dataset\.modelCancel!, button\.dataset\.modelConfirm !== undefined\);/, 'a question of the CLI is answered by the person, on the row');
    assert.match(source, /else if \(t\.ws\?\.readyState === WebSocket\.CONNECTING\) \{ if \(!t\.early\) t\.earlyAt = Date\.now\(\); t\.early = \(\(t\.early \?\? ''\) \+ data\)\.slice\(0, 4096\); \}/, 'keys typed while a session is still connecting are kept, per session');
    assert.match(source, /if \(t\.early && Date\.now\(\) - \(t\.earlyAt \?\? 0\) < EARLY_KEYS_MS\) ws\.send\(JSON\.stringify\(\{ type: 'input', data: t\.early \}\)\);\n      t\.early = '';/, 'and sent once when the connection opens, never after a long wait');
    assert.match(source, /const EARLY_KEYS_MS = 5000;/);
    assert.match(source, /ws\.onclose = \(\) => \{ if \(t\.ws !== ws \|\| !this\.tabs\.has\(t\.info\.id\)\) return; t\.connected = false; t\.early = '';/, 'a lost connection forgets them');
    assert.match(source, /t\.ws = ws; t\.connected = false; t\.early = '';/, 'a new connection never inherits keys from the previous one');
    assert.match(source, /this\.listEl\.addEventListener\('focusin', e => this\.showRailPreview\(\(e\.target as HTMLElement\)\.closest<HTMLElement>\('\.work-session'\)\?\.dataset\.sid \?\? null\)\);/, 'the detail follows the keyboard highlight');
    assert.match(source, /if \(lines\.some\(line => line\.trim\(\)\)\) return sessionPreview\(lines\);/, 'the pane already in the page and the server filter the screen the same way');
    assert.match(key, /e\.key === 'ArrowRight' && from\.closest\('\.work-session'\)/, '→ reaches the model of the highlighted session');
    assert.match(key, /if \(!e\.shiftKey && \(e\.key === 'ArrowLeft' \|\| e\.key === 'Escape'\)\) \{\n\s+e\.preventDefault\(\); e\.stopPropagation\(\);\n\s+from\.closest\('\.work-session'\)\?\.querySelector<HTMLElement>\('button\[data-session\]'\)\?\.focus/, '← and Esc come back to the row');
    assert.match(key, /else if \(from instanceof HTMLSelectElement && \(e\.key\.length === 1 \|\| e\.key\.startsWith\('Arrow'\)/, 'on the selector no key changes the model by itself');
    const quick = readFileSync(new URL('../src/ui/terminal-quick-menu.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(quick, /onModel|onNativeModel|Copia \/model|Nuova sessione con un altro modello/, 'the quick menu offers no model shortcut of its own');
    const english = readFileSync(new URL('../src/ui/locales/en.ts', import.meta.url), 'utf8');
    for (const text of ['"Nessuna attività leggibile": "No readable activity"', '"dal prossimo turno": "from the next turn"', '"la prossima risposta sarà più lenta e userà più token: confermi?"', '"In attesa: turno in corso"', '"Conferma": "Confirm"']) assert.ok(english.includes(text), `translated: ${text}`);
    assert.doesNotMatch(english, /Copia \/model e apri|Usa \/model nel terminale/, 'the copy-paste hint is gone in both languages');
    const css = readFileSync(new URL('../src/ui/style.css', import.meta.url), 'utf8');
    assert.match(css, /\.work-session > button\[data-session\]:focus-visible \{ outline: 2px solid var\(--fg\); outline-offset: -2px;/, 'the highlight is drawn inside the clipped row');
    assert.match(css, /\.work-session-detail \{ order: 3; flex: 0 0 100%;/, 'the detail takes its own line under the row, after the row’s actions');
    assert.match(css, /\.work-session-preview \{ display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2;/, 'the last words never take more than two lines');
    assert.doesNotMatch(css, /work-rail-preview|terminal-quick-actions/);
  }
  assert.deepEqual(railWidthLimits(1200), { min: 180, max: 360 });
  assert.deepEqual(railWidthLimits(500), { min: 180, max: 260 });
  assert.deepEqual(railWidthLimits(400), { min: 160, max: 160 });
  assert.deepEqual(railWidthLimits(200), { min: 0, max: 0 });
  const f = fixture();
  assert.equal(f.width(), 220); assert.equal(writes, 0, 'initialization does not overwrite preferences');
  assert.equal(f.handle.attributes.get('role'), 'separator'); assert.equal(f.handle.attributes.get('aria-orientation'), 'vertical');
  assert.equal(f.handle.attributes.get('aria-valuenow'), '220'); assert.equal(f.handle.tabIndex, 0);
  assert.equal(f.observer.target, f.root);
  fire(f.handle, 'pointerdown'); fire(document, 'pointermove', { clientX: 102 });
  assert.equal(f.width(), 220, 'a click within the threshold does not resize');
  fire(document, 'pointermove', { clientX: 180, pointerId: 2 }); assert.equal(f.width(), 220);
  fire(document, 'pointermove', { clientX: 180 });
  assert.equal(f.width(), 300); assert.equal(writes, 0, 'pointer preview is not persisted');
  assert.equal(document.body.classList.contains('rail-resizing'), true);
  fire(document, 'pointerup', { pointerId: 2 }); assert.equal(writes, 0, 'another pointer cannot commit');
  fire(document, 'pointerup');
  assert.equal(memory.get('vb:rail-width'), '300'); assert.equal(writes, 1);
  assert.equal(document.body.classList.contains('rail-resizing'), false);
  const reloaded = fixture(); assert.equal(reloaded.width(), 300, 'saved width is restored'); reloaded.cleanup();

  fire(f.handle, 'pointerdown'); fire(document, 'pointermove', { clientX: 1000 }); assert.equal(f.width(), 360);
  fire(document, 'keydown', { key: 'Escape' });
  assert.equal(f.width(), 300); assert.equal(writes, 1, 'Escape restores without saving');
  fire(f.handle, 'pointerdown'); fire(document, 'pointermove', { clientX: -1000 }); assert.equal(f.width(), 180);
  fire(window, 'blur'); assert.equal(f.width(), 300); assert.equal(writes, 1);
  fire(f.handle, 'pointerdown'); fire(document, 'pointermove', { clientX: 50 });
  fire(document, 'pointercancel', { pointerId: 2 }); assert.equal(f.width(), 250, 'unrelated cancel is ignored');
  fire(document, 'pointercancel'); assert.equal(f.width(), 300);
  fire(f.handle, 'keydown', { key: 'ArrowLeft' }); assert.equal(f.width(), 290);
  fire(f.handle, 'keydown', { key: 'ArrowLeft', shiftKey: true }); assert.equal(f.width(), 250);
  fire(f.handle, 'keydown', { key: 'ArrowRight', shiftKey: true }); assert.equal(f.width(), 290);
  fire(f.handle, 'keydown', { key: 'ArrowRight', ctrlKey: true }); assert.equal(f.width(), 290, 'modified shortcuts are left alone');
  fire(f.handle, 'keydown', { key: 'Home' }); assert.equal(f.width(), 220); assert.equal(memory.get('vb:rail-width'), '220');
  fire(f.handle, 'keydown', { key: 'ArrowRight' }); fire(f.handle, 'dblclick'); assert.equal(f.width(), 220);

  fire(f.handle, 'pointerdown'); fire(document, 'pointermove', { clientX: 200 }); fire(document, 'pointerup');
  assert.equal(f.width(), 320);
  f.root.clientWidth = 400; fire(window, 'resize');
  assert.equal(f.width(), 160); assert.equal(memory.get('vb:rail-width'), '320', 'viewport clamping preserves the preferred width');
  assert.equal(f.handle.attributes.get('aria-valuemax'), '160');
  f.root.clientWidth = 1200; f.observer.callback(); assert.equal(f.width(), 320, 'expanding the workspace restores the preferred width');
  f.root.classList.add('rail-collapsed');
  fire(f.handle, 'pointerdown'); fire(document, 'pointermove', { clientX: 20 }); fire(document, 'pointerup');
  assert.equal(f.width(), 320, 'a collapsed rail cannot be dragged'); f.root.classList.remove('rail-collapsed');
  fire(f.handle, 'pointerdown'); fire(document, 'pointermove', { clientX: 20 }); f.cleanup();
  assert.equal(f.width(), 320); assert.equal(f.observer.disconnected, true);
  assert.equal(document.body.classList.contains('rail-resizing'), false, 'cleanup cancels active resize and removes global state');
  const beforeCleanup = writes;
  fire(f.handle, 'keydown', { key: 'ArrowLeft' }); fire(f.handle, 'dblclick'); fire(window, 'resize');
  fire(f.handle, 'pointerdown'); fire(document, 'pointermove', { clientX: 20 }); fire(document, 'pointerup');
  assert.equal(writes, beforeCleanup, 'cleanup removes keyboard, pointer, reset, and window listeners');
  for (const invalid of ['garbage', 'null', '', '-20', 'Infinity']) {
    memory.set('vb:rail-width', invalid); const fallback = fixture(); assert.equal(fallback.width(), 220); fallback.cleanup();
  }
  memory.set('vb:rail-width', '9999'); const capped = fixture(); assert.equal(capped.width(), 360); capped.cleanup();
  denied = true;
  const privateMode = fixture(); fire(privateMode.handle, 'keydown', { key: 'ArrowRight' }); assert.equal(privateMode.width(), 230);
  privateMode.cleanup();
} finally { for (const [key, value] of Object.entries(old)) globalThis[key] = value; }
console.log('PASS rail resize: default/storage, viewport limits, pointer commit/cancel, Escape/blur, keyboard/reset, ARIA and cleanup');
