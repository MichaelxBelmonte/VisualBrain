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
  /** stem -> [variant position in EXT_VARIANTS, id] of every known path that is `stem + variant` (see tryVariants). */
  variants: Map<string, [number, number][]>;
}

export function loadIndex(db: Db, cfg: Config): Index {
  const byId = new Map<number, NodeLite>();
  const byPath = new Map<string, number>();
  const byName = new Map<string, number[]>();
  // a million rows on a Desktop: read one at a time (all at once they are ~900 MB more), kinds and classes kept once each
  const words = new Map<string, string>();
  const word = (s: string) => { let w = words.get(s); if (w === undefined) { w = s; words.set(s, s); } return w; };
  for (const r of db.iterate<{ id: number; path: string; name: string; kind: string; cls: string; parent_id: number | null; project_id: number | null; hash: string | null }>(
    'SELECT id, path, name, kind, cls, parent_id, project_id, hash FROM nodes WHERE deleted = 0')) {
    const n: NodeLite = { id: r.id, path: r.path, name: r.name, kind: word(r.kind), cls: word(r.cls), parent: r.parent_id, project: r.project_id, hash: r.hash };
    byId.set(n.id, n);
    byPath.set(n.path, n.id);
    if (n.kind === 'file' || n.kind === 'dir') {
      const arr = byName.get(n.name);
      if (arr) arr.push(n.id); else byName.set(n.name, [n.id]);
    }
  }
  const idx: Index = { byId, byPath, byName, roots: cfg.roots, home: homedir(), variants: new Map() };
  for (const [p, id] of byPath) addVariants(idx, p, id);
  return idx;
}

/** A map that reads a missing key from the database the first time it is asked for (and remembers misses too). */
class LazyMap<K, V> extends Map<K, V> {
  private misses = new Set<K>();
  private read: (key: K) => V | undefined;
  constructor(read: (key: K) => V | undefined) { super(); this.read = read; }
  override get(key: K): V | undefined {
    const hit = super.get(key);
    if (hit !== undefined || this.misses.has(key)) return hit;
    const v = this.read(key);
    if (v === undefined) this.misses.add(key); else super.set(key, v);
    return v;
  }
  override has(key: K): boolean { return this.get(key) !== undefined; }
  override set(key: K, v: V): this { this.misses.delete(key); return super.set(key, v); }
}

/**
 * The same index as loadIndex, answered from the database one lookup at a time: for work that touches a few paths (a pass
 * over a few rewritten files, an edge added through the API), where reading every node first would cost seconds.
 */
export function lazyIndex(db: Db, cfg: Config): Index {
  const nodeById = db.prepare('SELECT id, path, name, kind, cls, parent_id, project_id, hash FROM nodes WHERE id = ? AND deleted = 0');
  const idByPath = db.prepare('SELECT id FROM nodes WHERE path = ? AND deleted = 0');
  const idsByName = db.prepare("SELECT id FROM nodes WHERE name = ? AND deleted = 0 AND kind IN ('file', 'dir') ORDER BY id");
  const byPath = new LazyMap<string, number>((p) => (idByPath.get(p) as { id: number } | undefined)?.id);
  const byId = new LazyMap<number, NodeLite>((id) => {
    const r = nodeById.get(id) as { id: number; path: string; name: string; kind: string; cls: string; parent_id: number | null; project_id: number | null; hash: string | null } | undefined;
    return r ? { id: r.id, path: r.path, name: r.name, kind: r.kind, cls: r.cls, parent: r.parent_id, project: r.project_id, hash: r.hash } : undefined;
  });
  const byName = new LazyMap<string, number[]>((name) => { const ids = (idsByName.all(name) as { id: number }[]).map((r) => r.id); return ids.length ? ids : undefined; });
  // every known path that is `stem + variant`, as addVariants would have registered it
  const variants = new LazyMap<string, [number, number][]>((stem) => {
    const list: [number, number][] = [];
    for (let at = 1; at < EXT_VARIANTS.length; at++) { const id = byPath.get(stem + EXT_VARIANTS[at]); if (id !== undefined) list.push([at, id]); }
    return list.length ? list : undefined;
  });
  return { byId, byPath, byName, roots: cfg.roots, home: homedir(), variants };
}

export function normalizePath(target: string, home: string): string {
  let t = target.trim().replace(/^["'`]+|["'`]+$/g, '');
  if (t.startsWith('~/')) t = home + t.slice(1);
  else if (t === '~') t = home;
  t = t.replace(/^\$\{?HOME\}?/, home);
  t = normalize(t).replace(/\/+$/, '');
  return t;
}

const EXT_VARIANTS = ['', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.py', '.rs', '.md', '.sh', '/index.ts', '/index.js', '/__init__.py', '/mod.rs', '.gs', '.json', '.html', '.java', '.kt'];

const VARIANT_AT = new Map(EXT_VARIANTS.map((v, i) => [v, i] as const).filter(([v]) => v !== ''));
const SLASH_VARIANTS = EXT_VARIANTS.filter((v) => v.startsWith('/'));

/** Registers `path` as `stem + variant` for every variant it ends with, so tryVariants is one lookup instead of seventeen. */
function addVariants(idx: Index, path: string, id: number): void {
  const add = (v: string) => {
    const at = VARIANT_AT.get(v)!;
    const stem = path.slice(0, path.length - v.length);
    const list = idx.variants.get(stem);
    if (list) list.push([at, id]); else idx.variants.set(stem, [[at, id]]);
  };
  const dot = path.lastIndexOf('.');
  if (dot < 0) return;
  const tail = path.slice(dot);
  if (VARIANT_AT.has(tail)) add(tail);
  for (const v of SLASH_VARIANTS) if (path.endsWith(v)) add(v);
}

function tryVariants(idx: Index, base: string): number | null {
  const direct = idx.byPath.get(base);
  if (direct !== undefined) return direct;
  const list = idx.variants.get(base);
  if (!list) return null;
  let best = list[0];
  for (let i = 1; i < list.length; i++) if (list[i][0] < best[0]) best = list[i];
  return best[1];
}

/** A relative path that normalize(join(base, rel)) would leave as it is: no `.`/`..`/empty segment, no leading or trailing slash. */
const UNCLEAN = /(^|\/)\.\.?(\/|$)|\/\/|^\/|\/$|^$/;

/** normalize(join(base, rel)) for a base that is a node path; just a concatenation when `rel` is clean (most targets). */
function joinUnder(base: string, rel: string, clean: boolean): string {
  return clean && base.length > 1 && !base.endsWith('/') ? base + '/' + rel : normalize(join(base, rel));
}

/**
 * For a full index, the folders under which a clean relative path names a node: `base` such that `base/rel` is a known path or
 * the stem of one (what tryVariants would find). A Desktop has a million root-relative imports but a few thousand distinct
 * targets, so each is matched once against the paths with its last segment, and the dozen candidate folders of every file
 * that imports it are then checked without building a path. Null for a lazy index, which cannot list its paths.
 */
function hitFolders(idx: Index): ((rel: string) => Set<string>) | null {
  if (idx.byPath instanceof LazyMap) return null;
  const last = (p: string) => p.slice(p.lastIndexOf('/') + 1);
  let byLast: Map<string, string[]> | null = null;
  const memo = new Map<string, Set<string>>();
  return (rel) => {
    let hit = memo.get(rel);
    if (hit) return hit;
    if (!byLast) {
      byLast = new Map();
      for (const keys of [idx.byPath.keys(), idx.variants.keys()]) for (const k of keys) {
        const l = last(k);
        const list = byLast.get(l);
        if (list) list.push(k); else byLast.set(l, [k]);
      }
    }
    hit = new Set();
    const tail = '/' + rel;
    for (const k of byLast.get(last(rel)) ?? []) if (k.length > tail.length && k.endsWith(tail)) hit.add(k.slice(0, k.length - tail.length));
    memo.set(rel, hit);
    return hit;
  };
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
  // atomic upsert: the API (or a scan in the worker) may have created this path since the index was loaded; keep that id
  db.run("INSERT INTO nodes (path, parent_id, name, kind, ext, cls, depth, gen, extracted) VALUES (?, ?, ?, 'external', '', 'other', ?, 0, 1) ON CONFLICT(path) DO NOTHING", p, parent, name, depth);
  const row = db.get<{ id: number; parent_id: number | null; kind: string; cls: string }>('SELECT id, parent_id, kind, cls FROM nodes WHERE path = ?', p)!;
  const id = row.id;
  const n: NodeLite = { id, path: p, name, kind: row.kind as NodeLite['kind'], cls: row.cls, parent: row.parent_id, project: null, hash: null };
  idx.byId.set(id, n);
  idx.byPath.set(p, id);
  addVariants(idx, p, id);
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

/**
 * Which stored edges a batch replaces: all of its kinds (a full pass), or only those leaving some nodes (`src`) or touching
 * them (`either`) when just those nodes were recomputed.
 */
export interface EdgeScope { ids: number[]; by: 'src' | 'either' }

/** Upserts a batch of edges of the given origin, keeping ids and the `hidden` flag of the ones that still exist. */
export function writeEdges(db: Db, drafts: Map<string, EdgeDraft>, origin: string, kinds: string[], scope?: EdgeScope): number {
  const gen = Number(db.getMeta('gen') ?? 0);
  const kindList = kinds.map((k) => `'${k}'`).join(',');
  // an existing edge of these kinds is the same edge whichever way it was stored; the draft's direction is written back
  const keyOf = (src: number, dst: number, kind: string) => (SYMMETRIC.has(kind) ? `${Math.min(src, dst)}|${Math.max(src, dst)}|${kind}` : `${src}|${dst}|${kind}`);
  const ins = db.prepare('INSERT INTO edges (src, dst, kind, verified, confidence, evidence, origin, created_at, gen, count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  // An edge that comes back identical is not written again: every pass would otherwise rewrite the million edges of a
  // Desktop (and grow the WAL by hundreds of MB) to change nothing.
  const upd = db.prepare(`UPDATE edges SET src = ?1, dst = ?2, verified = ?3, confidence = ?4, evidence = ?5, gen = ?6, count = ?7, hidden = ?8 WHERE id = ?9
    AND (src IS NOT ?1 OR dst IS NOT ?2 OR verified IS NOT ?3 OR confidence IS NOT ?4 OR evidence IS NOT ?5 OR count IS NOT ?7 OR hidden IS NOT ?8)`);
  const now = Date.now();
  db.tx(() => {
    // read under the write lock: an edge the API hides between a snapshot and the lock must not be un-hidden here
    const existing = new Map<string, { id: number; src: number; dst: number; hidden: number }[]>();
    // a scope is a few nodes: looked up by endpoint, never by kind (a kind can hold most of the table)
    const bySrc = 'SELECT id FROM edges INDEXED BY edges_src WHERE src IN (SELECT value FROM json_each(?2))';
    const within = !scope ? '' : scope.by === 'src' ? ` AND id IN (${bySrc})`
      : ` AND id IN (${bySrc} UNION SELECT id FROM edges INDEXED BY edges_dst WHERE dst IN (SELECT value FROM json_each(?2)))`;
    const args: (string | number)[] = scope ? [origin, JSON.stringify(scope.ids)] : [origin];
    for (const r of db.iterate<{ id: number; src: number; dst: number; kind: string; hidden: number }>(`SELECT id, src, dst, kind, hidden FROM edges WHERE origin = ?1 AND kind IN (${kindList})${within}`, ...args)) {
      const k = keyOf(r.src, r.dst, r.kind);
      const list = existing.get(k);
      if (list) list.push(r); else existing.set(k, [r]);
    }
    for (const d of drafts.values()) {
      const ev = JSON.stringify(d.evidence);
      const k = keyOf(d.src, d.dst, d.kind);
      const list = existing.get(k);
      if (list && list.length) {
        // keep the edge (and its id) stored with the same orientation when there is one; a hidden duplicate keeps the pair hidden
        const keep = list.find((e) => e.src === d.src) ?? list[0];
        const hidden = list.some((e) => e.hidden) ? 1 : 0;
        for (const e of list) if (e !== keep) db.run('DELETE FROM edges WHERE id = ?', e.id);
        upd.run(d.src, d.dst, d.verified, d.confidence, ev, gen, d.count, hidden, keep.id);
        existing.delete(k);
      } else {
        ins.run(d.src, d.dst, d.kind, d.verified, d.confidence, ev, d.origin, now, gen, d.count);
      }
    }
    for (const list of existing.values()) for (const e of list) db.run('DELETE FROM edges WHERE id = ?', e.id);
  });
  return drafts.size;
}

/**
 * Kinds whose stored edge is matched as an unordered pair when reconciling with what is already in the database.
 * similar/shared_id are undirected; a duplicate points at its hub, but the hub of a tie (equal path lengths) used to be
 * picked by id and is now picked by path, so the same pair may come back reversed: it must stay the same edge (id, hidden).
 */
const SYMMETRIC = new Set(['similar', 'shared_id', 'duplicate']);

/**
 * Ties between heuristic candidates are broken by path, never by node id: ids follow the order the walk happened to
 * finish its I/O in, so id-based tie-breaks would make the graph depend on timing and on the engine.
 */
const cmpPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

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

/** Resolves the raw references of every file (or of `only`, when just those changed) to nodes and writes the edges. */
export function resolveRefs(db: Db, cfg: Config, idx: Index, only?: number[]): number {
  const drafts = new Map<string, EdgeDraft>();
  const refs = only
    ? db.all<RefRow>("SELECT node_id, kind, target, line, snippet, relative_to FROM refs WHERE kind <> 'package' AND node_id IN (SELECT value FROM json_each(?))", JSON.stringify(only))
    : db.iterate<RefRow>("SELECT node_id, kind, target, line, snippet, relative_to FROM refs WHERE kind <> 'package'");
  const projectRoot = new Map<number, string>();
  for (const r of db.all<{ id: number; path: string }>('SELECT p.id, n.path FROM projects p JOIN nodes n ON n.id = p.node_id')) projectRoot.set(r.id, r.path);
  const folders = hitFolders(idx);

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
      dst = tryVariants(idx, joinUnder(dirname(src.path), t, !UNCLEAN.test(t)));
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
      const clean = !UNCLEAN.test(t);
      // under the roots, `b/t` can only be a node that existed before this pass (the external ones it adds are outside)
      const hits = clean && folders ? folders(t) : null;
      for (const b of bases) {
        if (hits && b.length > 1 && !hits.has(b) && underRoots(idx, b)) continue;
        dst = tryVariants(idx, joinUnder(b, t, clean));
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
  const links = only
    ? db.all<{ id: number; link_target: string }>("SELECT id, link_target FROM nodes WHERE kind = 'symlink' AND deleted = 0 AND link_target IS NOT NULL AND id IN (SELECT value FROM json_each(?))", JSON.stringify(only))
    : db.all<{ id: number; link_target: string }>("SELECT id, link_target FROM nodes WHERE kind = 'symlink' AND deleted = 0 AND link_target IS NOT NULL");
  for (const r of links) {
    const p = normalizePath(r.link_target, idx.home);
    let dst = idx.byPath.get(p) ?? resolveExisting(idx, p)?.id ?? null;
    if (dst === null) {
      if (underRoots(idx, p)) continue;
      dst = getOrCreateExternal(db, idx, p);
    }
    if (dst === r.id) continue;
    addDraft(drafts, { src: r.id, dst, kind: 'symlink', verified: 1, confidence: 1, evidence: { note: 'collegamento simbolico', file: idx.byId.get(r.id)?.path }, origin: 'scan', count: 1 });
  }
  return writeEdges(db, drafts, 'scan', REF_KINDS, only ? { ids: only, by: 'src' } : undefined);
}

/**
 * Files with an identical hash: a star from the shallowest copy to the others. With `only`, just the groups those files
 * belong to now or belonged to before (the copies they were linked with) are rebuilt.
 */
export function duplicateEdges(db: Db, idx: Index, only?: number[]): number {
  const drafts = new Map<string, EdgeDraft>();
  let scope: EdgeScope | undefined;
  let groups: { hash: string; ids: string }[];
  if (only) {
    const list = JSON.stringify(only);
    const hashes = db.all<{ hash: string }>(`SELECT DISTINCT hash FROM nodes WHERE hash IS NOT NULL AND id IN (SELECT value FROM json_each(?1))
      UNION SELECT DISTINCT n.hash FROM edges e JOIN nodes n ON n.id = CASE WHEN e.src IN (SELECT value FROM json_each(?1)) THEN e.dst ELSE e.src END
      WHERE e.kind = 'duplicate' AND e.origin = 'scan' AND n.hash IS NOT NULL AND (e.src IN (SELECT value FROM json_each(?1)) OR e.dst IN (SELECT value FROM json_each(?1)))`, list).map((r) => r.hash);
    groups = db.all<{ hash: string; ids: string }>(`SELECT hash, GROUP_CONCAT(id) AS ids FROM nodes WHERE hash IN (SELECT value FROM json_each(?)) AND deleted = 0 AND size > 64 GROUP BY hash HAVING COUNT(*) > 1`, JSON.stringify(hashes));
    const members = new Set(only);
    for (const r of db.all<{ id: number }>('SELECT id FROM nodes WHERE hash IN (SELECT value FROM json_each(?))', JSON.stringify(hashes))) members.add(r.id);
    scope = { ids: [...members], by: 'either' };
  } else {
    groups = db.all<{ hash: string; ids: string }>("SELECT hash, GROUP_CONCAT(id) AS ids FROM nodes WHERE hash IS NOT NULL AND deleted = 0 AND size > 64 GROUP BY hash HAVING COUNT(*) > 1");
  }
  for (const g of groups) {
    const ids = g.ids.split(',').map(Number).filter((i) => idx.byId.has(i));
    if (ids.length < 2 || ids.length > 40) continue;
    ids.sort((a, b) => idx.byId.get(a)!.path.length - idx.byId.get(b)!.path.length || cmpPath(idx.byId.get(a)!.path, idx.byId.get(b)!.path));
    const hub = ids[0];
    for (const other of ids.slice(1)) {
      addDraft(drafts, { src: other, dst: hub, kind: 'duplicate', verified: 1, confidence: 1, evidence: { note: 'contenuto identico (sha1)', token: g.hash.slice(0, 10) }, origin: 'scan', count: 1 });
    }
  }
  return writeEdges(db, drafts, 'scan', ['duplicate'], scope);
}

/** The same rare identifier in several files. */
export function sharedIdEdges(db: Db, idx: Index): number {
  const drafts = new Map<string, EdgeDraft>();
  const groups = db.all<{ token: string; ids: string }>('SELECT token, GROUP_CONCAT(node_id) AS ids FROM identifiers GROUP BY token HAVING COUNT(*) BETWEEN 2 AND 25 ORDER BY token');
  for (const g of groups) {
    const ids = [...new Set(g.ids.split(',').map(Number))].filter((i) => idx.byId.has(i)).sort((a, b) => cmpPath(idx.byId.get(a)!.path, idx.byId.get(b)!.path));
    if (ids.length < 2) continue;
    const pairs: [number, number][] = [];
    if (ids.length <= 6) {
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) pairs.push([ids[i], ids[j]]);
    } else {
      for (let i = 1; i < ids.length; i++) pairs.push([ids[0], ids[i]]);
    }
    const conf = ids.length <= 3 ? 0.6 : 0.45;
    // pairs come out of the path-sorted list: lower path -> higher path, independent of ids (see similarityEdges)
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
  const drafts = new Map<string, EdgeDraft>();
  // Terms become numbers once, as they are read (one row at a time: the JSON of every text at once is hundreds of MB);
  // every later step indexes arrays instead of hashing strings again.
  const termId = new Map<string, number>();
  const termName: string[] = [];
  const df: number[] = [];
  const parsed: { id: number; path: string; hash: string | null; terms: Int32Array; tf: Float64Array }[] = [];
  let N = 0;
  for (const d of db.iterate<{ id: number; path: string; terms: string; hash: string | null }>("SELECT id, path, terms, hash FROM nodes WHERE terms IS NOT NULL AND deleted = 0 AND kind = 'file' ORDER BY path")) {
    N++;
    let raw: Record<string, number>;
    try { raw = JSON.parse(d.terms); } catch { continue; }
    const keys = Object.keys(raw);
    const terms = new Int32Array(keys.length), tf = new Float64Array(keys.length);
    for (let k = 0; k < keys.length; k++) {
      let t = termId.get(keys[k]);
      if (t === undefined) { t = termName.length; termId.set(keys[k], t); termName.push(keys[k]); df.push(0); }
      terms[k] = t; tf[k] = raw[keys[k]]; df[t]++;
    }
    parsed.push({ id: d.id, path: d.path, hash: d.hash, terms, tf });
  }
  if (N < 2) return writeEdges(db, drafts, 'scan', ['similar']);
  const maxDf = Math.max(2, Math.floor(N * 0.15));
  // Documents get dense ordinals (their order in `docTerms`) so the scoring below runs on arrays; the sums are made in the
  // same order as before, so scores (and ties) are bit-for-bit the same.
  const postOrd: number[][] = [], postW: number[][] = [];
  const docIds: number[] = [], docPath: string[] = [], docHash: (string | null)[] = [];
  const docTerms: Int32Array[] = [], docW: Float64Array[] = [];
  const vt: number[] = [], vw: number[] = [];
  for (const d of parsed) {
    vt.length = 0; vw.length = 0;
    let norm = 0;
    for (let k = 0; k < d.terms.length; k++) {
      const f = df[d.terms[k]];
      if (f < 2 || f > maxDf) continue;
      const w = (1 + Math.log(d.tf[k])) * Math.log(N / f);
      vt.push(d.terms[k]); vw.push(w);
      norm += w * w;
    }
    if (vt.length < 3) continue;
    norm = Math.sqrt(norm);
    const ord = docIds.length;
    const w = new Float64Array(vw.length);
    for (let k = 0; k < vt.length; k++) {
      const t = vt[k], nw = vw[k] / norm;
      w[k] = nw;
      if (postOrd[t]) { postOrd[t].push(ord); postW[t].push(nw); } else { postOrd[t] = [ord]; postW[t] = [nw]; }
    }
    docIds.push(d.id); docPath.push(d.path); docHash.push(d.hash); docTerms.push(Int32Array.from(vt)); docW.push(w);
  }
  const M = docIds.length;
  const acc = new Float64Array(M);
  const shared = new Int32Array(M);
  const touched: number[] = [];
  // the weights of one peer by term, for the evidence (stamped by peer, never cleared)
  const peerW = new Float64Array(termName.length), peerOf = new Int32Array(termName.length).fill(-1);
  for (let i = 0; i < M; i++) {
    const id = docIds[i];
    const terms = docTerms[i], ws = docW[i];
    touched.length = 0;
    for (let k = 0; k < terms.length; k++) {
      const po = postOrd[terms[k]];
      if (po.length > 400) continue;
      const pw = postW[terms[k]], w = ws[k];
      for (let j = 0; j < po.length; j++) {
        const o = po[j];
        if (o === i) continue;
        if (shared[o] === 0) touched.push(o);
        acc[o] += w * pw[j];
        shared[o]++;
      }
    }
    // the five best peers; equal scores (identical term profiles) are cut by path, not by id
    const cands: [number, number][] = [];
    for (const o of touched) {
      if (acc[o] >= 0.3 && shared[o] >= 3) cands.push([o, acc[o]]);
      acc[o] = 0; shared[o] = 0;
    }
    const best = cands.sort((a, b) => b[1] - a[1] || cmpPath(docPath[a[0]], docPath[b[0]])).slice(0, 5);
    for (const [o, score] of best) {
      if (docHash[o] && docHash[o] === docHash[i]) continue;
      const other = docIds[o];
      // stored lower path -> higher path: rank.ts reads edge direction (PageRank, in/out degree), so it must not follow ids.
      // writeEdges matches undirected kinds as unordered pairs, so an edge stored the other way is updated in place.
      const [a, b] = cmpPath(docPath[i], docPath[o]) <= 0 ? [id, other] : [other, id];
      const key = `${a}|${b}|similar`;
      if (drafts.has(key)) continue;
      const ot = docTerms[o], ow = docW[o];
      for (let k = 0; k < ot.length; k++) { peerOf[ot[k]] = o; peerW[ot[k]] = ow[k]; }
      const common: [string, number][] = [];
      for (let k = 0; k < terms.length; k++) if (peerOf[terms[k]] === o) common.push([termName[terms[k]], ws[k] * peerW[terms[k]]]);
      const top = common.sort((x, y) => y[1] - x[1]).slice(0, 6).map(([t]) => t);
      drafts.set(key, { src: a, dst: b, kind: 'similar', verified: 0, confidence: Math.round(score * 100) / 100, evidence: { score: Math.round(score * 100) / 100, terms: top, note: 'testi simili (tf-idf)' }, origin: 'scan', count: 1 });
    }
  }
  return writeEdges(db, drafts, 'scan', ['similar']);
}

/**
 * All edges of the scan. `only`: just these files changed, in place (no path appeared, vanished or changed kind), so the
 * references of the other files resolve as before: only theirs and their duplicate groups are rebuilt. `similar` is
 * global (tf-idf over every text) and runs only when `similar` is true.
 */
export function buildEdges(db: Db, cfg: Config, progress?: (m: string) => void, opts: { only?: number[]; similar?: boolean } = {}): number {
  const idx = opts.only ? lazyIndex(db, cfg) : loadIndex(db, cfg);
  const a = resolveRefs(db, cfg, idx, opts.only);
  progress?.(`${a} archi da riferimenti`);
  const b = duplicateEdges(db, idx, opts.only);
  progress?.(`${b} duplicati`);
  const c = sharedIdEdges(db, idx);
  progress?.(`${c} identificatori condivisi`);
  const d = opts.similar === false ? 0 : similarityEdges(db, idx);
  if (opts.similar !== false) progress?.(`${d} similarità`);
  return a + b + c + d;
}
