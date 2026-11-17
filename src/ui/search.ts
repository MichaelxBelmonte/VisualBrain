import { t as tr, ui } from './i18n.ts';
// ⌘K search overlay.
import { api } from './api.ts';
import type { GraphNode } from '../shared/types.ts';
import { SEARCH_FILTERS, isSearchFilter, type SearchFilter } from '../shared/search-filter.ts';

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

export class Search {
  private readonly overlay: HTMLElement;
  private readonly onPick: (id: number) => void;
  private results: GraphNode[] = [];
  private sel = 0;
  private timer: number | null = null;
  private input!: HTMLInputElement;
  private list!: HTMLElement;
  private pick!: (id: number) => void;
  private generation = 0;
  private filter: SearchFilter = 'all';

  constructor(overlay: HTMLElement, onPick: (id: number) => void) {
    this.overlay = overlay;
    this.onPick = onPick;
  }

  isOpen(): boolean { return !this.overlay.classList.contains('hidden') && this.overlay.dataset.mode === 'search'; }

  open(onPick = this.onPick, placeholder = tr('Cerca file, cartelle, progetti…')): void {
    this.generation++;
    this.pick = onPick;
    this.results = []; this.sel = 0;
    this.overlay.dataset.mode = 'search';
    this.overlay.innerHTML = ui`<div class="dialog search"><input placeholder="Cerca file, cartelle, progetti…" autocomplete="off" spellcheck="false"><div class="results"><div class="empty">Scrivi per cercare. ↑↓ per muoverti, Invio per aprire.</div></div></div>`;
    this.overlay.classList.remove('hidden');
    const filters = document.createElement('div');
    filters.className = 'search-filters';
    filters.setAttribute('role', 'group'); filters.setAttribute('aria-label', tr('Filtra per tipo'));
    filters.innerHTML = Object.entries(SEARCH_FILTERS).map(([value, label]) => `<button type="button" class="chip" data-filter="${value}" aria-pressed="${value === this.filter}">${esc(tr(label))}</button>`).join('');
    this.overlay.querySelector('input')!.after(filters);
    filters.addEventListener('click', e => {
      const value = (e.target as HTMLElement).closest<HTMLElement>('[data-filter]')?.dataset.filter;
      if (!value || !isSearchFilter(value)) return;
      this.filter = value;
      filters.querySelectorAll<HTMLElement>('[data-filter]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.filter === value)));
      this.schedule(); this.input.focus();
    });
    this.input = this.overlay.querySelector('input')!;
    this.input.placeholder = placeholder;
    this.list = this.overlay.querySelector('.results')!;
    this.input.focus();
    this.input.addEventListener('input', () => this.schedule());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); this.sel = Math.min(this.results.length - 1, this.sel + 1); this.renderList(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); this.sel = Math.max(0, this.sel - 1); this.renderList(); }
      else if (e.key === 'Enter') { e.preventDefault(); const r = this.results[this.sel]; if (r) { const pick = this.pick; this.close(); pick(r.id); } }
      else if (e.key === 'Escape') { this.close(); }
    });
    this.overlay.onmousedown = (e) => { if (e.target === this.overlay) this.close(); };
  }

  close(): void {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.overlay.classList.add('hidden');
    this.overlay.innerHTML = '';
    delete this.overlay.dataset.mode;
  }

  private schedule(): void {
    this.generation++;
    this.results = []; this.sel = 0;
    if (this.timer) clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.run(), 120);
  }

  private async run(): Promise<void> {
    const generation = this.generation;
    const q = this.input.value.trim();
    if (!q) { this.results = []; this.list.innerHTML = tr('<div class="empty">Scrivi per cercare.</div>'); return; }
    let results: GraphNode[];
    try { ({ results } = await api.search(q, 40, this.filter)); }
    catch { if (generation === this.generation && this.isOpen()) this.list.innerHTML = tr('<div class="empty">Ricerca non disponibile. Riprova.</div>'); return; }
    if (generation !== this.generation || !this.isOpen() || this.input.value.trim() !== q) return;
    this.results = results;
    this.sel = 0;
    this.renderList();
  }

  private renderList(): void {
    if (!this.results.length) { this.list.innerHTML = tr('<div class="empty">Nessun risultato.</div>'); return; }
    this.list.innerHTML = this.results.map((r, i) => ui`<div class="res ${i === this.sel ? 'sel' : ''}" data-i="${i}">
      <span class="shape ${r.kind === 'dir' ? (r.cls === 'project' ? 'project' : '') : r.kind === 'external' ? 'external' : 'file'}"></span>
      <div><div>${esc(r.name)}${r.kind === 'dir' ? '/' : ''}</div><div class="p">${esc(r.path.replace(/^\/Users\/[^/]+/, '~'))}</div></div>
      <span class="k">${esc(r.cls)}</span></div>`).join('');
    this.list.querySelectorAll<HTMLElement>('.res').forEach((el) => el.addEventListener('click', () => { const r = this.results[Number(el.dataset.i)]; if (r) { const pick = this.pick; this.close(); pick(r.id); } }));
    this.list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  }
}
