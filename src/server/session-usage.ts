// What a session did, from the agent CLI's own records: the person's requests (turns) and the tokens of the answers.
// Claude Code writes each answer with its usage in the transcript (one answer may span several lines with the same
// message id: counted once); Codex writes a running total (token_count) and each request in its rollout (task_started;
// older versions wrote user_message instead).
// Read-only, local files, read incrementally: only what was appended since the last read is parsed.
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import type { StatsUsage } from '../shared/mega-stats.ts';

interface Answer { at: number; input: number; output: number; cacheRead: number; cacheWrite: number; model: string | null }
interface Total { at: number; input: number; cached: number; output: number }
interface Parsed {
  offset: number; rest: string; size: number; mtimeMs: number;
  prompts: number[];
  /** Codex: one per request (task_started); when a record has none, its user_message events count instead. */
  starts: number[];
  answers: Map<string, Answer>;
  totals: Total[];
  models: { at: number; model: string }[];
}
const files = new Map<string, Parsed>();
const CHUNK = 4 * 1024 * 1024;

export const emptyUsage = (): StatsUsage => ({ turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, model: null });
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;

/** A request typed by the person (or sent by Visual Brain as the first prompt), not a tool result or a command echo. */
function claudePrompt(d: any): boolean {
  if (d?.type !== 'user' || d.isMeta || d.isSidechain || d.message?.role !== 'user') return false;
  const content = d.message.content;
  if (typeof content === 'string') return !content.startsWith('<');
  return Array.isArray(content) && !content.some((c: any) => c?.type === 'tool_result') && content.some((c: any) => c?.type === 'text' && typeof c.text === 'string' && !c.text.startsWith('<'));
}

function parseLine(p: Parsed, agent: 'claude' | 'codex', line: string): void {
  if (!line) return;
  let d: any;
  try { d = JSON.parse(line); } catch { return; }
  const at = Date.parse(d?.timestamp);
  if (!Number.isFinite(at)) return;
  if (agent === 'claude') {
    if (claudePrompt(d)) { p.prompts.push(at); return; }
    const m = d?.type === 'assistant' ? d.message : undefined, u = m?.usage;
    if (!u || m.model === '<synthetic>') return;
    // The last line of an answer carries its final usage: a later line with the same id replaces the earlier one.
    const id = typeof m.id === 'string' ? m.id : `${at}:${p.answers.size}`;
    const first = p.answers.get(id)?.at ?? at;
    p.answers.set(id, { at: first, input: num(u.input_tokens), output: num(u.output_tokens), cacheRead: num(u.cache_read_input_tokens), cacheWrite: num(u.cache_creation_input_tokens), model: typeof m.model === 'string' ? m.model : null });
    return;
  }
  const payload = d?.payload;
  if (d?.type === 'turn_context' && typeof payload?.model === 'string') p.models.push({ at, model: payload.model });
  if (d?.type !== 'event_msg') return;
  if (payload?.type === 'task_started') p.starts.push(at);
  else if (payload?.type === 'user_message') p.prompts.push(at);
  else if (payload?.type === 'token_count') {
    const t = payload.info?.total_token_usage;
    if (t) p.totals.push({ at, input: num(t.input_tokens), cached: num(t.cached_input_tokens), output: num(t.output_tokens) });
  }
}

/** Parses what was appended to the record since the last call; a file that shrank or was replaced is read again. */
function parsed(file: string, agent: 'claude' | 'codex'): Parsed | undefined {
  const stat = statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) { files.delete(file); return undefined; }
  let p = files.get(file);
  if (!p || stat.size < p.offset) {
    p = { offset: 0, rest: '', size: 0, mtimeMs: 0, prompts: [], starts: [], answers: new Map(), totals: [], models: [] };
    files.set(file, p);
  }
  if (stat.size === p.offset) return p;
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(CHUNK, stat.size - p.offset));
    while (p.offset < stat.size) {
      const n = readSync(fd, buf, 0, Math.min(buf.length, stat.size - p.offset), p.offset);
      if (n <= 0) break;
      p.offset += n;
      const text = p.rest + buf.toString('utf8', 0, n);
      const lines = text.split('\n');
      p.rest = lines.pop() ?? '';
      for (const line of lines) parseLine(p, agent, line);
    }
  } catch { /* unreadable now: keep what was read */ } finally { if (fd !== undefined) closeSync(fd); }
  p.size = stat.size; p.mtimeMs = stat.mtimeMs;
  return p;
}

/** Turns and tokens of a session's record within [from, to]; undefined when the record cannot be read. */
export function usageOf(file: string, agent: 'claude' | 'codex', from: number, to: number): StatsUsage | undefined {
  const p = parsed(file, agent);
  if (!p) return undefined;
  const inside = (at: number) => at >= from && at <= to;
  const usage = emptyUsage();
  usage.turns = (p.starts.length ? p.starts : p.prompts).filter(inside).length;
  if (agent === 'claude') {
    let last = -Infinity;
    for (const a of p.answers.values()) if (inside(a.at)) {
      usage.input += a.input; usage.output += a.output; usage.cacheRead += a.cacheRead; usage.cacheWrite += a.cacheWrite;
      if (a.model && a.at >= last) { last = a.at; usage.model = a.model; }
    }
    return usage;
  }
  // Codex keeps a running total: what the period used is its last total minus the last one before the period.
  const before = p.totals.filter(t => t.at < from).at(-1), end = p.totals.filter(t => t.at <= to).at(-1);
  if (end && end.at >= from) {
    const cached = end.cached - (before?.cached ?? 0), input = end.input - (before?.input ?? 0);
    usage.cacheRead = Math.max(0, cached); usage.input = Math.max(0, input - cached); usage.output = Math.max(0, end.output - (before?.output ?? 0));
  }
  usage.model = p.models.filter(m => m.at <= to).at(-1)?.model ?? null;
  return usage;
}

/** The interval holding `at` (binary search over the edges); -1 outside them. The last interval includes its end. */
export function bucketOf(edges: readonly number[], at: number): number {
  const last = edges.length - 1;
  if (last < 1 || at < edges[0] || at > edges[last]) return -1;
  let lo = 0, hi = last - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (edges[mid] <= at) lo = mid; else hi = mid - 1; }
  return lo;
}

/**
 * Requests and tokens (read + written) of a record per interval, in one pass over what is already parsed. Codex keeps a
 * running total: each total adds its difference from the previous one to its own interval, so the intervals sum to the
 * period's figure.
 */
export function usageBuckets(file: string, agent: 'claude' | 'codex', edges: readonly number[]): { turns: number[]; tokens: number[] } | undefined {
  const p = parsed(file, agent);
  if (!p) return undefined;
  const n = Math.max(0, edges.length - 1), turns = new Array<number>(n).fill(0), tokens = new Array<number>(n).fill(0);
  for (const at of p.starts.length ? p.starts : p.prompts) { const i = bucketOf(edges, at); if (i >= 0) turns[i]++; }
  if (agent === 'claude') {
    for (const a of p.answers.values()) { const i = bucketOf(edges, a.at); if (i >= 0) tokens[i] += a.input + a.output; }
  } else {
    let prev = 0;
    for (const t of p.totals) {
      const worked = Math.max(0, t.input - t.cached) + t.output, i = bucketOf(edges, t.at);
      if (i >= 0) tokens[i] += Math.max(0, worked - prev);
      prev = worked;
    }
  }
  return { turns, tokens };
}

export function addUsage(into: StatsUsage, u: StatsUsage): void {
  into.turns += u.turns; into.input += u.input; into.output += u.output; into.cacheRead += u.cacheRead; into.cacheWrite += u.cacheWrite;
  if (u.model) into.model = u.model;
}

/** Forgets the parsed records (tests). */
export function forgetUsage(): void { files.clear(); }
