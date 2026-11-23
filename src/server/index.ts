// Indexing pipeline: scan → extract → projects → edges → seeds → ranking.
import { performance } from 'node:perf_hooks';
import type { Db } from './db.ts';
import type { Config } from './config.ts';
import { scan, type Progress, type ScanSummary } from './scan.ts';
import { ExtractPool, extractFile, extractWorkers, type ExtractJob, type ExtractOutcome } from './extract-pool.ts';
import { PROJECT_MARKERS, TEXT_CLASSES } from './classify.ts';
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

/** External identities carrying something a person or an agent added: notes, non-scan edges, hidden edges. */
const ANNOTATED_EXTERNAL = `id IN (SELECT node_id FROM notes)
  OR id IN (SELECT src FROM edges WHERE origin <> 'scan' OR hidden = 1)
  OR id IN (SELECT dst FROM edges WHERE origin <> 'scan' OR hidden = 1)`;

const TEXT_DATA_EXT = new Set(['json', 'jsonl', 'ndjson', 'xml', 'svg']);
const SMALL = 256 * 1024;

/** Below this many files the workers' startup costs more than they save. */
const POOL_MIN_FILES = 200;

/** Where the extraction time goes: `read` is the wall time spent waiting for extracted batches; `hash` and `extract` add up the CPU time of all workers, so with a pool they can exceed the wall time. */
export interface ExtractStats { readMs: number; hashMs: number; extractMs: number; writeMs: number; bytes: number; texts: number; refs: number; identifiers: number }

/** Hashes and extracts every file row flagged `extracted = 0`. */
export async function extractAll(db: Db, cfg: Config, progress?: Progress, stats?: ExtractStats, ids?: number[]): Promise<number> {
  // folders are looked up as the files ask for them: a pass over a few files reads a few folders, not all of them
  const dirRow = db.prepare("SELECT parent_id, cls FROM nodes WHERE id = ? AND kind = 'dir' AND deleted = 0");
  const inDumpCache = new Map<number, boolean>();
  const inDump = (dirId: number | null): boolean => {
    if (dirId === null) return false;
    const c = inDumpCache.get(dirId);
    if (c !== undefined) return c;
    const r = dirRow.get(dirId) as { parent_id: number | null; cls: string } | undefined;
    const v = r !== undefined && (r.cls === 'dump' || r.cls === 'vendor' || r.cls === 'media' || inDump(r.parent_id));
    inDumpCache.set(dirId, v);
    return v;
  };
  const projectRootOf = new Map<number, string>();
  for (const r of db.all<{ id: number; path: string }>('SELECT p.id, n.path FROM projects p JOIN nodes n ON n.id = p.node_id')) projectRootOf.set(r.id, r.path);
  const projectByNode = new Map<number, number | null>();
  for (const r of db.all<{ id: number; project_id: number | null }>("SELECT id, project_id FROM nodes INDEXED BY nodes_pending WHERE deleted = 0 AND kind = 'file' AND extracted = 0")) projectByNode.set(r.id, r.project_id);

  const todo = db.all<FileRow>("SELECT id, path, name, ext, cls, lang, size, parent_id FROM nodes INDEXED BY nodes_pending WHERE kind = 'file' AND deleted = 0 AND extracted = 0 AND cls <> 'secret'");
  const upd = db.prepare('UPDATE nodes SET hash = ?, lines = ?, complexity = ?, terms = ?, extracted = 1 WHERE id = ?');
  const markDone = db.prepare('UPDATE nodes SET extracted = 1 WHERE id = ?');
  const insRef = db.prepare('INSERT INTO refs (node_id, kind, target, line, snippet, relative_to) VALUES (?, ?, ?, ?, ?, ?)');
  const insId = db.prepare('INSERT OR IGNORE INTO identifiers (token, node_id, line) VALUES (?, ?, ?)');

  if (ids) for (const f of todo) ids.push(f.id);
  let done = 0;
  const total = todo.length;
  const BATCH = 400;
  const jobOf = (f: FileRow): ExtractJob => {
    const dump = inDump(f.parent_id);
    const wantHash = f.size > 0 && f.size <= cfg.maxHashBytes && !dump;
    const textual = TEXT_CLASSES.has(f.cls) || f.cls === 'log' || (f.cls === 'data' && TEXT_DATA_EXT.has(f.ext));
    const wantText = textual && f.size > 0 && f.size <= (f.cls === 'log' || f.cls === 'data' ? SMALL : cfg.maxTextBytes) && !(dump && f.cls !== 'code' && f.cls !== 'doc');
    const projectId = projectByNode.get(f.id) ?? null;
    return { path: f.path, ext: f.ext, cls: f.cls, lang: f.lang, projectRoot: projectId === null ? null : (projectRootOf.get(projectId) ?? null), wantHash, wantText };
  };
  // Extraction runs on worker threads when there is enough to do; the writes below stay here, in `todo` order.
  const workers = extractWorkers();
  const pool = workers > 1 && total >= POOL_MIN_FILES ? new ExtractPool(workers) : null;
  const CHUNK = 25;
  const runBatch = (slice: FileRow[]): Promise<ExtractOutcome[]> => {
    const jobs = slice.map(jobOf);
    if (!pool) return Promise.all(jobs.map(extractFile));
    const chunks: Promise<ExtractOutcome[]>[] = [];
    for (let j = 0; j < jobs.length; j += CHUNK) chunks.push(pool.run(jobs.slice(j, j + CHUNK)));
    return Promise.all(chunks).then((parts) => parts.flat());
  };
  try {
    let tBatch = performance.now();
    let next = total ? runBatch(todo.slice(0, BATCH)) : null;
    for (let i = 0; i < total; i += BATCH) {
      const slice = todo.slice(i, i + BATCH);
      const outcomes = await next!;
      // the next batch is extracted while this one is written
      next = i + BATCH < total ? runBatch(todo.slice(i + BATCH, i + 2 * BATCH)) : null;
      const tWrite = performance.now();
      if (stats) stats.readMs += tWrite - tBatch;
      db.tx(() => {
        for (let k = 0; k < slice.length; k++) {
          const f = slice[k], { hash, res } = outcomes[k];
          if (stats) {
            stats.hashMs += outcomes[k].hashMs;
            stats.bytes += outcomes[k].bytes;
            if (res) { stats.extractMs += outcomes[k].extractMs; stats.texts++; }
          }
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
      tBatch = performance.now();
      if (stats) stats.writeMs += tBatch - tWrite;
      done += slice.length;
      progress?.({ phase: 'extract', done, total });
    }
  } finally {
    await pool?.close();
  }
  return total;
}

/** Version of the import readers: 2 = tree-sitter for Python, Go, Java and C/C++ and the Kotlin rule (0.2.32). */
const EXTRACTOR = '2';
/** After a pass that only rewrote some files, the global weights (rank, similarity) wait at most this long. */
export const GLOBAL_EVERY_MS = 10 * 60_000;

/** Drops provisional external identities inside the roots and the edges left without an end (rebuilt by the pass). */
function dropProvisional(db: Db, cfg: Config): void {
  db.tx(() => {
    for (const root of cfg.roots) {
      db.run(`DELETE FROM nodes WHERE kind = 'external' AND (path = ? OR substr(path, 1, ?) = ?) AND NOT (${ANNOTATED_EXTERNAL})`,
        root, root.length + 1, root + '/');
    }
    db.exec('DELETE FROM edges WHERE src NOT IN (SELECT id FROM nodes) OR dst NOT IN (SELECT id FROM nodes)');
  });
}
const EXTRACTOR_LANGS = ['python', 'go', 'java', 'kotlin', 'c', 'cpp', 'objc', 'cuda'];

export async function runIndex(db: Db, cfg: Config, opts: { subtrees?: string[]; reextract?: boolean; metrics?: IndexMetrics } = {}, progress?: Progress): Promise<IndexSummary> {
  const t0 = Date.now();
  const m = opts.metrics ?? new IndexMetrics();
  // First start of a full pass: the structure is shown as soon as it is scanned, extraction and edges follow in background.
  const firstMap = !opts.subtrees?.length && db.getMeta('lastScan') === null;
  // A pass over some paths of an index already built by this extractor may turn out to have only rewritten files in place;
  // its clean-up then waits until the scan says so (see `narrow` below).
  const narrowable = Boolean(opts.subtrees?.length) && !opts.reextract && db.getMeta('lastScan') !== null && db.getMeta('extractor') === EXTRACTOR;
  m.measure('prepare', () => {
    // A newer extractor for some languages: their files are read again once, the others keep what they had.
    if (!opts.reextract && db.getMeta('lastScan') !== null && db.getMeta('extractor') !== EXTRACTOR) {
      const files = `kind = 'file' AND deleted = 0 AND lang IN (${EXTRACTOR_LANGS.map(l => `'${l}'`).join(', ')})`;
      db.tx(() => {
        db.exec(`DELETE FROM refs WHERE node_id IN (SELECT id FROM nodes WHERE ${files})`);
        db.exec(`UPDATE nodes SET extracted = 0 WHERE ${files}`);
      });
    }
    if (opts.reextract) {
      db.tx(() => {
        db.exec("UPDATE nodes SET extracted = 0, hash = NULL, lines = NULL, terms = NULL WHERE kind = 'file' AND deleted = 0");
        db.exec('DELETE FROM refs');
        db.exec('DELETE FROM identifiers');
      });
    }
    // external identities that point inside the roots are provisional: rebuilt from the current references every run,
    // unless annotated (the scan then turns them into the real file in place when it appears, keeping the id)
    if (!narrowable) dropProvisional(db, cfg);
  });
  const s = await m.measureAsync('scan', () => scan(db, cfg, opts, progress), (r) => ({ seen: r.seen, added: r.added, changed: r.changed, removed: r.removed }));
  // Only files rewritten in place: every other file resolves its references as before, so only the rewritten (and
  // re-read) files get their edges rebuilt, and the provisional identities the others point at must stay.
  const narrow = narrowable && s.added === 0 && s.removed === 0 && !s.structural;
  if (narrowable && !narrow) m.measure('prepare', () => dropProvisional(db, cfg));
  progress?.({ phase: 'scan', done: s.seen, message: `scansione: ${s.seen} voci, ${s.added} nuove, ${s.changed} cambiate, ${s.removed} sparite (${s.ms} ms)` });
  // After a narrow scan, projects can change only through their manifests (technologies, dependencies).
  const manifests = new Set([...PROJECT_MARKERS, 'requirements-dev.txt']);
  const manifestChanged = narrow && s.changedFiles.length > 0
    && db.all<{ name: string }>('SELECT name FROM nodes WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(s.changedFiles)).some((r) => manifests.has(r.name));
  const projects = narrow && !manifestChanged ? Number(db.get<{ c: number }>('SELECT COUNT(*) c FROM projects')?.c ?? 0)
    : m.measure('projects', () => detectProjects(db, (msg) => progress?.({ phase: 'projects', done: 0, message: msg })), (n) => ({ projects: n }));
  if (firstMap) {
    // Folders, files and projects are in the database: the server publishes the map now (its cache ranks the nodes in memory
    // while the database is still unranked, see GraphCache.load); the stored ranking comes at the end of the pass.
    progress?.({ phase: 'map', done: s.seen, message: 'mappa pronta' });
  }
  const xs: ExtractStats = { readMs: 0, hashMs: 0, extractMs: 0, writeMs: 0, bytes: 0, texts: 0, refs: 0, identifiers: 0 };
  const reread: number[] = [];
  const extracted = await m.measureAsync('extract', () => extractAll(db, cfg, progress, xs, reread), (n) => ({
    files: n, texts: xs.texts, bytes: xs.bytes, refs: xs.refs, identifiers: xs.identifiers,
    readMs: Math.round(xs.readMs), hashMs: Math.round(xs.hashMs), extractMs: Math.round(xs.extractMs), writeMs: Math.round(xs.writeMs),
  }));
  progress?.({ phase: 'extract', done: extracted, total: extracted, message: `estratti ${extracted} file` });
  // projects again: technologies from manifests do not change, but new project dirs may have appeared
  const edgeSteps = splitter('edges', ['refs', 'duplicate', 'shared_id', 'similar'], m, (msg) => progress?.({ phase: 'edges', done: 0, message: msg }));
  // Rank and similarity read the whole graph: after a narrow pass they run again only when their last run is old enough.
  const due = (key: string) => !narrow || Date.now() - Number(db.getMeta(key) ?? 0) >= GLOBAL_EVERY_MS;
  const only = narrow ? [...new Set([...s.changedFiles, ...reread])] : undefined;
  const similar = due('similarAt');
  const edges = only && only.length === 0 && !similar ? 0
    : m.measure('edges', () => buildEdges(db, cfg, edgeSteps, { only, similar }), (n) => ({ edges: n }));
  if (similar) db.setMeta('similarAt', Date.now());
  m.measure('seed', () => importSeeds(db, cfg, (msg) => progress?.({ phase: 'seed', done: 0, message: msg })));
  // external identities that no edge uses any more (and empty external groups)
  m.measure('externals', () => {
    for (let i = 0; i < 3; i++) {
      const r = db.run(`DELETE FROM nodes WHERE kind = 'external'
        AND id NOT IN (SELECT src FROM edges) AND id NOT IN (SELECT dst FROM edges)
        AND id NOT IN (SELECT parent_id FROM nodes WHERE parent_id IS NOT NULL)
        AND id NOT IN (SELECT node_id FROM notes)`);
      if (Number(r.changes) === 0) break;
    }
  });
  if (due('rankAt')) {
    m.measure('rank', () => rank(db, (msg) => progress?.({ phase: 'rank', done: 0, message: msg })));
    db.setMeta('rankAt', Date.now());
  }
  // names and paths only change when paths appear, vanish or change kind
  if (!narrow) m.measure('fts', () => db.rebuildFts());
  // A full pass has just told which paths are gone: rows that have been gone long enough, with nothing attached, leave now.
  if (!opts.subtrees?.length) m.measure('prune', () => db.pruneDeleted(), (n) => ({ pruned: n }));
  const ms = Date.now() - t0;
  db.setMeta('lastScan', Date.now());
  db.setMeta('extractor', EXTRACTOR);
  db.setMeta('scanMs', ms);
  db.setMeta('indexPhases', JSON.stringify(m.phases));
  return { scan: s, extracted, projects, edges, ms, phases: m.phases };
}
