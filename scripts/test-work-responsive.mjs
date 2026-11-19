// Test the actual rail controller across breakpoints, without a browser or user settings.
import assert from 'node:assert/strict';
import { bindRailSearch, bindRailVisibility } from '../src/ui/work-rail.ts';
class Element extends EventTarget {
  names = new Set(); attrs = new Map(); focused = false;
  classList = { contains: key => this.names.has(key), toggle: (key, value) => value ? this.names.add(key) : this.names.delete(key) };
  setAttribute(key, value) { this.attrs.set(key, value); }
  focus() { this.focused = true; }
}
const original = Object.fromEntries(['window','localStorage','requestAnimationFrame'].map(k => [k,globalThis[k]]));
const media = Object.assign(new EventTarget(), { matches: false });
const memory = new Map(); let fits = 0;
const toggle = new Element(), backdrop = new Element(), root = new Element();
root.querySelector = selector => { assert.equal(selector, '#work-rail-backdrop', 'the drawer has no close button of its own'); return backdrop; };
globalThis.window = { matchMedia: query => { assert.equal(query,'(max-width: 760px)'); return media; } };
globalThis.localStorage = { getItem: k => memory.get(k) ?? null, setItem: (k,v) => memory.set(k,v) };
globalThis.requestAnimationFrame = callback => callback();
const click = element => element.dispatchEvent(new Event('click'));
const resize = narrow => { media.matches = narrow; media.dispatchEvent(new Event('change')); };
const collapsed = () => root.classList.contains('rail-collapsed');
try {
  const cleanup = bindRailVisibility(root, toggle, () => fits++);
  assert.equal(collapsed(),false); assert.equal(toggle.attrs.get('aria-expanded'),'true');
  assert.equal(toggle.attrs.get('aria-label'),'Nascondi elenco');
  const expandedIcon=toggle.innerHTML;
  click(toggle); assert.equal(collapsed(),true); assert.equal(memory.get('vb:rail-collapsed'),'true');
  assert.equal(toggle.attrs.get('aria-label'),'Mostra elenco'); assert.notEqual(toggle.innerHTML,expandedIcon);
  click(toggle); assert.equal(collapsed(),false); assert.equal(memory.get('vb:rail-collapsed'),'false');
  resize(true); assert.equal(collapsed(),true,'mobile starts with closed drawer');
  click(toggle); assert.equal(collapsed(),false); assert.equal(toggle.attrs.get('aria-expanded'),'true');
  assert.equal(toggle.attrs.get('aria-label'),'Nascondi elenco');
  assert.equal(toggle.innerHTML,expandedIcon);
  assert.equal(memory.get('vb:rail-collapsed'),'false','mobile opening preserves desktop preference');
  click(backdrop); assert.equal(collapsed(),true);
  click(toggle); click(toggle); assert.equal(collapsed(),true,'the toggle that opened the drawer closes it');
  click(toggle);
  const esc = new Event('keydown'); Object.defineProperty(esc,'key',{value:'Escape'}); root.dispatchEvent(esc);
  assert.equal(collapsed(),true); assert.equal(toggle.focused,true,'Escape restores focus to drawer toggle');
  click(toggle);
  const selected = new Event('click'); Object.defineProperty(selected,'target',{value:{closest:()=>({})}}); root.dispatchEvent(selected);
  assert.equal(collapsed(),true,'opening a node or session dismisses the mobile drawer');
  resize(false); assert.equal(collapsed(),false,'desktop preference survives mobile navigation');
  click(toggle); resize(true); click(toggle); resize(false);
  assert.equal(collapsed(),true,'desktop closed preference survives mobile opening');
  const prior = fits; cleanup(); click(toggle); resize(true); click(backdrop);
  assert.equal(fits,prior,'cleanup removes all listeners');
  memory.set('vb:rail-collapsed','true'); media.matches=false;
  const dispose = bindRailVisibility(root,toggle,()=>{}); assert.equal(collapsed(),true,'saved desktop preference restored'); dispose();
} finally { for (const [key,value] of Object.entries(original)) globalThis[key]=value; }
console.log('PASS responsive rail: desktop preference, mobile drawer, breakpoint restoration, selection, Escape, backdrop, ARIA and cleanup');

const field = new Element();
field.value = ''; let filters = 0;
field.addEventListener('input', () => filters++);
const unbind = bindRailSearch(field);
const escapeKey = () => { const e = new Event('keydown'); Object.defineProperty(e, 'key', {value: 'Escape'}); field.dispatchEvent(e); return e; };
field.value = 'a node'; escapeKey(); assert.equal(field.value, ''); assert.equal(filters, 1, 'Escape clears the search and refilters');
escapeKey(); assert.equal(filters, 1, 'an empty search lets Escape through');
unbind(); field.value = 'x'; escapeKey(); assert.equal(field.value, 'x');
console.log('PASS rail search: always visible, Escape clears it, cleanup');

// Narrow window, from the sources the app ships.
import { readFileSync } from 'node:fs';
const css = readFileSync(new URL('../src/ui/style.css', import.meta.url), 'utf8');
const board = readFileSync(new URL('../src/ui/work-board.ts', import.meta.url), 'utf8');
const terminal = readFileSync(new URL('../src/ui/terminal.ts', import.meta.url), 'utf8');
// Under 760 px the rail is an absolute drawer: without an explicit track the main area fell into the 0 px column
// and Lavoro, Terminali and Codice were blank.
assert.match(css, /^\.work-main \{ grid-column: 2; grid-row: 1;/m, 'the main area always takes the second track');
assert.match(css, /^\.needs-badge\[hidden\] \{ display: none; \}/m, '«Lavoro» shows no 0 when nothing waits on the person');
assert.match(css, /max-width: 480px\) \{\n  \.work-new > summary \.control-label, \.work-new > summary \.chevron \{ display: none; \}/, 'at phone width «Nuovo» is only its +');
console.log('PASS narrow Operativa: main area visible, no 0 badge, «Nuovo» fits the bar');

// Board: placeholder cards until the first response, then aria-busy goes back to false; an error removes them.
assert.match(board, /<div class="board lavoro" aria-busy="true">/);
assert.match(board, /<div class="lavoro-cards">\$\{SKELETON\}<\/div>/);
assert.match(board, /if \(error && !view\) \{ el\.querySelectorAll\('\.lavoro-skeleton'\)\.forEach\(card => card\.remove\(\)\);/);
assert.match(css, /\.lavoro-skeleton > i \{[^}]*animation: loading-pulse/);
console.log('PASS board loading: placeholder cards, aria-busy, removed on error');

// One button per action: «+ Incarico» lives in the header, «+ Agente» in the hint only while no agent runs.
assert.doesNotMatch(board, /data-new>＋ Incarico/, 'the hint does not repeat «+ Incarico»');
assert.match(board, /if \(info && addAgentChip\(members, waiting\)\) chips\.push/, 'the + member chip follows addAgentChip');
assert.match(board, /paintGoal\(lanes\.you\.length\);/, 'the goal row is painted after «Serve te», which decides where «+ Agente» goes');
assert.doesNotMatch(board, /Impostalo dal menu/, 'an empty objective is a button, not an instruction');
assert.match(board, /data-panel="settings">Imposta obiettivo<\/button>/);
console.log('PASS board actions: one button per action, empty objective as a button');

// Menus: every Operativa menu closes with Escape and gives the focus back to its button; the squad ··· stays on the right.
assert.match(terminal, /if \(e\.key !== 'Escape'\) return;\n\s*const open = \[\.\.\.document\.querySelectorAll<HTMLDetailsElement>\('\.work-overflow\[open\]'\)\];/);
assert.match(css, /^\.lavoro-tools \{[^}]*margin-left: auto;/m, 'the squad ··· stays on the right, so its menu opens inside the window');
console.log('PASS Operativa menus: Escape closes them, the squad menu opens inside the window');

// Shells: the later plain sessions of an agent in a node are numbered, the first keeps its name.
assert.match(terminal, /if \(!t\.info\.role\) return this\.agentLabel\(t\);/, 'two plain shells of a node are «Terminale» and «Terminale 2»');
assert.match(terminal, /return position > 0 \? `\$\{labels\[t\.info\.agent\]\} \$\{position \+ 1\}` : labels\[t\.info\.agent\];/, 'the first keeps its plain name');
console.log('PASS plain sessions: the second and later are numbered in rail and tabs');

// The node is named once: above 760 px the bar's node menu has the name and «Mostra nella mappa».
assert.match(css, /@media \(min-width: 761px\) \{ \.lavoro-head > \.lavoro-node, \.lavoro-menu \[data-reveal\] \{ display: none; \} \}/, 'with the bar node menu visible, the board repeats neither the node name nor «Mostra nella mappa»');
console.log('PASS node named once, «Mostra nella mappa» once');

// Launcher: a short placeholder, the keys in the title.
const launcher = readFileSync(new URL('../src/ui/work-launcher.ts', import.meta.url), 'utf8');
assert.match(launcher, /placeholder="Obiettivo \(facoltativo\)" title="Invio avvia · Maiusc\+Invio va a capo"/);
console.log('PASS launcher: short objective placeholder');
