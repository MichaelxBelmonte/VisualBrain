// One colour language for roles and run state, shared by the map, the rail and the terminal headers.
// Pure: no DOM, `now` injectable. The tone is also a shape and a word in the UI, never colour alone.
import { t as tr, ui } from './i18n.ts';

export type SessionTone = 'orchestrator' | 'active' | 'idle' | 'blocked' | 'attention' | 'stale' | 'ended';

export interface ToneSession {
  alive: boolean; role?: string; workState?: string; idleSince?: number;
  stateSource?: string; stateAt?: number; lastOutputAt?: number; lastInputAt?: number; attention?: string;
}

/** Meaningful terminal output this recent means the agent is working, whatever it declares. */
export const BUSY_WINDOW_MS = 10_000;
/** A "working" claim with no state change, input or output for this long is shown as stale. */
export const STALE_AFTER_MS = 2 * 60_000;

/** What the session is actually doing, combining what it declares with what the server observes. */
type Activity = 'ended' | 'attention' | 'blocked' | 'busy' | 'working' | 'stale' | 'idle' | 'running';

const age = (at: number | undefined, now: number) => (at === undefined ? Infinity : Math.max(0, now - at));

function activity(s: ToneSession, now: number): Activity {
  if (!s.alive) return 'ended';
  if (s.attention) return 'attention';
  if (s.workState === 'blocked') return 'blocked';
  // Hooks are authoritative: a turn that ended after the last busy output is not hidden by that output.
  const hookEnded = s.stateSource === 'hook' && s.workState !== 'working' && s.stateAt !== undefined && s.lastOutputAt !== undefined && s.stateAt >= s.lastOutputAt;
  // A hook "working" alone is not proof: an Esc interrupt fires no Stop hook. It counts only when the server observes no output at all.
  if ((age(s.lastOutputAt, now) <= BUSY_WINDOW_MS && !hookEnded) || (s.stateSource === 'hook' && s.workState === 'working' && s.lastOutputAt === undefined)) return 'busy';
  if (s.workState === 'working') {
    const seen = [s.stateAt, s.lastInputAt, s.lastOutputAt].filter((v): v is number => v !== undefined);
    // An older server sends none of these: trust the claim, as before.
    return !seen.length || age(Math.max(...seen), now) < STALE_AFTER_MS ? 'working' : 'stale';
  }
  return s.workState === 'idle' ? 'idle' : 'running';
}

/**
 * ended when terminated; attention (any role) when it waits for the person; the orchestrator otherwise keeps its fixed colour;
 * blocked when stuck; active while observably busy or while a "working" claim is recent; stale when the claim has gone silent;
 * idle while waiting. A plain terminal has no role: null (neutral look).
 */
export function sessionTone(s: ToneSession, now = Date.now()): SessionTone | null {
  if (!s.role) return null;
  const a = activity(s, now);
  if (a === 'ended' || a === 'attention') return a;
  if (s.role === 'orchestrator' || s.role === 'brain') return 'orchestrator';
  if (a === 'blocked' || a === 'stale' || a === 'idle') return a;
  return 'active';
}

/** True for observed or recent work, including an orchestrator; idle and stale claims do not animate channels. */
export function sessionWorking(s: ToneSession, now = Date.now()): boolean {
  const state = activity(s, now); return state === 'busy' || state === 'working';
}

export const TONES: SessionTone[] = ['orchestrator', 'active', 'idle', 'blocked', 'attention', 'stale', 'ended'];

const ago = (ms: number) => (ms < 60_000 ? ui`${Math.floor(ms / 1000)} s fa` : ui`${Math.floor(ms / 60_000)} min fa`);

/** Short explanation of the light, for tooltips and the terminal header. */
export function toneReason(s: ToneSession, now = Date.now()): string {
  const a = activity(s, now);
  const output = age(s.lastOutputAt, now);
  switch (a) {
    case 'ended': return tr('Terminato');
    case 'attention': return s.attention === 'permission' ? tr('Serve un permesso nel terminale') : tr('C’è una domanda nel terminale');
    case 'blocked': return tr('Bloccato');
    case 'busy':
    case 'working': return output < Infinity ? ui`Al lavoro · attività ${ago(output)}` : tr('Al lavoro');
    case 'stale': {
      const minutes = Math.floor(age(Math.max(...[s.stateAt, s.lastInputAt, s.lastOutputAt].filter((v): v is number => v !== undefined)), now) / 60_000);
      return ui`Nessuna attività da ${minutes} min`;
    }
    case 'idle': {
      const minutes = s.idleSince === undefined ? 0 : Math.floor(age(s.idleSince, now) / 60_000);
      return minutes >= 1 ? ui`In attesa da ${minutes} min` : tr('In attesa');
    }
    default: return tr('In esecuzione');
  }
}

/** A visible word next to the tones that colour and shape alone would undersell; '' for the others. */
export function toneFlag(tone: SessionTone | null, session?: ToneSession): string {
  return tone === 'attention' ? (session?.attention === 'permission' ? tr('Permesso richiesto') : tr('Da rispondere')) : tone === 'blocked' ? tr('Bloccato') : tone === 'stale' ? tr('Inattivo') : '';
}

/** Whole minutes an operator / reviewer has been waiting with nothing to do; null when it is not idle or only just became so. */
export function idleMinutes(s: ToneSession, now = Date.now()): number | null {
  if (!s.role || s.role === 'orchestrator' || s.role === 'brain' || s.idleSince === undefined || activity(s, now) !== 'idle') return null;
  const minutes = Math.floor((now - s.idleSince) / 60_000);
  return minutes >= 1 ? minutes : null;
}

/** Role names for every view: the Main Brain sits above the orchestrators of a node's squads. */
export const ROLE_WORDS: Record<'orchestrator' | 'operator' | 'reviewer' | 'brain', string> = { orchestrator: tr('Orchestratore'), operator: tr('Operatore'), reviewer: tr('Revisore'), brain: 'Main Brain' };
const roleWords: Record<string, string> = ROLE_WORDS;
/**
 * "Operatore 3" for the session coded OP3. The number comes from the code the server assigns once, so the rail, the
 * terminal header, the board and the agents' messages agree. Sessions started before codes existed fall back to `position`.
 */
export function roleName(s: { role?: string; code?: string }, position = ''): string {
  if (!s.role) return '';
  const number = s.role === 'orchestrator' || s.role === 'brain' ? '' : s.code?.match(/\d+$/)?.[0] ?? position;
  return roleWords[s.role] + (number ? ' ' + number : '');
}

/** Session codes as written by the agents (OP3, REV1, ORC1) inside a line of terminal output. */
export const CODE_IN_TEXT = /\b(?:ORC|OP|REV|BRAIN)\d{1,4}\b/g;

/** Ended sessions "Riprendi" can start again: Claude with its conversation id, Codex (found in its own records), a plain shell. */
export function resumable(s: { alive: boolean; agent: string; resumeId?: string }): boolean {
  return !s.alive && (s.agent === 'shell' || s.agent === 'codex' || (s.agent === 'claude' && Boolean(s.resumeId)));
}
