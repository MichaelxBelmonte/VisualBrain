// What a terminal shows, whatever the agent reports: busy spinners, real output, prompts waiting for the person.
// Idle Claude Code still repaints a few cells (status line timer, "Checking for updates"), so only busy markers or a
// substantial amount of new text count as activity. Output is scanned at most every SCAN_EVERY_MS per terminal.
import type { TerminalInfo } from '../shared/types.ts';

export const SCAN_EVERY_MS = 250;
/** A resize makes the agent redraw its whole screen (old transcript included): only strong markers count meanwhile. */
export const QUIET_AFTER_RESIZE_MS = 2_000;
/** Echo of what the person types, or of the prompt the server pastes, is not activity. */
export const QUIET_AFTER_KEY_MS = 1_000;
export const SUBSTANTIAL_CHARS = 200;
const MAX_PENDING = 16_000;

export interface Activity {
  pending: string;           // raw output not scanned yet
  timer: NodeJS.Timeout | null;
  quietUntil: number;
  attentionAt?: number;      // since when info.attention is set
  draft?: boolean;           // the person typed something not sent yet: the server must not paste into it
  navigation?: 'history' | 'menu' | 'return'; // a recalled entry or another view may own Enter
  escapeArmed?: boolean;     // a second Esc can open the transcript/rewind view
  cliBusy?: boolean;         // last native CLI turn signal, independent of the board's reported state
}

export const newActivity = (): Activity => ({ pending: '', timer: null, quietUntil: 0, escapeArmed: false });

const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const STRING_SEQ = /\x1b[P^_][^\x1b]*\x1b\\/g;
const CURSOR_RIGHT = /\x1b\[\d*C/g;
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ESC = /\x1b[()*+][0-9A-Za-z]|\x1b[@-Z\\-_=>78]/g;
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;
const UNFINISHED = /\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*|[P^_][^\x1b]*|[()*+])?$/;

/** Plain text of terminal output: escape sequences removed, cursor jumps kept as a space so words stay apart. */
export function stripAnsi(s: string): string {
  return s.replace(OSC, '').replace(STRING_SEQ, '').replace(CURSOR_RIGHT, ' ').replace(CSI, '').replace(ESC, '')
    .replace(/\r\n?/g, '\n').replace(CONTROL, '');
}

// Most reliable: the window title. While a turn runs Claude Code alternates "◐ <topic>" / "◑ <topic>" every 960 ms and
// shows "✳ <topic>" when it waits, including while a permission dialog is open; Codex animates a braille spinner
// "⠋ <topic> | <dir>" about every 100 ms (whether it keeps spinning during an approval is unknown).
const TITLE = /\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
const CLAUDE_BUSY_TITLE = /^[\u25d0-\u25d3]/;
const BRAILLE_TITLE = /^[\u2800-\u28ff]/;
function lastTitle(raw: string): string | undefined {
  let last: string | undefined;
  for (const m of raw.matchAll(TITLE)) last = m[1];
  return last;
}
export function busyTitle(raw: string): boolean {
  const title = lastTitle(raw);
  return title !== undefined && (CLAUDE_BUSY_TITLE.test(title) || BRAILLE_TITLE.test(title));
}

export function observedTurn(raw: string, agent: TerminalInfo['agent']): boolean | undefined {
  if (agent === 'codex') {
    const states = raw.matchAll(/\x1b\]7501;state=(\w+):app=codex(?:\x07|\x1b\\)/g);
    let busy: boolean | undefined;
    for (const m of states) busy = m[1] !== 'idle' && m[1] !== 'done';
    return busy;
  }
  const title = agent === 'claude' ? lastTitle(raw) : undefined;
  if (title && CLAUDE_BUSY_TITLE.test(title)) return true;
  if (title?.startsWith('✳')) return false;
}

export function noticeInputBlocked(a: Activity | undefined, info: TerminalInfo): boolean {
  if (info.attention || a?.draft || a?.navigation) return true;
  const pending = a?.pending ?? '';
  return !!((observedTurn(pending, info.agent) ?? a?.cliBusy) || attentionIn(stripAnsi(pending.slice(composerEnd(pending, info.agent)))));
}

export function noticeInput(notice: string): string {
  return `\x1b[200~${notice}\x1b[201~\r`;
}

// Claude Code: spinner "✻ Manifesting… (3m 56s · ↓ 16.4k tokens · thinking with high effort)", repainted every ~100 ms
// while a turn runs, partially (glyph only, timer only). Codex: "• Working (1m 11s • esc to interrupt)" with a shimmer
// that rewrites "Working" letter by letter. None of these is drawn while the agent waits.
const CLAUDE_SPINNER = /\p{Lu}\p{Ll}+ing…|thinking with \w+ effort|[↓↑] ?[\d.,]+k? tokens/u;
const STRONG = /\p{Lu}\p{Ll}+ing…|thinking with \w+ effort|[↓↑] ?[\d.,]+k? tokens|Working \(\d/u;
const INTERRUPT = /esc to interrupt/i;
const WEAK = /[✢✳✶✻✽⏺]|Working/;
const NOISE = /※ ?recap|disable recaps|Checking for updates/;
const FILLER = /[\s─-▟✢✳✶✻✽⏺·•…❯›>|]/g;

export function busyMarker(text: string, quiet = false): boolean {
  return STRONG.test(text) || INTERRUPT.test(text) || (!quiet && WEAK.test(text));
}

/** A prompt waiting for the person: Claude and Codex permission dialogs, or a question with choices / free answer. */
// Only dialog layout counts: a highlighted numbered choice (❯ / › 1. …). The same words in the agent's prose, a diff or
// this very file must not stop deliveries.
const CHOICE = /[❯›] ?\d\. ?\S/;
export function attentionIn(text: string): TerminalInfo['attention'] | null {
  if (!CHOICE.test(text) && !/Enter to select/.test(text)) return null;
  if (/Do you want to [^?\n]{2,80}\?|[❯›] ?1\. ?Yes|Would you like to (?:run|make|grant)[^?\n]{0,60}\?|Yes, proceed|No, and tell (?:Claude|Codex) what to do/.test(text)) return 'permission';
  return 'input';
}

export function setAttention(a: Activity | undefined, info: TerminalInfo, value: TerminalInfo['attention'] | null, now = Date.now()): void {
  if (value) {
    if (!info.attention && a) a.attentionAt = now;
    info.attention = value;
  } else {
    delete info.attention;
    if (a) a.attentionAt = undefined;
  }
}

/** Queues raw output; returns true when a scan has to be scheduled. */
export function appendOutput(a: Activity, data: string): boolean {
  a.pending += data;
  if (a.pending.length > MAX_PENDING) a.pending = a.pending.slice(-MAX_PENDING);
  return a.timer === null;
}

export function scanOutput(a: Activity, info: TerminalInfo, now = Date.now()): void {
  let raw = a.pending;
  const cut = UNFINISHED.exec(raw.slice(-64));
  a.pending = cut ? cut[0] : '';
  if (cut) raw = raw.slice(0, raw.length - cut[0].length);
  const text = stripAnsi(raw);
  const turn = observedTurn(raw, info.agent);
  if (turn !== undefined) a.cliBusy = turn;
  const quiet = now < a.quietUntil;
  const title = lastTitle(raw) ?? '';
  // Claude's waiting title (✳) wins over spinner leftovers repainted in the same chunk as the end of the turn
  const busy = CLAUDE_BUSY_TITLE.test(title) || BRAILLE_TITLE.test(title) || (!title.startsWith('✳') && busyMarker(text, quiet));
  const substantial = !quiet && !NOISE.test(text) && text.replace(FILLER, '').length >= SUBSTANTIAL_CHARS;
  if (busy || substantial) info.lastOutputAt = now;
  // A fast Esc may close a selector inside this same scan. Only subsequent output can open a new one.
  const restored = composerEnd(raw, info.agent);
  if (restored && info.attention === 'input') setAttention(a, info, null, now);
  const found = attentionIn(restored ? stripAnsi(raw.slice(restored)) : text);
  if (quiet && !found) return;
  // Answered elsewhere (e.g. a hook approved it): Claude's turn resumes, or new text replaces the prompt. Codex's
  // spinners alone do not clear it, in case they keep running under the approval.
  if (found) setAttention(a, info, found, now);
  else if (info.attention && (CLAUDE_BUSY_TITLE.test(title) || CLAUDE_SPINNER.test(text) || substantial)) setAttention(a, info, null, now);
}

/** Input from the person's keyboard (the UI websocket); mouse reports and focus events are ignored. */
// Mouse reports, focus events and the terminal's automatic replies (cursor position, device attributes) are not keys.
const NOT_KEYS = /\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[M[\s\S]{3}|\x1b\[[IO]|\x1b\[\d+;\d+R|\x1b\[[?>][\d;]*c|\x1b\[\?[\d;]*\$y|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

const CURSOR_KEYS = /^(?:\x1b(?:\[[ABCDZ]|O[ABCD]))+$/;
const returnFrames = new WeakMap<Activity, string>();

// Only inspect a fresh repaint requested by a return gesture that started from an empty composer.
// The Codex placeholder is dim, at column 3, with the caret restored to that very row, column 3.
const CODEX_EMPTY = /\x1b\[(\d+);(?:3H|1H\x1b\[1m›\x1b\[22m )\x1b\[2mAsk Codex to do anything\x1b\[[\s\S]*?\x1b\[\1;3H\x1b\[\?25h$/;
// Claude restores the blank inverse-video cursor and the main session's agents shortcut.
const CLAUDE_EMPTY = /(?:\x1b\[7m \x1b\[27m\x1b\[K|❯\u00a0\x1b\[7m \r\x1b\[1B\x1b\[27m─)[^\n]*?←\x1b\[\d+Gfor\x1b\[\d+Gagents[^\n]*?\x1b\[\d+;3H$/;

/** End of a synchronized Codex frame that explicitly restores its empty input, or zero. */
function composerEnd(raw: string, agent: TerminalInfo['agent']): number {
  if (agent !== 'codex') return 0;
  const placeholder = raw.lastIndexOf('\x1b[2mAsk Codex to do anything');
  if (placeholder < 0) return 0;
  const start = Math.max(0, raw.lastIndexOf('\x1b[?2026h', placeholder));
  const finish = '\x1b[?2026l', end = raw.indexOf(finish, placeholder);
  return end >= 0 && CODEX_EMPTY.test(raw.slice(start, end)) ? end + finish.length : 0;
}

export function confirmComposerReturn(a: Activity, info: TerminalInfo, raw: string): boolean {
  // Esc may close a selector before the scan or host mirror has reported that it opened.
  const escaped = a.escapeArmed && !a.navigation && info.agent === 'codex';
  if ((!escaped && a.navigation !== 'return') || a.draft || info.attention === 'permission') return false;
  const frame = ((returnFrames.get(a) ?? '') + raw).slice(-16_000);
  const end = composerEnd(frame, info.agent);
  const confirmed = info.agent === 'codex'
    ? end > 0 && !stripAnsi(frame.slice(end)).trim()
    : info.agent === 'claude' && CLAUDE_EMPTY.test(frame.slice(Math.max(0, frame.lastIndexOf('\x1b[H'))));
  if (!confirmed) { returnFrames.set(a, frame); return false; }
  returnFrames.delete(a);
  delete a.navigation;
  if (info.attention === 'input') setAttention(a, info, null);
  return true;
}

function navigate(a: Activity, info: TerminalInfo, tail: string): boolean {
  const armed = a.escapeArmed;
  a.escapeArmed = false;
  if (info.attention && CURSOR_KEYS.test(tail)) return true;
  if (info.agent !== 'codex' && info.agent !== 'claude') return false;
  if (tail === '\x1b' || tail === '\x1b\x1b') {
    if (!a.draft) {
      if (a.navigation || info.attention) a.navigation = 'return';
      else if (armed || tail.length === 2) a.navigation = 'menu';
      else a.escapeArmed = true;
    }
    return true;
  }
  if (!CURSOR_KEYS.test(tail)) return false;
  if (!a.draft) for (const key of tail.match(/\x1b(?:\[|O)./g)!) {
    const direction = key.at(-1);
    if (direction === 'D' && !a.navigation) a.navigation = 'menu'; // Left opens the agents panel.
    if (direction === 'A' && a.navigation !== 'menu') a.navigation = 'history';
    if (direction === 'B' && a.navigation === 'history') a.navigation = 'return';
  }
  return true;
}

/** Returns true for a navigation-only suffix, so a backend can correct a pre-fix PTY host. */
export function noteInput(a: Activity, info: TerminalInfo, data: string, now = Date.now()): boolean {
  const keys = data.replace(NOT_KEYS, '');
  if (!keys) return false;
  a.quietUntil = Math.max(a.quietUntil, now + QUIET_AFTER_KEY_MS);
  const typed = keys.replace(/\x1b\[200~[\s\S]*?\x1b\[201~/g, 'x');
  if (!info.attention && a.pending) {
    const prompt = attentionIn(stripAnsi(a.pending.slice(composerEnd(a.pending, info.agent))));
    if (prompt) setAttention(a, info, prompt, now);
  }
  info.lastInputAt = now; // any key: the person is there, the session is not quiet
  // History navigation, completion and yank can populate an empty composer too.
  // Respect the order in a single write such as Enter followed by the start of a new draft.
  const end = Math.max(typed.lastIndexOf('\r'), typed.lastIndexOf('\x03'));
  const tail = typed.slice(end + 1);
  returnFrames.delete(a);
  if (end >= 0) {
    a.draft = false; a.escapeArmed = false;
    // Enter in a menu can restore an old prompt. A confirmed empty composer or explicit Ctrl-C releases it.
    if (typed[end] === '\r' && (a.navigation === 'menu' || a.navigation === 'return')) a.navigation = 'return';
    else delete a.navigation;
    if (info.attention) setAttention(a, info, null, now);
  }
  const navigation = !!tail && navigate(a, info, tail);
  if (tail && !navigation) { a.draft = true; delete a.navigation; }
  // Arrows move through the choices. Enter, Esc or Ctrl-C answer any prompt; a choice key (1-9, y, n, a) answers a
  // permission dialog only, since in a free answer box it is just the first letter of the reply.
  if (info.attention && (typed === '\x1b' || (info.attention === 'permission' && /^[1-9ynaYNA]$/.test(typed)))) setAttention(a, info, null, now);
  return navigation;
}

export function noteResize(a: Activity, now = Date.now()): void {
  a.quietUntil = Math.max(a.quietUntil, now + QUIET_AFTER_RESIZE_MS);
}

/** Text the server pastes itself (message delivery): its echo is not activity and not the person's input. */
export function noteInjected(a: Activity | undefined, now = Date.now()): void {
  if (a) { a.quietUntil = Math.max(a.quietUntil, now + QUIET_AFTER_KEY_MS); a.escapeArmed = false; }
}
