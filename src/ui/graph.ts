import { t as tr, ui } from './i18n.ts';
// Canvas renderer and interaction for the box map: groups, boxes, edges, pan/zoom, drag, selection, hover.
import type { Store } from './state.ts';
import { UNDIRECTED, shortPath } from './state.ts';
import { M, glyphSize, type Box, type Fonts, type Group, type Layout } from './layout.ts';
import { drawGlyph } from './icons.ts';
import type { GraphEdge } from '../shared/types.ts';

export interface GraphCallbacks {
  onSelect(id: number | null): void;
  onToggleExpand(id: number): void;
  onOpen(id: number): void;
  onPin(key: string, x: number, y: number): void;
  onSession(id: string): void;
  onToggleSessions(id: number): void;
}

interface Colors { bg: string; stage: string; fg: string; g1: string; g2: string; g3: string; g4: string; g5: string; font: string; mono: string }
interface Drag { type: 'pan' | 'box' | 'group'; box?: Box; group?: Group; hit?: Box; sx: number; sy: number; tx: number; ty: number; ox: number; oy: number; moved: boolean }
interface Curve { x0: number; y0: number; x1: number; y1: number; c0x: number; c0y: number; c1x: number; c1y: number }

const ANIM_MS = 280;
const ease = (t: number): number => 1 - Math.pow(1 - t, 3);

/** The map background over the window glass: the theme colour with the stage alpha (opaque outside the Mac app). */
function translucent(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m || !(alpha < 1)) return hex;
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${Math.max(0, alpha)})`;
}

function fitText(ctx: CanvasRenderingContext2D, text: string, width: number): string {
  if (width <= 0) return '';
  if (ctx.measureText(text).width <= width) return text;
  if (ctx.measureText('…').width > width) return '';
  const chars = Array.from(text);
  let lo = 0; let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(chars.slice(0, mid).join('') + '…').width <= width) lo = mid;
    else hi = mid - 1;
  }
  return chars.slice(0, lo).join('') + '…';
}

export class GraphView {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly store: Store;
  private readonly cb: GraphCallbacks;
  k = 1;
  tx = 0;
  ty = 0;
  private dpr = 1;
  private w = 0;
  private h = 0;
  private framePending = false;
  private colors!: Colors;
  private drag: Drag | null = null;
  private mouse: { x: number; y: number } | null = null;
  private layout: Layout = { groups: [], boxes: new Map(), top: [], bounds: { x0: 0, y0: 0, x1: 0, y1: 0 } };
  private animStart = 0;
  private animEnd = 0;
  private measureCache = new Map<string, number>();
  private hoverSince = 0;
  private hoverTimer = 0;
  private chevronHot = false;
  userMoved = false;

  constructor(canvas: HTMLCanvasElement, store: Store, cb: GraphCallbacks) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.store = store;
    this.cb = cb;
    this.readColors();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement!);
    this.resize();
    for (const ev of ['graph', 'select', 'hover'] as const) store.on(ev, () => this.invalidate());
    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerup', (e) => this.onUp(e));
    canvas.addEventListener('pointerleave', () => { this.mouse = null; this.store.hover(null); });
    canvas.addEventListener('dblclick', (e) => {
      const [wx, wy] = this.toWorld(e.offsetX, e.offsetY);
      const b = this.hitBox(wx, wy);
      if (!b) return;
      if (b.node.cls === 'session') return;
      if (b.expandable) this.cb.onToggleExpand(b.id);
      else if (b.node.kind === 'file' || b.node.kind === 'symlink') this.cb.onOpen(b.id);
    });
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  readColors(): void {
    const cs = getComputedStyle(document.documentElement);
    const v = (n: string) => cs.getPropertyValue(n).trim();
    this.colors = { bg: v('--bg'), stage: translucent(v('--bg'), Number(v('--stage-alpha') || 1)), fg: v('--fg'), g1: v('--g1'), g2: v('--g2'), g3: v('--g3'), g4: v('--g4'), g5: v('--g5'), font: v('--font'), mono: v('--mono') };
    this.measureCache.clear();
    this.invalidate();
  }

  fonts(): Fonts {
    const f = this.colors.font;
    return { box: ui`500 12px ${f}`, file: ui`400 11.5px ${f}`, sub: ui`400 10px ${f}`, tag: ui`500 9px ${f}`, group: ui`600 10.5px ${f}`, small: ui`500 10px ${f}` };
  }

  measure = (text: string, font: string): number => {
    const key = font + '\u0000' + text;
    let v = this.measureCache.get(key);
    if (v === undefined) {
      this.ctx.font = font;
      v = this.ctx.measureText(text).width;
      this.measureCache.set(key, v);
    }
    return v;
  };

  aspect(): number { return this.h > 0 ? this.w / this.h : 1.6; }

  invalidate(): void {
    if (this.framePending) return;
    this.framePending = true;
    requestAnimationFrame(this.paintFrame);
  }

  private paintFrame = (now: number): void => {
    this.framePending = false;
    if (this.animEnd > 0) {
      this.step(Math.min(now, this.animEnd));
      if (now < this.animEnd) this.invalidate();
      else this.animEnd = 0;
    }
    this.draw();
  };

  /** Last non-empty size and a fit asked for while the map was hidden (Operativa open): both keep the camera centred when it shows again. */
  private seenW = 0;
  private seenH = 0;
  private fitPending = false;

  private resize(): void {
    const p = this.canvas.parentElement!;
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    this.w = p.clientWidth;
    this.h = p.clientHeight;
    if (this.w > 1 && this.h > 1) {
      if (this.fitPending) { this.fitPending = false; this.fit(); }
      else if (this.seenW > 1 && this.seenH > 1) { this.tx += (this.w - this.seenW) / 2; this.ty += (this.h - this.seenH) / 2; } // same point stays at the centre
      this.seenW = this.w; this.seenH = this.h;
    }
    this.canvas.width = Math.max(1, Math.round(this.w * this.dpr));
    this.canvas.height = Math.max(1, Math.round(this.h * this.dpr));
    this.invalidate();
  }

  // ---------------------------------------------------------------- layout and animation

  setLayout(l: Layout): void {
    const prevB = this.layout.boxes;
    const prevG = new Map(this.layout.groups.map((g) => [g.id, g]));
    const first = prevB.size === 0 && this.layout.groups.length === 0;
    for (const g of l.groups) {
      const p = prevG.get(g.id);
      g.sx = p ? p.x : g.tx; g.sy = p ? p.y : g.ty;
    }
    const startOf = (b: Box): void => {
      const p = prevB.get(b.id);
      if (p) { b.sx = p.x; b.sy = p.y; }
      else if (b.parent) { b.sx = b.parent.sx + b.rx; b.sy = b.parent.sy + b.ry; }
      else { b.sx = b.tx; b.sy = b.ty; }
      for (const c of b.children) startOf(c);
    };
    for (const b of l.top) startOf(b);
    this.layout = l;
    if (first) { this.animEnd = 0; this.step(0, true); }
    else { this.animStart = performance.now(); this.animEnd = this.animStart + ANIM_MS; }
    this.invalidate();
  }

  private step(now: number, snap = false): void {
    const t = snap ? 1 : ease(Math.max(0, Math.min(1, (now - this.animStart) / Math.max(1, this.animEnd - this.animStart))));
    for (const g of this.layout.groups) { g.x = g.sx + (g.tx - g.sx) * t; g.y = g.sy + (g.ty - g.sy) * t; }
    for (const b of this.layout.boxes.values()) { b.x = b.sx + (b.tx - b.sx) * t; b.y = b.sy + (b.ty - b.sy) * t; }
  }

  // ---------------------------------------------------------------- camera

  toScreen(x: number, y: number): [number, number] { return [x * this.k + this.tx, y * this.k + this.ty]; }
  toWorld(sx: number, sy: number): [number, number] { return [(sx - this.tx) / this.k, (sy - this.ty) / this.k]; }

  fit(pad = 56): void {
    if (this.w <= 1 || this.h <= 1) { this.fitPending = true; return; } // hidden: it is applied when the map is shown again
    const b = this.layout.bounds;
    const bw = Math.max(1, b.x1 - b.x0);
    const bh = Math.max(1, b.y1 - b.y0);
    this.k = Math.max(0.12, Math.min(1.4, Math.min((this.w - pad * 2) / bw, (this.h - pad * 2) / bh)));
    this.tx = this.w / 2 - ((b.x0 + b.x1) / 2) * this.k;
    this.ty = this.h / 2 - ((b.y0 + b.y1) / 2) * this.k;
    this.invalidate();
  }

  focus(id: number, minK = 1): void {
    const b = this.layout.boxes.get(id);
    if (!b) return;
    this.k = Math.max(this.k, minK);
    this.tx = this.w / 2 - (b.tx + b.w / 2) * this.k;
    this.ty = this.h / 2 - (b.ty + Math.min(b.h, 120) / 2) * this.k;
    this.invalidate();
  }

  /** Pans as little as needed to show the box (its target rectangle); zooms out when the box is larger than the viewport. */
  ensureVisible(id: number, margin = 28): void {
    const b = this.layout.boxes.get(id);
    if (!b) return;
    if (b.w * this.k > this.w - 2 * margin || b.h * this.k > this.h - 2 * margin) {
      this.k = Math.max(0.12, Math.min(this.k, (this.w - 2 * margin) / b.w, (this.h - 2 * margin) / b.h));
    }
    const [x0, y0] = this.toScreen(b.tx, b.ty);
    const [x1, y1] = this.toScreen(b.tx + b.w, b.ty + b.h);
    if (x0 < margin) this.tx += margin - x0;
    else if (x1 > this.w - margin) this.tx -= x1 - (this.w - margin);
    if (y0 < margin) this.ty += margin - y0;
    else if (y1 > this.h - margin) this.ty -= y1 - (this.h - margin);
    this.invalidate();
  }

  /** Share of the top-level boxes whose centre is inside the viewport. */
  visibleFraction(): number {
    const top = this.layout.top;
    if (!top.length) return 1;
    let inside = 0;
    for (const b of top) {
      const [sx, sy] = this.toScreen(b.tx + b.w / 2, b.ty + b.h / 2);
      if (sx >= 0 && sy >= 0 && sx <= this.w && sy <= this.h) inside++;
    }
    return inside / top.length;
  }

  zoomBy(f: number, cx = this.w / 2, cy = this.h / 2): void {
    const nk = Math.max(0.08, Math.min(5, this.k * f));
    const [wx, wy] = this.toWorld(cx, cy);
    this.k = nk;
    this.tx = cx - wx * nk;
    this.ty = cy - wy * nk;
    this.invalidate();
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    this.userMoved = true;
    if (e.ctrlKey || e.metaKey) this.zoomBy(Math.exp(-e.deltaY * 0.01), e.offsetX, e.offsetY);
    else { this.tx -= e.deltaX; this.ty -= e.deltaY; this.invalidate(); }
  }

  // ---------------------------------------------------------------- hit testing

  private hitBox(wx: number, wy: number): Box | null {
    const inside = (b: Box) => wx >= b.x && wx <= b.x + b.w && wy >= b.y && wy <= b.y + b.h;
    const deep = (b: Box): Box | null => {
      if (!inside(b)) return null;
      for (let i = b.children.length - 1; i >= 0; i--) { const r = deep(b.children[i]); if (r) return r; }
      return b;
    };
    const top = this.layout.top;
    for (let i = top.length - 1; i >= 0; i--) { const r = deep(top[i]); if (r) return r; }
    return null;
  }

  private hitGroupHead(wx: number, wy: number): Group | null {
    for (const g of this.layout.groups) if (wx >= g.x && wx <= g.x + g.w && wy >= g.y && wy <= g.y + M.groupHead) return g;
    return null;
  }

  private inChevron(b: Box, wx: number, wy: number): boolean {
    return b.expandable && wx >= b.x + b.w - b.chevronW - 2 && wy <= b.y + b.headH;
  }
  private inSessionBadge(b: Box, wx: number, wy: number): boolean {
    const right = b.x + b.w - b.chevronW - 2;
    return b.sessionCount > 0 && wx >= right - b.sessionBadgeW && wx <= right && wy <= b.y + b.headH;
  }

  private topOf(b: Box): Box { let c = b; while (c.parent) c = c.parent; return c; }

  private shiftBox(b: Box, dx: number, dy: number): void {
    b.x += dx; b.y += dy; b.tx += dx; b.ty += dy; b.sx += dx; b.sy += dy;
    for (const c of b.children) this.shiftBox(c, dx, dy);
  }

  // ---------------------------------------------------------------- pointer

  private onDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    this.userMoved = true;
    this.canvas.setPointerCapture(e.pointerId);
    const [wx, wy] = this.toWorld(e.offsetX, e.offsetY);
    const hit = this.hitBox(wx, wy);
    if (hit) {
      const top = this.topOf(hit);
      this.drag = { type: 'box', box: top, hit, sx: e.offsetX, sy: e.offsetY, tx: this.tx, ty: this.ty, ox: top.x - wx, oy: top.y - wy, moved: false };
      return;
    }
    const g = this.hitGroupHead(wx, wy);
    if (g) {
      this.drag = { type: 'group', group: g, sx: e.offsetX, sy: e.offsetY, tx: this.tx, ty: this.ty, ox: g.x - wx, oy: g.y - wy, moved: false };
      return;
    }
    this.drag = { type: 'pan', sx: e.offsetX, sy: e.offsetY, tx: this.tx, ty: this.ty, ox: 0, oy: 0, moved: false };
    this.canvas.classList.add('grab');
  }

  private onMove(e: PointerEvent): void {
    this.mouse = { x: e.offsetX, y: e.offsetY };
    const [wx, wy] = this.toWorld(e.offsetX, e.offsetY);
    if (this.drag) {
      const dx = e.offsetX - this.drag.sx; const dy = e.offsetY - this.drag.sy;
      if (!this.drag.moved && Math.hypot(dx, dy) > 4) { this.drag.moved = true; if (this.drag.type !== 'pan') this.canvas.classList.add('grab'); }
      if (!this.drag.moved) return;
      if (this.drag.type === 'pan') { this.tx = this.drag.tx + dx; this.ty = this.drag.ty + dy; }
      else if (this.drag.type === 'box' && this.drag.box) {
        const b = this.drag.box;
        this.shiftBox(b, wx + this.drag.ox - b.x, wy + this.drag.oy - b.y);
      } else if (this.drag.type === 'group' && this.drag.group) {
        const g = this.drag.group;
        const ddx = wx + this.drag.ox - g.x; const ddy = wy + this.drag.oy - g.y;
        g.x += ddx; g.y += ddy; g.tx += ddx; g.ty += ddy; g.sx += ddx; g.sy += ddy;
        for (const b of g.boxes) if (!b.pinned) this.shiftBox(b, ddx, ddy);
      }
      this.invalidate();
      return;
    }
    const hit = this.hitBox(wx, wy);
    const hot = hit ? this.inChevron(hit, wx, wy) : false;
    if (hot !== this.chevronHot) { this.chevronHot = hot; this.invalidate(); }
    this.canvas.classList.toggle('pointer', hit !== null);
    const id = hit ? hit.id : null;
    if (id !== this.store.hovered) {
      this.hoverSince = performance.now();
      clearTimeout(this.hoverTimer);
      if (id !== null) this.hoverTimer = window.setTimeout(() => this.invalidate(), 420);
    }
    this.store.hover(id);
    this.invalidate();
  }

  private onUp(e: PointerEvent): void {
    const d = this.drag;
    this.drag = null;
    this.canvas.classList.remove('grab');
    if (!d) return;
    if (d.moved) {
      if (d.type === 'box' && d.box) this.cb.onPin(d.box.key, d.box.x, d.box.y);
      else if (d.type === 'group' && d.group) this.cb.onPin(d.group.key, d.group.x, d.group.y);
    } else if (d.type === 'box' && d.hit) {
      const [wx, wy] = this.toWorld(e.offsetX, e.offsetY);
      if (d.hit.node.cls === 'session') {
        const session = this.store.graphSession(d.hit.id);
        if (session) this.cb.onSession(session.id);
      }
      else if (this.inSessionBadge(d.hit, wx, wy)) this.cb.onToggleSessions(d.hit.id);
      else if (this.inChevron(d.hit, wx, wy)) this.cb.onToggleExpand(d.hit.id);
      else this.cb.onSelect(d.hit.id);
    } else {
      this.cb.onSelect(null);
    }
    this.invalidate();
  }

  // ---------------------------------------------------------------- drawing

  private rr(x: number, y: number, w: number, h: number, r: number): void {
    const ctx = this.ctx;
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  private draw(): void {
    const { ctx, k, colors: c } = this;
    const store = this.store;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.fillStyle = c.stage;
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.save();
    ctx.translate(this.tx, this.ty);
    ctx.scale(k, k);
    const focusId = store.selected ?? store.hovered;
    const focus = focusId !== null ? new Set([focusId, ...store.neighborsOf(focusId)]) : null;
    const fonts = this.fonts();
    for (const g of this.layout.groups) this.drawGroup(g, fonts);
    for (const b of this.layout.top) this.drawBox(b, fonts, focus);
    this.drawEdges(focus, focusId);
    this.drawSessionLinks();
    ctx.restore();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawTooltip();
  }

  private drawGroup(g: Group, fonts: Fonts): void {
    const { ctx, colors: c } = this;
    this.rr(g.x, g.y, g.w, g.h, 10);
    ctx.fillStyle = c.g1;
    ctx.fill();
    ctx.font = fonts.group;
    if ('letterSpacing' in ctx) (ctx as unknown as { letterSpacing: string }).letterSpacing = '0.12em';
    ctx.fillStyle = c.g4;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(g.name.toUpperCase(), g.x + M.groupPad, g.y + M.groupHead / 2 + 1);
    if ('letterSpacing' in ctx) (ctx as unknown as { letterSpacing: string }).letterSpacing = '0px';
    ctx.font = ui`10px ${c.mono}`;
    ctx.textAlign = 'right';
    ctx.fillText(String(g.boxes.length), g.x + g.w - M.groupPad, g.y + M.groupHead / 2 + 1);
  }

  private drawBox(b: Box, fonts: Fonts, focus: Set<number> | null): void {
    const { ctx, colors: c } = this;
    const store = this.store;
    const n = b.node;
    const session = store.graphSession(b.id);
    const sel = b.id === store.selected || (session?.id === store.activeSession);
    const hov = b.id === store.hovered;
    const dim = focus !== null && !focus.has(b.id) && !(session && session.nodeId != null && focus.has(session.nodeId));
    const faded = b.status === 'copy' || b.status === 'archive';
    ctx.globalAlpha = dim ? 0.3 : 1;
    let fill: string | null = c.bg;
    if (b.expanded && b.depth % 2 === 1) fill = c.g1;
    if (b.status === 'data' && !b.expanded) fill = c.g2;
    if (n.cls === 'rest') fill = null;
    if (sel && !b.expanded) fill = c.fg;
    let stroke = c.fg; let lw = 1; let dash: number[] = [];
    if (b.isFile) stroke = c.g3;
    if (b.isProject) lw = 1.4;
    if (faded) { stroke = c.g4; dash = [4, 3]; }
    if (n.kind === 'external') { stroke = c.g4; dash = [2, 2]; }
    if (n.aggregate && n.cls !== 'rest') { stroke = c.g4; dash = [1, 2]; }
    if (n.cls === 'rest') { stroke = c.g3; dash = [2, 2]; }
    if (hov && !sel) { stroke = c.fg; lw = 1.5; }
    if (sel) { stroke = c.fg; lw = 2; dash = []; }
    this.rr(b.x, b.y, b.w, b.h, 5);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    ctx.setLineDash(dash);
    ctx.lineWidth = lw;
    ctx.strokeStyle = stroke;
    ctx.stroke();
    ctx.setLineDash([]);
    if (sel && b.expanded) {
      // selected and open: only the title band is inverted, the children keep the normal background
      ctx.save();
      this.rr(b.x, b.y, b.w, b.h, 5);
      ctx.clip();
      ctx.fillStyle = c.fg;
      ctx.fillRect(b.x, b.y, b.w, b.headH);
      ctx.restore();
    }
    if (b.expanded) {
      ctx.beginPath();
      ctx.moveTo(b.x, b.y + b.headH);
      ctx.lineTo(b.x + b.w, b.y + b.headH);
      ctx.lineWidth = 1;
      ctx.strokeStyle = sel ? c.g4 : c.g2;
      ctx.stroke();
    }
    const titleH = b.isFile ? M.fileH : M.boxH;
    const ty = b.y + titleH / 2 + 0.5;
    const textColor = sel ? c.bg : n.cls === 'rest' || faded ? c.g4 : b.isFile ? c.g5 : c.fg;
    let titleRight = b.x + b.w - (b.expandable ? b.chevronW + 2 : M.padX) - b.sessionBadgeW;
    if (b.tag) {
      ctx.save();
      ctx.font = fonts.tag;
      if ('letterSpacing' in ctx) (ctx as unknown as { letterSpacing: string }).letterSpacing = '0.08em';
      titleRight -= ctx.measureText(b.tag.toUpperCase()).width + 8;
      ctx.restore();
    }
    if (b.glyph) {
      const size = glyphSize(b.isFile);
      ctx.strokeStyle = sel ? c.bg : textColor === c.fg ? c.g5 : textColor;
      drawGlyph(ctx, b.glyph, b.x + M.padX, ty - size / 2, size);
    }
    ctx.font = b.font;
    ctx.fillStyle = textColor;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(fitText(ctx, b.label, titleRight - b.x - M.padX - b.glyphW), b.x + M.padX + b.glyphW, ty);
    if (b.sub) {
      ctx.font = fonts.sub;
      ctx.fillStyle = sel ? c.g3 : c.g4;
      ctx.fillText(fitText(ctx, b.sub, b.w - 2 * M.padX), b.x + M.padX, b.y + titleH + M.subH / 2 - 1);
    }
    let right = b.x + b.w - M.padX;
    if (b.expandable) {
      ctx.font = fonts.small;
      ctx.textAlign = 'right';
      ctx.fillStyle = sel ? c.bg : hov && this.chevronHot ? c.fg : c.g4;
      ctx.fillText(b.filesExpanded ? '▾' : this.store.filters.compact ? '▸' : ui`▸ ${n.childCount.toLocaleString(tr('it-IT'))}`, b.x + b.w - 8, ty);
      right = b.x + b.w - b.chevronW - 2;
    }
    if (b.sessionCount) {
      ctx.font = fonts.small; ctx.textAlign = 'right'; ctx.fillStyle = sel ? c.bg : c.g4;
      ctx.fillText(ui`◈ ${b.sessionCount}`, right - 5, ty);
      right -= b.sessionBadgeW;
    }
    if (b.tag) {
      ctx.font = fonts.tag;
      ctx.textAlign = 'right';
      ctx.fillStyle = sel ? c.g3 : c.g4;
      if ('letterSpacing' in ctx) (ctx as unknown as { letterSpacing: string }).letterSpacing = '0.08em';
      ctx.fillText(b.tag.toUpperCase(), right, ty);
      if ('letterSpacing' in ctx) (ctx as unknown as { letterSpacing: string }).letterSpacing = '0px';
    }
    ctx.globalAlpha = 1;
    for (const ch of b.children) this.drawBox(ch, fonts, focus);
  }

  private curve(a: Box, b: Box): Curve {
    const ah = Math.min(a.h, a.headH); const bh = Math.min(b.h, b.headH);
    const acx = a.x + a.w / 2; const acy = a.y + ah / 2;
    const bcx = b.x + b.w / 2; const bcy = b.y + bh / 2;
    const dx = bcx - acx; const dy = bcy - acy;
    if (Math.abs(dx) >= Math.abs(dy) * 0.9) {
      const s = dx >= 0 ? 1 : -1;
      const x0 = s > 0 ? a.x + a.w : a.x; const y0 = acy;
      const x1 = s > 0 ? b.x : b.x + b.w; const y1 = bcy;
      const off = Math.max(28, Math.abs(x1 - x0) * 0.45) * s;
      return { x0, y0, x1, y1, c0x: x0 + off, c0y: y0, c1x: x1 - off, c1y: y1 };
    }
    const s = dy >= 0 ? 1 : -1;
    const x0 = acx; const y0 = s > 0 ? a.y + a.h : a.y;
    const x1 = bcx; const y1 = s > 0 ? b.y : b.y + b.h;
    const off = Math.max(28, Math.abs(y1 - y0) * 0.45) * s;
    return { x0, y0, x1, y1, c0x: x0, c0y: y0 + off, c1x: x1, c1y: y1 - off };
  }

  private drawEdges(focus: Set<number> | null, focusId: number | null): void {
    const mode = this.store.filters.edgeMode;
    if (mode === 'off') return;
    const boxes = this.layout.boxes;
    const hot: { e: GraphEdge; a: Box; b: Box }[] = [];
    for (const e of this.store.edges) {
      const a = boxes.get(e.src); const b = boxes.get(e.dst);
      if (!a || !b) continue;
      const isHot = focus !== null && (e.src === focusId || e.dst === focusId);
      if (isHot) { hot.push({ e, a, b }); continue; }
      if (mode === 'none') continue;
      const alpha = focus ? (mode === 'all' ? 0.12 : 0.04) : mode === 'all' ? (e.verified ? 0.7 : 0.5) : (e.verified ? 0.11 : 0.08);
      this.drawEdge(e, a, b, alpha, false);
    }
    for (const x of hot) this.drawEdge(x.e, x.a, x.b, 1, true);
  }

  private drawSessionLinks(): void {
    const { ctx, colors: c } = this;
    const boxFor = (nodeId: number, sessionId: string | null) => (sessionId ? this.layout.boxes.get(this.store.sessionIds.get(sessionId)!) : undefined) ?? this.layout.boxes.get(nodeId);
    const pairs: { a: Box; b: Box; internal: boolean }[] = [];
    for (const s of this.store.sessions.values()) {
      if (!s.alive || !s.parentId || s.nodeId == null) continue;
      const a = this.layout.boxes.get(this.store.sessionIds.get(s.parentId)!);
      const b = this.layout.boxes.get(this.store.sessionIds.get(s.id)!);
      if (a && b) pairs.push({ a, b, internal: true });
    }
    for (const link of this.store.sessionLinks) {
      // A session-specific channel expires with its process; node channels persist.
      if ((link.srcSessionId && !this.store.sessions.get(link.srcSessionId)?.alive) || (link.dstSessionId && !this.store.sessions.get(link.dstSessionId)?.alive)) continue;
      const a = boxFor(link.srcNodeId, link.srcSessionId), b = boxFor(link.dstNodeId, link.dstSessionId);
      if (a && b && a !== b) pairs.push({ a, b, internal: false });
    }
    for (const { a, b, internal } of pairs) {
      const hot = this.store.selected === a.id || this.store.selected === b.id || this.store.selected === a.node.parentId || this.store.selected === b.node.parentId;
      if (internal && !hot) continue;
      const curve = this.curve(a, b);
      ctx.globalAlpha = hot ? .8 : .22; ctx.lineWidth = 1 / this.k; ctx.strokeStyle = c.fg;
      ctx.setLineDash(internal ? [2, 4] : [8, 4]);
      ctx.beginPath(); ctx.moveTo(curve.x0, curve.y0); ctx.bezierCurveTo(curve.c0x, curve.c0y, curve.c1x, curve.c1y, curve.x1, curve.y1); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
    }
  }

  private drawEdge(e: GraphEdge, a: Box, b: Box, alpha: number, hot: boolean): void {
    const { ctx, k, colors: c } = this;
    const g = this.curve(a, b);
    const manual = e.origin === 'user' || e.kind === 'manual';
    ctx.globalAlpha = alpha;
    ctx.lineWidth = Math.max(0.6 / k, hot ? Math.min(3.5, 1.3 + 0.5 * Math.log2(e.count + 1)) : 1);
    ctx.strokeStyle = hot || manual ? c.fg : c.g4;
    ctx.setLineDash(!e.verified ? [5, 4] : e.kind === 'policy' ? [1.5, 3] : []);
    ctx.beginPath();
    ctx.moveTo(g.x0, g.y0);
    ctx.bezierCurveTo(g.c0x, g.c0y, g.c1x, g.c1y, g.x1, g.y1);
    ctx.stroke();
    ctx.setLineDash([]);
    if (hot && !UNDIRECTED.has(e.kind)) {
      const dx = g.x1 - g.c1x; const dy = g.y1 - g.c1y; const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len; const uy = dy / len; const s = 6;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      ctx.moveTo(g.x1, g.y1);
      ctx.lineTo(g.x1 - ux * s * 1.7 + uy * s * 0.8, g.y1 - uy * s * 1.7 - ux * s * 0.8);
      ctx.lineTo(g.x1 - ux * s * 1.7 - uy * s * 0.8, g.y1 - uy * s * 1.7 + ux * s * 0.8);
      ctx.closePath();
      ctx.fill();
    }
    if (hot && e.count > 1) {
      const mx = (g.x0 + 3 * g.c0x + 3 * g.c1x + g.x1) / 8; const my = (g.y0 + 3 * g.c0y + 3 * g.c1y + g.y1) / 8;
      const label = ui`×${e.count.toLocaleString(tr('it-IT'))}`;
      ctx.font = ui`10px ${c.mono}`;
      const w = ctx.measureText(label).width + 8;
      ctx.fillStyle = c.bg;
      ctx.fillRect(mx - w / 2, my - 7, w, 14);
      ctx.fillStyle = c.fg;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, mx, my + 0.5);
    }
    ctx.globalAlpha = 1;
  }

  private drawTooltip(): void {
    const { ctx, colors: c } = this;
    const h = this.store.hovered;
    if (h === null || !this.mouse || this.drag !== null || performance.now() - this.hoverSince < 420) return;
    const b = this.layout.boxes.get(h);
    if (!b || b.node.cls === 'rest') return;
    const n = b.node;
    const lines = [shortPath(n.path)];
    if (b.sessionCount) lines.push(ui`◈ ${b.sessionCount} sessioni · clic sul badge per aprire o richiudere`);
    if (b.label !== n.name) lines.unshift(n.name);
    if (n.kind === 'dir' && n.files > 0) lines.push(ui`${n.files.toLocaleString(tr('it-IT'))} file`);
    ctx.font = ui`11px ${c.mono}`;
    const w = Math.min(560, Math.max(...lines.map((l) => ctx.measureText(l).width)) + 16);
    const lh = 16; const hh = lines.length * lh + 6;
    let x = this.mouse.x + 14; let y = this.mouse.y + 18;
    if (x + w > this.w) x = this.w - w - 6;
    if (y + hh > this.h) y = this.mouse.y - hh - 8;
    ctx.fillStyle = c.fg;
    ctx.fillRect(x, y, w, hh);
    ctx.fillStyle = c.bg;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    lines.forEach((l, i) => ctx.fillText(l.length > 76 ? '…' + l.slice(-75) : l, x + 8, y + 3 + lh * i + lh / 2));
  }
}
