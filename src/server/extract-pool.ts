// Content extraction of single files (read, hash, extract) and a pool of worker threads that runs it in parallel.
// The work per file is pure: the caller keeps the database writes, in its own order, so the index does not
// depend on which worker finished first. The same module is the worker's entry point.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { performance } from 'node:perf_hooks';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { extract, type ExtractResult } from './extract.ts';
import { loadSyntax } from './syntax.ts';

export interface ExtractJob { path: string; ext: string; cls: string; lang: string | null; projectRoot: string | null; wantHash: boolean; wantText: boolean }
export interface ExtractOutcome { hash: string | null; res: ExtractResult | null; bytes: number; hashMs: number; extractMs: number }

const NONE: ExtractOutcome = { hash: null, res: null, bytes: 0, hashMs: 0, extractMs: 0 };

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

const goModules = new Map<string, Promise<{ path: string; dir: string } | null>>();

/** The nearest go.mod from the file's folder up to its project root: local imports then point at folders of this module. */
function goModule(dir: string, root: string | null, depth = 0): Promise<{ path: string; dir: string } | null> {
  let found = goModules.get(dir);
  if (!found) {
    found = readFile(join(dir, 'go.mod'), 'utf8').then(
      text => { const m = /^\s*module\s+("?)([^\s"]+)\1/m.exec(text); return m ? { path: m[2], dir } : null; },
      () => (dir === root || depth >= 12 || dirname(dir) === dir ? null : goModule(dirname(dir), root, depth + 1)),
    );
    if (goModules.size > 5000) goModules.clear();
    goModules.set(dir, found);
  }
  return found;
}

/** Reads, hashes and extracts one file. An unreadable file gives no hash and no result, as before the pool. */
export async function extractFile(job: ExtractJob): Promise<ExtractOutcome> {
  if (!job.wantHash && !job.wantText) return NONE;
  // Tree-sitter grammars load once per thread; without them the extractor keeps its line rules.
  if (job.wantText) await loadSyntax();
  try {
    const buf = await readFile(job.path);
    const t1 = performance.now();
    const hash = job.wantHash ? createHash('sha1').update(buf).digest('hex') : null;
    const t2 = performance.now();
    if (!job.wantText || isBinary(buf)) return { hash, res: null, bytes: buf.length, hashMs: t2 - t1, extractMs: 0 };
    const go = job.lang === 'go' ? await goModule(dirname(job.path), job.projectRoot) : null;
    const res = extract({ path: job.path, content: buf.toString('utf8'), ext: job.ext, cls: job.cls, lang: job.lang, projectRoot: job.projectRoot, goModule: go });
    return { hash, res, bytes: buf.length, hashMs: t2 - t1, extractMs: performance.now() - t2 };
  } catch {
    return NONE;
  }
}

const ROLE = 'vb-extract';

/** Worker count: `VB_EXTRACT_WORKERS` (0 or 1 = on the calling thread), otherwise one less than the cores, at most 4. */
export function extractWorkers(): number {
  const env = process.env.VB_EXTRACT_WORKERS;
  if (env !== undefined && env !== '') { const n = Number(env); return Number.isFinite(n) ? Math.max(0, Math.min(32, Math.floor(n))) : 0; }
  return Math.max(1, Math.min(4, availableParallelism() - 1));
}

interface Slot { worker: Worker; busy: boolean; alive: boolean }
interface Pending { jobs: ExtractJob[]; resolve: (r: ExtractOutcome[]) => void }

/**
 * Runs chunks of jobs on `size` workers. A worker that cannot start or dies gives its chunk back to the calling
 * thread, so a broken pool degrades to the inline extraction instead of failing the index.
 */
export class ExtractPool {
  private slots: Slot[] = [];
  private queue: Pending[] = [];
  private running = new Map<Worker, Pending>();

  constructor(size: number) {
    for (let i = 0; i < size; i++) {
      let worker: Worker;
      try { worker = new Worker(new URL(import.meta.url), { workerData: { role: ROLE } }); } catch { break; }
      const slot: Slot = { worker, busy: false, alive: true };
      worker.on('message', (out: ExtractOutcome[]) => {
        const p = this.running.get(worker);
        this.running.delete(worker);
        slot.busy = false;
        p?.resolve(out);
        this.pump();
      });
      const lost = () => {
        if (!slot.alive) return;
        slot.alive = false;
        const p = this.running.get(worker);
        this.running.delete(worker);
        if (p) this.inline(p);
        if (!this.slots.some((s) => s.alive)) for (const q of this.queue.splice(0)) this.inline(q);
      };
      worker.on('error', lost);
      worker.on('messageerror', () => { void worker.terminate(); });
      worker.on('exit', lost);
      this.slots.push(slot);
    }
  }

  run(jobs: ExtractJob[]): Promise<ExtractOutcome[]> {
    return new Promise((resolve) => {
      const p = { jobs, resolve };
      if (!this.slots.some((s) => s.alive)) this.inline(p);
      else { this.queue.push(p); this.pump(); }
    });
  }

  async close(): Promise<void> {
    const slots = this.slots.splice(0);
    for (const s of slots) s.alive = false;
    // work still queued or running is finished here, so no caller is left waiting
    const left = [...this.running.values(), ...this.queue.splice(0)];
    this.running.clear();
    for (const p of left) this.inline(p);
    await Promise.all(slots.map((s) => s.worker.terminate()));
  }

  private pump(): void {
    for (const slot of this.slots) {
      if (!slot.alive || slot.busy) continue;
      const p = this.queue.shift();
      if (!p) return;
      slot.busy = true;
      this.running.set(slot.worker, p);
      slot.worker.postMessage(p.jobs);
    }
  }

  private inline(p: Pending): void {
    void Promise.all(p.jobs.map(extractFile)).then(p.resolve);
  }
}

if (!isMainThread && parentPort && (workerData as { role?: string } | null)?.role === ROLE) {
  const port = parentPort;
  // the reads of a chunk overlap; the extraction itself is synchronous, so each worker uses one core
  port.on('message', (jobs: ExtractJob[]) => { void Promise.all(jobs.map(extractFile)).then((out) => port.postMessage(out)); });
}
