import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Row = Record<string, SQLInputValue>;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA cache_size = -65536;

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
  child_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS nodes_parent ON nodes(parent_id);
CREATE INDEX IF NOT EXISTS nodes_kind ON nodes(kind);
CREATE INDEX IF NOT EXISTS nodes_hash ON nodes(hash);
CREATE INDEX IF NOT EXISTS nodes_name ON nodes(name);
CREATE INDEX IF NOT EXISTS nodes_importance ON nodes(importance);
CREATE INDEX IF NOT EXISTS nodes_project ON nodes(project_id);

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

export class Db {
  readonly raw: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec(SCHEMA);
    this.ensureColumn('projects', 'status', 'TEXT');
    this.ensureColumn('edges', 'count', 'INTEGER NOT NULL DEFAULT 1');
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

  prepare(sql: string) {
    return this.raw.prepare(sql);
  }

  /** Runs `fn` inside one transaction; rolls back on throw. */
  tx<T>(fn: () => T): T {
    this.raw.exec('BEGIN');
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (err) {
      this.raw.exec('ROLLBACK');
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
    this.exec('DELETE FROM nodes_fts');
    this.exec("INSERT INTO nodes_fts(rowid, name, path) SELECT id, name, path FROM nodes WHERE deleted = 0");
  }

  close(): void {
    this.raw.close();
  }
}
