import type { ApiCtx } from './api.ts';
import type { TerminalInfo } from '../shared/types.ts';
import { noteInjected } from './activity.ts';

/** Single place that changes a session's work state, so idleSince, stateSource and stateAt always match it. */
export function setWorkState(info: TerminalInfo, state: 'working' | 'idle' | 'blocked', source: NonNullable<TerminalInfo['stateSource']> = 'agent', now = Date.now()): void {
  if (state === 'idle') { if (info.workState !== 'idle' || info.idleSince === undefined) info.idleSince = now; } else info.idleSince = undefined;
  info.workState = state;
  info.stateSource = source;
  info.stateAt = now; // every report is fresh evidence, even when the state does not change
}

/** A session declared working that shows no sign of life for this long has stopped (API error, Esc, a turn that never reported idle). */
export const QUIET_AFTER_MS = 3 * 60_000;

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
  if (!t?.info.alive || nodeId == null || !t.info.role || t.info.attention || (t.activity?.draft && !opts.manual)) return false;
  if (t.info.workState !== 'idle' && !isQuiet(t.info, opts.now)) return false;
  // each session reads its own board: its squad's, or the Main Brain's
  const latest = ctx.teams.get(nodeId, ctx.teams.teamOf(nodeId, t.info)).messages.reduce((max, msg) => msg.id > t.seenMessage && msg.from !== id && (!msg.to || msg.to === id) ? Math.max(max, msg.id) : max, 0);
  if (!latest || (!opts.manual && latest <= (t.injectedMessage ?? 0))) return false;
  if (ctx.terms.deliver) return ctx.terms.deliver(id, deliveryNotice(ctx.cfg, nodeId, id), latest, Date.now());
  t.injectedMessage = latest;
  setWorkState(t.info, 'working', 'server');
  noteInjected(t.activity);
  // where the token is, not the token: an agent whose first turn was lost (e.g. an API error) has no protocol in context
  t.proc.write(`\x1b[200~${deliveryNotice(ctx.cfg, nodeId, id)}\x1b[201~`);
  setTimeout(() => { if (t.info.alive) t.proc.write('\r'); }, 150);
  return true;
}
export function deliveryNotice(cfg: { host: string; port: number; language?: string }, nodeId: number, id: string): string {
  const url = `http://${cfg.host}:${cfg.port}/api/work/${nodeId}?session=${id}`;
  return cfg.language === 'en'
    ? `Visual Brain: new messages on the node board. Read GET ${url} with the header Authorization: Bearer $VB_TEAM_TOKEN (environment variable of this terminal) and handle only your own task.`
    : `Visual Brain: nuovi messaggi nella bacheca del nodo. Leggi GET ${url} con l’header Authorization: Bearer $VB_TEAM_TOKEN (variabile d’ambiente di questo terminale) e gestisci soltanto il tuo incarico.`;
}
/** Announces new messages to the sessions of one board (a squad, the Main Brain), or of every board of the node. */
export function notifyTeam(ctx: ApiCtx, nodeId: number, team?: string): void {
  for (const t of ctx.terms.list()) if (t.nodeId === nodeId && t.role && (team === undefined || ctx.teams.teamOf(nodeId, t) === team)) wakeSession(ctx, t.id);
}
