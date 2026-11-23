// One colour language for roles and run state, shared by the map, the rail and the terminal headers.
// Pure: no DOM, `now` injectable. The tone is also a shape and a word in the UI, never colour alone.
import { t as tr, ui } from './i18n.ts';

export type SessionTone = 'orchestrator' | 'active' | 'idle' | 'blocked' | 'attention' | 'stale' | 'ended';

export interface ToneSession {
  alive: boolean; role?: string; workState?: string; idleSince?: number;
  stateSource?: string; stateAt?: number; noticeSentAt?: number; noticeConfirmed?: boolean; lastOutputAt?: number; lastInputAt?: number; attention?: string;
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

/** The rail's state filters: «Tutti», «Attivi» (working now), «Per te» (waits on the person), «Chiusi». Pure. */
export type RailFilter = 'all' | 'active' | 'needs' | 'ended';
export function inRailFilter(filter: string, s: ToneSession, now = Date.now()): boolean {
  if (filter === 'all') return true;
  const state = sessionTone(s, now) ?? (s.alive ? 'terminal' : 'ended');
  if (filter === 'needs') return state === 'attention' || state === 'blocked';
  if (filter === 'active') return state === 'active' || (state === 'orchestrator' && sessionWorking(s, now));
  return state === filter;
}
/** How many sessions each rail filter shows. Pure. */
export function railCounts(list: ToneSession[], now = Date.now()): Record<RailFilter, number> {
  const count = (f: RailFilter) => list.filter(s => inRailFilter(f, s, now)).length;
  return { all: list.length, active: count('active'), needs: count('needs'), ended: count('ended') };
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
      if (s.noticeSentAt !== undefined) return s.noticeConfirmed ? tr('Eventi confermati dal client') : tr('Avviso inviato al terminale');
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

/** A squad as the role menu needs it: its name and the code of its live orchestrator, if any. */
export interface RoleSquad { id: string; name: string; orchestrator: string | null }
export interface RoleChoice { value: string; label: string; group?: string; selected?: boolean; disabled?: boolean }
type RoleSession = { agent: string; role?: string; code?: string; teamId?: string; inner?: string };

/**
 * The entries of a session's role menu: each role in each squad of the node («Orchestratore» taken by another session is
 * shown but not offered), and «Nessun ruolo». The value is "role@squad" or "none". Pure.
 */
export function roleChoices(s: RoleSession, squads: RoleSquad[]): RoleChoice[] {
  const many = squads.length > 1;
  const out: RoleChoice[] = [];
  if (!s.role) out.push({ value: '', label: s.agent === 'shell' ? tr('Aggiungi alla squadra…') : tr('Nessun ruolo'), selected: true, disabled: true });
  for (const q of squads) for (const r of ['orchestrator', 'operator', 'reviewer'] as const) {
    const taken = r === 'orchestrator' && !!q.orchestrator && q.orchestrator !== s.code;
    out.push({
      value: `${r}@${q.id}`, label: ROLE_WORDS[r] + (taken ? ` · ${q.orchestrator}` : ''),
      ...(many ? { group: q.name } : {}), ...(s.role === r && s.teamId === q.id ? { selected: true } : {}), ...(taken ? { disabled: true } : {}),
    });
  }
  if (s.role) out.push({ value: 'none', label: tr('Nessun ruolo') });
  return out;
}

/** What a menu value asks the server for. Pure. */
export function parseRoleChoice(value: string): { role: 'orchestrator' | 'operator' | 'reviewer' | null; teamId?: string } | null {
  if (value === 'none') return { role: null };
  const m = /^(orchestrator|operator|reviewer)@([\w-]+)$/.exec(value);
  return m ? { role: m[1] as 'orchestrator' | 'operator' | 'reviewer', teamId: m[2] } : null;
}

/** "Revisore · Bacheca" for a queued change (the squad named only when the node has more than one). Pure. */
export function roleTargetLabel(change: { role: string | null; teamId?: string }, squads: RoleSquad[]): string {
  if (!change.role) return tr('Nessun ruolo');
  const word = ROLE_WORDS[change.role as keyof typeof ROLE_WORDS] ?? change.role;
  const squad = squads.length > 1 ? squads.find(q => q.id === change.teamId)?.name : undefined;
  return squad ? `${word} · ${squad}` : word;
}

const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** Whether a session's role can be changed while it works: Claude Code and Codex in a node, or a plain terminal running one. Pure. */
export function roleChangeable(s: { alive: boolean; nodeId?: number | null; agent: string; role?: string; inner?: string }): boolean {
  return s.alive && s.nodeId != null && s.role !== 'brain' && (s.agent === 'claude' || s.agent === 'codex' || (s.agent === 'shell' && !!s.inner));
}

/**
 * The role line under a session's rail row: the menu, then what is happening — a change waiting for the end of the
 * turn (with «Subito» and «Annulla»), why one failed, or that the agent was started by hand. Pure.
 */
export function roleLineHtml(s: RoleSession & { id: string; name?: string; roleChange?: { role: string | null; teamId?: string; state: string; message?: string } }, squads: RoleSquad[]): string {
  const change = s.roleChange, waiting = change?.state === 'waiting';
  let options = '', group: string | undefined;
  for (const c of roleChoices(s, squads)) {
    if (c.group !== group) { options += (group !== undefined ? '</optgroup>' : '') + (c.group !== undefined ? `<optgroup label="${escape(c.group)}">` : ''); group = c.group; }
    options += `<option value="${escape(c.value)}"${c.selected ? ' selected' : ''}${c.disabled ? ' disabled' : ''}>${escape(c.label)}</option>`;
  }
  if (group !== undefined) options += '</optgroup>';
  let state = '', tone = '', actions = '';
  if (waiting) {
    state = `→ ${escape(roleTargetLabel(change!, squads))} · ${tr('alla fine del turno')}`;
    actions = `<button type="button" class="work-model-act" data-role-now="${escape(s.id)}" title="${tr('Interrompe il turno e riavvia subito con il nuovo ruolo')}">${tr('Subito')}</button><button type="button" class="work-model-act" data-role-cancel="${escape(s.id)}">${tr('Annulla')}</button>`;
  } else if (change?.state === 'failed') { state = escape(tr(change.message ?? 'Cambio non riuscito')); tone = ' warn'; }
  else if (s.agent === 'shell') state = s.inner === 'codex' ? tr('Codex avviato a mano') : tr('Claude Code avviato a mano');
  const name = s.code ?? s.name ?? s.id;
  return `<div class="work-model work-role"><select data-role-select="${escape(s.id)}" aria-label="${tr('Ruolo di')} ${escape(name)}" title="${tr('Il cambio di ruolo riavvia la conversazione con le nuove istruzioni, alla fine del turno')}"${waiting ? ' disabled' : ''}>${options}</select><span class="work-model-state${tone}">${state}</span>${actions}</div>`;
}
