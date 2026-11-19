import { t as tr, ui } from './i18n.ts';
// Operational workspace. Sessions keep running on the server; xterm is mounted on demand.
import { Terminal, type ILink } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { mountDevView } from './dev-view.ts';
import { openWorkLauncher } from './work-launcher.ts';
import { openTerminalQuickMenu, terminalQuickMenuOpen } from './terminal-quick-menu.ts';
import { openHarnessLauncher } from './harness-launcher.ts';
import { icon } from './icons.ts';
import { bindRailResize, bindRailVisibility, bindRailSearch, railStep } from './work-rail.ts';
import { bindReorder } from './work-reorder.ts';
import { connectionGroups, linkBetween, linkRequest, moveNode, orderNodes, type LinkSide } from './work-links.ts';
import { WorkChannel } from './work-channel.ts';
import { clampSplit, moveTile, orderTiles, MAX_TILES, connectionEndpoints, defaultTiles, directPeers, pairTiles, focusIndex, focusTile, gridColumns, groupSuggestion, pickerGroups, reconcileTiles, removeTile, stepFocus, stepTab, tabStepKey, tileKeyAction, tileMarker, toggleTile, type TileSelection, clampPage, emptyNodeView, needsLink, nodePickerGroups, nodeViewIds, orchestratorLink, pageCount, pageIds, pageOfId, type NodeView, type PickerItem } from './work-tiles.ts';
import { CODE_IN_TEXT, resumable, roleName, sessionTone, sessionWorking, toneFlag, toneReason, type SessionTone, ROLE_WORDS } from './work-roles.ts';
import { DEFAULT_FONT_SIZE, dropText, fontZoomKey, isNewTerminalKey, isPlainTerminalKey, parseFileDrop, zoomFont } from './work-input.ts';
import { api } from './api.ts';
import { fmtBytes } from './panel.ts';
import type { AgentName, AgentRole, ModelSwitchChoice, NodeDetail, SwarmProposal, TeamLink, TerminalInfo } from '../shared/types.ts';
import { sessionPreview, type SessionPreview } from '../shared/session-preview.ts';
import { mountWorkBoard, reconcileWorkList, type WorkListItem, type BoardUpdate } from './work-board.ts';

/** How long keys typed before the terminal connection opens are still worth sending. */
const EARLY_KEYS_MS = 5000;

interface Tab {
  info: TerminalInfo;
  pane?: HTMLElement;
  term?: Terminal;
  fit?: FitAddon;
  ws?: WebSocket;
  observer?: ResizeObserver;
  connected?: boolean;
  /** Keys typed while the session is still connecting: sent once when the connection opens, unless they waited too long. */
  early?: string;
  earlyAt?: number;
}
/** Contract of src/ui/work-channel.ts (root): a read-only board of the messages exchanged between linked sessions. */
interface WorkChannelLike {
  update(links: TeamLink[], sessions: TerminalInfo[], visible: string[]): void;
  refresh(): Promise<void>;
}
interface Callbacks {
  onLayout(): void;
  pickNode(): void;
  reveal(id: number): void;
  agents(): Record<AgentName, boolean>;
  sessionsChanged(sessions: TerminalInfo[], active: string | null): void;
  /** The node links changed: whoever else shows them reuses this read instead of polling its own. */
  linksChanged?(links: TeamLink[]): void;
}
const labels = { claude: 'Claude Code', codex: 'Codex', hermes: 'Hermes', agy: 'Antigravity', shell: tr('Terminale') };
const roles = ROLE_WORDS;
// ANSI colours per theme: xterm's default (Tango) is a dark-background palette, so in light yellow, bright green and cyan sat
// at 1.2-1.6:1 on white. Every text colour here is >= 4.5:1 on the theme's --bg; the background-like slots (white in
// light, black in dark) stay close to the background and minimumContrastRatio lifts them when they are used as text.
const ANSI_LIGHT = { black: '#000000', red: '#b42318', green: '#1a7f37', yellow: '#8a5d00', blue: '#1f5fbf', magenta: '#8b3fa8', cyan: '#0b6f80', white: '#e5e5e5', brightBlack: '#595959', brightRed: '#c4281c', brightGreen: '#1f7a34', brightYellow: '#7a5300', brightBlue: '#1a56b0', brightMagenta: '#9330a8', brightCyan: '#08707e', brightWhite: '#f5f5f5' };
const ANSI_DARK = { black: '#3a3a3a', red: '#f2655c', green: '#5fc977', yellow: '#e3c04d', blue: '#6aa4f2', magenta: '#cf86e8', cyan: '#4fc8d6', white: '#d4d4d4', brightBlack: '#8c8c8c', brightRed: '#ff7b72', brightGreen: '#7ee08f', brightYellow: '#f0d36a', brightBlue: '#8cbaff', brightMagenta: '#dda0f0', brightCyan: '#73dde8', brightWhite: '#ffffff' };
/** Escaped message text with the codes of the node's sessions (OP3) turned into buttons that open the session. */
const withCodeLinks = (html: string, sessions: TerminalInfo[]) => html.replace(CODE_IN_TEXT, code => {
  const session = sessions.find(s => s.code === code);
  return session ? `<button type="button" class="code-link" data-goto="${session.id}">${code}</button>` : code;
});
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const short = (s: string) => s.replace(/^\/Users\/[^/]+/, '~');

export class Terminals {
  private readonly root: HTMLElement;
  private readonly cb: Callbacks;
  private readonly bodyEl: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly tabs = new Map<string, Tab>();
  private readonly nodes = new Map<number, NodeDetail | null>();
  private readonly pendingNodes = new Map<number, Promise<NodeDetail | null>>();
  private active: string | null = null;
  private selectedNode: number | null = null;
  private tiled = false;
  /** Sessions shown side by side (any node, at most MAX_TILES). Survives turning the grid off and on again. */
  private sel: TileSelection = { ids: [], focus: null };
  /** True while an explicit composition (a pair, "Affianca collegati") is on screen: `sel` is then authoritative, not the node view. */
  private composed = false;
  /** One view per node: its own terminals, 4 per page, plus the sessions of linked nodes added to it. */
  private readonly views = new Map<number | null, NodeView>();
  /** A session of another node waiting for the user to confirm the link that showing it requires. */
  private pendingAdd: string | null = null;
  private readonly pager: HTMLElement;
  /** Tabs of the single view: one per terminal of the node view, the one on screen highlighted. */
  private readonly tabStrip: HTMLElement;
  private readonly picker: HTMLDetailsElement;
  private pickerHtml = '';
  /** Persistent links as last reported by the map; only used to preselect and mark endpoints. */
  private links: TeamLink[] = [];
  private suggested = new Set<string>();
  private readonly channelEl: HTMLElement;
  private channel: WorkChannelLike | null = null;
  private filter = '';
  /** Pills above the rail; 'needs' groups permissions, questions and blocked sessions. Other tones stay valid for callers. */
  private stateFilter: 'all' | 'needs' | SessionTone | 'terminal' = 'all';
  private railLinkSource: string | null = null;
  private railLinkBusy = false;
  /** Manual visual order; moving a node never changes its communication links. */
  private nodeOrder: number[] = (() => { try { const v = JSON.parse(localStorage.getItem('vb:node-order') || '[]'); return Array.isArray(v) ? v.filter(Number.isInteger) : []; } catch { return []; } })();
  /** Saved for existing sessions; new sessions follow their creation order. */
  private sessionOrder: string[] = (() => { try { const v = JSON.parse(localStorage.getItem('vb:session-order') || '[]'); return Array.isArray(v) ? v.filter((id): id is string => typeof id === 'string') : []; } catch { return []; } })();
  /** Text size of every terminal (⌘+ / ⌘− / ⌘0), remembered on this computer. */
  private fontSize = (() => { try { const v = Number(localStorage.getItem('vb:term-font')); return v >= 9 && v <= 20 ? v : DEFAULT_FONT_SIZE; } catch { return DEFAULT_FONT_SIZE; } })();
  /** Share of the tiled grid given to the first column and the first row, set by dragging the dividers. */
  private split = (() => { try { const v = JSON.parse(localStorage.getItem('vb:tile-split') || '{}'); return { col: clampSplit(Number(v.col ?? 0.5)), row: clampSplit(Number(v.row ?? 0.5)) }; } catch { return { col: 0.5, row: 0.5 }; } })();
  private splitHandles!: Record<'col' | 'row', HTMLElement>;
  private tileOrder: string[] = (() => { try { const v = JSON.parse(localStorage.getItem('vb:tile-order') || '[]'); return Array.isArray(v) ? v.filter((id): id is string => typeof id === 'string') : []; } catch { return []; } })();
  private tileDragCleanup: (() => void) | null = null;
  private railDragCleanup: (() => void)[] = [];
  /** A full-width view replaces the terminals: Lavoro (the board) when `boardOpen`, Codice when `gitOpen`. Lavoro is the default. */
  private sideOpen = true;
  private gitOpen = false;
  private boardOpen = true;
  private updateBoard: BoardUpdate | null = null;
  private updateGit: ((node: number | null, visible: boolean) => void) | null = null;
  private collapsedNodes = new Set<number>((() => { try { const v = JSON.parse(localStorage.getItem('vb:collapsed-nodes') || '[]'); return Array.isArray(v) ? v.filter(Number.isInteger) : []; } catch { return []; } })());
  private dismissLauncher: (() => void) | null = null;
  private dismissQuickMenu?: () => void;
  private syncing = false;
  private pollSignature = '';
  private pollReasons = '';

  private railPreviewId: string | null = null;
  private railPreviewRequest = 0;
  private railPreviewData: { id: string; preview: SessionPreview } | null = null;
  /** What each agent's own model selector offers (or why an agent has none), asked once. */
  private modelChoices: { claude: ModelSwitchChoice[]; codex: ModelSwitchChoice[]; limits: Record<string, string | null> } | null = null;
  private modelWatch: ReturnType<typeof setTimeout> | null = null;
  private control<T extends Element = HTMLElement>(selector: string): T | null { return this.root.querySelector<T>(selector) ?? document.querySelector<T>(selector); }

  constructor(root: HTMLElement, cb: Callbacks) {
    this.root = root; this.cb = cb;
    this.bodyEl = root.querySelector('#term-body')!;
    this.listEl = this.control('#work-list')!;
    this.control('#work-add')!.addEventListener('click', () => cb.pickNode());
    this.control('#work-launch')!.addEventListener('click', () => this.openLauncher());
    this.control('#work-board')!.addEventListener('click', () => this.openBoard());
    this.control('#work-shell')!.addEventListener('click', () => void this.openShell(this.selectedNode));
    this.control('#work-git')!.addEventListener('click', () => {
      this.sideOpen = true; this.gitOpen = true; this.boardOpen = false;
      this.selectedNode ??= this.tabs.get(this.active || '')?.info.nodeId ?? [...this.nodes.keys()][0] ?? null;
      this.updateGit ??= mountDevView(this.control('#work-git-view')!, { reveal: id => { this.show(false); this.cb.reveal(id); }, login: info => { this.gitOpen = false; this.attach(info); } });
      this.renderList(); this.renderBody();
    });
    this.control('#work-terminals')!.addEventListener('click', () => { this.sideOpen = false; this.gitOpen = false; this.boardOpen = false; this.openNode(this.selectedNode ?? this.tabs.get(this.active || '')?.info.nodeId ?? [...this.nodes.keys()][0] ?? null); });
    bindRailResize(root, this.control<HTMLElement>('#work-rail-resize')!);
    root.classList.add('rail-compact');
    this.control('#work-add-top')!.addEventListener('click', () => cb.pickNode());
    this.control('#work-new-task')!.addEventListener('click', () => { this.openBoard(); this.control('#work-board-view')?.querySelector<HTMLElement>('[data-new]')?.click(); });
    this.control('#work-new-squad')!.addEventListener('click', () => this.openLauncher(undefined, 'embedded', '', true, this.selectedNode, { teamId: 'new' }));
    // An item of a toolbar menu closes its menu.
    document.querySelectorAll<HTMLDetailsElement>('#work-toolbar details.work-overflow').forEach(menu => menu.addEventListener('click', e => { if ((e.target as HTMLElement).closest('div > button')) menu.open = false; }));
    const railToggle = this.control<HTMLElement>('#work-toggle-rail')!;
    bindRailVisibility(root, railToggle, () => this.fitVisible());
    this.control('#work-grid')!.addEventListener('click', () => { if (!this.tiled) this.setTiled(true); });
    this.control('#work-single')!.addEventListener('click', () => { if (this.tiled) this.setTiled(false); });
    this.channelEl = document.createElement('div'); this.channelEl.className = 'work-channel hidden';
    this.bodyEl.insertAdjacentElement('afterend', this.channelEl);
    this.channel = new WorkChannel(this.channelEl);
    this.picker = this.createPicker();
    this.control('#work-grid')!.insertAdjacentElement('afterend', this.picker);
    this.pager = document.createElement('span'); this.pager.className = 'tile-pager hidden';
    this.picker.insertAdjacentElement('afterend', this.pager);
    this.pager.addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-page],[data-node-view]'); if (!b) return;
      if (b.dataset.nodeView) { this.composed = false; this.renderList(); this.renderBody(); return; }
      this.goToPage(Number(b.dataset.page));
    });
    this.tabStrip = document.createElement('nav'); this.tabStrip.className = 'term-tabs hidden';
    this.tabStrip.setAttribute('role', 'tablist'); this.tabStrip.setAttribute('aria-label', tr('Terminali del nodo'));
    this.bodyEl.insertAdjacentElement('beforebegin', this.tabStrip);
    this.tabStrip.addEventListener('click', e => { const id = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]')?.dataset.tab; if (id) this.activate(id); });
    this.tabStrip.addEventListener('dblclick', e => { const t = this.tabs.get((e.target as HTMLElement).closest<HTMLElement>('[data-tab]')?.dataset.tab ?? ''); if (t) this.startRename(t); });
    document.addEventListener('keydown', e => this.tabKey(e), true);
    document.addEventListener('keydown', e => this.tileKey(e), true);
    document.addEventListener('keydown', e => this.shortcutKey(e), true);
    window.addEventListener('vb-file-drop', e => this.fileDrop((e as CustomEvent).detail));
    this.control('#work-brain')!.addEventListener('click', () => { if (this.selectedNode !== null) { this.show(false); this.cb.reveal(this.selectedNode); } });
    bindRailSearch(this.control<HTMLInputElement>('#work-filter')!);
    this.listEl.addEventListener('keydown', e => this.railKey(e));
    // The detail under a row follows the keyboard highlight and goes away with it; it never follows the pointer.
    this.listEl.addEventListener('focusin', e => this.showRailPreview((e.target as HTMLElement).closest<HTMLElement>('.work-session')?.dataset.sid ?? null));
    this.listEl.addEventListener('focusout', () => setTimeout(() => {
      const at = document.activeElement;
      if (!(at instanceof HTMLElement) || !at.closest('#work-list .work-session')) this.showRailPreview(null);
    }, 0));
    // The model of a session is chosen on its row; the answer to a question of the CLI is given there too.
    this.listEl.addEventListener('change', e => {
      const select = e.target instanceof HTMLSelectElement ? e.target : null;
      if (select?.dataset.modelSelect) void this.switchModel(select.dataset.modelSelect, select.value);
    });
    this.listEl.addEventListener('click', e => {
      const button = (e.target as HTMLElement).closest<HTMLElement>('[data-model-confirm], [data-model-cancel]');
      if (!button) return;
      e.stopPropagation();
      void this.answerModel(button.dataset.modelConfirm ?? button.dataset.modelCancel!, button.dataset.modelConfirm !== undefined);
    });
    void api.modelSwitch().then(choices => { this.modelChoices = choices; this.renderDetails(); }).catch(() => {});
    this.listEl.addEventListener('paste', e => {
      const t = this.railOpenRow(e.target), text = e.clipboardData?.getData('text');
      if (!t || !text) return;
      e.preventDefault(); t.term!.focus(); t.term!.paste(text);
    });
    this.control<HTMLInputElement>('#work-filter')!.addEventListener('keydown', e => {
      if (e.key !== 'ArrowDown' || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing) return;
      const first = this.listEl.querySelector<HTMLElement>('button[data-session]');
      if (first) { e.preventDefault(); first.focus({ preventScroll: true }); first.scrollIntoView({ block: 'nearest' }); }
    });
    this.control<HTMLInputElement>('#work-filter')!.addEventListener('input', e => {
      const field = e.target as HTMLInputElement;
      field.parentElement?.classList.toggle('has-query', !!field.value); // the field stays open while it filters the list
      this.filter = field.value.toLowerCase(); this.renderList();
    });
    const states = this.control('#work-state-filter')!;
    const paintStates = () => states.querySelectorAll<HTMLElement>('[data-state]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.state === this.stateFilter)));
    states.addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-state]'); if (!b) return;
      this.stateFilter = b.dataset.state as typeof this.stateFilter; paintStates(); this.renderList();
    });
    paintStates();
    document.getElementById('btn-brain')!.addEventListener('click', () => this.show(false));
    document.getElementById('btn-workspace')!.addEventListener('click', () => this.show(true));
    document.addEventListener('pointerdown', e => {
      const target = e.target as HTMLElement;
      document.querySelectorAll<HTMLDetailsElement>('.work-overflow[open]').forEach(menu => { if (!menu.contains(target)) menu.open = false; });
    });
    // Escape closes the open Operativa menu (Nuovo, node, squad ···) before anything else, and gives the focus back to its button.
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      const open = [...document.querySelectorAll<HTMLDetailsElement>('.work-overflow[open]')];
      if (!open.length) return;
      e.preventDefault(); e.stopPropagation();
      for (const menu of open) menu.open = false;
      open[open.length - 1].querySelector<HTMLElement>('summary')?.focus();
    }, true);
    new ResizeObserver(() => this.fitVisible()).observe(this.bodyEl);
    this.splitHandles = { col: this.splitHandle('col'), row: this.splitHandle('row') };
    this.applySplit();
    document.addEventListener('keydown', e => this.zoomKey(e), true);
    this.control('#work-close-node')!.addEventListener('click', () => { document.querySelector('details.work-node-options')?.removeAttribute('open'); if (this.selectedNode !== null) this.confirmCloseNode(this.selectedNode); });
    setInterval(() => void this.syncSessions(), 4000);
  }

  isOpen(): boolean { return !this.root.classList.contains('hidden'); }
  hasTabs(): boolean { return this.tabs.size > 0; }
  closeDialog(): boolean {
    if (!['work-launch', 'work-team', 'work-close-node'].includes(document.getElementById('overlay')!.dataset.mode ?? '')) return false;
    this.dismissLauncher?.(); return true;
  }
  toggle(): void { this.show(!this.isOpen()); }

  async launchForNode(id: number, agent: TerminalInfo['agent'], mode: 'embedded' | 'external', prompt: string): Promise<void> {
    await this.addNode(id);
    this.openLauncher(agent, mode, prompt);
  }

  async launchHarnessForNode(id: number): Promise<void> {
    await openHarnessLauncher(id, info => {
      void this.addNode(id).then(() => this.attach(info));
    });
  }

  private async syncSessions(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const list = await api.terminals();
      for (const info of list) {
        const tab = this.tabs.get(info.id);
        if (!tab) this.attach(info, false);
        else tab.info = info;
      }
      for (const tab of this.tabs.values()) if (!list.some(info => info.id === tab.info.id)) tab.info.alive = false;
      if (this.railPreviewId) this.showRailPreview(this.railPreviewId); // the last words of the highlighted session move on
      this.watchModels();
      this.sel = reconcileTiles(this.sel, new Set(this.tabs.keys()));
      const sessions = [...this.tabs.values()].map(tab => tab.info);
      const now = Date.now();
      // Tones and the active filter can change before the server sends different session data.
      const signature = JSON.stringify([this.active, this.selectedNode, this.sel, sessions,
        sessions.map(info => [sessionTone(info, now), sessionWorking(info, now)])]);
      const reasons = JSON.stringify(sessions.map(info => toneReason(info, now)));
      const changed = signature !== this.pollSignature;
      if (changed || reasons !== this.pollReasons) {
        for (const tab of this.tabs.values()) this.updateCard(tab);
        if (changed) {
          this.renderList();
          if (this.tiled && this.isOpen()) this.renderBody();
        } else {
          for (const button of this.listEl.querySelectorAll<HTMLButtonElement>('button[data-session]')) {
            const tab = this.tabs.get(button.dataset.session!);
            if (!tab) continue;
            const linked = !!button.closest<HTMLElement>('[data-connection-endpoint]');
            const title = this.railSessionTitle(tab.info, linked);
            if (button.title !== title) button.title = title;
          }
          this.renderTabs();
        }
        if (!document.body.classList.contains('reordering')) {
          this.pollSignature = signature;
          this.pollReasons = reasons;
        }
      }
      this.syncChannel(true);
      await this.refreshLinks();
    } catch (err) { this.message(ui`Aggiornamento sessioni: ${String(err)}`); }
    finally { this.syncing = false; }
  }

  show(open: boolean): void {
    if (document.getElementById('app')?.classList.contains('stats-open')) window.dispatchEvent(new Event('vb:leave-stats'));
    if (!open) this.dismissQuickMenu?.();
    this.root.classList.toggle('hidden', !open);
    document.getElementById('app')!.classList.toggle('operative', open);
    for (const [id, selected] of [['btn-brain', !open], ['btn-workspace', open]] as const) {
      const button = document.getElementById(id)!;
      button.classList.toggle('active', selected); button.setAttribute('aria-pressed', String(selected));
    }
    this.cb.onLayout();
    this.syncChannel(); // leaving Operativa invalidates any board read still in flight
    if (open) { this.renderBody(); requestAnimationFrame(() => this.fitVisible()); }
  }

  private theme() {
    const cs = getComputedStyle(document.documentElement);
    const fg = cs.getPropertyValue('--fg').trim();
    const bg = cs.getPropertyValue('--bg').trim();
    // with the window glass the terminal draws no background of its own: the surface behind it is translucent (style.css).
    // The transparent colour keeps the theme's RGB, because minimumContrastRatio measures text against it.
    const glass = document.documentElement.classList.contains('vb-glass') && !matchMedia('(prefers-reduced-transparency: reduce)').matches;
    const hex = /^#[0-9a-f]{6}$/i.test(bg);
    const dark = !hex || parseInt(bg.slice(1, 3), 16) + parseInt(bg.slice(3, 5), 16) + parseInt(bg.slice(5, 7), 16) < 384;
    return { background: glass ? (hex ? bg + '00' : '#00000000') : bg, foreground: fg, cursor: fg, selectionBackground: cs.getPropertyValue('--g3').trim(), ...(dark ? ANSI_DARK : ANSI_LIGHT) };
  }
  retheme(): void { for (const t of this.tabs.values()) if (t.term) t.term.options.theme = this.theme(); }

  async restore(): Promise<void> {
    let pinned: number[] = [];
    try { const saved: unknown = JSON.parse(localStorage.getItem('vb:work-nodes') ?? '[]'); if (Array.isArray(saved)) pinned = saved.filter((id): id is number => Number.isInteger(id) && id > 0); } catch { /* storage unavailable */ }
    const list = await api.terminals();
    for (const id of pinned) this.nodes.set(id, null);
    for (const info of list) this.attach(info, false);
    await Promise.all([...this.nodes.keys()].map(id => this.loadNode(id)));
    this.renderList();
    if (this.isOpen() && this.sideOpen && this.boardOpen) this.renderBody();
    await this.refreshLinks();
  }

  private async loadNode(id: number): Promise<NodeDetail | null> {
    if (this.nodes.get(id)) return this.nodes.get(id)!;
    const pending = this.pendingNodes.get(id);
    if (pending) return pending;
    const task = api.node(id).then(d => { this.nodes.set(id, d); return d; }).catch(() => null).finally(() => this.pendingNodes.delete(id));
    this.pendingNodes.set(id, task);
    return task;
  }

  async addNode(id: number): Promise<void> {
    const d = await this.loadNode(id);
    if (!d) { this.message(tr('Il nodo non è più disponibile nell’indice.')); return; }
    this.nodes.set(id, d); this.saveNodes();
    // The workspace keeps its mode: from the terminals (search, + Nodo, or back from the Brain) the node's terminals open.
    if (!this.sideOpen) { this.openNode(id); return; }
    this.selectedNode = id; this.active = null;
    this.show(true); this.renderList(); this.renderBody();
  }

  private saveNodes(): void {
    try { localStorage.setItem('vb:work-nodes', JSON.stringify([...this.nodes.keys()])); } catch { /* storage unavailable */ }
  }

  attach(info: TerminalInfo, activate = true): void {
    if (!this.tabs.has(info.id)) this.tabs.set(info.id, { info });
    if (info.nodeId != null) {
      if (!this.nodes.has(info.nodeId)) this.nodes.set(info.nodeId, null);
      void this.loadNode(info.nodeId).then(() => { this.renderList(); });
      this.saveNodes();
    }
    if (this.active === null) { this.active = info.id; this.selectedNode = info.nodeId ?? null; }
    this.renderList();
    if (activate) { this.activate(info.id); this.show(true); }
  }

  /** `focusTerminal: false` opens the session and leaves the keyboard where it is (a pointer click in the rail). */
  activate(id: string, focusTerminal = true): void {
    this.sideOpen = false;
    const t = this.tabs.get(id); if (!t) return;

    // Leaving an explicit composition: the session is not part of it, so its node's own view takes over.
    if (this.tiled && this.composed && !this.sel.ids.includes(id)) this.composed = false;
    this.active = id;
    if (this.tiled && !this.composed) this.showInView(id);
    else {
      this.selectedNode = t.info.nodeId ?? null;
      if (this.tiled) this.sel = focusTile(reconcileTiles(this.sel, new Set(this.tabs.keys())), id);
    }
    this.syncSel();
    this.renderList();
    if (this.isOpen()) this.renderBody();
    requestAnimationFrame(() => {
      if (!this.isOpen() || this.active !== id) return;
      this.listEl.querySelector('.work-session.selected')?.scrollIntoView({ block: 'nearest' });
      t.pane?.scrollIntoView({ block: 'nearest' });
      // a double click on the tab renames: the second click activates it again, and must not take the field's focus
      this.fitVisible(); if (focusTerminal && !t.pane?.classList.contains('renaming')) t.term?.focus();
    });
  }

  /** The tab whose rail row holds the keyboard, when that session is the open one and can take input. */
  private railOpenRow(target: EventTarget | null): Tab | null {
    const id = target instanceof HTMLElement ? target.closest<HTMLElement>('button[data-session]')?.dataset.session : undefined;
    const t = id && id === this.active ? this.tabs.get(id) : undefined;
    return t?.term && t.info.alive ? t : null;
  }

  /** ↑/↓ and Home/End move the keyboard highlight across the visible sessions of the rail without opening any; Enter opens
   *  the highlighted one and gives it the keyboard. A character typed on the row of the open session goes to its terminal,
   *  so "click a session, then type" still works. → reaches the model of the highlighted session, under its row.
   *  Alt+arrows keep reordering (see bindNodeDrag). */
  private railKey(e: KeyboardEvent): void {
    if (e.altKey || e.ctrlKey || e.metaKey || e.isComposing) return;
    const from = e.target instanceof HTMLElement ? e.target : null;
    if (!from) return;
    if (from.closest('.work-model')) {
      // ← or Esc go back from the model of a session to its row. On the selector no key changes the model by itself (a
      // browser would step through the choices on arrows or letters): ↑, ↓ and Space open the list, where the choice is made.
      if (!e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'Escape')) {
        e.preventDefault(); e.stopPropagation();
        from.closest('.work-session')?.querySelector<HTMLElement>('button[data-session]')?.focus({ preventScroll: true });
      } else if (from instanceof HTMLSelectElement && (e.key.length === 1 || e.key.startsWith('Arrow') || ['Home', 'End', 'PageUp', 'PageDown'].includes(e.key))) {
        e.preventDefault();
        if (['ArrowDown', 'ArrowUp', ' '].includes(e.key)) try { from.showPicker(); } catch { /* no list to show here */ }
      }
      return;
    }
    if (from.closest('input, textarea, select, #work-rail-links')) return;
    if (!e.shiftKey && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      const rows = [...this.listEl.querySelectorAll<HTMLElement>('button[data-session]')];
      if (!rows.length) return;
      const own = from.closest('.work-session')?.querySelector<HTMLElement>('button[data-session]');
      const at = railStep(rows.length, own ? rows.indexOf(own) : -1, e.key,
        // From a node row: the nearest session below it, or above it.
        rows.findIndex(row => from.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING));
      e.preventDefault(); // the list never scrolls by itself under the highlight
      if (at === 'search') { this.control<HTMLInputElement>('#work-filter')?.focus(); return; }
      if (at === null) return;
      rows[at].focus({ preventScroll: true }); rows[at].scrollIntoView({ block: 'nearest' });
      return;
    }
    if (!e.shiftKey && e.key === 'ArrowRight' && from.closest('.work-session')) {
      // The model of the highlighted session is under its row; ← or Esc come back.
      const control = from.closest('.work-session')!.querySelector<HTMLElement>('.work-model :is(select, button):not([disabled])');
      if (control) { e.preventDefault(); control.focus({ preventScroll: true }); }
      return;
    }
    const t = e.key.length === 1 ? this.railOpenRow(from) : null;
    if (t) { e.preventDefault(); t.term!.focus(); t.term!.input(e.key, true); }
  }

  markExit(id: string): void {
    const t = this.tabs.get(id); if (!t) return;
    t.info.alive = false; this.renderList(); this.updateCard(t);
  }

  async close(id: string): Promise<void> {
    const t = this.tabs.get(id); if (!t) return;
    // Keep the session visible if deletion fails, so it can still be managed.
    // A session that already ended may be unknown to the server: it can still be dropped from the client.
    try { await api.killTerminal(id); } catch (err) { if (t.info.alive) { this.message(String(err)); return; } }
    t.ws?.close(); t.observer?.disconnect(); t.term?.dispose(); t.pane?.remove();
    this.tabs.delete(id); this.sel = removeTile(this.sel, id);
    if (this.active === id) this.active = (this.tiled ? this.sel.focus : null) ?? [...this.tabs.values()].find(s => s.info.nodeId === this.selectedNode)?.info.id ?? null;
    this.renderList(); this.renderBody();
  }

  private setTiled(value: boolean): void {
    this.sideOpen = false;
    this.tiled = value;
    if (value && !this.composed) {
      if (this.active) this.showInView(this.active);
      this.syncSel();
      this.active = this.sel.focus ?? this.active;
    } else if (value) {
      // The previous selection is kept (it only loses sessions that are gone); the first time it is the focused session and its node.
      const known = reconcileTiles(this.sel, new Set(this.tabs.keys()));
      const infos = [...this.tabs.values()].map(t => ({ id: t.info.id, nodeId: t.info.nodeId, alive: t.info.alive, createdAt: t.info.createdAt }));
      this.sel = known.ids.length ? (this.active ? focusTile(known, this.active) : known) : defaultTiles(infos, this.active);
      if (this.sel.focus && this.active !== this.sel.focus) { this.active = this.sel.focus; this.selectedNode = this.tabs.get(this.sel.focus)?.info.nodeId ?? null; }
    }
    this.renderBody(); this.renderList();
  }

  /** Removes a session from the grid only: the process, the WebSocket and the xterm stay alive and the card stays in the rail. */
  private removeView(id: string): void {
    if (!this.composed) { this.dropFromNodeView(id); return; }
    if (!this.sel.ids.includes(id)) return;
    this.sel = removeTile(this.sel, id);
    const focus = this.sel.focus && this.tabs.get(this.sel.focus);
    if (this.active === id || this.active === null) { this.active = focus ? focus.info.id : null; this.selectedNode = focus ? focus.info.nodeId ?? null : this.selectedNode; }
    this.renderList(); this.renderBody();
    requestAnimationFrame(() => { if (this.active) this.tabs.get(this.active)?.term?.focus(); });
  }

  private tileInfos(): { id: string; nodeId: number | null | undefined; alive: boolean; createdAt: number | undefined; role: string | undefined }[] {
    return [...this.tabs.values()].map(t => ({ id: t.info.id, nodeId: t.info.nodeId, alive: t.info.alive, createdAt: t.info.createdAt, role: t.info.role }));
  }
  private nodeView(node: number | null): NodeView {
    let v = this.views.get(node);
    if (!v) this.views.set(node, v = emptyNodeView());
    return v;
  }
  private nodeViewList(): string[] { return orderTiles(nodeViewIds(this.selectedNode, this.tileInfos(), this.nodeView(this.selectedNode), this.links), this.tileOrder); }

  /** With the grid on and no composition, `sel` is the current page of the selected node's view; it is recomputed before every read. */
  private syncSel(): void {
    if (!this.tiled) return;
    if (this.composed) { this.sel = { ...this.sel, ids: orderTiles(this.sel.ids, this.tileOrder) }; return; }
    const view = this.nodeView(this.selectedNode);
    const ids = this.nodeViewList();
    view.page = clampPage(view.page, ids.length);
    const shown = pageIds(ids, view.page);
    this.sel = { ids: shown, focus: this.active && shown.includes(this.active) ? this.active : shown[0] ?? null };
  }

  /** Makes the view show `id` on the current page. A session already in the current view (a guest too) keeps that view, any other one switches to its own node. */
  private showInView(id: string): void {
    const t = this.tabs.get(id); if (!t) return;
    let ids = this.nodeViewList();
    if (!ids.includes(id)) {
      this.selectedNode = t.info.nodeId ?? null;
      const own = this.nodeView(this.selectedNode); own.hidden = own.hidden.filter(h => h !== id);
      ids = this.nodeViewList();
    }
    const view = this.nodeView(this.selectedNode);
    view.page = pageOfId(ids, id) ?? view.page;
  }

  private goToPage(page: number): void {
    if (this.composed) return;
    const view = this.nodeView(this.selectedNode);
    view.page = clampPage(page, this.nodeViewList().length);
    this.syncSel();
    this.active = this.sel.focus;
    this.renderList(); this.renderBody();
    requestAnimationFrame(() => { if (this.active) this.tabs.get(this.active)?.term?.focus(); });
  }

  /** Node view only: the session leaves the view (own = hidden, guest = dropped). Nothing is closed. */
  private dropFromNodeView(id: string): void {
    if (!this.nodeViewList().includes(id)) return;
    const next = removeTile({ ids: this.nodeViewList(), focus: this.active }, id).focus;
    const view = this.nodeView(this.selectedNode);
    if (view.guests.includes(id)) view.guests = view.guests.filter(g => g !== id);
    else if (!view.hidden.includes(id)) view.hidden = [...view.hidden, id];
    if (this.active === id || this.active === null) this.active = next;
    this.syncSel();
    this.renderList(); this.renderBody();
    requestAnimationFrame(() => { if (this.active) this.tabs.get(this.active)?.term?.focus(); });
  }

  /** Nodes whose terminals are on screen: a session of any other node needs a link to them. */
  private linkBases(): number[] {
    const nodes = this.composed ? this.sel.ids.map(id => this.tabs.get(id)?.info.nodeId ?? null) : [this.selectedNode];
    return nodes.filter((n, i): n is number => n !== null && nodes.indexOf(n) === i);
  }
  private linkBase(): number | null {
    const focus = this.composed && this.sel.focus ? this.tabs.get(this.sel.focus)?.info.nodeId ?? null : null;
    return focus ?? this.linkBases()[0] ?? null;
  }

  /** Picker toggle. Returns false when refused (a composition is limited to MAX_TILES). */
  private toggleInView(id: string): boolean {
    if (this.composed) {
      const result = toggleTile(this.sel, id, new Set(this.tabs.keys()));
      if (result.change === 'full') { this.message(ui`Al massimo ${MAX_TILES} terminali affiancati: rimuovi una vista per aggiungerne un’altra.`); return false; }
      this.message('');
      this.sel = { ids: result.ids, focus: result.focus };
      if (!this.active || !this.sel.ids.includes(this.active)) { const f = this.sel.focus && this.tabs.get(this.sel.focus); this.active = f ? f.info.id : null; this.selectedNode = f ? f.info.nodeId ?? null : this.selectedNode; }
      this.tiled = this.sel.ids.length > 0 || this.tiled;
    } else {
      this.message('');
      if (this.nodeViewList().includes(id)) { this.dropFromNodeView(id); return true; }
      const t = this.tabs.get(id); if (!t) return false;
      const view = this.nodeView(this.selectedNode);
      if ((t.info.nodeId ?? null) === this.selectedNode) view.hidden = view.hidden.filter(h => h !== id);
      else if (!view.guests.includes(id)) view.guests = [...view.guests, id];
      this.tiled = true;
      view.page = pageOfId(this.nodeViewList(), id) ?? view.page;
      this.syncSel();
      this.active = this.sel.focus;
    }
    this.renderList(); this.renderBody();
    return true;
  }

  /** The user confirmed: the two orchestrators are linked, then the session joins the view. */
  private async confirmLink(): Promise<void> {
    const id = this.pendingAdd;
    const t = id ? this.tabs.get(id) : undefined;
    const base = this.linkBase();
    if (!id || !t || base === null || t.info.nodeId == null) { this.pendingAdd = null; this.renderPicker(); return; }
    const link = orchestratorLink(base, t.info.nodeId, this.tileInfos());
    if (!link) { this.message(ui`Collegamento impossibile: serve un orchestratore attivo in entrambi i nodi (${this.nodeLabel(base)}, ${this.nodeLabel(t.info.nodeId)})`); this.pendingAdd = null; this.renderPicker(); return; }
    try { await api.linkTeams(link); await this.refreshLinks(); } catch (err) { this.message(String(err)); return; }
    this.pendingAdd = null;
    this.toggleInView(id);
    this.picker.querySelector<HTMLElement>(ui`[data-tile="${id}"]`)?.focus();
  }

  /** "Affianca collegati": the live endpoints of the card's linked nodes go side by side, and the picker opens to adjust. */
  private groupLinked(nodeId: number): void {
    const infos = [...this.tabs.values()].map(t => ({ id: t.info.id, nodeId: t.info.nodeId, alive: t.info.alive, createdAt: t.info.createdAt, role: t.info.role }));
    const found = groupSuggestion(nodeId, this.links, infos);
    this.suggested = new Set(found.ids);
    const dead = found.inactive.length ? ui`Collegamenti inattivi, senza sessione viva raggiungibile (non proposti): ${found.inactive.length}.` : '';
    this.syncSel(); this.composed = true;
    if (!found.ids.length) { this.message(ui`Nessuna sessione attiva da affiancare per questo nodo. ${dead}`); this.openPicker(); return; }
    if (!found.fits) {
      this.message(ui`${found.ids.length} sessioni collegate: ne entrano al massimo ${MAX_TILES}. Scegli quali affiancare. ${dead}`);
      this.openPicker(); return;
    }
    this.message(dead);
    this.sel = { ids: found.ids, focus: found.ids[0] };
    this.tiled = true;
    const first = this.tabs.get(found.ids[0])!;
    this.active = first.info.id; this.selectedNode = first.info.nodeId ?? null;
    this.show(true); this.renderList(); this.renderBody();
    this.openPicker();
  }
  /** The terminals of a node: its first live session (else the first one), or the empty node with its start buttons. Never the Brain. */
  private openNode(id: number | null): void {
    if (this.sideOpen) {
      this.selectedNode = id;
      this.renderList(); this.renderBody(); return;
    }
    this.composed = false; this.selectedNode = id;
    const mine = [...this.tabs.values()].filter(t => (t.info.nodeId ?? null) === id);
    const first = mine.find(t => t.info.alive) ?? mine[0];
    if (first) { this.activate(first.info.id); this.show(true); return; }
    this.active = null; this.show(true); this.renderList(); this.renderBody();
  }
  private openPicker(): void {
    this.show(true); this.picker.open = true; this.renderPicker();
    this.picker.querySelector<HTMLElement>('input:not(:disabled)')?.focus();
  }

  private tileKey(e: KeyboardEvent): void {
    if (!this.isOpen() || this.sideOpen || !this.tiled || (e.target instanceof HTMLElement && e.target.closest('#overlay'))) return;
    const action = tileKeyAction(e);
    if (!action) return;
    this.syncSel();
    e.preventDefault(); e.stopPropagation();
    if (action.type === 'picker') { this.openPicker(); return; }
    if (action.type === 'remove') { if (this.active) this.removeView(this.active); return; }
    const next = action.type === 'focus' ? focusIndex(this.sel, action.index) : stepFocus(this.sel, action.delta);
    if (next.focus && next.focus !== this.active) this.activate(next.focus);
    else this.tabs.get(next.focus ?? '')?.term?.focus();
  }

  /** Terminals offered as tabs in the single view: the node view, plus the one on screen if it came from elsewhere. */
  private tabIds(): string[] {
    const ids = this.nodeViewList().filter(id => this.tabs.has(id));
    if (this.active && this.tabs.has(this.active) && !ids.includes(this.active)) ids.unshift(this.active);
    return ids;
  }
  private renderTabs(): void {
    if (!this.tabStrip) return; // views assembled piecemeal (tests) have no strip
    const show = this.isOpen() && !this.sideOpen && !this.tiled;
    const ids = show ? this.tabIds() : [];
    const html = ids.length < 2 ? '' : ids.map((id, i) => {
      const t = this.tabs.get(id)!, on = id === this.active, tone = sessionTone(t.info);
      const label = t.info.role ? this.roleName(t) : t.info.name || this.generatedName(t);
      const keys = i < 9 ? ` · Ctrl+Alt+${i + 1}` : '';
      return ui`<button type="button" role="tab" class="term-tab" data-tab="${id}" aria-selected="${on}"${tone ? ` data-tone="${tone}"` : ''} title="${esc(this.sessionLabel(t) + ' · ' + toneReason(t.info) + keys)}"><span class="work-dot"></span><span class="term-tab-label">${esc(label)}</span>${t.info.code ? ui`<span class="work-code">${esc(t.info.code)}</span>` : ''}</button>`;
    }).join('');
    this.tabStrip.classList.toggle('hidden', !html);
    this.bodyEl.classList.toggle('with-tabs', Boolean(html)); // the tab already names the session: the pane header does not repeat it
    // One row: the strip takes the place of the session name in the active pane's header, beside its commands.
    const host = html && this.active ? this.tabs.get(this.active)?.pane?.querySelector('.session-heading') : null;
    if (host) { if (this.tabStrip.parentElement !== host) host.prepend(this.tabStrip); }
    else if (this.tabStrip.nextElementSibling !== this.bodyEl) this.bodyEl.insertAdjacentElement('beforebegin', this.tabStrip);
    if (this.tabStrip.dataset.sig === html) return;
    this.tabStrip.dataset.sig = html; this.tabStrip.innerHTML = html;
    this.tabStrip.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  /** Single view: ⌘⇧[ ⌘⇧], ⌃Tab and Ctrl+Alt+[ ] / 1-9 move between the tabs, as in the grid. */
  private tabKey(e: KeyboardEvent): void {
    if (!this.isOpen() || this.sideOpen || this.tiled || (e.target instanceof HTMLElement && e.target.closest('#overlay'))) return;
    const step = tabStepKey(e), action = step === null ? tileKeyAction(e) : null;
    if (step === null && action?.type !== 'step' && action?.type !== 'focus') return;
    const ids = this.tabIds();
    if (ids.length < 2) return;
    e.preventDefault(); e.stopPropagation();
    const next = action?.type === 'focus' ? ids[action.index] : stepTab(ids, this.active, step ?? (action?.type === 'step' ? action.delta : 1));
    if (next && next !== this.active) this.activate(next);
  }

  /** ⌘J: the "+ Agent" dialog for the node on screen (a plain terminal is one of its choices). */
  private shortcutKey(e: KeyboardEvent): void {
    if (!this.isOpen() || (e.target instanceof HTMLElement && e.target.closest('#overlay'))) return;
    if (e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey && e.code === 'Space' && document.getElementById('overlay')!.classList.contains('hidden')) {
      e.preventDefault(); e.stopPropagation();
      if (!e.repeat) this.toggleQuickMenu();
      return;
    }
    // ⌘⇧J: a plain terminal at once, in the node on screen (free when none is selected).
    if (isPlainTerminalKey(e)) { e.preventDefault(); e.stopPropagation(); void this.openShell(this.selectedNode); return; }
    if (!isNewTerminalKey(e)) return;   // also from Lavoro and Codice: the launcher opens over them
    e.preventDefault(); e.stopPropagation();
    this.openLauncher();
  }

  private toggleQuickMenu(): void {
    // No button of its own in the rail head: the menu opens from the keyboard (Ctrl+Shift+Space), under the head.
    const anchor = this.control<HTMLElement>('.work-rail-head')!;
    if (terminalQuickMenuOpen()) { this.dismissQuickMenu?.(); return; }
    if (this.root.classList.contains('rail-collapsed')) this.control<HTMLElement>('#work-toggle-rail')!.click();
    const items = [...this.tabs.values()].map(tab => this.quickItem(tab));
    this.dismissQuickMenu = openTerminalQuickMenu({ anchor, items, selectedId: this.active,
      onOpen: id => this.activate(id) });
  }

  /** What the quick menu says about a session: who it is, the model it is on, its last words. */
  private quickItem(tab: Tab) {
    return {
      id: tab.info.id,
      label: [tab.info.code ?? tab.info.id, tab.info.name || labels[tab.info.agent], this.nodeLabel(tab.info.nodeId ?? null)].join(' · '),
      model: tab.info.modelNext ?? tab.info.modelNow ?? tab.info.model,
      preview: () => this.quickPreview(tab),
    };
  }

  /** Asks the session's own CLI for another model, in place. The row shows the new model only once the CLI confirms it. */
  private async switchModel(id: string, model: string): Promise<void> {
    const tab = this.tabs.get(id);
    if (!tab || !model) return;
    try { tab.info.modelChange = (await api.switchModel(id, model)).change; }
    catch (err) { this.message(String(err instanceof Error ? err.message : err)); }
    this.renderDetails(); this.watchModels();
  }
  /** The person's answer to what the CLI asked before switching (yes), or a change they no longer want (no). */
  private async answerModel(id: string, yes: boolean): Promise<void> {
    try { await (yes ? api.confirmModel(id) : api.cancelModel(id)); } catch (err) { this.message(String(err instanceof Error ? err.message : err)); }
    await this.syncSessions();
    this.listEl.querySelector<HTMLElement>(`.work-session[data-sid="${id}"] .work-model :is(select, button):not([disabled])`)?.focus({ preventScroll: true });
  }
  /** While a change is on its way the list is read again often, so its outcome shows as soon as the CLI confirms it. */
  private watchModels(): void {
    if (this.modelWatch || ![...this.tabs.values()].some(t => ['waiting', 'running', 'confirm'].includes(t.info.modelChange?.state ?? ''))) return;
    this.modelWatch = setTimeout(() => { this.modelWatch = null; void this.syncSessions(); }, 700);
  }

  /** The row the keyboard highlights stays marked while the keyboard is on its model. */
  private markPreviewRow(): void {
    for (const row of this.listEl.querySelectorAll<HTMLElement>('.work-session')) row.classList.toggle('previewed', row.dataset.sid === this.railPreviewId);
  }

  /** The session the keyboard highlights (null: none) shows its detail under its row: its model and, when its terminal
   *  is not on screen, its last words. */
  private showRailPreview(id: string | null): void {
    const tab = id ? this.tabs.get(id) : undefined;
    if (!tab) { this.railPreviewId = null; this.railPreviewData = null; this.railPreviewRequest++; this.markPreviewRow(); this.renderDetails(); return; }
    this.railPreviewId = tab.info.id; this.markPreviewRow(); this.renderDetails();
    const request = ++this.railPreviewRequest;
    void this.quickPreview(tab).catch((): SessionPreview => ({ text: '' })).then(preview => {
      if (request !== this.railPreviewRequest) return;
      this.railPreviewData = { id: tab.info.id, preview }; this.renderDetails();
    });
  }

  /** Reading an xterm buffer has no effect on the active pane, its selection or its PTY. */
  private async quickPreview(tab: Tab): Promise<SessionPreview> {
    const buffer = tab.term?.buffer.active;
    if (buffer?.length) {
      const lines: string[] = [];
      for (let i = buffer.baseY; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
      if (lines.some(line => line.trim())) return sessionPreview(lines);
    }
    return api.terminalPreview(tab.info.id);
  }

  private renderDetails(): void {
    for (const row of this.listEl.querySelectorAll<HTMLElement>('.work-session[data-sid]')) this.renderDetail(row);
  }

  /** Under the row of the open session and of the highlighted one: the model, changed in place with the CLI's own
   *  selector, and for a highlighted session whose terminal is not on screen its last words. Rebuilt only when what it
   *  says changes, so an open choice list is not closed by a poll. */
  private renderDetail(row: HTMLElement): void {
    const box = row.querySelector<HTMLElement>('.work-session-detail'), info = this.tabs.get(row.dataset.sid!)?.info;
    if (!box || !info) return;
    const highlighted = this.railPreviewId === info.id, onScreen = this.active === info.id || !!this.sel?.ids.includes(info.id);
    const model = highlighted || this.active === info.id ? this.modelLine(info) : '';
    const data = highlighted && !onScreen && this.railPreviewData?.id === info.id ? this.railPreviewData.preview : null;
    const words = !data ? '' : (data.text ? `<p class="work-session-preview">${esc(data.text)}</p>` : '') + (data.error ? `<p class="work-session-preview error">${esc(data.error)}</p>` : '')
      + (!data.text && !data.error ? `<p class="work-session-preview none">${tr('Nessuna attività leggibile')}</p>` : '');
    const html = model + words;
    if (box.dataset.shown === html) return;
    const focused = box.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
    const refocus = focused?.dataset.modelSelect !== undefined ? 'select' : focused ? 'button' : '';
    box.dataset.shown = html; box.innerHTML = html; box.hidden = !html;
    if (refocus) (box.querySelector<HTMLElement>(`.work-model ${refocus}:not([disabled])`) ?? row.querySelector<HTMLElement>('button[data-session]'))?.focus({ preventScroll: true });
    if (highlighted && html) row.scrollIntoView({ block: 'nearest' });
  }

  /** The model of a session as its own CLI reports it, with the choice to change it. The launch model is named only when
   *  the session has moved away from it. */
  private modelLine(info: TerminalInfo): string {
    if (!info.alive || info.agent === 'shell') return '';
    const limit = this.modelChoices?.limits[info.agent];
    if (limit) return `<div class="work-model"><span class="work-model-state">${info.model ? `${esc(info.model)} · ` : ''}${esc(tr(limit))}</span></div>`;
    const choices = info.agent === 'claude' || info.agent === 'codex' ? this.modelChoices?.[info.agent] : undefined;
    if (!choices?.length) return '';
    const change = info.modelChange, busy = change && ['waiting', 'running', 'confirm'].includes(change.state);
    const current = info.modelChoice ?? '';
    const options = (choices.some(c => c.id === current) ? '' : `<option value="" selected disabled>${esc(info.modelNow ?? info.model ?? tr('Predefinito'))}</option>`)
      + choices.map(c => `<option value="${esc(c.id)}"${c.id === current ? ' selected' : ''}>${esc(c.label)}</option>`).join('');
    const moved = info.model && current && info.model !== current ? ` · ${tr('avvio')}: ${esc(info.model)}` : '';
    let state = info.modelNext ? `${esc(info.modelNext)} ${tr('dal prossimo turno')}${info.modelNow ? ` · ${tr('ultimo')}: ${esc(info.modelNow)}` : ''}`
      : info.modelNow ? `${tr('ultimo turno')}: ${esc(info.modelNow)}${moved}` : info.model ? `${tr('all’avvio')}: ${esc(info.model)}` : '';
    let tone = '', title = '', actions = '';
    const cancel = `<button type="button" class="work-model-act" data-model-cancel="${info.id}">${tr('Annulla')}</button>`;
    const lower = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
    if (change?.state === 'waiting') { state = `→ ${esc(change.label)} · ${esc(lower(tr(change.message ?? 'In coda')))}`; actions = cancel; }
    else if (change?.state === 'running') state = `→ ${esc(change.label)} · ${tr('cambio in corso…')}`;
    else if (change?.state === 'confirm') {
      // The CLI's own warning, in the person's language when it is the one we know; its exact words stay in the tooltip.
      const cost = /slower and use more tokens/i.test(change.message ?? '');
      state = `→ ${esc(change.label)} · ${cost ? tr('la prossima risposta sarà più lenta e userà più token: confermi?') : esc(change.message ?? '')}`;
      title = change.message ?? ''; tone = ' ask';
      actions = `<button type="button" class="work-model-act" data-model-confirm="${info.id}">${tr('Conferma')}</button>${cancel}`;
    } else if (change?.state === 'failed') { state = esc(tr(change.message ?? 'Cambio non riuscito')); tone = ' warn'; }
    return `<div class="work-model"><select data-model-select="${info.id}" aria-label="${tr('Modello di')} ${esc(info.code ?? info.id)}" title="${tr('Modello della sessione: il cambio vale dal prossimo turno')}"${busy ? ' disabled' : ''}>${options}</select><span class="work-model-state${tone}"${title ? ` title="${esc(title)}"` : ''}>${state}</span>${actions}</div>`;
  }

  /** Files dropped on the window (the desktop shell reports their paths): they are typed, escaped, into the terminal under the pointer. */
  private fileDrop(detail: unknown): void {
    const drop = parseFileDrop(detail);
    this.root.querySelectorAll('.term-pane.drop-target').forEach(p => p.classList.remove('drop-target'));
    // A dialog on top (e.g. the launcher, which takes attachments) receives the drop instead of the terminal behind it.
    const overlay = document.getElementById('overlay');
    const dialogOpen = !!overlay && !overlay.classList.contains('hidden');
    if (!drop || drop.kind === 'leave' || dialogOpen || !this.isOpen() || this.sideOpen) return;
    // The shell sends CSS pixels (before 0.2.25 it sent macOS points as if they were physical pixels: half the position on Retina).
    const hit = drop.x !== null && drop.y !== null ? document.elementFromPoint(drop.x, drop.y)?.closest<HTMLElement>('.term-pane') : null;
    const visible = [...this.bodyEl.querySelectorAll<HTMLElement>('.term-pane:not(.hidden)')];
    const pane = hit ?? (visible.length === 1 ? visible[0] : null);
    if (drop.kind === 'over') { pane?.classList.add('drop-target'); return; }
    const tab = pane ? this.tabs.get(pane.dataset.session ?? '') : undefined;
    if (!drop.paths.length) { this.message(tr('Non ho ricevuto nessun file da questo trascinamento. Salvalo sul disco e trascinalo dal Finder.')); return; }
    if (!tab?.term) { this.message(tr('Rilascia i file su un terminale.')); return; }
    if (!tab.info.alive || tab.ws?.readyState !== WebSocket.OPEN) { this.message(tr('Il terminale non è attivo: i file non sono stati inseriti.')); return; }
    this.message('');
    tab.term.paste(dropText(drop.paths));
    this.activate(tab.info.id);
  }

  /** "Operatore 3" from the session code; sessions older than codes are numbered by position among their node's operators. */
  private roleName(t: Tab): string {
    if (!t.info.role) return this.agentLabel(t);
    const position = t.info.role === 'operator' ? String([...this.tabs.values()].filter(tab => tab.info.nodeId === t.info.nodeId && tab.info.role === 'operator' && tab.info.alive === t.info.alive).indexOf(t) + 1) : '';
    return roleName(t.info, position);
  }
  /** «Terminale», then «Terminale 2», «Terminale 3»… for the later sessions of the same agent without a role in the node,
   * in order of creation: the rail and the tabs tell them apart, and the first keeps its plain name. */
  private agentLabel(t: Tab): string {
    const position = [...this.tabs.values()].filter(tab => !tab.info.role && tab.info.agent === t.info.agent && (tab.info.nodeId ?? null) === (t.info.nodeId ?? null))
      .sort((a, b) => a.info.createdAt - b.info.createdAt).indexOf(t);
    return position > 0 ? `${labels[t.info.agent]} ${position + 1}` : labels[t.info.agent];
  }
  private nodeLabel(nodeId: number | null): string {
    const node = nodeId !== null ? this.nodes.get(nodeId) : null;
    return node?.name ?? [...this.tabs.values()].find(t => (t.info.nodeId ?? null) === nodeId)?.info.cwd.split('/').pop() ?? (nodeId !== null ? ui`Nodo #${nodeId}` : tr('Terminali liberi'));
  }

  private createPicker(): HTMLDetailsElement {
    const picker = document.createElement('details');
    picker.className = 'work-overflow tile-picker';
    picker.innerHTML = ui`<summary aria-label="Scegli i terminali da affiancare" title="Scegli i terminali da affiancare (Ctrl+Alt+G)"><span class="control-label">Seleziona</span>${icon('chevron')}</summary><div role="group" aria-label="Terminali da affiancare"></div>`;
    picker.addEventListener('toggle', () => { if (picker.open) this.renderPicker(); else { this.suggested.clear(); this.pickerHtml = ''; } });
    picker.addEventListener('change', e => {
      const input = e.target as HTMLInputElement;
      const id = input.dataset.tile; if (!id) return;
      // Showing a session of a node that is not linked to the ones on screen is what links their orchestrators: ask first.
      const adding = !(this.composed ? this.sel.ids : this.nodeViewList()).includes(id);
      if (adding && needsLink(this.linkBases(), this.tabs.get(id)?.info.nodeId ?? null, this.links)) { input.checked = false; this.pendingAdd = id; this.message(''); this.renderPicker(); return; }
      this.pendingAdd = null;
      if (!this.toggleInView(id)) input.checked = false;
      this.picker.querySelector<HTMLElement>(ui`[data-tile="${id}"]`)?.focus();
    });
    picker.addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-link-confirm],[data-link-cancel]'); if (!b) return;
      if (b.hasAttribute('data-link-cancel')) { this.pendingAdd = null; this.renderPicker(); return; }
      void this.confirmLink();
    });
    return picker;
  }

  private pickerRow(item: PickerItem, flags: { linked?: boolean; suggested?: boolean } = {}): string {
    const t = this.tabs.get(item.id)!;
    const marker = item.tile ? tileMarker(item.tile - 1).text : '';
    const state = toneReason(t.info);
    return ui`<label class="${item.selected ? 'on' : ''} ${item.disabled ? 'off' : ''}" title="${item.disabled ? esc(tr('Griglia piena: rimuovi una vista per aggiungerne un’altra.')) : ''}"><input type="checkbox" data-tile="${item.id}" ${item.selected ? 'checked' : ''} ${item.disabled ? 'disabled' : ''}><span>${esc(this.sessionLabel(t))}</span><small>${flags.linked ? '⇄ ' : ''}${flags.suggested && !item.selected ? tr('suggerita') + ' · ' : ''}${marker ? marker + ' · ' : ''}${state}</small></label>`;
  }

  private renderPicker(): void {
    const box = this.picker.querySelector<HTMLElement>(':scope > div')!;
    const infos = this.tileInfos();
    let html: string;
    if (this.composed) {
      const ends = new Set<string>();
      for (const l of this.links) { if (l.srcNodeId !== l.dstNodeId) for (const id of [l.srcSessionId, l.dstSessionId]) if (id) ends.add(id); }
      const groups = pickerGroups(infos, this.sel, id => this.nodeLabel(id), undefined, MAX_TILES, { linked: ends, suggested: this.suggested });
      const used = this.sel.ids.length;
      html = ui`<div class="tile-picker-head"><span>Terminali affiancati</span><span>${used}/${MAX_TILES}</span></div>` + this.pickerConfirm() + (groups.map(g => ui`<div class="tile-picker-node">${esc(g.name)}</div>${g.items.map(item => this.pickerRow(item, { linked: item.linked, suggested: item.suggested })).join('')}`).join('') || tr('<div class="tile-picker-empty">Nessuna sessione. Avvia un agente da un nodo.</div>'));
    } else {
      const view = this.nodeView(this.selectedNode);
      const total = this.nodeViewList().length;
      const groups = nodePickerGroups(infos, this.selectedNode, view, this.links, id => this.nodeLabel(id), this.tileOrder);
      html = ui`<div class="tile-picker-head"><span>Terminali di ${esc(this.nodeLabel(this.selectedNode))}</span><span>${total}</span></div>` + this.pickerConfirm() + (groups.map(g => {
        const note = g.own ? '' : g.linked ? ' ⇄ ' + tr('collegato') : ' · ' + tr('richiede il collegamento');
        return ui`<div class="tile-picker-node">${esc(g.name)}${esc(note)}</div>${g.items.map(item => this.pickerRow(item, { linked: !g.own && g.linked })).join('')}`;
      }).join('') || tr('<div class="tile-picker-empty">Nessuna sessione. Avvia un agente da un nodo.</div>'));
    }
    if (html === this.pickerHtml) return;
    const focused = document.activeElement instanceof HTMLElement && box.contains(document.activeElement) ? document.activeElement.dataset.tile : undefined;
    box.innerHTML = html; this.pickerHtml = html;
    if (focused) box.querySelector<HTMLElement>(ui`[data-tile="${focused}"]`)?.focus();
  }

  /** Confirmation shown on top of the picker while a session of an unlinked node waits to be added. */
  private pickerConfirm(): string {
    const t = this.pendingAdd ? this.tabs.get(this.pendingAdd) : undefined;
    const base = this.linkBase();
    if (!t || base === null) return '';
    return ui`<div class="tile-picker-confirm" role="alert"><span>Per mostrare ${esc(this.sessionLabel(t))} (${esc(this.nodeLabel(t.info.nodeId ?? null))}) vicino a ${esc(this.nodeLabel(base))} i due orchestratori vengono collegati e iniziano a scambiarsi informazioni.</span><span><button class="btn small" data-link-confirm>Collega e aggiungi</button> <button class="btn small" data-link-cancel>Annulla</button></span></div>`;
  }

  private railSessionTitle(info: TerminalInfo, linked: boolean): string {
    return [info.code, labels[info.agent], info.modelNext ?? info.modelNow ?? [info.model, info.effort].filter(Boolean).join(' '), toneReason(info), linked ? tr('Canale collegato') : ''].filter(Boolean).join(' · ');
  }

  private renderList(): void {
    this.pollSignature = ''; // A direct UI action may have changed the rendered state between polls.
    if (document.body.classList.contains('reordering')) return;
    // "Lavoro" counts the sessions waiting on the person: a permission or a question, or blocked.
    const needs = [...this.tabs.values()].filter(t => t.info.alive && ['attention', 'blocked'].includes(sessionTone(t.info) ?? '')).length;
    const badge = this.control('#work-needs');
    if (badge) { badge.hidden = !needs; badge.textContent = String(needs); badge.title = needs === 1 ? tr('1 sessione aspetta te') : ui`${needs} sessioni aspettano te`; }
    // The rail's "Serve te" filter carries the same count, so what waits on the person is visible without filtering.
    const needsFilter = this.control('#work-state-filter [data-state="needs"]');
    if (needsFilter?.dataset) {
      if (needs) needsFilter.dataset.count = String(needs); else delete needsFilter.dataset.count;
      // the dot has no text of its own: its name carries the count for the tooltip and the screen reader
      const said = needs ? `${tr('Serve te')}: ${needs === 1 ? tr('1 sessione aspetta te') : ui`${needs} sessioni aspettano te`}` : '';
      needsFilter.title = said || tr('Serve te: permessi, domande e bloccati');
      needsFilter.setAttribute('aria-label', said || tr('Serve te'));
    }
    this.syncSel();
    this.renderTabs();
    const sessionsInfo = [...this.tabs.values()].map(t => ({ ...t.info }));
    this.cb.sessionsChanged(sessionsInfo, this.active);
    const tones = connectionGroups(this.links);
    const endpoints = connectionEndpoints(this.links, sessionsInfo);
    const now = Date.now();
    const filteringState = this.stateFilter && this.stateFilter !== 'all';
    const toneAttr = (id: number | null) => (id !== null && tones.has(id) ? ` data-connection-tone="${tones.get(id)!.tone}"` : '');
    const groupIds = new Set<number | null>([...this.nodes.keys(), ...[...this.tabs.values()].map(t => t.info.nodeId ?? null)]);
    const groups: WorkListItem[] = [];
    for (const { id, clusterSize, clusterStart } of orderNodes([...groupIds], this.nodeOrder, this.links, true)) {
      const node = id !== null ? this.nodes.get(id) : null;
      const sessions = [...this.tabs.values()].filter(t => (t.info.nodeId ?? null) === id);
      const name = id === null ? tr('Terminali liberi') : node?.name ?? sessions[0]?.info.cwd.split('/').pop() ?? ui`Nodo #${id}`;
      // Colour of the squad on each session, only where the node has more than one squad at work.
      const squadIds = new Set(sessions.filter(t => t.info.role && t.info.role !== 'brain').map(t => t.info.teamId ?? '1'));
      const squadMark = (info: TerminalInfo) => squadIds.size > 1 && info.role && info.role !== 'brain' ? ` data-team-color="${(Number(info.teamId ?? '1') - 1) % 8}"` : info.role === 'brain' ? ' data-brain="true"' : '';
      const path = node?.path ?? sessions[0]?.info.cwd ?? '';
      const matchesNode = ui`${name} ${path}`.toLowerCase().includes(this.filter);
      const matching = sessions.filter(t => {
        const state = sessionTone(t.info, now) ?? (t.info.alive ? 'terminal' : 'ended');
        const stateMatch = this.stateFilter === 'needs' ? state === 'attention' || state === 'blocked'
          : this.stateFilter === 'active' ? state === 'active' || (state === 'orchestrator' && sessionWorking(t.info, now))
          : state === this.stateFilter;
        return (!filteringState || stateMatch) && (matchesNode || ui`${labels[t.info.agent]} ${t.info.role ? roles[t.info.role] : ''} ${t.info.code || ''} ${t.info.model || ''} ${t.info.name || ''} ${t.info.title} ${t.info.id}`.toLowerCase().includes(this.filter));
      });
      const rank = (t: Tab) => { const at = this.sessionOrder.indexOf(t.info.id); return at < 0 ? Infinity : at; };
      const collapsed = id !== null && this.collapsedNodes.has(id) && !this.filter && !filteringState;
      const shown = [...matching].sort((a, b) => rank(a) - rank(b)); // stable: sessions never moved keep their creation order
      if ((!matchesNode || filteringState) && !shown.length) continue;
      if (clusterStart) groups.push({ key: `cluster:${id}`, html: ui`<div class="work-cluster"${toneAttr(id)}>⇄ Collegati · ${clusterSize} nodi</div>` });
      const rows: WorkListItem[] = [{ key: 'header', html: ui`<div class="work-node-row">${id !== null ? ui`<button class="work-row-grip" data-node-grip="${id}" aria-label="Sposta ${esc(name)}" title="Trascina per riordinare · Alt e frecce per muovere">⠿</button>` : ''}${id !== null ? ui`<button class="work-fold" data-fold="${id}" aria-expanded="${!collapsed}" title="${collapsed ? tr('Espandi nodo') : tr('Compatta nodo')}" aria-label="${collapsed ? tr('Espandi nodo') : tr('Compatta nodo')}">${collapsed ? '›' : '⌄'}</button>` : ''}<button class="work-node ${this.selectedNode === id ? 'selected' : ''}" data-node="${id ?? ''}" aria-current="${this.selectedNode === id ? 'true' : 'false'}" title="${esc(path)}"><span class="work-node-icon" aria-hidden="true">${icon('folder')}</span><span><strong>${esc(name)}</strong>${id !== null && tones.has(id) ? ui` <span class="work-link-mark" title="Nodo con collegamenti" aria-hidden="true">⇄</span>` : ''}</span><span class="work-number">${sessions.length}</span></button>${id === null ? ui`<button class="work-rail-action" data-add-shell="" title="Nuovo terminale libero" aria-label="Nuovo terminale libero">${icon('terminal')}</button>` : ''}${id !== null ? ui`<button class="work-rail-action" data-add-agent="${id}" title="Aggiungi agente a ${esc(name)}" aria-label="Aggiungi agente a ${esc(name)}">${icon('plus')}</button><button class="work-rail-action" data-add-shell="${id}" title="Terminale in ${esc(name)}" aria-label="Terminale in ${esc(name)}">${icon('terminal')}</button><button class="work-rail-action" data-node-link="${id}" title="Collega ${esc(name)}" aria-label="Collega ${esc(name)}" aria-expanded="${this.railLinkSource === `node:${id}`}">${icon('connect')}</button>${tones.has(id) ? ui`<button class="work-rail-action" data-group="${id}" title="Affianca i nodi collegati" aria-label="Affianca i nodi collegati a ${esc(name)}">${icon('grid')}</button>` : ''}` : ''}${id !== null ? ui`<button class="work-remove" data-remove="${id}" title="${sessions.length ? tr('Chiudi il nodo e termina le sue sessioni') : tr('Rimuovi il nodo dalla vista Operativa')}" aria-label="Chiudi ${esc(name)}">×</button>` : ''}</div>` }];
      if (!collapsed) for (const t of shown) {
        rows.push({ key: `session:${t.info.id}`, html: ui`<div class="work-session ${this.active === t.info.id ? 'selected' : ''}" data-sid="${t.info.id}"${toneAttr(id)}${squadMark(t.info)}${endpoints.has(t.info.id) ? ` data-connection-endpoint="${endpoints.get(t.info.id)}"` : ''}><button class="work-row-grip" data-session-grip="${t.info.id}" aria-label="Sposta ${esc(t.info.name || this.roleName(t))}" title="Trascina per riordinare · Alt e frecce per muovere">⠿</button><button data-session="${t.info.id}"><span class="work-dot ${t.info.alive ? 'live' : ''}"></span><span class="work-session-name">${esc(t.info.name || this.roleName(t))}${endpoints.has(t.info.id) ? ' ⇄' : ''}</span>${t.info.code ? ui`<span class="work-code">${esc(t.info.code)}</span>` : ''}</button>${t.info.role && t.info.alive ? ui`<button class="work-rail-action" data-session-link="${t.info.id}" title="Collega ${esc(this.sessionLabel(t))}" aria-label="Collega ${esc(this.sessionLabel(t))}" aria-expanded="${this.railLinkSource === `session:${t.info.id}`}">${icon('connect')}</button>` : ''}<button class="work-close" data-close="${t.info.id}" title="Chiudi sessione e termina il processo" aria-label="Chiudi ${labels[t.info.agent]} ${t.info.id}">×</button><div class="work-session-detail" hidden></div></div>` });
      }
      groups.push({ key: `node:${id}`, html: `<section class="work-group ${this.selectedNode === id ? 'current-node' : ''}"${toneAttr(id)} ${id !== null ? `data-drag="${id}"` : ''}></section>`, children: rows });
    }
    if (!groups.length) groups.push({ key: 'empty', html: tr('<div class="work-list-empty">Nessun nodo trovato.</div>') });
    const focused = this.listEl.contains(document.activeElement) && document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const actionKey = ['addAgent', 'nodeLink', 'sessionLink'].find(key => focused?.dataset[key]);
    const focusKey = actionKey ? `[${actionKey.replace(/[A-Z]/g, c => '-' + c.toLowerCase()).replace(/^/, 'data-')}="${focused!.dataset[actionKey]}"]` : focused?.dataset.nodeGrip ? `[data-node-grip="${focused.dataset.nodeGrip}"]` : focused?.dataset.sessionGrip ? `[data-session-grip="${focused.dataset.sessionGrip}"]` : focused?.dataset.fold ? `[data-fold="${focused.dataset.fold}"]` : focused?.dataset.node ? `[data-node="${focused.dataset.node}"]` : focused?.dataset.session ? `[data-session="${focused.dataset.session}"]` : focused?.dataset.modelSelect ? `[data-model-select="${focused.dataset.modelSelect}"]` : null;
    // The highlighted session may leave the list (closed, filtered out): the highlight stays at the same place.
    const focusedAt = focused?.dataset.session ? [...this.listEl.querySelectorAll('button[data-session]')].indexOf(focused) : -1;
    if (this.patchRail(groups)) {
      this.railDragCleanup.forEach(cleanup => cleanup()); this.railDragCleanup = [];
      this.listEl.querySelectorAll<HTMLElement>('[data-node]').forEach(el => el.onclick = () => {
        const id = el.dataset.node ? Number(el.dataset.node) : null;
        this.openNode(id);
      });
      this.listEl.querySelectorAll<HTMLButtonElement>('[data-fold]').forEach(b => b.onclick = () => {
        const id = Number(b.dataset.fold);
        if (this.collapsedNodes.has(id)) this.collapsedNodes.delete(id); else this.collapsedNodes.add(id);
        this.saveCollapsed(); this.renderList();
      });
      this.listEl.querySelectorAll<HTMLButtonElement>('[data-add-agent]').forEach(b => b.onclick = () => {
        this.openLauncher(undefined, 'embedded', '', false, Number(b.dataset.addAgent));
      });
      this.listEl.querySelectorAll<HTMLButtonElement>('[data-add-shell]').forEach(b => b.onclick = () => void this.openShell(b.dataset.addShell ? Number(b.dataset.addShell) : null));
      this.listEl.querySelectorAll<HTMLButtonElement>('[data-node-link]').forEach(b => b.onclick = () => this.toggleRailLinks(`node:${b.dataset.nodeLink}`));
      this.listEl.querySelectorAll<HTMLButtonElement>('[data-group]').forEach(b => b.onclick = () => this.groupLinked(Number(b.dataset.group)));
      this.listEl.querySelectorAll<HTMLButtonElement>('[data-session-link]').forEach(b => b.onclick = () => this.toggleRailLinks(`session:${b.dataset.sessionLink}`));
      this.bindNodeDrag();
      // A pointer click opens the session and leaves the keyboard on its row, so ↑/↓ go on from there; Enter (a click
      // without a pointer) opens it and moves the keyboard to the terminal. In the narrow drawer the rail closes instead.
      this.listEl.querySelectorAll<HTMLElement>('[data-session]').forEach(el => el.onclick = e => {
        const id = el.dataset.session!, stay = e.detail > 0 && !window.matchMedia('(max-width: 760px)').matches;
        this.activate(id, !stay);
        if (stay) this.listEl.querySelector<HTMLElement>(`button[data-session="${id}"]`)?.focus({ preventScroll: true });
      });
      this.listEl.querySelectorAll<HTMLElement>('[data-close]').forEach(el => el.onclick = () => void this.close(el.dataset.close!));
      this.listEl.querySelectorAll<HTMLElement>('[data-remove]').forEach(el => el.onclick = () => this.confirmCloseNode(Number(el.dataset.remove)));
      if (focusKey) {
        const rows = focusedAt < 0 ? [] : this.listEl.querySelectorAll<HTMLElement>('button[data-session]');
        (this.listEl.querySelector<HTMLElement>(focusKey) ?? rows[Math.min(focusedAt, rows.length - 1)])?.focus({ preventScroll: true });
      }
      this.markPreviewRow();
    }
    for (const row of this.listEl.querySelectorAll<HTMLElement>('.work-session[data-sid]')) {
      const info = this.tabs.get(row.dataset.sid!)!.info;
      const tone = sessionTone(info, now);
      if (tone !== (row.dataset.tone ?? null)) {
        if (tone) row.dataset.tone = tone; else delete row.dataset.tone;
      }
      const button = row.querySelector<HTMLButtonElement>('button[data-session]')!;
      const title = this.railSessionTitle(info, endpoints.has(info.id));
      if (button.title !== title) button.title = title;
      const flag = toneFlag(tone, info);
      let badge = button.querySelector('em');
      if (flag) {
        if (!badge) { badge = document.createElement('em'); badge.className = 'tone-flag'; button.append(badge); }
        if (badge.textContent !== flag) badge.textContent = flag;
      } else badge?.remove();
      this.renderDetail(row);
    }
    this.renderRailLinks();
    this.renderNodeMenu();
    document.getElementById('session-count')!.textContent = String(this.tabs.size);
    if (this.picker.open) this.renderPicker();
    this.sel.ids.forEach((id, i) => { const tab = this.tabs.get(id); if (tab) this.updateTileHead(tab, i); });
    for (const tab of this.tabs.values()) this.updateConnection(tab);
  }

  private patchRail(groups: WorkListItem[]): boolean { return reconcileWorkList(this.listEl, groups); }

  private saveCollapsed(): void {
    try { localStorage.setItem('vb:collapsed-nodes', JSON.stringify([...this.collapsedNodes])); } catch { /* unavailable */ }
  }

  private renderBody(): void {
    if (document.body.classList.contains('reordering')) return;
    this.tileDragCleanup?.(); this.tileDragCleanup = null;
    this.renderTabs();
    this.root.classList.toggle('show-tasks', this.sideOpen);
    const toolbar = this.control('#work-toolbar');
    toolbar?.classList.toggle('show-tasks', this.sideOpen);
    const terminalsOn = !this.sideOpen;
    this.control('#work-terminals')?.setAttribute('aria-pressed', String(terminalsOn));
    this.control('#work-terminals')?.classList.toggle('active', terminalsOn);
    const board = this.sideOpen && this.boardOpen, git = this.sideOpen && this.gitOpen && !this.boardOpen;
    if (board) this.ensureBoard();
    this.control('#work-board-view')!.classList.toggle('hidden', !board);
    this.control('#work-board')!.setAttribute('aria-pressed', String(board));
    this.control('#work-board')!.classList.toggle('active', board);
    this.updateBoard?.([...this.nodes.values()].filter((n): n is NodeDetail => n !== null), this.selectedNode, board && this.isOpen());
    this.control('#work-git-view')!.classList.toggle('hidden', !git);
    this.control('#work-git')!.setAttribute('aria-pressed', String(git));
    this.control('#work-git')!.classList.toggle('active', git);
    this.updateGit?.(this.selectedNode, git && this.isOpen());
    if (this.sideOpen) {
      this.bodyEl.classList.add('hidden'); this.syncChannel();
      return;
    }
    this.bodyEl.querySelector('.work-welcome')?.remove();
    this.bodyEl.classList.remove('hidden');
    for (const [id, on] of [['#work-single', !this.tiled], ['#work-grid', this.tiled]] as const) {
      const button = this.control(id)!;
      button.setAttribute('aria-pressed', String(on)); button.classList.toggle('active', on);
    }
    this.syncSel();
    const shown = this.tiled ? this.sel.ids.filter(id => this.tabs.has(id)) : this.active === null ? [] : [this.active];
    this.renderPager();
    this.bodyEl.classList.toggle('tiled', this.tiled && shown.length > 0);
    this.bodyEl.style.gridTemplateColumns = this.tiled && gridColumns(shown.length) === 1 ? 'minmax(0, 1fr)' : '';
    const twoColumns = this.tiled && gridColumns(shown.length) === 2;
    this.bodyEl.classList.toggle('two-rows', twoColumns && shown.length > 2);
    this.splitHandles.col.classList.toggle('hidden', !twoColumns);
    this.splitHandles.row.classList.toggle('hidden', !twoColumns || shown.length <= 2);
    // Panes are only hidden or shown, never remounted: the xterm, its WebSocket and the PTY behind it keep running.
    for (const [id, tab] of this.tabs) tab.pane?.classList.toggle('hidden', !shown.includes(id));
    shown.forEach((id, index) => {
      const tab = this.tabs.get(id)!;
      if (!tab.pane) this.mount(tab);
      tab.pane!.classList.remove('hidden');
      tab.pane!.classList.toggle('focused', id === this.active);
      tab.pane!.style.order = String(index);
      this.updateCard(tab);
      this.updateTileHead(tab, index);
      this.updateConnection(tab);
    });

    if (!shown.length) {
      const welcome = document.createElement('div'); welcome.className = 'work-welcome';
      const node = this.selectedNode !== null ? this.nodes.get(this.selectedNode) : null;
      welcome.innerHTML = ui`<div class="work-start"><h2>${esc(node?.name || tr('Operativa'))}</h2><button class="btn" data-start title="Avvia un agente o una squadra">+ Agente</button></div>`;
      welcome.querySelector('[data-start]')?.addEventListener('click', () => this.openLauncher(undefined, 'embedded', '', true));
      this.bodyEl.appendChild(welcome);

    }
    this.bindTileDrag(shown);
    this.syncChannel();
    requestAnimationFrame(() => this.fitVisible());
  }

  /** Page buttons of a node view with more than MAX_TILES terminals; during a composition, the way back to the node's own view. */
  private renderPager(): void {
    let html = '';
    if (this.tiled && this.composed) html = ui`<button class="btn small" data-node-view title="Torna ai terminali del nodo, quattro per pagina">Terminali del nodo</button>`;
    else if (this.tiled) {
      const total = this.nodeViewList().length, pages = pageCount(total), page = this.nodeView(this.selectedNode).page;
      if (pages > 1) html = ui`<button class="btn small" data-page="${page - 1}" ${page === 0 ? 'disabled' : ''} aria-label="Pagina precedente" title="Pagina precedente">‹</button><span class="tile-pager-label" role="status">${page + 1}/${pages}</span><button class="btn small" data-page="${page + 1}" ${page >= pages - 1 ? 'disabled' : ''} aria-label="Pagina successiva" title="Pagina successiva">›</button>`;
    }
    this.pager.classList.toggle('hidden', !html);
    if (this.pager.dataset.sig !== html) { this.pager.dataset.sig = html; this.pager.innerHTML = html; }
  }

  private mount(t: Tab): void {
    const pane = document.createElement('article'); pane.className = 'term-pane'; pane.dataset.session = t.info.id;
    pane.innerHTML = ui`<header class="session-head"><button class="work-tile-drag" data-move-tile aria-label="Sposta terminale" title="Trascina per riordinare · frecce per muovere">⠿</button><div class="session-heading"><span class="work-dot"></span><span class="tile-badge" aria-hidden="true"></span><strong class="session-label"></strong><span class="session-code"></span><span class="session-meta hidden"></span><span class="tile-node tile-node-slot"></span><span class="card-state"></span></div><span class="pane-peers"></span><button class="btn small session-resume hidden" data-resume title="Riavvia la sessione nella stessa cartella e riprendi la conversazione">Riprendi</button><div class="session-actions" role="group" aria-label="Comandi del terminale"><button class="btn ghost icon-btn" data-unview aria-label="Nascondi dalla vista" title="Il terminale resta attivo (Ctrl+Alt+W)">${icon('hide')}</button><button class="btn ghost icon-btn" data-rename aria-label="Rinomina sessione" title="Rinomina sessione">${icon('edit')}</button><button class="btn ghost icon-btn" data-context aria-expanded="false" aria-label="Mostra contesto" title="Mostra contesto">${icon('context')}</button><button class="btn ghost icon-btn" data-reconnect aria-label="Riconnetti" title="Riconnetti">${icon('refresh')}</button><button class="btn ghost icon-btn" data-end aria-label="Termina sessione" title="Termina sessione">${icon('close')}</button></div></header><div class="session-content"><aside class="session-context"></aside><div class="terminal-surface"></div></div>`;
    this.bodyEl.appendChild(pane); t.pane = pane;
    pane.addEventListener('focusin', () => {
      this.active = t.info.id;
      // A guest keeps the view of the node it is shown in.
      if (!(this.tiled && !this.composed && this.sel.ids.includes(t.info.id))) this.selectedNode = t.info.nodeId ?? null;
      if (this.tiled && this.sel.ids.includes(t.info.id)) this.sel = { ids: this.sel.ids, focus: t.info.id };
      for (const [id, tab] of this.tabs) tab.pane?.classList.toggle('focused', id === this.active);
      this.renderList();
    });
    const contextToggle = pane.querySelector('[data-context]')!;
    pane.classList.add('context-collapsed');
    contextToggle.addEventListener('click', () => {
      const collapsed = pane.classList.toggle('context-collapsed');
      contextToggle.setAttribute('aria-expanded', String(!collapsed));
      const text = collapsed ? tr('Mostra contesto') : tr('Nascondi contesto');
      contextToggle.setAttribute('title', text); contextToggle.setAttribute('aria-label', text);
      requestAnimationFrame(() => this.fitTab(t));
    });
    pane.querySelector('[data-unview]')!.addEventListener('click', () => this.removeView(t.info.id));
    pane.querySelector('[data-rename]')!.addEventListener('click', () => this.startRename(t));
    pane.querySelector('.session-label')!.addEventListener('dblclick', () => this.startRename(t));
    pane.querySelector('[data-end]')!.addEventListener('click', () => void this.close(t.info.id));
    pane.querySelector('[data-reconnect]')!.addEventListener('click', () => { this.connect(t); });
    pane.querySelector('[data-resume]')!.addEventListener('click', () => void this.resume(t));
    const surface = pane.querySelector<HTMLElement>('.terminal-surface')!;
    t.term = new Terminal({ fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono').trim(), fontSize: this.fontSize, lineHeight: 1.2, theme: this.theme(), minimumContrastRatio: 4.5, allowTransparency: true, scrollback: 5000 });
    t.fit = new FitAddon(); t.term.loadAddon(t.fit); t.term.open(surface);
    t.term.registerLinkProvider({ provideLinks: (y, done) => done(this.sessionLinks(t, y)) });
    t.term.attachCustomKeyEventHandler(e => !(this.tiled && tileKeyAction(e)));
    t.term.onData(data => {
      if (t.ws?.readyState === WebSocket.OPEN) t.ws.send(JSON.stringify({ type: 'input', data }));
      else if (t.ws?.readyState === WebSocket.CONNECTING) { if (!t.early) t.earlyAt = Date.now(); t.early = ((t.early ?? '') + data).slice(0, 4096); }
    });
    t.term.onResize(({ cols, rows }) => { if (t.ws?.readyState === WebSocket.OPEN) t.ws.send(JSON.stringify({ type: 'resize', cols, rows })); });
    t.observer = new ResizeObserver(() => { if (!pane.classList.contains('hidden') && this.isOpen()) this.fitTab(t); }); t.observer.observe(surface);
    if (t.info.nodeId != null) void this.renderContext(pane.querySelector('.session-context')!, t.info.nodeId);
    else pane.querySelector('.session-context')!.textContent = ui`Cartella di lavoro: ${short(t.info.cwd)}`;
    this.connect(t); // renderBody paints the header after showing the pane.
  }

  /** Session codes (OP3) and ids written in a terminal link to that session of the same node: a click opens it. */
  private sessionLinks(t: Tab, y: number): ILink[] | undefined {
    const text = t.term?.buffer.active.getLine(y - 1)?.translateToString(true);
    if (!text) return undefined;
    const sessions = [...this.tabs.values()].filter(s => s.info.nodeId === t.info.nodeId && s !== t);
    const links: ILink[] = [];
    for (const m of text.matchAll(new RegExp(`${CODE_IN_TEXT.source}|\\b[0-9a-f]{8}\\b`, 'g'))) {
      const target = sessions.find(s => s.info.code === m[0] || s.info.id === m[0]);
      if (!target) continue;
      links.push({
        range: { start: { x: m.index! + 1, y }, end: { x: m.index! + m[0].length, y } }, text: m[0],
        decorations: { underline: true, pointerCursor: true },
        activate: () => this.activate(target.info.id),
      });
    }
    return links.length ? links : undefined;
  }

  private connect(t: Tab): void {
    t.ws?.close(); t.term?.reset();
    const ws = new WebSocket(ui`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/term?id=${encodeURIComponent(t.info.id)}`);
    t.ws = ws; t.connected = false; t.early = '';
    ws.onopen = () => {
      if (t.ws !== ws) return;
      t.connected = true; this.updateCard(t); this.renderList(); this.fitTab(t);
      // fit may preserve the dimensions; always send them on a new connection.
      ws.send(JSON.stringify({ type: 'resize', cols: t.term!.cols, rows: t.term!.rows }));
      // Old keys never land by surprise: a connection that took longer than EARLY_KEYS_MS drops them.
      if (t.early && Date.now() - (t.earlyAt ?? 0) < EARLY_KEYS_MS) ws.send(JSON.stringify({ type: 'input', data: t.early }));
      t.early = '';
    };
    ws.onmessage = e => { if (t.ws === ws) t.term?.write(e.data); };
    ws.onclose = () => { if (t.ws !== ws || !this.tabs.has(t.info.id)) return; t.connected = false; t.early = ''; this.updateCard(t); this.renderList(); };
  }

  /** An ended Claude, Codex or shell session starts again under the same id; the server says why when it cannot. */
  private async resume(t: Tab): Promise<void> {
    const button = t.pane?.querySelector<HTMLButtonElement>('[data-resume]');
    if (button) button.disabled = true;
    try {
      const { info } = await api.resumeTerminal(t.info.id, { cols: t.term?.cols ?? 120, rows: t.term?.rows ?? 30 });
      t.info = info; this.message('');
      this.connect(t); this.updateCard(t); this.renderList(); this.renderTabs();
    } catch (err) { this.message(String(err)); } finally { if (button) button.disabled = false; }
  }

  private paneVisible(pane: HTMLElement): boolean {
    return this.isOpen() && !this.sideOpen && !pane.classList.contains('hidden');
  }

  private updateCard(t: Tab): void {
    if (!t.pane || !this.paneVisible(t.pane)) return;
    t.pane.querySelector('.card-state')!.textContent = !t.info.alive || t.info.workState || t.info.attention || t.connected ? toneReason(t.info) : tr('Disconnesso');
    const label = t.pane.querySelector('.session-label')!;
    label.setAttribute('title', [this.generatedName(t), toneReason(t.info), tr('Doppio clic per rinominare')].join(' · '));
    if (!label.querySelector('input')) label.textContent = t.info.name || this.roleName(t);
    t.pane.querySelector('.session-code')!.textContent = t.info.code ?? '';
    const meta = t.pane.querySelector<HTMLElement>('.session-meta');
    if (meta) { meta.textContent = this.generatedName(t); meta.title = this.generatedName(t); }
    t.pane.classList.toggle('ended', !t.info.alive);
    const tone = sessionTone(t.info);
    if (tone) t.pane.dataset.tone = tone; else delete t.pane.dataset.tone;
    t.pane.querySelector('.work-dot')?.setAttribute('title', toneReason(t.info));
    t.pane.querySelector('[data-reconnect]')!.classList.toggle('hidden', t.connected === true || !t.info.alive);
    t.pane.querySelector('[data-resume]')!.classList.toggle('hidden', t.info.alive || !resumable(t.info));
  }
  /** Drag a node row up or down to reorder the rail (see work-reorder.ts); Alt+↑/↓ on a node does the same from the keyboard. */
  private bindNodeDrag(): void {
    const rows = [...this.listEl.querySelectorAll<HTMLElement>('[data-drag]')];
    const ids = () => orderNodes([...new Set([...this.nodes.keys(), ...[...this.tabs.values()].map(t => t.info.nodeId).filter((id): id is number => id != null)])], this.nodeOrder, this.links, true).map(n => n.id!).filter(id => id !== null);
    const save = (order: number[]) => { this.nodeOrder = order; try { localStorage.setItem('vb:node-order', JSON.stringify(order)); } catch { /* storage unavailable */ } this.renderList(); };
    this.railDragCleanup.push(bindReorder({ rows, idOf: r => r.dataset.drag!, handleOf: r => r.querySelector('[data-node-grip]'), onMove: (id, before) => save(moveNode(ids(), Number(id), before === null ? null : Number(before))) }));
    // Sessions of one node can be reordered among themselves too (never across nodes).
    for (const group of this.listEl.querySelectorAll<HTMLElement>('.work-group')) {
      const items = [...group.querySelectorAll<HTMLElement>('.work-session[data-sid]')];
      if (items.length < 2) {
        const grip = items[0]?.querySelector<HTMLElement>('[data-session-grip]');
        if (grip) grip.onkeydown = null; // A retained row may have had a neighbour before filtering.
        continue;
      }
      const move = (id: string, before: string | null) => {
        const nodeId = group.dataset.drag ? Number(group.dataset.drag) : null;
        const infos = [...this.tabs.values()].filter(t => (t.info.nodeId ?? null) === nodeId).map(t => t.info.id);
        const list = orderTiles(infos, this.sessionOrder).filter(x => x !== id);
        const at = before === null ? list.length : list.indexOf(before);
        list.splice(at < 0 ? list.length : at, 0, id);
        this.sessionOrder = [...this.sessionOrder.filter(x => !list.includes(x)), ...list].slice(-500);
        try { localStorage.setItem('vb:session-order', JSON.stringify(this.sessionOrder)); } catch { /* unavailable */ }
        this.renderList();
      };
      this.railDragCleanup.push(bindReorder({ rows: items, idOf: r => r.dataset.sid!, handleOf: r => r.querySelector('[data-session-grip]'), onMove: move }));
      for (const item of items) item.querySelector<HTMLElement>('[data-session-grip]')!.onkeydown = e => {
        if (!e.altKey || !['ArrowUp', 'ArrowDown'].includes(e.key)) return;
        e.preventDefault();
        const list = items.map(r => r.dataset.sid!), id = item.dataset.sid!, at = list.indexOf(id), next = at + (e.key === 'ArrowUp' ? -1 : 1);
        if (next < 0 || next >= list.length) return;
        move(id, e.key === 'ArrowUp' ? list[next] : list[next + 1] ?? null);
      };
    }

    for (const row of rows) {
      const id = Number(row.dataset.drag);
      const moveKey = (e: KeyboardEvent) => {
        if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
        e.preventDefault();
        const list = rows.map(r => Number(r.dataset.drag)), at = list.indexOf(id), to = e.key === 'ArrowUp' ? at - 1 : at + 2;
        if (at + (e.key === 'ArrowUp' ? -1 : 1) < 0 || at + (e.key === 'ArrowUp' ? -1 : 1) >= list.length) return;
        save(moveNode(ids(), id, to >= list.length ? null : list[to]));
      };
      row.querySelector<HTMLElement>('.work-node')!.onkeydown = moveKey;
      row.querySelector<HTMLElement>('[data-node-grip]')!.onkeydown = moveKey;
    }
  }

  private moveTerminal(id: string, before: string | null): void {
    const moved = moveTile(this.sel, id, before);
    const all = this.composed ? this.sel.ids : this.nodeViewList();
    let slot = 0;
    const ordered = all.map(x => moved.ids.includes(x) ? moved.ids[slot++] : x);
    this.tileOrder = [...this.tileOrder.filter(x => !ordered.includes(x)), ...ordered].slice(-500);
    try { localStorage.setItem('vb:tile-order', JSON.stringify(this.tileOrder)); } catch { /* unavailable */ }
    this.sel = moved; this.renderBody(); this.renderList();
  }

  private bindTileDrag(shown: string[]): void {
    if (!this.tiled || shown.length < 2) return;
    const rows = shown.map(id => this.tabs.get(id)!.pane!);
    this.tileDragCleanup = bindReorder({ rows, idOf: row => row.dataset.session!, layout: 'grid',
      handleOf: row => row.querySelector('[data-move-tile]'), onMove: (id, before) => this.moveTerminal(id, before) });
    for (const row of rows) row.querySelector<HTMLElement>('[data-move-tile]')!.onkeydown = e => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key) || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      const id = row.dataset.session!, at = shown.indexOf(id);
      const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' ? -gridColumns(shown.length) : gridColumns(shown.length);
      const to = at + step;
      if (to < 0 || to >= shown.length) return;
      this.moveTerminal(id, step < 0 ? shown[to] : shown[to + 1] ?? null);
      this.tabs.get(id)?.pane?.querySelector<HTMLElement>('[data-move-tile]')?.focus();
    };
  }

  /** Generated label (agent, model, effort), used when the user has not named the session. */
  private generatedName(t: Tab): string {
    return ui`${this.agentLabel(t)}${t.info.model ? ' · ' + t.info.model : ''}${t.info.effort ? ' / ' + t.info.effort : ''}${t.info.branch ? ' · ⑂ ' + t.info.branch : ''}`;
  }
  private sessionLabel(t: Tab): string {
    return ui`${t.info.role ? this.roleName(t) + ' · ' : ''}${t.info.name || this.generatedName(t)}`;
  }
  private linkSide(t: Tab): LinkSide { return { id: t.info.id, nodeId: t.info.nodeId ?? null, role: t.info.role, alive: t.info.alive }; }

  /** Inline rename of a session: Enter or leaving the field saves, Escape cancels, an empty name restores the generated label. */
  private startRename(t: Tab): void {
    const pane = t.pane; if (!pane) return;
    pane.querySelector('details')?.removeAttribute('open');
    const label = pane.querySelector<HTMLElement>('.session-label')!;
    if (label.querySelector('input')) return;
    const input = document.createElement('input');
    input.className = 'session-rename'; input.maxLength = 60; input.value = t.info.name ?? '';
    input.placeholder = this.generatedName(t); input.setAttribute('aria-label', tr('Nome della sessione'));
    // with tabs the heading hides the name (the tab shows it): while renaming the field takes the tabs' place
    pane.classList.add('renaming');
    label.textContent = ''; label.appendChild(input); input.focus(); input.select();
    let done = false;
    const finish = async (save: boolean) => {
      if (done) return; done = true;
      const name = input.value.trim();
      input.remove(); pane.classList.remove('renaming'); this.updateCard(t);
      if (!save || name === (t.info.name ?? '')) return;
      try { t.info = await api.renameTerminal(t.info.id, name); this.message(''); } catch (err) { this.message(String(err)); }
      this.updateCard(t); this.renderList(); this.syncChannel();
    };
    input.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') void finish(true); else if (e.key === 'Escape') void finish(false); });
    input.addEventListener('blur', () => void finish(true));
  }

  /** A node link addresses its orchestrator; a session link keeps the selected operator endpoint. */
  private railLinkOptions(): { key: string; side: LinkSide; label: string }[] {
    return [
      ...[...this.nodes].map(([id, node]) => ({ key: `node:${id}`, side: { id: '', nodeId: id, role: 'orchestrator' as const, alive: true }, label: node?.name || this.nodeLabel(id) })),
      ...[...this.tabs.values()].filter(t => t.info.alive && t.info.role && t.info.role !== 'orchestrator').map(t => ({ key: `session:${t.info.id}`, side: this.linkSide(t), label: `${this.nodeLabel(t.info.nodeId ?? null)} · ${this.sessionLabel(t)}` })),
      ...[...this.tabs.values()].filter(t => t.info.alive && t.info.role === 'orchestrator').map(t => ({ key: `session:${t.info.id}`, side: this.linkSide(t), label: `${this.nodeLabel(t.info.nodeId ?? null)} · ${this.sessionLabel(t)}` })),
    ];
  }
  private toggleRailLinks(key: string | null): void {
    if (this.railLinkBusy) return;
    this.railLinkSource = this.railLinkSource === key ? null : key;
    this.renderList();
    this.control<HTMLElement>('#work-rail-links')?.querySelector<HTMLButtonElement>('button')?.focus();
  }
  private renderRailLinks(): void {
    const box = this.control<HTMLElement>('#work-rail-links'); if (!box) return;
    if (!this.railLinkSource && box.dataset.sig === undefined) return;
    const options = this.railLinkOptions(), source = options.find(o => o.key === this.railLinkSource);
    box.classList.toggle('hidden', !source);
    if (!source) {
      this.railLinkSource = null;
      if (box.dataset.sig !== undefined) { box.innerHTML = ''; delete box.dataset.sig; }
      return;
    }
    const candidates = options.filter(o => o.side.nodeId != null && o.side.nodeId !== source.side.nodeId && (o.key.startsWith('node:') || o.side.role !== 'orchestrator'));
    const html = ui`<header><strong>Collega ${esc(source.label)}</strong><button class="btn ghost icon-btn" data-dismiss-links aria-label="Chiudi collegamenti" title="Chiudi collegamenti">${icon('close')}</button></header><p>I nodi collegati possono scambiarsi messaggi.</p>${candidates.length ? candidates.map(o => {
      const link = linkBetween(this.links, source.side, o.side);
      return ui`<button class="work-rail-link-choice" data-link-with="${o.key}" aria-pressed="${!!link}" ${this.railLinkBusy ? 'disabled' : ''}><span>${esc(o.label)}</span><small>${link ? tr('Scollega') : tr('Collega')}</small></button>`;
    }).join('') : tr('<p>Aggiungi un altro nodo per collegarlo.</p>')}`;
    if (box.dataset.sig === html) return;
    box.innerHTML = html; box.dataset.sig = html;
    box.querySelector<HTMLButtonElement>('[data-dismiss-links]')!.onclick = () => this.toggleRailLinks(null);
    box.onkeydown = event => { if (event.key === 'Escape') { event.preventDefault(); const key = this.railLinkSource!; this.toggleRailLinks(null); this.listEl.querySelector<HTMLButtonElement>(key.startsWith('node:') ? `[data-node-link="${key.slice(5)}"]` : `[data-session-link="${key.slice(8)}"]`)?.focus(); } };
    box.querySelectorAll<HTMLButtonElement>('[data-link-with]').forEach(b => b.onclick = () => void this.toggleRailLinkWith(b.dataset.linkWith!));
  }
  private async toggleRailLinkWith(key: string): Promise<void> {
    if (this.railLinkBusy) return;
    const options = this.railLinkOptions(), a = options.find(o => o.key === this.railLinkSource), b = options.find(o => o.key === key);
    if (!a || !b) return;
    const request = linkRequest(a.side, b.side); if (!request) return;
    this.railLinkBusy = true; this.renderRailLinks();
    try {
      const link = linkBetween(this.links, a.side, b.side);
      if (link) await api.unlinkTeams(link.id); else await api.linkTeams(request);
      this.message(''); await this.refreshLinks();
    } catch (err) { this.message(String(err)); }
    finally { this.railLinkBusy = false; this.renderRailLinks(); this.control<HTMLElement>('#work-rail-links')?.querySelector<HTMLButtonElement>(`[data-link-with="${key}"]`)?.focus(); }
  }
  /** Tile number + shape (readable without colour) and the node the session belongs to, since a grid can mix nodes. */
  private updateTileHead(t: Tab, index: number): void {
    if (!t.pane || !this.paneVisible(t.pane)) return;
    const marker = tileMarker(index);
    const badge = t.pane.querySelector<HTMLElement>('.tile-badge')!;
    badge.textContent = String(marker.number); badge.title = ui`Terminale ${marker.number} (Ctrl+Alt+${marker.number})`;
    const node = t.pane.querySelector<HTMLElement>('.tile-node')!;
    node.textContent = this.nodeLabel(t.info.nodeId ?? null); node.title = node.textContent;
    t.pane.dataset.tile = String(marker.number);
  }
  /** Pushes links, sessions and the visible tiles to the channel board; it is only shown with a terminal view open. */
  private syncChannel(refresh = false): void {
    const show = this.isOpen() && !this.sideOpen;
    this.syncSel();
    this.channelEl.classList.toggle('hidden', !show);
    if (!this.channel) return;
    // Nothing visible (overview, Operativa closed) means no board reads in the background.
    const visible = !show ? [] : this.tiled ? this.sel.ids.filter(id => this.tabs.has(id)) : this.active ? [this.active] : [];
    this.channel.update(this.links, [...this.tabs.values()].map(t => ({ ...t.info })), visible);
    if (refresh && show) void this.channel.refresh().catch(err => this.message(String(err)));
  }

  /** Same tone as the map and the rail for a linked node, the real endpoints marked, and one button per live direct peer. */
  private updateConnection(t: Tab): void {
    const pane = t.pane; if (!pane || !this.paneVisible(pane)) return;
    const infos = [...this.tabs.values()].map(x => ({ id: x.info.id, nodeId: x.info.nodeId, alive: x.info.alive, createdAt: x.info.createdAt, role: x.info.role }));
    const group = t.info.nodeId != null ? connectionGroups(this.links).get(t.info.nodeId) : undefined;
    if (group) pane.dataset.connectionTone = String(group.tone); else delete pane.dataset.connectionTone;
    const kind = connectionEndpoints(this.links, infos).get(t.info.id);
    if (kind) pane.dataset.connectionEndpoint = kind; else delete pane.dataset.connectionEndpoint;
    const peers = t.info.alive ? directPeers(t.info.id, this.links, infos).filter(id => this.tabs.has(id)) : [];
    const box = pane.querySelector<HTMLElement>('.pane-peers')!;
    const html = peers.map(id => {
      const peer = this.tabs.get(id)!;
      const text = peer.info.role === 'orchestrator' ? tr('Affianca orchestratore') : ui`Affianca ${this.sessionLabel(peer)}`;
      return ui`<button class="btn small" data-pair="${id}" title="Mostra solo queste due sessioni collegate, una accanto all’altra">${esc(text)} · ${esc(this.nodeLabel(peer.info.nodeId ?? null))}</button>`;
    }).join('');
    if (box.dataset.sig === html) return;
    box.dataset.sig = html; box.innerHTML = html;
    box.querySelectorAll<HTMLElement>('[data-pair]').forEach(b => b.onclick = () => this.pairWith(t.info.id, b.dataset.pair!));
  }

  /** Exactly two sessions side by side. Nothing is remounted: both panes keep their xterm, WebSocket and PTY. */
  private pairWith(id: string, peer: string): void {
    const a = this.tabs.get(id), b = this.tabs.get(peer);
    if (!a || !b) return;
    this.sel = pairTiles(id, peer);
    this.composed = true; this.tiled = true;
    this.active = id; this.selectedNode = a.info.nodeId ?? null;
    this.show(true); this.renderList(); this.renderBody();
    requestAnimationFrame(() => { if (this.active === id) a.term?.focus(); });
  }

  /** ⌘+ / ⌘− / ⌘0 while the terminals are on screen: the text of all terminals, never the page. */
  private zoomKey(e: KeyboardEvent): void {
    if (!this.isOpen() || this.sideOpen || (e.target instanceof HTMLElement && e.target.closest('#overlay'))) return;
    const step = fontZoomKey(e);
    if (step === null) return;
    e.preventDefault(); e.stopPropagation();
    this.zoom(step);
  }
  zoom(step: 1 | -1 | 0): void {
    this.fontSize = zoomFont(this.fontSize, step);
    try { localStorage.setItem('vb:term-font', String(this.fontSize)); } catch { /* storage unavailable */ }
    for (const t of this.tabs.values()) if (t.term) t.term.options.fontSize = this.fontSize;
    this.fitVisible();
  }

  /** A divider between tiled terminals: drag it to give a column or row more room, double-click to even them out. */
  private splitHandle(axis: 'col' | 'row'): HTMLElement {
    const handle = document.createElement('div');
    handle.className = 'tile-split hidden'; handle.dataset.axis = axis;
    handle.setAttribute('role', 'separator'); handle.setAttribute('aria-orientation', axis === 'col' ? 'vertical' : 'horizontal');
    handle.title = tr('Trascina per ridimensionare · doppio clic per ripristinare');
    handle.addEventListener('pointerdown', e => {
      e.preventDefault(); handle.setPointerCapture(e.pointerId); handle.classList.add('dragging');
      const move = (m: PointerEvent) => {
        const r = this.bodyEl.getBoundingClientRect();
        this.split[axis] = clampSplit(axis === 'col' ? (m.clientX - r.left) / r.width : (m.clientY - r.top) / r.height);
        this.applySplit();
      };
      const end = () => {
        handle.classList.remove('dragging');
        handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', end); handle.removeEventListener('pointercancel', end);
        this.saveSplit();
      };
      handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end);
    });
    handle.addEventListener('dblclick', () => { this.split[axis] = 0.5; this.applySplit(); this.saveSplit(); });
    this.bodyEl.appendChild(handle);
    return handle;
  }
  private applySplit(): void {
    const { col, row } = this.split, style = this.bodyEl.style;
    style.setProperty('--col-a', `${col}fr`); style.setProperty('--col-b', `${1 - col}fr`); style.setProperty('--split-col', `${col * 100}%`);
    style.setProperty('--row-a', `${row}fr`); style.setProperty('--row-b', `${1 - row}fr`); style.setProperty('--split-row', `${row * 100}%`);
  }
  private saveSplit(): void { try { localStorage.setItem('vb:tile-split', JSON.stringify(this.split)); } catch { /* storage unavailable */ } }

  private fitTab(t: Tab): void { try { t.fit?.fit(); } catch { /* layout not ready */ } }
  private fitVisible(): void {
    if (!this.isOpen()) return;
    for (const t of this.tabs.values()) if (t.pane && !t.pane.classList.contains('hidden')) this.fitTab(t);
  }

  private async renderContext(el: HTMLElement, nodeId: number, browsingId = nodeId): Promise<void> {
    el.innerHTML = tr('<div class="work-context-section muted">Caricamento del nodo…</div>');
    try {
      const d = browsingId === nodeId ? await this.loadNode(nodeId) : await api.node(browsingId);
      if (!d) throw new Error(tr('Nodo non disponibile nell’indice'));
      if (!el.isConnected) return;
      el.innerHTML = ui`<div class="work-context-section"><div class="work-eyebrow">${browsingId === nodeId ? tr('Nodo della sessione') : tr('Esplora contenuto')}</div><h3>${esc(d.name)}</h3><div class="mono work-path">${esc(short(d.path))}</div><div class="chips"><span class="chip">${esc(d.cls)}</span><span class="chip">${fmtBytes(d.bytes)}</span></div>${d.summary || d.project?.description ? ui`<p>${esc(d.summary || d.project!.description!)}</p>` : ''}<div class="actions"><button class="btn small" data-brain>Nel Brain ↗</button><button class="btn small ghost" data-finder>Finder</button>${browsingId !== nodeId ? tr('<button class="btn small" data-back>↩ Nodo</button>') : ''}</div></div><div class="work-context-section"><div class="work-eyebrow">Contenuto · ${d.childCount}</div><div class="work-files"></div>${d.childCount > d.children.length ? tr('<button class="btn small" data-load>Carica altri</button>') : ''}${d.kind === 'file' ? tr('<button class="btn small" data-file>Apri file</button>') : ''}</div><div class="work-context-section"><div class="work-eyebrow">Collegamenti · ${d.edges.filter(e => !e.hidden).length}</div>${d.edges.filter(e => !e.hidden).slice(0, 8).map(e => { const other = e.src === d.id ? e.dst : e.src; const n = d.neighbors.find(n => n.id === other); return ui`<button class="work-related" data-related="${other}">${e.src === d.id ? '→' : '←'} ${esc(n?.name ?? String(other))}<small>${esc(e.kind)}${e.verified ? '' : tr(' · ipotesi')}</small></button>`; }).join('') || tr('<span class="muted">Nessun collegamento</span>')}</div>`;
      el.querySelector('[data-brain]')!.addEventListener('click', () => { this.show(false); this.cb.reveal(d.id); });
      el.querySelector('[data-finder]')!.addEventListener('click', () => void api.open(d.id, 'finder').catch(e => this.message(String(e))));
      el.querySelector('[data-back]')?.addEventListener('click', () => void this.renderContext(el, nodeId));
      el.querySelector('[data-file]')?.addEventListener('click', () => void api.open(d.id, 'default').catch(e => this.message(String(e))));
      el.querySelectorAll<HTMLElement>('[data-related]').forEach(b => b.onclick = () => void this.addNode(Number(b.dataset.related)));
      const filesEl = el.querySelector<HTMLElement>('.work-files')!;
      const appendFiles = (children: NodeDetail['children']) => {
        for (const c of children) {
          const b = document.createElement('button'); b.className = 'work-file'; b.title = c.path;
          b.textContent = ui`${c.kind === 'dir' ? '▸ ' : '· '}${c.name}${c.kind === 'dir' ? '/' : ''}`;
          b.onclick = () => c.kind === 'dir' ? void this.renderContext(el, nodeId, c.id) : void api.open(c.id, 'default').catch(e => this.message(String(e)));
          filesEl.appendChild(b);
        }
      };
      appendFiles(d.children);
      let offset = d.children.length;
      const load = el.querySelector<HTMLButtonElement>('[data-load]');
      if (load) load.onclick = async () => {
        load.disabled = true;
        try { const page = await api.children(d.id, 100, offset); appendFiles(page.children); offset += page.children.length; load.hidden = offset >= page.total; }
        catch (err) { this.message(String(err)); } finally { load.disabled = false; }
      };
    } catch (err) { if (el.isConnected) el.textContent = String(err); }
  }

  private message(text: string): void { this.control('#work-message')!.textContent = text; }

  private openLauncher(initialAgent?: TerminalInfo['agent'], mode: 'embedded' | 'external' = 'embedded', initialPrompt = '', squad = false, nodeId = this.selectedNode, extra: { teamId?: string; proposal?: SwarmProposal; role?: AgentRole; initialModel?: string; initialEffort?: string } = {}): void {
    if (nodeId === null) { this.cb.pickNode(); return; }
    const node = this.nodes.get(nodeId);
    if (!node) { this.message(tr('Nodo non disponibile.')); return; }
    this.dismissLauncher?.();
    this.dismissLauncher = openWorkLauncher({
      node, agents: this.cb.agents(), sessions: [...this.tabs.values()].filter(t => t.info.nodeId === node.id).map(t => t.info),
      squad, initialAgent, mode, prompt: extra.proposal?.objective ?? initialPrompt, teamId: extra.teamId, proposal: extra.proposal, initialRole: extra.role,
      initialModel: extra.initialModel, initialEffort: extra.initialEffort,
      dismissed: () => { this.dismissLauncher = null; },
      launched: (sessions, group, external, warning) => {
        for (const info of sessions) this.attach(info, false);
        this.message(warning ?? (external ? tr('Sessione avviata in Terminal.app.') : ''));
        if (this.boardOpen && this.sideOpen && extra.initialModel === undefined) { this.renderList(); this.renderBody(); return; }
        // Started from the terminals: stay there (the orchestrator is shown), only the map goes back to the map.
        if (sessions[0]) this.activate(sessions[0].id);
      },
    });
  }

  /** The toolbar's node menu names the node it acts on, and says what closing it stops. */
  private renderNodeMenu(): void {
    const id = this.selectedNode, node = id !== null ? this.nodes.get(id) : null;
    const sessions = id !== null ? [...this.tabs.values()].filter(t => t.info.nodeId === id).length : 0;
    this.control('#work-node-title')!.textContent = node?.name ?? (id !== null ? ui`Nodo #${id}` : tr('Nodo'));
    this.control<HTMLButtonElement>('#work-close-node')!.disabled = id === null;
    this.control('#work-close-node-hint')!.textContent = !sessions ? tr('lo toglie dalla vista Operativa') : sessions === 1 ? tr('termina la sua sessione e lo toglie dalla vista') : ui`termina le sue ${sessions} sessioni e lo toglie dalla vista`;
  }

  /** Closing a node stops every session in it: they are listed and the user confirms. A node without sessions goes at once. */
  private confirmCloseNode(id: number): void {
    const sessions = [...this.tabs.values()].filter(t => t.info.nodeId === id);
    if (!sessions.length) { void this.closeNode(id); return; }
    const name = this.nodes.get(id)?.name ?? ui`Nodo #${id}`;
    const live = sessions.filter(t => t.info.alive).length;
    const overlay = document.getElementById('overlay')!;
    overlay.dataset.mode = 'work-close-node';
    overlay.innerHTML = ui`<div class="dialog close-node-dialog" role="alertdialog" aria-modal="true" aria-labelledby="close-node-title" aria-describedby="close-node-text"><div class="dhead"><span id="close-node-title">Chiudere ${esc(name)}?</span></div><div class="dbody"><p id="close-node-text">${!live ? tr('Le sessioni del nodo sono già terminate: vengono tolte.') : live === 1 ? tr('1 sessione in esecuzione verrà terminata: il processo si ferma e quello che non è salvato nel terminale va perso.') : ui`${live} sessioni in esecuzione verranno terminate: i processi si fermano e quello che non è salvato nei terminali va perso.`} ${tr('Il nodo esce dalla vista Operativa; i file non vengono toccati.')}</p><ul>${sessions.map(t => `<li>${esc(this.sessionLabel(t))}${t.info.alive ? '' : ' · ' + tr('terminata')}</li>`).join('')}</ul></div><div class="dfoot"><button class="btn" data-cancel>Annulla</button><button class="btn danger" data-confirm>${sessions.length === 1 ? tr('Chiudi nodo e sessione') : ui`Chiudi nodo e ${sessions.length} sessioni`}</button></div></div>`;
    overlay.classList.remove('hidden');
    const close = () => { overlay.classList.add('hidden'); overlay.innerHTML = ''; delete overlay.dataset.mode; this.dismissLauncher = null; };
    this.dismissLauncher = close;
    overlay.querySelector('[data-cancel]')!.addEventListener('click', close);
    overlay.querySelector('[data-confirm]')!.addEventListener('click', () => { close(); void this.closeNode(id); });
    overlay.onmousedown = e => { if (e.target === overlay) close(); };
    overlay.querySelector<HTMLElement>('[data-cancel]')!.focus();
  }

  private async closeNode(id: number): Promise<void> {
    await Promise.all([...this.tabs.values()].filter(t => t.info.nodeId === id).map(t => this.close(t.info.id)));
    if ([...this.tabs.values()].some(t => t.info.nodeId === id)) return;   // a session would not stop: the node stays with it, the error is shown
    this.nodes.delete(id); this.saveNodes();
    if (this.selectedNode === id) { this.selectedNode = null; this.active = null; }
    this.renderList(); this.renderBody();
  }

  /** The squads' board of the selected node (a squad, or the Main Brain with "brain"). */
  async showStatsBoard(nodeId: number, team: string): Promise<void> {
    if (!await this.loadNode(nodeId)) { this.message(tr('Nodo non disponibile.')); return; }
    this.selectedNode = nodeId; this.show(true); this.openBoard(team);
  }

  private openBoard(team?: string): void {
    this.sideOpen = true; this.boardOpen = true; this.gitOpen = false;
    this.selectedNode ??= this.tabs.get(this.active || '')?.info.nodeId ?? [...this.nodes.keys()][0] ?? null;
    this.ensureBoard()([...this.nodes.values()].filter((n): n is NodeDetail => n !== null), this.selectedNode, this.isOpen(), team);
    this.renderList(); this.renderBody();
  }

  private ensureBoard(): BoardUpdate {
    return this.updateBoard ??= mountWorkBoard(this.control('#work-board-view')!, {
      open: id => { this.sideOpen = false; this.boardOpen = false; this.activate(id); },
      launch: (nodeId, o) => this.openLauncher(undefined, 'embedded', '', o.squad, nodeId, { teamId: o.teamId, proposal: o.proposal, role: o.role }),
      reveal: id => { this.show(false); this.cb.reveal(id); },
      linksChanged: () => void this.refreshLinks(),
    });
  }

  /** Links between nodes and sessions: the rail marks them, the channel shows their messages. */
  private async refreshLinks(): Promise<void> {
    let next: TeamLink[];
    try { next = await api.teamLinks(); } catch (err) { this.message(String(err)); return; }
    // Polled every 4 s: redraw only when a link appeared, changed or went away.
    if (JSON.stringify(next) === JSON.stringify(this.links)) return;
    this.links = next;
    this.cb.linksChanged?.(next);
    this.renderList();
    if (this.isOpen() && !this.sideOpen) this.renderBody(); else this.syncChannel();
  }

  /** A plain shell with one click: in the node's folder, or free (no node) in the home folder. */
  private async openShell(nodeId: number | null): Promise<void> {
    try {
      const { info } = await api.shell(nodeId !== null && this.nodes.has(nodeId) ? nodeId : null);
      this.sideOpen = false; this.boardOpen = false; this.gitOpen = false;
      this.message('');
      this.attach(info);
    } catch (err) { this.message(String(err)); }
  }
}
