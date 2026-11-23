// Status lights: what the agent declares, corrected by what the server observes (hooks, output, input, prompts).
// Uso: node scripts/test-work-roles.mjs — nessun server, nessuna app.
import assert from 'node:assert/strict';
import { setLanguage } from '../src/ui/i18n.ts';
import { BUSY_WINDOW_MS, STALE_AFTER_MS, TONES, idleMinutes, parseRoleChoice, roleChangeable, roleChoices, roleLineHtml, roleTargetLabel, sessionTone, toneFlag, toneReason } from '../src/ui/work-roles.ts';

setLanguage('it');
const NOW = 10_000_000, s = n => NOW - n * 1000, min = n => NOW - n * 60_000;
const op = { alive: true, role: 'operator' };

// [description, session, expected tone, expected reason (string or RegExp)]
const cases = [
  // older server: no observed fields, exactly the previous behaviour
  ['old server: working operator', { ...op, workState: 'working' }, 'active', 'Al lavoro'],
  ['old server: not reported yet', { ...op }, 'active', 'In esecuzione'],
  ['old server: idle operator', { ...op, workState: 'idle', idleSince: min(4) }, 'idle', 'In attesa da 4 min'],
  ['old server: idle under a minute', { ...op, workState: 'idle', idleSince: s(20) }, 'idle', 'In attesa'],
  ['notice written', { ...op, workState: 'idle', noticeSentAt: s(4) }, 'idle', 'Avviso inviato al terminale'],
  ['announced page confirmed', { ...op, workState: 'idle', noticeSentAt: s(4), noticeConfirmed: true }, 'idle', 'Eventi confermati dal client'],
  ['old server: blocked', { ...op, workState: 'blocked' }, 'blocked', 'Bloccato'],
  ['old server: orchestrator fixed', { alive: true, role: 'orchestrator', workState: 'idle' }, 'orchestrator', 'In attesa'],
  ['terminated, whatever it declared', { ...op, alive: false, workState: 'working', lastOutputAt: s(1) }, 'ended', 'Terminato'],
  ['terminated orchestrator', { alive: false, role: 'orchestrator', attention: 'input' }, 'ended', 'Terminato'],
  ['plain terminal has no tone', { alive: true, lastOutputAt: s(1) }, null, /^Al lavoro/],
  // attention wins over everything alive, the orchestrator included
  ['waiting for a permission', { ...op, workState: 'working', attention: 'permission', lastOutputAt: s(1) }, 'attention', 'Serve un permesso nel terminale'],
  ['waiting for an answer', { ...op, workState: 'idle', attention: 'input' }, 'attention', 'C’è una domanda nel terminale'],
  ['orchestrator waiting for the person', { alive: true, role: 'orchestrator', attention: 'permission' }, 'attention', /^Serve un permesso/],
  ['blocked beats busy', { ...op, workState: 'blocked', lastOutputAt: s(1) }, 'blocked', 'Bloccato'],
  // user case 1: "a volte è giallo ma sta andando" — declared idle, the person asked it something directly
  ['declared idle but busy output', { ...op, workState: 'idle', stateSource: 'agent', idleSince: min(30), lastInputAt: s(8), lastOutputAt: s(5) }, 'active', 'Al lavoro · attività 5 s fa'],
  ['busy window edge', { ...op, workState: 'idle', lastOutputAt: NOW - BUSY_WINDOW_MS }, 'active', /^Al lavoro/],
  ['just past the busy window', { ...op, workState: 'idle', idleSince: min(3), lastOutputAt: NOW - BUSY_WINDOW_MS - 1 }, 'idle', 'In attesa da 3 min'],
  ['hook working, no output observed at all', { ...op, workState: 'working', stateSource: 'hook', stateAt: min(30) }, 'active', 'Al lavoro'],
  ['hook working + Esc interrupt, no output for 3 min', { ...op, workState: 'working', stateSource: 'hook', stateAt: min(5), lastOutputAt: min(3) }, 'stale', 'Nessuna attività da 3 min'],
  ['hook working, output a minute ago', { ...op, workState: 'working', stateSource: 'hook', stateAt: min(5), lastOutputAt: s(60) }, 'active', 'Al lavoro · attività 1 min fa'],
  ['hook turn ended after the last busy output', { ...op, workState: 'idle', stateSource: 'hook', stateAt: s(2), lastOutputAt: s(3), idleSince: s(2) }, 'idle', 'In attesa'],
  // user case 2: "a volte non sta facendo nulla ma il colore è verde" — the server injected a message, the agent stopped
  ['server-set working, silent for 12 min', { ...op, workState: 'working', stateSource: 'server', stateAt: min(12) }, 'stale', 'Nessuna attività da 12 min'],
  ['agent forgot to report idle', { ...op, workState: 'working', stateSource: 'agent', stateAt: min(40), lastOutputAt: min(9) }, 'stale', 'Nessuna attività da 9 min'],
  ['working claim still recent', { ...op, workState: 'working', stateSource: 'agent', stateAt: s(90) }, 'active', 'Al lavoro'],
  ['recent input keeps the claim fresh', { ...op, workState: 'working', stateAt: min(20), lastInputAt: s(30) }, 'active', 'Al lavoro'],
  ['stale edge', { ...op, workState: 'working', stateAt: NOW - STALE_AFTER_MS }, 'stale', /Nessuna attività da 2 min/],
  ['recent output, outside busy window', { ...op, workState: 'working', stateAt: min(5), lastOutputAt: s(45) }, 'active', 'Al lavoro · attività 45 s fa'],
  ['orchestrator never shows stale', { alive: true, role: 'orchestrator', workState: 'working', stateAt: min(30) }, 'orchestrator', /^Nessuna attività/],
  ['reviewer follows the operator rules', { alive: true, role: 'reviewer', workState: 'working', stateAt: min(30) }, 'stale', /^Nessuna attività/],
];

for (const [name, session, tone, reason] of cases) {
  assert.equal(sessionTone(session, NOW), tone, `${name}: tone`);
  const text = toneReason(session, NOW);
  if (reason instanceof RegExp) assert.match(text, reason, `${name}: reason`); else assert.equal(text, reason, `${name}: reason`);
}

// idleMinutes: unchanged for an idle operator, silent when observation says it is not idle at all.
const waiting = { ...op, workState: 'idle', idleSince: 0 };
for (const [name, session, now, expected] of [
  ['under a minute', waiting, 30_000, null],
  ['seven minutes', waiting, 7 * 60_000 + 5, 7],
  ['orchestrator', { ...waiting, role: 'orchestrator' }, 9e6, null],
  ['working', { ...waiting, workState: 'working' }, 9e6, null],
  ['ended', { ...waiting, alive: false }, 9e6, null],
  ['busy despite idle', { ...waiting, lastOutputAt: 9e6 - 1000 }, 9e6, null],
  ['waiting for the person', { ...waiting, attention: 'input' }, 9e6, null],
]) assert.equal(idleMinutes(session, now), expected, `idleMinutes: ${name}`);

assert.equal(TONES.length, new Set(TONES).size, 'tones are distinct');
for (const tone of ['attention', 'stale']) assert.ok(TONES.includes(tone), `${tone} is a tone`);
assert.equal(toneFlag('attention'), 'Da rispondere');
assert.equal(toneFlag('stale'), 'Inattivo');
assert.equal(toneFlag('active'), '');
assert.equal(toneFlag('blocked'), 'Bloccato');
assert.equal(toneFlag('attention', { ...op, attention: 'permission' }), 'Permesso richiesto');
assert.equal(sessionTone({ ...op, workState: 'idle' }), 'idle', '`now` defaults to the clock');

setLanguage('en');
assert.equal(toneReason({ ...op, workState: 'idle', lastOutputAt: s(5) }, NOW), 'Working · last activity 5 s ago');
assert.equal(toneReason({ ...op, workState: 'working', stateAt: min(12) }, NOW), 'No activity for 12 min');
assert.equal(toneReason({ ...op, workState: 'idle', idleSince: min(4) }, NOW), 'Idle for 4 min');
assert.equal(toneReason({ ...op, attention: 'permission' }, NOW), 'Permission needed in the terminal');
assert.equal(toneReason({ ...op, attention: 'input' }, NOW), 'There is a question in the terminal');
assert.equal(toneReason({ ...op, workState: 'working', lastOutputAt: min(1), stateSource: 'hook' }, NOW), 'Working · last activity 1 min ago');
assert.equal(toneFlag('stale'), 'Inactive');
setLanguage('it');

// The role menu of a session: each role in each squad, the orchestrator taken by someone else shown but not offered.
{
  const one = [{ id: '1', name: 'Bacheca', orchestrator: 'ORC1' }];
  const op3 = roleChoices({ agent: 'claude', role: 'operator', code: 'OP3', teamId: '1' }, one);
  assert.deepEqual(op3.map(c => c.value), ['orchestrator@1', 'operator@1', 'reviewer@1', 'none']);
  assert.equal(op3[0].disabled, true); assert.equal(op3[0].label, 'Orchestratore · ORC1');
  assert.equal(op3.find(c => c.selected).value, 'operator@1'); assert.equal(op3[0].group, undefined, 'one squad: no group headings');
  const orc = roleChoices({ agent: 'claude', role: 'orchestrator', code: 'ORC1', teamId: '1' }, one);
  assert.equal(orc[0].disabled, undefined, 'its own orchestrator role stays selectable');
  const two = [...one, { id: '2', name: 'Stats', orchestrator: null }];
  const shell = roleChoices({ agent: 'shell', inner: 'claude' }, two);
  assert.deepEqual(shell[0], { value: '', label: 'Aggiungi alla squadra…', selected: true, disabled: true });
  assert.deepEqual(shell.slice(1).map(c => c.group), ['Bacheca', 'Bacheca', 'Bacheca', 'Stats', 'Stats', 'Stats']);
  assert.ok(!shell.some(c => c.value === 'none'), 'nothing to leave yet');
  assert.equal(shell[4].disabled, undefined, 'a squad without orchestrator offers the role');
  assert.deepEqual(parseRoleChoice('reviewer@2'), { role: 'reviewer', teamId: '2' });
  assert.deepEqual(parseRoleChoice('none'), { role: null });
  assert.equal(parseRoleChoice('brain@1'), null); assert.equal(parseRoleChoice(''), null);
  assert.equal(roleTargetLabel({ role: 'reviewer', teamId: '2' }, two), 'Revisore · Stats');
  assert.equal(roleTargetLabel({ role: 'reviewer', teamId: '1' }, one), 'Revisore');
  assert.equal(roleTargetLabel({ role: null }, two), 'Nessun ruolo');
  assert.equal(roleChangeable({ alive: true, nodeId: 1, agent: 'claude' }), true, 'a Claude session without a role can join');
  assert.equal(roleChangeable({ alive: true, nodeId: 1, agent: 'shell' }), false, 'a plain terminal with nothing inside');
  assert.equal(roleChangeable({ alive: true, nodeId: 1, agent: 'shell', inner: 'codex' }), true);
  assert.equal(roleChangeable({ alive: true, nodeId: null, agent: 'claude' }), false, 'outside nodes there are no squads');
  assert.equal(roleChangeable({ alive: true, nodeId: 1, agent: 'claude', role: 'brain' }), false);
  assert.equal(roleChangeable({ alive: false, nodeId: 1, agent: 'claude', role: 'operator' }), false);
  assert.equal(roleChangeable({ alive: true, nodeId: 1, agent: 'hermes', role: 'operator' }), false);
  const waiting = roleLineHtml({ id: 'ab', agent: 'claude', role: 'operator', code: 'OP3', teamId: '1', roleChange: { role: 'reviewer', teamId: '1', state: 'waiting' } }, one);
  assert.match(waiting, /<select data-role-select="ab" aria-label="Ruolo di OP3"[^>]* disabled>/);
  assert.match(waiting, /→ Revisore · alla fine del turno/); assert.match(waiting, /data-role-now="ab"[^>]*>Subito</); assert.match(waiting, /data-role-cancel="ab">Annulla</);
  const failed = roleLineHtml({ id: 'ab', agent: 'claude', role: 'operator', code: 'OP3', teamId: '1', roleChange: { role: 'orchestrator', state: 'failed', message: 'Questa <squadra>' } }, one);
  assert.match(failed, /work-model-state warn">Questa &lt;squadra&gt;</);
  const hand = roleLineHtml({ id: 'sh', agent: 'shell', inner: 'claude' }, [...one, { id: '2', name: 'S"tats', orchestrator: null }]);
  assert.match(hand, /<optgroup label="Bacheca">.*<\/optgroup><optgroup label="S&quot;tats">.*<\/optgroup><\/select>/);
  assert.match(hand, />Claude Code avviato a mano</);
  console.log('PASS role menu: roles per squad, taken orchestrator not offered, plain terminal joins, values parsed');
}

console.log(`work-roles: ok (${cases.length} cases)`);
