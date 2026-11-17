import type { ApiCtx } from './api.ts';
import type { TerminalInfo } from '../shared/types.ts';
import { isQuiet, wakeSession } from './team-delivery.ts';

export const IDLE_AFTER_MS = 90_000;
export const REMIND_EVERY_MS = 5 * 60_000;
/** Reminders for the same unchanged situation: then silence until it changes (new idle stretch, new backlog, sign of life). */
export const MAX_REMINDERS = 3;
/** A prompt left unanswered in the agent's terminal, and a working claim with no sign of life (output or input). */
export const ATTENTION_AFTER_MS = 2 * 60_000;
export const STALE_AFTER_MS = 10 * 60_000;
const TICK_MS = 30_000;
const SYSTEM = 'visual-brain';

/** Reminders already sent, per situation (session plus what would change it). */
export type Reminded = Map<string, { at: number; count: number; session: string }>;
const LAST = ' Ultimo avviso automatico: non ne arriveranno altri finché la situazione non cambia.';

const minutes = (ms: number) => Math.round(ms / 60_000) || 1;
/** The code the user sees, with the id the API also accepts. */
const name = (s: TerminalInfo) => s.code ? `${s.code} (${s.id})` : `${s.id} (${s.role})`;

/**
 * Local watchdog, no AI calls: an operator or reviewer that has been idle for a while with nothing assigned is either told to
 * take an unassigned task, or reported to the orchestrator, which is the one who decides what to hand out next. Sessions
 * waiting for the person in their terminal, or declared working (by the agent or by a delivery) but silent, are reported too.
 * Hook turns are checked too: Esc interrupts a turn without the Stop hook.
 */
export function checkIdle(ctx: ApiCtx, now = Date.now(), reminded: Reminded = new Map()): { nudged: string[]; reported: string[] } {
  const nudged: string[] = [], reported: string[] = [];
  // One squad at a time: its own board, its own orchestrator. The Main Brain is nobody's worker.
  const bySquad = new Map<string, { nodeId: number; team: string; sessions: TerminalInfo[] }>();
  for (const t of ctx.teams.withCodes(ctx.terms.list())) {
    if (!t.alive || t.nodeId == null || !t.role || t.role === 'brain') continue;
    const team = ctx.teams.teamOf(t.nodeId, t), key = `${t.nodeId}:${team}`;
    const entry = bySquad.get(key) ?? { nodeId: t.nodeId, team, sessions: [] };
    entry.sessions.push(t); bySquad.set(key, entry);
  }
  for (const { nodeId, team, sessions } of bySquad.values()) {
    const board = ctx.teams.get(nodeId, team);
    const open = board.tasks.filter(t => t.status !== 'done');
    const unassigned = open.filter(t => t.assignedTo === null && t.status === 'pending');
    // Each reminder of the same situation waits twice as long as the previous one, and after MAX_REMINDERS there are no more.
    const due = (key: string) => { const r = reminded.get(key); return !r || (r.count < MAX_REMINDERS && now - r.at >= REMIND_EVERY_MS * 2 ** (r.count - 1)); };
    const mark = (key: string, session: string) => reminded.set(key, { at: now, count: (reminded.get(key)?.count ?? 0) + 1, session });
    const last = (keys: string[]) => keys.every(k => (reminded.get(k)?.count ?? 0) + 1 >= MAX_REMINDERS) ? LAST : '';
    const lastSign = (s: TerminalInfo) => Math.max(s.stateAt ?? s.createdAt ?? 0, s.lastOutputAt ?? 0, s.lastInputAt ?? 0);
    // messages queued for a session that went quiet while declared working (its turn ended without reporting idle)
    for (const s of sessions) if (isQuiet(s, now)) wakeSession(ctx, s.id, { now });
    const orchestrator = sessions.find(s => s.role === 'orchestrator');
    const workers = sessions.filter(s => s.role !== 'orchestrator');
    const attentionKey = (s: TerminalInfo) => `attention:${s.id}:${ctx.terms.get(s.id)?.activity?.attentionAt ?? ''}`;
    const staleKey = (s: TerminalInfo) => `stale:${s.id}:${lastSign(s)}`;
    // Not idleSince: answering a nudge without taking work starts a new idle stretch. Work on its own tasks, or a different backlog, is a change.
    const freeKey = (s: TerminalInfo) => `free:${s.id}:${Math.max(0, ...board.tasks.filter(t => t.assignedTo === s.id).map(t => t.updatedAt))}:${unassigned.length}`;
    const waiting = workers.filter(s => s.attention && now - (ctx.terms.get(s.id)?.activity?.attentionAt ?? now) >= ATTENTION_AFTER_MS && due(attentionKey(s)));
    // hook turns included: Esc interrupts a turn without the Stop hook, and then nothing else ever reports it
    // (sessions without stateSource predate the observation and are not judged)
    const stale = workers.filter(s => !s.attention && s.workState === 'working' && s.stateSource !== undefined && now - lastSign(s) >= STALE_AFTER_MS && due(staleKey(s)));
    if (orchestrator && (waiting.length || stale.length)) {
      const items = [
        ...waiting.map(s => `${name(s)} aspetta una risposta dell'utente nel suo terminale da ${minutes(now - (ctx.terms.get(s.id)?.activity?.attentionAt ?? now))} min`),
        ...stale.map(s => `${name(s)} dichiara al lavoro ma è fermo da ${minutes(now - lastSign(s))} min`),
      ];
      ctx.teams.message(nodeId, SYSTEM, orchestrator.id, `Sessioni da controllare: ${items.join('; ')}. Chi aspetta l'utente non riprende finché la persona non risponde nel suo terminale: segnalalo all'utente. Chi è fermo riceve di nuovo i messaggi in automatico (un solo avviso per gli stessi messaggi): se non riprende, l'utente deve scrivere nel suo terminale oppure riassegna il suo incarico.${last([...waiting.map(attentionKey), ...stale.map(staleKey)])}`, team);
      for (const s of waiting) { mark(attentionKey(s), s.id); reported.push(s.id); }
      for (const s of stale) { mark(staleKey(s), s.id); reported.push(s.id); }
      wakeSession(ctx, orchestrator.id);
    }
    // Idle by its own report but visibly busy (e.g. the person is driving it), or waiting for the person: not free.
    const free = workers.filter(s => s.workState === 'idle' && s.idleSince !== undefined && now - s.idleSince >= IDLE_AFTER_MS && !s.attention
      && now - Math.max(s.lastOutputAt ?? 0, s.lastInputAt ?? 0) >= IDLE_AFTER_MS && !open.some(t => t.assignedTo === s.id) && due(freeKey(s)));
    if (!free.length) continue;
    if (unassigned.length) {
      for (const s of free.slice(0, unassigned.length)) {
        ctx.teams.message(nodeId, SYSTEM, s.id, `Ci sono ${unassigned.length} incarichi non assegnati e sei libero: leggi la bacheca, rivendica un incarico adatto (PATCH status "working") e portalo a termine.${last([freeKey(s)])}`, team);
        mark(freeKey(s), s.id); nudged.push(s.id); wakeSession(ctx, s.id);
      }
      continue;
    }
    if (!orchestrator) continue;
    const list = free.map(s => `${name(s)} libera da ${minutes(now - s.idleSince!)} min`).join(', ');
    ctx.teams.message(nodeId, SYSTEM, orchestrator.id, `Sessioni libere senza incarico: ${list}. Nessun incarico in coda: scomponi il lavoro rimasto e assegna a ciascuna un incarico mirato (POST /tasks con assignedTo), oppure affida verifica, test o revisione di quanto già fatto. Se il lavoro è finito, lasciale libere.${last(free.map(freeKey))}`, team);
    for (const s of free) { mark(freeKey(s), s.id); reported.push(s.id); }
    wakeSession(ctx, orchestrator.id);
  }
  // Situations of sessions that ended are forgotten; those still open keep their count, so silence lasts.
  const alive = new Set(ctx.terms.list().filter(t => t.alive).map(t => t.id));
  for (const [key, r] of reminded) if (!alive.has(r.session)) reminded.delete(key);
  return { nudged, reported };
}

export function startTeamWatch(ctx: ApiCtx): () => void {
  const reminded: Reminded = new Map();
  const timer = setInterval(() => { try { checkIdle(ctx, Date.now(), reminded); } catch { /* the watchdog never stops the server */ } }, TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
