// Acquire the SQLite writer lock without blocking the HTTP / terminal event loop.
import { setTimeout as delay } from 'node:timers/promises';
import type { Db } from './db.ts';

function locked(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = Number((error as { errcode?: unknown }).errcode) & 0xff;
  return code === 5 || code === 6; // SQLITE_BUSY / SQLITE_LOCKED, including extended codes
}

/**
 * Only lock acquisition is retried. The synchronous callback runs exactly once inside a transaction;
 * validation failures roll back, and no asynchronous work can keep a transaction open on this connection.
 */
export async function apiWrite<T>(db: Db, write: () => T, timeoutMs = 30_000): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const previousTimeout = Number(db.get<{ timeout: number }>('PRAGMA busy_timeout')?.timeout ?? 0);
    let acquired = false;
    let retryError: unknown;
    db.exec('PRAGMA busy_timeout = 0');
    try {
      db.exec('BEGIN IMMEDIATE');
      acquired = true;
      const result = write();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      if (acquired) {
        try { db.exec('ROLLBACK'); } catch { /* SQLite may already have rolled back: preserve the original error. */ }
        throw error;
      }
      if (!locked(error)) throw error;
      retryError = error;
    } finally {
      db.exec(`PRAGMA busy_timeout = ${previousTimeout}`);
    }
    if (performance.now() >= deadline) throw retryError;
    await delay(Math.min(20, Math.max(1, deadline - performance.now())));
  }
}
