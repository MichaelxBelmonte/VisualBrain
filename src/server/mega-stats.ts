import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiCtx } from './api.ts';
import type { TeamTask, TerminalInfo } from '../shared/types.ts';
import type { MegaStatsReport, StatsAccount, StatsLatency, StatsMeasures, StatsQuality, StatsQualityRow, StatsSession, StatsTeam, StatsTimeline, StatsUsage } from '../shared/mega-stats.ts';
import { sessionRecordFile } from './session-model.ts';
import { addUsage, bucketOf, emptyUsage, usageBuckets, usageOf } from './session-usage.ts';
import { accountById, mainName } from './accounts.ts';

const HOUR = 3_600_000;
const WEEK = 168 * HOUR;
type Scope = { node: number; team: string | null; sid: string | null };
type Member = Scope & { sid: string; label: string; agent: string; role: string | null; created: number; seen: number };
type Turn = { sid: string; start: number | null; stop: number | null; source: string };
type Event = Scope & { kind: string; ms: number; error: number };
type Step = { at: number; node: number; team: string; task: string; sid: string | null; kind: 'created' | 'status' | 'assigned'; prev: string | null; next: string | null };

/** «/api/terminals/a1b2c3d4/input» → «/api/terminals/:id/input»: the route of a failed call, never its ids or query. */
export function routeOf(path: string): string {
  return path.split('?')[0].split('/').map(part => /^\d+$/.test(part) || (/\d/.test(part) && part.length >= 6) || /^[0-9a-f-]{8,}$/i.test(part) ? ':id' : part).join('/').slice(0, 120);
}
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

/**
 * Interval edges for a period: 5 min for an hour, 1 h for a day, 6 h for a week, on the local clock (06:00, 12:00…).
 * The first interval starts at `from`, the last ends at `now`.
 */
export function timelineEdges(from: number, now: number, hours: number): number[] {
  const size = hours <= 1 ? 5 * 60_000 : hours <= 24 ? HOUR : 6 * HOUR;
  const offset = -new Date(now).getTimezoneOffset() * 60_000;
  const edges = [from];
  for (let at = Math.floor((from + offset) / size) * size - offset + size; at < now; at += size) edges.push(at);
  edges.push(now);
  return edges;
}

/** Each API process owns one interval. Heartbeats bound the unobserved tail after a crash. */
export class MegaStats {
  private db: DatabaseSync;
  private run = randomUUID();
  private lastPrune = 0;
  private scopes = new WeakMap<IncomingMessage, Scope>();
  private inventory = new Map<string, string>();
  private live = new Map<string, { state: string | null; attention: string | null; since: number | null }>();
  private insertStep: ReturnType<DatabaseSync['prepare']>;
  private insertWait: ReturnType<DatabaseSync['prepare']>;
  private insertFailure: ReturnType<DatabaseSync['prepare']>;
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
      CREATE TABLE IF NOT EXISTS task_steps (at INTEGER, node INTEGER, team TEXT, task TEXT, sid TEXT, kind TEXT, prev TEXT, next TEXT);
      CREATE INDEX IF NOT EXISTS stats_task_steps ON task_steps(at);
      CREATE TABLE IF NOT EXISTS waits (sid TEXT, start INTEGER, stop INTEGER, kind TEXT, PRIMARY KEY(sid,start));
      CREATE TABLE IF NOT EXISTS failures (at INTEGER, node INTEGER, route TEXT, status INTEGER);
      CREATE INDEX IF NOT EXISTS stats_failures ON failures(at);`);
    // Written on changes only (a task moves, a wait ends, a call fails): prepared once.
    this.insertStep = this.db.prepare('INSERT INTO task_steps VALUES (?,?,?,?,?,?,?,?)');
    this.insertWait = this.db.prepare('INSERT OR IGNORE INTO waits VALUES (?,?,?,?)');
    this.insertFailure = this.db.prepare('INSERT INTO failures VALUES (?,?,?,?)');
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
    this.db.prepare('DELETE FROM task_steps WHERE at<?').run(cut);
    this.db.prepare('DELETE FROM waits WHERE stop<?').run(cut);
    this.db.prepare('DELETE FROM failures WHERE at<?').run(cut);
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
      if (prev?.attention && (!s.alive || !s.attention)) this.endWait(s.id, prev, now);
      if (s.alive) {
        const state = s.workState ?? null, attention = s.attention ?? null;
        if (!prev || prev.state !== state || prev.attention !== attention) {
          const since = attention ? ctx.terms.get(s.id)?.activity?.attentionAt ?? now : state === 'blocked' ? now : state === 'idle' ? s.idleSince ?? null : null;
          this.live.set(s.id, { state, attention, since }); this.signal();
        }
      } else if (this.live.delete(s.id)) this.signal();
    }
    for (const id of this.inventory.keys()) if (!found.has(id)) {
      const prev = this.live.get(id);
      if (prev?.attention) this.endWait(id, prev, now);
      this.db.prepare('UPDATE members SET seen=? WHERE sid=?').run(now, id);
      this.inventory.delete(id); this.live.delete(id); this.signal();
    }
  }
  /** A permission dialog or a question answered (or gone): how long the agent waited for the person. */
  private endWait(sid: string, prev: { attention: string | null; since: number | null }, now: number) {
    const start = prev.since ?? now;
    if (now > start) this.insertWait.run(sid, start, now, prev.attention);
  }
  /**
   * A squad's board was saved: records what changed in its tasks (created, new status, new owner). Called by Teams on
   * every save; compares two small arrays in memory and writes only the differences.
   */
  tasks(node: number, team: string, before: readonly TeamTask[], after: readonly TeamTask[], at = Date.now()) {
    const old = new Map(before.map(t => [t.id, t]));
    let wrote = false;
    for (const t of after) {
      const p = old.get(t.id);
      if (!p) { this.insertStep.run(at, node, team, t.id, t.assignedTo, 'created', null, t.status); wrote = true; continue; }
      if (p.status !== t.status) { this.insertStep.run(at, node, team, t.id, t.assignedTo ?? p.assignedTo, 'status', p.status, t.status); wrote = true; }
      if (p.assignedTo && t.assignedTo && p.assignedTo !== t.assignedTo) { this.insertStep.run(at, node, team, t.id, t.assignedTo, 'assigned', p.assignedTo, t.assignedTo); wrote = true; }
    }
    if (wrote) this.signal();
  }
  heartbeat(ctx: ApiCtx, now = Date.now()) {
    this.snapshot(ctx, now);
    this.db.prepare('UPDATE members SET seen=? WHERE sid IN (SELECT value FROM json_each(?))').run(now, JSON.stringify([...this.live.keys()]));
    this.beat(now);
  }
  bind(req: IncomingMessage, node: number, team: string | null, sid: string | null) { this.scopes.set(req, { node, team, sid }); }
  http(scope: Scope | undefined, ms: number, status: number, at = Date.now(), route?: string) {
    this.db.prepare("INSERT INTO events VALUES (?,'http',?,?,?,?,?,NULL)").run(at, scope?.node ?? null, scope?.team ?? null, scope?.sid ?? null, ms, Number(status >= 400));
    if (status >= 400 && route) this.insertFailure.run(at, scope?.node ?? null, route, status);
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
      this.capture(() => this.http(this.scopes.get(req), performance.now() - start, res.statusCode, Date.now(), res.statusCode >= 400 ? `${req.method ?? 'GET'} ${routeOf(path)}` : undefined));
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
  /**
   * «Qualità»: the boards' transitions and the waits for the person in the period, in the same scope as the rest of the
   * report. Only runs when the Stats are open; a week of transitions is a few thousand small rows.
   */
  private quality(ctx: ApiCtx, rows: Member[], sessions: StatsSession[], accepts: (s: Scope) => boolean, filtered: boolean, from: number, now: number, timeline: StatsTimeline): StatsQuality {
    const members = new Map(rows.map(r => [r.sid, r]));
    const bySession = new Map(sessions.map(s => [s.id, s]));
    const steps = this.db.prepare('SELECT * FROM task_steps ORDER BY at, rowid').all() as unknown as Step[];
    const inScope = (s: Step) => accepts({ node: s.node, team: s.team, sid: s.sid });
    const inside = (at: number) => at >= from && at <= now;
    const q: StatsQuality = { since: steps[0]?.at ?? null, created: 0, completed: 0, reopened: 0, blocked: 0, reassigned: 0, cycle: latency([]), blockedMs: 0,
      waits: { n: 0, open: 0, permission: 0, input: 0, response: latency([]), histogram: [0, 0, 0, 0, 0] }, workers: [], teams: [], failures: [] };
    const slot = (at: number) => bucketOf(timeline.edges, at);
    type Acc = StatsQualityRow & { cycles: number[]; sids: Set<string> };
    const workers = new Map<string, Acc>(), teams = new Map<string, Acc>();
    const row = (map: Map<string, Acc>, key: string, make: () => Omit<StatsQualityRow, 'created' | 'completed' | 'reopened' | 'blocked' | 'cycle' | 'tokensPerTask'>) => {
      let r = map.get(key);
      if (!r) map.set(key, r = { ...make(), created: 0, completed: 0, reopened: 0, blocked: 0, cycle: latency([]), tokensPerTask: null, cycles: [], sids: new Set() });
      return r;
    };
    // The agent·model·role of a session: the model of its last answer when the record has one, otherwise the requested one.
    const worker = (sid: string | null) => {
      const m = sid ? members.get(sid) : undefined;
      if (!sid || !m || !m.role) return undefined;
      const model = bySession.get(sid)?.usage?.model ?? ctx.terms.get(sid)?.info.model ?? null;
      const r = row(workers, `${m.agent}|${model ?? ''}|${m.role}`, () => ({ key: `${m.agent}|${model ?? ''}|${m.role}`, label: m.agent, agent: m.agent, model: model || null, role: m.role }));
      r.sids.add(sid);
      return r;
    };
    const team = (s: Step) => row(teams, `${s.node}:${s.team}`, () => ({ key: `${s.node}:${s.team}`, label: ctx.teams.team(s.node, s.team)?.name ?? s.team, agent: null, model: null, role: null }));
    const created = new Map<string, number>(), lastDone = new Map<string, string | null>(), blockedAt = new Map<string, number>();
    const cycles: number[] = [];
    for (const s of steps) {
      const id = `${s.node}:${s.team}:${s.task}`;
      const counted = inside(s.at) && inScope(s);
      if (s.kind === 'created') {
        created.set(id, s.at);
        if (counted) { q.created++; team(s).created++; }
      }
      // Time blocked: from «bloccato» to the next status, within the period.
      if ((s.kind === 'status' || s.kind === 'created') && blockedAt.has(id) && s.next !== 'blocked') {
        if (inScope(s)) q.blockedMs += Math.max(0, Math.min(s.at, now) - Math.max(blockedAt.get(id)!, from));
        blockedAt.delete(id);
      }
      if (s.next === 'blocked' && s.kind !== 'assigned') {
        blockedAt.set(id, s.at);
        if (counted) { q.blocked++; team(s).blocked++; const w = worker(s.sid); if (w) w.blocked++; }
      }
      if (s.kind === 'status' && s.next === 'done') {
        lastDone.set(id, s.sid);
        if (counted) {
          q.completed++;
          if (slot(s.at) >= 0) timeline.completed[slot(s.at)]++;
          const start = created.get(id), w = worker(s.sid), g = team(s);
          w && w.completed++; g.completed++;
          if (start !== undefined) { cycles.push(s.at - start); w?.cycles.push(s.at - start); g.cycles.push(s.at - start); }
        }
      }
      // Reopened: a closed task put back to work counts against whoever closed it.
      if (s.kind === 'status' && s.prev === 'done' && (s.next === 'pending' || s.next === 'working')) {
        if (counted) { q.reopened++; if (slot(s.at) >= 0) timeline.reopened[slot(s.at)]++; team(s).reopened++; const w = worker(lastDone.get(id) ?? null); if (w) w.reopened++; }
        lastDone.delete(id);
      }
      if (s.kind === 'assigned' && counted) q.reassigned++;
    }
    for (const [id, start] of blockedAt) {
      const [node, teamId] = id.split(':');
      if (accepts({ node: Number(node), team: teamId, sid: null })) q.blockedMs += Math.max(0, now - Math.max(start, from));
    }
    q.cycle = latency(cycles);
    const finishRows = (map: Map<string, Acc>) => [...map.values()].map(({ cycles: c, sids, ...r }) => {
      let tokens = 0, known = false;
      for (const sid of sids) { const u = bySession.get(sid)?.usage; if (u) { tokens += u.input + u.output; known = true; } }
      return { ...r, cycle: latency(c), tokensPerTask: known && r.completed ? Math.round(tokens / r.completed) : null };
    }).filter(r => r.created || r.completed || r.reopened || r.blocked).sort((a, b) => b.completed - a.completed || b.created - a.created);
    // Every squad session counts toward its line's tokens, even one that closed nothing in the period.
    for (const s of sessions) if (s.role && s.role !== 'brain') worker(s.id);
    q.workers = finishRows(workers);
    q.teams = finishRows(teams);
    // Waits: those answered in the period and those still open.
    const response: number[] = [];
    for (const w of this.db.prepare('SELECT sid,start,stop,kind FROM waits WHERE stop>=? AND stop<=?').iterate(from, now) as unknown as Iterable<{ sid: string; start: number; stop: number; kind: string }>) {
      const m = members.get(w.sid);
      if (!m || !accepts(m)) continue;
      q.waits.n++; response.push(w.stop - w.start);
      const minutes = (w.stop - w.start) / 60_000;
      q.waits.histogram[minutes < 1 ? 0 : minutes < 5 ? 1 : minutes < 15 ? 2 : minutes < 60 ? 3 : 4]++;
      if (w.kind === 'permission') q.waits.permission++; else q.waits.input++;
    }
    for (const [sid, live] of this.live) { const m = members.get(sid); if (live.attention && m && accepts(m)) q.waits.open++; }
    q.waits.response = latency(response);
    // Failed calls by route. Without a node they belong to no project: listed only without a project or squad filter.
    const failures = new Map<string, { route: string; status: number; n: number }>();
    for (const f of this.db.prepare('SELECT node,route,status FROM failures WHERE at BETWEEN ? AND ?').iterate(from, now) as unknown as Iterable<{ node: number | null; route: string; status: number }>) {
      if (f.node == null ? filtered : !accepts({ node: f.node, team: null, sid: null })) continue;
      const key = `${f.status} ${f.route}`;
      const x = failures.get(key) ?? { route: f.route, status: f.status, n: 0 };
      x.n++; failures.set(key, x);
    }
    q.failures = [...failures.values()].sort((a, b) => b.n - a.n).slice(0, 8);
    return q;
  }
  private project(ctx: ApiCtx, node: number): number {
    const project = ctx.cache.nodes.get(node)?.projectId;
    return ctx.cache.projectByNode.has(node) ? node : project != null ? ctx.cache.projects.get(project)?.nodeId ?? node : node;
  }
  report(ctx: ApiCtx, hours: number, filters: { project: string | null; team: string | null; session: string | null }, now = Date.now()): MegaStatsReport {
    this.snapshot(ctx, now); this.beat(now);
    const from = now - hours * HOUR;
    // Every session seen in the period, whatever node it ran in: projects are those of their nodes.
    const rows = this.db.prepare('SELECT * FROM members WHERE seen>=?').all(from) as unknown as Member[];
    const projectIds = new Set(rows.map(r => this.project(ctx, r.node)));
    const projects = [...projectIds].map(id => ({ id, name: ctx.cache.nodes.get(id)?.name ?? String(id) })).sort((a, b) => a.name.localeCompare(b.name));
    const totals = samples(), groups = new Map<string,Samples>(), sessions: StatsSession[] = [];
    const projectOk = (p: number) => projectIds.has(p) && (!filters.project || String(p) === filters.project);
    const accepts = (s: Scope) => projectOk(this.project(ctx, s.node)) && (!filters.team || filters.team === `${s.node}:${s.team}`) && (!filters.session || filters.session === s.sid);
    const claimed = () => new Set(ctx.terms.list().map(s => s.resumeId).filter((r): r is string => Boolean(r)));
    const usage = emptyUsage(), accounts = new Map<string, StatsAccount>();
    const edges = timelineEdges(from, now, hours), slots = edges.length - 1, zeros = () => new Array<number>(slots).fill(0);
    const timeline: StatsTimeline = { edges, tokens: [], requests: zeros(), completed: zeros(), reopened: zeros() };
    const tokenSeries = new Map<string, StatsTimeline['tokens'][number]>();
    let usageMissing = 0;
    for (const r of rows) {
      if (!accepts(r)) continue;
      const g = samples(), live = this.live.get(r.sid);
      g.metrics.waiting = Number(!!live?.attention); g.metrics.blocked = Number(live?.state === 'blocked');
      totals.metrics.waiting += g.metrics.waiting; totals.metrics.blocked += g.metrics.blocked;
      groups.set(r.sid, g);
      // Turns and tokens from the CLI's own record, when the session is still known to the terminal store.
      const info = ctx.terms.get(r.sid)?.info;
      let used: StatsUsage | null = null;
      if (r.agent === 'claude' || r.agent === 'codex') {
        const file = info ? sessionRecordFile(info, claimed, now) : undefined;
        used = (file && usageOf(file, r.agent, from, now)) || null;
        if (used) addUsage(usage, used); else usageMissing++;
        const split = used && file ? usageBuckets(file, r.agent, edges) : undefined;
        if (split) {
          const key = `${r.agent}:${info?.account ?? ''}`;
          const line = tokenSeries.get(key) ?? { key, agent: r.agent, label: info?.account ? accountById(info.account)?.label ?? info.account : mainName(r.agent) ?? null, values: zeros() };
          split.tokens.forEach((v, i) => { line.values[i] += v; });
          split.turns.forEach((v, i) => { timeline.requests[i] += v; });
          tokenSeries.set(key, line);
        }
      }
      // An extra account by its current name; the main one by the name the person gave it, if any.
      const account = info?.account ?? null, accountLabel = account ? accountById(account)?.label ?? account : mainName(r.agent) ?? null;
      const activeMs = Math.max(0, Math.min(now, live ? now : r.seen) - Math.max(from, r.created));
      if (r.agent === 'claude' || r.agent === 'codex') {
        const key = `${r.agent}:${account ?? ''}`;
        const line = accounts.get(key) ?? { key, agent: r.agent, account, label: accountLabel, sessions: 0, activeMs: 0, usage: emptyUsage() };
        line.sessions++; line.activeMs += activeMs; if (used) addUsage(line.usage, used);
        accounts.set(key, line);
      }
      sessions.push({ id:r.sid, label:r.label, nodeId:r.node, projectId:this.project(ctx, r.node), teamKey:r.team ? `${r.node}:${r.team}` : null,
        agent:r.agent, role:r.role, alive:!!live, state:live?.state ?? null, attention:live?.attention ?? null, since:live?.since ?? null, turnSource:null,
        account, accountLabel, activeMs, usage: used, metrics:g.metrics });
    }
    // Squads that worked in the period (a session of theirs, or tasks on their board), with their tasks by status now.
    const teams: StatsTeam[] = [];
    for (const nodeId of new Set(rows.map(r => r.node))) {
      const projectId = this.project(ctx,nodeId);
      for (const t of [...ctx.teams.teams(nodeId), {id:'brain', name:'Main Brain'}]) {
        const key = `${nodeId}:${t.id}`;
        if (!projectOk(projectId) || (filters.team && filters.team !== key) || (filters.session && !sessions.some(s => s.id === filters.session && s.teamKey === key))) continue;
        const board = ctx.teams.get(nodeId,t.id);
        const mine = board.tasks.filter(task => !filters.session || task.assignedTo === filters.session);
        const members = rows.some(r => r.node === nodeId && r.team === t.id);
        if (!members && !mine.length) continue;
        const lead = rows.find(r => r.node === nodeId && r.team === t.id && (r.role === 'brain' || r.role === 'orchestrator') && this.live.has(r.sid));
        const count = (status: string) => mine.filter(task => task.status === status).length;
        teams.push({ key, id:t.id, name:t.name, nodeId, projectId, recipient:lead?.label ?? null,
          blockedTasks:count('blocked'), tasks:{ pending:count('pending'), working:count('working'), blocked:count('blocked'), done:count('done') } });
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
      projects, teams, sessions, totals:finish(totals,observedMs), usage, usageMissing,
      quality:this.quality(ctx, rows, sessions, accepts, Boolean(filters.project || filters.team || filters.session), from, now, timeline),
      timeline:{ ...timeline, tokens:[...tokenSeries.values()].sort((a, b) => b.values.reduce((x, y) => x + y, 0) - a.values.reduce((x, y) => x + y, 0)) },
      accounts:[...accounts.values()].sort((a, b) => a.agent.localeCompare(b.agent) || Number(!!a.account) - Number(!!b.account) || (a.label ?? '').localeCompare(b.label ?? '')),
      unattributedHttp };
  }
}
