// API-side mirror of a detached terminal host. No PTY is owned by this process.
import { connect, type Socket } from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, existsSync, readFileSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { chmod, copyFile, cp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Terminals, appendBuffer, type SpawnOptions, type Term, type TerminalStore } from './terminals.ts';
import { appendOutput, confirmComposerReturn, noticeInput, noticeInputBlocked, noteInjected, noteInput, observedTurn, scanOutput, stripAnsi } from './activity.ts';
import { TERMINAL_PROTOCOL, metadataFields, observe, readFrames, sendFrame, sendFrames, type HostRecord, type TermPatch, type TermSnapshot } from './terminal-wire.ts';

const workStateFields = ['workState', 'stateSource', 'stateAt', 'idleSince'] as const;
const noticeField = (key: string) => key === 'noticeSentAt' || key === 'noticeConfirmed';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; } };
/** After a reboot the recorded PID can belong to an unrelated process: also require the host's own command line. */
function hostAlive(record: HostRecord, dir: string): boolean {
  if (!alive(record.pid)) return false;
  try { return execFileSync('ps', ['-ww', '-p', String(record.pid), '-o', 'command='], { encoding: 'utf8' }).trim().endsWith(` src/server/terminal-host.ts ${dir}`); }
  catch { return false; }
}
function recordAt(path: string): HostRecord | null {
  try {
    const r = JSON.parse(readFileSync(path, 'utf8'));
    if (!Number.isInteger(r.pid) || r.pid < 2 || !Number.isInteger(r.port) || r.port < 1 || r.port > 65535 || !/^[a-f0-9]{64}$/.test(r.token)) throw new Error('Invalid terminal host record');
    return r;
  } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
}

/** Copy only the PTY runtime, never the checkout/config/credentials. A bundle replacement cannot invalidate lazy loads. */
async function prepareRuntime(dir: string): Promise<string> {
  const source = dirname(fileURLToPath(import.meta.url));
  const names = ['terminal-host.ts', 'terminal-wire.ts', 'terminals.ts', 'activity.ts'];
  const require = createRequire(import.meta.url);
  const addon = dirname(require.resolve('node-pty/package.json'));
  const hash = createHash('sha256').update(process.version).update(process.arch).update(readFileSync(join(addon, 'package.json')));
  for (const name of names) hash.update(readFileSync(join(source, name)));
  const runtime = join(dir, `runtime-${hash.digest('hex').slice(0, 20)}`);
  if (existsSync(join(runtime, 'complete'))) return runtime;
  const stage = `${runtime}.new-${process.pid}`;
  await rm(stage, { recursive: true, force: true });
  try {
    await mkdir(join(stage, 'src/server'), { recursive: true, mode: 0o700 });
    await copyFile(process.execPath, join(stage, 'node'), constants.COPYFILE_FICLONE);
    await chmod(join(stage, 'node'), 0o700);
    for (const name of names) await copyFile(join(source, name), join(stage, 'src/server', name));
    await writeFile(join(stage, 'package.json'), '{"private":true,"type":"module"}', { mode: 0o600 });
    const dest = join(stage, 'node_modules/node-pty');
    await mkdir(dest, { recursive: true, mode: 0o700 });
    await copyFile(join(addon, 'package.json'), join(dest, 'package.json'));
    await cp(join(addon, 'lib'), join(dest, 'lib'), { recursive: true });
    for (const entry of [`prebuilds/${process.platform}-${process.arch}`, 'build/Release']) {
      if (existsSync(join(addon, entry))) await cp(join(addon, entry), join(dest, entry), { recursive: true });
    }
    await writeFile(join(stage, 'complete'), '1', { mode: 0o600 });
    await rename(stage, runtime);
    return runtime;
  } catch (error) { await rm(stage, { recursive: true, force: true }); throw error; }
}

export class TerminalService implements TerminalStore {
  readonly persistent = true;
  private socket!: Socket;
  private terms = new Map<string, Term>();
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private sequence = 0;
  private applying = false;
  private noticeOnly = false;
  private checkedNotices = false;
  private navigationAware = false;
  private delivering = new Set<string>();
  onTurnIdle?: (id: string) => void;
  private closing = false;
  private failure: Error | null = null;
  private onExit: (id: string, code: number) => void;
  private envSource = new Terminals(() => {});
  hostPid = 0;
  connected = false;

  private constructor(onExit: (id: string, code: number) => void) { this.onExit = onExit; }

  static async open(dataDir: string, publicPort: number, onExit: (id: string, code: number) => void): Promise<TerminalService> {
    const dir = join(dataDir, 'terminal-service');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const recordFile = join(dir, 'host.json');
    const attach = async (record: HostRecord) => {
      if (record.protocol !== TERMINAL_PROTOCOL) throw new Error('Il servizio terminali usa un protocollo diverso: conserva la versione corrente finché le sessioni finiscono.');
      const service = new TerminalService(onExit);
      await service.attach(record, publicPort);
      return service;
    };
    const existing = recordAt(recordFile);
    if (existing && hostAlive(existing, dir)) return attach(existing); // Never replace a live/unreachable/unauthorized host.

    // Serialize only host startup. Another backend never gets its own duplicate PTY service for this profile.
    const lock = join(dir, 'starting');
    const deadline = Date.now() + 30_000;
    for (;;) {
      try { mkdirSync(lock, { mode: 0o700 }); writeFileSync(join(lock, 'pid'), String(process.pid), { mode: 0o600 }); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const current = recordAt(recordFile);
        if (current && hostAlive(current, dir)) return attach(current);
        const pid = Number(existsSync(join(lock, 'pid')) ? readFileSync(join(lock, 'pid'), 'utf8') : 0);
        if (Date.now() - statSync(lock).mtimeMs > 30_000 && (pid === 0 || (pid > 1 && !alive(pid)))) { rmSync(lock, { recursive: true }); continue; }
        if (Date.now() >= deadline) throw new Error('Avvio del servizio terminali già in corso; riprova.');
        await pause(100);
      }
    }
    try {
      const current = recordAt(recordFile);
      if (current && hostAlive(current, dir)) return await attach(current);
      const runtime = await prepareRuntime(dir);
      const child = spawn(join(runtime, 'node'), ['src/server/terminal-host.ts', dir], {
        cwd: runtime, detached: true, stdio: 'ignore',
        // Credentials from the API process are sent only as part of a terminal's explicit environment, never host identity.
        env: Object.fromEntries(['HOME', 'PATH', 'LANG', 'SHELL', 'TMPDIR'].flatMap(k => process.env[k] === undefined ? [] : [[k, process.env[k]!]])),
      });
      let error: Error | null = null;
      child.on('error', e => { error = e; }); child.unref();
      for (let n = 0; n < 150; n++) {
        if (error) throw error;
        const record = recordAt(recordFile);
        if (record && record.pid === child.pid) return await attach(record);
        if (child.exitCode !== null) throw new Error(`Servizio terminali terminato durante l’avvio (${child.exitCode}).`);
        await pause(100);
      }
      throw new Error('Timeout durante l’avvio del servizio terminali.');
    } finally { rmSync(lock, { recursive: true, force: true }); }
  }

  private attach(record: HostRecord, publicPort: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let ready = false;
      const socket = this.socket = connect(record.port, '127.0.0.1');
      const timeout = setTimeout(() => { reject(new Error('Terminal service handshake timed out')); socket.destroy(); }, 5000);
      socket.on('connect', () => sendFrame(socket, { op: 'hello', token: record.token, protocol: TERMINAL_PROTOCOL, publicPort }));
      socket.on('error', error => { this.failure = error; if (!ready) reject(error); });
      socket.on('close', () => {
        clearTimeout(timeout); this.connected = false;
        const error = this.failure ?? new Error('Terminal service disconnected');
        if (!ready) reject(error);
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); } this.pending.clear();
      });
      readFrames(socket, m => {
        if (m.error && !m.request) { this.failure = new Error(m.error); if (!ready) reject(this.failure); socket.destroy(); return; }
        if (m.event === 'ready') {
          ready = true; this.connected = true; this.hostPid = m.pid;
          this.noticeOnly = m.noticeOnly === true; this.checkedNotices = m.checkedNotices === true;
          this.navigationAware = m.navigationAware === true;
          clearTimeout(timeout); resolve(); return;
        }
        if (m.event === 'term') { this.add(m.term); return; }
        if (m.event === 'output') {
          const t = this.terms.get(m.id); if (!t) return;
          this.applying = true;
          let returned: boolean;
          try { returned = confirmComposerReturn(t.activity, t.info, m.data); } finally { this.applying = false; }
          if (returned) {
            if (!this.navigationAware) this.command({ op: 'patch', id: m.id, patch: { section: 'activity', key: 'draft', value: false } });
            setImmediate(() => this.onTurnIdle?.(m.id));
          }
          if (!this.checkedNotices) {
            const wasBusy = t.activity.cliBusy;
            this.applying = true;
            try { appendOutput(t.activity, m.data); scanOutput(t.activity, t.info); } finally { this.applying = false; }
            if (wasBusy && t.activity.cliBusy === false) setImmediate(() => this.onTurnIdle?.(m.id));
          }
          appendBuffer(t, m.data); for (const listener of t.listeners) listener(m.data);
        } else if (m.event === 'patch') {
          const t = this.terms.get(m.id); if (!t) return;
          // This backend owns keyboard writes; an echo can predate a later key already in the mirror.
          if (m.patch.section === 'activity' && m.patch.key === 'draft') return;
          // These fields are API-owned. Old hosts echo temporary changes from their legacy deliver operation.
          if (m.patch.section === 'info' && (noticeField(m.patch.key) || (!this.noticeOnly && workStateFields.some(key => key === m.patch.key)))) return;
          this.applying = true;
          try {
            const target = t[m.patch.section as 'info' | 'activity'] as unknown as Record<string, unknown>;
            if (m.patch.value === undefined) delete target[m.patch.key]; else target[m.patch.key] = m.patch.value;
          } finally { this.applying = false; }
          if ((m.patch.section === 'activity' && m.patch.key === 'cliBusy' && m.patch.value === false)
            || (m.patch.section === 'info' && m.patch.key === 'attention' && !m.patch.value))
            setImmediate(() => this.onTurnIdle?.(m.id));
        } else if (m.event === 'exit') {
          const t = this.terms.get(m.id); if (t) { t.info.alive = false; t.exitCode = m.code; this.onExit(m.id, m.code); }
        } else if (m.event === 'remove') this.terms.delete(m.id);
        else if (m.request) {
          const p = this.pending.get(m.request); if (!p) return;
          this.pending.delete(m.request); clearTimeout(p.timer);
          if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result);
        }
      });
    });
  }

  private add(s: TermSnapshot): void {
    const id = s.info.id;
    const screen = s.buffer.join('');
    // An older host may still have its original notice in Codex's completion menu. Preserve that composer.
    const afterLastTurn = screen.slice(Math.max(0, screen.lastIndexOf('\x1b]7501;state=working')));
    const stranded = s.info.agent === 'codex' && s.injectedMessage > s.seenMessage
      && stripAnsi(afterLastTurn).includes('enter insert') && afterLastTurn.includes('$VB_TEAM_TOKEN');
    const changed = (section: TermPatch['section']) => (key: string, value: unknown) => {
      if (section === 'info' && noticeField(key) && !this.noticeOnly) return;
      if (!this.applying) this.command({ op: 'patch', id, patch: { section, key, value } });
    };
    const t: Term = {
      info: observe(s.info, changed('info'), metadataFields.info),
      activity: observe({ ...s.activity, draft: stranded || s.activity.draft, escapeArmed: s.activity.escapeArmed ?? (s.info.lastInputAt !== undefined), cliBusy: s.activity.cliBusy ?? observedTurn(screen, s.info.agent), timer: null }, changed('activity'), metadataFields.activity),
      proc: { pid: s.pid, write: data => this.command({ op: 'write', id, data }), resize: (cols, rows) => this.resize(id, cols, rows), kill: () => this.kill(id) },
      buffer: s.buffer, bufferBytes: s.buffer.reduce((n, b) => n + b.length, 0), listeners: new Set(), exitCode: s.exitCode,
      teamToken: s.teamToken, seenMessage: s.seenMessage, injectedMessage: s.injectedMessage,
    };
    this.terms.set(id, observe(t, changed('term'), metadataFields.term));
  }
  private command(message: object): void {
    if (!this.connected || this.closing) throw this.failure ?? new Error('Terminal service disconnected');
    sendFrame(this.socket, message);
  }
  private request(message: object): Promise<any> {
    return new Promise((resolve, reject) => {
      const request = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(request); reject(new Error('Terminal service request timed out'));
        // Do not retry a spawn/input whose acknowledgement was lost: the operation might already have happened.
        this.socket.destroy();
      }, 10_000);
      this.pending.set(request, { resolve, reject, timer });
      try { this.command({ ...message, request }); } catch (e) { clearTimeout(timer); this.pending.delete(request); reject(e); }
    });
  }
  list() { return [...this.terms.values()].map(t => t.info); }
  get(id: string) { return this.terms.get(id); }
  env(vars: Record<string, string> = {}) { return this.envSource.env(vars); }
  async spawn(opts: SpawnOptions): Promise<Term> {
    const id = await this.request({ op: 'spawn', opts: { ...opts, env: this.env(opts.env) } });
    const term = this.terms.get(id)!;
    // A previous host marks initial assignments working as soon as it starts the PTY.
    if (!this.noticeOnly && opts.role && opts.task && term.info.stateSource === 'server') {
      term.info.workState = 'idle';
      term.info.idleSince = term.info.stateAt;
    }
    // A host started by an older version drops unknown spawn fields: keep them for this server's lifetime.
    if (opts.resumeId && !term.info.resumeId) term.info.resumeId = opts.resumeId;
    if (opts.branch && !term.info.branch) term.info.branch = opts.branch;
    return term;
  }
  rename(id: string, name: string) {
    const t = this.terms.get(id); if (!t) return;
    const clean = name.replace(/\s+/g, ' ').trim().slice(0, 60);
    if (clean) t.info.name = clean; else delete t.info.name;
    return t.info;
  }
  write(id: string, data: string) {
    const t = this.get(id);
    if (!t) return;
    const previous = !!(t.activity.draft || t.activity.navigation);
    this.applying = true;
    let navigation: boolean;
    try { navigation = noteInput(t.activity, t.info, data); } finally { this.applying = false; }
    const input = { op: 'write', id, data, input: true };
    const guarded = !!(t.activity.draft || t.activity.navigation);
    if (!this.navigationAware && (navigation || guarded !== previous)) {
      // Older hosts classify the same navigation bytes differently. Ship the correction with the key.
      if (!this.connected || this.closing) throw this.failure ?? new Error('Terminal service disconnected');
      sendFrames(this.socket, [input, { op: 'patch', id, patch: { section: 'activity', key: 'draft', value: guarded } }]);
    } else this.command(input);
  }
  resize(id: string, cols: number, rows: number) { this.command({ op: 'resize', id, cols, rows }); }
  kill(id: string) { this.command({ op: 'kill', id }); this.terms.delete(id); }
  killAll() { for (const id of this.terms.keys()) this.kill(id); }
  deliver(id: string, notice: string, cursor: number, now: number): boolean {
    const t = this.get(id);
    if (!t?.info.alive || this.delivering.has(id) || noticeInputBlocked(t.activity, t.info)) return false;
    const sent = () => {
      this.applying = true;
      try {
        t.injectedMessage = Math.max(t.injectedMessage, cursor);
        delete t.info.noticeConfirmed;
        t.info.noticeSentAt = now;
        noteInjected(t.activity, now);
      } finally { this.applying = false; }
    };
    if (this.checkedNotices) {
      this.delivering.add(id);
      void this.request({ op: 'deliver', id, notice, cursor, now, noticeOnly: true })
        .then(ok => { if (ok) sent(); }, () => { /* reattach restores the host's committed cursor */ })
        .finally(() => this.delivering.delete(id));
    } else {
      if (!this.connected || this.closing) throw this.failure ?? new Error('Terminal service disconnected');
      // Installed hosts also support raw writes. Avoid their delayed Enter, keep the cursor across detach.
      const patch = (section: TermPatch['section'], key: string, value?: unknown) => ({ op: 'patch', id, patch: { section, key, value } });
      sendFrames(this.socket, [{ op: 'write', id, data: noticeInput(notice) }, patch('term', 'injectedMessage', cursor),
        ...(this.noticeOnly ? [patch('info', 'noticeSentAt', now), patch('info', 'noticeConfirmed')] : [])]);
      sent();
    }
    return true;
  }
  async flush() { await this.request({ op: 'flush' }); }
  async detach() {
    if (!this.connected) return;
    const detached = this.request({ op: 'detach' });
    this.closing = true;
    try { await detached; } finally { this.socket.destroy(); }
  }
}
