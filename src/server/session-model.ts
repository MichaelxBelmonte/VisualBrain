// The model a session really uses, read from the agent CLI's own records, never from what Visual Brain asked for:
// Claude Code's transcript (each answer names its model; a model command leaves its confirmation) and Codex's rollout
// (each turn records its model and effort; a settings change is recorded when it is applied). Read-only, local files.
import { closeSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { TerminalInfo } from '../shared/types.ts';
import { findCodexSession, findCodexSessionOf } from './launch.ts';

export interface ModelRecord {
  /** Model of the last turn the provider answered (Claude: model id; Codex: model slug). */
  now?: string;
  nowEffort?: string;
  /** Model the CLI confirmed for the next turn, when it differs from the last turn's or no turn has run since. */
  next?: string;
  nextEffort?: string;
  /** Changes whenever the CLI records a new selection: lets a caller wait for the confirmation of its own request. */
  mark: string;
}

const TAIL_BYTES = 4 * 1024 * 1024;
const MISSING_FOR_MS = 5_000, GUESS_FOR_MS = 15_000, LAUNCH_WINDOW_MS = 11 * 60_000, WALK_EVERY_MS = 60_000;

function tail(file: string, size: number): { text: string; start: number } {
  const start = Math.max(0, size - TAIL_BYTES);
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    const read = readSync(fd, buf, 0, buf.length, start);
    // A tail starts in the middle of a line: that first piece is not a record. Offsets stay those of the file.
    const skip = start > 0 ? buf.indexOf(10) + 1 : 0;
    return { text: buf.toString('utf8', skip, read), start: start + skip };
  } finally { closeSync(fd); }
}

/** Claude Code: `Set model to …` is the command's own output; an answer after it has used that model. */
export function claudeRecord(text: string, offset = 0): ModelRecord {
  let now: string | undefined, next: string | undefined, mark = '', at = offset;
  for (const line of text.split('\n')) {
    const here = at; at += Buffer.byteLength(line) + 1;
    const answer = line.includes('"type":"assistant"'), command = line.includes('<local-command-stdout>Set model to');
    if (!answer && !command) continue;
    let d: any;
    try { d = JSON.parse(line); } catch { continue; }
    if (d?.type === 'assistant' && typeof d.message?.model === 'string' && d.message.model !== '<synthetic>' && !d.isSidechain) { now = d.message.model; next = undefined; continue; }
    if (d?.type !== 'user') continue;
    const content = typeof d.message?.content === 'string' ? d.message.content : Array.isArray(d.message?.content) ? d.message.content.map((c: any) => c?.text ?? '').join('') : '';
    const m = /<local-command-stdout>Set model to `?([^`<\n]+?)`?(?: for this session only| and saved[^<]*)?<\/local-command-stdout>/.exec(content);
    if (m) { next = m[1].trim(); mark = String(here); }
  }
  return { now, next, mark };
}

/** Codex: `turn_context` is the turn as it ran; `thread_settings_applied` is the selection, recorded when it is made. */
export function codexRecord(text: string, offset = 0): ModelRecord {
  let now: string | undefined, nowEffort: string | undefined, next: string | undefined, nextEffort: string | undefined, mark = '', at = offset;
  for (const line of text.split('\n')) {
    const here = at; at += Buffer.byteLength(line) + 1;
    const turn = line.includes('"type":"turn_context"'), settings = line.includes('"thread_settings_applied"');
    if (!turn && !settings) continue;
    let d: any;
    try { d = JSON.parse(line); } catch { continue; }
    const p = d?.payload;
    if (d?.type === 'turn_context' && typeof p?.model === 'string') { now = p.model; nowEffort = typeof p.effort === 'string' ? p.effort : undefined; next = nextEffort = undefined; }
    else if (d?.type === 'event_msg' && p?.type === 'thread_settings_applied' && typeof p.thread_settings?.model === 'string') {
      next = p.thread_settings.model; nextEffort = typeof p.thread_settings.reasoning_effort === 'string' ? p.thread_settings.reasoning_effort : undefined;
      mark = String(here);
    }
  }
  return { now, nowEffort, next, nextEffort, mark };
}

/** A selection equal to what the last turn already used says nothing new. */
function settle(r: ModelRecord, same: (a: string, b: string) => boolean): ModelRecord {
  if (r.next !== undefined && r.now !== undefined && same(r.next, r.now) && (r.nextEffort ?? r.nowEffort) === r.nowEffort) return { ...r, next: undefined, nextEffort: undefined };
  return r;
}

/** "claude-sonnet-5-5" and the picker's "Sonnet 5.5" are the same model. */
export function claudeLabel(model: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?![\d])/.exec(model);
  if (!m) return model;
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? '.' + m[3] : ''}`;
}
const sameClaude = (a: string, b: string) => claudeLabel(a).toLowerCase() === claudeLabel(b).toLowerCase();

const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };

/** Claude Code files a conversation under its folder's name; `everywhere` also looks in the other folders (a session
 *  whose folder is known to the CLI under another path), which costs a walk of them all. */
function claudeTranscript(info: TerminalInfo, everywhere: boolean): string | undefined {
  if (!info.resumeId) return undefined;
  const projects = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects'), name = `${info.resumeId}.jsonl`;
  const direct = join(projects, real(info.cwd).replace(/[^a-zA-Z0-9]/g, '-'), name);
  if (statSync(direct, { throwIfNoEntry: false })?.isFile()) return direct;
  if (!everywhere) return undefined;
  let dirs: string[];
  try { dirs = readdirSync(projects); } catch { return undefined; }
  for (const dir of dirs) { const file = join(projects, dir, name); if (statSync(file, { throwIfNoEntry: false })?.isFile()) return file; }
  return undefined;
}

function codexRollout(id: string, createdAt: number): string | undefined {
  const home = process.env.CODEX_HOME || join(homedir(), '.codex');
  for (const offset of [0, -1, 1]) {
    const day = new Date(createdAt + offset * 86_400_000);
    const dir = join(home, 'sessions', String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    const name = names.find(n => n.startsWith('rollout-') && n.endsWith(`-${id}.jsonl`));
    if (name) return join(dir, name);
  }
  return undefined;
}

interface Cached { file?: string; missingAt?: number; size?: number; mtimeMs?: number; record?: ModelRecord; codexId?: string; sure?: boolean; guessedAt?: number; walkedAt?: number }
const cache = new Map<string, Cached>();

/** Sessions that ended for good: nothing is kept for them. */
export function forgetSessionModel(id: string): void { cache.delete(id); }

/**
 * The record of a session, or undefined when the CLI keeps none we can find (another agent, a conversation not started
 * yet). The file is parsed again only when it changed; `claimed` are the Codex conversations bound to other sessions.
 * A record that was missing is looked for again after a few seconds, or at once with `fresh` (a change waiting for it).
 */
export function sessionModel(info: TerminalInfo, claimed: () => Set<string> = () => new Set(), now = Date.now(), fresh = false): ModelRecord | undefined {
  if (info.agent !== 'claude' && info.agent !== 'codex') return undefined;
  const c = cache.get(info.id) ?? {};
  cache.set(info.id, c);
  // A Codex conversation found only by folder and time is a guess while other sessions may have started beside it:
  // it is looked for again until Codex has recorded the opening message that names this session.
  if (info.agent === 'codex' && c.file && !c.sure && now - (c.guessedAt ?? 0) > (fresh ? 1_000 : GUESS_FOR_MS) && now - info.createdAt < LAUNCH_WINDOW_MS) c.file = undefined;
  if (!c.file) {
    if (!fresh && c.missingAt !== undefined && now - c.missingAt < MISSING_FOR_MS) return undefined;
    if (info.agent === 'claude') {
      const walk = now - (c.walkedAt ?? 0) > WALK_EVERY_MS;
      if (walk) c.walkedAt = now;
      c.file = claudeTranscript(info, walk);
    }
    else {
      const own = info.resumeId ?? findCodexSessionOf(info.id, info.cwd, info.createdAt);
      if (own) { if (own !== c.codexId) c.record = undefined; c.codexId = own; c.sure = true; }
      else {
        const taken = claimed();
        for (const [id, other] of cache) if (id !== info.id && other.sure && other.codexId) taken.add(other.codexId);
        const guess = findCodexSession(info.cwd, info.createdAt, taken);
        if (guess !== c.codexId) c.record = undefined;
        c.codexId = guess; c.guessedAt = now;
      }
      c.file = c.codexId ? codexRollout(c.codexId, info.createdAt) : undefined;
    }
    if (!c.file) { c.missingAt = now; return undefined; }
    c.size = undefined;
  }
  const stat = statSync(c.file, { throwIfNoEntry: false });
  if (!stat) { c.file = undefined; c.record = undefined; c.missingAt = now; return undefined; }
  if (c.record && stat.size === c.size && stat.mtimeMs === c.mtimeMs) return c.record;
  try {
    const { text, start } = tail(c.file, stat.size);
    c.record = info.agent === 'claude' ? settle(claudeRecord(text, start), sameClaude) : settle(codexRecord(text, start), (a, b) => a === b);
    c.size = stat.size; c.mtimeMs = stat.mtimeMs;
  } catch { /* being written: the previous reading stays */ }
  return c.record;
}
