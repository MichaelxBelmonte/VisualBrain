// The ids of nodes that a profile uses outside the index database.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * What a profile files under the id of a node, outside the database: the boards of its squads (`teams/<id>.json`,
 * `teams/<id>-<squad>.json`), the links between squads and the work records, the sessions that can be resumed, its
 * attachments, the worktrees and the memory of its squads, the work statistics. A row with one of these ids must not be
 * removed before its time: a path that comes back with a new id would find none of them.
 * Returns the reasons by id. Throws when something that is there cannot be read: better to remove nothing than too much.
 */
export function profileNodes(dir: string): Map<number, Set<string>> {
  const found = new Map<number, Set<string>>();
  const add = (id: unknown, why: string) => {
    const n = Number(id);
    if (!Number.isSafeInteger(n) || n <= 0) return;
    const reasons = found.get(n);
    if (reasons) reasons.add(why); else found.set(n, new Set([why]));
  };
  const names = (sub: string) => { const d = join(dir, sub); return existsSync(d) ? readdirSync(d) : []; };
  const json = (file: string): unknown => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null);
  /** The ids in some columns of a side database; a table that is not there yet has none. */
  const column = (file: string, table: string, name: string, why: string) => {
    if (!existsSync(file)) return;
    const side = new DatabaseSync(file, { readOnly: true });
    try {
      if (!side.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) return;
      for (const r of side.prepare(`SELECT DISTINCT ${name} AS id FROM ${table}`).all() as { id: unknown }[]) add(r.id, why);
    } finally { side.close(); }
  };
  for (const name of names('teams')) { const m = /^(\d+)(?:-[^.]+)?\.json$/.exec(name); if (m) add(m[1], 'bacheca'); }
  const links = json(join(dir, 'teams/links.json'));
  if (Array.isArray(links)) for (const l of links as { srcNodeId?: unknown; dstNodeId?: unknown }[]) { add(l?.srcNodeId, 'collegamento fra squadre'); add(l?.dstNodeId, 'collegamento fra squadre'); }
  column(join(dir, 'teams/work-records.sqlite'), 'records', 'nodeId', 'registro di lavoro');
  const sessions = json(join(dir, 'sessions.json')) as { sessions?: { info?: { nodeId?: unknown } }[] } | null;
  if (Array.isArray(sessions?.sessions)) for (const saved of sessions.sessions) add(saved?.info?.nodeId, 'sessione salvata');
  for (const name of names('attachments')) add(name, 'allegati');
  for (const name of names('worktrees')) add(name, 'copia di lavoro di una squadra');
  for (const name of names('memory')) { const m = /^node-(\d+)$/.exec(name); if (m) add(m[1], 'memoria di una squadra'); }
  for (const table of ['members', 'events', 'task_steps']) column(join(dir, 'work-stats.sqlite'), table, 'node', 'statistiche di lavoro');
  return found;
}
