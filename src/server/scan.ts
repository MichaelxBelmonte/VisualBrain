// Filesystem walk of the roots → node rows. Incremental: unchanged files keep their row and extraction.
import { readdir, lstat, readlink, stat, open } from 'node:fs/promises';
import { lstatSync, existsSync } from 'node:fs';
import { join, dirname, resolve, basename, relative, sep } from 'node:path';
import type { Dirent } from 'node:fs';
import type { Db } from './db.ts';
import type { Config } from './config.ts';
import { nativeWalk } from './native-indexer.ts';
import { classifyFile, classifyDir, emptyDirStats, setSecretPatterns, DATA_CLASSES, MEDIA_CLASSES, PROJECT_MARKERS, type DirStats } from './classify.ts';

export interface Entry {
  path: string;
  parent: string | null;
  name: string;
  kind: 'file' | 'dir' | 'symlink';
  ext: string;
  cls: string;
  lang: string | null;
  size: number;
  mtime: number;
  inode: number;
  depth: number;
  aggregate: 0 | 1;
  linkTarget: string | null;
  stats: DirStats | null;
}

export interface ScanSummary {
  gen: number;
  seen: number;
  added: number;
  changed: number;
  removed: number;
  ms: number;
  /** Files and links rewritten in place (same path, same kind): only their content can have changed. */
  changedFiles: number[];
  /** A path changed kind or a folder changed class: other files may resolve differently, nothing can be narrowed. */
  structural: boolean;
  /** The rows that appeared (new, or back after having gone) and the rows that vanished in this pass. */
  addedIds: number[];
  removedIds: number[];
}

export type Progress = (p: { phase: string; done: number; total?: number; message?: string }) => void;

/** Bounded concurrency for filesystem calls. */
class Semaphore {
  private readonly queue: (() => void)[] = [];
  private active = 0;
  private readonly max: number;
  constructor(max: number) {
    this.max = max;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

interface WalkCtx {
  cfg: Config;
  excludePaths: Set<string>;
  excludeNames: Set<string>;
  vendorNames: Set<string>;
  markers: Set<string>;
  sem: Semaphore;
  entries: Entry[];
  progress?: Progress;
  counter: number;
}

/** Walks the roots with the engine chosen in the config; the native one falls back to the TypeScript walk in `auto`. */
export async function walk(cfg: Config, roots: string[], progress?: Progress): Promise<Entry[]> {
  setSecretPatterns(cfg.secretPatterns);
  const native = await nativeWalk(cfg, roots, progress);
  return native ?? walkTs(cfg, roots, progress);
}

export async function walkTs(cfg: Config, roots: string[], progress?: Progress): Promise<Entry[]> {
  setSecretPatterns(cfg.secretPatterns);
  const ctx: WalkCtx = {
    cfg,
    excludePaths: new Set(cfg.excludePaths),
    excludeNames: new Set(cfg.excludeNames),
    vendorNames: new Set(cfg.vendorNames),
    markers: new Set(PROJECT_MARKERS),
    sem: new Semaphore(48),
    entries: [],
    progress,
    counter: 0,
  };
  for (const root of roots) {
    if (isExcluded(ctx, root)) continue;
    const depth = root.split('/').length - 1;
    const parent = cfg.roots.includes(root) ? null : dirname(root);
    await walkDir(ctx, root, depth, parent);
  }
  return ctx.entries;
}

function isExcluded(ctx: WalkCtx, p: string): boolean {
  return ctx.excludePaths.has(p) || ctx.excludeNames.has(basename(p));
}

function tick(ctx: WalkCtx): void {
  ctx.counter++;
  if (ctx.progress && ctx.counter % 2000 === 0) ctx.progress({ phase: 'scan', done: ctx.counter });
}

/**
 * The main checkout of a linked Git worktree (`git worktree add`), from the text of its `.git` file:
 * `gitdir: <main>/.git/worktrees/<name>`. Null for anything else: a submodule points into `.git/modules/`, the
 * worktree of a bare repository into `<repo>.git/worktrees/`.
 */
export function worktreeMain(gitFile: string, dir: string): string | null {
  const m = /^gitdir:[ \t]*(.+?)[ \t]*\r?$/m.exec(gitFile);
  if (!m) return null;
  const gitDir = m[1].startsWith('/') ? resolve(m[1]) : resolve(dir, m[1]);
  const at = gitDir.indexOf('/.git/worktrees/');
  return at > 0 ? gitDir.slice(0, at) : null;
}

/**
 * A linked worktree whose main checkout is under a mapped root is a second copy of files already on the map: it is
 * counted like a vendor folder (one node with totals) instead of file by file. A root the person chose is always walked.
 */
async function isMappedWorktree(ctx: WalkCtx, dir: string, names: Dirent[]): Promise<boolean> {
  if (!names.some((d) => d.name === '.git' && d.isFile()) || ctx.cfg.roots.includes(dir)) return false;
  try {
    const main = worktreeMain(await ctx.sem.run(() => readHead(join(dir, '.git'), 1024)), dir);
    return main !== null && ctx.cfg.roots.some((r) => main === r || main.startsWith(r + '/'));
  } catch {
    return false;
  }
}

/** The first `bytes` of a file as text: a `.git` file is one short line, whatever else carries that name is not read whole. */
async function readHead(path: string, bytes: number): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(bytes), 0, bytes, 0);
    return buffer.toString('utf8', 0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function walkDir(ctx: WalkCtx, dir: string, depth: number, parent: string | null): Promise<DirStats> {
  const stats = emptyDirStats();
  const entry: Entry = {
    path: dir, parent, name: basename(dir) || dir, kind: 'dir', ext: '', cls: 'folder', lang: null,
    size: 0, mtime: 0, inode: 0, depth, aggregate: 0, linkTarget: null, stats,
  };
  ctx.entries.push(entry);
  tick(ctx);
  let names: Dirent[] = [];
  try {
    const [st, list] = await ctx.sem.run(async () => Promise.all([lstat(dir), readdir(dir, { withFileTypes: true })]));
    entry.mtime = st.mtimeMs;
    entry.inode = Number(st.ino);
    names = list;
  } catch {
    return stats;
  }
  const isVenv = names.some((d) => d.name === 'pyvenv.cfg');
  if (isVenv || await isMappedWorktree(ctx, dir, names)) {
    const agg = await aggregate(ctx, dir, names);
    entry.aggregate = 1;
    entry.cls = 'vendor';
    stats.files = agg.files;
    stats.bytes = agg.bytes;
    stats.childCount = names.length;
    return stats;
  }
  const tasks: Promise<void>[] = [];
  for (const d of names) {
    const name = d.name;
    if (ctx.excludeNames.has(name)) continue;
    const p = join(dir, name);
    if (ctx.excludePaths.has(p)) continue;
    if (ctx.markers.has(name)) stats.markers.push(name);
    stats.childCount++;
    if (d.isSymbolicLink()) {
      tasks.push(handleSymlink(ctx, p, depth + 1, dir).then(() => { stats.files += 0; }));
    } else if (d.isDirectory()) {
      if (ctx.vendorNames.has(name)) {
        tasks.push(handleVendor(ctx, p, depth + 1, dir).then((s) => { stats.files += s.files; stats.bytes += s.bytes; }));
      } else {
        tasks.push(walkDir(ctx, p, depth + 1, dir).then((s) => {
          stats.files += s.files; stats.bytes += s.bytes; stats.dataFiles += s.dataFiles; stats.mediaFiles += s.mediaFiles;
          stats.codeFiles += s.codeFiles; stats.docFiles += s.docFiles;
        }));
      }
    } else if (d.isFile()) {
      tasks.push(handleFile(ctx, p, depth + 1, dir).then((e) => {
        if (!e) return;
        stats.files++;
        stats.bytes += e.size;
        if (DATA_CLASSES.has(e.cls) || e.ext === 'txt') stats.dataFiles++;
        if (MEDIA_CLASSES.has(e.cls)) stats.mediaFiles++;
        if (e.cls === 'code') stats.codeFiles++;
        if (e.cls === 'doc') stats.docFiles++;
      }));
    }
  }
  await Promise.all(tasks);
  if (stats.markers.length === 0) {
    // a `.git` directory is excluded from the listing above, so look at the raw names
    if (names.some((d) => d.name === '.git')) stats.markers.push('.git');
  }
  entry.cls = classifyDir(stats, { vendor: false, dumpMinFiles: ctx.cfg.dumpMinFiles, dumpDataShare: ctx.cfg.dumpDataShare });
  return stats;
}

async function handleFile(ctx: WalkCtx, p: string, depth: number, parent: string): Promise<Entry | null> {
  try {
    const st = await ctx.sem.run(() => lstat(p));
    const name = basename(p);
    const fc = classifyFile(name);
    const e: Entry = {
      path: p, parent, name, kind: 'file', ext: fc.ext, cls: fc.cls, lang: fc.lang, size: st.size,
      mtime: st.mtimeMs, inode: Number(st.ino), depth, aggregate: 0, linkTarget: null, stats: null,
    };
    ctx.entries.push(e);
    tick(ctx);
    return e;
  } catch {
    return null;
  }
}

async function handleSymlink(ctx: WalkCtx, p: string, depth: number, parent: string): Promise<void> {
  try {
    const [st, target] = await ctx.sem.run(async () => Promise.all([lstat(p), readlink(p)]));
    const abs = target.startsWith('/') ? target : resolve(dirname(p), target);
    const e: Entry = {
      path: p, parent, name: basename(p), kind: 'symlink', ext: '', cls: 'other', lang: null, size: 0,
      mtime: st.mtimeMs, inode: Number(st.ino), depth, aggregate: 0, linkTarget: abs, stats: null,
    };
    ctx.entries.push(e);
    tick(ctx);
  } catch {
    /* dangling or unreadable link */
  }
}

async function handleVendor(ctx: WalkCtx, p: string, depth: number, parent: string): Promise<{ files: number; bytes: number }> {
  const entry: Entry = {
    path: p, parent, name: basename(p), kind: 'dir', ext: '', cls: 'vendor', lang: null, size: 0, mtime: 0, inode: 0,
    depth, aggregate: 1, linkTarget: null, stats: emptyDirStats(),
  };
  ctx.entries.push(entry);
  tick(ctx);
  try {
    const [st, names] = await ctx.sem.run(async () => Promise.all([lstat(p), readdir(p, { withFileTypes: true })]));
    entry.mtime = st.mtimeMs;
    entry.inode = Number(st.ino);
    const agg = await aggregate(ctx, p, names);
    entry.stats!.files = agg.files;
    entry.stats!.bytes = agg.bytes;
    entry.stats!.childCount = names.length;
    return agg;
  } catch {
    return { files: 0, bytes: 0 };
  }
}

/** Counts files and bytes of a subtree without creating nodes. */
async function aggregate(ctx: WalkCtx, dir: string, names: Dirent[]): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const tasks: Promise<void>[] = [];
  for (const d of names) {
    if (ctx.excludeNames.has(d.name)) continue;
    const p = join(dir, d.name);
    if (ctx.excludePaths.has(p)) continue;
    if (d.isDirectory()) {
      tasks.push(ctx.sem.run(() => readdir(p, { withFileTypes: true })).then((n) => aggregate(ctx, p, n)).then((s) => { files += s.files; bytes += s.bytes; }).catch(() => {}));
    } else if (d.isFile()) {
      tasks.push(ctx.sem.run(() => stat(p)).then((st) => { files++; bytes += st.size; }).catch(() => {}));
    }
  }
  await Promise.all(tasks);
  return { files, bytes };
}

interface ExistingRow {
  id: number;
  path: string;
  cls: string;
  ext: string | null;
  lang: string | null;
  size: number;
  mtime: number;
  inode: number | null;
  kind: string;
  deleted: number;
}

/** SQL fragment matching `path` equal to or below `dir`, without LIKE wildcards (`_` and `%` are legal in paths). */
function underClause(dir: string): { sql: string; args: [string, string, string] } {
  // a range on the path index: everything that starts with `dir/` sorts between `dir/` and `dir0` ('0' follows '/')
  return { sql: '(path = ? OR (path >= ? AND path < ?))', args: [dir, dir + '/', dir + '0'] };
}

export interface PartialPlan {
  /** Existing directories to walk, outermost only. */
  walk: string[];
  /** Existing files and symlinks to stat one by one (their directory is not walked). */
  files: string[];
  /** Paths that no longer exist: their rows are tombstoned, nothing is walked. */
  gone: string[];
  /** Directories whose totals must be recomputed from their children after the write, deepest first. */
  refresh: string[];
}

const outermost = (set: Iterable<string>): string[] => {
  const all = [...new Set(set)];
  return all.filter((p) => !all.some((q) => q !== p && p.startsWith(q + '/'))).sort();
};

/**
 * Merges nested paths and, when more than `max` remain, truncates the deepest ones one level at a time
 * (never above the first folder under their root) so a burst of events becomes a few subtrees instead of hundreds.
 */
export function coalesceSubtrees(paths: Iterable<string>, roots: string[], max: number): string[] {
  let list = outermost(paths);
  const rel = (p: string) => {
    const r = roots.find((x) => p === x || p.startsWith(x + '/'));
    return r ? relative(r, p).split(sep).filter(Boolean).length : 0;
  };
  while (list.length > max) {
    const deepest = Math.max(...list.map(rel));
    if (deepest <= 1) break;
    list = outermost(list.map((p) => (rel(p) === deepest ? dirname(p) : p)));
  }
  return list;
}

/**
 * Turns the paths reported by the watcher or the CLI into safe work: ignored areas are dropped, a path inside a
 * vendor/aggregate folder climbs to the folder above it, a new directory whose parent is unknown climbs to a known one,
 * a lone file is stat'ed instead of walking its folder, a vanished path is only tombstoned.
 */
export function planSubtrees(db: Db, cfg: Config, subtrees: string[]): PartialPlan {
  const excludePaths = new Set(cfg.excludePaths);
  const skipNames = new Set(cfg.excludeNames);
  const vendorNames = new Set(cfg.vendorNames);
  const rootOf = (p: string) => cfg.roots.find((r) => p === r || p.startsWith(r + '/'));
  const rowOf = (p: string) => db.get<{ aggregate: number; deleted: number; kind: string }>('SELECT aggregate, deleted, kind FROM nodes WHERE path = ?', p);
  const walkSet = new Set<string>();
  const fileSet = new Set<string>();
  const goneSet = new Set<string>();

  /** Nearest directory at or above `dir` that can be walked: outside aggregated folders and attached to a known parent. */
  const settle = (dir: string, root: string): string => {
    let p = dir;
    for (let guard = 0; guard < 64 && p !== root; guard++) {
      let aggregated: string | null = null;
      for (let a: string = p; a !== root && a.length > root.length; a = dirname(a)) {
        const r = rowOf(a);
        if (r && !r.deleted && r.aggregate === 1) aggregated = a; // keep the outermost
      }
      if (aggregated) { p = dirname(aggregated); continue; }
      const parentRow = rowOf(dirname(p));
      if (!parentRow || parentRow.deleted || parentRow.kind !== 'dir') { p = dirname(p); continue; }
      break;
    }
    return p;
  };

  for (const raw of subtrees) {
    let p = resolve(raw);
    const root = rootOf(p);
    if (!root || excludePaths.has(root)) continue;
    const segs = relative(root, p).split(sep).filter(Boolean);
    let ignored = false;
    let cut = segs.length;
    for (let i = 0; i < segs.length; i++) {
      if (skipNames.has(segs[i]) || excludePaths.has(join(root, ...segs.slice(0, i + 1)))) { ignored = true; break; }
      if (vendorNames.has(segs[i]) && i < cut) cut = i; // vendor folders are only a total: never walk inside them
    }
    if (ignored) continue;
    if (cut < segs.length) p = join(root, ...segs.slice(0, cut)); // climb to the folder that holds the vendor dir
    let st;
    try { st = lstatSync(p); } catch { goneSet.add(p); continue; }
    if (st.isDirectory()) walkSet.add(settle(p, root));
    else if (st.isFile() || st.isSymbolicLink()) {
      const dir = dirname(p);
      const settled = settle(dir, root);
      if (settled === dir && p !== root) fileSet.add(p); else walkSet.add(settled);
    }
  }

  const walkList = outermost(walkSet);
  const under = (p: string, dirs: string[]) => dirs.some((w) => p === w || p.startsWith(w + '/'));
  // paths below a directory we walk anyway are handled by that walk
  const fileList = [...fileSet].filter((f) => !under(f, walkList)).sort();
  const goneList = outermost(goneSet).filter((g) => !under(g, walkList));
  const refresh = new Set<string>();
  for (const start of [...walkList, ...fileList, ...goneList]) {
    const root = rootOf(start);
    if (!root) continue;
    for (let a: string = start; a !== root && a.length > root.length; ) { a = dirname(a); refresh.add(a); }
  }
  // directories that are walked themselves get their totals from the walk
  return { walk: walkList, files: fileList, gone: goneList, refresh: [...refresh].filter((r) => !walkList.includes(r)).sort((a, b) => b.length - a.length) };
}

/** Entries for individual files/symlinks, built like the walk would (same classification, same depth). */
async function statEntries(cfg: Config, paths: string[]): Promise<Entry[]> {
  if (!paths.length) return [];
  setSecretPatterns(cfg.secretPatterns);
  const ctx: WalkCtx = {
    cfg, excludePaths: new Set(cfg.excludePaths), excludeNames: new Set(cfg.excludeNames), vendorNames: new Set(cfg.vendorNames),
    markers: new Set(PROJECT_MARKERS), sem: new Semaphore(16), entries: [], counter: 0,
  };
  await Promise.all(paths.map(async (p) => {
    const depth = p.split('/').length - 1;
    const parent = dirname(p);
    try {
      if ((await lstat(p)).isSymbolicLink()) await handleSymlink(ctx, p, depth, parent);
      else await handleFile(ctx, p, depth, parent);
    } catch { /* vanished between the plan and now: the removal pass will tombstone it */ }
  }));
  return ctx.entries;
}

/**
 * Recomputes totals and the folder role of the directories above a partial walk, the way a full walk would:
 * files / bytes / child_count from their children, class from the file classes below them (vendor contents are only totals).
 */
function refreshAncestors(db: Db, cfg: Config, dirs: string[], reclassify = true): void {
  const upd = db.prepare(`UPDATE nodes SET
      files = (SELECT COALESCE(SUM(CASE c.kind WHEN 'file' THEN 1 WHEN 'dir' THEN c.files ELSE 0 END), 0) FROM nodes c WHERE c.parent_id = nodes.id AND c.deleted = 0 AND c.kind IN ('file', 'dir', 'symlink')),
      bytes = (SELECT COALESCE(SUM(CASE c.kind WHEN 'file' THEN c.size WHEN 'dir' THEN c.bytes ELSE 0 END), 0) FROM nodes c WHERE c.parent_id = nodes.id AND c.deleted = 0 AND c.kind IN ('file', 'dir', 'symlink')),
      child_count = (SELECT COUNT(*) FROM nodes c WHERE c.parent_id = nodes.id AND c.deleted = 0 AND c.kind IN ('file', 'dir', 'symlink'))
    WHERE id = ?`);
  const list = (set: Set<string>) => [...set].map((c) => `'${c}'`).join(', ');
  const counts = db.prepare(`SELECT
      COALESCE(SUM(cls IN (${list(DATA_CLASSES)}) OR ext = 'txt'), 0) AS data,
      COALESCE(SUM(cls IN (${list(MEDIA_CLASSES)})), 0) AS media,
      COALESCE(SUM(cls = 'code'), 0) AS code,
      COALESCE(SUM(cls = 'doc'), 0) AS doc
    FROM nodes WHERE +kind = 'file' AND deleted = 0 AND path >= ? AND path < ?`);
  const markerNames = new Set(PROJECT_MARKERS);
  const names = db.prepare("SELECT name FROM nodes WHERE parent_id = ? AND deleted = 0 AND kind IN ('file', 'dir', 'symlink')");
  const setCls = db.prepare('UPDATE nodes SET cls = ? WHERE id = ?');
  for (const d of dirs) { // deepest first: a parent sums its already refreshed children
    const row = db.get<{ id: number; aggregate: number; cls: string }>("SELECT id, aggregate, cls FROM nodes WHERE path = ? AND kind = 'dir' AND deleted = 0", d);
    if (!row || row.aggregate) continue;
    upd.run(row.id);
    // files only rewritten in place, in the same class: the totals moved, the roles of the folders cannot have
    if (!reclassify) continue;
    const t = db.get<{ files: number }>('SELECT files FROM nodes WHERE id = ?', row.id)!;
    const c = counts.get(d + '/', d + '0') as { data: number; media: number; code: number; doc: number };
    const stats = emptyDirStats();
    stats.files = t.files;
    stats.dataFiles = Number(c.data); stats.mediaFiles = Number(c.media); stats.codeFiles = Number(c.code); stats.docFiles = Number(c.doc);
    for (const n of names.all(row.id) as { name: string }[]) if (markerNames.has(n.name)) stats.markers.push(n.name);
    if (!stats.markers.length && existsSync(join(d, '.git'))) stats.markers.push('.git'); // `.git` is never a node
    const cls = classifyDir(stats, { vendor: false, dumpMinFiles: cfg.dumpMinFiles, dumpDataShare: cfg.dumpDataShare });
    setCls.run(cls, row.id);
    if (dumpish(row.cls) !== dumpish(cls)) invalidateBelow(db, d);
  }
}

/** Folder roles that change how the files below are read (hashing and text extraction skip dumps, media and vendor folders). */
const dumpish = (cls: string | null | undefined): boolean => cls === 'dump' || cls === 'media' || cls === 'vendor';

/** A folder moved in or out of a dump/media/vendor role: what was extracted below it was read under the other rules. */
function invalidateBelow(db: Db, dir: string): void {
  const range = [dir + '/', dir + '0'];
  db.run(`DELETE FROM refs WHERE node_id IN (SELECT id FROM nodes WHERE +kind = 'file' AND path >= ? AND path < ?)`, ...range);
  db.run(`DELETE FROM identifiers WHERE node_id IN (SELECT id FROM nodes WHERE +kind = 'file' AND path >= ? AND path < ?)`, ...range);
  db.run(`UPDATE nodes SET extracted = 0, hash = NULL, lines = NULL, terms = NULL, complexity = 0 WHERE +kind = 'file' AND deleted = 0 AND path >= ? AND path < ?`, ...range);
}

/** Walks the roots (or the given subtrees) and writes the nodes. Returns the scan summary. */
export async function scan(db: Db, cfg: Config, opts: { subtrees?: string[] } = {}, progress?: Progress): Promise<ScanSummary> {
  const t0 = Date.now();
  const gen = Number(db.getMeta('gen') ?? 0) + 1;
  const partial = Boolean(opts.subtrees && opts.subtrees.length);
  const plan: PartialPlan | null = partial ? planSubtrees(db, cfg, opts.subtrees!) : null;
  const roots = plan ? plan.walk : cfg.roots;
  const entries = roots.length ? await walk(cfg, roots, progress) : [];
  if (plan?.files.length) entries.push(...await statEntries(cfg, plan.files));
  // everything a partial run may have touched: a path that is neither seen nor listed here keeps its row
  const scope = plan ? [...plan.walk, ...plan.files, ...plan.gone] : [];
  progress?.({ phase: 'scan', done: entries.length, message: `${entries.length} voci lette` });

  const existing = new Map<string, ExistingRow>();
  const cols = 'id, path, cls, ext, lang, size, mtime, inode, kind, deleted';
  // `external` rows with the same path (a note on a file that did not exist yet) are converted in place, keeping their id
  // `+kind`: never pick the kind index (it holds most of the table) over the path range of a subtree
  const kinds = "+kind IN ('file', 'dir', 'symlink', 'external')";
  // read inside the write transaction below: a row the API creates while the walk runs must not be missed
  const loadExisting = () => {
    if (!plan) {
      for (const row of db.all<ExistingRow>(`SELECT ${cols} FROM nodes WHERE ${kinds}`)) existing.set(row.path, row);
    } else {
      // only what the walk can touch: the subtrees and the chain of directories above them
      for (const sub of scope) {
        const u = underClause(sub);
        for (const row of db.all<ExistingRow>(`SELECT ${cols} FROM nodes WHERE ${kinds} AND ${u.sql}`, ...u.args)) existing.set(row.path, row);
      }
      for (const sub of [...plan.walk, ...plan.files]) {
        const root = cfg.roots.find((r) => sub === r || sub.startsWith(r + '/'));
        const parent = dirname(sub);
        if (root && sub !== root && !existing.has(parent)) {
          const row = db.get<ExistingRow>(`SELECT ${cols} FROM nodes WHERE path = ? AND ${kinds}`, parent);
          if (row) existing.set(row.path, row);
        }
      }
    }
  };

  const ins = db.prepare(`INSERT INTO nodes (path, parent_id, name, kind, ext, cls, lang, size, bytes, files, depth, mtime, inode,
      aggregate, link_target, gen, deleted, extracted, child_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`);
  const updFile = db.prepare(`UPDATE nodes SET parent_id = ?, name = ?, kind = ?, ext = ?, cls = ?, lang = ?, size = ?, bytes = ?, depth = ?,
      mtime = ?, inode = ?, link_target = ?, gen = ?, deleted = 0, extracted = 0, hash = NULL, lines = NULL, terms = NULL,
      files = 0, child_count = 0, aggregate = 0 WHERE id = ?`);
  const touch = db.prepare('UPDATE nodes SET parent_id = ?, depth = ?, gen = ?, deleted = 0 WHERE id = ?');
  const updDir = db.prepare(`UPDATE nodes SET parent_id = ?, cls = ?, bytes = ?, files = ?, depth = ?, mtime = ?, inode = ?, aggregate = ?,
      gen = ?, deleted = 0, child_count = ? WHERE id = ?`);
  const delRefs = db.prepare('DELETE FROM refs WHERE node_id = ?');
  const delIds = db.prepare('DELETE FROM identifiers WHERE node_id = ?');

  let added = 0;
  let changed = 0;
  let structural = false;
  let reclassed = false;
  const changedFiles: number[] = [];
  const addedIds: number[] = [];
  const removedIds: number[] = [];
  const restyled: string[] = [];
  const idByPath = new Map<string, number>();

  db.tx(() => {
    loadExisting();
    if (plan) for (const row of existing.values()) if (!row.deleted) idByPath.set(row.path, row.id);
    let i = 0;
    for (const e of entries) {
      const parentId = e.parent ? (idByPath.get(e.parent) ?? null) : null;
      const prev = existing.get(e.path);
      if (e.kind === 'dir') {
        const s = e.stats!;
        if (prev && prev.kind === 'dir') {
          if (!prev.deleted && dumpish(prev.cls) !== dumpish(e.cls)) restyled.push(e.path);
          updDir.run(parentId, e.cls, s.bytes, s.files, e.depth, e.mtime, e.inode, e.aggregate, gen, s.childCount, prev.id);
          idByPath.set(e.path, prev.id);
          if (prev.deleted) { added++; addedIds.push(prev.id); }
        } else if (prev) {
          // the path changed kind (file -> dir): reuse the row with a stable id
          updDir.run(parentId, e.cls, s.bytes, s.files, e.depth, e.mtime, e.inode, e.aggregate, gen, s.childCount, prev.id);
          db.run("UPDATE nodes SET kind = 'dir', name = ?, ext = '', lang = NULL, size = 0, link_target = NULL, hash = NULL, extracted = 0 WHERE id = ?", e.name, prev.id);
          delRefs.run(prev.id);
          delIds.run(prev.id);
          idByPath.set(e.path, prev.id);
          changed++;
          structural = true;
        } else {
          const r = ins.run(e.path, parentId, e.name, 'dir', '', e.cls, null, 0, s.bytes, s.files, e.depth, e.mtime, e.inode, e.aggregate, null, gen, s.childCount);
          idByPath.set(e.path, Number(r.lastInsertRowid));
          added++; addedIds.push(Number(r.lastInsertRowid));
        }
      } else {
        // class/ext/lang are compared too: a new secret pattern or class rule must invalidate the extracted content of an untouched file
        const unchanged = prev && !prev.deleted && prev.kind === e.kind && prev.size === e.size && prev.mtime === e.mtime && (prev.inode ?? 0) === e.inode
          && prev.cls === e.cls && (prev.ext ?? '') === e.ext && (prev.lang ?? null) === e.lang;
        if (prev && unchanged) {
          touch.run(parentId, e.depth, gen, prev.id);
          idByPath.set(e.path, prev.id);
        } else if (prev) {
          updFile.run(parentId, e.name, e.kind, e.ext, e.cls, e.lang, e.size, e.size, e.depth, e.mtime, e.inode, e.linkTarget, gen, prev.id);
          delRefs.run(prev.id);
          delIds.run(prev.id);
          idByPath.set(e.path, prev.id);
          if (prev.deleted) { added++; addedIds.push(prev.id); } else changed++;
          if (!prev.deleted && prev.kind === e.kind) changedFiles.push(prev.id); else if (!prev.deleted) structural = true;
          if (prev.cls !== e.cls) reclassed = true;
        } else {
          const r = ins.run(e.path, parentId, e.name, e.kind, e.ext, e.cls, e.lang, e.size, e.size, 0, e.depth, e.mtime, e.inode, 0, e.linkTarget, gen, 0);
          idByPath.set(e.path, Number(r.lastInsertRowid));
          added++; addedIds.push(Number(r.lastInsertRowid));
        }
      }
      if (++i % 5000 === 0) progress?.({ phase: 'write', done: i, total: entries.length });
    }
  });

  if (restyled.length) db.tx(() => { for (const d of restyled) invalidateBelow(db, d); });

  // nodes not seen in this generation are gone
  let removed = 0;
  db.tx(() => {
    let rows: { id: number }[];
    if (plan) {
      rows = [];
      for (const sub of scope) {
        const u = underClause(sub);
        rows.push(...db.all<{ id: number }>(`SELECT id FROM nodes WHERE deleted = 0 AND gen < ? AND +kind IN ('file', 'dir', 'symlink') AND ${u.sql}`, gen, ...u.args));
      }
    } else {
      rows = db.all<{ id: number }>('SELECT id FROM nodes WHERE deleted = 0 AND gen < ? AND kind IN (\'file\', \'dir\', \'symlink\')', gen);
    }
    // deleted_at starts the wait after which Db.pruneDeleted may remove the row
    const mark = db.prepare('UPDATE nodes SET deleted = 1, deleted_at = ? WHERE id = ?');
    const goneAt = Date.now();
    const dropEdges = db.prepare("DELETE FROM edges WHERE (src = ? OR dst = ?) AND origin = 'scan'");
    for (const r of rows) {
      mark.run(goneAt, r.id);
      dropEdges.run(r.id, r.id);
      delRefs.run(r.id);
      delIds.run(r.id);
      removed++; removedIds.push(r.id);
    }
    if (plan) refreshAncestors(db, cfg, plan.refresh, added > 0 || removed > 0 || structural || reclassed || restyled.length > 0);
  });

  db.setMeta('gen', gen);
  const ms = Date.now() - t0;
  return { gen, seen: entries.length, added, changed, removed, ms, changedFiles, structural: structural || restyled.length > 0, addedIds, removedIds };
}
