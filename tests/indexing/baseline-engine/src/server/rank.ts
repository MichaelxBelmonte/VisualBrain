// Importance of nodes: PageRank on the dependency edges, degree, size, recency; for folders also how many edges cross their boundary.
import type { Db } from './db.ts';

interface NodeRow { id: number; kind: string; cls: string; parent_id: number | null; size: number; bytes: number; files: number; mtime: number; aggregate: number }
interface EdgeRow { src: number; dst: number; kind: string; confidence: number }

function percentile(values: Map<number, number>): Map<number, number> {
  const entries = [...values.entries()].sort((a, b) => a[1] - b[1]);
  const out = new Map<number, number>();
  const n = entries.length;
  if (n === 0) return out;
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && entries[j + 1][1] === entries[i][1]) j++;
    const r = n === 1 ? 1 : (i + j) / 2 / (n - 1);
    for (let k = i; k <= j; k++) out.set(entries[k][0], r);
    i = j + 1;
  }
  return out;
}

export function rank(db: Db, progress?: (m: string) => void): void {
  const nodes = db.all<NodeRow>("SELECT id, kind, cls, parent_id, size, bytes, files, mtime, aggregate FROM nodes WHERE deleted = 0");
  const edges = db.all<EdgeRow>('SELECT src, dst, kind, confidence FROM edges WHERE hidden = 0');
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const indeg = new Map<number, number>();
  const outdeg = new Map<number, number>();
  const wout = new Map<number, number>();
  for (const e of edges) {
    if (!byId.has(e.src) || !byId.has(e.dst)) continue;
    outdeg.set(e.src, (outdeg.get(e.src) ?? 0) + 1);
    indeg.set(e.dst, (indeg.get(e.dst) ?? 0) + 1);
    wout.set(e.src, (wout.get(e.src) ?? 0) + e.confidence);
  }

  // PageRank restricted to nodes touched by an edge
  const touched = new Set<number>([...indeg.keys(), ...outdeg.keys()]);
  const pr = new Map<number, number>();
  const n = touched.size || 1;
  for (const id of touched) pr.set(id, 1 / n);
  const d = 0.85;
  for (let it = 0; it < 25; it++) {
    const next = new Map<number, number>();
    let dangling = 0;
    for (const id of touched) if (!wout.has(id)) dangling += pr.get(id) ?? 0;
    for (const id of touched) next.set(id, (1 - d) / n + d * dangling / n);
    for (const e of edges) {
      if (!touched.has(e.src) || !touched.has(e.dst)) continue;
      const share = (pr.get(e.src) ?? 0) * e.confidence / (wout.get(e.src) ?? 1);
      next.set(e.dst, (next.get(e.dst) ?? 0) + d * share);
    }
    for (const [k, v] of next) pr.set(k, v);
  }

  // boundary crossings per folder
  const ancestors = (id: number): number[] => {
    const out: number[] = [];
    let cur = byId.get(id)?.parent_id ?? null;
    let guard = 0;
    while (cur !== null && guard++ < 64) { out.push(cur); cur = byId.get(cur)?.parent_id ?? null; }
    return out;
  };
  const cross = new Map<number, number>();
  for (const e of edges) {
    if (!byId.has(e.src) || !byId.has(e.dst)) continue;
    const a = ancestors(e.src);
    const b = ancestors(e.dst);
    const bs = new Set(b);
    const as = new Set(a);
    for (const x of a) if (!bs.has(x)) cross.set(x, (cross.get(x) ?? 0) + 1);
    for (const x of b) if (!as.has(x)) cross.set(x, (cross.get(x) ?? 0) + 1);
  }

  const now = Date.now();
  const recency = (mtime: number) => Math.exp(-Math.max(0, now - mtime) / (90 * 86400e3));
  const files = nodes.filter((x) => x.kind === 'file');
  const dirs = nodes.filter((x) => x.kind === 'dir');
  const others = nodes.filter((x) => x.kind !== 'file' && x.kind !== 'dir');
  const prFile = percentile(new Map(files.map((f) => [f.id, pr.get(f.id) ?? 0])));
  const degFile = percentile(new Map(files.map((f) => [f.id, (indeg.get(f.id) ?? 0) + (outdeg.get(f.id) ?? 0)])));
  const sizeFile = percentile(new Map(files.map((f) => [f.id, f.size])));
  const filesDir = percentile(new Map(dirs.map((x) => [x.id, x.files])));
  const bytesDir = percentile(new Map(dirs.map((x) => [x.id, x.bytes])));
  const crossDir = percentile(new Map(dirs.map((x) => [x.id, cross.get(x.id) ?? 0])));
  const degOther = percentile(new Map(others.map((x) => [x.id, (indeg.get(x.id) ?? 0) + (outdeg.get(x.id) ?? 0)])));
  const clsBonus: Record<string, number> = { code: 1, doc: 1, notebook: 0.9, config: 0.6, sheet: 0.5, data: 0.3, image: 0.2, video: 0.3, archive: 0.2, binary: 0.05, log: 0.2, other: 0.2, secret: 0.3 };

  const upd = db.prepare('UPDATE nodes SET importance = ?, pagerank = ?, indeg = ?, outdeg = ? WHERE id = ?');
  db.tx(() => {
    for (const f of files) {
      const deg = (indeg.get(f.id) ?? 0) + (outdeg.get(f.id) ?? 0);
      let imp = 0.40 * (deg ? (prFile.get(f.id) ?? 0) : 0) + 0.25 * (deg ? (degFile.get(f.id) ?? 0) : 0) + 0.15 * (sizeFile.get(f.id) ?? 0) + 0.10 * recency(f.mtime) + 0.10 * (clsBonus[f.cls] ?? 0.2);
      upd.run(Math.round(imp * 1000) / 1000, pr.get(f.id) ?? 0, indeg.get(f.id) ?? 0, outdeg.get(f.id) ?? 0, f.id);
    }
    for (const x of dirs) {
      let imp = 0.30 * (filesDir.get(x.id) ?? 0) + 0.15 * (bytesDir.get(x.id) ?? 0) + 0.35 * (crossDir.get(x.id) ?? 0) + 0.10 * (x.cls === 'project' ? 1 : 0) + 0.10 * recency(x.mtime);
      if (x.cls === 'vendor') imp *= 0.3;
      else if (x.cls === 'dump') imp *= 0.7;
      upd.run(Math.round(imp * 1000) / 1000, pr.get(x.id) ?? 0, indeg.get(x.id) ?? 0, outdeg.get(x.id) ?? 0, x.id);
    }
    for (const x of others) {
      const imp = x.kind === 'symlink' ? 0.12 : 0.8 * (degOther.get(x.id) ?? 0);
      upd.run(Math.round(imp * 1000) / 1000, pr.get(x.id) ?? 0, indeg.get(x.id) ?? 0, outdeg.get(x.id) ?? 0, x.id);
    }
  });
  progress?.(`pesi calcolati su ${nodes.length} nodi e ${edges.length} archi`);
}
