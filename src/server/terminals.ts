// Interactive terminal sessions (node-pty) attached to the browser through WebSockets.
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { delimiter } from 'node:path';
import pty from 'node-pty';
import type { LaunchOptions, TerminalInfo } from '../shared/types.ts';
import { appendOutput, newActivity, noteInput, noteResize, scanOutput, SCAN_EVERY_MS, type Activity } from './activity.ts';

export interface Term {
  info: TerminalInfo;
  proc: Pick<pty.IPty, 'pid' | 'write' | 'resize' | 'kill'>;
  buffer: string[];          // last output, replayed to a client that attaches later
  bufferBytes: number;
  listeners: Set<(data: string) => void>;
  exitCode: number | null;
  teamToken: string;
  seenMessage: number;
  injectedMessage: number;   // last board message announced to the agent: the same messages are never pasted twice
  activity: Activity;
}

export const MAX_BUFFER = 200_000;
export type SpawnOptions = LaunchOptions & { id?: string; resumeId?: string; createdAt?: number; branch?: string; teamToken?: string; seenMessage?: number; agent: TerminalInfo['agent']; cwd: string; file: string; args: string[]; title: string; nodeId?: number | null; cols?: number; rows?: number; env?: Record<string, string> };

/** The API works with either local PTYs (unit tests) or the persistent terminal service. */
export interface TerminalStore {
  readonly persistent?: boolean;
  onTurnIdle?: (id: string) => void;
  list(): TerminalInfo[];
  get(id: string): Term | undefined;
  env(vars?: Record<string, string>): NodeJS.ProcessEnv;
  spawn(opts: SpawnOptions): Term | Promise<Term>;
  rename(id: string, name: string): TerminalInfo | undefined;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  kill(id: string): void;
  killAll(): void;
  flush?(): Promise<void>;
  /** Submit the notice and its terminator together and remember its cursor in the surviving host. */
  deliver?(id: string, notice: string, cursor: number, now: number): boolean;
}

export function appendBuffer(term: Term, data: string): void {
  // Even a single large output chunk is bounded (including while no UI/server is attached).
  const chunk = data.slice(-MAX_BUFFER);
  term.buffer.push(chunk);
  term.bufferBytes += chunk.length;
  while (term.bufferBytes > MAX_BUFFER && term.buffer.length > 1) term.bufferBytes -= term.buffer.shift()!.length;
}

const PRIVATE_MODE = /\x1b\[\?([\d;]+)([hl])/g;
const ALT_SCREEN = new Set(['1049', '1047', '47']), MOUSE = new Set(['1000', '1002', '1003']);

/** What a client attaching now needs before the kept output. A full-screen program (Claude's fullscreen view, an editor)
 *  entered the alternate screen long before the last MAX_BUFFER characters; its mouse tracking, set again on every frame,
 *  says it is still there. Without the prefix the frames would land on the scrollback; `fullScreen` asks for a repaint. */
export function replayState(buffer: string[]): { prefix: string; fullScreen: boolean } {
  let alt: boolean | null = null;
  const mouse = new Set<string>();
  for (const m of buffer.join('').matchAll(PRIVATE_MODE)) for (const n of m[1].split(';')) {
    if (ALT_SCREEN.has(n)) alt = m[2] === 'h';
    else if (MOUSE.has(n)) { if (m[2] === 'h') mouse.add(n); else mouse.delete(n); }
  }
  const inferred = alt === null && mouse.size > 0;
  return { prefix: inferred ? '\x1b[?1049h' : '', fullScreen: alt === true || inferred };
}

export class Terminals {
  onTurnIdle?: (id: string) => void;
  private readonly terms = new Map<string, Term>();
  private readonly onExit: (id: string, code: number) => void;

  constructor(onExit: (id: string, code: number) => void) {
    this.onExit = onExit;
  }

  list(): TerminalInfo[] {
    return [...this.terms.values()].map((t) => t.info);
  }

  get(id: string): Term | undefined {
    return this.terms.get(id);
  }

  env(vars: Record<string, string> = {}): NodeJS.ProcessEnv {
    const home = homedir();
    const extra = [`${home}/.local/bin`, `${home}/.local/node/bin`, '/opt/homebrew/bin', '/usr/local/bin'];
    const path = (process.env.PATH ?? '/usr/bin:/bin').split(delimiter);
    for (const p of extra) if (!path.includes(p)) path.unshift(p);
    return { ...process.env, PATH: path.join(delimiter), TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: process.env.LANG ?? 'it_IT.UTF-8', ...vars };
  }

  spawn(opts: SpawnOptions): Term {
    const id = opts.id ?? randomUUID().slice(0, 8);
    const proc = pty.spawn(opts.file, opts.args, {
      name: 'xterm-256color', cols: opts.cols ?? 120, rows: opts.rows ?? 32, cwd: opts.cwd, env: this.env(opts.env) as Record<string, string>,
    });
    const now = Date.now();
    const initialState = opts.role ? (opts.role === 'orchestrator' && !opts.task ? 'working' : 'idle') : undefined;
    const term: Term = {
      info: { id, agent: opts.agent, cwd: opts.cwd, title: opts.title, alive: true, nodeId: opts.nodeId ?? null, createdAt: Number.isSafeInteger(opts.createdAt) ? opts.createdAt! : now, model: opts.model, effort: opts.effort, role: opts.role, parentId: opts.parentId, task: opts.task, workState: initialState, idleSince: initialState === 'idle' ? now : undefined, ...(opts.role ? { stateSource: 'server' as const, stateAt: now } : {}), ...(typeof opts.resumeId === 'string' ? { resumeId: opts.resumeId } : {}), ...(typeof opts.branch === 'string' ? { branch: opts.branch } : {}) },
      proc, buffer: [], bufferBytes: 0, listeners: new Set(), exitCode: null,
      teamToken: opts.teamToken ?? '', seenMessage: opts.seenMessage ?? 0, injectedMessage: 0, activity: newActivity(),
    };
    proc.onData((data) => {
      appendBuffer(term, data);
      for (const l of term.listeners) l(data);
      const a = term.activity;
      if (appendOutput(a, data)) {
        a.timer = setTimeout(() => {
          a.timer = null;
          const wasBusy = a.cliBusy;
          scanOutput(a, term.info);
          if (wasBusy && a.cliBusy === false) this.onTurnIdle?.(id);
        }, SCAN_EVERY_MS);
        a.timer.unref();
      }
    });
    proc.onExit(({ exitCode }) => {
      term.info.alive = false;
      term.exitCode = exitCode;
      if (term.activity.timer) clearTimeout(term.activity.timer);
      const msg = `\r\n[processo terminato, codice ${exitCode}]\r\n`;
      appendBuffer(term, msg);
      for (const l of term.listeners) l(msg);
      this.onExit(id, exitCode);
    });
    this.terms.set(id, term);
    return term;
  }

  /** Names a session (trimmed, at most 60 characters); an empty name restores the generated label. */
  rename(id: string, name: string): TerminalInfo | undefined {
    const t = this.terms.get(id);
    if (!t) return undefined;
    const clean = name.replace(/\s+/g, ' ').trim().slice(0, 60);
    if (clean) t.info.name = clean; else delete t.info.name;
    return t.info;
  }

  /** Input from the person (UI websocket). The server's own deliveries write to the PTY directly and are not counted. */
  write(id: string, data: string): void {
    const t = this.terms.get(id);
    if (t && t.info.alive) { noteInput(t.activity, t.info, data); t.proc.write(data); }
  }

  resize(id: string, cols: number, rows: number): void {
    const t = this.terms.get(id);
    if (t && t.info.alive && cols > 0 && rows > 0) {
      noteResize(t.activity);
      try { t.proc.resize(Math.min(500, cols), Math.min(200, rows)); } catch { /* closed */ }
    }
  }

  kill(id: string): void {
    const t = this.terms.get(id);
    if (!t) return;
    if (t.activity.timer) clearTimeout(t.activity.timer);
    if (t.info.alive) {
      try { t.proc.kill(); } catch { /* already gone */ }
    }
    this.terms.delete(id);
  }

  killAll(): void {
    for (const id of [...this.terms.keys()]) this.kill(id);
  }
}
