import { t as tr } from './i18n.ts';
// UI state: visible graph, selection, filters, pins. Small event emitter, no framework.
import type { Area, GraphEdge, GraphNode, GraphPayload, ProjectInfo, StatusPayload, TeamLink, TerminalInfo } from '../shared/types.ts';

export type Ev = 'graph' | 'select' | 'hover' | 'status' | 'filters' | 'expanded' | 'pins' | 'extra';
export type EdgeMode = 'focus' | 'all' | 'none' | 'off';
export interface Filters { kinds: Set<string>; inferred: boolean; min: number; edgeMode: EdgeMode; symlinks: boolean; externals: boolean; compact: boolean }

export const EDGE_KIND_LABELS: Record<string, string> = {
  imports: 'import', links: 'link', refpath: tr('percorso'), mention: tr('citazione'), symlink: tr('collegamento simbolico'), duplicate: tr('copia identica'), derived: tr('derivato'),
  shared_id: tr('id condiviso'), similar: tr('simile'), semantic: tr('semantica (AI)'), manual: tr('manuale'), uses: tr('usa'), policy: tr('regola'), external: tr('esterno'),
};
export const ALL_EDGE_KINDS = Object.keys(EDGE_KIND_LABELS);
export const UNDIRECTED = new Set(['duplicate', 'shared_id', 'similar']);
export const STATUS_LABELS: Record<string, string> = { data: tr('dati'), copy: tr('copia'), archive: tr('archivio') };

export function shortPath(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, '~');
}

export class Store {
  sessions = new Map<string, TerminalInfo>();
  sessionIds = new Map<string, number>();
  sessionsExpanded = new Set<number>();
  sessionLinks: TeamLink[] = [];
  activeSession: string | null = null;
  nodes = new Map<number, GraphNode>();
  edges: GraphEdge[] = [];
  areas: Area[] = [];
  /** Projects by node id. */
  projects = new Map<number, ProjectInfo>();
  /** Nodes drawn as boxes of their area; the others sit inside their parent box. */
  topLevel = new Set<number>();
  expanded = new Set<number>();
  /** Nodes forced into the view (revealed by a search) although nothing visible contains them. */
  extra = new Set<number>();
  selected: number | null = null;
  hovered: number | null = null;
  status: StatusPayload | null = null;
  filters: Filters = { kinds: new Set(ALL_EDGE_KINDS), inferred: true, min: 0.25, edgeMode: 'focus', symlinks: false, externals: false, compact: false };
  /** Manual positions: `n<nodeId>` for boxes, `g<groupId>` for groups. */
  pins = new Map<string, { x: number; y: number }>();
  private listeners = new Map<Ev, Set<() => void>>();

  constructor() {
    try {
      const exp = JSON.parse(localStorage.getItem('vb:expanded') ?? '[]') as number[];
      for (const id of exp) this.expanded.add(id);
      for (const id of JSON.parse(localStorage.getItem('vb:sessions-expanded') ?? '[]') as number[]) if (Number.isInteger(id) && id > 0) this.sessionsExpanded.add(id);
      const f = JSON.parse(localStorage.getItem('vb:filters2') ?? 'null') as Partial<{ kinds: string[]; inferred: boolean; min: number; edgeMode: EdgeMode; symlinks: boolean; externals: boolean; compact: boolean }> | null;
      if (f) this.filters = { kinds: new Set(f.kinds ?? ALL_EDGE_KINDS), inferred: f.inferred ?? true, min: f.min ?? 0.25, edgeMode: f.edgeMode ?? 'focus', symlinks: f.symlinks ?? false, externals: f.externals ?? false, compact: f.compact ?? false };
      const pins = JSON.parse(localStorage.getItem('vb:pins2') ?? '{}') as Record<string, { x: number; y: number }>;
      for (const [k, v] of Object.entries(pins)) if (v && Number.isFinite(v.x) && Number.isFinite(v.y)) this.pins.set(k, v);
    } catch { /* storage unavailable */ }
  }

  setSessions(sessions: TerminalInfo[], active: string | null): boolean {
    const changed = JSON.stringify([...this.sessions.values()]) !== JSON.stringify(sessions);
    this.sessions = new Map(sessions.map(s => [s.id, s]));
    for (const s of sessions) if (!this.sessionIds.has(s.id)) this.sessionIds.set(s.id, -2_000_000_000 - this.sessionIds.size);
    this.activeSession = active;
    return changed;
  }
  toggleSessions(id: number): void {
    if (this.sessionsExpanded.has(id)) this.sessionsExpanded.delete(id); else this.sessionsExpanded.add(id);
    this.save('vb:sessions-expanded', [...this.sessionsExpanded]);
  }
  graphSession(id: number): TerminalInfo | undefined {
    const entry = [...this.sessionIds].find(([, nodeId]) => nodeId === id);
    return entry ? this.sessions.get(entry[0]) : undefined;
  }

  on(ev: Ev, fn: () => void): () => void {
    let s = this.listeners.get(ev);
    if (!s) { s = new Set(); this.listeners.set(ev, s); }
    s.add(fn);
    return () => s!.delete(fn);
  }

  emit(ev: Ev): void {
    for (const fn of this.listeners.get(ev) ?? []) fn();
  }

  private save(key: string, value: unknown): void {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
  }

  setGraph(g: GraphPayload): void {
    // Hydration can finish between the first status and graph requests, before the events socket exists.
    if (this.status && JSON.stringify(this.status.stats) !== JSON.stringify(g.stats)) {
      this.status = { ...this.status, stats: g.stats };
      this.emit('status');
    }
    this.nodes = new Map(g.nodes.map((n) => [n.id, n]));
    this.edges = g.edges;
    this.areas = g.areas;
    this.topLevel = new Set(g.topLevel);
    this.projects = new Map(g.projects.map((p) => [p.nodeId, p]));
    if (this.selected !== null && !this.nodes.has(this.selected)) this.selected = null;
    if (this.hovered !== null && !this.nodes.has(this.hovered)) this.hovered = null;
    this.emit('graph');
  }

  roots(): string[] { return this.status?.stats.roots ?? []; }

  /** Path relative to its root (`work/engines/engine-python`), or the short path when outside the roots. */
  relPath(path: string): string {
    for (const r of this.roots()) if (path.startsWith(r + '/')) return path.slice(r.length + 1);
    return shortPath(path);
  }

  select(id: number | null): void {
    if (this.selected === id) return;
    this.selected = id;
    this.emit('select');
  }

  hover(id: number | null): void {
    if (this.hovered === id) return;
    this.hovered = id;
    this.emit('hover');
  }

  toggleExpanded(id: number): boolean {
    const open = !this.expanded.has(id);
    if (open) this.expanded.add(id); else this.expanded.delete(id);
    this.save('vb:expanded', [...this.expanded]);
    this.emit('expanded');
    return open;
  }

  expandMany(ids: number[]): void {
    for (const id of ids) this.expanded.add(id);
    this.save('vb:expanded', [...this.expanded]);
    this.emit('expanded');
  }

  collapseAll(): void {
    this.expanded.clear();
    this.extra.clear();
    this.save('vb:expanded', []);
    this.emit('expanded');
  }

  setFilters(f: Partial<Filters>): void {
    this.filters = { ...this.filters, ...f };
    this.save('vb:filters2', { ...this.filters, kinds: [...this.filters.kinds] });
    this.emit('filters');
  }

  /** Edge kinds sent to the server: the selected kinds, minus the inferred ones when hidden. */
  activeKinds(): string[] | null {
    const kinds = [...this.filters.kinds].filter((k) => this.filters.inferred || (k !== 'similar' && k !== 'semantic'));
    return kinds.length === ALL_EDGE_KINDS.length ? null : kinds;
  }

  neighborsOf(id: number): Set<number> {
    const s = new Set<number>();
    for (const e of this.edges) {
      if (e.src === id) s.add(e.dst);
      else if (e.dst === id) s.add(e.src);
    }
    return s;
  }

  pin(key: string, x: number, y: number): void {
    this.pins.set(key, { x, y });
    this.save('vb:pins2', Object.fromEntries(this.pins));
    this.emit('pins');
  }

  clearPins(): void {
    if (!this.pins.size) return;
    this.pins.clear();
    this.save('vb:pins2', {});
    this.emit('pins');
  }

  addExtra(id: number): void {
    if (this.extra.has(id)) return;
    this.extra.add(id);
    this.emit('extra');
  }
}
