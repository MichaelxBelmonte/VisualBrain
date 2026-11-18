// HTTP API. See docs/API.md.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from './db.ts';
import { explore } from './explore.ts';
import type { Updater } from './updater.ts';
import { openPrivacySettings, type BlockedFolder } from './access.ts';
import type { Config } from './config.ts';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, resolve, isAbsolute, join, sep } from 'node:path';
import { stat, realpath, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { GraphCache, CEdge } from './cache.ts';
import { rowToEdge } from './cache.ts';
import type { TerminalStore } from './terminals.ts';
import type { Area, GraphEdge, GraphNode, LaunchRequest, LlmRun, NodeDetail, Note, ProjectInfo, RepoChoice, StatusPayload, TeamBoard } from '../shared/types.ts';
import { forgetAgents, hasAgents, openWith } from './launch.ts';
import { cliAction, cliCatalog, forgetCliCatalog, isCli } from './agent-clis.ts';
import { harnessCatalog, launchHarness } from './harnesses.ts';
import { startHarnessInstall } from './harness-installer.ts';
import { BRAIN_TEAM, DEFAULT_TEAM, Teams, TeamError, boundedText, classify, isTeamId } from './team.ts';
import { modelCatalog } from './models.ts';
import { resumeSession, startSession, startSquad } from './sessions.ts';
import { removeWorktree } from './worktrees.ts';
import { gitCommit, gitFetch, gitOverview, gitTop, githubState } from './git.ts';
import { codeDiff, codeFile, codeSearch, codeTree, localCodeSearch, insideRepo, openInEditor } from './code.ts';
import { saveAttachment } from './attachments.ts';
import { markNoticeConfirmed, notifyTeam, setWorkState, wakeSession } from './team-delivery.ts';
import { acknowledgeConsumer, readConsumer } from './work-cursors.ts';
import { workRecords } from './work-records.ts';
import { normalizePath, getOrCreateExternal, lazyIndex, resolveExisting } from './graph.ts';
import { handleReminderBoard, defaultReminderFolder } from './reminder-board.ts';
import { apiWrite } from './api-write.ts';
import { setAttention, stripAnsi } from './activity.ts';
import { SEARCH_SQL, isSearchFilter, type SearchFilter } from '../shared/search-filter.ts';
import { connectGithub, githubRepositories } from './github-connect.ts';
import { gitEnv } from './git.ts';
import { mapQuery, type StartupMap } from './startup-map.ts';
import type { MegaStats } from './mega-stats.ts';
import type { QuotaRouter } from './quota-router.ts';

export interface ApiCtx {
  routing?: QuotaRouter;
  stats?: MegaStats;
  db: Db;
  startupMap?: StartupMap;
  cfg: Config;
  cache: GraphCache;
  terms: TerminalStore;
  teams: Teams;
  updater: Updater;
  /** Mapped folders macOS refuses to the app (or that no longer exist). */
  access: () => Promise<BlockedFolder[]>;
  state: { indexing: boolean; analyzing: boolean };
  configure: (settings: { roots: string[]; language: 'it' | 'en'; setupComplete: boolean }) => void;
  startIndex: (paths?: string[]) => boolean;
  startAnalyze: (consent: 'metadata' | 'excerpts') => Promise<number>;
  previewAnalyze: (consent: 'metadata' | 'excerpts') => { payload: string; bytes: number; nodes: number };
  changed: (reason: string) => void;
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const EDGE_KINDS = new Set(['imports', 'links', 'refpath', 'mention', 'symlink', 'duplicate', 'derived', 'shared_id', 'similar', 'semantic', 'manual', 'uses', 'policy', 'external']);

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  sendJsonText(res, status, JSON.stringify(body));
}

export function sendJsonText(res: ServerResponse, status: number, data: string): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(data);
}

// A reload or a second window commonly asks for the same map. A cache swap or edge edit
// replaces stats. Keep only the last canvas response and cap its retained size.
const lastCanvasResponse = new WeakMap<GraphCache['stats'], { query: string; json: string }>();

export function graphJson(cache: GraphCache, url: URL): string {
  const mapOnly = url.searchParams.get('detail') === 'map';
  const query = mapOnly ? mapQuery(url) : '';
  const previous = mapOnly ? lastCanvasResponse.get(cache.stats) : undefined;
  if (previous?.query === query) {
    return previous.json;
  }
  const expanded = (url.searchParams.get('expanded') ?? '').split(',').filter(Boolean).map(Number).filter((n) => Number.isFinite(n));
  const kindsParam = url.searchParams.get('kinds');
  const kinds = kindsParam ? new Set(kindsParam.split(',').filter(Boolean)) : null;
  const min = num(url.searchParams.get('min'), 0);
  const view = url.searchParams.get('view') === 'folders' ? 'folders' : 'projects';
  const flag = (name: string, def: boolean) => { const v = url.searchParams.get(name); return v === null ? def : v === '1' || v === 'true'; };
  const extra = (url.searchParams.get('extra') ?? '').split(',').filter(Boolean).map(Number).filter((n) => Number.isFinite(n));
  const g = cache.graph({ expanded, kinds, min, view, symlinks: flag('symlinks', view === 'folders'), externals: flag('externals', view === 'folders'), extra, mapOnly });
  const json = JSON.stringify({ ...g, areas: cache.areas, stats: cache.stats });
  if (mapOnly && json.length <= 1024 * 1024) {
    lastCanvasResponse.set(cache.stats, { query, json });
  }
  return json;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const c of req) {
    bytes += (c as Buffer).length;
    if (bytes > 256 * 1024) throw new HttpError(413, 'Richiesta troppo grande');
    chunks.push(c as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('object required');
    return body;
  } catch {
    throw new HttpError(400, 'JSON non valido');
  }
}

function num(v: string | null, def: number): number {
  if (v === null || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

export function projectInfo(ctx: ApiCtx, projectId: number | null | undefined): ProjectInfo | null {
  if (projectId === null || projectId === undefined) return null;
  const r = ctx.db.get<Record<string, unknown>>('SELECT id, node_id, name, label, type, remote, technologies, description, area_id, status FROM projects WHERE id = ?', projectId);
  if (!r) return null;
  return {
    id: Number(r.id), nodeId: Number(r.node_id), name: String(r.name), label: (r.label as string | null) ?? null, type: String(r.type), remote: (r.remote as string | null) ?? null,
    technologies: r.technologies ? (JSON.parse(String(r.technologies)) as string[]) : [], description: (r.description as string | null) ?? null, areaId: (r.area_id as number | null) ?? null,
  };
}

function notesOf(ctx: ApiCtx, id: number): Note[] {
  return ctx.db.all<Record<string, unknown>>('SELECT id, node_id, kind, text, origin, created_at FROM notes WHERE node_id = ? ORDER BY created_at DESC', id)
    .map((r) => ({ id: Number(r.id), nodeId: Number(r.node_id), kind: String(r.kind), text: String(r.text), origin: String(r.origin), createdAt: Number(r.created_at) }));
}

/** The repository with the sessions working on its branches (an operator's worktree branch, the branch a session sits on). */
async function gitRepoView(ctx: ApiCtx, top: string) {
  const overview = await gitOverview(top);
  const sessions = ctx.teams.withCodes(ctx.terms.list().filter(s => s.branch && s.agent !== 'shell'));
  const agents: Record<string, { id: string; code?: string; name?: string; alive: boolean }> = {};
  for (const s of sessions) agents[s.branch!] = { id: s.id, ...(s.code ? { code: s.code } : {}), ...(s.name ? { name: s.name } : {}), alive: s.alive };
  return { repo: overview, agents };
}

function requireNode(ctx: ApiCtx, id: number): GraphNode {
  const n = ctx.cache.nodes.get(id);
  if (!n) throw new HttpError(404, 'nodo non trovato');
  return n;
}

export function nodeDetail(ctx: ApiCtx, id: number): NodeDetail {
  const n = requireNode(ctx, id);
  const row = ctx.db.get<Record<string, unknown>>('SELECT link_target, hash, lines, complexity, pagerank FROM nodes WHERE id = ?', id) ?? {};
  const ownProject = ctx.db.get<{ id: number }>('SELECT id FROM projects WHERE node_id = ?', id);
  const project = projectInfo(ctx, ownProject ? ownProject.id : n.projectId);
  const area: Area | null = n.areaId ? (ctx.cache.areas.find((a) => a.id === n.areaId) ?? null) : null;
  const strongest = ctx.cache.incident(id)
    .sort((a, b) => Number(b.verified) - Number(a.verified) || b.confidence - a.confidence || b.count - a.count)
    .slice(0, 400);
  const evidence = ctx.cache.evidence(strongest.map((e) => e.id));
  const edges: GraphEdge[] = strongest.map((e) => ({ id: e.id, src: e.src, dst: e.dst, kind: e.kind as GraphEdge['kind'], verified: e.verified, confidence: e.confidence, count: e.count, evidence: evidence.get(e.id) ?? [], origin: e.origin, hidden: e.hidden }));
  const neighborIds = new Set<number>();
  for (const e of edges) neighborIds.add(e.src === id ? e.dst : e.src);
  const neighbors: GraphNode[] = [];
  for (const nid of neighborIds) { const x = ctx.cache.nodes.get(nid); if (x) neighbors.push(x); }
  const children = (ctx.cache.children.get(id) ?? []).slice(0, 60).map((c) => ctx.cache.nodes.get(c)!).filter(Boolean);
  const ancestors: number[] = [];
  let cur = n.parentId;
  while (cur !== null && cur !== undefined && ancestors.length < 64) { ancestors.push(cur); cur = ctx.cache.nodes.get(cur)?.parentId ?? null; }
  return {
    ...n, linkTarget: (row.link_target as string | null) ?? null, hash: (row.hash as string | null) ?? null, lines: (row.lines as number | null) ?? null,
    complexity: (row.complexity as number | null) ?? null, pagerank: (row.pagerank as number | null) ?? null, project, area, edges, neighbors, children, notes: notesOf(ctx, id), ancestors,
  };
}

function search(ctx: ApiCtx, q: string, limit: number, filter: SearchFilter = 'all'): GraphNode[] {
  const tokens = q.split(/\s+/).filter(Boolean).slice(0, 6);
  if (tokens.length === 0) return [];
  const ids = new Set<number>();
  try {
    const match = tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' AND ');
    for (const r of ctx.db.all<{ rowid: number }>(`SELECT nodes_fts.rowid FROM nodes_fts JOIN nodes n ON n.id=nodes_fts.rowid WHERE nodes_fts MATCH ? AND n.deleted=0 AND (${SEARCH_SQL[filter]}) LIMIT 400`, match)) ids.add(r.rowid);
  } catch {
    /* fall through to LIKE */
  }
  if (ids.size < limit) {
    for (const r of ctx.db.all<{ id: number }>(`SELECT n.id FROM nodes n WHERE n.deleted = 0 AND n.name LIKE ? AND (${SEARCH_SQL[filter]}) ORDER BY n.importance DESC LIMIT 200`, `%${tokens[0]}%`)) ids.add(r.id);
  }
  const lower = q.toLowerCase();
  return [...ids].map((i) => ctx.cache.nodes.get(i)).filter((n): n is GraphNode => Boolean(n))
    .sort((a, b) => Number(b.name.toLowerCase().startsWith(lower)) - Number(a.name.toLowerCase().startsWith(lower)) || b.importance - a.importance)
    .slice(0, limit);
}

function resolveNodeRef(ctx: ApiCtx, id: unknown, path: unknown, create: boolean, refresh = true): number {
  if (typeof id === 'number' && ctx.cache.nodes.has(id)) {
    const row = ctx.db.get<{ path: string }>('SELECT path FROM nodes WHERE id = ?', id);
    if (!row || row.path !== ctx.cache.nodes.get(id)!.path) throw new HttpError(409, 'nodo cambiato durante l’indicizzazione; aggiorna il grafo');
    return id;
  }
  if (typeof path === 'string' && path) {
    const idx = lazyIndex(ctx.db, ctx.cfg);
    const p = path.startsWith('/') || path.startsWith('~') ? normalizePath(path, idx.home) : path;
    const found = idx.byPath.get(p) ?? (p.startsWith('/') ? resolveExisting(idx, p)?.id : undefined);
    if (found !== undefined) return found;
    if (create) {
      const nid = getOrCreateExternal(ctx.db, idx, p);
      if (refresh) ctx.cache.load(ctx.db, ctx.cfg);
      return nid;
    }
  }
  throw new HttpError(404, 'nodo non trovato');
}

function edgeById(ctx: ApiCtx, id: number): CEdge {
  const r = ctx.db.get<Record<string, unknown>>('SELECT id, src, dst, kind, verified, confidence, origin, count, evidence, hidden FROM edges WHERE id = ?', id);
  if (!r) throw new HttpError(404, 'arco non trovato');
  return rowToEdge(r);
}

function edgePayload(ctx: ApiCtx, e: CEdge): GraphEdge {
  return { id: e.id, src: e.src, dst: e.dst, kind: e.kind as GraphEdge['kind'], verified: e.verified, confidence: e.confidence, count: e.count, evidence: ctx.cache.evidence([e.id]).get(e.id) ?? [], origin: e.origin, hidden: e.hidden };
}

function replaceEdgeInCache(ctx: ApiCtx, e: CEdge | null, id: number): void {
  ctx.cache.replaceEdge(id, e);
}

function status(ctx: ApiCtx, stats = ctx.cache.stats): StatusPayload {
  return {
    stats,
    config: { roots: ctx.cfg.roots, language: ctx.cfg.language, setupComplete: ctx.cfg.setupComplete, label: ctx.cfg.label?.slice(0, 60) || undefined, llm: { provider: ctx.cfg.llm.provider, model: ctx.cfg.llm.model, effort: ctx.cfg.llm.effort, consent: ctx.cfg.llm.consent }, agents: hasAgents(ctx.cfg) },
    indexing: ctx.state.indexing,
    analyzing: ctx.state.analyzing,
    terminals: ctx.teams.withCodes(ctx.terms.list()),
  };
}

function runs(ctx: ApiCtx): LlmRun[] {
  return ctx.db.all<Record<string, unknown>>('SELECT id, provider, model, consent, started_at, finished_at, bytes_sent, nodes_sent, status, error, summary FROM llm_runs ORDER BY id DESC LIMIT 50')
    .map((r) => ({ id: Number(r.id), provider: String(r.provider), model: String(r.model), consent: r.consent as LlmRun['consent'], startedAt: Number(r.started_at), finishedAt: (r.finished_at as number | null) ?? null,
      bytesSent: Number(r.bytes_sent), nodesSent: Number(r.nodes_sent), status: r.status as LlmRun['status'], error: (r.error as string | null) ?? null, summary: (r.summary as string | null) ?? null }));
}

export async function handleApi(ctx: ApiCtx, req: IncomingMessage, res: ServerResponse, preview?: NonNullable<StartupMap['current']>): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://local');
  const path = url.pathname;
  const method = req.method ?? 'GET';
  const send = async (response: ServerResponse, status: number, body: unknown): Promise<void> => {
    // A successful API reply is a durability boundary: tokens/cursors/state have reached the surviving PTY owner.
    if (status < 400 && /^\/api\/(work\/|launch|terminals)/.test(path)) {
      try { await ctx.terms.flush?.(); }
      catch { sendJson(response, 503, { error: 'Servizio terminali disconnesso; operazione non confermata.' }); return; }
    }
    sendJson(response, status, body);
  };
  try {
    if (path==='/api/mega-stats/routing' || path==='/api/mega-stats/routing/refresh') {
      if(req.headers.authorization || req.headers['sec-fetch-site']!=='same-origin')throw new HttpError(403,'Solo dalla pagina Stats');
      if(!ctx.routing)throw new HttpError(503,'Routing non disponibile');
      const node=url.searchParams.has('node')?Number(url.searchParams.get('node')):null,team=url.searchParams.get('team')??'1';
      if(!isTeamId(team))throw new HttpError(400,'Squadra non valida');
      if(node!==null){requireNode(ctx,node);if(team!=='brain'&&!ctx.teams.team(node,team))throw new HttpError(404,'Squadra non trovata');}
      if(path.endsWith('/refresh') && method==='POST'){
        try {await ctx.routing.refresh(ctx);} catch {throw new HttpError(503,'Il CLI non ha restituito una quota aggiornata');}
      } else if(method==='PUT' && node!==null && team!=='brain' && !path.endsWith('/refresh')) {
        ctx.routing.configure(node,team,await readJson(req)); ctx.routing.tick(ctx);ctx.stats?.signal();
      } else if(method!=='GET' || path.endsWith('/refresh')) throw new HttpError(405,'Metodo non consentito');
      return sendJson(res,200,ctx.routing.view(ctx,node,team));
    }
    if (path === '/api/mega-stats' || path === '/api/mega-stats/preferences') {
      if (req.headers.authorization || req.headers['sec-fetch-site'] !== 'same-origin') throw new HttpError(403, 'Solo dalla pagina Stats');
      if (!ctx.stats?.available) throw new HttpError(503, 'Telemetria non disponibile');
      if (path === '/api/mega-stats' && method === 'GET') {
        const hours = Number(url.searchParams.get('hours') ?? 24);
        if (![1,24,168].includes(hours)) throw new HttpError(400, 'Intervallo non valido');
        return send(res,200,ctx.stats.report(ctx,hours,{project:url.searchParams.get('project'),team:url.searchParams.get('team'),session:url.searchParams.get('session')}));
      }
      if (path.endsWith('/preferences') && method === 'PUT') {
        const b = await readJson(req);
        if (typeof b.nodeId !== 'number' || !Number.isSafeInteger(b.nodeId) || !isTeamId(b.teamId) ||
          typeof b.cadenceMinutes !== 'number' || !Number.isInteger(b.cadenceMinutes) || b.cadenceMinutes < 1 || b.cadenceMinutes > 1440 ||
          (b.mode !== 'suggest' && b.mode !== 'assign') || (b.provider !== 'balanced' && b.provider !== 'codex' && b.provider !== 'claude')) throw new HttpError(400, 'Preferenze non valide');
        try { return send(res,200,ctx.stats.setRequest(ctx,b.nodeId,b.teamId,{cadenceMinutes:b.cadenceMinutes,mode:b.mode,provider:b.provider})); }
        catch (err) { if (err instanceof RangeError) throw new HttpError(404,err.message); throw err; }
      }
      throw new HttpError(405, 'Metodo non consentito');
    }
    if (preview) {
      res.setHeader('x-vb-map-preview', preview.id);
      return sendJsonText(res, 200, path === '/api/status' ? JSON.stringify(status(ctx, preview.stats)) : preview.json);
    }
    if (await handleReminderBoard(ctx, req, res)) return;
    const reminderRoute = /^\/api\/reminders(?:\/([a-z0-9-]+))?$/.exec(path);
    if (reminderRoute) {
      // An authenticated agent can only read and update reminders owned by its live session's node.
      // UI requests keep working independently of sessions, teams and agent tokens.
      const body = method === 'GET' ? {} : await readJson(req);
      const actor = method === 'GET' ? url.searchParams.get('session') : body.from;
      const member = req.headers.authorization && typeof actor === 'string' ? ctx.terms?.get(actor) : undefined;
      if (req.headers.authorization && (!member || !member.info.alive || !member.info.role || !member.teamToken || member.info.nodeId == null || req.headers.authorization !== `Bearer ${member.teamToken}`)) throw new HttpError(403, 'Sessione non autorizzata');
      const agentNode = member ? ctx.db.get<{ id: number; path: string }>('SELECT id,path FROM nodes WHERE id=? AND deleted=0', member.info.nodeId!) : undefined;
      if (member && !agentNode) throw new HttpError(403, 'Nodo della sessione non disponibile');
      const id = reminderRoute[1];
      const columns = 'id, node_id AS nodeId, node_path AS nodePath, node_name AS nodeName, title, status, notes, folder_id AS folderId, created_at AS createdAt, updated_at AS updatedAt';
      if (!id && method === 'GET') return send(res, 200, agentNode
        ? ctx.db.all(`SELECT ${columns} FROM reminders WHERE node_id=? AND node_path=? ORDER BY (status = 'done'), updated_at DESC, id`, agentNode.id, agentNode.path)
        : ctx.db.all(`SELECT ${columns} FROM reminders ORDER BY (status = 'done'), updated_at DESC, id`));
      if ((!id && method === 'POST') || (id && method === 'PATCH')) {
        const b = body;
        const result = await apiWrite(ctx.db, () => {
          const old = id ? ctx.db.get<import('../shared/types.ts').NodeReminder>(`SELECT ${columns} FROM reminders WHERE id = ?`, id) : undefined;
          if (id && (!old || (agentNode && (old.nodeId !== agentNode.id || old.nodePath !== agentNode.path)))) throw new HttpError(404, 'Promemoria non trovato');
          const title = b.title === undefined ? old?.title : b.title;
          const notes = b.notes === undefined ? old?.notes ?? '' : b.notes;
          const status = b.status === undefined ? old?.status ?? 'pending' : b.status;
          if (typeof title !== 'string' || !title.trim() || title.length > 1000) throw new HttpError(400, 'Titolo richiesto (massimo 1000 caratteri)');
          if (typeof notes !== 'string' || notes.length > 10000) throw new HttpError(400, 'Appunti troppo lunghi');
          if (typeof status !== 'string' || !['pending', 'working', 'done'].includes(status)) throw new HttpError(400, 'Stato non valido');
          const nodeId = b.nodeId === undefined ? old?.nodeId ?? agentNode?.id : b.nodeId;
          if (agentNode && nodeId !== agentNode.id) throw new HttpError(403, 'Puoi aggiornare solo i promemoria del tuo nodo');
          if (typeof nodeId !== 'number' || !Number.isSafeInteger(nodeId) || nodeId <= 0) throw new HttpError(400, 'Scegli un nodo');
          const node = ctx.db.get<{ path: string; name: string }>('SELECT path, name FROM nodes WHERE id = ? AND deleted = 0', nodeId);
          // An archived/missing node must not prevent updating an existing reminder.
          const sameNode = old && nodeId === old.nodeId && (!node || node.path === old.nodePath);
          if (!sameNode && !node) throw new HttpError(404, 'Nodo non trovato');
          if (old && nodeId === old.nodeId && node && node.path !== old.nodePath) throw new HttpError(409, 'Nodo cambiato: scegli nuovamente il nodo');
          const now = Date.now(), key = id || randomUUID();
          const nodePath = sameNode ? old.nodePath : node!.path, nodeName = sameNode ? old.nodeName : node!.name;
          const folderId = b.folderId === undefined
            ? (sameNode ? old.folderId : null) ?? defaultReminderFolder(ctx.db, nodeId, nodePath)
            : b.folderId;
          if (typeof folderId !== 'string') throw new HttpError(400, 'Scegli una cartella');
          const folder = ctx.db.get<{ nodeId: number; nodePath: string }>('SELECT node_id AS nodeId,node_path AS nodePath FROM reminder_folders WHERE id=?', folderId);
          if (!folder || folder.nodeId !== nodeId || folder.nodePath !== nodePath) throw new HttpError(400, 'La cartella deve appartenere al nodo del promemoria');
          ctx.db.run(`INSERT INTO reminders(id,node_id,node_path,node_name,title,status,notes,folder_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET node_id=excluded.node_id,node_path=excluded.node_path,node_name=excluded.node_name,title=excluded.title,status=excluded.status,notes=excluded.notes,folder_id=excluded.folder_id,updated_at=excluded.updated_at`,
            key, nodeId, nodePath, nodeName, title.trim(), String(status), notes, folderId, old?.createdAt ?? now, now);
          return ctx.db.get(`SELECT ${columns} FROM reminders WHERE id = ?`, key);
        });
        return send(res, id ? 200 : 201, result);
      }
      throw new HttpError(405, 'Metodo non consentito');
    }
    if (path === '/api/health' && method === 'GET') return send(res, 200, { app: 'visual-brain', profile: ctx.cfg.dataDir, instance: process.env.VISUAL_BRAIN_INSTANCE || '', persistentTerminals: ctx.terms.persistent === true });
    if (path === '/api/update' && method === 'GET') return send(res, 200, ctx.updater.snapshot);
    if (path === '/api/access' && method === 'GET') return send(res, 200, { blocked: await ctx.access(), platform: process.platform });
    if (path === '/api/access/settings' && method === 'POST') {
      try { await openPrivacySettings(); } catch (error) { throw new HttpError(409, error instanceof Error ? error.message : String(error)); }
      return send(res, 200, { ok: true });
    }
    if (path === '/api/update/check' && method === 'POST') {
      try { await ctx.updater.check(); } catch (error) { throw new HttpError(502, error instanceof Error ? error.message : String(error)); }
      return send(res, 200, ctx.updater.snapshot);
    }
    if (path === '/api/update/install' && method === 'POST') {
      try { await ctx.updater.install(); } catch (error) { throw new HttpError(409, error instanceof Error ? error.message : String(error)); }
      return send(res, 200, ctx.updater.snapshot);
    }
    if (path === '/api/update/restart' && method === 'POST') {
      try { ctx.updater.restart(); } catch (error) { throw new HttpError(409, error instanceof Error ? error.message : String(error)); }
      res.once('finish', () => ctx.updater.quit()); // the page gets its answer before the server goes
      return send(res, 200, ctx.updater.snapshot);
    }
    if (path === '/api/preferences' && method === 'GET') return send(res, 200, { roots: ctx.cfg.roots, language: ctx.cfg.language, setupComplete: ctx.cfg.setupComplete, home: homedir(), desktopMode: ctx.cfg.desktopMode });
    if (path === '/api/folders' && method === 'GET') {
      const dir = url.searchParams.get('path') || homedir();
      if (!isAbsolute(dir)) throw new HttpError(400, 'Use an absolute folder path.');
      const entries = await readdir(dir, { withFileTypes: true });
      return send(res, 200, { path: dir, folders: entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name).sort((a, b) => a.localeCompare(b)) });
    }
    if (path === '/api/preferences' && method === 'PUT') {
      if (ctx.state.indexing || ctx.state.analyzing) throw new HttpError(409, 'Wait for the current scan or analysis to finish.');
      const body = await readJson(req);
      if (!['it', 'en'].includes(String(body.language)) || !Array.isArray(body.roots) || !body.roots.length || body.roots.length > 20) throw new HttpError(400, 'Choose a language and 1–20 folders.');
      const roots: string[] = [];
      for (const raw of body.roots) {
        if (typeof raw !== 'string' || !isAbsolute(raw)) throw new HttpError(400, 'Use absolute folder paths.');
        const dir = await realpath(resolve(raw));
        if (!(await stat(dir)).isDirectory()) throw new HttpError(400, 'Choose folders, not files.');
        await readdir(dir); // Detect denied access before saving or replacing the current index.
        if (!roots.includes(dir)) roots.push(dir);
      }
      const unique = roots.filter(p => !roots.some(parent => parent !== p && p.startsWith(parent.endsWith(sep) ? parent : parent + sep)));
      ctx.configure({ roots: unique, language: body.language as 'it' | 'en', setupComplete: true });
      ctx.startIndex();
      return send(res, 200, { saved: true });
    }
    if (path === '/api/status' && method === 'GET') return send(res, 200, status(ctx));

    if (path === '/api/graph' && method === 'GET') {
      const json = graphJson(ctx.cache, url);
      if (ctx.startupMap && url.searchParams.get('detail') === 'map') {
        const key = mapQuery(url);
        if (ctx.startupMap.select(key, req.headers['x-vb-startup-map'] === '1')) ctx.startupMap.save(key, json, ctx.cache.stats);
      }
      return sendJsonText(res, 200, json);
    }

    let m = /^\/api\/node\/(\d+)$/.exec(path);
    if (m && method === 'GET') return send(res, 200, nodeDetail(ctx, Number(m[1])));

    m = /^\/api\/node\/(\d+)\/children$/.exec(path);
    if (m && method === 'GET') {
      const id = Number(m[1]);
      const all = (ctx.cache.children.get(id) ?? []).map((c) => ctx.cache.nodes.get(c)!);
      const sort = url.searchParams.get('sort') ?? 'importance';
      const sorted = [...all].sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : sort === 'size' ? b.bytes - a.bytes : sort === 'mtime' ? b.mtime - a.mtime : b.importance - a.importance);
      const offset = num(url.searchParams.get('offset'), 0);
      const limit = Math.min(1000, num(url.searchParams.get('limit'), 200));
      return send(res, 200, { children: sorted.slice(offset, offset + limit), total: all.length });
    }

    if (path === '/api/search' && method === 'GET') {
      const filter = url.searchParams.get('filter') ?? 'all';
      if (!isSearchFilter(filter)) throw new HttpError(400, 'Filtro non valido');
      return send(res, 200, { results: search(ctx, url.searchParams.get('q') ?? '', Math.max(1, Math.min(100, num(url.searchParams.get('limit'), 30))), filter) });
    }

    if (path === '/api/path' && method === 'GET') {
      const p = url.searchParams.get('p') ?? '';
      const id = resolveNodeRef(ctx, undefined, p, false);
      return send(res, 200, ctx.cache.nodes.get(id));
    }

    if (path === '/api/explore' && method === 'GET') {
      const q = url.searchParams, node = q.get('node');
      const graph = { nodes: ctx.cache.nodes, children: ctx.cache.children, links: (id: number) => ctx.cache.incident(id), evidence: (ids: number[]) => ctx.cache.evidence(ids), find: (text: string, limit: number) => search(ctx, text, limit), notes: (id: number) => notesOf(ctx, id) };
      try {
        return send(res, 200, explore(graph, { from: node && /^\d+$/.test(node) ? Number(node) : undefined, target: q.get('target') || undefined, query: q.get('query') || undefined, to: q.get('to') || undefined, depth: Number(q.get('depth') ?? 1) }));
      } catch (error) { throw new HttpError(404, (error as Error).message); }
    }

    if (path === '/api/edges' && method === 'POST') {
      const b = await readJson(req);
      const kind = String(b.kind ?? 'manual');
      if (!EDGE_KINDS.has(kind)) throw new HttpError(400, `kind non ammesso: ${kind}`);
      const origin = String(b.origin ?? 'user').slice(0, 60);
      const verified = origin === 'user' ? (b.verified === false ? 0 : 1) : (b.verified === true ? 1 : 0);
      const confidence = typeof b.confidence === 'number' ? Math.max(0, Math.min(1, b.confidence)) : 1;
      const evidence = b.evidence && typeof b.evidence === 'object' ? b.evidence : { note: typeof b.evidence === 'string' ? b.evidence : 'aggiunto a mano' };
      const written = await apiWrite(ctx.db, () => {
        const src = resolveNodeRef(ctx, b.src, b.srcPath, true, false);
        const dst = resolveNodeRef(ctx, b.dst, b.dstPath, true, false);
        if (src === dst) throw new HttpError(400, 'un arco deve unire due nodi diversi');
        ctx.db.run(`INSERT INTO edges (src, dst, kind, verified, confidence, evidence, origin, created_at, gen, count)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1)
          ON CONFLICT(src, dst, kind, origin) DO UPDATE SET verified = excluded.verified, confidence = excluded.confidence, evidence = excluded.evidence, hidden = 0`,
          src, dst, kind, verified, confidence, JSON.stringify(evidence), origin, Date.now());
        // lastInsertRowid belongs to an earlier INSERT when this statement updated an existing edge.
        return {
          id: ctx.db.get<{ id: number }>('SELECT id FROM edges WHERE src = ? AND dst = ? AND kind = ? AND origin = ?', src, dst, kind, origin)!.id,
          refresh: !ctx.cache.nodes.has(src) || !ctx.cache.nodes.has(dst),
        };
      });
      const { id } = written;
      if (written.refresh) ctx.cache.load(ctx.db, ctx.cfg);
      const e = edgeById(ctx, id);
      replaceEdgeInCache(ctx, e, id);
      ctx.changed('edge');
      return send(res, 201, edgePayload(ctx, e));
    }

    m = /^\/api\/edges\/(\d+)$/.exec(path);
    if (m && method === 'PATCH') {
      const id = Number(m[1]);
      const b = await readJson(req);
      await apiWrite(ctx.db, () => {
        edgeById(ctx, id);
        if (typeof b.hidden === 'boolean') ctx.db.run('UPDATE edges SET hidden = ? WHERE id = ?', b.hidden ? 1 : 0, id);
        if (typeof b.confidence === 'number') ctx.db.run('UPDATE edges SET confidence = ? WHERE id = ?', Math.max(0, Math.min(1, b.confidence)), id);
        if (typeof b.kind === 'string' && EDGE_KINDS.has(b.kind)) ctx.db.run('UPDATE edges SET kind = ? WHERE id = ?', b.kind, id);
      });
      const e = edgeById(ctx, id);
      replaceEdgeInCache(ctx, e, id);
      ctx.changed('edge');
      return send(res, 200, edgePayload(ctx, e));
    }
    if (m && method === 'DELETE') {
      const id = Number(m[1]);
      const e = await apiWrite(ctx.db, () => {
        const current = edgeById(ctx, id);
        if (current.origin === 'scan' || current.origin.startsWith('import:') || current.origin === 'llm') {
          // computed edges would come back at the next index run: hide them instead
          ctx.db.run('UPDATE edges SET hidden = 1 WHERE id = ?', id);
          return edgeById(ctx, id);
        }
        ctx.db.run('DELETE FROM edges WHERE id = ?', id);
        return null;
      });
      replaceEdgeInCache(ctx, e, id);
      ctx.changed('edge');
      return send(res, 200, { ok: true });
    }

    m = /^\/api\/nodes\/(\d+)\/notes$/.exec(path);
    if (m && method === 'POST') {
      const id = Number(m[1]);
      if (!ctx.cache.nodes.has(id)) throw new HttpError(404, 'nodo non trovato');
      const expectedPath = ctx.cache.nodes.get(id)!.path;
      const b = await readJson(req);
      const text = String(b.text ?? '').trim();
      if (!text) throw new HttpError(400, 'testo vuoto');
      const r = await apiWrite(ctx.db, () => {
        const row = ctx.db.get<{ path: string }>('SELECT path FROM nodes WHERE id = ?', id);
        if (!row || row.path !== expectedPath) throw new HttpError(409, 'nodo cambiato durante l’indicizzazione; aggiorna il grafo');
        return ctx.db.run('INSERT INTO notes (node_id, kind, text, origin, created_at) VALUES (?, ?, ?, ?, ?)', id, String(b.kind ?? 'note'), text.slice(0, 4000), String(b.origin ?? 'user').slice(0, 60), Date.now());
      });
      const note = notesOf(ctx, id).find((n) => n.id === Number(r.lastInsertRowid));
      return send(res, 201, note);
    }
    m = /^\/api\/notes\/(\d+)$/.exec(path);
    if (m && method === 'DELETE') {
      const id = Number(m[1]);
      await apiWrite(ctx.db, () => ctx.db.run('DELETE FROM notes WHERE id = ?', id));
      return send(res, 200, { ok: true });
    }

    if (path === '/api/index' && method === 'POST') {
      const b = await readJson(req);
      const paths = Array.isArray(b.paths) ? (b.paths as unknown[]).filter((p): p is string => typeof p === 'string') : undefined;
      const started = ctx.startIndex(paths && paths.length ? paths : undefined);
      return send(res, started ? 202 : 409, { started });
    }

    if (path === '/api/analyze' && method === 'POST') {
      const b = await readJson(req);
      const consent: 'metadata' | 'excerpts' = b.consent === 'excerpts' ? 'excerpts' : 'metadata';
      if (b.dryRun) return send(res, 200, ctx.previewAnalyze(consent));
      if (ctx.state.indexing) throw new HttpError(409, 'indicizzazione in corso');
      if (ctx.state.analyzing) throw new HttpError(409, 'analisi già in corso');
      const runId = await ctx.startAnalyze(consent);
      return send(res, 202, { runId });
    }
    if (path === '/api/analyze/runs' && method === 'GET') return send(res, 200, runs(ctx));

    if (path === '/api/models' && method === 'GET') return send(res, 200, modelCatalog());

    if (path === '/api/team-links' && method === 'GET') return send(res, 200, ctx.teams.getLinks());
    if (path === '/api/team-links' && method === 'POST') {
      const b = await readJson(req);
      if (req.headers.authorization || (b.from && b.from !== 'user')) throw new HttpError(403, 'I canali si creano da Operativa');
      const srcNodeId = Number(b.srcNodeId), dstNodeId = Number(b.dstNodeId);
      requireNode(ctx, srcNodeId); requireNode(ctx, dstNodeId);
      const endpoint = (value: unknown, nodeId: number) => {
        if (value === null || value === undefined) return null;
        if (typeof value !== 'string') throw new HttpError(400, 'Sessione non valida');
        const session = ctx.terms.get(value)?.info;
        if (!session?.alive || !session.role || session.nodeId !== nodeId) throw new HttpError(400, 'Sessione non attiva su questo nodo');
        return value;
      };
      const srcSessionId = endpoint(b.srcSessionId, srcNodeId), dstSessionId = endpoint(b.dstSessionId, dstNodeId);
      if (srcNodeId === dstNodeId && srcSessionId === dstSessionId) throw new HttpError(400, 'Scegli due sessioni o nodi diversi');
      const link = ctx.teams.link({ srcNodeId, dstNodeId, srcSessionId, dstSessionId });
      ctx.stats?.signal();
      return send(res, 201, link);
    }
    m = /^\/api\/team-links\/([a-z0-9-]+)$/.exec(path);
    if (m && method === 'DELETE') {
      if (req.headers.authorization) throw new HttpError(403, 'I canali si rimuovono da Operativa');
      ctx.teams.unlink(m[1]); ctx.stats?.signal(); return send(res, 200, { ok: true });
    }

    m = /^\/api\/work\/(\d+)\/quota$/.exec(path);
    if(m && method==='POST'){
      const b=await readJson(req);
      const t=typeof b.from==='string'?ctx.terms.get(b.from):undefined;
      if(!t?.info.alive||!t.info.role||t.info.agent==='shell'||t.info.nodeId!==Number(m[1])||!t.teamToken||req.headers.authorization!=='Bearer '+t.teamToken)throw new HttpError(403,'Sessione non autorizzata');
      if(!ctx.routing)throw new HttpError(503,'Routing non disponibile');
      const team=ctx.teams.teamOf(t.info.nodeId,t.info);
      ctx.routing.report(t.info.nodeId,team,t.info.agent,b);ctx.stats?.bind(req,t.info.nodeId,team,t.info.id);
      ctx.routing.tick(ctx);ctx.stats?.signal();return sendJson(res,200,{ok:true});
    }
    m = /^\/api\/work\/(\d+)\/turn$/.exec(path);
    if (m && method === 'POST') {
      const b = await readJson(req);
      const t = typeof b.from === 'string' ? ctx.terms.get(b.from) : undefined;
      if (!t?.info.alive || !t.info.role || t.info.agent !== 'codex' || t.info.nodeId !== Number(m[1]) || !t.teamToken || req.headers.authorization !== 'Bearer '+t.teamToken)
        throw new HttpError(403,'Sessione non autorizzata');
      if (b.phase !== 'ready' && ((b.phase !== 'start' && b.phase !== 'stop' && b.phase !== 'interrupted') || typeof b.turnId !== 'string' || !/^[\w-]{1,100}$/.test(b.turnId)))
        throw new HttpError(400,'Evento turno non valido');
      ctx.stats?.bind(req,t.info.nodeId,ctx.teams.teamOf(t.info.nodeId,t.info),t.info.id);
      const phase = b.phase;
      ctx.stats?.capture(() => ctx.stats!.turn(t.info,phase,typeof b.turnId === 'string' ? b.turnId : undefined));
      return sendJson(res,200,{ok:true});
    }
    m = /^\/api\/work\/(\d+)(?:\/(messages|tasks|state|spawn|wake|inbox|forward|proposals|handoff|ack|records)(?:\/([a-z0-9-]+))?)?$/.exec(path);
    if (m) {
      const nodeId = Number(m[1]);
      const node = requireNode(ctx, nodeId);
      const action = m[2];
      const taskId = m[3];
      const b = method === 'GET' ? {} : await readJson(req);
      const actor = boundedText(method === 'GET' ? url.searchParams.get('session') ?? undefined : b.from, 80) || 'user';
      const member = actor === 'user' ? undefined : ctx.terms.get(actor);
      if ((actor !== 'user' || req.headers.authorization) && (!member || !member.info.alive || member.info.nodeId !== nodeId || !member.info.role || req.headers.authorization !== `Bearer ${member.teamToken}`)) throw new HttpError(403, 'Sessione non autorizzata per questo nodo');
      // The board: an agent's own squad (the Main Brain's own board for it); the person names one (default: the first squad).
      const requested = method === 'GET' ? url.searchParams.get('team') ?? undefined : b.team;
      if (requested !== undefined && !isTeamId(requested)) throw new HttpError(400, 'Squadra non valida');
      const team = member ? ctx.teams.teamOf(nodeId, member.info) : (requested as string | undefined) ?? DEFAULT_TEAM;
      ctx.stats?.bind(req,nodeId,team,member?.info.id ?? null);
      const isBrain = team === BRAIN_TEAM;
      if (!isBrain && !ctx.teams.team(nodeId, team)) throw new HttpError(404, 'Squadra non trovata');
      const all = ctx.teams.withCodes(ctx.terms.list().filter(s => s.nodeId === nodeId && s.agent !== 'shell'));
      const brain = all.find(s => s.alive && s.role === 'brain') ?? null;
      // A squad's board shows its members; the Main Brain's board its own session and the orchestrators it talks to.
      const sessions = isBrain ? all.filter(s => s.role === 'brain' || s.role === 'orchestrator') : all.filter(s => s.role && s.role !== 'brain' && ctx.teams.teamOf(nodeId, s) === team);
      const canManage = actor === 'user' || member?.info.role === (isBrain ? 'brain' : 'orchestrator');
      if (action === 'records' && !taskId && (method === 'GET' || method === 'POST')) return send(res, 200, workRecords({
        dataDir: ctx.cfg.dataDir, nodeId, project: node.path, team, actor, author: member?.info.code ?? ctx.teams.get(nodeId).codes?.ids[actor] ?? actor,
        canManage, shareWithBrain: ctx.teams.get(nodeId, BRAIN_TEAM).policy.delivery !== 'manual',
        method, body: method === 'GET' ? { before: url.searchParams.get('before') } : b,
      }));
      if (action === 'ack' && !taskId && method === 'POST') {
        if (!member) throw new HttpError(403, 'Conferma riservata alla sessione autenticata');
        const ack = acknowledgeConsumer({ dataDir: ctx.cfg.dataDir, nodeId, team, session: actor, consumer: b.consumer },
          b.through, ctx.teams.get(nodeId, team).messages, b.acceptGapThrough);
        if (ack.drivesNotices && b.through === ack.ackedThrough) markNoticeConfirmed(ctx, actor, ack.ackedThrough, b.acceptGapThrough !== undefined);
        return send(res, 200, ack);
      }
      const links = ctx.teams.getLinks().filter(l => l.srcNodeId === nodeId || l.dstNodeId === nodeId);
      // Sessions of other boards (another squad's Main Brain or orchestrator, linked nodes) this board may write to.
      const peers = ctx.teams.withCodes(ctx.terms.list().filter(s => s.alive && s.role && !sessions.some(own => own.id === s.id) && sessions.some(own => own.alive && ctx.teams.canTalk(own, s))));
      ctx.teams.recover(nodeId, all);
      const board = ctx.teams.get(nodeId, team);
      const english = ctx.cfg.language === 'en';
      // Agents may name a session by its id or by the code the user sees (OP3).
      const recipient = (id: unknown, pool = sessions): string | null => {
        if (id === null || id === undefined || id === '') return null;
        const session = typeof id === 'string' ? ctx.teams.resolve(nodeId, pool.filter(s => s.alive), id) : undefined;
        if (!session) throw new HttpError(400, 'Destinatario non attivo in questa squadra');
        return session.id;
      };
      const codeOf = (id: string) => all.find(s => s.id === id)?.code ?? id;
      const heldNote = english ? 'Held on the sorting board: the user decides whether to forward it. Do not repeat it.' : 'In smistamento: l’utente decide se inoltrarlo. Non ripeterlo.';
      const wake = (id: string) => wakeSession(ctx, id);
      const notify = () => notifyTeam(ctx, nodeId, team);
      const visible = ({ codes: _codes, members: _members, teams: _teams, nextTeam: _next, savedSquads: _saved, ...rest }: TeamBoard) => rest;
      if (!action && method === 'GET') {
        const consumer = url.searchParams.get('consumer'), after = url.searchParams.get('after');
        if (after !== null && consumer === null) throw new HttpError(400, 'Il replay richiede un consumer');
        if (consumer !== null && !member) throw new HttpError(403, 'Consumer riservato alla sessione autenticata');
        if (!member) return send(res, 200, { ...visible(board), savedSquads: ctx.teams.get(nodeId).savedSquads, messages: board.messages.slice(-50), sessions, peers, links, team: isBrain ? undefined : ctx.teams.team(nodeId, team), teamList: ctx.teams.summaries(nodeId, all), brain });
        const page = consumer === null ? null : readConsumer({ dataDir: ctx.cfg.dataDir, nodeId, team, session: actor, consumer }, board.messages, member.seenMessage, after);
        const messages = page?.messages ?? board.messages.filter(msg => msg.id > member.seenMessage && msg.from !== actor && (!msg.to || msg.to === actor)).slice(0, 50);
        if (!page && messages.length) member.seenMessage = messages.at(-1)!.id;
        const delivery = page ? { delivery: page.delivery } : {};
        const { inbox: _inbox, ...own } = visible(board);
        if (isBrain) return send(res, 200, { ...own, ...delivery, messages, sessions, peers, links,
          teamList: ctx.teams.summaries(nodeId, all, { id: actor, allHandoffs: url.searchParams.get('handoffs') === 'all' }).filter(t => !t.archived) });
        // With manual delivery a held result is not the orchestrator's yet: it sees the status, the person forwards the content.
        const held = english ? '(delivered, being sorted by the user)' : '(consegnato, in smistamento dall’utente)';
        const tasks = member.info.role === 'orchestrator' ? board.tasks.map(t => t.held ? { ...t, result: held } : t) : board.tasks.filter(t => t.assignedTo === actor || (t.assignedTo === null && t.status !== 'done'));
        return send(res, 200, { ...own, ...delivery, messages, tasks, sessions, peers, links, team: ctx.teams.team(nodeId, team), brain: member.info.role === 'orchestrator' ? brain : undefined });
      }
      if (!action && method === 'PATCH') {
        if (!canManage) throw new HttpError(403, 'Solo l’orchestratore aggiorna il riepilogo');
        const settings = ['autoSpawn', 'maxAgents', 'worktrees', 'delivery', 'memory', 'name', 'objective', 'archived'].some(k => b[k] !== undefined);
        if (actor !== 'user' && settings) throw new HttpError(403, 'Solo l’utente cambia i limiti della squadra');
        if (actor === 'user' && !isBrain && (b.name !== undefined || b.objective !== undefined || b.archived !== undefined)) {
          const patch: { name?: string; objective?: string; archived?: boolean } = {};
          if (b.name !== undefined) patch.name = boundedText(b.name, 40, true);
          if (b.objective !== undefined) patch.objective = boundedText(b.objective, 4000);
          if (b.archived !== undefined) {
            if (typeof b.archived !== 'boolean') throw new HttpError(400, 'archived non valido');
            if (b.archived && sessions.some(s => s.alive)) throw new HttpError(409, 'Chiudi prima le sessioni della squadra');
            patch.archived = b.archived;
          }
          const info = ctx.teams.setTeam(nodeId, team, patch);
          // An archived squad's worktree goes only when Git can remove it without losing anything; its branch stays.
          if (patch.archived && info.worktree && await removeWorktree(ctx.cfg.dataDir, info.worktree.path)) ctx.teams.setTeam(nodeId, team, { worktree: undefined });
        }
        ctx.teams.update(nodeId, b, team);
        if (actor === 'user' && !isBrain && ['autoSpawn', 'maxAgents', 'worktrees', 'delivery', 'memory'].some(k => b[k] !== undefined)) ctx.teams.saveSquad(nodeId, node.path, node.name, sessions, team);
        return send(res, 200, visible(ctx.teams.get(nodeId, team)));
      }
      if (action === 'state' && method === 'POST') {
        // Agents send {from, state}; Claude Code hooks add source "hook" and report prompts waiting for the person as attention.
        const hasState = b.state !== undefined, hasAttention = b.attention !== undefined;
        if (!member || (!hasState && !hasAttention) || (hasState && !['working', 'idle', 'blocked'].includes(String(b.state)))
          || (hasAttention && b.attention !== null && b.attention !== 'permission' && b.attention !== 'input')
          || (b.source !== undefined && b.source !== 'agent' && b.source !== 'hook')) throw new HttpError(400, 'Stato o sessione non validi');
        if (b.source === 'hook' && member.info.agent === 'claude' && (b.state === 'working' || b.state === 'idle'))
          ctx.stats?.capture(() => ctx.stats!.turn(member.info,b.state === 'working' ? 'start' : 'stop'));
        if (hasState) {
          setWorkState(member.info, b.state as 'working' | 'idle' | 'blocked', b.source === 'hook' ? 'hook' : 'agent');
          if (b.state !== 'blocked') setAttention(member.activity, member.info, null); // a turn started or ended: the prompt was answered
        }
        if (hasAttention) setAttention(member.activity, member.info, b.attention as 'permission' | 'input' | null);
        ctx.stats?.capture(() => ctx.stats!.snapshot(ctx));
        if (hasState) wake(actor);
        return send(res, 200, { state: member.info.workState, attention: member.info.attention ?? null });
      }
      if (action === 'messages' && method === 'POST') {
        const text = boundedText(b.text, 1200, true);
        // Another board: a linked node (addressed by id: codes are unique only inside a node), the Main Brain, another squad.
        const named = typeof b.to === 'string' && b.to ? ctx.terms.get(b.to)?.info ?? ctx.teams.resolve(nodeId, all.filter(s => s.alive && s.role), b.to) : undefined;
        const target = named?.nodeId != null && named.role ? { node: named.nodeId, team: ctx.teams.teamOf(named.nodeId, named) } : null;
        if (named && target && (target.node !== nodeId || target.team !== team)) {
          if (!named.alive || !(member ? ctx.teams.canTalk(member.info, named) : target.node === nodeId || sessions.some(s => s.alive && ctx.teams.canTalk(s, named)))) throw new HttpError(403, 'Collega prima le sessioni in Operativa');
          if (member?.info.role === 'orchestrator' && named.role === 'brain' && ctx.teams.get(nodeId, BRAIN_TEAM).policy.delivery === 'manual') {
            const item = ctx.teams.hold(nodeId, BRAIN_TEAM, { kind: classify(text), from: actor, text });
            return send(res, 201, { held: true, item: item.id, note: heldNote });
          }
          const message = ctx.teams.message(target.node, actor, named.id, text, target.team);
          ctx.teams.message(nodeId, actor, named.id, text, team);
          notifyTeam(ctx, target.node, target.team); return send(res, 201, message);
        }
        const to = recipient(b.to);
        // Manual delivery: what an operator says to its orchestrator (or to the whole squad) waits for the person.
        const worker = member?.info.role === 'operator' || member?.info.role === 'reviewer';
        if (worker && board.policy.delivery === 'manual' && (to === null || sessions.find(s => s.id === to)?.role === 'orchestrator')) {
          const item = ctx.teams.hold(nodeId, team, { kind: classify(text), from: actor, text });
          return send(res, 201, { held: true, item: item.id, note: heldNote });
        }
        const message = ctx.teams.message(nodeId, actor, to, text, team);
        notify(); return send(res, 201, message);
      }
      if (action === 'tasks' && !taskId && method === 'POST') {
        if (!canManage || isBrain) throw new HttpError(403, 'Solo l’orchestratore crea incarichi');
        const assignedTo = recipient(b.assignedTo);
        if(ctx.routing?.rule(nodeId,team).enabled) return send(res,201,ctx.routing.create(ctx,nodeId,team,actor,b,assignedTo));
        const task = ctx.teams.createTask(nodeId, actor, { title: b.title, scope: b.scope, assignedTo }, team);
        ctx.teams.message(nodeId, actor, assignedTo, `${english ? 'Task' : 'Incarico'} ${task.id}: ${task.title}`, team);
        notify(); return send(res, 201, task);
      }
      if(action==='handoff' && taskId && method==='POST') {
        if(isBrain || !ctx.routing?.rule(nodeId,team).enabled)throw new HttpError(409,'Routing non attivo per questa squadra');
        if(board.policy.delivery==='manual' && actor!=='user')throw new HttpError(409,'La persona deve confermare il checkpoint nella squadra a consegna manuale');
        return send(res,200,ctx.routing.handoff(ctx,nodeId,team,taskId,actor,b));
      }
      if (action === 'tasks' && taskId && method === 'PATCH') {
        if (isBrain) throw new HttpError(403, 'Il Main Brain non ha incarichi');
        const finishing = b.status === 'done' || b.status === 'blocked';
        const manual = finishing && board.policy.delivery === 'manual' && (member?.info.role === 'operator' || member?.info.role === 'reviewer');
        const before = board.tasks.find(t => t.id === taskId);
        const assignedTo = b.assignedTo === undefined ? undefined : recipient(b.assignedTo);
        if(before?.routing && (ctx.routing?.rule(nodeId,team).enabled || (before.routing.handoff && !before.routing.handoff.to))) {
          if(assignedTo!==undefined && assignedTo!==before.assignedTo)throw new HttpError(409,'Per cambiare proprietario consegna un checkpoint verificato');
          if(before.status!=='done' && !before.assignedTo && b.status==='working')throw new HttpError(409,'In attesa di un proprietario compatibile con la quota');
          if(before.routing.handoff && !before.routing.handoff.to && b.status && b.status!=='blocked')throw new HttpError(409,'Consegna in attesa di un successore');
        }
        const changed = !before || (b.status !== undefined && b.status !== before.status)
          || (b.result !== undefined && (typeof b.result !== 'string' || b.result.trim() !== before.result))
          || (assignedTo !== undefined && assignedTo !== before.assignedTo);
        // Always validate ownership and the transition, including repeat requests.
        const task = ctx.teams.changeTask(nodeId, taskId, actor, member?.info.role, { status: b.status, result: b.result, ...(assignedTo !== undefined ? { assignedTo } : {}), ...(manual && changed ? { held: true } : {}) }, team);
        if (b.status === 'working' && member && task.assignedTo === actor && (before?.status !== 'working' || before.assignedTo !== actor)) {
          setWorkState(member.info, 'working', 'agent');
        }
        if (task.status === 'done' && before?.status !== 'done')
          ctx.stats?.done(nodeId,team,task.assignedTo,task.id);
        if (!changed && task.assignedTo === before?.assignedTo) return send(res, 200, task);
        if (manual) ctx.teams.hold(nodeId, team, { kind: task.status === 'done' ? 'result' : 'blocked', from: actor, text: task.result || task.title, taskId: task.id, taskTitle: task.title });
        const target = sessions.find(s => s.alive && s.role === 'orchestrator' && s.id !== actor);
        const notified = new Set<string>();
        const inform = (id: string | null, text: string) => {
          if (!id || id === actor || notified.has(id) || !sessions.some(s => s.alive && s.id === id)) return;
          notified.add(id);
          ctx.teams.message(nodeId, actor, id, text, team);
          wake(id);
        };
        const ownerChanged = before && before.assignedTo !== task.assignedTo;
        const reopened = before?.status === 'done' && task.status !== 'done';
        const unblocked = before?.status === 'blocked' && (task.status === 'pending' || task.status === 'working');
        const label = (english ? 'Task ' : 'Incarico ') + task.id;
        if (ownerChanged && before.assignedTo) {
          const owner = task.assignedTo ? codeOf(task.assignedTo) : (english ? 'unassigned' : 'da assegnare');
          inform(before.assignedTo, `${label} → ${owner}. ${english ? 'Stop working on this task.' : 'Interrompi il lavoro su questo incarico.'}`);
        }
        if (ownerChanged || reopened || unblocked) {
          const change = reopened ? (english ? 'reopened' : 'riaperto') : unblocked ? (english ? 'unblocked' : 'sbloccato') : (english ? 'reassigned' : 'riassegnato');
          const message = `${label} · ${change} (${task.status}). ${english ? 'Check owner and latest result before continuing.' : 'Controlla assegnatario e ultimo esito prima di proseguire.'}`;
          inform(task.assignedTo, message);
          if (target && (reopened || unblocked || ownerChanged && before.assignedTo)) inform(target.id, message);
        }
        if (target && !notified.has(target.id) && (task.status === 'done' || task.status === 'blocked')) {
          const done = task.status === 'done';
          const word = done ? (english ? 'Done' : 'Completato') : (english ? 'Blocked' : 'Bloccato');
          const next = task.held ? (english ? 'held for the user to forward' : 'in smistamento dall’utente')
            : done ? (english ? 'review the result on the board' : 'verifica il risultato in bacheca')
            : (english ? 'check the blocker and decide who acts next' : 'verifica il blocco e decidi chi interviene');
          inform(target.id, `${word} ${task.id} · ${codeOf(task.assignedTo ?? actor)} · ${next}.`);
        }
        return send(res, 200, task);
      }
      if (action === 'spawn' && method === 'POST') {
        if (!member || member.info.role !== 'orchestrator' || !board.policy.autoSpawn) throw new HttpError(403, 'Avvio automatico non abilitato per questo orchestratore');
        if(ctx.routing && isCli(b.agent) && !ctx.routing.permitsProvider(nodeId,team,b.agent))throw new HttpError(409,'Il routing della squadra sospende nuovi incarichi per questo provider');
        if (!['operator', 'reviewer'].includes(String(b.role))) throw new HttpError(400, 'Un delegato deve essere operatore o revisore');
        boundedText(b.task, 1000, true);
        const launched = await startSession(ctx, nodeDetail(ctx, nodeId), { ...b, id: nodeId, mode: 'embedded', parentId: actor, teamId: team } as unknown as LaunchRequest);
        return send(res, 201, launched);
      }
      if (action === 'wake' && method === 'POST') {
        if (actor !== 'user' || req.headers.authorization) throw new HttpError(403, 'Risveglio manuale riservato all’utente');
        const id = recipient(b.to, all);
        if (!id || !wakeSession(ctx, id, { manual: true })) throw new HttpError(409, 'La sessione deve essere in attesa e avere nuovi messaggi');
        return send(res, 200, { ok: true });
      }
      if (action === 'inbox' && taskId && method === 'PATCH') {
        if (actor !== 'user' || req.headers.authorization) throw new HttpError(403, 'Lo smistamento è riservato all’utente');
        return send(res, 200, ctx.teams.changeInbox(nodeId, team, Number(taskId), b));
      }
      if (action === 'forward' && !taskId && method === 'POST') {
        if (actor !== 'user' || req.headers.authorization) throw new HttpError(403, 'Lo smistamento è riservato all’utente');
        // Default recipient: the squad's orchestrator (the Main Brain for its own board); any live squad session of the node otherwise.
        const to = b.to ? all.find(s => s.alive && s.role && (s.id === b.to || s.code?.toUpperCase() === String(b.to).toUpperCase())) : isBrain ? brain : sessions.find(s => s.alive && s.role === 'orchestrator');
        if (!to) throw new HttpError(409, isBrain ? 'Nessun Main Brain attivo nel nodo' : 'Nessun orchestratore attivo nella squadra: avvialo o scegli un altro destinatario');
        const toTeam = ctx.teams.teamOf(nodeId, to);
        const { text, items } = ctx.teams.forward(nodeId, team, b.items, to.id, b.note, codeOf, english ? 'en' : 'it', toTeam === team && to.role === 'orchestrator');
        const message = ctx.teams.message(nodeId, 'user', to.id, text, toTeam, 4200);
        notifyTeam(ctx, nodeId, toTeam);
        return send(res, 201, { message, items });
      }
      if (action === 'proposals' && !taskId && method === 'POST') {
        if (member?.info.role !== 'brain') throw new HttpError(403, 'Solo il Main Brain propone nuove squadre');
        return send(res, 201, ctx.teams.propose(nodeId, actor, b));
      }
      if (action === 'proposals' && taskId && method === 'PATCH') {
        if (actor !== 'user' || req.headers.authorization) throw new HttpError(403, 'Le proposte si gestiscono dall’interfaccia');
        if (b.status !== 'discarded') throw new HttpError(400, 'Le proposte si avviano dalla finestra di avvio');
        const proposal = ctx.teams.settleProposal(nodeId, taskId, 'discarded');
        if (brain) {
          ctx.teams.message(nodeId, 'visual-brain', brain.id, english ? `The user discarded your proposal "${proposal.name}".` : `L’utente ha scartato la tua proposta «${proposal.name}».`, BRAIN_TEAM);
          wake(brain.id);
        }
        return send(res, 200, proposal);
      }
      throw new HttpError(404, 'Azione squadra sconosciuta');
    }

    if (path === '/api/harnesses' && method === 'GET') return send(res, 200, harnessCatalog(ctx.cfg));
    if (path === '/api/harnesses/install' && method === 'POST') {
      if (req.headers.authorization) throw new HttpError(403, 'Installa gli harness dal pannello del nodo');
      const body = await readJson(req);
      return send(res, 202, startHarnessInstall(ctx.cfg, body.harness));
    }
    if (path === '/api/agents' && method === 'GET') {
      if (req.headers.authorization) throw new HttpError(403, 'Solo dall’interfaccia');
      const clis = await cliCatalog(ctx.cfg, url.searchParams.get('fresh') === '1');
      const sessions: Record<string, number> = {};
      for (const s of ctx.terms.list()) if (s.alive && s.agent !== 'shell') sessions[s.agent] = (sessions[s.agent] ?? 0) + 1;
      return send(res, 200, { clis, sessions });
    }
    m = /^\/api\/agents\/([a-z]+)\/(install|update|login|logout)$/.exec(path);
    if (m && method === 'POST') {
      // Only the person at the app: an agent never installs or signs in other agents.
      if (req.headers.authorization) throw new HttpError(403, 'Installa e collega gli agenti da Impostazioni → Agenti');
      if (!isCli(m[1])) throw new HttpError(404, 'CLI sconosciuta');
      let action: ReturnType<typeof cliAction>;
      try { action = cliAction(ctx.cfg, m[1], m[2] as 'install' | 'update' | 'login' | 'logout'); } catch (error) { throw new HttpError(400, error instanceof Error ? error.message : String(error)); }
      forgetCliCatalog(); forgetAgents();
      const term = await ctx.terms.spawn({ agent: 'shell', cwd: homedir(), nodeId: null, title: action.title, file: action.file, args: action.args });
      term.info.name = action.title;
      await ctx.terms.flush?.();
      return send(res, 201, { info: term.info });
    }
    if (path === '/api/github/login' && method === 'POST') {
      if (req.headers.authorization) throw new HttpError(403, 'Solo dall’interfaccia');
      const term = await ctx.terms.spawn({ agent: 'shell', cwd: homedir(), nodeId: null, title: 'GitHub · login', file: '/usr/bin/env', args: ['gh', 'auth', 'login', '--hostname', 'github.com', '--web', '--git-protocol', 'https'], env: { PATH: gitEnv().PATH!, GH_PROMPT_DISABLED: '' } });
      await ctx.terms.flush?.();
      return send(res, 201, { info: term.info });
    }
    if (path === '/api/github/logout' && method === 'POST') {
      if (req.headers.authorization) throw new HttpError(403, 'Solo dall’interfaccia');
      const term = await ctx.terms.spawn({ agent: 'shell', cwd: homedir(), nodeId: null, title: 'GitHub · uscita', file: '/usr/bin/env', args: ['gh', 'auth', 'logout', '--hostname', 'github.com'], env: { PATH: gitEnv().PATH! } });
      await ctx.terms.flush?.();
      return send(res, 201, { info: term.info });
    }
    if (path === '/api/launch-harness' && method === 'POST') {
      if (req.headers.authorization) throw new HttpError(403, 'Avvia gli harness dal pannello del nodo');
      const body = await readJson(req);
      const detail = nodeDetail(ctx, Number(body.id));
      const projectPath = detail.project ? ctx.cache.nodes.get(detail.project.nodeId)?.path ?? null : null;
      return send(res, 201, await launchHarness(ctx.terms, ctx.cfg, detail, projectPath, body));
    }

    if (path === '/api/attachments' && method === 'POST') {
      if (req.headers.authorization) throw new HttpError(403, 'Allega i file dalla finestra di avvio');
      const name = req.headers['x-file-name'];
      if (typeof name !== 'string' || !name) throw new HttpError(400, 'Nome del file mancante');
      const node = requireNode(ctx, Number(url.searchParams.get('node')));
      return send(res, 201, await saveAttachment(ctx.cfg.dataDir, node.id, name, req));
    }

    if (path === '/api/launch-squad' && method === 'POST') {
      if (req.headers.authorization) throw new HttpError(403, 'Avvia la squadra dalla vista Operativa');
      const b = await readJson(req);
      const detail = nodeDetail(ctx, Number(b.id));
      ctx.stats?.bind(req, detail.id, null, null);
      const squad = await startSquad(ctx, detail, b as unknown as import('../shared/types.ts').SquadRequest);
      ctx.stats?.bind(req, detail.id, squad.teamId, null);
      ctx.stats?.capture(() => ctx.stats!.snapshot(ctx));
      return send(res, 201, squad);
    }

    if (path === '/api/launch' && method === 'POST') {
      const b = (await readJson(req)) as unknown as LaunchRequest & { cols?: number; rows?: number };
      // A plain terminal may belong to no node: it opens in the home folder.
      const free = b.agent === 'shell' && (b.id === undefined || b.id === null);
      if (free && req.headers.authorization) throw new HttpError(403, 'I terminali si aprono dall’interfaccia');
      const detail = free ? null : nodeDetail(ctx, Number(b.id));
      if (detail) ctx.stats?.bind(req,detail.id,null,null);
      const result = await startSession(ctx, detail, b);
      if (detail && result.info) ctx.stats?.bind(req,detail.id,result.info.teamId ?? null,result.info.id);
      ctx.stats?.capture(() => ctx.stats!.snapshot(ctx));
      return send(res, result.info ? 201 : 200, result);
    }

    if (path === '/api/open' && method === 'POST') {
      const b = await readJson(req);
      const n = ctx.cache.nodes.get(Number(b.id));
      if (!n) throw new HttpError(404, 'nodo non trovato');
      if (n.kind === 'external' && !n.path.startsWith('/')) throw new HttpError(400, 'non è un percorso');
      openWith(n.path, b.app === 'finder' ? 'finder' : b.app === 'editor' ? 'editor' : 'default');
      return send(res, 200, { ok: true });
    }

    if (path === '/api/github/repos' && method === 'GET') {
      if (req.headers.authorization) throw new HttpError(403, 'Solo dall’interfaccia');
      const page = Math.max(1, Math.min(1000, Math.floor(num(url.searchParams.get('page'), 1))));
      return send(res, 200, await githubRepositories(page));
    }
    m = /^\/api\/github\/(\d+)\/(login|connect)$/.exec(path);
    if (m && method === 'POST') {
      if (req.headers.authorization) throw new HttpError(403, 'Solo dall’interfaccia');
      const n = ctx.cache.nodes.get(Number(m[1]));
      if (!n || !['dir', 'file'].includes(n.kind)) throw new HttpError(404, 'Cartella non trovata');
      const folder = n.kind === 'dir' ? n.path : dirname(n.path);
      if (m[2] === 'login') {
        const term = await ctx.terms.spawn({ agent: 'shell', cwd: folder, nodeId: n.id, title: 'GitHub · login', file: '/usr/bin/env', args: ['gh', 'auth', 'login', '--hostname', 'github.com', '--web', '--git-protocol', 'https'], env: { PATH: gitEnv().PATH!, GH_PROMPT_DISABLED: '' } });
        await ctx.terms.flush?.();
        return send(res, 201, { info: term.info });
      }
      const b = await readJson(req);
      if (typeof b.repository !== 'string' || (b.push !== undefined && typeof b.push !== 'boolean')) throw new HttpError(400, 'Repository non valido');
      const result = await connectGithub(folder, b.repository, b.push === true);
      ctx.changed('github');
      return send(res, 200, result);
    }

    if (path === '/api/repos' && method === 'GET') {
      // the indexed projects that are Git checkouts (a worktree's .git is a file): what the Dev tab can connect to
      const repos: RepoChoice[] = [];
      for (const p of ctx.cache.projects.values()) if (!p.container && p.path && existsSync(p.path)) repos.push({ nodeId: p.nodeId, name: p.label || p.name, path: p.path });
      return send(res, 200, repos.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path)));
    }

    m = /^\/api\/git\/(\d+)\/code\/(tree|file|diff|search|open)$/.exec(path);
    if (m) {
      const n = ctx.cache.nodes.get(Number(m[1]));
      if (!n || (n.kind !== 'dir' && n.kind !== 'file')) throw new HttpError(404, 'nodo non trovato');
      const folder = n.kind === 'dir' ? n.path : dirname(n.path);
      const repo = await gitTop(folder), top = repo ?? folder;
      const rel = url.searchParams.get('path') ?? '';
      const fail = (e: unknown, status = 400): never => { throw new HttpError(status, String((e as { stderr?: string }).stderr || (e as Error).message || e).trim().split('\n')[0].slice(0, 300)); };
      if (m[2] === 'tree' && method === 'GET') return send(res, 200, await codeTree(top, !!repo).catch((e) => fail(e, 500)));
      if (m[2] === 'file' && method === 'GET') return send(res, 200, await codeFile(top, rel, ctx.cfg.secretPatterns, url.searchParams.get('reveal') === '1').catch((e) => fail(e, /ENOENT/.test(String(e)) ? 404 : 400)));
      if (m[2] === 'diff' && method === 'GET') return send(res, 200, repo ? await codeDiff(top, rel).catch((e) => fail(e)) : { diff: '', truncated: false });
      if (m[2] === 'search' && method === 'GET') return send(res, 200, await (repo ? codeSearch(top, url.searchParams.get('q') ?? '') : localCodeSearch(top, url.searchParams.get('q') ?? '', ctx.cfg.secretPatterns)).catch((e) => fail(e, 500)));
      if (m[2] === 'open' && method === 'POST') {
        if (req.headers.authorization) throw new HttpError(403, 'Solo dall’interfaccia');
        const b = await readJson(req);
        const full = await insideRepo(top, String(b.path ?? '')).catch((e) => fail(e));
        const line = Number(b.line);
        return send(res, 200, { editor: openInEditor(full, Number.isInteger(line) && line > 0 ? line : undefined) });
      }
      throw new HttpError(405, 'metodo non consentito');
    }

    m = /^\/api\/git\/(\d+)(?:\/(fetch|github|open|commit\/([0-9a-f]{7,64})))?$/.exec(path);
    if (m) {
      const n = ctx.cache.nodes.get(Number(m[1]));
      if (!n || (n.kind !== 'dir' && n.kind !== 'file')) throw new HttpError(404, 'nodo non trovato');
      const top = await gitTop(n.kind === 'dir' ? n.path : dirname(n.path));
      const action = m[2]?.startsWith('commit/') ? 'commit' : m[2];
      if (!top) return send(res, 200, { repo: null });
      if (method === 'POST' && req.headers.authorization) throw new HttpError(403, 'Solo dall’interfaccia');
      if (!action && method === 'GET') return send(res, 200, await gitRepoView(ctx, top));
      if (action === 'fetch' && method === 'POST') {
        try { await gitFetch(top); } catch (error) { throw new HttpError(502, `git fetch non riuscito: ${String((error as { stderr?: string }).stderr || (error as Error).message).trim().split('\n').pop()!.slice(0, 300)}`); }
        return send(res, 200, await gitRepoView(ctx, top));
      }
      if (action === 'commit' && method === 'GET') {
        const detail = await gitCommit(top, m[3]).catch(() => { throw new HttpError(404, 'Commit non trovato'); });
        // Files still in the map can be opened there.
        const ids = new Map(detail.files.length ? ctx.db.all<{ id: number; path: string }>(`SELECT id, path FROM nodes WHERE deleted = 0 AND path IN (${detail.files.map(() => '?').join(',')})`, ...detail.files.map(f => f.path)).map(r => [r.path, r.id]) : []);
        return send(res, 200, { ...detail, files: detail.files.map(f => ({ ...f, ...(ids.has(f.path) ? { nodeId: ids.get(f.path) } : {}) })) });
      }
      const overview = await gitOverview(top);
      if (action === 'github' && method === 'GET') {
        if (!overview.github) return send(res, 200, { state: 'error', message: 'Nessun remote GitHub' });
        return send(res, 200, await githubState(overview.github, url.searchParams.get('fresh') === '1'));
      }
      if (action === 'open' && method === 'POST') {
        const b = await readJson(req);
        const target = typeof b.url === 'string' ? b.url : '';
        // Only pages of this repository on GitHub, never an address chosen elsewhere.
        if (!overview.github || !(target === overview.github.web || target.startsWith(overview.github.web + '/')) || /[\s"'<>]/.test(target)) throw new HttpError(400, 'Indirizzo non consentito');
        openWith(target, 'default');
        return send(res, 200, { ok: true });
      }
      throw new HttpError(405, 'metodo non consentito');
    }
    if (path === '/api/terminals' && method === 'GET') return send(res, 200, ctx.teams.withCodes(ctx.terms.list()));
    m = /^\/api\/terminals\/([a-z0-9-]+)\/preview$/.exec(path);
    if (m && method === 'GET') {
      if (req.headers.authorization || req.headers['sec-fetch-site'] !== 'same-origin') throw new HttpError(403, 'Anteprima disponibile dalla vista Operativa');
      const term = ctx.terms.get(m[1]);
      if (!term) throw new HttpError(404, 'Sessione non trovata');
      // Read the retained output without attaching to or resizing an unseen PTY.
      const lines = stripAnsi(term.buffer.join('')).trimEnd().split('\n').slice(-6);
      return sendJson(res, 200, { text: lines.map(line => line.slice(-240)).join('\n') });
    }
    m = /^\/api\/terminals\/([a-z0-9-]+)\/resume$/.exec(path);
    if (m && method === 'POST') {
      if (req.headers.authorization) throw new HttpError(403, 'Le sessioni si riprendono dall’interfaccia');
      const b = await readJson(req);
      return send(res, 200, await resumeSession(ctx, m[1], b));
    }
    m = /^\/api\/terminals\/([a-z0-9-]+)$/.exec(path);
    if (m && method === 'PATCH') {
      if (req.headers.authorization) throw new HttpError(403, 'Le sessioni si rinominano dall’interfaccia');
      const b = await readJson(req);
      if (typeof b.name !== 'string') throw new HttpError(400, 'Nome non valido');
      const info = ctx.terms.rename(m[1], b.name);
      if (!info) throw new HttpError(404, 'Sessione non trovata');
      const node = info.role && info.role !== 'brain' && info.nodeId != null ? ctx.cache.nodes.get(info.nodeId) : null;
      if (node) ctx.teams.saveSquad(node.id, node.path, node.name, ctx.terms.list(), ctx.teams.teamOf(node.id, info));
      return send(res, 200, info);
    }
    if (m && method === 'DELETE') {
      const nodeId = ctx.terms.get(m[1])?.info.nodeId;
      const cwd = ctx.terms.get(m[1])?.info.cwd;
      if (nodeId != null) ctx.teams.release(nodeId, m[1]);
      ctx.terms.kill(m[1]);
      // A closed operator's worktree goes away only when Git can remove it without losing anything; its branch stays.
      // A squad's own worktree stays while the squad exists: its other sessions work there.
      if (cwd && !(nodeId != null && ctx.teams.isTeamWorktree(nodeId, cwd))) void removeWorktree(ctx.cfg.dataDir, cwd);
      return send(res, 200, { ok: true });
    }

    throw new HttpError(404, 'percorso sconosciuto');
  } catch (err) {
    const status = err instanceof HttpError || err instanceof TeamError ? err.status : 500;
    send(res, status, { error: err instanceof Error ? err.message : String(err) });
  }
}
