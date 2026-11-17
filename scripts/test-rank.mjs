// computeRank on typed arrays must give exactly what the plain version (Maps keyed by id, kept here as the reference) gave:
// same PageRank sums in the same order, same crossings, same percentile ties. Random graphs with the awkward cases on purpose.
// Uso: node scripts/test-rank.mjs — nessun database.
import assert from 'node:assert/strict';
import { computeRank } from '../src/server/rank.ts';

function percentile(values) {
  const entries = [...values.entries()].sort((a, b) => a[1] - b[1]);
  const out = new Map();
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

function reference(nodes, edges, now) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const indeg = new Map(), outdeg = new Map(), wout = new Map();
  for (const e of edges) {
    if (!byId.has(e.src) || !byId.has(e.dst)) continue;
    outdeg.set(e.src, (outdeg.get(e.src) ?? 0) + 1);
    indeg.set(e.dst, (indeg.get(e.dst) ?? 0) + 1);
    wout.set(e.src, (wout.get(e.src) ?? 0) + e.confidence);
  }
  const touched = new Set([...indeg.keys(), ...outdeg.keys()]);
  const pr = new Map();
  const n = touched.size || 1;
  for (const id of touched) pr.set(id, 1 / n);
  const d = 0.85;
  for (let it = 0; it < 25; it++) {
    const next = new Map();
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
  const ancestors = (id) => {
    const out = [];
    let cur = byId.get(id)?.parent_id ?? null;
    let guard = 0;
    while (cur !== null && guard++ < 64) { out.push(cur); cur = byId.get(cur)?.parent_id ?? null; }
    return out;
  };
  const cross = new Map();
  for (const e of edges) {
    if (!byId.has(e.src) || !byId.has(e.dst)) continue;
    const a = ancestors(e.src), b = ancestors(e.dst);
    const bs = new Set(b), as = new Set(a);
    for (const x of a) if (!bs.has(x)) cross.set(x, (cross.get(x) ?? 0) + 1);
    for (const x of b) if (!as.has(x)) cross.set(x, (cross.get(x) ?? 0) + 1);
  }
  const recency = (mtime) => Math.exp(-Math.max(0, now - mtime) / (90 * 86400e3));
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
  const clsBonus = { code: 1, doc: 1, notebook: 0.9, config: 0.6, sheet: 0.5, data: 0.3, image: 0.2, video: 0.3, archive: 0.2, binary: 0.05, log: 0.2, other: 0.2, secret: 0.3 };
  const out = new Map();
  const put = (id, imp) => out.set(id, { importance: Math.round(imp * 1000) / 1000, pagerank: pr.get(id) ?? 0, indeg: indeg.get(id) ?? 0, outdeg: outdeg.get(id) ?? 0 });
  for (const f of files) {
    const deg = (indeg.get(f.id) ?? 0) + (outdeg.get(f.id) ?? 0);
    put(f.id, 0.40 * (deg ? (prFile.get(f.id) ?? 0) : 0) + 0.25 * (deg ? (degFile.get(f.id) ?? 0) : 0) + 0.15 * (sizeFile.get(f.id) ?? 0) + 0.10 * recency(f.mtime) + 0.10 * (clsBonus[f.cls] ?? 0.2));
  }
  for (const x of dirs) {
    let imp = 0.30 * (filesDir.get(x.id) ?? 0) + 0.15 * (bytesDir.get(x.id) ?? 0) + 0.35 * (crossDir.get(x.id) ?? 0) + 0.10 * (x.cls === 'project' ? 1 : 0) + 0.10 * recency(x.mtime);
    if (x.cls === 'vendor') imp *= 0.3;
    else if (x.cls === 'dump') imp *= 0.7;
    put(x.id, imp);
  }
  for (const x of others) put(x.id, x.kind === 'symlink' ? 0.12 : 0.8 * (degOther.get(x.id) ?? 0));
  return out;
}

let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (list) => list[Math.floor(rnd() * list.length)];
const now = 1_800_000_000_000;
for (let round = 0; round < 40; round++) {
  const size = 5 + Math.floor(rnd() * 300);
  const nodes = [];
  const ids = [];
  for (let i = 0; i < size; i++) ids.push(1 + Math.floor(rnd() * size * 3));   // sparse ids, never repeated below
  const unique = [...new Set(ids)];
  for (const [k, id] of unique.entries()) {
    const kind = k < 3 ? 'dir' : pick(['file', 'file', 'file', 'dir', 'dir', 'symlink', 'external']);
    // parents: an earlier node, nobody, a deleted one (unknown id), or now and then a later one (cycles)
    const r = rnd();
    const parent = k === 0 || r < 0.05 ? null : r < 0.1 ? 999_999 : r < 0.13 ? pick(unique) : unique[Math.floor(rnd() * k)];
    nodes.push({ id, kind, cls: pick(['code', 'doc', 'project', 'vendor', 'dump', 'other', 'weird']), parent_id: parent,
      size: pick([0, 10, 10, 100, Math.floor(rnd() * 1e6)]), bytes: pick([0, 5, 5, Math.floor(rnd() * 1e7)]), files: pick([0, 1, 1, 7]),
      mtime: now - pick([0, 1, 1, Math.floor(rnd() * 400 * 86400e3)]), aggregate: 0 });
  }
  const edges = [];
  const ends = [...unique, 999_998, 0];   // some endpoints are not nodes
  const count = Math.floor(rnd() * size * 4);
  for (let i = 0; i < count; i++) edges.push({ src: pick(ends), dst: rnd() < 0.05 ? undefined : pick(ends), kind: 'imports', confidence: pick([1, 1, 0.7, 0.45, 0.95]) });
  for (const e of edges) if (e.dst === undefined) e.dst = e.src;   // self loops
  const want = reference(nodes, edges, now);
  const got = computeRank(nodes, edges, now);
  assert.deepEqual([...got], [...want], `round ${round}: ${nodes.length} nodes, ${edges.length} edges`);
  // rows read one at a time, with a size hint below the real count (the arrays grow) or no hint at all
  const streamed = hint => ({ length: hint, [Symbol.iterator]: () => edges.values() });
  assert.deepEqual([...computeRank(nodes, streamed(Math.floor(edges.length / 3)), now)], [...want], `round ${round}, streamed`);
  assert.deepEqual([...computeRank(nodes, { [Symbol.iterator]: () => edges.values() }, now)], [...want], `round ${round}, no hint`);
}
assert.deepEqual([...computeRank([], [])], []);
const lone = [{ id: 1, kind: 'file', cls: 'code', parent_id: null, size: 3, bytes: 0, files: 0, mtime: now, aggregate: 0 }];
assert.deepEqual([...computeRank(lone, [], now)], [...reference(lone, [], now)]);
console.log('PASS rank: typed-array computeRank equals the reference on 40 random graphs (cycles, missing parents, unknown endpoints, self loops, ties), also from streamed rows');
