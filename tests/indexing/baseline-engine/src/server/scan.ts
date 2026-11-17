// Filesystem walk of the roots → node rows. Incremental: unchanged files keep their row and extraction.
import { readdir, lstat, readlink, stat } from 'node:fs/promises';
import { join, dirname, resolve, basename } from 'node:path';
import type { Dirent } from 'node:fs';
import type { Db } from './db.ts';
import type { Config } from './config.ts';
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

export async function walk(cfg: Config, roots: string[], progress?: Progress): Promise<Entry[]> {
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
  if (isVenv) {
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
  size: number;
  mtime: number;
  inode: number | null;
  kind: string;
  deleted: number;
}

/** Walks the roots (or the given subtrees) and writes the nodes. Returns the scan summary. */
export async function scan(db: Db, cfg: Config, opts: { subtrees?: string[] } = {}, progress?: Progress): Promise<ScanSummary> {
  const t0 = Date.now();
  const gen = Number(db.getMeta('gen') ?? 0) + 1;
  const partial = Boolean(opts.subtrees && opts.subtrees.length);
  const roots = partial ? opts.subtrees! : cfg.roots;
  const entries = await walk(cfg, roots, progress);
  progress?.({ phase: 'scan', done: entries.length, message: `${entries.length} voci lette` });

  const existing = new Map<string, ExistingRow>();
  for (const row of db.all<ExistingRow>('SELECT id, path, size, mtime, inode, kind, deleted FROM nodes WHERE kind IN (\'file\', \'dir\', \'symlink\')')) {
    existing.set(row.path, row);
  }

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
  const idByPath = new Map<string, number>();
  // parents of partial subtrees already exist
  if (partial) {
    for (const row of existing.values()) if (!row.deleted) idByPath.set(row.path, row.id);
  }

  db.tx(() => {
    let i = 0;
    for (const e of entries) {
      const parentId = e.parent ? (idByPath.get(e.parent) ?? null) : null;
      const prev = existing.get(e.path);
      if (e.kind === 'dir') {
        const s = e.stats!;
        if (prev && prev.kind === 'dir') {
          updDir.run(parentId, e.cls, s.bytes, s.files, e.depth, e.mtime, e.inode, e.aggregate, gen, s.childCount, prev.id);
          idByPath.set(e.path, prev.id);
          if (prev.deleted) added++;
        } else if (prev) {
          // the path changed kind (file -> dir): reuse the row with a stable id
          updDir.run(parentId, e.cls, s.bytes, s.files, e.depth, e.mtime, e.inode, e.aggregate, gen, s.childCount, prev.id);
          db.run("UPDATE nodes SET kind = 'dir', name = ?, ext = '', lang = NULL, size = 0, link_target = NULL, hash = NULL, extracted = 0 WHERE id = ?", e.name, prev.id);
          delRefs.run(prev.id);
          delIds.run(prev.id);
          idByPath.set(e.path, prev.id);
          changed++;
        } else {
          const r = ins.run(e.path, parentId, e.name, 'dir', '', e.cls, null, 0, s.bytes, s.files, e.depth, e.mtime, e.inode, e.aggregate, null, gen, s.childCount);
          idByPath.set(e.path, Number(r.lastInsertRowid));
          added++;
        }
      } else {
        const unchanged = prev && !prev.deleted && prev.kind === e.kind && prev.size === e.size && prev.mtime === e.mtime && (prev.inode ?? 0) === e.inode;
        if (prev && unchanged) {
          touch.run(parentId, e.depth, gen, prev.id);
          idByPath.set(e.path, prev.id);
        } else if (prev) {
          updFile.run(parentId, e.name, e.kind, e.ext, e.cls, e.lang, e.size, e.size, e.depth, e.mtime, e.inode, e.linkTarget, gen, prev.id);
          delRefs.run(prev.id);
          delIds.run(prev.id);
          idByPath.set(e.path, prev.id);
          if (prev.deleted) added++; else changed++;
        } else {
          const r = ins.run(e.path, parentId, e.name, e.kind, e.ext, e.cls, e.lang, e.size, e.size, 0, e.depth, e.mtime, e.inode, 0, e.linkTarget, gen, 0);
          idByPath.set(e.path, Number(r.lastInsertRowid));
          added++;
        }
      }
      if (++i % 5000 === 0) progress?.({ phase: 'write', done: i, total: entries.length });
    }
  });

  // nodes not seen in this generation are gone
  let removed = 0;
  db.tx(() => {
    let rows: { id: number }[];
    if (partial) {
      rows = [];
      for (const sub of roots) {
        rows.push(...db.all<{ id: number }>('SELECT id FROM nodes WHERE deleted = 0 AND gen < ? AND kind IN (\'file\', \'dir\', \'symlink\') AND (path = ? OR path LIKE ?)', gen, sub, sub + '/%'));
      }
    } else {
      rows = db.all<{ id: number }>('SELECT id FROM nodes WHERE deleted = 0 AND gen < ? AND kind IN (\'file\', \'dir\', \'symlink\')', gen);
    }
    const mark = db.prepare('UPDATE nodes SET deleted = 1 WHERE id = ?');
    const dropEdges = db.prepare("DELETE FROM edges WHERE (src = ? OR dst = ?) AND origin = 'scan'");
    for (const r of rows) {
      mark.run(r.id);
      dropEdges.run(r.id, r.id);
      delRefs.run(r.id);
      delIds.run(r.id);
      removed++;
    }
  });

  db.setMeta('gen', gen);
  const ms = Date.now() - t0;
  return { gen, seen: entries.length, added, changed, removed, ms };
}
