// Sessions survive a computer restart as ended sessions that «Riprendi» starts again.
// Uso: node scripts/test-session-registry.mjs — nessun server, nessun agente reale, profilo temporaneo.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Terminals } from '../src/server/terminals.ts';
import { KEEP_SESSIONS, RememberedSessions, readSessions } from '../src/server/session-registry.ts';
import { resumeSession } from '../src/server/sessions.ts';
import { DEFAULTS as BASE } from '../src/server/config.ts';

const DEFAULTS = { ...BASE, language: 'it' };
const temp = realpathSync(mkdtempSync(join(tmpdir(), 'vb-sessions-')));
const priorShell = process.env.SHELL;
const opened = [];
const service = () => { const t = new Terminals(() => {}); opened.push(t); return t; };
const ended = t => new Promise(ok => { const wait = () => t.info.alive ? setTimeout(wait, 20) : ok(); wait(); });
try {
  // Before the restart: a team member, a shell and a session that was closed explicitly.
  const before = new RememberedSessions(service(), temp, 'it');
  const member = await before.spawn({ agent: 'shell', cwd: temp, file: '/bin/sh', args: ['-c', 'sleep 30'], title: 'claude · fixture', nodeId: 7, role: 'operator', task: 'x', resumeId: 'conv-1', teamToken: 'token-1', seenMessage: 12, model: 'opus' });
  member.info.agent = 'claude'; // the fixture runs sh; the store keeps what the session is
  before.rename(member.info.id, 'Indice');
  const shell = await before.spawn({ agent: 'shell', cwd: temp, file: '/bin/sh', args: ['-c', 'exit 0'], title: 'shell · fixture', nodeId: 7 });
  await ended(shell);
  const closed = await before.spawn({ agent: 'shell', cwd: temp, file: '/bin/sh', args: ['-c', 'exit 0'], title: 'closed', nodeId: 7 });
  before.kill(closed.info.id);
  before.save();
  const file = join(temp, 'sessions.json');
  assert.equal(statSync(file).mode & 0o777, 0o600, 'the list and its board tokens are private to the user');
  const saved = readSessions(temp);
  assert.deepEqual(saved.map(s => s.info.id).sort(), [member.info.id, shell.info.id].sort(), 'a closed session is forgotten');
  const kept = saved.find(s => s.info.id === member.info.id);
  assert.equal(kept.info.name, 'Indice'); assert.equal(kept.info.resumeId, 'conv-1'); assert.equal(kept.teamToken, 'token-1'); assert.equal(kept.seenMessage, 12);
  assert.equal(kept.info.alive, undefined, 'live state is not written');
  console.log('PASS sessions written privately with name, conversation, token and cursor; closed ones forgotten');

  // The app only closed: the service still has them, nothing is duplicated.
  const reopened = new RememberedSessions(before.inner, temp, 'it');
  assert.equal(reopened.list().length, 2);
  assert.equal(reopened.get(member.info.id), before.inner.get(member.info.id), 'a live session stays the service’s own');
  console.log('PASS app reopened on the same service: same sessions, no copies');
  before.inner.killAll();

  // The computer restarted: a new, empty service. Both come back as ended, with «Riprendi» material.
  const after = new RememberedSessions(service(), temp, 'it');
  const back = after.get(member.info.id);
  assert.ok(back, 'the session is listed again');
  assert.equal(back.info.alive, false); assert.equal(back.info.name, 'Indice'); assert.equal(back.info.role, 'operator'); assert.equal(back.info.nodeId, 7);
  assert.equal(back.teamToken, 'token-1'); assert.equal(back.seenMessage, 12);
  assert.match(back.buffer.join(''), /riavvio del computer/);
  assert.equal(after.list().length, 2);
  after.write(member.info.id, 'x'); after.resize(member.info.id, 80, 20); // no process: nothing happens, nothing throws
  console.log('PASS after a restart the sessions are listed as ended, same id, name, role, node, token');

  // «Riprendi»: same id, a new process, the remembered row is replaced by the live one.
  process.env.SHELL = '/bin/sh';
  const teams = { get: () => ({ policy: { maxAgents: 4 } }), teamOf: () => '1', withCodes: list => list };
  const resumed = await resumeSession({ terms: after, teams, cfg: DEFAULTS }, shell.info.id, { cols: 90, rows: 20 });
  assert.equal(resumed.termId, shell.info.id);
  assert.equal(after.get(shell.info.id), after.inner.get(shell.info.id), 'the resumed session belongs to the new service');
  assert.equal(after.list().filter(s => s.id === shell.info.id).length, 1);
  after.save();
  assert.ok(readSessions(temp).some(s => s.info.id === shell.info.id), 'still remembered once resumed');
  console.log('PASS «Riprendi» after a restart starts the session again under the same id');

  // Closing a remembered session forgets it without touching the service.
  after.kill(member.info.id);
  assert.equal(after.get(member.info.id), undefined);
  assert.ok(!readSessions(temp).some(s => s.info.id === member.info.id));
  console.log('PASS closing a remembered session forgets it');

  // Bounded and robust: the most recent sessions only; a damaged file means none.
  const many = new RememberedSessions(service(), join(temp), 'it', false);
  for (let i = 0; i < KEEP_SESSIONS + 5; i++) await many.spawn({ agent: 'shell', cwd: temp, file: '/bin/sh', args: ['-c', 'exit 0'], title: `s${i}`, createdAt: 1_000 + i });
  many.save();
  assert.equal(readSessions(temp).length, KEEP_SESSIONS);
  many.inner.killAll();
  writeFileSync(file, '{not json'); assert.deepEqual(readSessions(temp), []);
  writeFileSync(file, JSON.stringify({ version: 1, sessions: [{ info: { id: '../x', agent: 'claude', cwd: temp }, teamToken: 't', seenMessage: 0 }] }));
  assert.deepEqual(readSessions(temp), [], 'an unsafe id is ignored');
  assert.ok(JSON.parse(readFileSync(file, 'utf8')));
  console.log('PASS at most the latest sessions are kept; damaged or unsafe entries are ignored');
} finally {
  process.env.SHELL = priorShell;
  for (const t of opened) t.killAll();
  rmSync(temp, { recursive: true, force: true });
}
