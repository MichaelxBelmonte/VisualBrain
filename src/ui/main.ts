import { t as tr, ui } from './i18n.ts';
// Bootstrap: store, canvas, layout, panel, search, terminals, toolbar, live events, keyboard.
import { translateStaticUI, getLanguage, setLanguage } from './i18n.ts';
import { openSettings, setSettingsHooks } from './settings.ts';
import { api } from './api.ts';
import { Store } from './state.ts';
import { GraphView } from './graph.ts';
import { computeLayout } from './layout.ts';
import { Panel } from './panel.ts';
import { Search } from './search.ts';
import { Terminals } from './terminal.ts';
import { Toolbar } from './toolbar.ts';
import { mountIcons } from './icons.ts';
import { mountWindowChrome } from './window-chrome.ts';
import { Updates } from './updates.ts';
import { Access } from './access.ts';
import type { EventMessage } from '../shared/types.ts';

translateStaticUI();
mountIcons();
mountWindowChrome();
const store = new Store();
const canvas = document.getElementById('canvas') as HTMLCanvasElement;
let firstLayout = true;
let lastToggled: number | null = null;

const graph = new GraphView(canvas, store, {
  onSelect: (id) => {
    if (id !== null && id < 0) { store.setFilters({ min: 0 }); return; }   // "+N altri": show every file
    store.select(id);
  },
  onToggleExpand: (id) => toggleExpand(id),
  onOpen: (id) => void api.open(id, 'default'),
  onPin: (key, x, y) => store.pin(key, x, y),
  onSession: (id) => { terminals.activate(id); terminals.show(true); },
  onToggleSessions: (id) => { store.toggleSessions(id); relayout(); graph.ensureVisible(id); },
});

const updates = new Updates(document.getElementById('update-banner')!);
new Access(document.getElementById('access-banner')!);
const toolbar = new Toolbar(store, {
  fit: () => graph.fit(),
  reorder: () => reorder(),
  collapseAll: () => store.collapseAll(),
  toggleCompact: () => toggleCompact(),
});
const terminals = new Terminals(document.getElementById('terminals')!, {
  onLayout: () => graph.invalidate(),
  pickNode: () => search.open((id) => void terminals.addNode(id), tr('Cerca un nodo da aggiungere alla vista Operativa…')),
  reveal: (id) => void reveal(id),
  agents: () => store.status?.config.agents ?? { claude: false, codex: false, hermes: false, agy: false },
  sessionsChanged: (sessions, active) => {
    const priorNodes = new Set([...store.sessions.values()].filter(s => s.alive && s.nodeId != null).map(s => s.nodeId!));
    const changed = store.setSessions(sessions, active);
    if (changed) {
      relayout();
      if (sessions.some(s => s.alive && s.nodeId != null && !priorNodes.has(s.nodeId))) void loadGraph();
    }
    graph.invalidate();
  },
  // the terminals already read the links with every session sync: the map reuses that read
  linksChanged: (links) => { store.sessionLinks = links; graph.invalidate(); },
});

let fitAfterLoad = false;
function toggleCompact(): void {
  fitAfterLoad = true;
  store.setFilters({ compact: !store.filters.compact });
}

setSettingsHooks({
  openTerminal: (info) => terminals.attach(info),
  onThemeChange: () => { graph.readColors(); terminals.retheme(); relayout(); },
  zoom: (step) => terminals.zoom(step),
  checkUpdates: () => updates.checkNow(),
  appVersion: () => updates.current,
});

function toggleTerminals(): void {
  terminals.toggle();
}
const panel = new Panel(document.getElementById('panel')!, store, {
  reveal: (id) => void reveal(id),
  toggleExpand: (id) => toggleExpand(id),
  workspace: (id) => void terminals.addNode(id),
  harness: (id) => void terminals.launchHarnessForNode(id),
  launch: (id, agent, mode, prompt) => void terminals.launchForNode(id, agent, mode, prompt),
  refreshGraph: () => void loadGraph(),
});
const search = new Search(document.getElementById('overlay')!, (id) => void reveal(id));

function relayout(): void {
  graph.setLayout(computeLayout(store, graph.measure, graph.fonts(), graph.aspect()));
}

// First start: the stage is black until the first index finishes, so it shows a light "loading" mark meanwhile.
let graphLoaded = false, indexing = false, nodeCount = -1, indexNote = '';
/** Indexing runs in the background: a dot in the corner while it works (red after an error), the details in its tooltip. */
function indexDot(text: string | null, error = false): void {
  const dot = document.getElementById('index-dot');
  if (!dot) return;
  dot.hidden = text === null;
  dot.classList.toggle('error', error);
  dot.title = text ?? '';
  dot.setAttribute('aria-label', text ?? '');
}

function syncLoader(): void {
  const show = !graphLoaded || (indexing && nodeCount <= 0);
  document.getElementById('stage-loading')!.classList.toggle('hidden', !show);
  document.getElementById('stage-loading-text')!.textContent = indexing ? (indexNote || tr('Indicizzazione…')) : tr('Carico la mappa…');
  document.getElementById('hint')!.textContent = graphLoaded && !indexing && nodeCount === 0 ? tr('Nessun elemento: usa «Menu app → Aggiorna dai file».') : '';
}

let loading = false;
let queued = false;
async function loadGraph(): Promise<void> {
  if (loading) { queued = true; return; }
  loading = true;
  try {
    const f = store.filters;
    const sessionNodes = [...store.sessions.values()].filter(s => s.alive && s.nodeId != null).map(s => s.nodeId!);
    const g = await api.graph({ expanded: [...store.expanded], kinds: store.activeKinds(), min: f.min, symlinks: f.symlinks, externals: f.externals, extra: [...new Set([...store.extra, ...sessionNodes])] });
    store.setGraph(g);
    relayout();
    if (fitAfterLoad && !firstLayout) { fitAfterLoad = false; graph.fit(); }
    if (firstLayout) {
      firstLayout = false;
      if (!restoreCamera() || graph.visibleFraction() < 0.5) graph.fit();
    } else if (lastToggled !== null) {
      graph.ensureVisible(lastToggled);
      lastToggled = null;
    }
    nodeCount = g.nodes.length;
  } catch (err) {
    toolbar.setProgress(String(err));
  } finally {
    graphLoaded = true; syncLoader();
    loading = false;
    if (queued) { queued = false; void loadGraph(); }
  }
}

async function loadStatus(): Promise<void> {
  try {
    store.status = await api.status();
    store.emit('status');
    indexing = !!store.status.indexing; syncLoader();
    indexDot(store.status.indexing ? indexNote || tr('aggiornamento dai file in corso…') : null);   // the corner dot, never a notice that stays
  } catch (err) {
    toolbar.setProgress(String(err));
  }
}

function toggleExpand(id: number): void {
  lastToggled = id;
  store.toggleExpanded(id);
}

function reorder(): void {
  store.clearPins();
  relayout();
  graph.fit();
  saveCamera();
}

/** Shows a node: expands what contains it (or forces it into the view), selects it and centres the camera on it. */
async function reveal(id: number): Promise<void> {
  try {
    if (!store.nodes.has(id)) {
      const d = await api.node(id);
      const chain: number[] = [];
      let anchored = false;
      for (const a of d.ancestors) {           // from the parent up to the root
        chain.push(a);
        if (store.nodes.has(a) || store.topLevel.has(a)) { anchored = true; break; }
      }
      if (anchored) {
        const missing = chain.filter((a) => !store.expanded.has(a));
        if (missing.length) { store.expandMany(missing); await loadGraph(); }
      } else {
        store.addExtra(id);
        await loadGraph();
      }
    }
    store.select(id);
    if (store.nodes.has(id)) { graph.focus(id, Math.max(graph.k, 1)); saveCamera(); }
  } catch (err) {
    toolbar.setProgress(String(err));
  }
}

function saveCamera(): void {
  try { localStorage.setItem('vb:camera2', JSON.stringify({ k: graph.k, tx: graph.tx, ty: graph.ty })); } catch { /* ignore */ }
}
function restoreCamera(): boolean {
  try {
    const c = JSON.parse(localStorage.getItem('vb:camera2') ?? 'null') as { k: number; tx: number; ty: number } | null;
    if (!c || !Number.isFinite(c.k) || !Number.isFinite(c.tx) || !Number.isFinite(c.ty)) return false;
    graph.k = c.k; graph.tx = c.tx; graph.ty = c.ty; graph.invalidate();
    return true;
  } catch { return false; }
}
let camTimer = 0;
canvas.addEventListener('pointerup', saveCamera);
canvas.addEventListener('wheel', () => { clearTimeout(camTimer); camTimer = window.setTimeout(saveCamera, 400); }, { passive: true });

store.on('expanded', () => void loadGraph());
store.on('filters', () => void loadGraph());
store.on('extra', () => void loadGraph());
store.on('pins', () => relayout());

function connectEvents(): void {
  const ws = new WebSocket(ui`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/events${api.graphEventQuery()}`);
  let graphTimer = 0;
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data) as EventMessage;
    switch (m.type) {
      case 'index:progress':
        indexing = true; indexNote = ui`${tr('Indicizzazione')} · ${m.done.toLocaleString(tr('it-IT'))}${m.total ? '/' + m.total.toLocaleString(tr('it-IT')) : ''}`; syncLoader();
        indexDot(indexNote);
        break;
      case 'index:map': // first start: the structure is ready, edges and details follow
        void loadStatus();
        void loadGraph();
        break;
      case 'index:done':
        indexing = false; indexNote = ''; // loadGraph below refreshes the loader once the new graph is in
        indexDot(null);
        void loadStatus();
        void loadGraph();
        void panel.reload();
        break;
      case 'index:error':
        indexing = false; indexNote = ''; syncLoader();
        indexDot(ui`${tr("errore nell'aggiornamento:")} ${m.error}`, true);
        break;
      case 'analyze:progress':
        toolbar.setProgress(m.message);
        break;
      case 'analyze:done':
        toolbar.setProgress(ui`AI: ${m.summary}`);
        void loadStatus();
        void loadGraph();
        void panel.reload();
        setTimeout(() => toolbar.setProgress(''), 8000);
        break;
      case 'analyze:error':
        toolbar.setProgress(ui`errore AI: ${m.error}`);
        break;
      case 'graph:changed':
        clearTimeout(graphTimer);
        graphTimer = window.setTimeout(() => void loadGraph(), 300);
        break;
      case 'term:exit':
        terminals.markExit(m.id);
        break;
    }
  };
  ws.onclose = () => setTimeout(connectEvents, 2000);
}

function openSearch(): void {
  if (terminals.isOpen()) search.open((id) => void terminals.addNode(id), tr('Cerca un nodo da aggiungere alla vista Operativa…'));
  else search.open();
}
document.getElementById('btn-search')!.addEventListener('click', openSearch);

document.addEventListener('keydown', (e) => {
  // Keep global shortcuts from replacing onboarding or a settings draft.
  if (document.getElementById('overlay')!.dataset.mode === 'settings') return;
  const target = e.target instanceof HTMLElement ? e.target : null;
  const inTerminal = !!target?.closest('.xterm');
  const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || inTerminal);
  if ((e.metaKey || (e.ctrlKey && !inTerminal)) && e.key.toLowerCase() === 'r') { e.preventDefault(); location.reload(); return; }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openSearch(); return; }
  if (e.metaKey && e.key === ',') { e.preventDefault(); void openSettings().catch(err => toolbar.flash(String(err))); return; }
  if (e.key === 'Escape' && terminals.closeDialog()) { e.preventDefault(); return; }
  if (e.key === 'Escape' && search.isOpen()) { e.preventDefault(); search.close(); return; }
  if (typing) return;
  if (terminals.isOpen() && !['Escape', 't', 'T', '/'].includes(e.key)) return;
  switch (e.key) {
    case 'Escape':
      if (search.isOpen()) search.close();
      else if (toolbar.menuOpen()) toolbar.closeMenus();
      else if (!document.getElementById('overlay')!.classList.contains('hidden')) toolbar.closeDialog();
      else store.select(null);
      break;
    case 'f': case 'F': graph.fit(); saveCamera(); break;
    case 'r': case 'R': reorder(); break;
    case 'c': case 'C': toggleCompact(); break;
    case 'e': case 'E': if (store.selected !== null) { const n = store.nodes.get(store.selected); if (n && (n.kind === 'dir' || n.kind === 'external') && !n.aggregate) toggleExpand(n.id); } break;
    case 't': case 'T': toggleTerminals(); break;
    case '/': e.preventDefault(); openSearch(); break;
    case '+': case '=': graph.zoomBy(1.25); break;
    case '-': graph.zoomBy(0.8); break;
    case '0': graph.fit(); break;
  }
});

void (async () => {
  await loadStatus();
  const prefs = await api.preferences();
  if (prefs.setupComplete && prefs.language !== getLanguage()) { setLanguage(prefs.language); location.reload(); return; }
  await loadGraph();
  connectEvents();
  if (!prefs.setupComplete) await openSettings(true);
  try { await terminals.restore(); } catch (err) { toolbar.flash(ui`Ripristino dei terminali: ${String(err)}`); }
})();
