// Operators left without work must be handed work or reported to the orchestrator, locally and only once per reminder window.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Teams } from '../src/server/team.ts';
import { checkIdle, IDLE_AFTER_MS, MAX_REMINDERS, REMIND_EVERY_MS } from '../src/server/team-watch.ts';
import { idleMinutes } from '../src/ui/work-roles.ts';
import { setWorkState } from '../src/server/team-delivery.ts';

const dir = mkdtempSync(join(tmpdir(), 'vb-watch-'));
try {
  const teams = new Teams(dir);
  const written = [];
  const mk = (id, role, workState, idleSince) => ({ info: { id, role, nodeId: 7, alive: true, workState, idleSince, agent: 'codex', cwd: '/x', title: id, createdAt: 0 }, seenMessage: 0, proc: { write: s => written.push([id, s]) } });
  const terms = [mk('orc', 'orchestrator', 'idle', 0), mk('op1', 'operator', 'idle', 0), mk('op2', 'operator', 'working')];
  const ctx = { teams, cfg: { host: '127.0.0.1', port: 1 }, terms: { list: () => terms.map(t => t.info), get: id => terms.find(t => t.info.id === id) } };
  const reminded = new Map();
  const inbox = id => teams.get(7).messages.filter(m => m.to === id);

  assert.deepEqual(checkIdle(ctx, IDLE_AFTER_MS - 1, reminded), { nudged: [], reported: [] }, 'not idle long enough');
  const first = checkIdle(ctx, IDLE_AFTER_MS, reminded);
  assert.deepEqual(first.reported, ['op1'], 'idle operator is reported to the orchestrator');
  assert.equal(inbox('orc').length, 1);
  assert.match(inbox('orc')[0].text, /op1/);
  assert.equal(inbox('orc')[0].from, 'visual-brain');
  assert.ok(written.some(([id]) => id === 'orc'), 'the idle orchestrator is woken');
  assert.deepEqual(checkIdle(ctx, IDLE_AFTER_MS + 1000, reminded), { nudged: [], reported: [] }, 'no repeated reminder inside the window');
  assert.deepEqual(checkIdle(ctx, IDLE_AFTER_MS + REMIND_EVERY_MS, reminded).reported, ['op1'], 'reminded again after the window');

  // A busy operator is never reported, an assigned one neither.
  const task = teams.createTask(7, 'orc', { title: 'fai', assignedTo: 'op1' });
  assert.deepEqual(checkIdle(ctx, IDLE_AFTER_MS + 3 * REMIND_EVERY_MS, reminded), { nudged: [], reported: [] }, 'operator with an open task is not free');
  teams.changeTask(7, task.id, 'op1', 'operator', { status: 'done', result: 'ok' });

  // With unassigned work the operator is told to claim it instead of bothering the orchestrator.
  teams.createTask(7, 'orc', { title: 'coda' });
  const before = inbox('orc').length;
  const second = checkIdle(ctx, IDLE_AFTER_MS + 5 * REMIND_EVERY_MS, reminded);
  assert.deepEqual(second.nudged, ['op1']);
  assert.equal(inbox('orc').length, before);
  assert.match(inbox('op1').at(-1).text, /rivendica/);

  // The same unchanged situation is reminded at most MAX_REMINDERS times, further apart each time, then never again.
  // Each nudge wakes the operator; it answers without taking work and goes idle again (a new idle stretch, not a change).
  const t0 = IDLE_AFTER_MS + 5 * REMIND_EVERY_MS;
  const at = now => { setWorkState(terms[1].info, 'idle', 'hook', now - IDLE_AFTER_MS); return checkIdle(ctx, now, reminded).nudged; };
  assert.deepEqual(at(t0 + REMIND_EVERY_MS - 1), [], 'not before the window');
  assert.deepEqual(at(t0 + REMIND_EVERY_MS), ['op1'], 'second reminder');
  assert.deepEqual(at(t0 + 2 * REMIND_EVERY_MS), [], 'the third waits twice as long');
  assert.deepEqual(at(t0 + 3 * REMIND_EVERY_MS), ['op1'], 'third reminder');
  assert.equal(MAX_REMINDERS, 3);
  assert.match(inbox('op1').at(-1).text, /Ultimo avviso/, 'the last reminder says so');
  const sent = inbox('op1').length;
  for (let i = 4; i < 100; i++) at(t0 + i * REMIND_EVERY_MS);
  assert.equal(inbox('op1').length, sent, 'silence while nothing changes');
  teams.createTask(7, 'orc', { title: 'altro' });
  assert.deepEqual(at(t0 + 101 * REMIND_EVERY_MS), ['op1'], 'new work in the queue restarts them');
  // Ended sessions are forgotten.
  terms[1].info.alive = false;
  checkIdle(ctx, t0 + 102 * REMIND_EVERY_MS, reminded);
  assert.ok(![...reminded.values()].some(r => r.session === 'op1'));
  terms[1].info.alive = true;

  // setWorkState keeps idleSince in step with the state.
  const info = { workState: 'working' };
  setWorkState(info, 'idle'); assert.equal(typeof info.idleSince, 'number');
  const since = info.idleSince; setWorkState(info, 'idle'); assert.equal(info.idleSince, since, 'staying idle keeps the original time');
  setWorkState(info, 'working'); assert.equal(info.idleSince, undefined);
  const waiting = { alive: true, role: 'operator', workState: 'idle', idleSince: 0 };
  assert.equal(idleMinutes(waiting, 30_000), null, 'under a minute is not worth showing');
  assert.equal(idleMinutes(waiting, 7 * 60_000 + 5), 7);
  assert.equal(idleMinutes({ ...waiting, role: 'orchestrator' }, 9e6), null);
  assert.equal(idleMinutes({ ...waiting, workState: 'working' }, 9e6), null);
  assert.equal(idleMinutes({ ...waiting, alive: false }, 9e6), null);
  console.log('team-watch: ok');
} finally { rmSync(dir, { recursive: true, force: true }); }
