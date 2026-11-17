// Interactive terminal sessions (node-pty) attached to the browser through WebSockets.
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { delimiter } from 'node:path';
import pty from 'node-pty';
import type { LaunchOptions, TerminalInfo } from '../shared/types.ts';

export interface Term {
  info: TerminalInfo;
  proc: pty.IPty;
  buffer: string[];          // last output, replayed to a client that attaches later
  bufferBytes: number;
  listeners: Set<(data: string) => void>;
  exitCode: number | null;
  teamToken: string;
  seenMessage: number;
}

const MAX_BUFFER = 200_000;

export class Terminals {
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

  env(): NodeJS.ProcessEnv {
    const home = homedir();
    const extra = [`${home}/.local/bin`, `${home}/.local/node/bin`, '/opt/homebrew/bin', '/usr/local/bin'];
    const path = (process.env.PATH ?? '/usr/bin:/bin').split(delimiter);
    for (const p of extra) if (!path.includes(p)) path.unshift(p);
    return { ...process.env, PATH: path.join(delimiter), TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: process.env.LANG ?? 'it_IT.UTF-8' };
  }

  spawn(opts: LaunchOptions & { id?: string; teamToken?: string; seenMessage?: number; agent: TerminalInfo['agent']; cwd: string; file: string; args: string[]; title: string; nodeId?: number | null; cols?: number; rows?: number }): Term {
    const id = opts.id ?? randomUUID().slice(0, 8);
    const proc = pty.spawn(opts.file, opts.args, {
      name: 'xterm-256color', cols: opts.cols ?? 120, rows: opts.rows ?? 32, cwd: opts.cwd, env: this.env() as Record<string, string>,
    });
    const term: Term = {
      info: { id, agent: opts.agent, cwd: opts.cwd, title: opts.title, alive: true, nodeId: opts.nodeId ?? null, createdAt: Date.now(), model: opts.model, effort: opts.effort, role: opts.role, parentId: opts.parentId, task: opts.task, workState: opts.role ? 'working' : undefined },
      proc, buffer: [], bufferBytes: 0, listeners: new Set(), exitCode: null,
      teamToken: opts.teamToken ?? '', seenMessage: opts.seenMessage ?? 0,
    };
    proc.onData((data) => {
      term.buffer.push(data);
      term.bufferBytes += data.length;
      while (term.bufferBytes > MAX_BUFFER && term.buffer.length > 1) term.bufferBytes -= term.buffer.shift()!.length;
      for (const l of term.listeners) l(data);
    });
    proc.onExit(({ exitCode }) => {
      term.info.alive = false;
      term.exitCode = exitCode;
      const msg = `\r\n[processo terminato, codice ${exitCode}]\r\n`;
      term.buffer.push(msg);
      for (const l of term.listeners) l(msg);
      this.onExit(id, exitCode);
    });
    this.terms.set(id, term);
    return term;
  }

  write(id: string, data: string): void {
    const t = this.terms.get(id);
    if (t && t.info.alive) t.proc.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const t = this.terms.get(id);
    if (t && t.info.alive && cols > 0 && rows > 0) {
      try { t.proc.resize(Math.min(500, cols), Math.min(200, rows)); } catch { /* closed */ }
    }
  }

  kill(id: string): void {
    const t = this.terms.get(id);
    if (!t) return;
    if (t.info.alive) {
      try { t.proc.kill(); } catch { /* already gone */ }
    }
    this.terms.delete(id);
  }

  killAll(): void {
    for (const id of [...this.terms.keys()]) this.kill(id);
  }
}
