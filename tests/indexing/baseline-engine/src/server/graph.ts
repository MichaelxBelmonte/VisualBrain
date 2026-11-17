// Edge building from extracted references, symlinks, duplicate hashes, shared identifiers and text similarity.
import { dirname, join, normalize, basename } from 'node:path';
import { homedir } from 'node:os';
import { realpathSync } from 'node:fs';
import type { Db } from './db.ts';
import type { Config } from './config.ts';

export interface NodeLite {
  id: number;
  path: string;
  name: string;
  kind: string;
  cls: string;
  parent: number | null;
  project: number | null;
  hash: string | null;
}

export interface Index {
  byId: Map<number, NodeLite>;
  byPath: Map<string, number>;
  byName: Map<string, number[]>;
  roots: string[];
  home: string;
}

export function loadIndex(db: Db, cfg: Config): Index {
  const byId = new Map<number, NodeLite>();
  const byPath = new Map<string, number>();
  const byName = new Map<string, number[]>();
  for (const r of db.all<{ id: number; path: string; name: string; kind: string; cls: string; parent_id: number | null; project_id: number | null; hash: string | null }>(
    'SELECT id, path, name, kind, cls, parent_id, project_id, hash FROM nodes WHERE deleted = 0')) {
    const n: NodeLite = { id: r.id, path: r.path, name: r.name, kind: r.kind, cls: r.cls, parent: r.parent_id, project: r.project_id, hash: r.hash };
    byId.set(n.id, n);
    byPath.set(n.path, n.id);
    if (n.kind === 'file' || n.kind === 'dir') {
      const arr = byName.get(n.name);
      if (arr) arr.push(n.id); else byName.set(n.name, [n.id]);
    }
  }
  return { byId, byPath, byName, roots: cfg.roots, home: homedir() };
}

export function normalizePath(target: string, home: string): string {
  let t = target.trim().replace(/^["'`]+|["'`]+$/g, '');
  if (t.startsWith('~/')) t = home + t.slice(1);
  else if (t === '~') t = home;
  t = t.replace(/^\$\{?HOME\}?/, home);
  t = normalize(t).replace(/\/+$/, '');
  return t;
}

const EXT_VARIANTS = ['', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.py', '.rs', '.md', '.sh', '/index.ts', '/index.js', '/__init__.py', '/mod.rs', '.gs', '.json', '.html'];

function tryVariants(idx: Index, base: string): number | null {
  const direct = idx.byPath.get(base);
  if (direct !== undefined) return direct;
  for (const v of EXT_VARIANTS) {
    if (v === '') continue;
    const id = idx.byPath.get(base + v);
    if (id !== undefined) return id;
  }
  return null;
}

function isAncestor(idx: Index, maybeAncestor: number, node: number): boolean {
  let cur: number | null = node;
  let guard = 0;
  while (cur !== null && guard++ < 64) {
    if (cur === maybeAncestor) return true;
    cur = idx.byId.get(cur)?.parent ?? null;
  }
  return false;
}

export function underRoots(idx: Index, p: string): boolean {
  return idx.roots.some((r) => p === r || p.startsWith(r + '/'));
}

/** Finds the node for an absolute path: exact, through symlinks, or the nearest aggregate ancestor (vendor/build dirs). */
export function resolveExisting(idx: Index, p: string): { id: number; via: 'exact' | 'realpath' | 'aggregate' } | null {
  const direct = tryVariants(idx, p);
  if (direct !== null) return { id: direct, via: 'exact' };
  let real: string | null = null;
  try { real = realpathSync(p); } catch { real = null; }
  if (real && real !== p) {
    const id = tryVariants(idx, real);
    if (id !== null) return { id, via: 'realpath' };
    p = real;
  }
  if (!underRoots(idx, p)) return null;
  let cur = dirname(p);
  let guard = 0;
  while (guard++ < 64 && underRoots(idx, cur)) {
    const id = idx.byPath.get(cur);
    if (id !== undefined) {
      const n = idx.byId.get(id)!;
      return n.kind === 'dir' && n.cls === 'vendor' ? { id, via: 'aggregate' } : null;
    }
    cur = dirname(cur);
  }
  return null;
}

/** The nearest existing ancestor node of a path under the roots, or null. */
export function nearestAncestor(idx: Index, p: string): number | null {
  let cur = dirname(p);
  let guard = 0;
  while (guard++ < 64) {
    const id = idx.byPath.get(cur);
    if (id !== undefined) return id;
    const next = dirname(cur);
    if (next === cur) return null;
    cur = next;
  }
  return null;
}

export function externalGroup(p: string, home: string): string | null {
  if (!p.startsWith('/')) return null;
  if (p.startsWith(home + '/')) {
    const rest = p.slice(home.length + 1).split('/');
    const g = home + '/' + rest[0];
    return g === p ? null : g;
  }
  const parts = p.split('/').filter(Boolean);
  if (parts.length <= 1) return null;
  const g = '/' + parts[0];
  return g === p ? null : g;
}

/** Returns the id of the external node for `p`, creating it (and its group) when needed. */
export function getOrCreateExternal(db: Db, idx: Index, p: string): number {
  const found = idx.byPath.get(p);
  if (found !== undefined) return found;
  let parent: number | null = null;
  let depth = 0;
  if (p.startsWith('/') && underRoots(idx, p)) {
    // a path inside the roots that does not exist (any more): hang it under its nearest existing folder
    parent = nearestAncestor(idx, p);
    depth = parent === null ? 0 : (p.split('/').length - 1);
  } else {
    const group = externalGroup(p, idx.home);
    if (group) {
      parent = getOrCreateExternal(db, idx, group);
      depth = 1;
    }
  }
  const name = p.startsWith('/') ? (basename(p) || p) : p;
  const r = db.run("INSERT INTO nodes (path, parent_id, name, kind, ext, cls, depth, gen, extracted) VALUES (?, ?, ?, 'external', '', 'other', ?, 0, 1)", p, parent, name, depth);
  const id = Number(r.lastInsertRowid);
  const n: NodeLite = { id, path: p, name, kind: 'external', cls: 'other', parent, project: null, hash: null };
  idx.byId.set(id, n);
  idx.byPath.set(p, id);
  return id;
}

interface RefRow { node_id: number; kind: string; target: string; line: number | null; snippet: string | null; relative_to: string }

export interface EdgeDraft {
  src: number;
  dst: number;
  kind: string;
  verified: 0 | 1;
  confidence: number;
  evidence: Record<string, unknown>;
  origin: string;
  count: number;
}

/** Upserts a batch of edges of the given origin, keeping ids and the `hidden` flag of the ones that still exist. */
export function writeEdges(db: Db, drafts: Map<string, EdgeDraft>, origin: string, kinds: string[]): number {
  const gen = Number(db.getMeta('gen') ?? 0);
  const existing = new Map<string, number>();
  const kindList = kinds.map((k) => `'${k}'`).join(',');
  for (const r of db.all<{ id: number; src: number; dst: number; kind: string }>(`SELECT id, src, dst, kind FROM edges WHERE origin = ? AND kind IN (${kindList})`, origin)) {
    existing.set(`${r.src}|${r.dst}|${r.kind}`, r.id);
  }
  const ins = db.prepare('INSERT INTO edges (src, dst, kind, verified, confidence, evidence, origin, created_at, gen, count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const upd = db.prepare('UPDATE edges SET verified = ?, confidence = ?, evidence = ?, gen = ?, count = ? WHERE id = ?');
  const now = Date.now();
  db.tx(() => {
    for (const [key, d] of drafts) {
      const ev = JSON.stringify(d.evidence);
      const id = existing.get(key);
      if (id !== undefined) {
        upd.run(d.verified, d.confidence, ev, gen, d.count, id);
        existing.delete(key);
      } else {
        ins.run(d.src, d.dst, d.kind, d.verified, d.confidence, ev, d.origin, now, gen, d.count);
      }
    }
    for (const id of existing.values()) db.run('DELETE FROM edges WHERE id = ?', id);
  });
  return drafts.size;
}

function addDraft(map: Map<string, EdgeDraft>, d: EdgeDraft): void {
  const key = `${d.src}|${d.dst}|${d.kind}`;
  const prev = map.get(key);
  if (prev) {
    prev.count += d.count;
    prev.confidence = Math.max(prev.confidence, d.confidence);
  } else {
    map.set(key, d);
  }
}

const REF_KINDS = ['imports', 'links', 'refpath', 'mention', 'external', 'symlink'];

/** Resolves the raw references of every file to nodes and writes the edges. */
export function resolveRefs(db: Db, cfg: Config, idx: Index): number {
  const drafts = new Map<string, EdgeDraft>();
  const refs = db.all<RefRow>("SELECT node_id, kind, target, line, snippet, relative_to FROM refs WHERE kind <> 'package'");
  const projectRoot = new Map<number, string>();
  for (const r of db.all<{ id: number; path: string }>('SELECT p.id, n.path FROM projects p JOIN nodes n ON n.id = p.node_id')) projectRoot.set(r.id, r.path);

  for (const r of refs) {
    const src = idx.byId.get(r.node_id);
    if (!src) continue;
    const ev = { file: src.path, line: r.line ?? undefined, snippet: r.snippet ?? undefined };
    let dst: number | null = null;
    let kind = r.kind;
    let confidence = 1;
    if (r.kind === 'external') {
      const p = normalizePath(r.target, idx.home);
      if (!p.startsWith('/') || underRoots(idx, p)) continue;
      dst = getOrCreateExternal(db, idx, p);
    } else if (r.relative_to === 'absolute') {
      const p = normalizePath(r.target, idx.home);
      if (!p.startsWith('/')) continue;
      const hit = resolveExisting(idx, p);
      if (hit) {
        dst = hit.id;
        if (hit.via === 'aggregate') (ev as Record<string, unknown>).note = `dentro ${p}`;
      } else {
        if (underRoots(idx, p)) continue;        // a path that does not exist (any more): no edge
        kind = 'external';
        dst = getOrCreateExternal(db, idx, p);
      }
    } else if (r.relative_to === 'file') {
      const t = r.target.replace(/^\.\//, '');
      dst = tryVariants(idx, normalize(join(dirname(src.path), t)));
      if (dst === null && /^\.\.?(\/|$)/.test(r.target) === false && src.cls === 'code') {
        // python dotted module written as a/b
        const root = src.project === null ? null : projectRoot.get(src.project);
        if (root) dst = tryVariants(idx, join(root, t)) ?? tryVariants(idx, join(root, 'src', t));
      }
    } else if (r.relative_to === 'root') {
      const t = r.target.replace(/^\.\//, '').replace(/^\/+/, '');
      const bases: string[] = [];
      const root = src.project === null ? null : projectRoot.get(src.project);
      if (root) bases.push(root, join(root, 'src'));
      let cur: number | null = src.parent;
      let guard = 0;
      while (cur !== null && guard++ < 12) {
        const d = idx.byId.get(cur);
        if (!d) break;
        bases.push(d.path);
        if (idx.roots.includes(d.path)) break;
        cur = d.parent;
      }
      for (const b of bases) {
        dst = tryVariants(idx, normalize(join(b, t)));
        if (dst !== null) break;
      }
      if (dst === null && r.kind !== 'mention') {
        // last resort: the target is unique by its last segment
        const seg = basename(t);
        const cands = idx.byName.get(seg);
        if (cands && cands.length === 1 && idx.byId.get(cands[0])!.path.endsWith('/' + t)) dst = cands[0];
      }
    } else if (r.relative_to === 'name') {
      const name = r.target.replace(/^\[\[|\]\]$/g, '');
      let cands = idx.byName.get(name) ?? [];
      if (cands.length === 0 && !name.includes('.')) {
        cands = [...(idx.byName.get(name + '.md') ?? [])];
      }
      if (cands.length === 1) {
        dst = cands[0];
        confidence = r.kind === 'links' ? 0.95 : 0.7;
      } else if (cands.length > 1 && src.project !== null) {
        const same = cands.filter((c) => idx.byId.get(c)!.project === src.project);
        if (same.length === 1) { dst = same[0]; confidence = r.kind === 'links' ? 0.9 : 0.6; }
      }
      if (dst === null) continue;
    }
    if (dst === null || dst === src.id) continue;
    const target = idx.byId.get(dst);
    if (!target) continue;
    if (target.kind === 'dir' && isAncestor(idx, dst, src.id)) continue;   // a file naming its own folder
    addDraft(drafts, { src: src.id, dst, kind, verified: 1, confidence, evidence: ev, origin: 'scan', count: 1 });
  }

  // symbolic links
  for (const r of db.all<{ id: number; link_target: string }>("SELECT id, link_target FROM nodes WHERE kind = 'symlink' AND deleted = 0 AND link_target IS NOT NULL")) {
    const p = normalizePath(r.link_target, idx.home);
    let dst = idx.byPath.get(p) ?? resolveExisting(idx, p)?.id ?? null;
    if (dst === null) {
      if (underRoots(idx, p)) continue;
      dst = getOrCreateExternal(db, idx, p);
    }
    if (dst === r.id) continue;
    addDraft(drafts, { src: r.id, dst, kind: 'symlink', verified: 1, confidence: 1, evidence: { note: 'collegamento simbolico', file: idx.byId.get(r.id)?.path }, origin: 'scan', count: 1 });
  }
  return writeEdges(db, drafts, 'scan', REF_KINDS);
}

/** Files with an identical hash: a star from the shallowest copy to the others. */
export function duplicateEdges(db: Db, idx: Index): number {
  const drafts = new Map<string, EdgeDraft>();
  const groups = db.all<{ hash: string; ids: string }>("SELECT hash, GROUP_CONCAT(id) AS ids FROM nodes WHERE hash IS NOT NULL AND deleted = 0 AND size > 64 GROUP BY hash HAVING COUNT(*) > 1");
  for (const g of groups) {
    const ids = g.ids.split(',').map(Number).filter((i) => idx.byId.has(i));
    if (ids.length < 2 || ids.length > 40) continue;
    ids.sort((a, b) => idx.byId.get(a)!.path.length - idx.byId.get(b)!.path.length || a - b);
    const hub = ids[0];
    for (const other of ids.slice(1)) {
      addDraft(drafts, { src: other, dst: hub, kind: 'duplicate', verified: 1, confidence: 1, evidence: { note: 'contenuto identico (sha1)', token: g.hash.slice(0, 10) }, origin: 'scan', count: 1 });
    }
  }
  return writeEdges(db, drafts, 'scan', ['duplicate']);
}

/** The same rare identifier in several files. */
export function sharedIdEdges(db: Db, idx: Index): number {
  const drafts = new Map<string, EdgeDraft>();
  const groups = db.all<{ token: string; ids: string }>('SELECT token, GROUP_CONCAT(node_id) AS ids FROM identifiers GROUP BY token HAVING COUNT(*) BETWEEN 2 AND 25');
  for (const g of groups) {
    const ids = [...new Set(g.ids.split(',').map(Number))].filter((i) => idx.byId.has(i)).sort((a, b) => a - b);
    if (ids.length < 2) continue;
    const pairs: [number, number][] = [];
    if (ids.length <= 6) {
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) pairs.push([ids[i], ids[j]]);
    } else {
      for (let i = 1; i < ids.length; i++) pairs.push([ids[0], ids[i]]);
    }
    const conf = ids.length <= 3 ? 0.6 : 0.45;
    for (const [a, b] of pairs) {
      const key = `${a}|${b}|shared_id`;
      const prev = drafts.get(key);
      if (prev) {
        prev.count++;
        const toks = prev.evidence.tokens as string[];
        if (toks.length < 5) toks.push(g.token);
        prev.confidence = Math.min(0.9, prev.confidence + 0.1);
      } else {
        drafts.set(key, { src: a, dst: b, kind: 'shared_id', verified: 1, confidence: conf, evidence: { tokens: [g.token], note: 'stesso identificatore' }, origin: 'scan', count: 1 });
      }
    }
  }
  return writeEdges(db, drafts, 'scan', ['shared_id']);
}

/** Cosine similarity on tf-idf vectors of the extracted terms (inferred edges). */
export function similarityEdges(db: Db, idx: Index): number {
  const docs = db.all<{ id: number; terms: string; hash: string | null }>("SELECT id, terms, hash FROM nodes WHERE terms IS NOT NULL AND deleted = 0 AND kind = 'file'");
  const N = docs.length;
  const drafts = new Map<string, EdgeDraft>();
  if (N < 2) return writeEdges(db, drafts, 'scan', ['similar']);
  const df = new Map<string, number>();
  const parsed: { id: number; hash: string | null; terms: Record<string, number> }[] = [];
  for (const d of docs) {
    let terms: Record<string, number>;
    try { terms = JSON.parse(d.terms); } catch { continue; }
    parsed.push({ id: d.id, hash: d.hash, terms });
    for (const t of Object.keys(terms)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const maxDf = Math.max(2, Math.floor(N * 0.15));
  const vectors = new Map<number, Map<string, number>>();
  const postings = new Map<string, [number, number][]>();
  for (const d of parsed) {
    const v = new Map<string, number>();
    let norm = 0;
    for (const [t, tf] of Object.entries(d.terms)) {
      const f = df.get(t) ?? 1;
      if (f < 2 || f > maxDf) continue;
      const w = (1 + Math.log(tf)) * Math.log(N / f);
      v.set(t, w);
      norm += w * w;
    }
    if (v.size < 3) continue;
    norm = Math.sqrt(norm);
    for (const [t, w] of v) {
      const nw = w / norm;
      v.set(t, nw);
      const p = postings.get(t);
      if (p) p.push([d.id, nw]); else postings.set(t, [[d.id, nw]]);
    }
    vectors.set(d.id, v);
  }
  const hashOf = new Map(parsed.map((d) => [d.id, d.hash]));
  for (const [id, v] of vectors) {
    const acc = new Map<number, number>();
    const shared = new Map<number, number>();
    for (const [t, w] of v) {
      const p = postings.get(t);
      if (!p || p.length > 400) continue;
      for (const [other, ow] of p) {
        if (other === id) continue;
        acc.set(other, (acc.get(other) ?? 0) + w * ow);
        shared.set(other, (shared.get(other) ?? 0) + 1);
      }
    }
    const best = [...acc.entries()].filter(([o, s]) => s >= 0.3 && (shared.get(o) ?? 0) >= 3).sort((a, b) => b[1] - a[1]).slice(0, 5);
    for (const [other, score] of best) {
      if (hashOf.get(other) && hashOf.get(other) === hashOf.get(id)) continue;
      const a = Math.min(id, other);
      const b = Math.max(id, other);
      const key = `${a}|${b}|similar`;
      if (drafts.has(key)) continue;
      const ov = vectors.get(other)!;
      const terms = [...v.entries()].filter(([t]) => ov.has(t)).sort((x, y) => (y[1] * ov.get(y[0])!) - (x[1] * ov.get(x[0])!)).slice(0, 6).map(([t]) => t);
      drafts.set(key, { src: a, dst: b, kind: 'similar', verified: 0, confidence: Math.round(score * 100) / 100, evidence: { score: Math.round(score * 100) / 100, terms, note: 'testi simili (tf-idf)' }, origin: 'scan', count: 1 });
    }
  }
  return writeEdges(db, drafts, 'scan', ['similar']);
}

export function buildEdges(db: Db, cfg: Config, progress?: (m: string) => void): number {
  const idx = loadIndex(db, cfg);
  const a = resolveRefs(db, cfg, idx);
  progress?.(`${a} archi da riferimenti`);
  const b = duplicateEdges(db, idx);
  progress?.(`${b} duplicati`);
  const c = sharedIdEdges(db, idx);
  progress?.(`${c} identificatori condivisi`);
  const d = similarityEdges(db, idx);
  progress?.(`${d} similarità`);
  return a + b + c + d;
}
