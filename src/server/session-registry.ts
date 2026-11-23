// Sessions remembered across a computer restart.
// The terminal service keeps sessions while the app closes, updates or crashes, but it ends with the computer (restart,
// shutdown, logout). Its list then comes back empty and nothing could be resumed, although Claude and Codex keep their
// conversations on disk. This store wraps the terminal service, writes the sessions it holds to the profile, and after a
// restart shows the ones the new service does not know as ended sessions: same id, code, name, role, node and squad, so
// «Riprendi» starts them again (sessions.ts) with their conversation and board token.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TerminalInfo } from '../shared/types.ts';
import { newActivity } from './activity.ts';
import type { SpawnOptions, Term, TerminalStore } from './terminals.ts';

/** At most this many sessions are remembered, the most recent first. */
export const KEEP_SESSIONS = 64;
const FILE = 'sessions.json';
const RESUMABLE = new Set(['claude', 'codex', 'shell']);
const VERSION = 1;
/** Fields of a session worth keeping: identity, place and how to start it again. Live state (attention, activity) is not. */
const KEPT = ['id', 'agent', 'cwd', 'title', 'name', 'nodeId', 'createdAt', 'model', 'effort', 'role', 'parentId', 'task', 'resumeId', 'branch', 'account'] as const;

interface Saved { info: Partial<TerminalInfo>; teamToken: string; seenMessage: number }

function keep(term: Term): Saved {
  const info: Record<string, unknown> = {};
  for (const key of KEPT) if (term.info[key] !== undefined) info[key] = term.info[key];
  return { info: info as Partial<TerminalInfo>, teamToken: term.teamToken, seenMessage: term.seenMessage };
}

function valid(s: unknown): s is Saved {
  const v = s as Saved;
  return !!v && typeof v === 'object' && !!v.info && typeof v.info.id === 'string' && /^[\w-]{1,64}$/.test(v.info.id)
    && ['claude', 'codex', 'shell', 'hermes', 'agy'].includes(String(v.info.agent)) && typeof v.info.cwd === 'string'
    && typeof v.teamToken === 'string' && Number.isSafeInteger(v.seenMessage);
}

/** Reads the remembered sessions; a missing or damaged file means none. */
export function readSessions(dataDir: string): Saved[] {
  try {
    const data = JSON.parse(readFileSync(join(dataDir, FILE), 'utf8'));
    return data?.version === VERSION && Array.isArray(data.sessions) ? data.sessions.filter(valid) : [];
  } catch { return []; }
}

/** An ended session the current terminal service has never held: its row, its code and «Riprendi», no process. */
function ended(saved: Saved, note: string): Term {
  const info = { title: '', nodeId: null, createdAt: 0, ...saved.info, alive: false } as TerminalInfo;
  return {
    info, proc: { pid: 0, write() {}, resize() {}, kill() {} }, buffer: [note], bufferBytes: note.length, listeners: new Set(), exitCode: null,
    teamToken: saved.teamToken, seenMessage: saved.seenMessage, injectedMessage: saved.seenMessage, activity: newActivity(),
  };
}

type Inner = TerminalStore & { connected?: boolean; hostPid?: number; detach?(): Promise<void> };

export class RememberedSessions<T extends Inner> implements TerminalStore {
  readonly persistent?: boolean;
  private readonly restored = new Map<string, Term>();
  private signature = '';
  private timer: NodeJS.Timeout | null = null;

  /** `restore` false only remembers: used when the inner store is not the one that survives a restart. */
  readonly inner: T;
  private readonly dataDir: string;

  constructor(inner: T, dataDir: string, language: 'it' | 'en' = 'it', restore = true) {
    this.inner = inner; this.dataDir = dataDir;
    this.persistent = inner.persistent;
    const note = language === 'en'
      ? '\r\n[Session closed by a computer restart. Resume it to continue the conversation.]\r\n'
      : '\r\n[Sessione chiusa dal riavvio del computer. Usa Riprendi per continuare la conversazione.]\r\n';
    if (restore) {
      const live = new Set(inner.list().map(s => s.id));
      for (const saved of readSessions(dataDir)) if (!live.has(saved.info.id!)) this.restored.set(saved.info.id!, ended(saved, note));
    }
    this.save();
  }

  get connected() { return this.inner.connected; }
  get hostPid() { return this.inner.hostPid; }
  get onTurnIdle() { return this.inner.onTurnIdle; }
  set onTurnIdle(fn) { this.inner.onTurnIdle = fn; }

  list(): TerminalInfo[] {
    const live = this.inner.list();
    const ids = new Set(live.map(s => s.id));
    return [...live, ...[...this.restored.values()].filter(t => !ids.has(t.info.id)).map(t => t.info)];
  }
  get(id: string): Term | undefined { return this.inner.get(id) ?? this.restored.get(id); }
  env(vars?: Record<string, string>) { return this.inner.env(vars); }
  async spawn(opts: SpawnOptions): Promise<Term> {
    const term = await this.inner.spawn(opts);
    this.restored.delete(term.info.id);
    this.save();
    return term;
  }
  rename(id: string, name: string) {
    const restored = this.restored.get(id);
    if (restored && !this.inner.get(id)) {
      const clean = name.replace(/\s+/g, ' ').trim().slice(0, 60);
      if (clean) restored.info.name = clean; else delete restored.info.name;
      this.save();
      return restored.info;
    }
    const info = this.inner.rename(id, name);
    this.save();
    return info;
  }
  write(id: string, data: string) { if (this.inner.get(id)) this.inner.write(id, data); }
  resize(id: string, cols: number, rows: number) { if (this.inner.get(id)) this.inner.resize(id, cols, rows); }
  /** Closing a remembered session forgets it; closing a live one ends its process, as before. */
  kill(id: string) {
    const known = this.restored.delete(id);
    if (this.inner.get(id) || !known) this.inner.kill(id);
    this.save();
  }
  killAll() { this.restored.clear(); this.inner.killAll(); this.save(); }
  flush() { this.save(); return this.inner.flush?.() ?? Promise.resolve(); }
  deliver(id: string, notice: string, cursor: number, now: number) { return this.inner.deliver?.(id, notice, cursor, now) ?? false; }
  async detach() {
    this.save();
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    await this.inner.detach?.();
  }

  /** Session metadata changes through the service (names, models, conversation ids): look again every few seconds. */
  watch(everyMs = 5000): this {
    this.timer ??= setInterval(() => this.save(), everyMs);
    this.timer.unref();
    return this;
  }

  /** Writes the list when it changed: live and remembered sessions, newest first, private to the user. */
  save(): void {
    const all = [...this.inner.list().map(s => this.inner.get(s.id)).filter((t): t is Term => !!t), ...this.restored.values()];
    // Only sessions «Riprendi» can start again: Claude and Codex reopen their conversation, a shell its folder.
    const unique = [...new Map(all.filter(t => RESUMABLE.has(t.info.agent)).map(t => [t.info.id, t])).values()];
    const sessions = unique.sort((a, b) => b.info.createdAt - a.info.createdAt).slice(0, KEEP_SESSIONS).map(keep);
    const text = JSON.stringify({ version: VERSION, sessions });
    if (text === this.signature) return;
    try {
      const file = join(this.dataDir, FILE), temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, text, { mode: 0o600 });
      renameSync(temp, file);
      this.signature = text;
    } catch (error) { console.error('[sessions] salvataggio non riuscito:', error instanceof Error ? error.message : String(error)); }
  }

}
