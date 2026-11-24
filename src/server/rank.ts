// Importance of nodes: PageRank on the dependency edges, degree, size, recency; for folders also how many edges cross their boundary.
import type { Db } from './db.ts';

export interface NodeRow { id: number; kind: string; cls: string; parent_id: number | null; size: number; bytes: number; files: number; mtime: number; aggregate: number }
export interface EdgeRow { src: number; dst: number; kind: string; confidence: number }

/** Rank in [0, 1] of each value (ties share their mean rank), in the order of `values`. */
function percentile(values: Float64Array): Float64Array {
  const n = values.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  // stable by value: equal values keep their order
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => (values[a] - values[b]) || (a - b));
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && values[order[j + 1]] === values[order[i]]) j++;
    const r = n === 1 ? 1 : (i + j) / 2 / (n - 1);
    for (let k = i; k <= j; k++) out[order[k]] = r;
    i = j + 1;
  }
  return out;
}

export interface Ranked { importance: number; pagerank: number; indeg: number; outdeg: number }

const clsBonus: Record<string, number> = { code: 1, doc: 1, notebook: 0.9, config: 0.6, sheet: 0.5, data: 0.3, image: 0.2, video: 0.3, archive: 0.2, binary: 0.05, log: 0.2, other: 0.2, secret: 0.3 };
const recent = (mtime: number, now: number) => Math.exp(-Math.max(0, now - mtime) / (90 * 86400e3));

/**
 * The ranking itself, on rows already in memory: what `rank` stores. The cache uses it, without edges, to show a first map
 * before the database has been ranked (the same function, so what is shown is what the first ranking would store).
 * Nodes are addressed by their position in `nodes`, in typed arrays; sums run in the order of the edges, so the result does not
 * depend on how it is stored.
 */
export function computeRank(nodes: NodeRow[], edges: Iterable<EdgeRow> & { length?: number }, now = Date.now()): Map<number, Ranked> {
  const N = nodes.length;
  let maxId = 0;
  for (const x of nodes) if (x.id > maxId) maxId = x.id;
  const pos = new Int32Array(maxId + 1).fill(-1);
  for (let i = 0; i < N; i++) pos[nodes[i].id] = i;
  const at = (id: number | null): number => (id === null || id < 0 || id > maxId ? -1 : pos[id]);

  // edges between known nodes, as positions
  // `edges` may be rows read one at a time: `length` is then only a size hint, and the arrays grow past it if needed
  let cap = Math.max(16, edges.length ?? 0);
  let src = new Int32Array(cap), dst = new Int32Array(cap), conf = new Float64Array(cap);
  let E = 0;
  for (const e of edges) {
    const s = at(e.src), t = at(e.dst);
    if (s < 0 || t < 0) continue;
    if (E === cap) {
      cap *= 2;
      const s2 = new Int32Array(cap), d2 = new Int32Array(cap), c2 = new Float64Array(cap);
      s2.set(src); d2.set(dst); c2.set(conf); src = s2; dst = d2; conf = c2;
    }
    src[E] = s; dst[E] = t; conf[E] = e.confidence; E++;
  }
  const indeg = new Int32Array(N), outdeg = new Int32Array(N), wout = new Float64Array(N);
  // nodes touched by an edge, in the order they were first met as a target, then as a source
  const seenIn = new Uint8Array(N), seenOut = new Uint8Array(N);
  const asDst: number[] = [], asSrc: number[] = [];
  for (let k = 0; k < E; k++) {
    const s = src[k], t = dst[k];
    if (!seenOut[s]) { seenOut[s] = 1; asSrc.push(s); }
    if (!seenIn[t]) { seenIn[t] = 1; asDst.push(t); }
    outdeg[s]++; indeg[t]++; wout[s] += conf[k];
  }
  const touched = asDst.slice();
  for (const s of asSrc) if (!seenIn[s]) touched.push(s);

  // PageRank restricted to nodes touched by an edge
  let pr = new Float64Array(N), next = new Float64Array(N);
  const n = touched.length || 1;
  for (const i of touched) pr[i] = 1 / n;
  const d = 0.85;
  for (let it = 0; it < 25; it++) {
    let dangling = 0;
    for (const i of touched) if (!outdeg[i]) dangling += pr[i];
    const base = (1 - d) / n + d * dangling / n;
    for (const i of touched) next[i] = base;
    for (let k = 0; k < E; k++) {
      const s = src[k];
      next[dst[k]] += d * (pr[s] * conf[k] / wout[s]);
    }
    const t = pr; pr = next; next = t;
  }

  // boundary crossings per folder: ancestors of one end that are not ancestors of the other
  const parent = new Int32Array(N);
  for (let i = 0; i < N; i++) parent[i] = at(nodes[i].parent_id);
  const cross = new Float64Array(N);
  const markA = new Int32Array(N), markB = new Int32Array(N);
  const upA = new Int32Array(64), upB = new Int32Array(64);
  const climb = (i: number, mark: Int32Array, up: Int32Array, stamp: number): number => {
    let len = 0;
    for (let cur = parent[i]; cur >= 0 && len < 64; cur = parent[cur]) { mark[cur] = stamp; up[len++] = cur; }
    return len;
  };
  for (let k = 0; k < E; k++) {
    const stamp = k + 1;
    const la = climb(src[k], markA, upA, stamp), lb = climb(dst[k], markB, upB, stamp);
    for (let j = 0; j < la; j++) if (markB[upA[j]] !== stamp) cross[upA[j]]++;
    for (let j = 0; j < lb; j++) if (markA[upB[j]] !== stamp) cross[upB[j]]++;
  }

  const recency = (mtime: number) => recent(mtime, now);
  const files: number[] = [], dirs: number[] = [], others: number[] = [];
  for (let i = 0; i < N; i++) (nodes[i].kind === 'file' ? files : nodes[i].kind === 'dir' ? dirs : others).push(i);
  const of = (list: number[], value: (i: number) => number) => percentile(Float64Array.from(list, value));
  const prFile = of(files, (i) => pr[i]);
  const degFile = of(files, (i) => indeg[i] + outdeg[i]);
  const sizeFile = of(files, (i) => nodes[i].size);
  const filesDir = of(dirs, (i) => nodes[i].files);
  const bytesDir = of(dirs, (i) => nodes[i].bytes);
  const crossDir = of(dirs, (i) => cross[i]);
  const degOther = of(others, (i) => indeg[i] + outdeg[i]);

  const out = new Map<number, Ranked>();
  const put = (i: number, imp: number) => out.set(nodes[i].id, { importance: Math.round(imp * 1000) / 1000, pagerank: pr[i], indeg: indeg[i], outdeg: outdeg[i] });
  files.forEach((i, k) => {
    const f = nodes[i];
    const deg = indeg[i] + outdeg[i];
    put(i, 0.40 * (deg ? prFile[k] : 0) + 0.25 * (deg ? degFile[k] : 0) + 0.15 * sizeFile[k] + 0.10 * recency(f.mtime) + 0.10 * (clsBonus[f.cls] ?? 0.2));
  });
  dirs.forEach((i, k) => {
    const x = nodes[i];
    let imp = 0.30 * filesDir[k] + 0.15 * bytesDir[k] + 0.35 * crossDir[k] + 0.10 * (x.cls === 'project' ? 1 : 0) + 0.10 * recency(x.mtime);
    if (x.cls === 'vendor') imp *= 0.3;
    else if (x.cls === 'dump') imp *= 0.7;
    put(i, imp);
  });
  others.forEach((i, k) => put(i, nodes[i].kind === 'symlink' ? 0.12 : 0.8 * degOther[k]));
  return out;
}
export function rank(db: Db, progress?: (m: string) => void): void {
  const nodes = db.all<NodeRow & Ranked>('SELECT id, kind, cls, parent_id, size, bytes, files, mtime, aggregate, importance, pagerank, indeg, outdeg FROM nodes WHERE deleted = 0');
  // the edges only fill typed arrays: read one at a time, the count is just the initial size
  const visible = 'FROM edges WHERE hidden = 0';
  const edges = { length: Number(db.get<{ c: number }>(`SELECT COUNT(*) c ${visible}`)?.c ?? 0), [Symbol.iterator]: () => db.iterate<EdgeRow>(`SELECT src, dst, kind, confidence ${visible}`) };
  const ranked = computeRank(nodes, edges);
  // unchanged weights are not written again (most of them, after a pass that touched a few files)
  const upd = db.prepare('UPDATE nodes SET importance = ?, pagerank = ?, indeg = ?, outdeg = ? WHERE id = ?');
  db.tx(() => {
    for (const n of nodes) {
      const x = ranked.get(n.id)!;
      if (n.importance === x.importance && n.pagerank === x.pagerank && n.indeg === x.indeg && n.outdeg === x.outdeg) continue;
      upd.run(x.importance, x.pagerank, x.indeg, x.outdeg, n.id);
    }
  });
  progress?.(`pesi calcolati su ${nodes.length} nodi e ${edges.length} archi`);
}

/**
 * A weight for the nodes that appeared since the last ranking, until the next one: the formula of computeRank with every
 * rank among the other nodes at its midpoint (and no edge across a new folder), so a new file is neither hidden as
 * unranked nor placed above the ones that were measured. Rows that already have a weight (a path that came back) keep it.
 */
export function provisionalRank(db: Db, ids: number[], now = Date.now()): void {
  const rows = db.all<{ id: number; kind: string; cls: string; mtime: number }>(
    'SELECT id, kind, cls, mtime FROM nodes WHERE deleted = 0 AND importance = 0 AND id IN (SELECT value FROM json_each(?))', JSON.stringify(ids));
  if (!rows.length) return;
  const into = db.prepare('SELECT COUNT(*) c FROM edges INDEXED BY edges_dst WHERE dst = ? AND hidden = 0');
  const from = db.prepare('SELECT COUNT(*) c FROM edges INDEXED BY edges_src WHERE src = ? AND hidden = 0');
  const upd = db.prepare('UPDATE nodes SET importance = ?, indeg = ?, outdeg = ? WHERE id = ?');
  db.tx(() => {
    for (const r of rows) {
      const indeg = Number((into.get(r.id) as { c: number }).c), outdeg = Number((from.get(r.id) as { c: number }).c);
      let imp: number;
      if (r.kind === 'file') imp = (indeg + outdeg ? 0.65 * 0.5 : 0) + 0.15 * 0.5 + 0.10 * recent(r.mtime, now) + 0.10 * (clsBonus[r.cls] ?? 0.2);
      else if (r.kind === 'dir') imp = (0.45 * 0.5 + 0.10 * (r.cls === 'project' ? 1 : 0) + 0.10 * recent(r.mtime, now)) * (r.cls === 'vendor' ? 0.3 : r.cls === 'dump' ? 0.7 : 1);
      else imp = r.kind === 'symlink' ? 0.12 : 0;
      upd.run(Math.round(imp * 1000) / 1000, indeg, outdeg, r.id);
    }
  });
}
