import type { TeamLink, TerminalInfo } from '../shared/types.ts';

export interface ConnectionGroup {
  nodeIds: number[];
  /** Stable colour across input ordering and session state changes. */
  tone: number;
}

/** Explicit operational channels only: file-graph relationships never enter this view. */
export function connectionGroups(links: TeamLink[]): Map<number, ConnectionGroup> {
  const neighbors = new Map<number, Set<number>>();
  for (const link of links) {
    if (link.srcNodeId === link.dstNodeId) continue;
    for (const [a, b] of [[link.srcNodeId, link.dstNodeId], [link.dstNodeId, link.srcNodeId]]) {
      if (!neighbors.has(a)) neighbors.set(a, new Set());
      neighbors.get(a)!.add(b);
    }
  }
  const groups = new Map<number, ConnectionGroup>();
  for (const id of [...neighbors.keys()].sort((a, b) => a - b)) {
    if (groups.has(id)) continue;
    const visited = new Set<number>([id]), pending = [id];
    for (let i = 0; i < pending.length; i++) {
      for (const next of neighbors.get(pending[i]) || []) if (!visited.has(next)) { visited.add(next); pending.push(next); }
    }
    const nodeIds = [...visited].sort((a, b) => a - b);
    const group = { nodeIds, tone: nodeIds[0] % 6 };
    for (const nodeId of nodeIds) groups.set(nodeId, group);
  }
  return groups;
}

export interface LinkSide { id: string; nodeId: number | null; role?: TerminalInfo['role']; alive: boolean }

/** One side of a link as stored: an orchestrator is reached through its node (null), any other session by id. */
const storedSession = (s: LinkSide): string | null => (s.role === 'orchestrator' ? null : s.id);

/** The stored link between two sessions, whichever direction it was made in. */
export function linkBetween(links: TeamLink[], a: LinkSide, b: LinkSide): TeamLink | undefined {
  if (a.nodeId == null || b.nodeId == null) return undefined;
  const [sa, sb] = [storedSession(a), storedSession(b)];
  return links.find(l =>
    (l.srcNodeId === a.nodeId && l.dstNodeId === b.nodeId && l.srcSessionId === sa && l.dstSessionId === sb)
    || (l.srcNodeId === b.nodeId && l.dstNodeId === a.nodeId && l.srcSessionId === sb && l.dstSessionId === sa));
}

/** The link to create between two sessions (null for a side that is an orchestrator). */
export function linkRequest(a: LinkSide, b: LinkSide): Omit<TeamLink, 'id'> | null {
  if (a.nodeId == null || b.nodeId == null || a.nodeId === b.nodeId) return null;
  return { srcNodeId: a.nodeId, srcSessionId: storedSession(a), dstNodeId: b.nodeId, dstSessionId: storedSession(b) };
}

export interface OrderedNode { id: number | null; /** Nodes sharing a channel form a cluster: the first one of each cluster carries its size. */ clusterSize: number; clusterStart: boolean }

/**
 * Order of the nodes in the rail: the user's manual order first (then the remaining nodes as given), with the nodes of one
 * connection group kept side by side by default. freeOrder lets the rail follow manual order exactly without changing links.
 * A node without a stored position goes last.
 */
export function orderNodes(ids: (number | null)[], manual: number[], links: TeamLink[], freeOrder = false): OrderedNode[] {
  const present = new Set(ids);
  const base = [...manual.filter(id => present.has(id)), ...ids.filter(id => id === null || !manual.includes(id))];
  const unique = base.filter((id, i) => base.indexOf(id) === i);
  if (freeOrder) return unique.map(id => ({ id, clusterSize: 1, clusterStart: false }));
  const groups = connectionGroups(links);
  const out: OrderedNode[] = [], placed = new Set<number | null>();
  for (const id of unique) {
    if (placed.has(id)) continue;
    const group = id !== null ? groups.get(id) : undefined;
    const members = group ? unique.filter(other => other !== null && group.nodeIds.includes(other)) : [id];
    members.forEach((member, i) => { placed.add(member); out.push({ id: member, clusterSize: members.length, clusterStart: i === 0 && members.length > 1 }); });
  }
  return out;
}

/** The manual order after dragging `id` in front of `before` (or last when `before` is null). */
export function moveNode(order: (number | null)[], id: number, before: number | null): number[] {
  const rest = order.filter((x): x is number => x !== null && x !== id);
  const at = before === null ? rest.length : rest.indexOf(before);
  rest.splice(at < 0 ? rest.length : at, 0, id);
  return rest;
}
