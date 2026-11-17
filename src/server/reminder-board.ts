import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Db } from './db.ts';
import type { ApiCtx } from './api.ts';
import type { ReminderFolder } from '../shared/types.ts';
import { apiWrite } from './api-write.ts';

const columns = 'id,node_id AS nodeId,node_path AS nodePath,name,x,y,is_inbox AS isInbox,created_at AS createdAt,updated_at AS updatedAt';
class BoardError extends Error { status: number; constructor(status: number, text: string) { super(text); this.status = status; } }
const fail = (status: number, text: string): never => { throw new BoardError(status, text); };
const folderName = (value: unknown) => typeof value === 'string' && value.trim() && value.trim().length <= 120 ? value.trim() : fail(400, 'Nome della cartella richiesto (massimo 120 caratteri)');
const coordinate = (value: unknown, fallback = 0) => value === undefined ? fallback : typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100000 ? Math.round(value) : fail(400, 'Posizione non valida');

/** Called inside apiWrite. Existing reminders keep their IDs, text, notes and timestamps. */
export function defaultReminderFolder(db: Db, nodeId: number, nodePath: string): string {
  let id = db.get<{ id: string }>('SELECT id FROM reminder_folders WHERE node_id=? AND node_path=? AND is_inbox=1', nodeId, nodePath)?.id;
  if (!id) {
    id = randomUUID(); const now = Date.now();
    db.run('INSERT INTO reminder_folders(id,node_id,node_path,name,x,y,is_inbox,created_at,updated_at) VALUES (?,?,?,?,0,0,1,?,?)', id, nodeId, nodePath, 'Promemoria', now, now);
  }
  db.run('UPDATE reminders SET folder_id=? WHERE node_id=? AND node_path=? AND folder_id IS NULL', id, nodeId, nodePath);
  return id;
}

/** Dedicated routes, independent of PTY hosts and team boards. */
export async function handleReminderBoard(ctx: Pick<ApiCtx, 'db' | 'terms'>, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url || '/', 'http://local');
  const route = /^\/api\/(reminder-board|reminder-folders|reminder-folder-links)(?:\/([a-z0-9-]+))?$/.exec(url.pathname);
  if (!route) return false;
  const send = (status: number, data: unknown) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
  try {
    const method = req.method || 'GET', kind = route[1], id = route[2];
    let b: Record<string, unknown> = {};
    if (method !== 'GET') {
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const raw of req) { const chunk = Buffer.from(raw); bytes += chunk.length; if (bytes > 256 * 1024) fail(413, 'Richiesta troppo grande'); chunks.push(chunk); }
      if (bytes) { try { b = JSON.parse(Buffer.concat(chunks).toString()); if (!b || typeof b !== 'object' || Array.isArray(b)) throw Error(); } catch { fail(400, 'JSON non valido'); } }
    }
    const actor = method === 'GET' ? url.searchParams.get('session') : b.from;
    const member = req.headers.authorization && typeof actor === 'string' ? ctx.terms?.get(actor) : undefined;
    if (req.headers.authorization && (!member || !member.info.alive || !member.info.role || !member.teamToken || member.info.nodeId == null || req.headers.authorization !== `Bearer ${member.teamToken}`)) fail(403, 'Sessione non autorizzata');
    const authorize = (nodeId: unknown, expectedPath?: string) => {
      if (typeof nodeId !== 'number' || !Number.isSafeInteger(nodeId) || nodeId <= 0) fail(400, 'Scegli un nodo');
      if (member && member.info.nodeId !== nodeId) fail(403, 'Puoi accedere solo alle cartelle del tuo nodo');
      let node = ctx.db.get<{ id: number; path: string }>(`SELECT id,path FROM nodes WHERE id=?${member ? ' AND deleted=0' : ''}`, nodeId as number);
      // The person can still edit saved lists after a file disappears; agents require a live indexed node.
      if (!node && !member) {
        const saved = ctx.db.get<{ path: string }>('SELECT node_path AS path FROM reminder_folders WHERE node_id=? ORDER BY updated_at DESC LIMIT 1', nodeId as number)
          ?? ctx.db.get<{ path: string }>('SELECT node_path AS path FROM reminders WHERE node_id=? ORDER BY updated_at DESC LIMIT 1', nodeId as number);
        if (saved) node = { id: nodeId as number, path: saved.path };
      }
      if (!node || (expectedPath && node.path !== expectedPath)) fail(404, 'Nodo non disponibile');
      return node!;
    };
    const getFolder = (key: string) => {
      const folder = ctx.db.get<ReminderFolder>(`SELECT ${columns} FROM reminder_folders WHERE id=?`, key);
      if (!folder) fail(404, 'Cartella non trovata');
      authorize(folder!.nodeId, folder!.nodePath); return folder!;
    };
    const board = (node: { id: number; path: string }) => ({
      folders: ctx.db.all(`SELECT ${columns} FROM reminder_folders WHERE node_id=? AND node_path=? ORDER BY created_at,id`, node.id, node.path),
      links: ctx.db.all('SELECT l.id,l.src,l.dst,l.created_at AS createdAt FROM reminder_folder_links l JOIN reminder_folders f ON f.id=l.src WHERE f.node_id=? AND f.node_path=? ORDER BY l.created_at,l.id', node.id, node.path),
    });
    if (kind === 'reminder-board' && !id && ['GET', 'POST'].includes(method)) {
      const node = authorize(method === 'GET' ? Number(url.searchParams.get('nodeId') || member?.info.nodeId) : b.nodeId ?? member?.info.nodeId);
      if (method === 'POST') await apiWrite(ctx.db, () => defaultReminderFolder(ctx.db, node.id, node.path));
      send(200, board(node)); return true;
    }
    if (kind === 'reminder-folders' && !id && method === 'POST') {
      const result = await apiWrite(ctx.db, () => {
        const node = authorize(b.nodeId ?? member?.info.nodeId);
        defaultReminderFolder(ctx.db, node.id, node.path);
        const count = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM reminder_folders WHERE node_id=? AND node_path=?', node.id, node.path)!.n;
        if (count >= 200) fail(409, 'Massimo 200 cartelle per nodo');
        const name = folderName(b.name), key = randomUUID(), now = Date.now();
        ctx.db.run('INSERT INTO reminder_folders(id,node_id,node_path,name,x,y,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', key, node.id, node.path, name, coordinate(b.x, 340 * (count % 3)), coordinate(b.y, 260 * Math.floor(count / 3)), now, now);
        return ctx.db.get(`SELECT ${columns} FROM reminder_folders WHERE id=?`, key);
      }); send(201, result); return true;
    }
    if (kind === 'reminder-folders' && id && method === 'PATCH') {
      const result = await apiWrite(ctx.db, () => {
        const old = getFolder(id);
        ctx.db.run('UPDATE reminder_folders SET name=?,x=?,y=?,updated_at=? WHERE id=?', b.name === undefined ? old.name : folderName(b.name), coordinate(b.x, old.x), coordinate(b.y, old.y), Date.now(), id);
        return ctx.db.get(`SELECT ${columns} FROM reminder_folders WHERE id=?`, id);
      }); send(200, result); return true;
    }
    if (kind === 'reminder-folders' && id && method === 'DELETE') {
      await apiWrite(ctx.db, () => {
        const old = getFolder(id); if (old.isInbox) fail(409, 'La cartella principale si può rinominare ma non eliminare');
        const inbox = defaultReminderFolder(ctx.db, old.nodeId, old.nodePath);
        ctx.db.run('UPDATE reminders SET folder_id=? WHERE folder_id=?', inbox, id);
        ctx.db.run('DELETE FROM reminder_folder_links WHERE src=? OR dst=?', id, id);
        ctx.db.run('DELETE FROM reminder_folders WHERE id=?', id);
      }); send(200, { ok: true }); return true;
    }
    if (kind === 'reminder-folder-links' && !id && method === 'POST') {
      const result = await apiWrite(ctx.db, () => {
        if (typeof b.src !== 'string' || typeof b.dst !== 'string' || b.src === b.dst) fail(400, 'Scegli due cartelle diverse');
        const a = getFolder(String(b.src)), z = getFolder(String(b.dst));
        if (a.nodeId !== z.nodeId || a.nodePath !== z.nodePath) fail(400, 'Le cartelle devono appartenere allo stesso nodo');
        const [src, dst] = [a.id, z.id].sort(), key = randomUUID(), now = Date.now();
        ctx.db.run('INSERT INTO reminder_folder_links(id,src,dst,created_at) VALUES (?,?,?,?) ON CONFLICT(src,dst) DO NOTHING', key, src, dst, now);
        return ctx.db.get('SELECT id,src,dst,created_at AS createdAt FROM reminder_folder_links WHERE src=? AND dst=?', src, dst);
      }); send(201, result); return true;
    }
    if (kind === 'reminder-folder-links' && id && method === 'DELETE') {
      await apiWrite(ctx.db, () => {
        const link = ctx.db.get<{ src: string }>('SELECT src FROM reminder_folder_links WHERE id=?', id); if (!link) fail(404, 'Collegamento non trovato');
        getFolder(link!.src); ctx.db.run('DELETE FROM reminder_folder_links WHERE id=?', id);
      }); send(200, { ok: true }); return true;
    }
    fail(405, 'Metodo non consentito');
  } catch (err) { send(err instanceof BoardError ? err.status : 500, { error: err instanceof Error ? err.message : String(err) }); }
  return true;
}
