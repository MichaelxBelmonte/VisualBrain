import { t as tr, ui } from './i18n.ts';
// Deterministic layout: areas as groups, projects as boxes, expanded folders as nested boxes. No physics: stable, readable positions.
import type { GraphNode } from '../shared/types.ts';
import { STATUS_LABELS, type Store } from './state.ts';
import { glyphOf } from './icons.ts';

export type Measure = (text: string, font: string) => number;
export interface Fonts { box: string; file: string; sub: string; tag: string; group: string; small: string }

export interface Box {
  key: string;
  id: number;
  node: GraphNode;
  /** Current (animated) and target absolute positions, start of the current animation, position relative to the parent box or group. */
  x: number; y: number; tx: number; ty: number; sx: number; sy: number; rx: number; ry: number;
  w: number; h: number;
  /** Height of the title row: the whole box when collapsed. */
  headH: number;
  /** Width of the expand control at the right of the title row (0 when not expandable). */
  chevronW: number;
  /** Width of the box when collapsed: the column layout of the groups is decided on collapsed sizes, so it stays stable. */
  ownW: number;
  label: string;
  sub: string | null;
  tag: string | null;
  font: string;
  expandable: boolean;
  expanded: boolean;
  status: string | null;
  isFile: boolean;
  isProject: boolean;
  children: Box[];
  parent: Box | null;
  group: Group | null;
  depth: number;
  pinned: boolean;
  sessionCount: number;
  sessionBadgeW: number;
  /** Map glyph before the name and the width it takes, gap included (0 without a glyph). */
  glyph: string | null;
  glyphW: number;
  filesExpanded: boolean;
}

export interface Group {
  key: string;
  id: number;
  name: string;
  /** Height with every box collapsed (drives the column layout). */
  baseH: number;
  x: number; y: number; tx: number; ty: number; sx: number; sy: number;
  w: number; h: number;
  boxes: Box[];
  pinned: boolean;
}

export interface Bounds { x0: number; y0: number; x1: number; y1: number }
export interface Layout { groups: Group[]; boxes: Map<number, Box>; top: Box[]; bounds: Bounds }

export const G_LOOSE = 0;
export const G_LINKS = -1;
export const G_EXT = -2;
/** Optional preferred order of the area groups by name; areas not listed follow in the order they were created. */
const AREA_ORDER: string[] = [];

export const M = {
  padX: 10, boxH: 28, fileH: 24, subH: 13, chevronW: 30, gap: 8, innerPad: 10,
  groupPad: 14, groupHead: 34, groupGapX: 48, groupGapY: 36, minBoxW: 64, maxBoxW: 250,
};
const M_NORMAL = { ...M };
const M_COMPACT = { ...M, padX: 8, boxH: 24, gap: 6, innerPad: 8, groupPad: 10, groupHead: 30, maxBoxW: 200 };
/** Side of the map glyph: files use the smaller title row. */
export const glyphSize = (isFile: boolean): number => isFile ? 12 : 13;
/** Compact view: tighter metrics, folder names only. The renderer reads the same `M`, so both stay in step. */
export function applyMetrics(compact: boolean): void {
  Object.assign(M, compact ? M_COMPACT : M_NORMAL);
}

function trunc(s: string, max: number): string {
  if (s.length <= max) return s;
  const dot = s.lastIndexOf('.');
  const ext = dot > 0 && s.length - dot <= 6 ? s.slice(dot) : '';
  return s.slice(0, Math.max(4, max - ext.length - 1)) + '…' + ext;
}

function flow(items: { w: number; h: number }[], targetW: number, gap: number): { pos: { x: number; y: number }[]; w: number; h: number } {
  let x = 0; let y = 0; let rowH = 0; let maxW = 0;
  const pos: { x: number; y: number }[] = [];
  for (const it of items) {
    if (x > 0 && x + it.w > targetW) { x = 0; y += rowH + gap; rowH = 0; }
    pos.push({ x, y });
    x += it.w + gap;
    rowH = Math.max(rowH, it.h);
    maxW = Math.max(maxW, x - gap);
  }
  return { pos, w: maxW, h: items.length ? y + rowH : 0 };
}

/** A row width that makes the block wider than tall (ratio), never narrower than the widest item. */
function targetWidth(items: { w: number; h: number }[], ratio: number, min: number, max: number): number {
  let area = 0; let widest = 0;
  for (const it of items) { area += (it.w + M.gap) * (it.h + M.gap); widest = Math.max(widest, it.w); }
  return Math.max(widest, Math.min(max, Math.max(min, Math.sqrt(area * ratio))));
}

const rank = (s: string | null): number => (s === 'archive' ? 3 : s === 'copy' ? 2 : s === 'data' ? 1 : 0);

export function computeLayout(store: Store, measure: Measure, fonts: Fonts, aspect: number): Layout {
  const compact = store.filters.compact;
  applyMetrics(compact);
  const boxes = new Map<number, Box>();
  const sessionNodes = new Set([...store.sessions.values()].filter(s => s.alive).map(s => s.nodeId));
  const nodes = [...store.nodes.values()];
  for (const session of store.sessions.values()) {
    if (!session.alive || session.nodeId == null || !store.nodes.has(session.nodeId) || !store.sessionsExpanded.has(session.nodeId)) continue;
    const parent = store.nodes.get(session.nodeId)!;
    const role = session.role === 'orchestrator' ? tr('Orchestratore') : session.role === 'reviewer' ? tr('Revisore') : session.role === 'operator' ? tr('Operatore') : tr('Terminale');
    nodes.push({ ...parent, id: store.sessionIds.get(session.id)!, parentId: session.nodeId, cls: 'session', kind: 'file', name: ui`${role} · ${session.agent}`, path: session.cwd, childCount: 0, aggregate: false, summary: ui`${session.model || tr('Predefinito')}${session.effort ? ' / ' + session.effort : ''}` });
  }
  for (const n of nodes) {
    if (compact && n.cls !== 'session' && !sessionNodes.has(n.id) && (n.kind === 'file' || n.kind === 'symlink')) continue;
    boxes.set(n.id, {
      key: ui`n${n.id}`, id: n.id, node: n, x: 0, y: 0, tx: 0, ty: 0, sx: 0, sy: 0, rx: 0, ry: 0, w: 0, h: 0, headH: M.boxH, chevronW: 0, ownW: 0,
      label: n.name, sub: null, tag: null, font: fonts.box, expandable: false, expanded: false, status: null, isFile: false, isProject: false,
      children: [], parent: null, group: null, depth: 0, pinned: false, sessionCount: 0, sessionBadgeW: 0, glyph: null, glyphW: 0, filesExpanded: false,
    });
  }
  for (const b of boxes.values()) {
    const n = b.node;
    if (store.topLevel.has(n.id) || store.extra.has(n.id) || n.parentId === null) continue;
    const parent = boxes.get(n.parentId);
    if (parent) { b.parent = parent; parent.children.push(b); }
  }
  const top = [...boxes.values()].filter((b) => b.parent === null);

  // groups
  const groups = new Map<number, Group>();
  const groupName = (id: number): string => {
    if (id === G_LOOSE) return tr('Scrivania');
    if (id === G_LINKS) return tr('Collegamenti');
    if (id === G_EXT) return tr('Fuori dalla Scrivania');
    return store.areas.find((a) => a.id === id)?.name ?? ui`Area ${id}`;
  };
  const groupOf = (b: Box): number => {
    const n = b.node;
    if (n.kind === 'external') return G_EXT;
    if (n.kind === 'symlink') return G_LINKS;
    return store.projects.get(n.id)?.areaId ?? n.areaId ?? G_LOOSE;
  };
  for (const b of top) {
    const gid = groupOf(b);
    let g = groups.get(gid);
    if (!g) { g = { key: ui`g${gid}`, id: gid, name: groupName(gid), x: 0, y: 0, tx: 0, ty: 0, sx: 0, sy: 0, w: 0, h: 0, baseH: 0, boxes: [], pinned: store.pins.has(ui`g${gid}`) }; groups.set(gid, g); }
    b.group = g;
    g.boxes.push(b);
  }

  // sizes (post-order)
  const subOf = (n: GraphNode): string | null => {
    const rel = store.relPath(n.path);
    const i = rel.lastIndexOf('/');
    return i > 0 ? rel.slice(0, i) : null;
  };
  const tagOf = (b: Box): string | null => {
    const n = b.node;
    if (n.cls === 'rest') return null;
    if (n.kind === 'external') return tr('esterno');
    if (n.kind === 'symlink') return 'link';
    if (n.aggregate) return tr('solo totale');
    return b.status ? (STATUS_LABELS[b.status] ?? null) : null;
  };
  const size = (b: Box, depth: number): void => {
    const n = b.node;
    b.depth = depth;
    b.isFile = n.kind === 'file' || n.kind === 'symlink';
    b.isProject = store.projects.has(n.id) || n.cls === 'project';
    b.status = store.projects.get(n.id)?.status ?? null;
    b.expandable = (n.kind === 'dir' || n.kind === 'external') && !n.aggregate && n.cls !== 'rest' && n.childCount > 0;
    b.expanded = b.children.length > 0;
    b.filesExpanded = b.children.some(c => c.node.cls !== 'session');
    b.sessionCount = [...store.sessions.values()].filter(s => s.nodeId === n.id && s.alive).length;
    b.sessionBadgeW = b.sessionCount ? Math.ceil(measure(ui`◈ ${b.sessionCount}`, fonts.small) + 14) : 0;
    b.glyph = glyphOf(n);
    b.glyphW = b.glyph ? glyphSize(b.isFile) + 6 : 0;
    b.label = n.cls === 'rest' ? n.name : trunc(n.name, 30);
    b.font = b.isFile ? fonts.file : fonts.box;
    b.sub = n.cls === 'session' ? n.summary ?? null : depth === 0 && !compact ? subOf(n) : null;
    b.tag = compact ? null : tagOf(b);
    b.pinned = depth === 0 && store.pins.has(b.key);
    b.chevronW = b.expandable ? Math.ceil(measure(compact ? '▸' : ui`▸ ${n.childCount.toLocaleString(tr('it-IT'))}`, fonts.small) + 14) : 0;
    const chevron = b.chevronW;
    const tagW = b.tag ? measure(b.tag.toUpperCase(), fonts.tag) + 10 : 0;
    // the label gives way to the tag and the expand control: a long name is shortened until the box fits the maximum width
    const fixed = 2 * M.padX + b.glyphW + chevron + tagW + b.sessionBadgeW;
    let labelW = measure(b.label, b.font);
    let max = n.cls === 'rest' ? b.label.length : 30;
    while (labelW + fixed > M.maxBoxW && max > 8) { max -= 2; b.label = trunc(n.name, max); labelW = measure(b.label, b.font); }
    let ownW = labelW + fixed;
    if (b.sub) {
      let subW = measure(b.sub, fonts.sub);
      if (subW + 2 * M.padX > M.maxBoxW) { b.sub = '…' + b.sub.slice(-Math.max(10, Math.floor(b.sub.length * (M.maxBoxW - 2 * M.padX - 8) / subW))); subW = measure(b.sub, fonts.sub); }
      ownW = Math.max(ownW, subW + 2 * M.padX);
    }
    ownW = Math.max(M.minBoxW, Math.min(M.maxBoxW, Math.ceil(ownW)));
    b.ownW = ownW;
    b.headH = (b.isFile ? M.fileH : M.boxH) + (b.sub ? M.subH : 0);
    if (b.expanded) {
      b.children.sort((p, q) => {
        const ps = p.node.cls === 'session'; const qs = q.node.cls === 'session';
        if (ps !== qs) return ps ? -1 : 1;
        if (ps && qs) {
          const order = { brain: -1, orchestrator: 0, operator: 1, reviewer: 2 };
          const pr = store.graphSession(p.id)?.role, qr = store.graphSession(q.id)?.role;
          const roleOrder = (pr ? order[pr] : 3) - (qr ? order[qr] : 3);
          if (roleOrder) return roleOrder;
        }
        const pr = p.node.cls === 'rest' ? 1 : 0; const qr = q.node.cls === 'rest' ? 1 : 0;
        if (pr !== qr) return pr - qr;
        const pd = p.node.kind === 'dir' || p.node.kind === 'external' ? 0 : 1; const qd = q.node.kind === 'dir' || q.node.kind === 'external' ? 0 : 1;
        if (pd !== qd) return pd - qd;
        return (q.node.importance - p.node.importance) || p.node.name.localeCompare(q.node.name);
      });
      for (const c of b.children) size(c, depth + 1);
      const tw = targetWidth(b.children, 1.7, 180, 600);
      const f = flow(b.children, Math.max(tw, ownW - 2 * M.innerPad), M.gap);
      b.children.forEach((c, i) => { c.rx = M.innerPad + f.pos[i].x; c.ry = b.headH + M.innerPad + f.pos[i].y; });
      b.w = Math.max(ownW, f.w + 2 * M.innerPad);
      b.h = b.headH + f.h + 2 * M.innerPad;
    } else {
      b.w = ownW;
      b.h = b.headH;
    }
  };
  for (const b of top) size(b, 0);

  // boxes inside their group
  for (const g of groups.values()) {
    g.boxes.sort((p, q) => (rank(p.status) - rank(q.status)) || (q.node.importance - p.node.importance) || p.node.name.localeCompare(q.node.name));
    const free = g.boxes.filter((b) => !b.pinned);
    const tw = targetWidth(free, 1.9, 220, 780);
    const f = flow(free, tw, M.gap + 2);
    free.forEach((b, i) => { b.rx = M.groupPad + f.pos[i].x; b.ry = M.groupHead + f.pos[i].y; });
    g.w = Math.max(f.w + 2 * M.groupPad, measure(g.name.toUpperCase(), fonts.group) + 2 * M.groupPad + 36);
    g.h = M.groupHead + f.h + M.groupPad;
    const collapsed = free.map((b) => ({ w: b.ownW, h: b.headH }));
    g.baseH = M.groupHead + flow(collapsed, targetWidth(collapsed, 1.9, 220, 780), M.gap + 2).h + M.groupPad;
  }

  // groups in columns, in a stable order, filling a block with the aspect of the viewport
  const order = (g: Group): number => {
    if (g.id === G_LOOSE) return 1000; if (g.id === G_LINKS) return 1001; if (g.id === G_EXT) return 1002;
    const i = AREA_ORDER.indexOf(g.name);
    return i >= 0 ? i : 100 + g.id;
  };
  const ordered = [...groups.values()].sort((p, q) => order(p) - order(q));
  const free = ordered.filter((g) => !g.pinned);
  // columns decided on the collapsed heights: opening a box widens or lengthens a column, never moves a group elsewhere
  let area = 0;
  for (const g of free) area += (g.w + M.groupGapX) * (g.baseH + M.groupGapY);
  const H = Math.sqrt(area / Math.max(0.5, aspect));
  let x = 0; let y = 0; let baseY = 0; let colW = 0;
  for (const g of free) {
    if (baseY > 0 && baseY + g.baseH > H * 1.05) { x += colW + M.groupGapX; y = 0; baseY = 0; colW = 0; }
    g.tx = x; g.ty = y;
    y += g.h + M.groupGapY;
    baseY += g.baseH + M.groupGapY;
    colW = Math.max(colW, g.w);
  }
  for (const g of ordered) if (g.pinned) { const p = store.pins.get(g.key)!; g.tx = p.x; g.ty = p.y; }

  // absolute targets
  const bounds: Bounds = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const grow = (x0: number, y0: number, x1: number, y1: number) => { bounds.x0 = Math.min(bounds.x0, x0); bounds.y0 = Math.min(bounds.y0, y0); bounds.x1 = Math.max(bounds.x1, x1); bounds.y1 = Math.max(bounds.y1, y1); };
  const place = (b: Box, px: number, py: number): void => {
    b.tx = px + b.rx; b.ty = py + b.ry;
    for (const c of b.children) place(c, b.tx, b.ty);
  };
  for (const g of ordered) {
    grow(g.tx, g.ty, g.tx + g.w, g.ty + g.h);
    for (const b of g.boxes) {
      if (b.pinned) { const p = store.pins.get(b.key)!; b.tx = p.x; b.ty = p.y; for (const c of b.children) place(c, b.tx, b.ty); grow(b.tx, b.ty, b.tx + b.w, b.ty + b.h); }
      else place(b, g.tx, g.ty);
    }
  }
  if (!Number.isFinite(bounds.x0)) Object.assign(bounds, { x0: 0, y0: 0, x1: 0, y1: 0 });
  return { groups: ordered, boxes, top, bounds };
}
