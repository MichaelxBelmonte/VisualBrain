// HTTP API. See docs/API.md.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from './db.ts';
import type { Config } from './config.ts';
import { homedir } from 'node:os';
import { resolve, isAbsolute, sep } from 'node:path';
import { stat, realpath, readdir } from 'node:fs/promises';
import type { GraphCache, CEdge } from './cache.ts';
import { rowToEdge } from './cache.ts';
import type { Terminals } from './terminals.ts';
import type { Area, GraphEdge, GraphNode, LaunchRequest, LlmRun, NodeDetail, Note, ProjectInfo, StatusPayload } from '../shared/types.ts';
import { hasAgents, openWith } from './launch.ts';
import { Teams, TeamError, boundedText } from './team.ts';
import { modelCatalog } from './models.ts';
import { startSession, startSquad } from './sessions.ts';
import { notifyTeam, wakeSession } from './team-delivery.ts';
import { normalizePath, getOrCreateExternal, loadIndex, resolveExisting } from './graph.ts';

export interface ApiCtx {
  db: Db;
  cfg: Config;
  cache: GraphCache;
  terms: Terminals;
  teams: Teams;
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

function send(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(data);
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

export function nodeDetail(ctx: ApiCtx, id: number): NodeDetail {
  const n = ctx.cache.nodes.get(id);
  if (!n) throw new HttpError(404, 'nodo non trovato');
  const row = ctx.db.get<Record<string, unknown>>('SELECT link_target, hash, lines, complexity, pagerank FROM nodes WHERE id = ?', id) ?? {};
  const ownProject = ctx.db.get<{ id: number }>('SELECT id FROM projects WHERE node_id = ?', id);
  const project = projectInfo(ctx, ownProject ? ownProject.id : n.projectId);
  const area: Area | null = n.areaId ? (ctx.cache.areas.find((a) => a.id === n.areaId) ?? null) : null;
  const edges: GraphEdge[] = ctx.cache.edges
    .filter((e) => e.src === id || e.dst === id)
    .sort((a, b) => Number(b.verified) - Number(a.verified) || b.confidence - a.confidence || b.count - a.count)
    .slice(0, 400)
    .map((e) => ({ id: e.id, src: e.src, dst: e.dst, kind: e.kind as GraphEdge['kind'], verified: e.verified, confidence: e.confidence, count: e.count, evidence: e.evidence, origin: e.origin, hidden: e.hidden }));
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

function search(ctx: ApiCtx, q: string, limit: number): GraphNode[] {
  const tokens = q.split(/\s+/).filter(Boolean).slice(0, 6);
  if (tokens.length === 0) return [];
  const ids = new Set<number>();
  try {
    const match = tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' AND ');
    for (const r of ctx.db.all<{ rowid: number }>('SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH ? LIMIT 400', match)) ids.add(r.rowid);
  } catch {
    /* fall through to LIKE */
  }
  if (ids.size < limit) {
    for (const r of ctx.db.all<{ id: number }>('SELECT id FROM nodes WHERE deleted = 0 AND name LIKE ? ORDER BY importance DESC LIMIT 200', `%${tokens[0]}%`)) ids.add(r.id);
  }
  const lower = q.toLowerCase();
  return [...ids].map((i) => ctx.cache.nodes.get(i)).filter((n): n is GraphNode => Boolean(n))
    .sort((a, b) => Number(b.name.toLowerCase().startsWith(lower)) - Number(a.name.toLowerCase().startsWith(lower)) || b.importance - a.importance)
    .slice(0, limit);
}

function resolveNodeRef(ctx: ApiCtx, id: unknown, path: unknown, create: boolean): number {
  if (typeof id === 'number' && ctx.cache.nodes.has(id)) return id;
  if (typeof path === 'string' && path) {
    const idx = loadIndex(ctx.db, ctx.cfg);
    const p = path.startsWith('/') || path.startsWith('~') ? normalizePath(path, idx.home) : path;
    const found = idx.byPath.get(p) ?? (p.startsWith('/') ? resolveExisting(idx, p)?.id : undefined);
    if (found !== undefined) return found;
    if (create) {
      const nid = getOrCreateExternal(ctx.db, idx, p);
      ctx.cache.load(ctx.db, ctx.cfg);
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

function edgePayload(e: CEdge): GraphEdge {
  return { id: e.id, src: e.src, dst: e.dst, kind: e.kind as GraphEdge['kind'], verified: e.verified, confidence: e.confidence, count: e.count, evidence: e.evidence, origin: e.origin, hidden: e.hidden };
}

function replaceEdgeInCache(ctx: ApiCtx, e: CEdge | null, id: number): void {
  const i = ctx.cache.edges.findIndex((x) => x.id === id);
  if (e === null) { if (i >= 0) ctx.cache.edges.splice(i, 1); }
  else if (i >= 0) ctx.cache.edges[i] = e;
  else ctx.cache.edges.push(e);
  ctx.cache.stats.edges = ctx.cache.edges.filter((x) => !x.hidden).length;
}

function status(ctx: ApiCtx): StatusPayload {
  return {
    stats: ctx.cache.stats,
    config: { roots: ctx.cfg.roots, language: ctx.cfg.language, setupComplete: ctx.cfg.setupComplete, llm: { provider: ctx.cfg.llm.provider, model: ctx.cfg.llm.model, effort: ctx.cfg.llm.effort, consent: ctx.cfg.llm.consent }, agents: hasAgents(ctx.cfg) },
    indexing: ctx.state.indexing,
    analyzing: ctx.state.analyzing,
    terminals: ctx.terms.list(),
  };
}

function runs(ctx: ApiCtx): LlmRun[] {
  return ctx.db.all<Record<string, unknown>>('SELECT id, provider, model, consent, started_at, finished_at, bytes_sent, nodes_sent, status, error, summary FROM llm_runs ORDER BY id DESC LIMIT 50')
    .map((r) => ({ id: Number(r.id), provider: String(r.provider), model: String(r.model), consent: r.consent as LlmRun['consent'], startedAt: Number(r.started_at), finishedAt: (r.finished_at as number | null) ?? null,
      bytesSent: Number(r.bytes_sent), nodesSent: Number(r.nodes_sent), status: r.status as LlmRun['status'], error: (r.error as string | null) ?? null, summary: (r.summary as string | null) ?? null }));
}

export async function handleApi(ctx: ApiCtx, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://local');
  const path = url.pathname;
  const method = req.method ?? 'GET';
  try {
    if (path === '/api/health' && method === 'GET') return send(res, 200, { app: 'visual-brain', profile: ctx.cfg.dataDir, instance: process.env.VISUAL_BRAIN_INSTANCE || '' });
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
      const expanded = (url.searchParams.get('expanded') ?? '').split(',').filter(Boolean).map(Number).filter((n) => Number.isFinite(n));
      const kindsParam = url.searchParams.get('kinds');
      const kinds = kindsParam ? new Set(kindsParam.split(',').filter(Boolean)) : null;
      const min = num(url.searchParams.get('min'), 0);
      const view = url.searchParams.get('view') === 'folders' ? 'folders' : 'projects';
      const flag = (name: string, def: boolean) => { const v = url.searchParams.get(name); return v === null ? def : v === '1' || v === 'true'; };
      const extra = (url.searchParams.get('extra') ?? '').split(',').filter(Boolean).map(Number).filter((n) => Number.isFinite(n));
      const g = ctx.cache.graph({ expanded, kinds, min, view, symlinks: flag('symlinks', view === 'folders'), externals: flag('externals', view === 'folders'), extra });
      return send(res, 200, { ...g, areas: ctx.cache.areas, stats: ctx.cache.stats });
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
      return send(res, 200, { results: search(ctx, url.searchParams.get('q') ?? '', Math.min(100, num(url.searchParams.get('limit'), 30))) });
    }

    if (path === '/api/path' && method === 'GET') {
      const p = url.searchParams.get('p') ?? '';
      const id = resolveNodeRef(ctx, undefined, p, false);
      return send(res, 200, ctx.cache.nodes.get(id));
    }

    if (path === '/api/edges' && method === 'POST') {
      const b = await readJson(req);
      const src = resolveNodeRef(ctx, b.src, b.srcPath, true);
      const dst = resolveNodeRef(ctx, b.dst, b.dstPath, true);
      if (src === dst) throw new HttpError(400, 'un arco deve unire due nodi diversi');
      const kind = String(b.kind ?? 'manual');
      if (!EDGE_KINDS.has(kind)) throw new HttpError(400, `kind non ammesso: ${kind}`);
      const origin = String(b.origin ?? 'user').slice(0, 60);
      const verified = origin === 'user' ? (b.verified === false ? 0 : 1) : (b.verified === true ? 1 : 0);
      const confidence = typeof b.confidence === 'number' ? Math.max(0, Math.min(1, b.confidence)) : 1;
      const evidence = b.evidence && typeof b.evidence === 'object' ? b.evidence : { note: typeof b.evidence === 'string' ? b.evidence : 'aggiunto a mano' };
      const r = ctx.db.run(`INSERT INTO edges (src, dst, kind, verified, confidence, evidence, origin, created_at, gen, count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1)
        ON CONFLICT(src, dst, kind, origin) DO UPDATE SET verified = excluded.verified, confidence = excluded.confidence, evidence = excluded.evidence, hidden = 0`,
        src, dst, kind, verified, confidence, JSON.stringify(evidence), origin, Date.now());
      const id = Number(r.lastInsertRowid) || ctx.db.get<{ id: number }>('SELECT id FROM edges WHERE src = ? AND dst = ? AND kind = ? AND origin = ?', src, dst, kind, origin)!.id;
      const e = edgeById(ctx, id);
      replaceEdgeInCache(ctx, e, id);
      ctx.changed('edge');
      return send(res, 201, edgePayload(e));
    }

    m = /^\/api\/edges\/(\d+)$/.exec(path);
    if (m && method === 'PATCH') {
      const id = Number(m[1]);
      const b = await readJson(req);
      edgeById(ctx, id);
      if (typeof b.hidden === 'boolean') ctx.db.run('UPDATE edges SET hidden = ? WHERE id = ?', b.hidden ? 1 : 0, id);
      if (typeof b.confidence === 'number') ctx.db.run('UPDATE edges SET confidence = ? WHERE id = ?', Math.max(0, Math.min(1, b.confidence)), id);
      if (typeof b.kind === 'string' && EDGE_KINDS.has(b.kind)) ctx.db.run('UPDATE edges SET kind = ? WHERE id = ?', b.kind, id);
      const e = edgeById(ctx, id);
      replaceEdgeInCache(ctx, e, id);
      ctx.changed('edge');
      return send(res, 200, edgePayload(e));
    }
    if (m && method === 'DELETE') {
      const id = Number(m[1]);
      const e = edgeById(ctx, id);
      if (e.origin === 'scan' || e.origin.startsWith('import:') || e.origin === 'llm') {
        // computed edges would come back at the next index run: hide them instead
        ctx.db.run('UPDATE edges SET hidden = 1 WHERE id = ?', id);
        replaceEdgeInCache(ctx, edgeById(ctx, id), id);
      } else {
        ctx.db.run('DELETE FROM edges WHERE id = ?', id);
        replaceEdgeInCache(ctx, null, id);
      }
      ctx.changed('edge');
      return send(res, 200, { ok: true });
    }

    m = /^\/api\/nodes\/(\d+)\/notes$/.exec(path);
    if (m && method === 'POST') {
      const id = Number(m[1]);
      if (!ctx.cache.nodes.has(id)) throw new HttpError(404, 'nodo non trovato');
      const b = await readJson(req);
      const text = String(b.text ?? '').trim();
      if (!text) throw new HttpError(400, 'testo vuoto');
      const r = ctx.db.run('INSERT INTO notes (node_id, kind, text, origin, created_at) VALUES (?, ?, ?, ?, ?)', id, String(b.kind ?? 'note'), text.slice(0, 4000), String(b.origin ?? 'user').slice(0, 60), Date.now());
      const note = notesOf(ctx, id).find((n) => n.id === Number(r.lastInsertRowid));
      return send(res, 201, note);
    }
    m = /^\/api\/notes\/(\d+)$/.exec(path);
    if (m && method === 'DELETE') {
      ctx.db.run('DELETE FROM notes WHERE id = ?', Number(m[1]));
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
      nodeDetail(ctx, srcNodeId); nodeDetail(ctx, dstNodeId);
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
      return send(res, 201, link);
    }
    m = /^\/api\/team-links\/([a-z0-9-]+)$/.exec(path);
    if (m && method === 'DELETE') {
      if (req.headers.authorization) throw new HttpError(403, 'I canali si rimuovono da Operativa');
      ctx.teams.unlink(m[1]); return send(res, 200, { ok: true });
    }

    m = /^\/api\/work\/(\d+)(?:\/(messages|tasks|state|spawn|wake)(?:\/([a-z0-9-]+))?)?$/.exec(path);
    if (m) {
      const nodeId = Number(m[1]);
      nodeDetail(ctx, nodeId); // Reject unknown nodes, including before writing the board.
      const action = m[2];
      const taskId = m[3];
      const b = method === 'GET' ? {} : await readJson(req);
      const actor = boundedText(method === 'GET' ? url.searchParams.get('session') ?? undefined : b.from, 80) || 'user';
      const member = actor === 'user' ? undefined : ctx.terms.get(actor);
      if (actor !== 'user' && (!member || !member.info.alive || member.info.nodeId !== nodeId || !member.info.role || req.headers.authorization !== `Bearer ${member.teamToken}`)) throw new HttpError(403, 'Sessione non autorizzata per questo nodo');
      const canManage = actor === 'user' || member?.info.role === 'orchestrator';
      const sessions = ctx.terms.list().filter(s => s.nodeId === nodeId && s.agent !== 'shell');
      const links = ctx.teams.getLinks().filter(l => l.srcNodeId === nodeId || l.dstNodeId === nodeId);
      const peers = ctx.terms.list().filter(s => s.nodeId !== nodeId && s.alive && s.role && sessions.some(own => own.alive && ctx.teams.canTalk(own, s)));
      ctx.teams.recover(nodeId, sessions);
      const recipient = (id: unknown): string | null => {
        if (id === null || id === undefined || id === '') return null;
        if (typeof id !== 'string' || !sessions.some(s => s.id === id && s.alive)) throw new HttpError(400, 'Destinatario non attivo su questo nodo');
        return id;
      };
      const wake = (id: string) => wakeSession(ctx, id);
      const notify = () => notifyTeam(ctx, nodeId);
      if (!action && method === 'GET') {
        const board = ctx.teams.get(nodeId);
        if (!member) return send(res, 200, { ...board, messages: board.messages.slice(-50), sessions, peers, links });
        const messages = board.messages.filter(msg => msg.id > member.seenMessage && msg.from !== actor && (!msg.to || msg.to === actor)).slice(0, 50);
        if (messages.length) member.seenMessage = messages.at(-1)!.id;
        return send(res, 200, { ...board, messages, tasks: member.info.role === 'orchestrator' ? board.tasks : board.tasks.filter(t => t.assignedTo === actor || (t.assignedTo === null && t.status !== 'done')), sessions, peers, links });
      }
      if (!action && method === 'PATCH') {
        if (!canManage) throw new HttpError(403, 'Solo l’orchestratore aggiorna il riepilogo');
        if (actor !== 'user' && (b.autoSpawn !== undefined || b.maxAgents !== undefined)) throw new HttpError(403, 'Solo l’utente cambia i limiti della squadra');
        return send(res, 200, ctx.teams.update(nodeId, b));
      }
      if (action === 'state' && method === 'POST') {
        if (!member || !['working', 'idle', 'blocked'].includes(String(b.state))) throw new HttpError(400, 'Stato o sessione non validi');
        member.info.workState = b.state as 'working' | 'idle' | 'blocked';
        wake(actor);
        return send(res, 200, { state: member.info.workState });
      }
      if (action === 'messages' && method === 'POST') {
        const to = typeof b.to === 'string' ? ctx.terms.get(b.to) : undefined;
        const crossNode = to?.info.nodeId != null && to.info.nodeId !== nodeId;
        if (crossNode) {
          if (!to.info.alive || !to.info.role || !(member ? ctx.teams.canTalk(member.info, to.info) : sessions.some(s => s.alive && ctx.teams.canTalk(s, to.info)))) throw new HttpError(403, 'Collega prima le sessioni in Operativa');
          const text = boundedText(b.text, 1200, true);
          const message = ctx.teams.message(to.info.nodeId!, actor, to.info.id, text);
          ctx.teams.message(nodeId, actor, to.info.id, text);
          notifyTeam(ctx, to.info.nodeId!); return send(res, 201, message);
        }
        const message = ctx.teams.message(nodeId, actor, recipient(b.to), b.text);
        notify(); return send(res, 201, message);
      }
      if (action === 'tasks' && !taskId && method === 'POST') {
        if (!canManage) throw new HttpError(403, 'Solo l’orchestratore crea incarichi');
        const assignedTo = recipient(b.assignedTo);
        const task = ctx.teams.createTask(nodeId, actor, { title: b.title, scope: b.scope, assignedTo });
        ctx.teams.message(nodeId, actor, assignedTo, `Incarico ${task.id}: ${task.title}`);
        notify(); return send(res, 201, task);
      }
      if (action === 'tasks' && taskId && method === 'PATCH') {
        const task = ctx.teams.changeTask(nodeId, taskId, actor, member?.info.role, { status: b.status, result: b.result, ...(b.assignedTo !== undefined ? { assignedTo: recipient(b.assignedTo) } : {}) });
        const target = sessions.find(s => s.alive && s.role === 'orchestrator' && s.id !== actor);
        if (target && (task.status === 'done' || task.status === 'blocked')) {
          ctx.teams.message(nodeId, actor, target.id, `${task.status === 'done' ? 'Completato' : 'Bloccato'} ${task.id}: ${task.result.slice(0, 1100) || task.title}`);
          wake(target.id);
        }
        return send(res, 200, task);
      }
      if (action === 'spawn' && method === 'POST') {
        if (!member || member.info.role !== 'orchestrator' || !ctx.teams.get(nodeId).policy.autoSpawn) throw new HttpError(403, 'Avvio automatico non abilitato per questo orchestratore');
        if (!['operator', 'reviewer'].includes(String(b.role))) throw new HttpError(400, 'Un delegato deve essere operatore o revisore');
        boundedText(b.task, 1000, true);
        const launched = startSession(ctx, nodeDetail(ctx, nodeId), { ...b, id: nodeId, mode: 'embedded', parentId: actor } as unknown as LaunchRequest);
        return send(res, 201, launched);
      }
      if (action === 'wake' && method === 'POST') {
        if (actor !== 'user') throw new HttpError(403, 'Risveglio manuale riservato all’utente');
        const id = recipient(b.to);
        if (!id || !wake(id)) throw new HttpError(409, 'La sessione deve essere in attesa e avere nuovi messaggi');
        return send(res, 200, { ok: true });
      }
      throw new HttpError(404, 'Azione squadra sconosciuta');
    }

    if (path === '/api/launch-squad' && method === 'POST') {
      if (req.headers.authorization) throw new HttpError(403, 'Avvia la squadra dalla vista Operativa');
      const b = await readJson(req);
      return send(res, 201, startSquad(ctx, nodeDetail(ctx, Number(b.id)), b as unknown as import('../shared/types.ts').SquadRequest));
    }

    if (path === '/api/launch' && method === 'POST') {
      const b = (await readJson(req)) as unknown as LaunchRequest & { cols?: number; rows?: number };
      const detail = nodeDetail(ctx, Number(b.id));
      const result = startSession(ctx, detail, b);
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

    if (path === '/api/terminals' && method === 'GET') return send(res, 200, ctx.terms.list());
    m = /^\/api\/terminals\/([a-z0-9-]+)$/.exec(path);
    if (m && method === 'DELETE') {
      const nodeId = ctx.terms.get(m[1])?.info.nodeId;
      if (nodeId != null) ctx.teams.release(nodeId, m[1]);
      ctx.terms.kill(m[1]); return send(res, 200, { ok: true });
    }

    throw new HttpError(404, 'percorso sconosciuto');
  } catch (err) {
    const status = err instanceof HttpError || err instanceof TeamError ? err.status : 500;
    send(res, status, { error: err instanceof Error ? err.message : String(err) });
  }
}
