import type { ApiCtx } from './api.ts';
import type { TerminalInfo } from '../shared/types.ts';
import { noticeInput, noticeInputBlocked, noteInjected } from './activity.ts';
import { notificationCursor } from './work-cursors.ts';

/** Single place that changes a session's work state, so idleSince, stateSource and stateAt always match it. */
export function setWorkState(info: TerminalInfo, state: 'working' | 'idle' | 'blocked', source: NonNullable<TerminalInfo['stateSource']> = 'agent', now = Date.now()): void {
  if (state !== 'idle') {
    delete info.noticeSentAt;
    delete info.noticeConfirmed;
  }
  if (state === 'idle') { if (info.workState !== 'idle' || info.idleSince === undefined) info.idleSince = now; } else info.idleSince = undefined;
  info.workState = state;
  info.stateSource = source;
  info.stateAt = now; // every report is fresh evidence, even when the state does not change
}

/** A session declared working that shows no sign of life for this long has stopped (API error, Esc, a turn that never reported idle). */
export const QUIET_AFTER_MS = 3 * 60_000;

export function markNoticeConfirmed(ctx: ApiCtx, id: string, through: number, reconciledGap: boolean): void {
  const t = ctx.terms.get(id);
  if (!t || t.info.noticeSentAt === undefined || !t.injectedMessage || through < t.injectedMessage) return;
  if (reconciledGap) {
    delete t.info.noticeSentAt;
    delete t.info.noticeConfirmed;
  } else t.info.noticeConfirmed = true;
}

/** Declared working, but silent: no output, input or state report for QUIET_AFTER_MS and not waiting for the person. */
export function isQuiet(info: TerminalInfo, now = Date.now()): boolean {
  // only agents whose activity the server can see (busy title / spinner); hermes and agy may think silently for minutes
  if (info.workState !== 'working' || info.attention || info.stateSource === undefined || (info.agent !== 'claude' && info.agent !== 'codex')) return false;
  return now - Math.max(info.stateAt ?? info.createdAt, info.lastOutputAt ?? 0, info.lastInputAt ?? 0) >= QUIET_AFTER_MS;
}

// Never inject messages into a shell or an agent that is busy, and never announce the same messages twice: an agent that
// cannot read the board (e.g. 403) would otherwise be re-prompted after every turn (Stop hook → idle). A session stuck at
// "working" but silent counts as free, so a turn lost to an error does not block its messages forever. `manual` is the
// person's own request from the UI: it repeats an announcement the agent may have missed.
export function wakeSession(ctx: ApiCtx, id: string, opts: { manual?: boolean; now?: number } = {}): boolean {
  const t = ctx.terms.get(id);
  const nodeId = t?.info.nodeId;
  if (!t?.info.alive || nodeId == null || !t.info.role || noticeInputBlocked(t.activity, t.info)) return false;
  if (t.info.workState !== 'idle' && !isQuiet(t.info, opts.now)) return false;
  const now = opts.now ?? Date.now();
  // each session reads its own board: its squad's, or the Main Brain's
  const team = ctx.teams.teamOf(nodeId, t.info);
  const board = ctx.teams.get(nodeId, team);
  const addressed = (msg: typeof board.messages[number]) => msg.from !== id && (!msg.to || msg.to === id);
  if (!opts.manual && !board.messages.some(msg => msg.id > (t.injectedMessage ?? 0) && addressed(msg))) return false;
  const seen = notificationCursor(ctx.cfg.dataDir, nodeId, team, id, t.seenMessage);
  // Coalesce further notices while the agent opens its board. A lost turn can be woken again for new mail.
  const noticeAt = t.info.noticeSentAt;
  if (!opts.manual && seen < t.injectedMessage && noticeAt !== undefined && (t.info.stateAt ?? -1) < noticeAt && now - noticeAt < QUIET_AFTER_MS) return false;
  const unread = board.messages.filter(msg => msg.id > seen && addressed(msg));
  // GET serves at most 50 messages. After a partial read the next batch still needs its own notice.
  const batch = unread.slice(0, 50);
  const last = batch.at(-1);
  if (!last || (!opts.manual && last.id <= (t.injectedMessage ?? 0))) return false;
  // Only project the board's task ID/status, never arbitrary message or held-result text into the PTY.
  const ref = /^(?:Incarico|Task|Completato|Done|Bloccato|Blocked) ([a-f0-9]{8})\b/.exec(last.text)?.[1];
  const task = ref ? board.tasks.find(task => task.id === ref && (t.info.role === 'orchestrator' || task.assignedTo === id || task.assignedTo === null)) : undefined;
  const notice = deliveryNotice(ctx.cfg, nodeId, id, task, batch.length, t.info.agent === 'codex' || t.info.agent === 'claude');
  if (ctx.terms.deliver) return ctx.terms.deliver(id, notice, last.id, now);
  noteInjected(t.activity, now);
  // where the token is, not the token: an agent whose first turn was lost (e.g. an API error) has no protocol in context
  t.proc.write(noticeInput(notice));
  t.injectedMessage = last.id;
  delete t.info.noticeConfirmed;
  t.info.noticeSentAt = now;
  return true;
}
export function deliveryNotice(cfg: { host: string; port: number; language?: string }, nodeId: number, id: string, task?: { id: string; status: string }, count = 1, mcp = false): string {
  const url = `http://${cfg.host}:${cfg.port}/api/work/${nodeId}?session=${id}`;
  const en = cfg.language === 'en';
  let change = en ? 'new messages' : 'nuovi messaggi';
  if (task) {
    const action = task.status === 'done' ? (en ? 'review handoff' : 'verifica consegna')
      : task.status === 'blocked' ? (en ? 'review blocker' : 'verifica blocco')
      : (en ? 'check assignment' : 'verifica incarico');
    change = `${task.id} · ${task.status} · ${action}`;
  }
  // A trailing $name opens Codex's skill picker, which consumes Enter instead of submitting the notice.
  return `Visual Brain · ${change}${count > 1 ? ' (+' + (count - 1) + ')' : ''}. ${mcp ? 'team_request {"operation":"read"} | ' : ''}Authorization: Bearer $VB_TEAM_TOKEN · GET ${url}`;
}
/** Announces new messages to the sessions of one board (a squad, the Main Brain), or of every board of the node. */
export function notifyTeam(ctx: ApiCtx, nodeId: number, team?: string): void {
  for (const t of ctx.terms.list()) if (t.nodeId === nodeId && t.role && (team === undefined || ctx.teams.teamOf(nodeId, t) === team)) wakeSession(ctx, t.id);
}
