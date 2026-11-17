import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiCtx } from './api.ts';
import type { TerminalInfo } from '../shared/types.ts';
import type { CoordinationRequest, MegaStatsReport, StatsLatency, StatsMeasures, StatsSession, StatsTeam } from '../shared/mega-stats.ts';

const HOUR = 3_600_000;
const WEEK = 168 * HOUR;
type Scope = { node: number; team: string | null; sid: string | null };
type Member = Scope & { sid: string; label: string; agent: string; role: string | null; created: number; seen: number };
type Turn = { sid: string; start: number | null; stop: number | null; source: string };
type Event = Scope & { kind: string; ms: number; error: number };
type Samples = { metrics: StatsMeasures; turns: number[]; http: number[] };
const emptyLatency = (): StatsLatency => ({ n: 0, p50Ms: null, p95Ms: null });
const samples = (): Samples => ({
  metrics: { turns: null, unpairedTurns: 0, turnsPerHour: null, turnLatency: emptyLatency(), http: 0, httpPerHour: null,
    httpLatency: emptyLatency(), httpErrors: 0, retries: null, completed: 0, completedPerHour: null, waiting: 0, blocked: 0 },
  turns: [], http: [],
});
function latency(values: number[]): StatsLatency {
  if (!values.length) return emptyLatency();
  values.sort((a, b) => a - b);
  return { n: values.length, p50Ms: values[Math.ceil(.5 * values.length) - 1], p95Ms: values[Math.ceil(.95 * values.length) - 1] };
}
function finish(s: Samples, observedMs: number): StatsMeasures {
  const rate = (n: number | null) => observedMs > 0 && n !== null ? n * HOUR / observedMs : null;
  return { ...s.metrics, turnLatency: latency(s.turns), httpLatency: latency(s.http), turnsPerHour: rate(s.metrics.turns),
    httpPerHour: rate(s.metrics.http), completedPerHour: rate(s.metrics.completed) };
}

/** Each API process owns one interval. Heartbeats bound the unobserved tail after a crash. */
export class MegaStats {
  private db: DatabaseSync;
  private run = randomUUID();
  private lastPrune = 0;
  private scopes = new WeakMap<IncomingMessage, Scope>();
  private inventory = new Map<string, string>();
  private live = new Map<string, { state: string | null; attention: string | null; since: number | null }>();
  private notifyTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  available = true;
  private changed: () => void;

  constructor(path: string, changed: () => void = () => {}, now = Date.now()) {
    this.changed = changed;
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, start INTEGER, stop INTEGER);
      CREATE TABLE IF NOT EXISTS members (sid TEXT PRIMARY KEY, node INTEGER, team TEXT, label TEXT, agent TEXT, role TEXT, created INTEGER, seen INTEGER);
      CREATE TABLE IF NOT EXISTS events (at INTEGER, kind TEXT, node INTEGER, team TEXT, sid TEXT, ms REAL, error INTEGER, k TEXT UNIQUE);
      CREATE INDEX IF NOT EXISTS stats_event_window ON events(at,node);
      CREATE INDEX IF NOT EXISTS stats_event_scope ON events(node,at);
      CREATE TABLE IF NOT EXISTS turns (sid TEXT, id TEXT, start INTEGER, stop INTEGER, source TEXT, run TEXT, PRIMARY KEY(sid,id));
      CREATE INDEX IF NOT EXISTS stats_turn_start ON turns(start);
      CREATE TABLE IF NOT EXISTS sources (sid TEXT PRIMARY KEY, source TEXT, first INTEGER, last INTEGER);
      CREATE TABLE IF NOT EXISTS preferences (node INTEGER, team TEXT, body TEXT, PRIMARY KEY(node,team));`);
    this.db.prepare('INSERT INTO runs VALUES (?,?,?)').run(this.run, now, now);
    this.beat(now);
  }
  beat(now = Date.now()) {
    this.db.prepare('UPDATE runs SET stop=? WHERE id=?').run(now, this.run);
    if (now - this.lastPrune < HOUR) return;
    const cut = now - WEEK;
    this.db.prepare('DELETE FROM events WHERE at<?').run(cut);
    this.db.prepare('DELETE FROM turns WHERE COALESCE(stop,start)<?').run(cut);
    this.db.prepare('DELETE FROM runs WHERE stop<?').run(cut);
    this.db.prepare('DELETE FROM members WHERE seen<?').run(cut);
    this.db.prepare('DELETE FROM sources WHERE last<? AND sid NOT IN (SELECT sid FROM members)').run(cut);
    this.lastPrune = now;
  }
  signal() {
    if (!this.notifyTimer) this.notifyTimer = setTimeout(() => { this.notifyTimer = undefined; this.changed(); }, 350);
  }
  close(now = Date.now()) {
    this.closed = true;
    clearTimeout(this.notifyTimer); this.capture(() => this.beat(now)); this.db.close();
  }
  /** Optional local measurements must not interrupt a terminal or change the result of a board operation. */
  capture(write: () => void) {
    if (!this.available) return;
    try { write(); }
    catch {
      this.available = false;
      console.warn('[stats] Registrazione sospesa: archivio locale non disponibile.');
      if (!this.closed) this.signal();
    }
  }
  snapshot(ctx: ApiCtx, now = Date.now()) {
    const found = new Set<string>();
    for (const s of ctx.teams.withCodes(ctx.terms.list())) {
      if (s.nodeId == null) continue;
      found.add(s.id);
      const team = s.role ? ctx.teams.teamOf(s.nodeId, s) : null;
      const label = s.code || s.name || s.id;
      const key = JSON.stringify([s.nodeId, team, label, s.agent, s.role, s.alive]);
      if (key !== this.inventory.get(s.id)) {
        this.db.prepare(`INSERT INTO members VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(sid) DO UPDATE SET node=excluded.node,team=excluded.team,label=excluded.label,agent=excluded.agent,role=excluded.role,seen=excluded.seen`)
          .run(s.id, s.nodeId, team, label, s.agent, s.role ?? null, s.createdAt, now);
        this.inventory.set(s.id, key); this.signal();
      }
      const prev = this.live.get(s.id);
      if (s.alive) {
        const state = s.workState ?? null, attention = s.attention ?? null;
        if (!prev || prev.state !== state || prev.attention !== attention) {
          const since = attention ? ctx.terms.get(s.id)?.activity?.attentionAt ?? now : state === 'blocked' ? now : state === 'idle' ? s.idleSince ?? null : null;
          this.live.set(s.id, { state, attention, since }); this.signal();
        }
      } else if (this.live.delete(s.id)) this.signal();
    }
    for (const id of this.inventory.keys()) if (!found.has(id)) {
      this.db.prepare('UPDATE members SET seen=? WHERE sid=?').run(now, id);
      this.inventory.delete(id); this.live.delete(id); this.signal();
    }
  }
  heartbeat(ctx: ApiCtx, now = Date.now()) {
    this.snapshot(ctx, now);
    this.db.prepare('UPDATE members SET seen=? WHERE sid IN (SELECT value FROM json_each(?))').run(now, JSON.stringify([...this.live.keys()]));
    this.beat(now);
  }
  bind(req: IncomingMessage, node: number, team: string | null, sid: string | null) { this.scopes.set(req, { node, team, sid }); }
  http(scope: Scope | undefined, ms: number, status: number, at = Date.now()) {
    this.db.prepare("INSERT INTO events VALUES (?,'http',?,?,?,?,?,NULL)").run(at, scope?.node ?? null, scope?.team ?? null, scope?.sid ?? null, ms, Number(status >= 400));
    if (scope) this.signal();
  }
  watch(req: IncomingMessage, res: ServerResponse, ctx: ApiCtx) {
    const path = (req.url ?? '').split('?')[0];
    if (!path.startsWith('/api/') || path.startsWith('/api/mega-stats')) return;
    const start = performance.now();
    const match = /^\/api\/(?:work|node|git|code|nodes)\/(\d+)(?:\/|$)/.exec(path);
    if (match) this.bind(req, Number(match[1]), null, null);
    if (path === '/api/explore' || path === '/api/reminders' || path === '/api/reminder-board') {
      const q = new URL(req.url!, 'http://local').searchParams;
      const id = q.get(path === '/api/explore' ? 'node' : 'nodeId');
      if (id && /^[1-9]\d*$/.test(id)) this.bind(req,Number(id),null,null);
    }
    const term = /^\/api\/terminals\/([a-z0-9-]+)(?:\/|$)/.exec(path);
    const info = term && ctx.terms.get(term[1])?.info;
    if (info && info.nodeId != null && !req.headers.authorization) this.bind(req, info.nodeId, info.role ? ctx.teams.teamOf(info.nodeId, info) : null, info.id);
    res.once('finish', () => {
      if (this.closed) return;
      this.capture(() => this.http(this.scopes.get(req), performance.now() - start, res.statusCode));
    });
  }
  done(node: number, team: string, sid: string | null, task: string, at = Date.now()) {
    this.capture(() => {
      this.db.prepare("INSERT OR IGNORE INTO events VALUES (?,'done',?,?,?,0,0,?)").run(at, node, team, sid, JSON.stringify([node, team, task]));
      this.signal();
    });
  }
  turn(s: TerminalInfo, phase: 'ready' | 'start' | 'stop' | 'interrupted', id?: string, at = Date.now()) {
    // Existing Claude state hooks report sequential turns without an ID. Never pair these across an API restart.
    const source = s.agent === 'codex' ? 'Codex hook' : 'Claude Code hook';
    this.db.prepare('INSERT INTO sources VALUES (?,?,?,?) ON CONFLICT(sid) DO UPDATE SET last=excluded.last').run(s.id,source,at,at);
    if (phase === 'ready') { this.signal(); return; }
    if (phase === 'interrupted') { this.signal(); return; } // not a successful response
    if (!id) {
      const open = this.db.prepare('SELECT id FROM turns WHERE sid=? AND run=? AND stop IS NULL AND source=? ORDER BY start DESC LIMIT 1').get(s.id, this.run, source);
      if (phase === 'start' && open) return;
      id = open ? String(open.id) : randomUUID();
    }
    const start = phase === 'start' ? at : null, stop = phase === 'stop' ? at : null;
    this.db.prepare(`INSERT INTO turns VALUES (?,?,?,?,?,?) ON CONFLICT(sid,id) DO UPDATE SET
      start=COALESCE(turns.start,excluded.start),stop=COALESCE(turns.stop,excluded.stop)`).run(s.id, id, start, stop, source, this.run);
    this.signal();
  }
  private project(ctx: ApiCtx, node: number): number {
    const project = ctx.cache.nodes.get(node)?.projectId;
    return ctx.cache.projectByNode.has(node) ? node : project != null ? ctx.cache.projects.get(project)?.nodeId ?? node : node;
  }
  private linked(ctx: ApiCtx) {
    const nodes = new Set(ctx.teams.getLinks().flatMap(l => [l.srcNodeId, l.dstNodeId]).filter(n => ctx.cache.nodes.has(n)));
    return { nodes, projects: new Set([...nodes].map(n => this.project(ctx, n))) };
  }
  setRequest(ctx: ApiCtx, node: number, team: string, values: Pick<CoordinationRequest,'cadenceMinutes'|'mode'|'provider'>): CoordinationRequest {
    if (!this.linked(ctx).projects.has(this.project(ctx, node)) || !ctx.cache.nodes.has(node) || (team !== 'brain' && !ctx.teams.team(node, team))) throw new RangeError('Destinatario non collegato');
    const body = { ...values, status: 'pending' as const, updatedAt: Date.now() };
    this.db.prepare('INSERT OR REPLACE INTO preferences VALUES (?,?,?)').run(node, team, JSON.stringify(body));
    this.signal(); return body;
  }
  report(ctx: ApiCtx, hours: number, filters: { project: string | null; team: string | null; session: string | null }, now = Date.now()): MegaStatsReport {
    this.snapshot(ctx, now); this.beat(now);
    const from = now - hours * HOUR, { nodes, projects: linked } = this.linked(ctx);
    const projects = [...linked].map(id => ({ id, name: ctx.cache.nodes.get(id)?.name ?? String(id) }));
    const rows = this.db.prepare('SELECT * FROM members WHERE seen>=?').all(from) as unknown as Member[];
    const teamNodes = new Set([...nodes,...linked]);
    const totals = samples(), groups = new Map<string,Samples>(), sessions: StatsSession[] = [];
    const projectOk = (p: number) => linked.has(p) && (!filters.project || String(p) === filters.project);
    const accepts = (s: Scope) => projectOk(this.project(ctx, s.node)) && (!filters.team || filters.team === `${s.node}:${s.team}`) && (!filters.session || filters.session === s.sid);
    for (const r of rows) {
      if (linked.has(this.project(ctx, r.node))) teamNodes.add(r.node);
      if (!accepts(r)) continue;
      const g = samples(), live = this.live.get(r.sid);
      g.metrics.waiting = Number(!!live?.attention); g.metrics.blocked = Number(live?.state === 'blocked');
      totals.metrics.waiting += g.metrics.waiting; totals.metrics.blocked += g.metrics.blocked;
      groups.set(r.sid, g);
      sessions.push({ id:r.sid, label:r.label, nodeId:r.node, projectId:this.project(ctx, r.node), teamKey:r.team ? `${r.node}:${r.team}` : null,
        agent:r.agent, role:r.role, alive:!!live, state:live?.state ?? null, attention:live?.attention ?? null, since:live?.since ?? null, turnSource:null, metrics:g.metrics });
    }
    const teams: StatsTeam[] = [];
    for (const nodeId of teamNodes) {
      const projectId = this.project(ctx,nodeId);
      for (const t of [...ctx.teams.teams(nodeId), {id:'brain', name:'Main Brain'}]) {
        const lead = rows.find(r => r.node === nodeId && r.team === t.id && (r.role === 'brain' || r.role === 'orchestrator') && this.live.has(r.sid));
        const saved = this.db.prepare('SELECT body FROM preferences WHERE node=? AND team=?').get(nodeId,t.id);
        const board = ctx.teams.get(nodeId,t.id);
        teams.push({ key:`${nodeId}:${t.id}`, id:t.id, name:t.name, nodeId,projectId,recipient:lead?.label ?? null,
          blockedTasks:board.tasks.filter(task => task.status === 'blocked' && (!filters.session || task.assignedTo === filters.session)).length,
          autoSpawn:board.policy.autoSpawn, requested:saved ? JSON.parse(String(saved.body)) : null });
      }
    }
    const unattributedHttp = Number(this.db.prepare('SELECT COUNT(*) AS n FROM events WHERE node IS NULL AND at BETWEEN ? AND ?').get(from,now)!.n);
    const nodeIds = this.db.prepare('SELECT DISTINCT node FROM events WHERE node IS NOT NULL').all()
      .map(row => Number(row.node)).filter(node => projectOk(this.project(ctx,node)));
    for (const e of this.db.prepare('SELECT kind,node,team,sid,ms,error FROM events WHERE node IN (SELECT value FROM json_each(?)) AND at BETWEEN ? AND ?')
      .iterate(JSON.stringify(nodeIds),from,now) as unknown as Iterable<Event>) {
      if (!accepts(e)) continue;
      const group = e.sid && groups.get(e.sid);
      for (const acc of group ? [totals, group] : [totals]) {
        if (e.kind === 'done') acc.metrics.completed++;
        else { acc.metrics.http++; acc.metrics.httpErrors += e.error; acc.http.push(e.ms); }
      }
    }
    const byId = new Map(sessions.map(s => [s.id,s]));
    for (const row of this.db.prepare('SELECT sid,source FROM sources WHERE first<=?').iterate(now)) {
      const s = byId.get(String(row.sid));
      if (s) { s.turnSource = String(row.source); groups.get(s.id)!.metrics.turns = 0; totals.metrics.turns ??= 0; }
    }
    for (const e of this.db.prepare('SELECT sid,start,stop,source FROM turns WHERE start>=? OR stop>=?').iterate(from,from) as unknown as Iterable<Turn>) {
      const g = groups.get(e.sid); if (!g) continue;
      byId.get(e.sid)!.turnSource = e.source;
      for (const acc of [totals,g]) {
        acc.metrics.turns ??= 0;
        if (e.start != null && e.start >= from && e.start <= now) acc.metrics.turns++;
        if (e.stop != null && e.stop >= from && e.stop <= now && e.start != null && e.stop >= e.start) acc.turns.push(e.stop - e.start);
        else if (e.stop == null || e.start == null || e.stop < e.start) acc.metrics.unpairedTurns++;
      }
    }
    const observedMs = Number(this.db.prepare('SELECT SUM(MAX(0,MIN(stop,?)-MAX(start,?))) AS ms FROM runs WHERE stop>=? AND start<=?').get(now,from,from,now)?.ms ?? 0);
    for (const s of sessions) s.metrics = finish(groups.get(s.id)!,observedMs);
    return { from, to:now, updatedAt:now, observedMs, coverageStart:Number(this.db.prepare('SELECT MIN(start) AS start FROM runs').get()!.start),
      projects, teams, sessions, totals:finish(totals,observedMs), unattributedHttp };
  }
}
