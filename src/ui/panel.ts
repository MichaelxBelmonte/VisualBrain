import { t as tr, ui } from './i18n.ts';
// Side panel: details of the selected node, relations with evidence, actions, agents, notes.
import { api } from './api.ts';
import { EDGE_KIND_LABELS, type Store } from './state.ts';
import type { GraphEdge, GraphNode, NodeDetail, TerminalInfo } from '../shared/types.ts';

export interface PanelCallbacks {
  reveal(id: number): void;             // select + show in the graph
  toggleExpand(id: number): void;
  launch(id: number, agent: TerminalInfo['agent'], mode: 'embedded' | 'external', prompt: string): void;
  workspace(id: number): void;
  harness(id: number): void;
  refreshGraph(): void;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return ui`${n} B`;
  if (n < 1024 ** 2) return ui`${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return ui`${(n / 1024 ** 2).toFixed(1)} MB`;
  return ui`${(n / 1024 ** 3).toFixed(2)} GB`;
}

function fmtDate(ms: number): string {
  if (!ms) return '–';
  const d = new Date(ms);
  return d.toLocaleDateString(tr('it-IT'), { day: '2-digit', month: '2-digit', year: 'numeric' }) + ' ' + d.toLocaleTimeString(tr('it-IT'), { hour: '2-digit', minute: '2-digit' });
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

function shortPath(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, '~');
}

function evidenceText(e: GraphEdge): string {
  const ev = e.evidence[0];
  if (!ev) return '';
  const parts: string[] = [];
  if (ev.note) parts.push(ev.note);
  if (ev.line) parts.push(ui`riga ${ev.line}`);
  if (ev.snippet) parts.push(ui`«${ev.snippet.slice(0, 90)}»`);
  if (ev.terms?.length) parts.push(ev.terms.join(', '));
  if (ev.score !== undefined) parts.push(ui`score ${ev.score}`);
  if (ev.token) parts.push(ev.token);
  return parts.join(' · ');
}

export class Panel {
  private readonly el: HTMLElement;
  private readonly store: Store;
  private readonly cb: PanelCallbacks;
  private detail: NodeDetail | null = null;
  private agents = { claude: false, codex: false, hermes: false, agy: false };

  constructor(el: HTMLElement, store: Store, cb: PanelCallbacks) {
    this.el = el;
    this.store = store;
    this.cb = cb;
    store.on('select', () => void this.load());
    store.on('status', () => { if (store.status) this.agents = store.status.config.agents; });
  }

  async load(): Promise<void> {
    const id = this.store.selected;
    if (id === null || id < 0) { this.el.classList.add('hidden'); this.detail = null; return; }
    try {
      const detail = await api.node(id);
      if (this.store.selected !== id) return;
      this.detail = detail;
      this.render();
      this.el.classList.remove('hidden');
    } catch (err) {
      this.el.innerHTML = ui`<div class="head"><h2>Errore</h2><div class="muted">${esc(String(err))}</div></div>`;
      this.el.classList.remove('hidden');
    }
  }

  async reload(): Promise<void> {
    if (this.detail) await this.load();
  }

  private render(): void {
    const d = this.detail!;
    const isDir = d.kind === 'dir' || d.kind === 'external';
    const expanded = this.store.expanded.has(d.id);
    const chips = [d.kind === 'external' ? d.kind : '', d.cls === 'folder' ? '' : d.cls, d.lang ?? ''].filter(Boolean).map((c) => ui`<span class="chip">${esc(c)}</span>`).join('');
    const metrics = [
      [tr('Dimensione'), fmtBytes(d.bytes)],
      isDir ? ['File', d.files.toLocaleString(tr('it-IT'))] : [tr('Righe'), d.lines ? d.lines.toLocaleString(tr('it-IT')) : '–'],
      [tr('Modificato'), fmtDate(d.mtime)],
    ].map(([k, v]) => ui`<div class="metric"><div class="k">${k}</div><div class="v">${esc(v)}</div></div>`).join('');
    const imp = Math.round(d.importance * 100);
    const project = d.project ? ui`
      <section><h3>Progetto</h3>
        <div><span class="link" data-reveal="${d.project.nodeId}">${esc(d.project.label ?? d.project.name)}</span> <span class="muted">· ${esc(d.project.type)}</span></div>
        ${d.project.description ? ui`<div class="summary">${esc(d.project.description)}</div>` : ''}
        ${d.project.remote ? ui`<div class="mono muted">${esc(d.project.remote)}</div>` : ''}
        ${d.project.technologies.length ? ui`<div class="chips" style="margin-top:6px">${d.project.technologies.slice(0, 14).map((t) => ui`<span class="chip">${esc(t)}</span>`).join('')}</div>` : ''}
      </section>` : '';
    const summary = d.summary || d.tags?.length ? ui`
      <section><h3>Descrizione</h3>
        ${d.summary ? ui`<div class="summary">${esc(d.summary)}</div>` : tr('<div class="muted">Nessuna descrizione. Usa «Menu app → Trova collegamenti con l\'AI» per farla scrivere al modello.</div>')}
        ${d.tags?.length ? ui`<div class="chips" style="margin-top:6px">${d.tags.map((t) => ui`<span class="chip">${esc(t)}</span>`).join('')}</div>` : ''}
      </section>` : '';
    const rels = this.renderRelations(d);
    const children = d.children.length ? ui`
      <section class="children"><h3>Contenuto <span class="muted">(${d.childCount.toLocaleString(tr('it-IT'))})</span></h3>
        ${d.children.slice(0, 40).map((c) => ui`<div class="row" data-reveal="${c.id}"><span class="n">${esc(c.name)}${c.kind === 'dir' ? '/' : ''}</span><span class="s">${c.kind === 'dir' ? c.files.toLocaleString(tr('it-IT')) + ' file' : fmtBytes(c.size)}</span></div>`).join('')}
        ${d.childCount > 40 ? ui`<div class="muted" style="padding-top:4px">… e altri ${(d.childCount - 40).toLocaleString(tr('it-IT'))}</div>` : ''}
      </section>` : '';
    const notes = ui`
      <section><h3>Note</h3>
        ${d.notes.map((n) => ui`<div class="note ${n.kind === 'suggestion' ? 'sugg' : ''}"><span class="o">${esc(n.origin)}</span> ${esc(n.text)} <button class="x" data-delnote="${n.id}" title="Elimina">×</button></div>`).join('')}
        <div class="row2" style="margin-top:6px"><input id="note-input" placeholder="Aggiungi una nota…"><button class="btn small" id="note-add">Aggiungi</button></div>
      </section>`;
    const canLaunch = d.kind !== 'external' || d.path.startsWith('/');
    const status = d.project?.nodeId === d.id && d.project?.status && d.project.status !== 'live' ? d.project.status : null;
    const statusLabel: Record<string, string> = { data: tr('dati'), copy: tr('copia'), archive: tr('archivio') };
    this.el.innerHTML = ui`
      <div class="head">
        <button class="close" title="Chiudi (Esc)">×</button>
        <h2>${esc(d.name)}</h2>
        <div class="path mono">${esc(shortPath(d.path))}</div>
        <div class="chips" style="margin-top:8px">${d.area ? ui`<span class="chip solid">${esc(d.area.name)}</span>` : ''}${status ? ui`<span class="chip">${esc(statusLabel[status] ?? status)}</span>` : ''}${chips}${d.aggregate ? tr('<span class="chip">solo totale</span>') : ''}</div>
      </div>
      <section>
        <div class="metrics">${metrics}
          <div class="metric"><div class="k">Importanza</div><div class="v">${imp}%</div><div class="bar"><i style="width:${imp}%"></i></div></div>
          ${d.hash ? ui`<div class="metric"><div class="k">Hash</div><div class="v">${d.hash.slice(0, 10)}</div></div>` : ''}
        </div>
      </section>
      <section class="panel-actions">
        <div class="actions">
          ${isDir && !d.aggregate ? ui`<button class="btn small" data-act="expand">${expanded ? tr('Chiudi nella mappa') : tr('Apri nella mappa')} <kbd>E</kbd></button>` : ''}
          <button class="btn small" data-act="focus">Trova nella mappa</button>
          ${canLaunch ? ui`<button class="btn small ghost" data-act="finder">Mostra nel Finder</button><button class="btn small ghost" data-act="open">Apri nell'app</button><button class="btn small ghost" data-workspace title="Avvia agenti e vedi i terminali di questo elemento">Operativa ↗</button>` : ''}
        </div>
        ${d.linkTarget ? ui`<div class="muted mono" style="margin-top:6px">→ ${esc(shortPath(d.linkTarget))}</div>` : ''}
      </section>
      <section><button class="btn small" data-harness>Harness del nodo</button></section>
      ${summary}${project}${rels}${children}${notes}`;
    this.bind();
  }

  private renderRelations(d: NodeDetail): string {
    const byId = new Map(d.neighbors.map((n) => [n.id, n]));
    const groups = new Map<string, GraphEdge[]>();
    for (const e of d.edges) { const g = groups.get(e.kind); if (g) g.push(e); else groups.set(e.kind, [e]); }
    const order = ['manual', 'imports', 'links', 'refpath', 'mention', 'uses', 'policy', 'symlink', 'duplicate', 'derived', 'external', 'shared_id', 'semantic', 'similar'];
    const keys = [...groups.keys()].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const verified = d.edges.filter((e) => e.verified && !e.hidden).length;
    const inferred = d.edges.filter((e) => !e.verified && !e.hidden).length;
    const rows = keys.map((k) => {
      const list = groups.get(k)!;
      const items = list.slice(0, 25).map((e) => {
        const other = e.src === d.id ? e.dst : e.src;
        const n = byId.get(other) as GraphNode | undefined;
        const dir = e.src === d.id ? '→' : '←';
        const name = n ? (n.kind === 'dir' ? n.name + '/' : n.name) : ui`#${other}`;
        const ev = evidenceText(e);
        return ui`<div class="rel ${e.hidden ? 'hiddenrel' : ''}">
          <span class="dir">${dir}</span>
          <div><span class="name" data-reveal="${other}" title="${esc(n ? shortPath(n.path) : '')}">${esc(name)}</span>
            <div class="meta"><span class="kind">${esc(EDGE_KIND_LABELS[e.kind] ?? e.kind)}</span>${e.verified ? '' : ui`<span class="inf">ipotizzato ${Math.round(e.confidence * 100)}%</span>`}${e.count > 1 ? ui` ×${e.count}` : ''}${e.origin !== 'scan' ? ui` · ${esc(e.origin)}` : ''}${ev ? ui` · ${esc(ev)}` : ''}</div></div>
          <button class="x" data-edge="${e.id}" data-hidden="${e.hidden ? 1 : 0}" title="${e.hidden ? tr('Ripristina') : tr('Nascondi o elimina')}">${e.hidden ? '↺' : '×'}</button>
        </div>`;
      }).join('');
      return ui`<div class="group-title">${esc(EDGE_KIND_LABELS[k] ?? k)} · ${list.length}</div>${items}${list.length > 25 ? ui`<div class="muted">… altre ${list.length - 25}</div>` : ''}`;
    }).join('');
    return ui`<section><h3>Collegamenti <span class="muted">${verified} osservati · ${inferred} ipotizzati</span></h3>
      ${rows || tr('<div class="muted">Nessun collegamento trovato.</div>')}
      <details style="margin-top:8px"><summary class="link">Aggiungi un collegamento</summary>
        <div class="addrel">
          <input id="rel-q" placeholder="Cerca il nodo di destinazione…" autocomplete="off">
          <div class="results" id="rel-results"></div>
          <div class="row2">
            <select id="rel-kind">${['manual', 'uses', 'semantic', 'links', 'duplicate', 'derived', 'policy'].map((k) => ui`<option value="${k}">${EDGE_KIND_LABELS[k]}</option>`).join('')}</select>
            <select id="rel-dir"><option value="out">da qui →</option><option value="in">← verso qui</option></select>
          </div>
          <input id="rel-note" placeholder="Perché (la prova del collegamento)">
          <button class="btn small" id="rel-add" disabled>Crea</button>
        </div>
      </details></section>`;
  }

  private bind(): void {
    const d = this.detail!;
    const q = <T extends HTMLElement>(sel: string) => this.el.querySelector(sel) as T | null;
    q('.close')?.addEventListener('click', () => this.store.select(null));
    this.el.querySelectorAll<HTMLElement>('[data-reveal]').forEach((el) => el.addEventListener('click', () => this.cb.reveal(Number(el.dataset.reveal))));
    q('[data-act=expand]')?.addEventListener('click', () => this.cb.toggleExpand(d.id));
    q('[data-act=focus]')?.addEventListener('click', () => this.cb.reveal(d.id));
    q('[data-act=finder]')?.addEventListener('click', () => void api.open(d.id, 'finder'));
    q('[data-act=open]')?.addEventListener('click', () => void api.open(d.id, 'default'));
    this.el.querySelector('[data-workspace]')?.addEventListener('click', () => this.cb.workspace(this.detail!.id));
    this.el.querySelector('[data-harness]')?.addEventListener('click', () => this.cb.harness(d.id));
    this.el.querySelectorAll<HTMLButtonElement>('[data-edge]').forEach((b) => b.addEventListener('click', async () => {
      const id = Number(b.dataset.edge);
      if (!Number.isFinite(id)) return;
      if (b.dataset.hidden === '1') await api.patchEdge(id, { hidden: false });
      else await api.deleteEdge(id);
      await this.reload();
      this.cb.refreshGraph();
    }));
    this.el.querySelectorAll<HTMLButtonElement>('[data-delnote]').forEach((b) => b.addEventListener('click', async () => { await api.deleteNote(Number(b.dataset.delnote)); await this.reload(); }));
    const noteInput = q<HTMLInputElement>('#note-input');
    const addNote = async () => { const t = noteInput?.value.trim(); if (!t) return; await api.addNote(d.id, t); await this.reload(); };
    q('#note-add')?.addEventListener('click', () => void addNote());
    noteInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') void addNote(); });

    // add relation
    const relQ = q<HTMLInputElement>('#rel-q');
    const relRes = q<HTMLElement>('#rel-results');
    const relAdd = q<HTMLButtonElement>('#rel-add');
    let target: GraphNode | null = null;
    let timer: number | null = null;
    relQ?.addEventListener('input', () => {
      if (timer) clearTimeout(timer);
      timer = window.setTimeout(async () => {
        const v = relQ.value.trim();
        if (!v || !relRes) return;
        const { results } = await api.search(v, 12);
        relRes.innerHTML = results.filter((r) => r.id !== d.id).map((r) => ui`<div data-id="${r.id}" title="${esc(shortPath(r.path))}">${esc(r.name)}${r.kind === 'dir' ? '/' : ''} <span class="muted mono">${esc(shortPath(r.path)).slice(-40)}</span></div>`).join('');
        relRes.querySelectorAll<HTMLElement>('div[data-id]').forEach((el) => el.addEventListener('click', () => {
          target = results.find((r) => r.id === Number(el.dataset.id)) ?? null;
          relRes.querySelectorAll('div').forEach((x) => x.classList.toggle('sel', x === el));
          if (relAdd) relAdd.disabled = !target;
        }));
      }, 180);
    });
    relAdd?.addEventListener('click', async () => {
      if (!target) return;
      const kind = q<HTMLSelectElement>('#rel-kind')!.value;
      const dir = q<HTMLSelectElement>('#rel-dir')!.value;
      const note = q<HTMLInputElement>('#rel-note')?.value.trim() || 'aggiunta a mano';
      const src = dir === 'out' ? d.id : target.id;
      const dst = dir === 'out' ? target.id : d.id;
      await api.addEdge({ src, dst, kind, confidence: 1, evidence: { note }, origin: 'user' });
      await this.reload();
      this.cb.refreshGraph();
    });
  }
}
