import { t as tr, ui } from './i18n.ts';
// Top bar: search, fit, the "Vista" menu of the map (actions and links), the AI dialog; ⚙ opens Impostazioni; status line and legend.
import { openSettings } from './settings.ts';
import { api } from './api.ts';
import { ALL_EDGE_KINDS, EDGE_KIND_LABELS, type EdgeMode, type Store } from './state.ts';
import type { Stats } from '../shared/types.ts';

export interface ToolbarCallbacks {
  fit(): void;
  reorder(): void;
  collapseAll(): void;
  toggleCompact(): void;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

export class Toolbar {
  private readonly store: Store;
  private readonly cb: ToolbarCallbacks;
  private readonly overlay: HTMLElement;
  private readonly menu: HTMLElement;
  private readonly statsEl: HTMLElement;
  private readonly progressEl: HTMLElement;
  private openMenuName: 'edges' | null = null;

  constructor(store: Store, cb: ToolbarCallbacks) {
    this.store = store;
    this.cb = cb;
    this.overlay = document.getElementById('overlay')!;
    this.menu = document.getElementById('menu')!;
    this.statsEl = document.getElementById('stats')!;
    this.progressEl = document.getElementById('progress')!;
    document.getElementById('btn-fit')!.addEventListener('click', () => this.cb.fit());
    document.getElementById('btn-edges')!.addEventListener('click', () => this.toggleMenu('edges'));
    document.getElementById('btn-more')!.addEventListener('click', () => { this.closeMenus(); void openSettings().catch(e => this.flash(String(e))); });
    document.addEventListener('mousedown', (e) => {
      const t = e.target as HTMLElement;
      if (this.openMenuName && !this.menu.contains(t) && !t.closest('#btn-edges')) this.closeMenus();
    });
    store.on('status', () => this.renderStats());
    this.renderLegend();
  }

  setProgress(text: string): void { this.progressEl.textContent = text; }

  /** Shows a short notice in the status bar and clears it unless something else replaced it. */
  flash(text: string, ms = 4000): void {
    this.progressEl.textContent = text;
    window.setTimeout(() => { if (this.progressEl.textContent === text) this.progressEl.textContent = ''; }, ms);
  }

  menuOpen(): boolean { return this.openMenuName !== null; }

  closeMenus(): void {
    this.openMenuName = null;
    this.menu.classList.add('hidden');
    this.menu.innerHTML = '';
    document.querySelectorAll('#btn-edges.active').forEach((b) => b.classList.remove('active'));
  }

  private toggleMenu(name: 'edges'): void {
    if (this.openMenuName === name) { this.closeMenus(); return; }
    this.closeMenus();
    this.openMenuName = name;
    const btn = document.getElementById('btn-edges')!;
    btn.classList.add('active');
    this.menu.innerHTML = this.edgesMenu();
    this.menu.classList.remove('hidden');
    const r = btn.getBoundingClientRect();
    this.menu.style.right = ui`${Math.max(8, window.innerWidth - r.right)}px`;
    this.bindEdgesMenu();
  }

  private edgesMenu(): string {
    const f = this.store.filters;
    const radio = (v: EdgeMode, label: string, hint: string) => ui`<label class="opt"><input type="radio" name="edge-mode" value="${v}" ${f.edgeMode === v ? 'checked' : ''}><span>${label}<small>${hint}</small></span></label>`;
    return ui`<h4>Mappa</h4>
      <button class="item item-key" id="m-reorder"><span>Riordina la mappa</span><kbd>R</kbd></button>
      <button class="item item-key" id="m-compact"><span>${f.compact ? tr('Espandi dettagli') : tr('Compatta la mappa')}</span><kbd>C</kbd></button>
      <button class="item" id="m-collapse"><span>Chiudi tutte le cartelle</span><small>torna alla mappa dei soli progetti</small></button>
      <button class="item" id="m-index"><span>Aggiorna dai file</span><small>rilegge le cartelle e aggiorna la mappa</small></button>
      <button class="item" id="m-analyze"><span>Trova collegamenti con l'AI…</span><small>aree, descrizioni e relazioni ipotizzate dal modello</small></button>
      <div class="sep"></div>
      <h4>Quali collegamenti mostrare</h4>
      ${radio('focus', tr('Solo dell\'elemento scelto'), tr('gli altri restano in trasparenza (consigliato)'))}
      ${radio('all', tr('Tutti'), tr('ogni collegamento in evidenza'))}
      ${radio('none', tr('Solo al passaggio o al clic'), tr('nessun collegamento di sfondo'))}
      ${radio('off', tr('Nessuno'), tr('nemmeno sull\'elemento scelto; restano elencati nel pannello'))}
      <div class="sep"></div>
      <label class="opt"><input type="checkbox" id="f-inferred" ${f.inferred ? 'checked' : ''}><span>Anche i collegamenti ipotizzati<small>testi simili e relazioni trovate dall'AI, tratteggiati</small></span></label>
      <details><summary class="link">Tipi di collegamento</summary>
        <div class="kinds">${ALL_EDGE_KINDS.map((k) => ui`<label><input type="checkbox" data-kind="${k}" ${f.kinds.has(k) ? 'checked' : ''}> ${esc(EDGE_KIND_LABELS[k])}</label>`).join('')}</div>
        <div class="row2"><button class="btn small ghost" id="f-all">Tutti</button><button class="btn small ghost" id="f-none">Nessuno</button></div>
      </details>
      <div class="sep"></div>
      <h4>Altri elementi nella mappa</h4>
      <label class="opt"><input type="checkbox" id="f-symlinks" ${f.symlinks ? 'checked' : ''}><span>Collegamenti simbolici<small>gli alias lasciati sulla Scrivania</small></span></label>
      <label class="opt"><input type="checkbox" id="f-externals" ${f.externals ? 'checked' : ''}><span>Riferimenti fuori dalla Scrivania<small>percorsi citati che stanno altrove o non esistono più</small></span></label>
      <div class="sep"></div>
      <h4>File mostrati nelle cartelle grandi</h4>
      <input type="range" id="f-min" min="0" max="0.9" step="0.05" value="${f.min}">
      <div class="muted" id="f-min-label">importanza ≥ ${Math.round(f.min * 100)}% (cartelle con più di 40 voci)</div>`;
  }

  private bindEdgesMenu(): void {
    const el = this.menu;
    el.querySelector('#m-reorder')!.addEventListener('click', () => { this.closeMenus(); this.cb.reorder(); });
    el.querySelector('#m-compact')!.addEventListener('click', () => { this.closeMenus(); this.cb.toggleCompact(); });
    el.querySelector('#m-index')!.addEventListener('click', () => { this.closeMenus(); void this.reindex(); });
    el.querySelector('#m-analyze')!.addEventListener('click', () => { this.closeMenus(); this.analyzeDialog(); });
    el.querySelector('#m-collapse')!.addEventListener('click', () => { this.closeMenus(); this.cb.collapseAll(); });
    el.querySelectorAll<HTMLInputElement>('input[name=edge-mode]').forEach((r) => r.addEventListener('change', () => { if (r.checked) this.store.setFilters({ edgeMode: r.value as EdgeMode }); }));
    el.querySelector<HTMLInputElement>('#f-inferred')!.addEventListener('change', (e) => this.store.setFilters({ inferred: (e.target as HTMLInputElement).checked }));
    el.querySelector<HTMLInputElement>('#f-symlinks')!.addEventListener('change', (e) => this.store.setFilters({ symlinks: (e.target as HTMLInputElement).checked }));
    el.querySelector<HTMLInputElement>('#f-externals')!.addEventListener('change', (e) => this.store.setFilters({ externals: (e.target as HTMLInputElement).checked }));
    el.querySelectorAll<HTMLInputElement>('[data-kind]').forEach((c) => c.addEventListener('change', () => {
      const kinds = new Set(this.store.filters.kinds);
      if (c.checked) kinds.add(c.dataset.kind!); else kinds.delete(c.dataset.kind!);
      this.store.setFilters({ kinds });
    }));
    el.querySelector('#f-all')!.addEventListener('click', () => { this.store.setFilters({ kinds: new Set(ALL_EDGE_KINDS) }); el.querySelectorAll<HTMLInputElement>('[data-kind]').forEach((c) => { c.checked = true; }); });
    el.querySelector('#f-none')!.addEventListener('click', () => { this.store.setFilters({ kinds: new Set() }); el.querySelectorAll<HTMLInputElement>('[data-kind]').forEach((c) => { c.checked = false; }); });
    const range = el.querySelector<HTMLInputElement>('#f-min')!;
    range.addEventListener('input', () => { el.querySelector('#f-min-label')!.textContent = ui`importanza ≥ ${Math.round(Number(range.value) * 100)}% (cartelle con più di 40 voci)`; });
    range.addEventListener('change', () => this.store.setFilters({ min: Number(range.value) }));
  }

  /** Legend and commands live behind one "?" button, closed by default: the map keeps the whole stage. */
  private renderLegend(): void {
    const el = document.getElementById('legend')!;
    let open = false;
    try { open = localStorage.getItem('vb:legend') === '1'; } catch { /* storage unavailable */ }
    el.innerHTML = ui`<button class="legend-toggle" aria-controls="legend-body" title="Legenda e comandi" aria-label="Legenda e comandi">?</button>
      <div id="legend-body" class="legend-body"><div class="legend-grid"><span><span class="shape"></span> progetto o cartella</span><span><span class="shape dashed"></span> copia o archivio</span>
      <span><span class="sw"></span> collegamento osservato</span><span><span class="sw dashed"></span> collegamento ipotizzato</span></div>
      <div class="legend-keys">clic: seleziona · <b>▸</b>: apre la cartella · trascina: sposta · ⌘ + rotella: zoom · <kbd>Esc</kbd> deseleziona</div></div>`;
    const toggle = el.querySelector<HTMLElement>('.legend-toggle')!;
    const apply = () => { el.classList.toggle('open', open); toggle.setAttribute('aria-expanded', String(open)); };
    toggle.addEventListener('click', () => { open = !open; try { localStorage.setItem('vb:legend', open ? '1' : '0'); } catch { /* ignore */ } apply(); });
    apply();
  }

  renderStats(): void {
    const s: Stats | undefined = this.store.status?.stats;
    if (!s) return;
    const last = s.lastScan ? new Date(s.lastScan).toLocaleTimeString(tr('it-IT'), { hour: '2-digit', minute: '2-digit' }) : '–';
    this.statsEl.textContent = ui`${s.files.toLocaleString(tr('it-IT'))} file · ${s.dirs.toLocaleString(tr('it-IT'))} cartelle · ${s.projects} progetti · ${s.edges.toLocaleString(tr('it-IT'))} collegamenti (${s.verifiedEdges.toLocaleString(tr('it-IT'))} osservati) · aggiornato alle ${last}`;
    const root = document.getElementById('root')!;
    root.textContent = s.roots.map((r) => r.replace(/^\/(?:Users|home)\/[^/]+/, '~')).join(', ');
    const label = this.store.status?.config.label ?? '';
    const badge = document.getElementById('brain-label')!;
    badge.textContent = label;
    badge.classList.toggle('hidden', !label);
    document.title = label ? `${label} · Brain` : 'Brain';
  }

  private async reindex(): Promise<void> {
    try {
      const r = await api.index();
      // a short notice: the corner dot follows the pass itself
      this.flash(r.started ? tr('Aggiornamento dai file avviato…') : tr('Aggiornamento già in corso'));
    } catch (err) {
      this.setProgress(String(err));
    }
  }

  private dialog(title: string, body: string, foot: string): HTMLElement {
    this.overlay.dataset.mode = 'dialog';
    this.overlay.innerHTML = ui`<div class="dialog"><div class="dhead"><span>${esc(title)}</span><button class="btn small ghost" data-close>Chiudi</button></div><div class="dbody">${body}</div><div class="dfoot">${foot}</div></div>`;
    this.overlay.classList.remove('hidden');
    const close = () => { this.overlay.classList.add('hidden'); this.overlay.innerHTML = ''; delete this.overlay.dataset.mode; };
    this.overlay.querySelector('[data-close]')!.addEventListener('click', close);
    this.overlay.addEventListener('mousedown', (e) => { if (e.target === this.overlay) close(); });
    return this.overlay;
  }

  closeDialog(): void {
    if (this.overlay.dataset.mode === 'dialog') { this.overlay.classList.add('hidden'); this.overlay.innerHTML = ''; delete this.overlay.dataset.mode; }
  }

  private analyzeDialog(): void {
    const llm = this.store.status?.config.llm;
    const el = this.dialog(tr('Trova collegamenti con l\'AI'), ui`
      <p>Il modello riceve un riepilogo della mappa e propone aree, descrizioni, collegamenti ipotizzati (con confidenza e motivo) e suggerimenti. I collegamenti ipotizzati restano distinti da quelli osservati nei file.</p>
      <div class="radio">
        <label><input type="radio" name="consent" value="metadata" checked><span>Solo informazioni sui file<small>Nomi, percorsi, tipi, dimensioni, tecnologie e i collegamenti già trovati. Nessun contenuto dei file.</small></span></label>
        <label><input type="radio" name="consent" value="excerpts"><span>Includi estratti dei documenti guida<small>In più le prime 400 battute e i titoli di README, CLAUDE.md e AGENTS.md di ogni unità. Autorizzi l'invio di questi estratti al provider.</small></span></label>
      </div>
      <details style="margin-top:10px"><summary class="link">Dettagli del modello</summary><p class="muted">Provider <b>${esc(llm?.provider ?? '–')}</b> · modello <b>${esc(llm?.model ?? '–')}</b> · effort ${esc(llm?.effort ?? '')}</p></details>
      <div id="preview"></div>`,
      ui`<button class="btn ghost" id="a-preview">Mostra cosa verrà inviato</button><button class="btn" id="a-run">Avvia</button>`);
    const consent = () => (el.querySelector<HTMLInputElement>('input[name=consent]:checked')!.value as 'metadata' | 'excerpts');
    el.querySelector('#a-preview')!.addEventListener('click', async () => {
      try {
        const r = await api.analyze(consent(), true);
        el.querySelector('#preview')!.innerHTML = ui`<div class="muted" style="margin-top:10px">${r.nodes} unità · ${((r.bytes ?? 0) / 1024).toFixed(0)} KB</div><pre class="payload">${esc(r.payload ?? '')}</pre>`;
      } catch (err) {
        el.querySelector('#preview')!.innerHTML = ui`<div style="margin-top:10px">${esc(String(err))}</div>`;
      }
    });
    el.querySelector('#a-run')!.addEventListener('click', async () => {
      const btn = el.querySelector<HTMLButtonElement>('#a-run')!;
      btn.disabled = true;
      try {
        const r = await api.analyze(consent(), false);
        this.setProgress(ui`AI avviata (corsa ${r.runId})…`);
        this.closeDialog();
      } catch (err) {
        btn.disabled = false;
        el.querySelector('#preview')!.innerHTML = ui`<div style="margin-top:10px">${esc(String(err))}</div>`;
      }
    });
  }
}
