// Operator status lights: what the terminal shows (busy spinners, real output, prompts for the person) and what the agent or
// its Claude Code hooks report must be recorded faithfully. Fake data and fake PTYs only, no real agent is started.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendOutput, attentionIn, busyMarker, busyTitle, confirmComposerReturn, noticeInputBlocked, newActivity, noteInjected, noteInput, noteResize, scanOutput, setAttention, stripAnsi, QUIET_AFTER_RESIZE_MS } from '../src/server/activity.ts';
import { setWorkState, wakeSession, deliveryNotice, QUIET_AFTER_MS } from '../src/server/team-delivery.ts';
import { checkIdle, ATTENTION_AFTER_MS, STALE_AFTER_MS, REMIND_EVERY_MS } from '../src/server/team-watch.ts';
import { claudeHookSettings, launchEmbedded } from '../src/server/launch.ts';
import { Terminals } from '../src/server/terminals.ts';
import { Teams } from '../src/server/team.ts';
import { DEFAULTS } from '../src/server/config.ts';

// Chunks as Claude Code 2.1 and Codex 0.162 write them (captured from live sessions).
const IDLE_REPAINTS = [
  '\x1b(B\x0f\x1b[?2004h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h',
  '\x1b[?25l\x1b[H\r\x1b[77C\x1b[21B\x1b[38;5;243m5\x1b[39m\x1b[24;1H\x1b[20;3H\x1b[?25h',
  '\x1b[?25l\x1b[H\r\x1b[76C\x1b[21B\x1b[38;5;243m1h00m\x1b[39m\x1b[24;1H\x1b[20;3H\x1b[?25h',
  '\x1b[?25l\x1b[H\r\x1b[89C\x1b[17B\x1b[38;2;153;153;153mChecking for updates\x1b[39m\x1b[24;1H\x1b[20;3H\x1b[?25h',
  '\x1b[?25l\x1b[H\r\x1b[89C\x1b[17B\x1b[K\x1b[24;1H\x1b[20;3H\x1b[?25h',
];
const RECAP = '\x1b[2m※ recap: Stavo leggendo i nuovi messaggi della bacheca del nodo 138 in Visual Brain per gestire il mio incarico, ma il server risponde 403 perché mi manca il token Bearer della sessione. Prossima azione: incollami il token oppure riavvia la sessione. (disable recaps in /config)\x1b[22m';
const CLAUDE_SPINNER = '\x1b[?25l\x1b[18;1H\x1b[38;2;215;119;87m✽\x1b[39m \x1b[38;2;215;119;87mManifesting…\x1b[39m \x1b[2m(3m 56s · ↓ 16.4k tokens · thinking with high effort)\x1b[22m\x1b[?25h';
const CLAUDE_GLYPH = '\x1b[?25l\x1b[18;1H\x1b[38;2;215;119;87m✢\x1b[39m\x1b[24;1H\x1b[?25h';
const CLAUDE_TIMER = '\x1b[18;20H\x1b[2m4\x1b[1C0s · ↓ 16.4k tokens)\x1b[22m';
const CODEX_WORKING = '\x1b[1m•\x1b[22m \x1b[38;5;245mWorking\x1b[39m \x1b[2m(1m 11s • esc to interrupt)\x1b[22m';
const CODEX_SHIMMER = '\x1b[22;3H\x1b[1mW\x1b[22mo\x1b[2mrking\x1b[22m';
const ANSWER = '\x1b[1m⏺\x1b[22m ' + 'Ho controllato la release pubblicata: la 0.2.11 è sul feed e il pacchetto firmato è presente. '.repeat(3);
const CLAUDE_PERMISSION = '\x1b[38;5;174m╭──────────────╮\x1b[39m\r\n│ Bash command │\r\n│   rm -rf dist │\r\n│ Do you want to proceed?\r\n│ \x1b[36m❯\x1b[39m 1. Yes\r\n│   2. Yes, and don\'t ask again for rm commands\r\n│   3. No, and tell Claude what to do differently (esc)';
const CODEX_APPROVAL = '  Would you like to run the following command?\r\n  $ npm publish\r\n› 1. Yes, proceed (y)\r\n  2. No, and tell Codex what to do differently (esc)';
const CLAUDE_QUESTION = '☐ Formato\r\n\r\nChe formato preferisci per il report?\r\n\r\n❯ 1. Markdown\r\n  2. HTML\r\n\r\nEnter to select · ↑/↓ to navigate · Esc to cancel';

// The window title: Claude alternates ◐/◑ during a turn and shows ✳ when waiting; Codex animates a braille spinner.
const CLAUDE_TITLE_BUSY = '\x1b]0;◐ Visual Brain nodo 138 bacheca\x07';
const CLAUDE_TITLE_IDLE = '\x1b]0;✳ Visual Brain nodo 138 bacheca\x07';
const CODEX_TITLE_BUSY = '\x1b]0;⠇ Consulta bacheca e attendi | vm\x07\x1b[?2026h\x1b[39m\x1b[49m\x1b[0m\x1b[21;3H\x1b[?25h\x1b[?2026l';

const fresh = () => ({ a: newActivity(), info: { id: 's1', role: 'operator', agent: 'codex', alive: true, workState: 'working' } });
const feed = (a, info, chunks, now) => { for (const c of chunks) appendOutput(a, c); scanOutput(a, info, now); };

// ANSI stripping keeps words apart where the cursor jumps, and drops colours, OSC titles and cursor moves.
assert.equal(stripAnsi('\x1b]0;✳ Claude Code\x07\x1b[1mok\x1b[22m'), 'ok');
assert.equal(stripAnsi('Ciao\x1b[3Cmondo\r\n'), 'Ciao mondo\n');
assert.equal(stripAnsi(CLAUDE_SPINNER).trim(), '✽ Manifesting… (3m 56s · ↓ 16.4k tokens · thinking with high effort)');
for (const busy of [CLAUDE_SPINNER, CLAUDE_TIMER, CODEX_WORKING].map(stripAnsi)) assert.ok(busyMarker(busy, true), `strong busy marker: ${busy}`);
for (const busy of [CLAUDE_GLYPH, CODEX_SHIMMER].map(stripAnsi)) assert.ok(busyMarker(busy) && !busyMarker(busy, true), `weak marker, ignored while the screen is redrawn: ${busy}`);
for (const idle of [...IDLE_REPAINTS, RECAP, '✻ Brewed for 9s · done 17:03'.replace('✻', '')].map(stripAnsi)) assert.ok(!busyMarker(idle), `idle repaint is not busy: ${idle}`);
assert.ok(busyTitle(CLAUDE_TITLE_BUSY) && busyTitle(CODEX_TITLE_BUSY) && busyTitle(CLAUDE_TITLE_IDLE + CLAUDE_TITLE_BUSY));
assert.ok(!busyTitle(CLAUDE_TITLE_IDLE) && !busyTitle(CLAUDE_TITLE_BUSY + CLAUDE_TITLE_IDLE) && !busyTitle('◐ not a title'), 'the last title wins');
console.log('PASS ANSI stripping and busy markers (Claude spinner, timer, Codex "esc to interrupt")');

{
  const { a, info } = fresh();
  for (let i = 0; i < 40; i++) feed(a, info, IDLE_REPAINTS, 1000 + i * 300);
  feed(a, info, [RECAP], 20_000);
  assert.equal(info.lastOutputAt, undefined, 'status line repaints and recaps of an idle agent are not activity');
  feed(a, info, [CLAUDE_TITLE_IDLE], 20_500);
  assert.equal(info.lastOutputAt, undefined, 'the idle title is not activity');
  feed(a, info, [CODEX_TITLE_BUSY], 20_700);
  assert.equal(info.lastOutputAt, 20_700, 'a busy title is, even with no printable text');
  feed(a, info, [CLAUDE_GLYPH], 21_000);
  assert.equal(info.lastOutputAt, 21_000, 'a spinner frame is');
  feed(a, info, [CODEX_SHIMMER], 22_000);
  assert.equal(info.lastOutputAt, 22_000);
  feed(a, info, [ANSWER], 23_000);
  assert.equal(info.lastOutputAt, 23_000, 'a substantial new answer is activity');
  noteResize(a, 30_000);
  feed(a, info, [ANSWER, '\x1b[1m⏺\x1b[22m ✻ Brewed for 9s · Working directory'], 30_500);
  assert.equal(info.lastOutputAt, 23_000, 'the full redraw after a resize is not activity');
  feed(a, info, [CLAUDE_SPINNER], 31_000);
  assert.equal(info.lastOutputAt, 31_000, 'a real spinner counts even right after a resize');
  feed(a, info, [ANSWER], 30_000 + QUIET_AFTER_RESIZE_MS + 1);
  assert.equal(info.lastOutputAt, 30_000 + QUIET_AFTER_RESIZE_MS + 1);
  noteInjected(a, 40_000);
  feed(a, info, ['Visual Brain: nuovi messaggi nella bacheca del nodo. Leggi GET http://127.0.0.1:4747/api/work/138?session=s1 con il tuo header Authorization e gestisci soltanto il tuo incarico.'.repeat(2)], 40_200);
  assert.equal(info.lastOutputAt, 30_000 + QUIET_AFTER_RESIZE_MS + 1, 'the echo of a pasted delivery is not activity');
  // An escape sequence split across two scans is not read as text.
  appendOutput(a, 'x\x1b[38;5;2'); scanOutput(a, info, 50_000);
  assert.equal(a.pending, '\x1b[38;5;2');
  appendOutput(a, '43m5\x1b[39m'); scanOutput(a, info, 50_300);
  assert.equal(a.pending, '');
}
console.log('PASS idle repaints, recaps, resize redraws and delivery echo do not bump lastOutputAt; spinners and new text do');

{
  const { a, info } = fresh();
  noteInput(a, info, '\x1b[<35;10;5M\x1b[<35;11;5M\x1b[I', 1000);
  assert.equal(a.quietUntil, 0, 'mouse moves and focus reports are not typing');
  noteInput(a, info, '\x1b[12;40R\x1b[?1;2c', 1500);
  assert.equal([a.quietUntil, info.lastInputAt].join(), '0,', 'the terminal\'s automatic replies are not typing');
  for (const key of ['\x1b','\x1b[C','\x1b[B','\x1bOC','\x1bOB','\x1b[Z']) {
    noteInput(a, info, key, 1600);
    assert.equal(noticeInputBlocked(a,info),false, 'plain navigation in an empty composer leaves it empty');
    assert.equal(info.lastInputAt,1600);
  }
  noteInput(a, info, 'ciao', 2000);
  assert.equal(info.lastInputAt, 2000, 'any key: the person is there');
  assert.equal(a.draft, true, 'an unsent draft');
  noteInput(a, info, '\x1b[200~riga uno\rriga due\x1b[201~', 2500);
  assert.equal(a.draft, true, 'a multi-line paste is not a submit');
  noteInput(a, info, '\x1b[D', 2700);
  assert.equal(a.draft, true, 'arrows keep the draft');
  noteInput(a, info, '\x1b[Z', 2750);
  noteInput(a, info, '\x1b', 2800);
  assert.equal(a.draft,true,'backtab and Esc protect existing text');
  noteInput(a, info, '\r', 3000);
  assert.deepEqual([info.lastInputAt, a.draft], [3000, false], 'Enter sends it');
  noteInput(a, info, 'x', 3100); noteInput(a, info, '\x03', 3200);
  assert.equal(a.draft, false, 'Ctrl-C clears it');
  noteInput(a, info, '\x1b[A', 3300);
  assert.equal(noticeInputBlocked(a,info), true, 'Up may recall an unrelated history entry');
  noteInput(a, info, '\rnext', 3400);
  assert.equal(a.draft, true, 'new input after an Enter is a draft');
  noteInput(a, info, '\r\x1b[C\x1b[Z', 3500);
  assert.equal(a.draft,false,'navigation after a submit does not start a new draft');
  noteInput(a, info, '\x1b[Dtext\x1b[C', 3600);
  assert.equal(a.draft,true,'navigation framing text does not hide an edit');
  for (const edit of ['\t','\x19','\x1bq','\x1b[99~','\x1b[200~\x1b[D\r\x1b[201~']) {
    noteInput(a, info, '\x03'+edit, 3700);
    assert.equal(a.draft,true,'completion, yank, unknown keys and pasted input remain guarded');
  }
}
console.log('PASS lastInputAt on every key from the person; drafts tracked until Enter or Ctrl-C');

{
  const { a, info } = fresh();
  const empty = '\x1b[?2026h\x1b[16;3H\x1b[2mAsk Codex to do anything\x1b[19;3H\x1b[22m\x1b[16;3H\x1b[?25h\x1b[?2026l';
  for (const [enter, back] of [['\x1b[D','\x1b'], ['\x1b[A','\x1b[B'], ['\x1b\x1b','\x1b']]) {
    noteInput(a,info,enter);
    assert.ok(noticeInputBlocked(a,info),'another view or history entry owns Enter');
    assert.equal(confirmComposerReturn(a,info,empty),false,'a repaint without a return gesture cannot release the guard');
    noteInput(a,info,back);
    assert.equal(confirmComposerReturn(a,info,'› Ask Codex to do anything · ? for shortcuts'),false,'plain output is not the composer');
    assert.ok(noticeInputBlocked(a,info));
    assert.equal(confirmComposerReturn(a,info,empty.slice(0,20)),false);
    assert.equal(confirmComposerReturn(a,info,empty.slice(20)),true,'split render restores the empty input and cursor');
    assert.ok(!noticeInputBlocked(a,info));
  }
  noteInput(a,info,'UNSENT'); noteInput(a,info,'\x1b[A'); noteInput(a,info,'\x1b[B');
  assert.equal(confirmComposerReturn(a,info,empty),false,'history navigation never releases a real draft');
  assert.ok(noticeInputBlocked(a,info));
  const other = fresh();
  noteInput(other.a,other.info,'/model',800);
  noteInput(other.a,other.info,'\r',850);
  assert.ok(noticeInputBlocked(other.a,other.info),'the command owns Enter even before its selector is painted');
  feed(other.a,other.info,[CLAUDE_QUESTION],870);
  noteInput(other.a,other.info,'\x1b',900);
  setAttention(other.a,other.info,'input',920);
  const resetBeforeDim = empty.replace('3H\x1b[2m','3H\x1b[22m\x1b[2m');
  assert.ok(confirmComposerReturn(other.a,other.info,resetBeforeDim),'recognize the partial repaint after early Esc, including its intensity reset');
  assert.equal(other.info.attention,undefined);
  feed(other.a,other.info,[CLAUDE_QUESTION,empty],1000);
  assert.equal(other.info.attention,undefined,'a fully repainted composer supersedes the earlier selector in the same scan');
  feed(other.a,other.info,[empty,CODEX_APPROVAL],1500);
  assert.equal(other.info.attention,'permission','a newer permission prompt wins over an earlier empty composer');
  noteInput(other.a,other.info,'\x1b[A',1600);
  assert.ok(noticeInputBlocked(other.a,other.info));
}

{
  assert.equal(attentionIn(stripAnsi(CLAUDE_PERMISSION)), 'permission');
  assert.equal(attentionIn(stripAnsi(CODEX_APPROVAL)), 'permission');
  assert.equal(attentionIn(stripAnsi(CLAUDE_QUESTION)), 'input');
  assert.equal(attentionIn(stripAnsi(ANSWER)), null);
  const { a, info } = fresh();
  feed(a, info, [CLAUDE_PERMISSION], 10_000);
  assert.equal(info.attention, 'permission');
  assert.equal(a.attentionAt, 10_000);
  feed(a, info, IDLE_REPAINTS, 11_000);
  assert.equal(info.attention, 'permission', 'repaints keep the prompt');
  noteInput(a, info, '\x1b[B', 12_000);
  assert.equal(info.attention, 'permission', 'moving through the choices does not answer');
  assert.ok(!a.draft,'selection inside a permission dialog is not composer text');
  noteInput(a, info, '\r', 13_000);
  assert.equal(info.attention, undefined, 'Enter answers the prompt');
  assert.equal(a.attentionAt, undefined);
  feed(a, info, [CODEX_APPROVAL], 20_000);
  assert.equal(info.attention, 'permission');
  feed(a, info, [CODEX_WORKING, CODEX_TITLE_BUSY], 21_000);
  assert.equal(info.attention, 'permission', 'Codex spinners alone may keep running under an approval: not an answer');
  feed(a, info, [ANSWER], 21_500);
  assert.equal(info.attention, undefined, 'new text replacing the prompt clears it');
  feed(a, info, [CLAUDE_PERMISSION, CLAUDE_TITLE_IDLE], 21_600);
  assert.equal(info.attention, 'permission');
  feed(a, info, [CLAUDE_TITLE_BUSY], 21_700);
  assert.equal(info.attention, undefined, 'Claude resuming its turn (busy title) clears it');
  feed(a, info, [CLAUDE_QUESTION], 22_000);
  assert.equal(info.attention, 'input');
  noteInput(a, info, 'n', 23_000);
  assert.equal(info.attention, 'input', 'in a free answer box a letter is the start of the reply, not the answer');
  noteInput(a, info, '\r', 23_500);
  assert.equal(info.attention, undefined, 'Enter answers the question');
  feed(a, info, [CLAUDE_PERMISSION, CLAUDE_TITLE_IDLE], 23_600);
  noteInput(a, info, '2', 23_700);
  assert.equal(info.attention, undefined, 'a choice key answers a permission dialog');
  // the same words in the agent's prose or in a diff are not a dialog
  for (const prose of ['Do you want to run the full test suite now?', '+  if (/Do you want to [^?]+\\?|Yes, proceed/.test(text))', 'Type your answer below and Enter to continue'])
    assert.equal(attentionIn(prose), null, prose);
  setAttention(a, info, 'input', 24_000); setAttention(a, info, 'permission', 25_000);
  assert.equal(a.attentionAt, 24_000, 'the waiting time starts with the first prompt');
}
console.log('PASS attention detected from Claude/Codex prompts and cleared by the answer or by busy output');

{
  const info = { workState: 'idle', idleSince: 5 };
  setWorkState(info, 'working', 'server', 100);
  assert.deepEqual(info, { workState: 'working', idleSince: undefined, stateSource: 'server', stateAt: 100 });
  setWorkState(info, 'idle', 'hook', 200);
  assert.deepEqual([info.workState, info.stateSource, info.stateAt, info.idleSince], ['idle', 'hook', 200, 200]);
  setWorkState(info, 'idle', 'agent', 300);
  assert.deepEqual([info.stateSource, info.stateAt, info.idleSince], ['agent', 300, 200], 'a repeated report refreshes stateAt, idleSince keeps the start');
  setWorkState(info, 'blocked');
  assert.equal(info.stateSource, 'agent', 'the API default is the agent');
}
console.log('PASS setWorkState records stateSource and stateAt');

const dir = mkdtempSync(join(tmpdir(), 'vb-state-'));
try {
  const teams = new Teams(dir);
  const written = [];
  const mk = (id, role, extra = {}) => ({ info: { id, role, nodeId: 7, alive: true, agent: 'claude', cwd: '/x', title: id, createdAt: 0, ...extra }, seenMessage: 0, injectedMessage: 0, activity: newActivity(), proc: { write: s => written.push([id, s]) } });
  const terms = [mk('orc', 'orchestrator', { workState: 'working', stateSource: 'hook', stateAt: 0 }), mk('op1', 'operator', { workState: 'idle', idleSince: 0 })];
  const ctx = { teams, cfg: { host: '127.0.0.1', port: 1 }, terms: { list: () => terms.map(t => t.info), get: id => terms.find(t => t.info.id === id) } };
  const op1 = terms[1];
  const pastes = () => written.filter(([id, s]) => id === 'op1' && s.includes('nuovi messaggi')).length;

  // No-double-injection guard: an agent that cannot read the board (403) and ends its turn is not re-prompted forever.
  teams.message(7, 'orc', 'op1', 'Incarico: verifica la release');
  assert.equal(wakeSession(ctx, 'op1'), true);
  assert.deepEqual([op1.info.workState, op1.info.stateSource, op1.info.idleSince], ['idle', undefined, 0]);
  assert.ok(op1.info.noticeSentAt > 0);
  assert.ok(op1.activity.quietUntil > 0, 'the pasted delivery is marked as server input');
  setWorkState(op1.info, 'idle', 'hook'); // Stop hook, board never read
  assert.equal(wakeSession(ctx, 'op1'), false, 'same pending messages: not pasted again');
  assert.equal(op1.info.workState, 'idle');
  teams.message(7, 'orc', 'op1', 'Ci sei?');
  assert.equal(wakeSession(ctx, 'op1'), true, 'a new message re-enables the delivery');
  assert.equal(pastes(), 2);
  setWorkState(op1.info, 'idle', 'hook');
  op1.seenMessage = teams.get(7).messages.at(-1).id; // the agent read the board
  assert.equal(wakeSession(ctx, 'op1'), false);
  console.log('PASS the same pending messages are never pasted twice; a new message re-enables delivery');

  // Watchdog: a prompt waiting for the person for over 2 min, and a working claim silent for over 10 min, go to the orchestrator.
  const inbox = () => teams.get(7).messages.filter(m => m.to === 'orc' && m.from === 'visual-brain');
  const t0 = 1_000_000;
  terms.push(
    mk('op2', 'operator', { workState: 'working', stateSource: 'agent', stateAt: t0 - STALE_AFTER_MS - 60_000, lastOutputAt: t0 - STALE_AFTER_MS - 1 }),
    mk('op3', 'operator', { workState: 'working', stateSource: 'hook', stateAt: t0 - 3 * STALE_AFTER_MS }),
    mk('op4', 'operator', { workState: 'working', stateSource: 'server', stateAt: t0 - 3 * STALE_AFTER_MS, lastInputAt: t0 - 60_000 }),
    mk('op5', 'operator', { workState: 'working', stateSource: 'server', stateAt: t0 - STALE_AFTER_MS + 6 * 60_000 }),
    mk('op6', 'operator', { workState: 'idle', idleSince: 0, lastOutputAt: t0 - 5_000 }),
  );
  op1.info.workState = 'working'; op1.info.stateSource = 'server'; op1.info.stateAt = t0 - 30 * 60_000;
  setAttention(op1.activity, op1.info, 'permission', t0 - ATTENTION_AFTER_MS);
  const reminded = new Map();
  const first = checkIdle(ctx, t0, reminded);
  assert.deepEqual(first.reported.sort(), ['op1', 'op2', 'op3'], 'op3 is a hook turn interrupted with Esc (no Stop hook); op4 recent input, op5 too recent, op6 visibly busy are left alone');
  const msg = inbox().at(-1).text;
  assert.match(msg, /OP1 · 2 min · serve risposta utente nel terminale/);
  assert.match(msg, /OP2 · 10 min · nessuna attività/);
  assert.match(msg, /OP3 · \d+ min · nessuna attività/);
  assert.equal(inbox().length, 1, 'one message for the whole node');
  assert.deepEqual(checkIdle(ctx, t0 + 60_000, reminded).reported, [], 'rate limited like the idle reminders');
  assert.deepEqual(checkIdle(ctx, t0 + REMIND_EVERY_MS, reminded).reported.sort(), ['op1', 'op2', 'op3', 'op6'], 'again after the window; op6 is quiet now, hence free');
  setAttention(op1.activity, op1.info, null); setAttention(op1.activity, op1.info, 'input', t0 + REMIND_EVERY_MS + 1000);
  assert.deepEqual(checkIdle(ctx, t0 + REMIND_EVERY_MS + 2000, reminded).reported, [], 'a fresh prompt is not reported yet');
  console.log('PASS watchdog reports prompts waiting for the person and silent working claims, once per window');

  // A turn lost to an API error (or Esc) leaves the session "working" and silent: after QUIET_AFTER_MS its messages are
  // delivered anyway, still only once per set; the person's manual wake repeats it; a prompt for the person is never typed over.
  const q = mk('op7', 'operator', { workState: 'working', stateSource: 'server', stateAt: t0 });
  terms.push(q);
  const pastesTo = (id) => written.filter(([w, s]) => w === id && s.includes('nuovi messaggi')).length;
  teams.message(7, 'orc', 'op7', 'Chiudi b987a550');
  assert.equal(wakeSession(ctx, 'op7', { now: t0 + QUIET_AFTER_MS - 1000 }), false, 'still within its turn');
  q.info.lastOutputAt = t0 + QUIET_AFTER_MS - 500;
  assert.equal(wakeSession(ctx, 'op7', { now: t0 + QUIET_AFTER_MS + 1000 }), false, 'recent output: busy');
  assert.equal(wakeSession(ctx, 'op7', { now: t0 + 2 * QUIET_AFTER_MS }), true, 'silent for QUIET_AFTER_MS: delivered');
  q.info.stateAt = t0; q.info.lastOutputAt = undefined;
  assert.equal(wakeSession(ctx, 'op7', { now: t0 + 3 * QUIET_AFTER_MS }), false, 'same messages are not announced twice');
  assert.equal(wakeSession(ctx, 'op7', { manual: true, now: t0 + 3 * QUIET_AFTER_MS }), true, 'the person can repeat the announcement');
  assert.equal(pastesTo('op7'), 2);
  q.info.stateAt = t0; setAttention(q.activity, q.info, 'permission', t0);
  teams.message(7, 'orc', 'op7', 'Ancora?');
  assert.equal(wakeSession(ctx, 'op7', { manual: true, now: t0 + 3 * QUIET_AFTER_MS }), false, 'never typed over a prompt for the person');
  setAttention(q.activity, q.info, null);
  const before = pastesTo('op7');
  checkIdle(ctx, t0 + 4 * QUIET_AFTER_MS, new Map());
  assert.equal(pastesTo('op7'), before + 1, 'the watchdog delivers to a quiet session');
  // a draft the person is writing is never submitted by an automatic delivery; hermes/agy are not observable, never "quiet"
  teams.message(7, 'orc', 'op7', 'Bozza?');
  q.info.stateAt = t0; q.activity.draft = true;
  assert.equal(wakeSession(ctx, 'op7', { now: t0 + 9 * QUIET_AFTER_MS }), false, 'unsent draft: no automatic paste');
  assert.equal(wakeSession(ctx, 'op7', { manual: true, now: t0 + 9 * QUIET_AFTER_MS }), false, 'manual wake cannot submit a draft either');
  q.activity.draft = false;
  q.info.agent = 'hermes';
  assert.equal(wakeSession(ctx, 'op7', { now: t0 + 9 * QUIET_AFTER_MS }), false, 'hermes thinking silently is not quiet');
  q.info.agent = 'claude';
  assert.equal(wakeSession(ctx, 'op7', { now: t0 + 9 * QUIET_AFTER_MS }), true);
  const main = mk('brain', 'brain', { workState: 'idle', agent: 'codex' });
  terms.push(main);
  teams.message(7, 'orc', 'brain', 'Unrelated message body', 'brain');
  feed(main.activity, main.info, ['\x1b]7501;state=working:app=codex\x1b\\'], t0);
  checkIdle(ctx,t0);
  assert.equal(main.injectedMessage,0,'native busy overrides an idle board report');
  feed(main.activity, main.info, ['\x1b]7501;state=done:app=codex\x1b\\'], t0+10);
  appendOutput(main.activity,CODEX_APPROVAL);
  assert.equal(wakeSession(ctx,'brain'),false,'defer even before the pending approval screen is scanned');
  scanOutput(main.activity,main.info,t0+20);
  setAttention(main.activity,main.info,null);
  checkIdle(ctx,t0+30);
  checkIdle(ctx,t0+40);
  const brainWrites = written.filter(([id])=>id==='brain');
  assert.equal(brainWrites.length,1,'wake the Main Brain once after the block clears');
  assert.ok(brainWrites[0][1].endsWith('\x1b[201~\r'));
  assert.ok(!brainWrites[0][1].includes('Unrelated message body'));
  console.log('PASS a session stuck at working but silent receives its messages; manual wake repeats; prompts are never typed over');
} finally { rmSync(dir, { recursive: true, force: true }); }

{
  // Hooks only for Claude sessions of a team; the token travels in the PTY environment, never in argv.
  const calls = [];
  const fakeTerms = { spawn(opts) { calls.push(opts); return {}; } };
  const detail = { id: 42, name: 'fixture' };
  launchEmbedded(fakeTerms, 'claude', DEFAULTS, detail, '/tmp', 'ciao', undefined, { role: 'operator', task: 'fai' });
  launchEmbedded(fakeTerms, 'claude', DEFAULTS, detail, '/tmp', 'ciao');
  launchEmbedded(fakeTerms, 'codex', DEFAULTS, detail, '/tmp', 'ciao', undefined, { role: 'operator' });
  const [team, solo, codex] = calls;
  assert.equal(team.args[0], '--settings');
  const settings = JSON.parse(team.args[1]);
  assert.deepEqual(Object.keys(settings.hooks).sort(), ['Notification', 'Stop', 'StopFailure', 'UserPromptSubmit']);
  assert.deepEqual(settings.hooks.Notification.map(n => n.matcher), ['permission_prompt|worker_permission_prompt', 'elicitation_dialog|elicitation_url_dialog|agent_needs_input']);
  for (const group of Object.values(settings.hooks)) for (const h of group[0].hooks) {
    assert.match(h.command, /curl -s -m 2 .*\|\| true|; true$/, 'never fails the agent');
    assert.match(h.command, />\/dev\/null 2>&1/, 'silent: UserPromptSubmit output would reach the model');
  }
  assert.equal(team.args.at(-1).startsWith('ciao'), true, 'the prompt stays the last argument');
  assert.deepEqual(team.env, { VB_STATE_URL: `http://${DEFAULTS.host}:${DEFAULTS.port}/api/work/42/state`, VB_SESSION_ID: team.id, VB_TEAM_TOKEN: team.teamToken, VB_EXPLORE_URL: `http://${DEFAULTS.host}:${DEFAULTS.port}/api/explore?node=42` });
  assert.ok(!team.args.some(a => a.includes(team.teamToken.slice(0, 8)) && a !== team.args.at(-1)), 'the token is not in the hook argv');
  assert.ok(!solo.args.includes('--settings'), 'a session outside a team gets no hooks');
  assert.deepEqual(Object.keys(solo.env), ['VB_EXPLORE_URL'], 'only the read-only graph endpoint, no team credentials');
  assert.ok(!codex.args.includes('--settings') && codex.env.VB_SESSION_ID === codex.id, 'Codex has no hooks, but the environment is there');
  assert.equal(claudeHookSettings(), team.args[1]);
}
{
  // The real hook command against a local server: Bearer header from stdin, JSON body, silent, and a no-op without env.
  const { createServer } = await import('node:http');
  const { execFile } = await import('node:child_process');
  const sh = (cmd, env) => new Promise((ok, fail) => execFile('/bin/sh', ['-c', cmd], { env, encoding: 'utf8' }, (e, out) => e ? fail(e) : ok(out)));
  const got = [];
  const srv = createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { got.push({ auth: req.headers.authorization, body: JSON.parse(b) }); res.end('{}'); }); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const cmd = JSON.parse(claudeHookSettings()).hooks.Stop[0].hooks[0].command;
  const env = { PATH: '/usr/bin:/bin', VB_STATE_URL: `http://127.0.0.1:${srv.address().port}/api/work/1/state`, VB_SESSION_ID: 'abc12345', VB_TEAM_TOKEN: 'tok-secret' };
  const out = await sh(cmd, env);
  assert.equal(out, '', 'no output reaches Claude');
  assert.deepEqual(got, [{ auth: 'Bearer tok-secret', body: { from: 'abc12345', state: 'idle', source: 'hook' } }]);
  assert.equal(await sh(cmd, { PATH: '/usr/bin:/bin' }), '', 'outside Visual Brain: nothing, exit 0');
  assert.ok(!/Bearer \$VB_TEAM_TOKEN"/.test(cmd) && cmd.includes('-H @-'), 'the header goes through stdin, not argv');
  srv.close();
}
{
  // A first turn lost to an API error leaves the agent without the protocol: every notice says where the token is, never the token.
  for (const language of ['it', 'en']) {
    const n = deliveryNotice({ host: '127.0.0.1', port: 4747, language }, 138, 'abc12345');
    assert.ok(n.includes('Authorization: Bearer $VB_TEAM_TOKEN') && n.includes('/api/work/138?session=abc12345'), n);
    assert.doesNotMatch(n, /\$[\w-]+[\p{P}\s]*$/u, 'punctuation after a trailing skill token still leaves the Codex completion menu open');
  }
}
console.log('PASS Claude hooks only for team sessions, with port, session and token from the PTY environment');

{
  // Real PTY (a shell, not an agent): environment, typed input, initial state and output scanning end to end.
  const terms = new Terminals(() => {});
  const t = terms.spawn({ agent: 'claude', cwd: tmpdir(), file: '/bin/sh', args: ['-c', `printf "$VB_SESSION_ID\\n"; read line; printf '\\033[1m✽\\033[22m Manifesting… (2s · ↓ 1.2k tokens)\\n'; sleep 1`], title: 't', role: 'operator', task: 'fai', env: { VB_SESSION_ID: 'pty-env-ok' } });
  assert.deepEqual([t.info.workState, t.info.stateSource, typeof t.info.stateAt], ['idle', 'server', 'number'], 'the initial assignment awaits a claim');
  const output = () => t.buffer.join('');
  const until = async (ok, what) => { for (let i = 0; i < 100 && !ok(); i++) await new Promise(r => setTimeout(r, 30)); assert.ok(ok(), what); };
  await until(() => output().includes('pty-env-ok'), 'env vars reach the PTY');
  terms.write(t.info.id, 'ok\r');
  assert.equal(typeof t.info.lastInputAt, 'number');
  await until(() => t.info.lastOutputAt !== undefined, 'the spinner printed after the input is seen as activity');
  terms.kill(t.info.id);
}
{
  // The update switch belongs to the desktop shell and its server: a terminal must not hand it to whatever is started from it.
  const keys = ['VISUAL_BRAIN_UPDATES', 'VISUAL_BRAIN_APP', 'VISUAL_BRAIN_SHELL', 'VISUAL_BRAIN_VERSION', 'VISUAL_BRAIN_INSTANCE', 'VISUAL_BRAIN_DATA_DIR'];
  const saved = keys.map(key => process.env[key]);
  Object.assign(process.env, { VISUAL_BRAIN_UPDATES: '1', VISUAL_BRAIN_APP: '/Applications/Visual Brain.app', VISUAL_BRAIN_SHELL: '4242', VISUAL_BRAIN_VERSION: '0.0.1', VISUAL_BRAIN_INSTANCE: '4242-1', VISUAL_BRAIN_DATA_DIR: '/tmp/vb-profile' });
  try {
    const env = new Terminals(() => {}).env({ VB_SESSION_ID: 'x' });
    assert.deepEqual([env.VISUAL_BRAIN_UPDATES, env.VISUAL_BRAIN_APP, env.VISUAL_BRAIN_SHELL], [undefined, undefined, undefined], 'a terminal does not inherit the update switch, the installed app path nor the shell it belongs to');
    assert.deepEqual([env.VISUAL_BRAIN_VERSION, env.VISUAL_BRAIN_INSTANCE], [undefined, undefined], 'nor the version and the instance of this server');
    assert.deepEqual([env.VISUAL_BRAIN_DATA_DIR, env.VB_SESSION_ID, env.TERM], ['/tmp/vb-profile', 'x', 'xterm-256color'], 'the rest of the environment is unchanged');
    assert.equal(process.env.VISUAL_BRAIN_UPDATES, '1', 'the server keeps its own switch');
  } finally {
    keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
  }
  const shell = readFileSync(new URL('../app/src-tauri/src/main.rs', import.meta.url), 'utf8');
  assert.ok(shell.includes('else { command.env_remove("VISUAL_BRAIN_UPDATES").env_remove("VISUAL_BRAIN_APP").env_remove("VISUAL_BRAIN_SHELL"); }'), 'a shell without updates drops an inherited update switch');
  assert.ok(shell.includes('.env("VISUAL_BRAIN_SHELL", std::process::id().to_string())'), 'a shell with updates names its own process for its server');
}
console.log('PASS PTY sessions carry the hook environment, never the update switch, and record input and busy output');
