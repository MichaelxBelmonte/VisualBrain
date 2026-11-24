import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Row = Record<string, SQLInputValue>;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA cache_size = -65536;
-- Reads through a memory map instead of one read() per 4 KB page: loading the map of a Desktop index is 2-3x faster.
PRAGMA mmap_size = 4294967296;
-- After a checkpoint the write-ahead log is cut back to this size instead of staying as large as its biggest burst.
PRAGMA journal_size_limit = 67108864;

CREATE TABLE IF NOT EXISTS nodes (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  parent_id INTEGER,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  ext TEXT,
  cls TEXT NOT NULL DEFAULT 'other',
  lang TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  files INTEGER NOT NULL DEFAULT 0,
  depth INTEGER NOT NULL DEFAULT 0,
  mtime REAL NOT NULL DEFAULT 0,
  inode INTEGER,
  hash TEXT,
  lines INTEGER,
  complexity REAL NOT NULL DEFAULT 0,
  importance REAL NOT NULL DEFAULT 0,
  pagerank REAL NOT NULL DEFAULT 0,
  indeg INTEGER NOT NULL DEFAULT 0,
  outdeg INTEGER NOT NULL DEFAULT 0,
  project_id INTEGER,
  area_id INTEGER,
  aggregate INTEGER NOT NULL DEFAULT 0,
  link_target TEXT,
  summary TEXT,
  tags TEXT,
  terms TEXT,
  gen INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  extracted INTEGER NOT NULL DEFAULT 0,
  child_count INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS nodes_parent ON nodes(parent_id);
CREATE INDEX IF NOT EXISTS nodes_kind ON nodes(kind);
CREATE INDEX IF NOT EXISTS nodes_hash ON nodes(hash);
CREATE INDEX IF NOT EXISTS nodes_name ON nodes(name);
CREATE INDEX IF NOT EXISTS nodes_importance ON nodes(importance);
CREATE INDEX IF NOT EXISTS nodes_project ON nodes(project_id);
-- files still to read: a handful after the first pass, found without scanning the table
CREATE INDEX IF NOT EXISTS nodes_pending ON nodes(id) WHERE extracted = 0;

CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY,
  src INTEGER NOT NULL,
  dst INTEGER NOT NULL,
  kind TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 1,
  confidence REAL NOT NULL DEFAULT 1,
  evidence TEXT,
  origin TEXT NOT NULL DEFAULT 'scan',
  created_at INTEGER NOT NULL DEFAULT 0,
  gen INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  count INTEGER NOT NULL DEFAULT 1,
  UNIQUE(src, dst, kind, origin)
);
CREATE INDEX IF NOT EXISTS edges_src ON edges(src);
CREATE INDEX IF NOT EXISTS edges_kind ON edges(kind);
CREATE INDEX IF NOT EXISTS edges_dst ON edges(dst);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  node_id INTEGER NOT NULL UNIQUE,
  name TEXT NOT NULL,
  label TEXT,
  type TEXT NOT NULL,
  remote TEXT,
  technologies TEXT,
  description TEXT,
  area_id INTEGER,
  status TEXT
);

CREATE TABLE IF NOT EXISTS areas (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  origin TEXT NOT NULL DEFAULT 'llm',
  confidence REAL
);

CREATE TABLE IF NOT EXISTS refs (
  node_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  line INTEGER,
  snippet TEXT,
  relative_to TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS refs_node ON refs(node_id);

CREATE TABLE IF NOT EXISTS identifiers (
  token TEXT NOT NULL,
  node_id INTEGER NOT NULL,
  line INTEGER,
  PRIMARY KEY (token, node_id)
);
CREATE INDEX IF NOT EXISTS identifiers_node ON identifiers(node_id);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY,
  node_id INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'note',
  text TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'user',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_node ON notes(node_id);

CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  node_id INTEGER NOT NULL,
  node_path TEXT NOT NULL,
  node_name TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reminders_node ON reminders(node_id);

CREATE TABLE IF NOT EXISTS reminder_folders (
  id TEXT PRIMARY KEY,
  node_id INTEGER NOT NULL,
  node_path TEXT NOT NULL,
  name TEXT NOT NULL,
  x REAL NOT NULL DEFAULT 0,
  y REAL NOT NULL DEFAULT 0,
  is_inbox INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS reminder_inbox ON reminder_folders(node_id,node_path) WHERE is_inbox=1;
CREATE INDEX IF NOT EXISTS reminder_folders_node ON reminder_folders(node_id,node_path);
CREATE TABLE IF NOT EXISTS reminder_folder_links (
  id TEXT PRIMARY KEY,
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(src,dst)
);

CREATE TABLE IF NOT EXISTS llm_runs (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  consent TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  bytes_sent INTEGER NOT NULL DEFAULT 0,
  nodes_sent INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  error TEXT,
  summary TEXT,
  payload TEXT,
  result TEXT
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(name, path, tokenize = 'unicode61 tokenchars ''-_.''');
`;

/**
 * How long the row of a path that is gone waits before it is removed. A path that comes back in the meantime (a folder
 * moved away and back, a volume unmounted, access refused for a while) gets its old row, so its id stays the same.
 * Folders wait longer: boards, teams and sessions are kept outside the database under the id of their node, usually a folder.
 */
export const PRUNE_FILES_AFTER_MS = 7 * 86_400_000;
export const PRUNE_DIRS_AFTER_MS = 90 * 86_400_000;

export class Db {
  readonly raw: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec(SCHEMA);
    this.ensureColumn('projects', 'status', 'TEXT');
    this.ensureColumn('edges', 'count', 'INTEGER NOT NULL DEFAULT 1');
    this.ensureColumn('reminders', 'folder_id', 'TEXT');
    this.ensureColumn('nodes', 'deleted_at', 'INTEGER');
  }

  /** Adds a column to an existing database created before the column was introduced. */
  ensureColumn(table: string, column: string, decl: string): void {
    const cols = this.raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) this.raw.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  run(sql: string, ...params: SQLInputValue[]) {
    return this.raw.prepare(sql).run(...params);
  }

  get<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  /** Rows one at a time: for the tables a full pass reads whole, where `all` would hold every row object at once. */
  iterate<T = Row>(sql: string, ...params: SQLInputValue[]): IterableIterator<T> {
    return this.raw.prepare(sql).iterate(...params) as IterableIterator<T>;
  }

  prepare(sql: string) {
    return this.raw.prepare(sql);
  }

  /**
   * Runs `fn` inside one transaction; rolls back on throw. The write lock is taken up front (BEGIN IMMEDIATE): a deferred
   * transaction that reads first and writes later fails with SQLITE_BUSY_SNAPSHOT, which busy_timeout does not retry,
   * whenever another connection (the server thread, the index worker) commits in between.
   */
  tx<T>(fn: () => T): T {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (err) {
      try { this.raw.exec('ROLLBACK'); } catch { /* SQLite may already have rolled back: keep the original error */ }
      throw err;
    }
  }

  getMeta(key: string): string | null {
    const row = this.get<{ value: string | null }>('SELECT value FROM meta WHERE key = ?', key);
    return row ? row.value : null;
  }

  setMeta(key: string, value: string | number | null): void {
    this.run('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value === null ? null : String(value));
  }

  /** Rebuilds the full-text index from the nodes table. */
  rebuildFts(): void {
    // one transaction: a reader never sees the table emptied, and a failure leaves the previous index in place
    // Only the rows that differ are written: a pass that touched a few files no longer rewrites the whole search index.
    this.tx(() => {
      this.exec(`DELETE FROM nodes_fts WHERE rowid IN (
        SELECT rowid FROM (SELECT rowid, name, path FROM nodes_fts EXCEPT SELECT id, name, path FROM nodes WHERE deleted = 0))`);
      this.exec(`INSERT INTO nodes_fts(rowid, name, path)
        SELECT id, name, path FROM nodes WHERE deleted = 0 EXCEPT SELECT rowid, name, path FROM nodes_fts`);
    });
  }

  /**
   * Removes the rows of paths that have been gone long enough and that nothing refers to any more. A row stays, however
   * old, while a note, a reminder or a link that was not found by the scan (written by hand, by an agent, by the model,
   * from a seed) is attached to it: those are kept for the day the path comes back. Returns how many rows were removed.
   * Rows marked before `deleted_at` existed start waiting at the first call.
   * The candidates are listed once, then removed `chunk` at a time, each chunk in its own short transaction: other
   * connections can write in between and the write-ahead log never has to hold the whole clean-up.
   * `keep`: rows that stay whatever their age, because something outside this database is filed under their id (see
   * profile-nodes.ts).
   */
  pruneDeleted(now = Date.now(), filesAfterMs = PRUNE_FILES_AFTER_MS, dirsAfterMs = PRUNE_DIRS_AFTER_MS, chunk = 50_000, keep: readonly number[] = []): number {
    // `NOT attached` is checked when the candidates are listed and again when each chunk is removed: a row that got a
    // note, or whose path came back, between the two is left alone
    const free = `n.deleted = 1 AND n.kind IN ('file', 'dir', 'symlink')
      AND NOT EXISTS (SELECT 1 FROM notes x WHERE x.node_id = n.id)
      AND NOT EXISTS (SELECT 1 FROM reminders x WHERE x.node_id = n.id)
      AND NOT EXISTS (SELECT 1 FROM reminder_folders x WHERE x.node_id = n.id)
      AND NOT EXISTS (SELECT 1 FROM edges x INDEXED BY edges_src WHERE x.src = n.id AND x.origin <> 'scan')
      AND NOT EXISTS (SELECT 1 FROM edges x INDEXED BY edges_dst WHERE x.dst = n.id AND x.origin <> 'scan')`;
    this.run('UPDATE nodes SET deleted_at = ? WHERE deleted = 1 AND deleted_at IS NULL', now);
    this.exec('CREATE TEMP TABLE IF NOT EXISTS prune_ids (id INTEGER PRIMARY KEY)');
    this.exec('CREATE TEMP TABLE IF NOT EXISTS prune_now (id INTEGER PRIMARY KEY)');
    this.exec('DELETE FROM prune_ids');
    this.run(`INSERT INTO prune_ids SELECT n.id FROM nodes n
      WHERE ${free} AND n.deleted_at <= CASE n.kind WHEN 'dir' THEN ?2 ELSE ?1 END`, now - filesAfterMs, now - dirsAfterMs);
    if (keep.length) this.run('DELETE FROM prune_ids WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(keep));
    let removed = 0;
    for (;;) {
      const done = this.tx(() => {
        this.exec('DELETE FROM prune_now');
        const listed = Number(this.run('INSERT INTO prune_now SELECT id FROM prune_ids ORDER BY id LIMIT ?', chunk).changes);
        if (!listed) return -1;
        this.exec('DELETE FROM prune_ids WHERE id IN (SELECT id FROM prune_now)');
        this.exec(`DELETE FROM prune_now WHERE id NOT IN (SELECT n.id FROM nodes n WHERE n.id IN (SELECT id FROM prune_now) AND ${free})`);
        // what the scan already removed when it marked the row; repeated here so a pruned id never leaves anything behind
        this.exec('DELETE FROM edges WHERE src IN (SELECT id FROM prune_now) OR dst IN (SELECT id FROM prune_now)');
        this.exec('DELETE FROM refs WHERE node_id IN (SELECT id FROM prune_now)');
        this.exec('DELETE FROM identifiers WHERE node_id IN (SELECT id FROM prune_now)');
        this.exec('DELETE FROM nodes_fts WHERE rowid IN (SELECT id FROM prune_now)');
        return Number(this.run('DELETE FROM nodes WHERE id IN (SELECT id FROM prune_now)').changes);
      });
      if (done < 0) break;
      removed += done;
    }
    this.exec('DELETE FROM prune_now');
    return removed;
  }

  /** Pages of the file and how many of them are free: removed rows leave free pages that new rows reuse. */
  space(): { pageSize: number; pages: number; free: number } {
    const n = (pragma: string) => Number(Object.values(this.get<Row>(`PRAGMA ${pragma}`) ?? { v: 0 })[0]);
    return { pageSize: n('page_size'), pages: n('page_count'), free: n('freelist_count') };
  }

  /**
   * Rewrites the file without its free pages and empties the write-ahead log. It needs free disk space for a second
   * copy of the live data and holds the database for its whole duration: only for a moment when nothing else writes.
   */
  compact(): void {
    this.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    this.raw.exec('VACUUM');
    this.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  close(): void {
    this.raw.close();
  }
}
