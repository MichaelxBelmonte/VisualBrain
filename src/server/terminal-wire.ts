// Private, versioned IPC between the API server and the process that owns the PTYs.
import type { Socket } from 'node:net';
import type { Term } from './terminals.ts';
import type { TerminalInfo } from '../shared/types.ts';
import type { Activity } from './activity.ts';

export const TERMINAL_PROTOCOL = 1;
export const MAX_FRAME = 2 * 1024 * 1024;
export interface HostRecord { protocol: number; pid: number; port: number; token: string; runtime: string }
export interface TermSnapshot {
  info: TerminalInfo; pid: number; buffer: string[]; exitCode: number | null;
  teamToken: string; seenMessage: number; injectedMessage: number;
  activity: Omit<Activity, 'timer'>;
}
export interface TermPatch { section: 'info' | 'activity' | 'term'; key: string; value?: unknown }
const infoFields = new Set(['name', 'parentId', 'workState', 'idleSince', 'stateSource', 'stateAt', 'noticeSentAt', 'noticeConfirmed', 'attention', 'lastOutputAt', 'lastInputAt']);
const activityFields = new Set(['quietUntil', 'attentionAt', 'draft', 'cliBusy']);

export function snapshot(t: Term): TermSnapshot {
  const { timer: _, ...activity } = t.activity;
  return { info: { ...t.info }, pid: t.proc.pid, buffer: [...t.buffer], exitCode: t.exitCode,
    teamToken: t.teamToken, seenMessage: t.seenMessage, injectedMessage: t.injectedMessage, activity };
}

/** Only mutable coordination fields cross back to the host; process identity and credentials never do. */
export function applyPatch(t: Term, p: TermPatch): void {
  if (!p || !['info', 'activity', 'term'].includes(p.section)) throw new Error('Invalid terminal metadata section');
  const allowed = p.section === 'info' ? infoFields : p.section === 'activity' ? activityFields : new Set(['seenMessage', 'injectedMessage']);
  if (!allowed.has(p.key)) throw new Error('Invalid terminal metadata field');
  if (p.value !== undefined && p.value !== null && !['string', 'number', 'boolean'].includes(typeof p.value)) throw new Error('Invalid terminal metadata value');
  const target = (p.section === 'term' ? t : t[p.section]) as unknown as Record<string, unknown>;
  if (p.section === 'term') {
    if (typeof p.value !== 'number' || !Number.isSafeInteger(p.value) || p.value < 0) throw new Error('Invalid message cursor');
    target[p.key] = Math.max(Number(target[p.key]) || 0, p.value);
  } else if (p.value === undefined) delete target[p.key];
  else target[p.key] = p.value;
}

/** Observe the existing mutation-based coordination API without periodic snapshots or lost last-second changes. */
export function observe<T extends object>(target: T, changed: (key: string, value: unknown) => void, fields?: Set<string>): T {
  return new Proxy(target, {
    set(obj, key, value) {
      const old = Reflect.get(obj, key);
      Reflect.set(obj, key, value);
      if (typeof key === 'string' && old !== value && (!fields || fields.has(key))) changed(key, value);
      return true;
    },
    deleteProperty(obj, key) {
      const had = Reflect.has(obj, key);
      Reflect.deleteProperty(obj, key);
      if (had && typeof key === 'string' && (!fields || fields.has(key))) changed(key, undefined);
      return true;
    },
  });
}
export const metadataFields = { info: infoFields, activity: activityFields, term: new Set(['seenMessage', 'injectedMessage']) };

export function sendFrame(socket: Socket, message: unknown): void {
  sendFrames(socket, [message]);
}

export function sendFrames(socket: Socket, messages: unknown[]): void {
  if (socket.destroyed) throw new Error('Terminal service disconnected');
  // A stuck UI/server must not stop PTY reads or grow the host without a bound.
  if (socket.writableLength > 8 * MAX_FRAME) { socket.destroy(); throw new Error('Terminal service client too slow'); }
  socket.write(messages.map(message => JSON.stringify(message) + '\n').join(''));
}

export function readFrames(socket: Socket, receive: (message: any) => void): void {
  let pending = '';
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    pending += chunk;
    for (;;) {
      const end = pending.indexOf('\n');
      if (end < 0) { if (pending.length > MAX_FRAME) socket.destroy(); return; }
      if (end > MAX_FRAME) { socket.destroy(); return; }
      const line = pending.slice(0, end); pending = pending.slice(end + 1);
      try { receive(JSON.parse(line)); } catch { socket.destroy(); return; }
    }
  });
}
