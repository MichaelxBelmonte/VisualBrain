// Side-by-side grid of terminal sessions, possibly from different nodes. Pure logic: no DOM, no xterm, no network.
// The grid only decides WHICH sessions are shown and in what order; the sessions themselves (PTY, WebSocket, xterm)
// belong to Terminals and are never touched when a view is added, removed or reordered.

export const MAX_TILES = 4;

/** Distinguishable without colour: a shape and a number, so two tiles are never told apart by hue alone. */
export const TILE_SHAPES = ['●', '■', '▲', '◆'] as const;

import type { TeamLink } from '../shared/types.ts';

export interface TileSession { id: string; nodeId?: number | null; alive: boolean; createdAt?: number; role?: string }

export interface TileSelection {
  ids: string[];
  /** The tile that has the keyboard focus (always one of `ids`, or null when the grid is empty). */
  focus: string | null;
}

const unique = (ids: string[]): string[] => ids.filter((id, i) => ids.indexOf(id) === i);
const keepFocus = (ids: string[], focus: string | null): string | null => (focus !== null && ids.includes(focus) ? focus : ids[0] ?? null);

/** Apply the saved visual order to a view, keeping new sessions at the end. */
export function orderTiles(ids: string[], manual: string[]): string[] {
  const known = new Set(ids);
  return unique([...manual.filter(id => known.has(id)), ...ids]);
}

/** Moving a terminal tile changes only its visual slot; its focus and live session stay intact. */
export function moveTile(sel: TileSelection, id: string, before: string | null): TileSelection {
  if (!sel.ids.includes(id) || before === id || (before !== null && !sel.ids.includes(before))) return sel;
  const ids = sel.ids.filter(other => other !== id);
  ids.splice(before === null ? ids.length : ids.indexOf(before), 0, id);
  return { ids, focus: keepFocus(ids, sel.focus) };
}

/**
 * The grid shown when it is first turned on: the focused session, then the live sessions of its node, up to `max`.
 * Terminated sessions of the same node fill the remaining slots after the live ones.
 */
export function defaultTiles(sessions: TileSession[], active: string | null, max = MAX_TILES): TileSelection {
  const current = sessions.find(s => s.id === active);
  if (!current) return { ids: [], focus: null };
  const same = sessions.filter(s => s.id !== current.id && (s.nodeId ?? null) === (current.nodeId ?? null));
  const ordered = [current, ...same.filter(s => s.alive), ...same.filter(s => !s.alive)];
  return { ids: unique(ordered.map(s => s.id)).slice(0, max), focus: current.id };
}

export type ToggleResult = TileSelection & { change: 'added' | 'removed' | 'full' | 'unknown' };

/** Picker checkbox: adds a session to the grid, or removes it from the view. A full grid refuses, it never evicts. */
export function toggleTile(sel: TileSelection, id: string, known: Set<string>, max = MAX_TILES): ToggleResult {
  const ids = unique(sel.ids);
  if (ids.includes(id)) return { ...removeTile({ ids, focus: sel.focus }, id), change: 'removed' };
  if (!known.has(id)) return { ...sel, change: 'unknown' };
  if (ids.length >= max) return { ...sel, change: 'full' };
  return { ids: [...ids, id], focus: sel.focus ?? id, change: 'added' };
}

/** "Remove from view": the session leaves the grid, the focus moves to the neighbour that takes its place. */
export function removeTile(sel: TileSelection, id: string): TileSelection {
  const at = sel.ids.indexOf(id);
  if (at < 0) return sel;
  const ids = sel.ids.filter(x => x !== id);
  if (sel.focus !== id) return { ids, focus: keepFocus(ids, sel.focus) };
  return { ids, focus: ids[Math.min(at, ids.length - 1)] ?? null };
}

/**
 * Focuses a session from outside the grid (rail click, notification). A tile already in the grid only takes the focus;
 * otherwise it takes a free slot, or replaces the focused tile when the grid is full. The other tiles are left alone.
 */
export function focusTile(sel: TileSelection, id: string, max = MAX_TILES): TileSelection {
  if (sel.ids.includes(id)) return { ids: sel.ids, focus: id };
  if (sel.ids.length < max) return { ids: [...sel.ids, id], focus: id };
  const at = sel.focus !== null ? sel.ids.indexOf(sel.focus) : -1;
  const ids = [...sel.ids];
  ids[at < 0 ? ids.length - 1 : at] = id;
  return { ids, focus: id };
}

/** Focus by position (1-based tile number) or by step (wraps around). */
export function stepFocus(sel: TileSelection, delta: number): TileSelection {
  if (!sel.ids.length) return sel;
  const at = sel.focus !== null ? sel.ids.indexOf(sel.focus) : -1;
  const next = at < 0 ? (delta > 0 ? 0 : sel.ids.length - 1) : (at + delta + sel.ids.length * 4) % sel.ids.length;
  return { ids: sel.ids, focus: sel.ids[next] };
}
export function focusIndex(sel: TileSelection, index: number): TileSelection {
  const id = sel.ids[index];
  return id === undefined ? sel : { ids: sel.ids, focus: id };
}

/**
 * Called after every server refresh. A session that is gone for good (unknown to the client, for example killed from
 * another window) leaves the grid. A terminated session stays: its output is still worth reading, and the user removes it.
 */
export function reconcileTiles(sel: TileSelection, known: Set<string>, max = MAX_TILES): TileSelection {
  const ids = unique(sel.ids).filter(id => known.has(id)).slice(0, max);
  return { ids, focus: keepFocus(ids, sel.focus) };
}

export interface GroupSuggestion {
  /** Nodes of the connected component of the card the user pressed (that node first). */
  nodes: number[];
  /** Live endpoints of the persistent links, the pressed node's first. */
  ids: string[];
  /** True when `ids` fit in the grid and can be applied as they are; false = the user must choose explicitly. */
  fits: boolean;
  /** Link endpoints that are terminated: shown as inactive, never suggested. */
  inactive: string[];
}

/** Persistent links between different nodes only: a link inside one node is useless (the node already talks to itself). */
export const crossNodeLinks = (links: TeamLink[]): TeamLink[] => links.filter(l => l.srcNodeId !== l.dstNodeId);

/** Nodes reachable from `nodeId` through persistent links (node or session endpoints), `nodeId` first, then breadth-first. */
export function linkedNodes(nodeId: number, links: TeamLink[]): number[] {
  const all = crossNodeLinks(links);
  const seen = [nodeId];
  for (let i = 0; i < seen.length; i++) {
    for (const l of all) {
      const other = l.srcNodeId === seen[i] ? l.dstNodeId : l.dstNodeId === seen[i] ? l.srcNodeId : null;
      if (other !== null && !seen.includes(other)) seen.push(other);
    }
  }
  return seen;
}

/** What a node-level link really reaches: the node's live orchestrator, nothing else. */
export function orchestratorEndpoint(nodeId: number, sessions: TileSession[]): string | null {
  return sessions.filter(s => s.alive && s.role === 'orchestrator' && (s.nodeId ?? null) === nodeId).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))[0]?.id ?? null;
}

/** NOT a link endpoint (a link only reaches the orchestrator, see orchestratorEndpoint): the session shown for a node with no links at all, its live orchestrator else its first live session. */
export function standaloneNodeSession(nodeId: number, sessions: TileSession[]): string | null {
  const live = sessions.filter(s => s.alive && (s.nodeId ?? null) === nodeId).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  return (live.find(s => s.role === 'orchestrator') ?? live[0])?.id ?? null;
}

/**
 * Sessions to show side by side for "Affianca collegati" on the card of `nodeId`: the live endpoints of every persistent
 * link of its component. A node-level endpoint is the node's live orchestrator and nothing else: without one the channel
 * is dead and the endpoint is reported as inactive (`node:<id>`), never replaced by another session that the link does not
 * reach. An endpoint that is a terminated session is inactive too. Only a node with no links at all falls back to its
 * first live session. When more than `max` endpoints qualify the
 * suggestion does not fit: nothing is applied and the user picks which ones to show.
 */
export function groupSuggestion(nodeId: number, links: TeamLink[], sessions: TileSession[], max = MAX_TILES): GroupSuggestion {
  const nodes = linkedNodes(nodeId, links);
  const byId = new Map(sessions.map(s => [s.id, s]));
  const ids: string[] = [];
  const inactive: string[] = [];
  const add = (id: string | null) => { if (id !== null && !ids.includes(id)) ids.push(id); };
  const endpoint = (node: number, sessionId: string | null) => {
    if (sessionId === null) {
      const orchestrator = orchestratorEndpoint(node, sessions);
      if (orchestrator) add(orchestrator);
      else { const mark = `node:${node}`; if (!inactive.includes(mark)) inactive.push(mark); }
      return;
    }
    const s = byId.get(sessionId);
    if (s?.alive) add(sessionId); else if (!inactive.includes(sessionId)) inactive.push(sessionId);
  };
  const component = new Set(nodes);
  const touched = crossNodeLinks(links).some(l => l.srcNodeId === nodeId || l.dstNodeId === nodeId);
  for (const node of nodes) {
    for (const l of crossNodeLinks(links)) {
      if (!component.has(l.srcNodeId) || !component.has(l.dstNodeId)) continue;
      if (l.srcNodeId === node) endpoint(node, l.srcSessionId);
      if (l.dstNodeId === node) endpoint(node, l.dstSessionId);
    }
    if (node === nodeId && !touched) add(standaloneNodeSession(nodeId, sessions));
  }
  return { nodes, ids, fits: ids.length <= max, inactive };
}

export interface PickerItem {
  id: string;
  nodeId: number | null;
  alive: boolean;
  selected: boolean;
  /** 1-based tile number when selected, so the picker shows the same marker as the tile header. */
  tile: number | null;
  /** True when the grid is full and this session is not in it: it cannot be added until another is removed. */
  disabled: boolean;
  /** An endpoint of a persistent link (the picker shows it with a marker, not only a colour). */
  linked: boolean;
  /** Suggested by "Affianca collegati" when the choice does not fit and the user must make it. */
  suggested: boolean;
}
export interface PickerGroup { nodeId: number | null; name: string; items: PickerItem[] }

/**
 * The picker lists every known session grouped by node, node order = first seen, live sessions before terminated ones.
 * `matches` is the filter (already lower-cased text per session) so the grouping stays independent from labels/i18n.
 */
export function pickerGroups(
  sessions: TileSession[], sel: TileSelection, nodeName: (nodeId: number | null) => string,
  matches: (id: string) => boolean = () => true, max = MAX_TILES,
  extra: { linked?: Set<string>; suggested?: Set<string> } = {},
): PickerGroup[] {
  const full = sel.ids.length >= max;
  const groups = new Map<number | null, PickerGroup>();
  const sorted = [...sessions].sort((a, b) => Number(b.alive) - Number(a.alive) || (a.createdAt ?? 0) - (b.createdAt ?? 0));
  for (const s of sorted) {
    if (!matches(s.id) && !sel.ids.includes(s.id)) continue;
    const nodeId = s.nodeId ?? null;
    let group = groups.get(nodeId);
    if (!group) groups.set(nodeId, group = { nodeId, name: nodeName(nodeId), items: [] });
    const at = sel.ids.indexOf(s.id);
    group.items.push({ id: s.id, nodeId, alive: s.alive, selected: at >= 0, tile: at >= 0 ? at + 1 : null, disabled: full && at < 0, linked: extra.linked?.has(s.id) ?? false, suggested: extra.suggested?.has(s.id) ?? false });
  }
  return [...groups.values()];
}

export interface TileMarker { index: number; number: number; shape: string; text: string }
/** Marker shown in the tile header and in the picker: "● 1", "■ 2", ... */
export function tileMarker(index: number): TileMarker {
  const shape = TILE_SHAPES[index % TILE_SHAPES.length];
  return { index, number: index + 1, shape, text: `${shape} ${index + 1}` };
}

export type TileKeyAction =
  | { type: 'focus'; index: number }
  | { type: 'step'; delta: 1 | -1 }
  | { type: 'remove' }
  | { type: 'picker' };
export interface KeyLike { code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }

/**
 * Keyboard shortcuts, active inside a terminal and outside. Ctrl+Alt is used because the shell and the agents own plain
 * Ctrl and Alt combinations. `code` (not `key`) because Option changes the produced character on macOS.
 *   Ctrl+Alt+1..4  focus tile n     Ctrl+Alt+[ / ]  previous / next tile
 *   Ctrl+Alt+W     remove the focused tile from the view (the session keeps running)
 *   Ctrl+Alt+G     open the picker
 */
export function tileKeyAction(e: KeyLike): TileKeyAction | null {
  if (!e.ctrlKey || !e.altKey || e.metaKey || e.shiftKey) return null;
  const digit = /^Digit([1-9])$/.exec(e.code);
  if (digit) return { type: 'focus', index: Number(digit[1]) - 1 };
  switch (e.code) {
    case 'BracketLeft': return { type: 'step', delta: -1 };
    case 'BracketRight': return { type: 'step', delta: 1 };
    case 'KeyW': return { type: 'remove' };
    case 'KeyG': return { type: 'picker' };
    default: return null;
  }
}

/** Next/previous terminal tab in the single view, the macOS way (⌘⇧[ ⌘⇧]) or the browser way (⌃Tab, ⌃⇧Tab); Ctrl+Alt keys go through tileKeyAction. */
export function tabStepKey(e: KeyLike & { shiftKey: boolean }): -1 | 1 | null {
  if (e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey && (e.code === 'BracketLeft' || e.code === 'BracketRight')) return e.code === 'BracketLeft' ? -1 : 1;
  if (e.ctrlKey && !e.metaKey && !e.altKey && e.code === 'Tab') return e.shiftKey ? -1 : 1;
  return null;
}
/** Tab after `active` in `ids`, wrapping around; the first one when `active` is not there. */
export function stepTab(ids: string[], active: string | null, delta: number): string | null {
  if (!ids.length) return null;
  const at = active === null ? -1 : ids.indexOf(active);
  if (at < 0) return ids[0];
  return ids[(at + delta + ids.length) % ids.length];
}

/** Columns of the grid: 1 tile fills the area, 2 side by side, 3-4 in a 2 x 2 grid. */
export function gridColumns(count: number): number { return count <= 1 ? 1 : 2; }
/** Share of the grid given to the first column or row when the dividers are dragged: 15% to 85%, so no terminal disappears. */
export const clampSplit = (share: number): number => Number.isFinite(share) ? Math.min(0.85, Math.max(0.15, share)) : 0.5;

export type EndpointKind = 'node' | 'session';

/** Resolves one side of a link to the session that really answers on it (live only), or null when the channel is dead there. */
function sideSession(nodeId: number, sessionId: string | null, sessions: TileSession[]): string | null {
  if (sessionId === null) return orchestratorEndpoint(nodeId, sessions);
  return sessions.some(s => s.id === sessionId && s.alive) ? sessionId : null;
}

/** The sessions that are real endpoints of persistent cross-node links: 'node' = reached through the node (its orchestrator), 'session' = named explicitly. */
export function connectionEndpoints(links: TeamLink[], sessions: TileSession[]): Map<string, EndpointKind> {
  const out = new Map<string, EndpointKind>();
  for (const l of crossNodeLinks(links)) {
    for (const [node, id] of [[l.srcNodeId, l.srcSessionId], [l.dstNodeId, l.dstSessionId]] as const) {
      const live = sideSession(node, id, sessions);
      if (live && (id !== null || !out.has(live))) out.set(live, id === null ? 'node' : 'session');
    }
  }
  return out;
}

/** Live sessions directly linked to `sessionId` (node, session or mixed links), in link order, without duplicates. */
export function directPeers(sessionId: string, links: TeamLink[], sessions: TileSession[]): string[] {
  const peers: string[] = [];
  for (const l of crossNodeLinks(links)) {
    const src = sideSession(l.srcNodeId, l.srcSessionId, sessions);
    const dst = sideSession(l.dstNodeId, l.dstSessionId, sessions);
    if (!src || !dst) continue; // an inactive channel offers nothing
    const peer = src === sessionId ? dst : dst === sessionId ? src : null;
    if (peer && peer !== sessionId && !peers.includes(peer)) peers.push(peer);
  }
  return peers;
}

/** "Affianca orchestratore": exactly these two sessions, the first one keeps the focus. */
export const pairTiles = (focus: string, peer: string): TileSelection => ({ ids: [focus, peer], focus });

// --- Per-node view: a node shows its own terminals, MAX_TILES per page ---------------------------------------------------
// A session of another node can be added to the view of a node only through a direct link between the two nodes: adding it
// is what links their orchestrators. The view is pure data; the sessions themselves are never touched.

export interface NodeView {
  /** Own sessions the user removed from this view (they keep running and stay in the rail). */
  hidden: string[];
  /** Sessions of directly linked nodes added to this view, in the order they were added. */
  guests: string[];
  /** Zero-based page of MAX_TILES tiles. */
  page: number;
}
export const emptyNodeView = (): NodeView => ({ hidden: [], guests: [], page: 0 });

/** Direct link between two nodes (any endpoints); a chain A-B-C does not make A and C linked. */
export const nodesLinked = (a: number, b: number, links: TeamLink[]): boolean =>
  crossNodeLinks(links).some(l => (l.srcNodeId === a && l.dstNodeId === b) || (l.srcNodeId === b && l.dstNodeId === a));

/** Everything a node view lists, in page order: the node's own sessions (creation order, hidden ones left out), then its guests. */
export function nodeViewIds(nodeId: number | null, sessions: TileSession[], view: NodeView, links: TeamLink[]): string[] {
  const own = sessions.filter(s => (s.nodeId ?? null) === nodeId && !view.hidden.includes(s.id)).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)).map(s => s.id);
  const byId = new Map(sessions.map(s => [s.id, s]));
  const guests = view.guests.filter(id => {
    const s = byId.get(id);
    return !!s && nodeId !== null && s.nodeId != null && s.nodeId !== nodeId && nodesLinked(nodeId, s.nodeId, links);
  });
  return unique([...own, ...guests]);
}

export const pageCount = (total: number, max = MAX_TILES): number => Math.max(1, Math.ceil(total / max));
export const clampPage = (page: number, total: number, max = MAX_TILES): number => Math.min(Math.max(0, page), pageCount(total, max) - 1);
export const pageIds = (ids: string[], page: number, max = MAX_TILES): string[] => ids.slice(clampPage(page, ids.length, max) * max, clampPage(page, ids.length, max) * max + max);
export const pageOfId = (ids: string[], id: string, max = MAX_TILES): number | null => { const at = ids.indexOf(id); return at < 0 ? null : Math.floor(at / max); };

/**
 * The link that adding a session of node `other` to the view of `base` requires: node-level, which is exactly the two
 * orchestrators. Null when it cannot work (one of the nodes has no live orchestrator), so nothing is created in vain.
 */
export function orchestratorLink(base: number, other: number, sessions: TileSession[]): Omit<TeamLink, 'id'> | null {
  if (!orchestratorEndpoint(base, sessions) || !orchestratorEndpoint(other, sessions)) return null;
  return { srcNodeId: base, srcSessionId: null, dstNodeId: other, dstSessionId: null };
}

/** True when showing a session of `other` next to the terminals of `bases` needs a new link (no direct link to any of them yet). */
export const needsLink = (bases: number[], other: number | null, links: TeamLink[]): boolean =>
  other !== null && bases.length > 0 && !bases.includes(other) && !bases.some(b => nodesLinked(b, other, links));

export interface NodePickerGroup extends PickerGroup {
  /** The viewed node itself. */
  own: boolean;
  /** Directly linked to the viewed node (its sessions can be added at once). */
  linked: boolean;
}

/** Picker of a node view: the node first, then its linked nodes, then every other node (adding one of those asks to link). */
export function nodePickerGroups(
  sessions: TileSession[], nodeId: number | null, view: NodeView, links: TeamLink[], nodeName: (nodeId: number | null) => string,
  manualOrder: string[] = [],
): NodePickerGroup[] {
  const ids = orderTiles(nodeViewIds(nodeId, sessions, view, links), manualOrder);
  const page = clampPage(view.page, ids.length);
  const groups = new Map<number | null, NodePickerGroup>();
  const sorted = [...sessions].sort((a, b) => Number(b.alive) - Number(a.alive) || (a.createdAt ?? 0) - (b.createdAt ?? 0));
  for (const s of sorted) {
    const node = s.nodeId ?? null;
    let group = groups.get(node);
    if (!group) groups.set(node, group = { nodeId: node, name: nodeName(node), items: [], own: node === nodeId, linked: node !== null && nodeId !== null && nodesLinked(nodeId, node, links) });
    const at = ids.indexOf(s.id);
    const onPage = at >= page * MAX_TILES && at < (page + 1) * MAX_TILES;
    group.items.push({ id: s.id, nodeId: node, alive: s.alive, selected: at >= 0, tile: onPage ? at - page * MAX_TILES + 1 : null, disabled: false, linked: false, suggested: false });
  }
  const rank = (g: NodePickerGroup) => (g.own ? 0 : g.linked ? 1 : 2);
  return [...groups.values()].sort((a, b) => rank(a) - rank(b));
}
