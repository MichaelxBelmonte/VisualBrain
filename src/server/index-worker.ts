// Worker thread entry: runs one index pass on its own SQLite connection so the server thread stays free
// for HTTP, WebSocket and terminal traffic. Messages out: progress, done, error.
import { parentPort, workerData } from 'node:worker_threads';
import { Db } from './db.ts';
import { runIndex } from './index.ts';
import type { Config } from './config.ts';

interface Job { dbFile: string; cfg: Config; opts: { subtrees?: string[]; reextract?: boolean } }

const port = parentPort;
if (!port) throw new Error('index-worker must run in a worker thread');
const { dbFile, cfg, opts } = workerData as Job;
const db = new Db(dbFile);
// the server thread writes notes and edges to the same file while an index runs: wait for each other instead of failing
db.exec('PRAGMA busy_timeout = 30000');
// (Db.tx takes the write lock up front, so a read-then-write transaction cannot hit SQLITE_BUSY_SNAPSHOT.)
port.postMessage({ type: 'ready' });
try {
  const summary = await runIndex(db, cfg, opts, (p) => port.postMessage({ type: 'progress', p }));
  port.postMessage({ type: 'done', summary });
} catch (err) {
  port.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
} finally {
  db.close();
}
