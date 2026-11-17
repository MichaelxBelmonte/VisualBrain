import { t } from './i18n.ts';

interface TerminalQuickItem {
  id: string;
  label: string;
  model?: string;
  preview: () => string;
  canChangeModel: boolean;
}

interface TerminalQuickMenuOptions {
  anchor: HTMLElement;
  items: readonly TerminalQuickItem[];
  selectedId?: string | null;
  onOpen: (id: string) => void;
  onModel: (id: string) => void;
}

let dismissCurrent: (() => void) | undefined;

/** A non-modal terminal picker. Selecting a row previews it; activating it opens the terminal. */
export function openTerminalQuickMenu({ anchor, items, selectedId, onOpen, onModel }: TerminalQuickMenuOptions): () => void {
  dismissCurrent?.();
  const menu = document.createElement('section');
  menu.id = 'terminal-quick-menu';
  menu.className = 'terminal-quick-menu';
  menu.setAttribute('role', 'dialog');
  menu.setAttribute('aria-label', t('Terminali'));
  menu.tabIndex = -1;
  const list = document.createElement('div');
  list.className = 'terminal-quick-list';
  list.tabIndex = 0;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', t('Terminali'));
  const rows = items.map((item, index) => {
    const row = document.createElement('div');
    row.id = `terminal-quick-option-${index}`;
    row.className = 'terminal-quick-option';
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', 'false');
    const label = document.createElement('span');
    label.textContent = item.label;
    row.append(label);
    if (item.model) {
      const model = document.createElement('small');
      model.textContent = item.model;
      row.append(model);
    }
    row.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') select(index); });
    row.addEventListener('click', () => { close(); onOpen(item.id); });
    list.append(row);
    return row;
  });
  const preview = document.createElement('pre');
  preview.className = 'terminal-quick-preview';
  preview.tabIndex = -1;
  preview.setAttribute('role', 'region');
  preview.setAttribute('aria-label', t('Anteprima del terminale'));
  const modelButton = document.createElement('button');
  modelButton.type = 'button';
  modelButton.className = 'btn terminal-quick-model';
  modelButton.textContent = t('Nuova sessione con un altro modello');
  let active = -1;
  function select(index: number) {
    if (active === index) return;
    rows[active]?.setAttribute('aria-selected', 'false');
    active = index;
    const row = rows[index], item = items[index];
    row.setAttribute('aria-selected', 'true');
    list.setAttribute('aria-activedescendant', row.id);
    preview.textContent = item.preview() || t('Nessuna anteprima disponibile');
    preview.scrollTop = preview.scrollHeight;
    modelButton.hidden = !item.canChangeModel;
  }
  modelButton.addEventListener('click', () => {
    const item = items[active];
    if (item?.canChangeModel) { close(); onModel(item.id); }
  });
  if (items.length) menu.append(list, preview, modelButton);
  else menu.textContent = t('Nessun terminale disponibile');
  document.body.append(menu);
  const oldControls = anchor.getAttribute('aria-controls');
  anchor.setAttribute('aria-expanded', 'true');
  anchor.setAttribute('aria-controls', menu.id);
  const events = new AbortController();
  const { signal } = events;
  function close() {
    if (signal.aborted) return;
    const restoreFocus = menu.contains(document.activeElement);
    events.abort();
    menu.remove();
    anchor.setAttribute('aria-expanded', 'false');
    if (oldControls === null) anchor.removeAttribute('aria-controls');
    else anchor.setAttribute('aria-controls', oldControls);
    if (restoreFocus && anchor.isConnected) anchor.focus({ preventScroll: true });
    dismissCurrent = undefined;
  }
  dismissCurrent = close;
  function position() {
    if (!anchor.isConnected) { close(); return; }
    const rect = anchor.getBoundingClientRect();
    const gap = 6, edge = 8;
    const below = innerHeight - rect.bottom - edge - gap, above = rect.top - edge - gap;
    const opensAbove = below < 260 && above > below;
    menu.style.maxHeight = `${Math.max(0, opensAbove ? above : below)}px`;
    menu.style.left = `${Math.max(edge, Math.min(rect.left, innerWidth - edge - menu.offsetWidth))}px`;
    menu.style.top = opensAbove ? 'auto' : `${rect.bottom + gap}px`;
    menu.style.bottom = opensAbove ? `${innerHeight - rect.top + gap}px` : 'auto';
  }
  window.addEventListener('resize', position, { signal });
  window.addEventListener('scroll', e => { if (!menu.contains(e.target as Node)) position(); }, { capture: true, signal });
  document.addEventListener('pointerdown', e => {
    if (!menu.contains(e.target as Node) && !anchor.contains(e.target as Node)) close();
  }, { capture: true, signal });
  document.addEventListener('focusin', e => {
    if (!menu.contains(e.target as Node) && !anchor.contains(e.target as Node)) close();
  }, { signal });
  menu.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === 'Tab') {
      if (e.shiftKey && e.target === modelButton) return;
      if (!e.shiftKey && e.target === list && !modelButton.hidden) return;
      if (e.shiftKey) e.preventDefault();
      close();
      return;
    }
    if (e.target !== list || !items.length) return;
    switch (e.key) {
      case 'ArrowDown': select((active + 1) % items.length); break;
      case 'ArrowUp': select((active + items.length - 1) % items.length); break;
      case 'Home': select(0); break;
      case 'End': select(items.length - 1); break;
      case 'Enter': close(); onOpen(items[active].id); break;
      default: return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (!signal.aborted) rows[active].scrollIntoView({ block: 'nearest' });
  });
  position();
  if (items.length) {
    const initial = items.findIndex(item => item.id === selectedId);
    select(Math.max(0, initial));
    list.focus({ preventScroll: true });
    rows[active].scrollIntoView({ block: 'nearest' });
  } else menu.focus({ preventScroll: true });
  return close;
}
