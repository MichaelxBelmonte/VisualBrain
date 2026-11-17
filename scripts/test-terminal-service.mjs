// Real PTYs, detached host and API process restarts. Invented profile only; never touches the running desktop app.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { connect, createServer } from 'node:net';
import WebSocket from 'ws';
import { pathToFileURL } from 'node:url';
const runtime = process.argv.find(a => a.startsWith('--runtime='))?.slice(10);
const root = runtime ? resolve(runtime, 'server') : resolve(import.meta.dirname, '..');
const { TerminalService } = await import(pathToFileURL(join(root, 'src/server/terminal-service.ts')));

const sleep = ms => new Promise(r => setTimeout(r, ms));
/** `detail` describes the state at the moment of the timeout, not when the wait started. */
const waitFor = async (label, check, ms = 15000, detail) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await check()) return; await sleep(25); }
  throw new Error('Timeout: ' + label + (detail ? ': ' + detail() : ''));
};
const freePort = () => new Promise(resolve => {
  const server = createServer().listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});
const temp = realpathSync(mkdtempSync(join(tmpdir(), 'vb-terminal-service-')));
let service, backend, backendExit, hostPid, socket;
let logs = '';
const profile = join(temp, 'profile'), files = join(temp, 'files');
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const request = async (path, method = 'GET', body, token) => {
  const res = await fetch(base + path, { method, signal: AbortSignal.timeout(5000), headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await res.json();
  return { status: res.status, data };
};
const start = async () => {
  backend = spawn(process.execPath, ['src/cli.ts', 'serve', '--port', String(port), '--no-watch'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, VISUAL_BRAIN_DATA_DIR: profile, VISUAL_BRAIN_INSTANCE: 'persistent-test', VB_ENGINE: 'ts' },
  });
  backendExit = new Promise(r => backend.once('exit', r));
  backend.stdout.on('data', b => logs += b); backend.stderr.on('data', b => logs += b);
  await waitFor('API ready: ' + logs, async () => {
    if (backend.exitCode !== null) throw new Error(logs);
    try { return (await request('/api/health')).status === 200; } catch { return false; }
  });
};
const stop = async signal => { if (backend?.exitCode === null) { backend.kill(signal); await backendExit; } };
const attach = async id => {
  let output = '';
  socket = new WebSocket(`ws://127.0.0.1:${port}/ws/term?id=${id}`, { headers: { origin: base } });
  socket.on('message', b => output += b);
  await new Promise((r, fail) => { socket.once('open', r); socket.once('error', fail); });
  return () => output;
};
try {
  mkdirSync(profile); mkdirSync(files);
  writeFileSync(join(files, 'README.md'), '# Fixture\n');
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({ roots: [files], setupComplete: true, language: 'en' }));

  service = await TerminalService.open(profile, port, () => {}); hostPid = service.hostPid;
  const record = JSON.parse(readFileSync(join(profile, 'terminal-service/host.json')));
  assert.equal(statSync(join(profile, 'terminal-service')).mode & 0o777, 0o700);
  assert.equal(statSync(join(profile, 'terminal-service/host.json')).mode & 0o777, 0o600);
  assert.ok(record.runtime.startsWith(join(profile, 'terminal-service/runtime-')));
  assert.ok(existsSync(join(record.runtime, 'node_modules/node-pty/lib/index.js')));
  await assert.rejects(TerminalService.open(profile, port, () => {}), /already attached/);
  const denial = await new Promise(resolve => {
    const s = connect(record.port, '127.0.0.1', () => s.write(JSON.stringify({ op: 'hello', token: '0'.repeat(64), protocol: 1, publicPort: port }) + '\n'));
    s.once('data', b => { resolve(String(b)); s.destroy(); });
  });
  assert.match(denial, /Unauthorized/);
  console.log('PASS private runtime, protected IPC, single backend owner');

  const term = await service.spawn({ id: 'persist-fixture', agent: 'claude', role: 'orchestrator', nodeId: 1, teamToken: 'fixture-token',
    file: '/bin/sh', args: ['-c', 'echo START:$$; while read line; do echo ANSWER:$line:$$; done'], cwd: files, title: 'fixture', env: { VB_FIXTURE: 'original' } });
  const pid = term.proc.pid;
  // A full-screen program whose alternate-screen switch is no longer in the kept tail: only its mouse tracking shows.
  // It reports its size on SIGWINCH and also polls it, so the check does not depend on how fast the OS delivers signals.
  await service.spawn({ id: 'fullscreen-fixture', agent: 'claude', file: '/bin/sh', cwd: files, title: 'fullscreen',
    args: ['-c', "trap 'echo WINCH:$(stty size)' WINCH; printf '\\033[?1000h\\033[?1006hREADY\\n'; last=$(stty size); while :; do sleep 0.05; now=$(stty size); [ \"$now\" != \"$last\" ] && echo SIZE:$now; last=$now; done"] });
  service.rename(term.info.id, 'Kept name');
  term.info.workState = 'idle'; term.info.stateAt = 1234; term.info.parentId = 'parent-fixture';
  term.seenMessage = 42; term.injectedMessage = 43;
  term.activity.draft = true;
  await service.flush();
  await waitFor('first PTY output', () => term.buffer.join('').includes(`START:${pid}`));
  await service.detach(); service = null;
  process.kill(pid, 0);
  await assert.rejects(TerminalService.open(profile, port + 1, () => {}), /require API port/);
  service = await TerminalService.open(profile, port, () => {});
  const restored = service.get(term.info.id);
  assert.equal(service.hostPid, hostPid); assert.equal(restored.proc.pid, pid);
  assert.equal(restored.info.name, 'Kept name'); assert.equal(restored.info.workState, 'idle');
  assert.equal(restored.teamToken, 'fixture-token'); assert.equal(restored.seenMessage, 42); assert.equal(restored.injectedMessage, 43);
  assert.equal(restored.activity.draft, true);
  service.resize(term.info.id, 93, 27);
  service.write(term.info.id, 'reconnected\r'); await service.flush();
  await waitFor('PTY still interactive', () => restored.buffer.join('').includes(`ANSWER:reconnected:${pid}`));
  await assert.rejects(service.spawn({ agent: 'shell', file: '/does/not/exist', args: [], cwd: '/missing-directory', title: 'bad' }));
  // "Riprendi": an ended session is dropped and spawned again under the same id, with its conversation id.
  const ended = await service.spawn({ id: 'resume-fixture', resumeId: 'conversation-1', agent: 'claude', file: '/bin/sh', args: ['-c', 'exit 3'], cwd: files, title: 'ended' });
  assert.equal(ended.info.resumeId, 'conversation-1');
  await waitFor('ended session', () => service.get('resume-fixture')?.info.alive === false);
  service.kill('resume-fixture');
  const again = await service.spawn({ id: 'resume-fixture', resumeId: 'conversation-1', agent: 'claude', file: '/bin/sh', args: ['-c', 'sleep 30'], cwd: files, title: 'ended' });
  assert.equal(again.info.alive, true); assert.equal(again.info.resumeId, 'conversation-1');
  service.kill('resume-fixture'); await service.flush();
  assert.equal(service.get(term.info.id).info.alive, true);
  service.deliver(term.info.id, 'delivery-across-detach', 44, Date.now());
  await service.detach(); service = null;
  await sleep(250); // Enter is sent by the host even though the API-side timer/process is gone.
  service = await TerminalService.open(profile, port, () => {});
  assert.equal(service.get(term.info.id).injectedMessage, 44);
  assert.ok(service.get(term.info.id).buffer.join('').includes('ANSWER:'));
  assert.match(service.get(term.info.id).buffer.join(''), /ANSWER:[^\n]*delivery-across-detach/);
  await service.detach(); service = null;
  console.log('PASS detach/reconnect: same PTY PID, credentials, cursors, draft, resize and input; wrong port rejected; an ended session restarts under its id');

  // Start the real API over the existing host, then replace the API twice (graceful shutdown and hard crash).
  await start();
  await waitFor('index', async () => (await request('/api/status')).data.stats.nodes > 0);
  const node = (await request('/api/path?p=' + encodeURIComponent(files))).data;
  assert.equal(node.id, 1, 'fixture terminal belongs to indexed root');
  const previewUrl = base + '/api/terminals/' + term.info.id + '/preview';
  const uiHeaders = { 'sec-fetch-site': 'same-origin' };
  assert.equal((await fetch(previewUrl)).status, 403);
  assert.equal((await fetch(previewUrl, { headers: { ...uiHeaders, authorization: 'Bearer fixture-token' } })).status, 403);
  const preview = await fetch(previewUrl, { headers: uiHeaders });
  assert.equal(preview.status, 200);
  const { text: recent } = await preview.json();
  assert.match(recent, /delivery-across-detach/);
  assert.ok(recent.split('\n').length <= 6 && recent.split('\n').every(line => line.length <= 240));
  console.log('PASS bounded preview of a detached terminal before the UI attaches');
  let output = await attach(term.info.id);
  await waitFor('replay', () => output().includes(`START:${pid}`));
  let board = await request('/api/work/1?session=persist-fixture', 'GET', undefined, 'fixture-token');
  assert.equal(board.status, 200);
  const task = await request('/api/work/1/tasks', 'POST', { from: 'persist-fixture', title: 'durable fixture', assignedTo: 'persist-fixture' }, 'fixture-token');
  assert.equal(task.status, 201);
  assert.equal((await request(`/api/work/1/tasks/${task.data.id}`, 'PATCH', { from: 'persist-fixture', status: 'working' }, 'fixture-token')).status, 200);
  // Attaching to it: back on the alternate screen first, then one row less and the real size, so the program redraws.
  const full = new WebSocket(`ws://127.0.0.1:${port}/ws/term?id=fullscreen-fixture`, { headers: { origin: base } });
  const frames = []; full.on('message', b => frames.push(String(b)));
  await new Promise((r, fail) => { full.once('open', r); full.once('error', fail); });
  await waitFor('fullscreen replay', () => frames.join('').includes('READY'));
  assert.equal(frames[0], '\x1b[?1049h', 'the alternate screen comes before the replay');
  full.send(JSON.stringify({ type: 'resize', cols: 101, rows: 31 }));
  await waitFor('repaint nudge', () => /(WINCH|SIZE):30 101[\s\S]*(WINCH|SIZE):31 101/.test(frames.join('')), 15000, () => JSON.stringify(frames.join('').slice(-300)));
  full.close();
  assert.equal((await request('/api/terminals/fullscreen-fixture', 'DELETE')).status, 200);
  console.log('PASS full-screen session: alternate screen restored before the replay, one repaint on the first size');
  socket.close(); await stop('SIGTERM');
  process.kill(pid, 0);
  await start(); output = await attach(term.info.id);
  socket.send(JSON.stringify({ type: 'input', data: 'after-graceful\r' }));
  await waitFor('same process after graceful restart', () => output().includes(`ANSWER:after-graceful:${pid}`));
  board = await request('/api/work/1?session=persist-fixture', 'GET', undefined, 'fixture-token');
  assert.equal(board.status, 200); assert.equal(board.data.tasks[0].assignedTo, 'persist-fixture'); assert.equal(board.data.tasks[0].status, 'working');
  assert.equal((await request('/api/work/1?session=persist-fixture', 'GET', undefined, 'wrong-token')).status, 403);
  assert.equal((await request('/api/terminals/persist-fixture', 'PATCH', { name: 'After restart' })).status, 200);
  socket.close(); await stop('SIGKILL');
  await start(); output = await attach(term.info.id);
  socket.send(JSON.stringify({ type: 'input', data: 'after-crash\r' }));
  await waitFor('same process after crash', () => output().includes(`ANSWER:after-crash:${pid}`));
  assert.equal((await request('/api/terminals')).data[0].name, 'After restart');
  assert.equal((await request('/api/work/1?session=persist-fixture', 'GET', undefined, 'fixture-token')).status, 200);
  assert.equal((await request('/api/terminals/persist-fixture', 'DELETE')).status, 200);
  await waitFor('explicit close terminates PTY', () => { try { process.kill(pid, 0); return false; } catch { return true; } });
  assert.deepEqual((await request('/api/terminals')).data, []);
  console.log('PASS real API graceful restart and SIGKILL: same PID/input/output, auth, assigned task and rename; explicit close still terminates');
  socket.close(); await stop('SIGTERM');
  await waitFor('empty detached host exits', () => !existsSync(join(profile, 'terminal-service/host.json')), 10000);
} finally {
  socket?.terminate();
  await stop('SIGTERM');
  if (!service && existsSync(join(profile, 'terminal-service/host.json'))) {
    try { service = await TerminalService.open(profile, port, () => {}); } catch {}
  }
  if (service) { try { service.killAll(); await service.flush(); await service.detach(); } catch {} }
  if (existsSync(join(profile, 'terminal-service/host.json'))) await waitFor('test host cleanup', () => !existsSync(join(profile, 'terminal-service/host.json')), 10000);
  rmSync(temp, { recursive: true, force: true });
}
