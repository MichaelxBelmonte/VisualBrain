// Opt-in, at-least-once delivery. Only offsets are stored, never board contents or credentials.
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TeamMessage } from '../shared/types.ts';
import { TeamError } from './team.ts';

interface Consumer {
  dataDir: string; nodeId: number; team: string; session: string; consumer: unknown;
}
interface Cursor { acked: number; offered: number }

function transaction<T>(key: Consumer, operation: (db: DatabaseSync, ids: [number, string, string, string]) => T): T {
  if (typeof key.consumer !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(key.consumer)) {
    throw new TeamError(400, 'consumer: usa da 1 a 64 lettere, cifre, punti, trattini o trattini bassi');
  }
  const dir = join(key.dataDir, 'team-consumers');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dir, 'cursors.sqlite'));
  try {
    db.exec(`PRAGMA busy_timeout=2000;
      CREATE TABLE IF NOT EXISTS cursors (
        node INTEGER NOT NULL, team TEXT NOT NULL, session TEXT NOT NULL, consumer TEXT NOT NULL,
        acked INTEGER NOT NULL, offered INTEGER NOT NULL,
        PRIMARY KEY(node, team, session, consumer)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS notifiers (
        node INTEGER NOT NULL, team TEXT NOT NULL, session TEXT NOT NULL, consumer TEXT NOT NULL,
        PRIMARY KEY(node, team, session)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS reported_gaps (
        node INTEGER NOT NULL, team TEXT NOT NULL, session TEXT NOT NULL, consumer TEXT NOT NULL,
        through INTEGER NOT NULL, PRIMARY KEY(node,team,session,consumer)) WITHOUT ROWID;
      BEGIN IMMEDIATE`);
    const result = operation(db, [key.nodeId, key.team, key.session, key.consumer]);
    db.exec('COMMIT');
    return result;
  } finally { db.close(); } // Closing rolls back an incomplete transaction.
}

const scope = 'WHERE node=? AND team=? AND session=? AND consumer=?';

/** The first forward reader drives its session’s terminal notifications; observers never advance that cursor. */
export function notificationCursor(dataDir: string | undefined, nodeId: number, team: string, session: string, legacySeen: number): number {
  if (!dataDir) return legacySeen;
  const file = join(dataDir, 'team-consumers', 'cursors.sqlite');
  if (!existsSync(file)) return legacySeen;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=2000');
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='notifiers'").get()) return legacySeen;
    const row = db.prepare(`SELECT acked FROM notifiers JOIN cursors USING(node,team,session,consumer)
      WHERE node=? AND team=? AND session=?`).get(nodeId, team, session);
    return Math.max(legacySeen, Number(row?.acked ?? 0));
  } finally { db.close(); }
}

export function readConsumer(key: Consumer, log: TeamMessage[], initialSeen: number, after: string | null) {
  const replay = after !== null;
  if (after !== null && (!/^(0|[1-9]\d*)$/.test(after) || !Number.isSafeInteger(Number(after)))) {
    throw new TeamError(400, 'after deve essere un intero non negativo');
  }
  return transaction(key, (db, ids) => {
    db.prepare('INSERT OR IGNORE INTO cursors VALUES (?,?,?,?,?,?)').run(...ids, initialSeen, initialSeen);
    const cursor = db.prepare('SELECT acked,offered FROM cursors ' + scope).get(...ids) as unknown as Cursor;
    const from = replay ? Number(after) : cursor.acked;
    const oldest = log[0]?.id ?? null, latest = log.at(-1)?.id ?? 0;
    if (from > latest || cursor.offered > latest) throw new TeamError(409, 'Cursore oltre la fine della bacheca');
    if (!replay) db.prepare('INSERT OR IGNORE INTO notifiers VALUES (?,?,?,?)').run(...ids);

    // Freeze an outstanding forward page so a retry cannot silently include later arrivals.
    const ceiling = !replay && cursor.offered > cursor.acked ? cursor.offered : latest;
    const visible = log.filter(m => m.id > from && m.from !== key.session && (m.to === null || m.to === key.session));
    const gap = oldest !== null && from < oldest - 1 ? { from: from + 1, to: oldest - 1 } : null;
    const blocked = !replay && gap !== null;
    const page = blocked ? [] : visible.filter(m => m.id <= ceiling);
    const messages = page.slice(0, 50);
    // An empty read containing only other recipients' traffic must not freeze an empty page.
    const next = blocked ? gap.to : messages.at(-1)?.id ?? from;
    if (blocked) db.prepare('INSERT OR REPLACE INTO reported_gaps VALUES (?,?,?,?,?)').run(...ids, gap.to);
    if (!replay && next > cursor.offered) db.prepare('UPDATE cursors SET offered=? ' + scope).run(next, ...ids);
    return { messages, delivery: { consumer: key.consumer, ackedThrough: cursor.acked, after: from, next,
      hasMore: visible.some(m => m.id > next), oldestAvailable: oldest, gap, replay } };
  });
}

export function acknowledgeConsumer(key: Consumer, through: unknown, log: TeamMessage[], acceptGapThrough?: unknown) {
  if (typeof through !== 'number' || !Number.isSafeInteger(through) || through < 0) {
    throw new TeamError(400, 'through deve essere un intero non negativo');
  }
  if (acceptGapThrough !== undefined && acceptGapThrough !== through) throw new TeamError(400, 'acceptGapThrough deve coincidere con through');
  return transaction(key, (db, ids) => {
    const cursor = db.prepare('SELECT acked,offered FROM cursors ' + scope).get(...ids) as unknown as Cursor | undefined;
    if (!cursor || through > cursor.offered) throw new TeamError(409, 'Conferma solo un cursore già offerto a questo consumer');
    const drivesNotices = !!db.prepare('SELECT 1 FROM notifiers ' + scope).get(...ids);
    if (through <= cursor.acked) return { consumer: key.consumer, ackedThrough: cursor.acked, drivesNotices };
    const expiredThrough = (log[0]?.id ?? 1) - 1;
    if (expiredThrough > cursor.acked) {
      const gap = db.prepare('SELECT through FROM reported_gaps ' + scope).get(...ids);
      if (acceptGapThrough !== expiredThrough || gap?.through !== expiredThrough) {
        throw new TeamError(409, 'Messaggi scaduti: rileggi la lacuna e riconciliala esplicitamente prima di avanzare');
      }
      db.prepare('DELETE FROM reported_gaps ' + scope).run(...ids);
    } else if (acceptGapThrough !== undefined) throw new TeamError(409, 'Nessuna lacuna da riconciliare');
    db.prepare('UPDATE cursors SET acked=? ' + scope).run(through, ...ids);
    return { consumer: key.consumer, ackedThrough: through, drivesNotices };
  });
}
