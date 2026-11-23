// How each person likes the Lavoro board: columns or list, comfortable or compact cards, hidden columns, filters and
// the list's order. Kept per node in this browser (vb:board:<node>): a preference of whoever looks, not of the squad.
// The columns a squad adds are not here: they are the squad's (policy.columns on the server), shared by everyone.
import type { BoardColumn, TeamTask } from '../shared/types.ts';
import type { Column } from './work-tasks.ts';

export type Priority = 'high' | 'normal' | 'low';
export type ListKey = 'title' | 'status' | 'priority' | 'owner' | 'updated';
export interface BoardFilter { agent?: string; label?: string; priority?: Priority; mine?: boolean }
export interface BoardPrefs {
  view: 'columns' | 'list';
  density: 'comfortable' | 'compact';
  /** Column ids this person does not want to see: todo, doing, done or a squad column. */
  hidden: string[];
  filter: BoardFilter;
  sort: { key: ListKey; desc: boolean };
  /** The one-line entry creates a reminder for the person instead of a squad task. */
  quickMine: boolean;
}
export const DEFAULT_PREFS: BoardPrefs = { view: 'columns', density: 'comfortable', hidden: [], filter: {}, sort: { key: 'status', desc: false }, quickMine: false };

const KEYS: ListKey[] = ['title', 'status', 'priority', 'owner', 'updated'];
/** Whatever was stored, a valid preference comes back: unknown values fall back to the default one by one. Pure. */
export function readPrefs(raw: string | null): BoardPrefs {
  let v: Record<string, unknown> = {};
  try { const parsed = JSON.parse(raw ?? '{}'); if (parsed && typeof parsed === 'object') v = parsed; } catch {}
  const f = (v.filter && typeof v.filter === 'object' ? v.filter : {}) as Record<string, unknown>;
  const s = (v.sort && typeof v.sort === 'object' ? v.sort : {}) as Record<string, unknown>;
  const text = (x: unknown) => typeof x === 'string' && x.length > 0 && x.length <= 40 ? x : undefined;
  const filter: BoardFilter = {};
  if (text(f.agent)) filter.agent = f.agent as string;
  if (text(f.label)) filter.label = f.label as string;
  if (f.priority === 'high' || f.priority === 'normal' || f.priority === 'low') filter.priority = f.priority;
  if (f.mine === true) filter.mine = true;
  return {
    view: v.view === 'list' ? 'list' : 'columns',
    density: v.density === 'compact' ? 'compact' : 'comfortable',
    hidden: Array.isArray(v.hidden) ? v.hidden.filter((x): x is string => typeof x === 'string' && x.length <= 16).slice(0, 8) : [],
    filter,
    sort: { key: KEYS.includes(s.key as ListKey) ? s.key as ListKey : 'status', desc: s.desc === true },
    quickMine: v.quickMine === true,
  };
}

const storeKey = (nodeId: number) => `vb:board:${nodeId}`;
/** Private windows, previews and blocked storage answer with the defaults; nothing breaks. */
export function loadPrefs(nodeId: number): BoardPrefs {
  try { return readPrefs(localStorage.getItem(storeKey(nodeId))); } catch { return { ...DEFAULT_PREFS, filter: {}, hidden: [] }; }
}
export function savePrefs(nodeId: number, prefs: BoardPrefs): void {
  try { localStorage.setItem(storeKey(nodeId), JSON.stringify(prefs)); } catch {}
}

export interface Lane { id: string; name: string; status: 'pending' | 'working' | 'done'; base: Column; custom: boolean }
const BASE: Array<[Column, string, Lane['status']]> = [['todo', 'Da fare', 'pending'], ['doing', 'In corso', 'working'], ['done', 'Fatto', 'done']];
export const baseOf = (status: Lane['status']): Column => status === 'pending' ? 'todo' : status === 'working' ? 'doing' : 'done';

/**
 * The columns on screen, left to right: each of the three base columns followed by the squad's columns resting on
 * the same status. Hidden ones are left out, but never all of them: then «Da fare» stays. Pure.
 */
export function boardLanes(columns: BoardColumn[] | undefined, hidden: string[], name: (it: string) => string = s => s): Lane[] {
  const lanes: Lane[] = [];
  for (const [id, label, status] of BASE) {
    lanes.push({ id, name: name(label), status, base: id, custom: false });
    for (const c of columns ?? []) if (c.status === status) lanes.push({ id: c.id, name: c.name, status, base: id, custom: true });
  }
  const shown = lanes.filter(l => !hidden.includes(l.id));
  return shown.length ? shown : [lanes[0]];
}

/**
 * The column a task shows in: its squad column while the status still matches, otherwise the base column of its
 * status. Blocked tasks wait in «Serve te» ('you'). When that column is hidden, the card is not on screen. Pure.
 */
export function laneOf(t: Pick<TeamTask, 'status' | 'column'>, columns: BoardColumn[] | undefined): string {
  if (t.status === 'blocked') return 'you';
  const own = t.column ? columns?.find(c => c.id === t.column) : undefined;
  return own && own.status === t.status ? own.id : baseOf(t.status);
}

/** The filters in use, for the number on «Vista». */
export const activeFilters = (f: BoardFilter) => Number(!!f.agent) + Number(!!f.label) + Number(!!f.priority) + Number(!!f.mine);

/**
 * Whether a card passes the person's filters. `owner` is the code of who has it ('' when nobody); `mine` marks the
 * person's reminders, which have no agent, priority or labels. Pure.
 */
export function passes(card: { mine: boolean; owner: string; priority?: 'high' | 'low'; labels?: string[] }, f: BoardFilter): boolean {
  if (f.mine) return card.mine;
  if (card.mine) return !f.agent && !f.label && !f.priority;
  if (f.agent && (f.agent === '-' ? card.owner !== '' : card.owner !== f.agent)) return false;
  if (f.label && !(card.labels ?? []).some(l => l.toLowerCase() === f.label!.toLowerCase())) return false;
  if (f.priority && (card.priority ?? 'normal') !== f.priority) return false;
  return true;
}

export interface ListRow { id: string; title: string; status: TeamTask['status']; priority?: 'high' | 'low'; owner: string; updatedAt: number }
const STATUS_RANK: Record<TeamTask['status'], number> = { blocked: 0, working: 1, pending: 2, done: 3 };
const PRIO_RANK = { high: 0, normal: 1, low: 2 } as const;
/** The list view's order: by the chosen column, ties by latest change. Status order puts what needs you first. Pure. */
export function sortRows<T extends ListRow>(rows: T[], key: ListKey, desc: boolean): T[] {
  const by = (a: T, b: T): number => {
    if (key === 'title') return a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true });
    if (key === 'status') return STATUS_RANK[a.status] - STATUS_RANK[b.status];
    if (key === 'priority') return PRIO_RANK[a.priority ?? 'normal'] - PRIO_RANK[b.priority ?? 'normal'];
    if (key === 'owner') return (a.owner || '￿').localeCompare(b.owner || '￿', undefined, { numeric: true });
    return a.updatedAt - b.updatedAt;
  };
  return [...rows].sort((a, b) => (desc ? -by(a, b) : by(a, b)) || b.updatedAt - a.updatedAt);
}
