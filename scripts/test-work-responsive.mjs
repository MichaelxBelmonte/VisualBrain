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
const toggle = new Element(), close = new Element(), backdrop = new Element(), root = new Element();
root.querySelector = selector => selector === '#work-rail-dismiss' ? close : backdrop;
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
  click(toggle); click(close); assert.equal(collapsed(),true);
  click(toggle);
  const esc = new Event('keydown'); Object.defineProperty(esc,'key',{value:'Escape'}); root.dispatchEvent(esc);
  assert.equal(collapsed(),true); assert.equal(toggle.focused,true,'Escape restores focus to drawer toggle');
  click(toggle);
  const selected = new Event('click'); Object.defineProperty(selected,'target',{value:{closest:()=>({})}}); root.dispatchEvent(selected);
  assert.equal(collapsed(),true,'opening a node or session dismisses the mobile drawer');
  resize(false); assert.equal(collapsed(),false,'desktop preference survives mobile navigation');
  click(toggle); resize(true); click(toggle); resize(false);
  assert.equal(collapsed(),true,'desktop closed preference survives mobile opening');
  const prior = fits; cleanup(); click(toggle); resize(true); click(close);
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
