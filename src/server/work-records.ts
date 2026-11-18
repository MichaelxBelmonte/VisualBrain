// Explicit, append-only project decisions and publication reports from the board's leaders.
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BRAIN_TEAM, boundedText, TeamError } from './team.ts';

interface RecordRequest {
  dataDir: string; nodeId: number; project: string; team: string; actor: string; author: string;
  canManage: boolean; shareWithBrain: boolean; method: string; body: Record<string, unknown>;
}

export function workRecords({ dataDir, nodeId, project, team, actor, author, canManage, shareWithBrain, method, body }: RecordRequest) {
  if (!canManage) throw new TeamError(403, 'Registro riservato alla persona e ai responsabili della bacheca');
  const dir = join(dataDir, 'teams');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'work-records.sqlite');
  closeSync(openSync(file, 'a', 0o600));
  const db = new DatabaseSync(file);
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS records (
      id INTEGER PRIMARY KEY, nodeId INTEGER NOT NULL, project TEXT NOT NULL, team TEXT NOT NULL,
      actor TEXT NOT NULL, author TEXT NOT NULL, createdAt INTEGER NOT NULL, entryId TEXT NOT NULL,
      kind TEXT NOT NULL, decision TEXT NOT NULL, nextOwner TEXT NOT NULL, taskId TEXT, sha TEXT, artifact TEXT, shareWithBrain INTEGER NOT NULL,
      UNIQUE(nodeId, project, team, actor, entryId)
    )`);
    const columns = 'id, entryId, createdAt, author, project, nodeId, team, kind, decision, nextOwner, taskId, sha, artifact';
    if (method === 'GET') {
      const before = body.before == null ? Number.MAX_SAFE_INTEGER : Number(body.before);
      if (!Number.isSafeInteger(before) || before < 1) throw new TeamError(400, 'Cursore del registro non valido');
      const rows = db.prepare(`SELECT ${columns} FROM records WHERE nodeId = ? AND project = ? AND id < ?
        AND (team = ? OR ? OR (? AND shareWithBrain)) ORDER BY id DESC LIMIT 51`)
        .all(nodeId, project, before, team, Number(actor === 'user'), Number(team === BRAIN_TEAM));
      const entries = rows.slice(0, 50);
      return { entries, nextBefore: rows.length > entries.length ? entries.at(-1)!.id : null };
    }
    const entryId = boundedText(body.entryId, 100, true);
    if (!/^[a-zA-Z0-9._-]+$/.test(entryId)) throw new TeamError(400, 'Identificativo della voce non valido');
    const kind = body.kind;
    if (kind !== 'decision' && kind !== 'publication') throw new TeamError(400, 'Tipo di voce non valido');
    const decision = boundedText(body.decision, 2000, true), nextOwner = boundedText(body.nextOwner, 120, true);
    const taskId = boundedText(body.taskId, 100) || null, sha = boundedText(body.sha, 64) || null;
    if (sha && !/^(?:[a-f\d]{7,40}|[a-f\d]{64})$/i.test(sha)) throw new TeamError(400, 'SHA non valido');
    const artifact = boundedText(body.artifact, 1000) || null;
    const fields = { kind, decision, nextOwner, taskId, sha, artifact };
    db.prepare(`INSERT INTO records (nodeId, project, team, actor, author, createdAt, entryId, kind, decision, nextOwner, taskId, sha, artifact, shareWithBrain)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(nodeId, project, team, actor, entryId) DO NOTHING`)
      .run(nodeId, project, team, actor, author, Date.now(), entryId, kind, decision, nextOwner, taskId, sha, artifact, Number(shareWithBrain));
    const entry = db.prepare(`SELECT ${columns} FROM records WHERE nodeId=? AND project=? AND team=? AND actor=? AND entryId=?`)
      .get(nodeId, project, team, actor, entryId)!;
    if (Object.entries(fields).some(([key, value]) => entry[key] !== value))
      throw new TeamError(409, 'Identificativo già utilizzato per una voce diversa');
    return entry;
  } finally { db.close(); }
}
