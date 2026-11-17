// Runs an index pass off the server thread. The CLI keeps calling runIndex inline; the server goes through here.
import { Worker } from 'node:worker_threads';
import type { Db } from './db.ts';
import type { Config } from './config.ts';
import { runIndex, type IndexSummary } from './index.ts';
import type { Progress } from './scan.ts';

export interface IndexOptions { subtrees?: string[]; reextract?: boolean }

/** Path of the main database file, or null for an in-memory/temporary database (which another connection cannot open). */
export function dbFileOf(db: Db): string | null {
  const rows = db.all<{ name: string; file: string }>('PRAGMA database_list');
  const file = rows.find((r) => r.name === 'main')?.file;
  return file || null;
}

/**
 * Index in a dedicated worker with its own connection to the same WAL database. Progress is forwarded as it arrives;
 * an error in the worker rejects (so the caller unblocks `indexing`). If the worker cannot start at all, or
 * `VB_INDEX_INLINE=1`, the pass runs inline on this thread as before.
 */
export function runIndexOffThread(db: Db, cfg: Config, opts: IndexOptions = {}, progress?: Progress): Promise<IndexSummary> {
  const file = dbFileOf(db);
  if (!file || process.env.VB_INDEX_INLINE === '1') return runIndex(db, cfg, opts, progress);
  return new Promise<IndexSummary>((resolve, reject) => {
    // `ready` is posted once the worker has loaded and opened the database. Before it, nothing can have been written,
    // so a failure is only a startup problem and the pass can safely run inline; after it, an error is the pass's own.
    let started = false;
    let settled = false;
    const worker = new Worker(new URL('./index-worker.ts', import.meta.url), { workerData: { dbFile: file, cfg, opts } });
    const finish = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
    worker.on('message', (m: { type: string; p?: Parameters<Progress>[0]; summary?: IndexSummary; message?: string }) => {
      if (m.type === 'ready') { started = true; return; }
      if (m.type === 'progress' && m.p) progress?.(m.p);
      else if (m.type === 'done' && m.summary) finish(() => resolve(m.summary!));
      else if (m.type === 'error') finish(() => reject(new Error(m.message ?? 'indicizzazione non riuscita')));
    });
    worker.on('error', (err) => {
      // never got going (the worker file could not be loaded or the database not opened): index inline instead of failing
      if (!started) finish(() => { console.error('[index] worker non avviabile, indicizzo nel processo principale:', err instanceof Error ? err.message : err); runIndex(db, cfg, opts, progress).then(resolve, reject); });
      else finish(() => reject(err instanceof Error ? err : new Error(String(err))));
    });
    worker.on('exit', (code) => {
      if (settled) return;
      if (!started) finish(() => { runIndex(db, cfg, opts, progress).then(resolve, reject); });
      else finish(() => reject(new Error(`worker di indicizzazione terminato (codice ${code})`)));
    });
  });
}
