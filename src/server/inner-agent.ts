// A Claude Code or Codex started by hand inside a plain terminal ("shell" session): found among the shell's descendant
// processes, with its folder and conversation, so the session can join a squad as a real team member. Read-only: the
// process table (ps), the process folder (lsof) and the CLIs' own conversation records; nothing is written.
import { execFile } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

export type InnerAgent = 'claude' | 'codex';
export interface ProcRow { pid: number; ppid: number; elapsed: number; command: string }
export interface Inner { agent: InnerAgent; pid: number; startedAt: number; resumeId?: string }

/** `ps -A -o pid=,ppid=,etime=,command=` rows. etime is [[dd-]hh:]mm:ss. Pure. */
export function parsePs(text: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const elapsed = (((Number(m[3] ?? 0) * 24 + Number(m[4] ?? 0)) * 60 + Number(m[5])) * 60 + Number(m[6])) * 1000;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), elapsed, command: m[7].trim() });
  }
  return rows;
}

/**
 * Which agent a command line runs: the native `claude`/`codex` binaries, or their npm launchers under node or bun.
 * Visual Brain's own helpers (the MCP bridge, hooks) never count. Pure.
 */
export function agentOf(command: string): InnerAgent | null {
  const words = command.split(/\s+/);
  const exe = basename(words[0] ?? '');
  if (exe === 'claude' || exe === 'codex') return exe;
  if (/^(node|bun|nodejs)$/.test(exe)) {
    const script = words[1] ?? '';
    if (/@anthropic-ai\/claude-code\//.test(script) || /^claude(\.m?js)?$/.test(basename(script))) return 'claude';
    if (/@openai\/codex\//.test(script) || /^codex(\.m?js)?$/.test(basename(script))) return 'codex';
  }
  return null;
}

/** The conversation named on the command line: `claude --resume X`, `-r X`, `--session-id X`; `codex resume X`. Pure. */
export function resumeIdOf(agent: InnerAgent, command: string): string | undefined {
  const words = command.split(/\s+/);
  const id = (v: string | undefined) => v && /^[A-Za-z0-9-]{8,80}$/.test(v) ? v : undefined;
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (agent === 'claude') {
      if (w === '--resume' || w === '-r' || w === '--session-id') { const v = id(words[i + 1]); if (v) return v; }
      const eq = /^--(?:resume|session-id)=(.+)$/.exec(w); if (eq && id(eq[1])) return eq[1];
    } else if (w === 'resume') { const next = words.slice(i + 1).find(x => !x.startsWith('-')); if (id(next)) return next; }
  }
  return undefined;
}

/** The outermost agent process below the shell (a launcher's native child is the same agent). Pure. */
export function findInner(rows: ProcRow[], shellPid: number, now = Date.now()): Inner | null {
  const children = new Map<number, ProcRow[]>();
  for (const r of rows) children.set(r.ppid, [...(children.get(r.ppid) ?? []), r]);
  const queue = [...(children.get(shellPid) ?? [])];
  const seen = new Set<number>();
  while (queue.length) {
    const r = queue.shift()!;
    if (seen.has(r.pid)) continue; seen.add(r.pid);
    const agent = agentOf(r.command);
    if (agent) return { agent, pid: r.pid, startedAt: now - r.elapsed, resumeId: resumeIdOf(agent, r.command) };
    queue.push(...(children.get(r.pid) ?? []));
  }
  return null;
}

/** Claude Code's folder for a working directory's conversations: every character other than a letter or digit is "-". */
export const claudeProjectDir = (home: string, cwd: string) => join(home, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));

/**
 * The Claude conversation of a process started at `startedAt` in `cwd`: the record written to most recently among
 * those touched since the start, skipping conversations already bound to a session.
 */
export function findClaudeConversation(home: string, cwd: string, startedAt: number, claimed: Set<string>): string | undefined {
  const dir = claudeProjectDir(home, cwd);
  let best: { id: string; at: number } | undefined;
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return undefined; }
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const id = name.slice(0, -6);
    if (claimed.has(id)) continue;
    let at = 0;
    try { at = statSync(join(dir, name)).mtimeMs; } catch { continue; }
    if (at < startedAt - 2000) continue;
    if (!best || at > best.at) best = { id, at };
  }
  return best?.id;
}

const run = (file: string, args: string[]) => new Promise<string>(resolve => {
  execFile(file, args, { timeout: 3000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => resolve(error ? '' : String(stdout)));
});

/** The folder a process works in now (the person may have changed directory before starting the agent). */
export async function processCwd(pid: number): Promise<string | undefined> {
  const out = await run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
  return out.split('\n').find(l => l.startsWith('n'))?.slice(1) || undefined;
}

// The process table read at most every few seconds, off the request path: the sessions list answers from the last read.
let table: { rows: ProcRow[]; at: number; reading?: Promise<void>; fixed?: boolean } = { rows: [], at: 0 };
const FRESH_MS = 4000;
export function refreshProcesses(force = false): Promise<void> {
  if (table.fixed) return Promise.resolve();
  if (table.reading) return table.reading;
  if (!force && Date.now() - table.at < FRESH_MS) return Promise.resolve();
  table.reading = run('ps', ['-A', '-o', 'pid=,ppid=,etime=,command=']).then(out => { table = { rows: parsePs(out), at: Date.now() }; });
  return table.reading;
}
/** From the last read of the process table; asks for a fresher one in the background. */
export function innerOf(shellPid: number | undefined): Inner | null {
  if (!shellPid) return null;
  void refreshProcesses();
  return findInner(table.rows, shellPid);
}
/** A fresh read, for the moment a shell is turned into a team member. */
export async function innerNow(shellPid: number): Promise<Inner | null> {
  await refreshProcesses(true);
  return findInner(table.rows, shellPid);
}
/** Only for tests. */
export function setProcessTable(rows: ProcRow[] | null): void { table = rows ? { rows, at: Date.now(), fixed: true } : { rows: [], at: 0 }; }
