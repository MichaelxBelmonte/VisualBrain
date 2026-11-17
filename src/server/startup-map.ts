// Last canvas view of this profile. SQLite remains authoritative; the copy is compared on every startup.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Stats } from '../shared/types.ts';

const VERSION = 1;
const MAX_BYTES = 8 * 1024 * 1024;
interface SavedView { query: string; json: string; id: string; stats: Stats }

const fingerprint = (source: string, query: string, json: string): string =>
  createHash('sha256').update(source).update('\0').update(query).update('\0').update(json).digest('hex');

/** Ordering of distinct URL parameters has no effect on the graph. Duplicate parameters keep their order. */
export function mapQuery(url: URL): string {
  const params = new URLSearchParams(url.search);
  params.sort();
  return params.toString();
}

export class StartupMap {
  private readonly file: string;
  private readonly source: string;
  private saved: SavedView | null = null;
  private initialQuery: string | undefined;

  constructor(dir: string, source: string) {
    this.file = join(dir, 'startup-map.json');
    this.source = source;
    try {
      if (statSync(this.file).size > MAX_BYTES) return;
      const record = JSON.parse(readFileSync(this.file, 'utf8'));
      if (record.version !== VERSION || record.source !== source || typeof record.query !== 'string' || typeof record.json !== 'string'
        || new URLSearchParams(record.query).get('detail') !== 'map' || record.id !== fingerprint(source, record.query, record.json)) return;
      const graph = JSON.parse(record.json);
      if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || !Array.isArray(graph.stats?.roots)) return;
      this.saved = { query: record.query, json: record.json, id: record.id, stats: graph.stats };
    } catch { /* missing, unreadable or incomplete: build directly from SQLite */ }
  }

  get current(): SavedView | null { return this.saved; }

  /** A temporary search or expansion must not evict the startup view. A new window may start with different filters. */
  select(query: string, firstInWindow: boolean): boolean {
    if (firstInWindow || this.initialQuery === undefined) this.initialQuery = query;
    return query === this.initialQuery;
  }

  save(query: string, json: string, stats: Stats): void {
    if (this.saved?.query === query && this.saved.json === json) return;
    // Large expanded views still work normally without making the next launch read an unbounded file.
    if (json.length > MAX_BYTES) return;
    const id = fingerprint(this.source, query, json);
    const record = JSON.stringify({ version: VERSION, source: this.source, query, id, json });
    if (Buffer.byteLength(record) > MAX_BYTES) return;
    const temp = this.file + '.' + randomUUID() + '.tmp';
    try {
      writeFileSync(temp, record, { mode: 0o600, flag: 'wx' });
      renameSync(temp, this.file);
      this.saved = { query, json, id, stats };
    } catch {
      try { rmSync(temp, { force: true }); } catch { /* optional cache */ }
    }
  }
}
