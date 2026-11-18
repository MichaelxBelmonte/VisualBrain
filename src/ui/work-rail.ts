import { icon } from './icons.ts';
import { t } from './i18n.ts';

const DEFAULT_WIDTH = 220;
const MIN_WIDTH = 180;
const MAX_WIDTH = 360;
const CONTENT_MIN = 240;
const STORAGE_KEY = 'vb:rail-width';

/** A drawer on narrow screens, a persistent rail on desktop. Mobile choices never overwrite desktop preferences. */
export function bindRailVisibility(root: HTMLElement, toggle: HTMLElement, fit: () => void): () => void {
  const narrow = window.matchMedia('(max-width: 760px)');
  let desktopClosed = false, mobileOpen = false;
  try { desktopClosed = localStorage.getItem('vb:rail-collapsed') === 'true'; } catch { /* optional storage */ }
  const apply = () => {
    const closed = narrow.matches ? !mobileOpen : desktopClosed;
    root.classList.toggle('rail-collapsed', closed);
    toggle.setAttribute('aria-expanded', String(!closed));
    toggle.innerHTML = icon(closed ? 'panelExpand' : 'panelCollapse');
    const label = t(closed ? 'Mostra elenco' : 'Nascondi elenco');
    toggle.setAttribute('aria-label', label); toggle.setAttribute('title', label);
    requestAnimationFrame(fit);
  };
  const dismiss = () => { mobileOpen = false; apply(); };
  const change = () => { mobileOpen = false; apply(); };
  const click = () => {
    if (narrow.matches) mobileOpen = !mobileOpen;
    else {
      desktopClosed = !desktopClosed;
      try { localStorage.setItem('vb:rail-collapsed', String(desktopClosed)); } catch { /* optional storage */ }
    }
    apply();
  };
  const select = (event: Event) => {
    if (narrow.matches && (event.target as HTMLElement).closest('[data-node],[data-session]')) dismiss();
  };
  const key = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && narrow.matches && mobileOpen) { dismiss(); toggle.focus(); }
  };
  const backdrop = root.querySelector('#work-rail-backdrop');
  const close = root.querySelector('#work-rail-dismiss');
  toggle.addEventListener('click', click);
  backdrop?.addEventListener('click', dismiss); close?.addEventListener('click', dismiss);
  root.addEventListener('click', select); root.addEventListener('keydown', key); toggle.addEventListener('keydown', key);
  narrow.addEventListener('change', change); apply();
  return () => {
    toggle.removeEventListener('click', click);
    backdrop?.removeEventListener('click', dismiss); close?.removeEventListener('click', dismiss);
    root.removeEventListener('click', select); root.removeEventListener('keydown', key); toggle.removeEventListener('keydown', key);
    narrow.removeEventListener('change', change);
  };
}

/** On very small viewports the rail may shrink below 180px to leave room for the workspace. */
export function railWidthLimits(available: number): { min: number; max: number } {
  const max = Number.isFinite(available) && available > 0 ? Math.max(0, Math.min(MAX_WIDTH, available - CONTENT_MIN)) : MAX_WIDTH;
  return { min: Math.min(MIN_WIDTH, max), max };
}

/** Resize only the workspace rail; no file node, session, or terminal is recreated. */
export function bindRailResize(root: HTMLElement, handle: HTMLElement): () => void {
  let preferred = DEFAULT_WIDTH;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const saved = raw?.trim() ? Number(raw) : NaN;
    if (Number.isFinite(saved) && saved > 0) preferred = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, saved));
  } catch { /* The current session can resize even when storage is unavailable. */ }
  let width = preferred;
  let cancelDrag: (() => void) | undefined;
  const limits = () => railWidthLimits(root.clientWidth || window.innerWidth);
  const apply = (value: number) => {
    const { min, max } = limits();
    width = Math.round(Math.max(min, Math.min(max, value)));
    root.style.setProperty('--work-rail-width', `${width}px`);
    handle.setAttribute('aria-valuemin', String(min));
    handle.setAttribute('aria-valuemax', String(max));
    handle.setAttribute('aria-valuenow', String(width));
  };
  const save = (value: number) => {
    preferred = value;
    try { localStorage.setItem(STORAGE_KEY, String(preferred)); } catch { /* Keep the width in memory. */ }
    apply(preferred);
  };
  const reset = () => { cancelDrag?.(); save(DEFAULT_WIDTH); };
  handle.setAttribute('role', 'separator'); handle.setAttribute('aria-orientation', 'vertical');
  handle.tabIndex = 0; handle.style.touchAction = 'none';
  apply(preferred);
  const down = (event: PointerEvent) => {
    if (event.button !== 0 || root.classList.contains('rail-collapsed')) return;
    cancelDrag?.();
    const start = width, original = preferred;
    let dragging = false;
    const move = (e: PointerEvent) => {
      if (e.pointerId !== event.pointerId) return;
      if (!handle.isConnected) { stop(false); return; }
      if (!dragging && Math.abs(e.clientX - event.clientX) < 3) return;
      dragging = true; e.preventDefault();
      root.classList.add('rail-resizing'); document.body.classList.add('rail-resizing');
      apply(start + e.clientX - event.clientX);
    };
    const stop = (commit: boolean) => {
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', cancel); document.removeEventListener('keydown', escape, true);
      window.removeEventListener('blur', cancel); cancelDrag = undefined;
      root.classList.remove('rail-resizing'); document.body.classList.remove('rail-resizing');
      if (commit && dragging) save(width); else { preferred = original; apply(preferred); }
    };
    const up = (e: PointerEvent) => { if (e.pointerId === event.pointerId) stop(true); };
    const cancel = (e?: PointerEvent | Event) => { if (!e || !('pointerId' in e) || e.pointerId === event.pointerId) stop(false); };
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); stop(false); } };
    cancelDrag = () => stop(false);
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', cancel); document.addEventListener('keydown', escape, true);
    window.addEventListener('blur', cancel);
  };
  const key = (e: KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'Home') { e.preventDefault(); reset(); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault(); cancelDrag?.();
      const step = e.shiftKey ? 40 : 10;
      const { min, max } = limits();
      save(Math.max(min, Math.min(max, width + (e.key === 'ArrowLeft' ? -step : step))));
    }
  };
  const resize = () => { cancelDrag?.(); apply(preferred); };
  const observer = new ResizeObserver(resize); observer.observe(root);
  handle.addEventListener('pointerdown', down); handle.addEventListener('keydown', key); handle.addEventListener('dblclick', reset);
  window.addEventListener('resize', resize);
  return () => {
    cancelDrag?.(); observer.disconnect(); window.removeEventListener('resize', resize);
    handle.removeEventListener('pointerdown', down); handle.removeEventListener('keydown', key); handle.removeEventListener('dblclick', reset);
  };
}

/** The rail search is always visible: Escape clears it and gives the whole list back. */
export function bindRailSearch(field: HTMLInputElement): () => void {
  const key = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !field.value) return;
    event.preventDefault(); event.stopPropagation();
    field.value = ''; field.dispatchEvent(new Event('input', { bubbles: true }));
  };
  field.addEventListener('keydown', key);
  return () => field.removeEventListener('keydown', key);
}

/** Where ↑/↓/Home/End take the keyboard highlight among `count` visible sessions. `at` is the highlighted one (-1: the
 *  keyboard is on a node row, and `below` is the first session under it, -1 when there is none). ↑ on the first session goes
 *  back to the search field; ↓ on the last one stays there. Pure, so it can be tested. */
export function railStep(count: number, at: number, key: string, below = -1): number | 'search' | null {
  if (!count) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (key === 'ArrowDown') return at >= 0 ? (at + 1 < count ? at + 1 : null) : below >= 0 ? below : null;
  if (key !== 'ArrowUp') return null;
  if (at >= 0) return at > 0 ? at - 1 : 'search';
  const above = below < 0 ? count - 1 : below - 1;
  return above >= 0 ? above : 'search';
}
