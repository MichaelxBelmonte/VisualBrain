// Indexing pipeline: scan → extract → projects → edges → seeds → ranking.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Db } from './db.ts';
import type { Config } from './config.ts';
import { scan, type Progress, type ScanSummary } from './scan.ts';
import { extract } from './extract.ts';
import { TEXT_CLASSES } from './classify.ts';
import { detectProjects } from './projects.ts';
import { buildEdges } from './graph.ts';
import { importSeeds } from './seed.ts';
import { rank } from './rank.ts';
import { IndexMetrics, splitter, type PhaseMetric } from './metrics.ts';

export interface IndexSummary {
  scan: ScanSummary;
  extracted: number;
  projects: number;
  edges: number;
  ms: number;
  /** Time and memory per phase (scan, projects, extract, edges, seed, rank, fts…). */
  phases: PhaseMetric[];
}

interface FileRow { id: number; path: string; name: string; ext: string; cls: string; lang: string | null; size: number; parent_id: number | null }

const TEXT_DATA_EXT = new Set(['json', 'jsonl', 'ndjson', 'xml', 'svg']);
const SMALL = 256 * 1024;

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Where the extraction time goes: `read` is the wall time of the reads and of the CPU work in between. */
export interface ExtractStats { readMs: number; hashMs: number; extractMs: number; writeMs: number; bytes: number; texts: number; refs: number; identifiers: number }

/** Hashes and extracts every file row flagged `extracted = 0`. */
export async function extractAll(db: Db, cfg: Config, progress?: Progress, stats?: ExtractStats): Promise<number> {
  const dumpDirs = new Set<number>();
  const parentOf = new Map<number, number | null>();
  for (const r of db.all<{ id: number; parent_id: number | null; cls: string }>("SELECT id, parent_id, cls FROM nodes WHERE kind = 'dir' AND deleted = 0")) {
    parentOf.set(r.id, r.parent_id);
    if (r.cls === 'dump' || r.cls === 'vendor' || r.cls === 'media') dumpDirs.add(r.id);
  }
  const inDumpCache = new Map<number, boolean>();
  const inDump = (dirId: number | null): boolean => {
    if (dirId === null) return false;
    const c = inDumpCache.get(dirId);
    if (c !== undefined) return c;
    const v = dumpDirs.has(dirId) || inDump(parentOf.get(dirId) ?? null);
    inDumpCache.set(dirId, v);
    return v;
  };
  const projectRootOf = new Map<number, string>();
  for (const r of db.all<{ id: number; path: string }>('SELECT p.id, n.path FROM projects p JOIN nodes n ON n.id = p.node_id')) projectRootOf.set(r.id, r.path);
  const projectByNode = new Map<number, number | null>();
  for (const r of db.all<{ id: number; project_id: number | null }>("SELECT id, project_id FROM nodes WHERE deleted = 0 AND kind = 'file' AND extracted = 0")) projectByNode.set(r.id, r.project_id);

  const todo = db.all<FileRow>("SELECT id, path, name, ext, cls, lang, size, parent_id FROM nodes WHERE kind = 'file' AND deleted = 0 AND extracted = 0 AND cls <> 'secret'");
  const upd = db.prepare('UPDATE nodes SET hash = ?, lines = ?, complexity = ?, terms = ?, extracted = 1 WHERE id = ?');
  const markDone = db.prepare('UPDATE nodes SET extracted = 1 WHERE id = ?');
  const insRef = db.prepare('INSERT INTO refs (node_id, kind, target, line, snippet, relative_to) VALUES (?, ?, ?, ?, ?, ?)');
  const insId = db.prepare('INSERT OR IGNORE INTO identifiers (token, node_id, line) VALUES (?, ?, ?)');

  let done = 0;
  const total = todo.length;
  const BATCH = 400;
  for (let i = 0; i < total; i += BATCH) {
    const slice = todo.slice(i, i + BATCH);
    const tBatch = performance.now();
    const results = await Promise.all(slice.map(async (f) => {
      const dump = inDump(f.parent_id);
      const wantHash = f.size > 0 && f.size <= cfg.maxHashBytes && !dump;
      const textual = TEXT_CLASSES.has(f.cls) || f.cls === 'log' || (f.cls === 'data' && TEXT_DATA_EXT.has(f.ext));
      const wantText = textual && f.size > 0 && f.size <= (f.cls === 'log' || f.cls === 'data' ? SMALL : cfg.maxTextBytes) && !(dump && f.cls !== 'code' && f.cls !== 'doc');
      if (!wantHash && !wantText) return { f, hash: null, res: null };
      try {
        const buf = await readFile(f.path);
        const t1 = performance.now();
        const hash = wantHash ? createHash('sha1').update(buf).digest('hex') : null;
        const t2 = performance.now();
        if (stats) { stats.hashMs += t2 - t1; stats.bytes += buf.length; }
        if (!wantText || isBinary(buf)) return { f, hash, res: null };
        const projectId = projectByNode.get(f.id) ?? null;
        const res = extract({
          path: f.path, content: buf.toString('utf8'), ext: f.ext, cls: f.cls, lang: f.lang,
          projectRoot: projectId === null ? null : (projectRootOf.get(projectId) ?? null),
        });
        if (stats) { stats.extractMs += performance.now() - t2; stats.texts++; }
        return { f, hash, res };
      } catch {
        return { f, hash: null, res: null };
      }
    }));
    const tWrite = performance.now();
    if (stats) stats.readMs += tWrite - tBatch;
    db.tx(() => {
      for (const { f, hash, res } of results) {
        if (!res) {
          if (hash) upd.run(hash, null, 0, null, f.id); else markDone.run(f.id);
          continue;
        }
        const top = Object.entries(res.terms).sort((a, b) => b[1] - a[1]).slice(0, 60);
        upd.run(hash, res.lines, res.complexity, top.length ? JSON.stringify(Object.fromEntries(top)) : null, f.id);
        for (const r of res.refs.slice(0, 500)) insRef.run(f.id, r.kind, r.target, r.line, r.snippet.slice(0, 160), r.relativeTo);
        for (const r of res.externalRefs.slice(0, 100)) insRef.run(f.id, 'external', r.target, r.line, r.snippet.slice(0, 160), 'absolute');
        for (const p of [...new Set(res.packages)].slice(0, 100)) insRef.run(f.id, 'package', p, null, null, 'name');
        for (const t of res.identifiers.slice(0, 200)) insId.run(t.token, f.id, t.line);
        if (stats) { stats.refs += Math.min(res.refs.length, 500); stats.identifiers += Math.min(res.identifiers.length, 200); }
      }
    });
    if (stats) stats.writeMs += performance.now() - tWrite;
    done += slice.length;
    progress?.({ phase: 'extract', done, total });
  }
  return total;
}

export async function runIndex(db: Db, cfg: Config, opts: { subtrees?: string[]; reextract?: boolean; metrics?: IndexMetrics } = {}, progress?: Progress): Promise<IndexSummary> {
  const t0 = Date.now();
  const m = opts.metrics ?? new IndexMetrics();
  m.measure('prepare', () => {
    if (opts.reextract) {
      db.tx(() => {
        db.exec("UPDATE nodes SET extracted = 0, hash = NULL, lines = NULL, terms = NULL WHERE kind = 'file' AND deleted = 0");
        db.exec('DELETE FROM refs');
        db.exec('DELETE FROM identifiers');
      });
    }
    // external identities that point inside the roots are provisional: rebuilt from the current references every run
    db.tx(() => {
      for (const root of cfg.roots) {
        db.run(`DELETE FROM nodes WHERE kind = 'external' AND (path = ? OR path LIKE ?)
          AND id NOT IN (SELECT src FROM edges WHERE origin = 'user') AND id NOT IN (SELECT dst FROM edges WHERE origin = 'user')`, root, root + '/%');
      }
      db.exec('DELETE FROM edges WHERE src NOT IN (SELECT id FROM nodes) OR dst NOT IN (SELECT id FROM nodes)');
    });
  });
  const s = await m.measureAsync('scan', () => scan(db, cfg, opts, progress), (r) => ({ seen: r.seen, added: r.added, changed: r.changed, removed: r.removed }));
  progress?.({ phase: 'scan', done: s.seen, message: `scansione: ${s.seen} voci, ${s.added} nuove, ${s.changed} cambiate, ${s.removed} sparite (${s.ms} ms)` });
  const projects = m.measure('projects', () => detectProjects(db, (msg) => progress?.({ phase: 'projects', done: 0, message: msg })), (n) => ({ projects: n }));
  const xs: ExtractStats = { readMs: 0, hashMs: 0, extractMs: 0, writeMs: 0, bytes: 0, texts: 0, refs: 0, identifiers: 0 };
  const extracted = await m.measureAsync('extract', () => extractAll(db, cfg, progress, xs), (n) => ({
    files: n, texts: xs.texts, bytes: xs.bytes, refs: xs.refs, identifiers: xs.identifiers,
    readMs: Math.round(xs.readMs), hashMs: Math.round(xs.hashMs), extractMs: Math.round(xs.extractMs), writeMs: Math.round(xs.writeMs),
  }));
  progress?.({ phase: 'extract', done: extracted, total: extracted, message: `estratti ${extracted} file` });
  // projects again: technologies from manifests do not change, but new project dirs may have appeared
  const edgeSteps = splitter('edges', ['refs', 'duplicate', 'shared_id', 'similar'], m, (msg) => progress?.({ phase: 'edges', done: 0, message: msg }));
  const edges = m.measure('edges', () => buildEdges(db, cfg, edgeSteps), (n) => ({ edges: n }));
  m.measure('seed', () => importSeeds(db, cfg, (msg) => progress?.({ phase: 'seed', done: 0, message: msg })));
  // external identities that no edge uses any more (and empty external groups)
  m.measure('externals', () => {
    for (let i = 0; i < 3; i++) {
      const r = db.run(`DELETE FROM nodes WHERE kind = 'external'
        AND id NOT IN (SELECT src FROM edges) AND id NOT IN (SELECT dst FROM edges)
        AND id NOT IN (SELECT parent_id FROM nodes WHERE parent_id IS NOT NULL)`);
      if (Number(r.changes) === 0) break;
    }
  });
  m.measure('rank', () => rank(db, (msg) => progress?.({ phase: 'rank', done: 0, message: msg })));
  m.measure('fts', () => db.rebuildFts());
  const ms = Date.now() - t0;
  db.setMeta('lastScan', Date.now());
  db.setMeta('scanMs', ms);
  db.setMeta('indexPhases', JSON.stringify(m.phases));
  return { scan: s, extracted, projects, edges, ms, phases: m.phases };
}
