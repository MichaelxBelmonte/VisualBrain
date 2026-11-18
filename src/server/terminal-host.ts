// Detached PTY owner. Its executable, addon and sources live in a private, immutable profile runtime.
// No HTTP API, graph database or model calls: restarting the app/server never signals these terminals.
import { createServer, type Socket } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Terminals, type Term } from './terminals.ts';
import { noteInjected } from './activity.ts';
import { TERMINAL_PROTOCOL, applyPatch, metadataFields, observe, readFrames, sendFrame, snapshot } from './terminal-wire.ts';

const serviceDir = process.argv[2];
if (!serviceDir) throw new Error('Terminal service directory missing');
process.umask(0o077);
const recordFile = join(serviceDir, 'host.json');
const token = randomBytes(32).toString('hex');
let owner: Socket | null = null;
let publicPort: number | null = null;
let listeningPort = 0;
function saveRecord() {
  const staging = `${recordFile}.${process.pid}`;
  writeFileSync(staging, JSON.stringify({ protocol: TERMINAL_PROTOCOL, pid: process.pid, port: listeningPort, apiPort: publicPort, token, runtime: process.cwd() }), { mode: 0o600 });
  renameSync(staging, recordFile);
}
let applying = false;
const emit = (message: unknown) => {
  if (!owner) return;
  try { sendFrame(owner, message); } catch { owner.destroy(); }
};
const terms = new Terminals((id, code) => emit({ event: 'exit', id, code }));
const watch = (t: Term) => {
  for (const section of ['info', 'activity'] as const) {
    // alive is host-owned and still needs to reach the client.
    const fields = new Set(metadataFields[section]);
    if (section === 'info') fields.add('alive');
    const observed = observe(t[section], (key, value) => { if (!applying) emit({ event: 'patch', id: t.info.id, patch: { section, key, value } }); }, fields);
    if (section === 'info') t.info = observed as Term['info']; else t.activity = observed as Term['activity'];
  }
  t.listeners.add(data => emit({ event: 'output', id: t.info.id, data }));
};
let idleTimer: NodeJS.Timeout | undefined;
const idle = () => {
  // Keep running for as long as even one terminal is alive, regardless of attached windows.
  if (owner || terms.list().some(t => t.alive)) { clearTimeout(idleTimer); idleTimer = undefined; }
  else if (!idleTimer) idleTimer = setTimeout(() => finish(), 5000);
};
const server = createServer(socket => {
  let authenticated = false;
  const authTimer = setTimeout(() => socket.destroy(), 3000);
  socket.on('error', () => {});
  socket.on('close', () => { clearTimeout(authTimer); if (owner === socket) owner = null; idle(); });
  readFrames(socket, m => {
    if (!authenticated) {
      const supplied = Buffer.from(typeof m.token === 'string' ? m.token : '');
      const expected = Buffer.from(token);
      const deny = (error: string) => { sendFrame(socket, { error }); socket.end(); };
      if (m.op !== 'hello' || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { deny('Unauthorized'); return; }
      if (m.protocol !== TERMINAL_PROTOCOL) { deny('Incompatible terminal protocol; keep the current terminal host running'); return; }
      if (owner) { deny('Another server is already attached to this profile'); return; }
      if (!Number.isInteger(m.publicPort) || m.publicPort < 1 || m.publicPort > 65535) { deny('Invalid API port'); return; }
      if (publicPort !== null && publicPort !== m.publicPort && terms.list().some(t => t.alive)) { deny(`Active terminals require API port ${publicPort}`); return; }
      publicPort = m.publicPort;
      saveRecord();
      owner = socket; authenticated = true; clearTimeout(authTimer); clearTimeout(idleTimer); idleTimer = undefined;
      for (const info of terms.list()) sendFrame(socket, { event: 'term', term: snapshot(terms.get(info.id)!) });
      sendFrame(socket, { event: 'ready', protocol: TERMINAL_PROTOCOL, pid: process.pid, noticeOnly: true });
      return;
    }
    if (owner !== socket) { socket.destroy(); return; }
    try {
      let result: unknown = null;
      const t = typeof m.id === 'string' ? terms.get(m.id) : undefined;
      switch (m.op) {
        case 'spawn': {
          if (!m.opts || typeof m.opts.file !== 'string' || typeof m.opts.cwd !== 'string' || !Array.isArray(m.opts.args)) throw new Error('Invalid spawn');
          if (!statSync(m.opts.cwd).isDirectory() || !m.opts.args.every((arg: unknown) => typeof arg === 'string')) throw new Error('Invalid terminal working directory or arguments');
          if (m.opts.id && terms.get(m.opts.id)) throw new Error('Duplicate terminal ID');
          const created = terms.spawn(m.opts); watch(created);
          emit({ event: 'term', term: snapshot(created) }); result = created.info.id;
          break;
        }
        case 'patch':
          if (t) { applying = true; try { applyPatch(t, m.patch); } finally { applying = false; } }
          break;
        case 'write': if (t) { if (m.input) terms.write(m.id, String(m.data)); else t.proc.write(String(m.data)); } break;
        case 'deliver':
          if (t?.info.alive) {
            if (!Number.isSafeInteger(m.cursor) || typeof m.notice !== 'string' || !Number.isFinite(m.now)) throw new Error('Invalid terminal delivery');
            noteInjected(t.activity, m.now);
            t.proc.write(`\x1b[200~${m.notice}\x1b[201~`);
            t.injectedMessage = Math.max(t.injectedMessage, m.cursor);
            if (m.noticeOnly) { delete t.info.noticeConfirmed; t.info.noticeSentAt = m.now; }
            else { // Older attached servers mirror this legacy transition locally.
              t.info.workState = 'working'; t.info.stateSource = 'server'; t.info.stateAt = m.now; delete t.info.idleSince;
            }
            setTimeout(() => { if (t.info.alive) try { t.proc.write('\r'); } catch { /* terminal exited during the paste */ } }, 150);
          }
          break;
        case 'resize': terms.resize(m.id, Number(m.cols), Number(m.rows)); break;
        case 'kill': terms.kill(m.id); emit({ event: 'remove', id: m.id }); idle(); break;
        case 'flush': break; // Stream order makes this an acknowledgement of every preceding mutation/input.
        case 'detach':
          if (m.request) sendFrame(socket, { request: m.request, result: null });
          owner = null; socket.end(); idle(); return;
        default: throw new Error('Unknown terminal command');
      }
      if (m.request) sendFrame(socket, { request: m.request, result });
    } catch (error) {
      if (m.request) sendFrame(socket, { request: m.request, error: error instanceof Error ? error.message : String(error) });
      else { sendFrame(socket, { error: 'Terminal command failed' }); socket.destroy(); }
    }
  });
});
function finish() {
  if (terms.list().some(t => t.alive)) return;
  try { if (JSON.parse(readFileSync(recordFile, 'utf8')).token === token) unlinkSync(recordFile); } catch {}
  server.close(); process.exit(0);
}
// A normal update must never stop this process; ignore accidental graceful termination while PTYs are alive.
process.on('SIGTERM', finish);
process.on('SIGINT', finish);
process.on('SIGHUP', () => {});
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing terminal service address');
  listeningPort = address.port;
  saveRecord();
  idle();
});
// A child can exit while the API is disconnected; stop the empty host then as well.
setInterval(idle, 1000).unref();
