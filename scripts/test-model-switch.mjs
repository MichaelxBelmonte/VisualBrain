// The model of an open session, changed in place: the screen reader, the selector parser, the CLIs' records, the preview
// filter and the driver itself against stand-ins of Claude Code and Codex (scripts/fake-agent-cli.mjs).
// No real agent, PTY or server; the records live in temporary CLAUDE_CONFIG_DIR / CODEX_HOME folders.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { FakeCli } from './fake-agent-cli.mjs';

const dir = mkdtempSync(join(tmpdir(), 'vb-model-switch-'));
const claudeHome = join(dir, 'claude'), codexHome = join(dir, 'codex'), cwd = join(dir, 'progetto');
for (const d of [claudeHome, codexHome, cwd]) mkdirSync(d);
process.env.CLAUDE_CONFIG_DIR = claudeHome; process.env.CODEX_HOME = codexHome;
const CODEX_MODELS = ['GPT-6.2-Sol', 'GPT-6.2-Astra', 'GPT-6.1 Terra', 'GPT-6.1-Sol', 'GPT-6-Astra', 'GPT-6-Sol', 'GPT-6-Luna', 'GPT-5.6-Sol', 'GPT-5.6-Terra', 'GPT-5.6-Luna'];
writeFileSync(join(codexHome, 'models_cache.json'), JSON.stringify({ models: CODEX_MODELS.map(label => ({ slug: label.toLowerCase().replace(' ', '-'), display_name: label, visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }] })) }));

const { Screen } = await import('../src/server/screen.ts');
const { claudeRecord, codexRecord, claudeLabel } = await import('../src/server/session-model.ts');
const { sessionPreview } = await import('../src/shared/session-preview.ts');
const { answerModelChange, cancelModelChange, forgetModelChange, modelFields, noteSize, requestModelChange, selectorRows, switchChoices, switchLimit } = await import('../src/server/model-switch.ts');
const { newActivity } = await import('../src/server/activity.ts');

try {
  // --- The screen: cursor moves, erasing, scrolling and the cell-by-cell redraws Codex makes.
  {
    const s = new Screen(20, 4);
    s.write('uno\r\ndue\r\ntre\r\nquattro\r\ncinque');
    assert.deepEqual(s.lines(), ['due', 'tre', 'quattro', 'cinque'], 'a full screen scrolls');
    s.write('\x1b[2;1H\x1b[KTRE\x1b[1;5Hx\x1b[4;1H\x1b[2Kfine');
    assert.deepEqual(s.lines(), ['due x', 'TRE', 'quattro', 'fine'], 'position, erase in line, overwrite single cells');
    s.write('\x1b[H\x1b[2Jpulito\x1b[?25l\x1b]0;titolo\x07\x1b[38;2;1;2;3m!\x1b[0m');
    assert.deepEqual(s.lines(), ['pulito!', '', '', ''], 'clear; modes, titles and colours leave no trace');
    s.write('\x1b[3;1Hmeta\x1b['); s.write('1;1HX');
    assert.equal(s.lines()[0], 'Xulito!', 'a sequence split between two chunks is completed by the next one');
    console.log('PASS the screen reader follows cursor moves, erasures, scrolling and split sequences');
  }

  // --- The selectors, laid out as the real CLIs draw them.
  {
    const claude = ['  Select model', '  Your pick is the default for new sessions. For other models, use --model.', '',
      '    1.  Default (recommended)  Opus 5.5 · Best for everyday, complex tasks', '    2.  Opus 5.5               For complex work and everyday tasks',
      '    3.  Fable 5.2              For your toughest challenges', '    4.  Sonnet 5.5             Most efficient for simpler tasks',
      '  ❯ 5.  Haiku 5.5 ✔            Fastest for quick answers', '    ▸   More models', '', '  ● High effort'];
    const rows = selectorRows(claude, /^\s*Select model\s*$/);
    assert.deepEqual(rows.map(r => r.label), ['Default (recommended)', 'Opus 5.5', 'Fable 5.2', 'Sonnet 5.5', 'Haiku 5.5']);
    assert.deepEqual(rows.filter(r => r.hot).map(r => r.n), [5], 'the highlighted row, without its check mark');
    const codex = ['  Select Model and Effort', '', '  1. GPT-6.2-Sol              Fast, go-to model.', '› 2. GPT-6.2-Astra (current)  Our most capable model.', '  3. GPT-6.1 Terra            Efficient model.', '↓', '  enter select · esc back'];
    assert.deepEqual(selectorRows(codex, /^\s*Select Model and Effort\s*$/), [{ n: 1, label: 'GPT-6.2-Sol', hot: false }, { n: 2, label: 'GPT-6.2-Astra', hot: true }, { n: 3, label: 'GPT-6.1 Terra', hot: false }]);
    assert.equal(selectorRows(['❯ 1. Yes', '  2. No'], /^\s*Select model\s*$/), null, 'another menu is not the model selector');
    console.log('PASS the model selectors of Claude Code and Codex are read row by row, with the highlighted one');
  }

  // --- The CLIs' own records.
  {
    const line = o => JSON.stringify(o);
    const answer = (model, extra = {}) => line({ type: 'assistant', isSidechain: false, message: { role: 'assistant', model }, ...extra });
    const set = text => line({ type: 'user', message: { role: 'user', content: `<local-command-stdout>${text}</local-command-stdout>` } });
    let r = claudeRecord([answer('claude-haiku-5-5'), set('Set model to `Sonnet 5.5` for this session only')].join('\n'));
    assert.deepEqual([r.now, r.next], ['claude-haiku-5-5', 'Sonnet 5.5'], 'last turn and the confirmed selection after it');
    const mark = r.mark;
    r = claudeRecord([answer('claude-haiku-5-5'), set('Set model to `Sonnet 5.5` for this session only'), answer('<synthetic>'), answer('claude-opus-5-5', { isSidechain: true }), answer('claude-sonnet-5-5')].join('\n'));
    assert.deepEqual([r.now, r.next, r.mark], ['claude-sonnet-5-5', undefined, mark], 'a turn after the selection has used it; synthetic and sub-agent entries do not count');
    assert.equal(claudeRecord(set('Set model to Haiku 5.5 and saved as your default for new sessions')).next, 'Haiku 5.5');
    assert.equal(claudeLabel('claude-sonnet-5-5'), 'Sonnet 5.5'); assert.equal(claudeLabel('claude-fable-5-2[1m]'), 'Fable 5.2'); assert.equal(claudeLabel('altro'), 'altro');
    const turn = (model, effort) => line({ type: 'turn_context', payload: { model, effort } });
    const applied = (model, effort) => line({ type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model, reasoning_effort: effort } } });
    r = codexRecord([turn('gpt-6-luna', 'low'), applied('gpt-6.2-sol', 'medium')].join('\n'));
    assert.deepEqual([r.now, r.nowEffort, r.next, r.nextEffort], ['gpt-6-luna', 'low', 'gpt-6.2-sol', 'medium']);
    r = codexRecord([turn('gpt-6-luna', 'low'), applied('gpt-6.2-sol', 'medium'), turn('gpt-6.2-sol', 'medium'), 'non json'].join('\n'));
    assert.deepEqual([r.now, r.next], ['gpt-6.2-sol', undefined]);
    console.log('PASS the model of the last turn and the confirmed next one are read from Claude’s transcript and Codex’s rollout');
  }

  // --- The preview: the agent's words or its question, never the CLI's furniture; real errors stay.
  {
    const rule = '─'.repeat(60);
    const claudeIdle = [' ▐▛███▛█   Claude Code v2.1.327', '▝▜██████▀  Sonnet 5.5 with high effort · Claude Team', ' ▝▝   ▝▝   /progetti/esempio', '', '❯ controlla la release', '',
      '⏺ Ho controllato la release pubblicata: la 0.2.11 è sul feed', '  e il pacchetto firmato è presente.', '', '✻ Worked for 1m 46s', '', rule, '❯ ', rule,
      '  ◆ Sonnet 5.5 ◇high 🧠 │ ░░░░ 5% 58.8k/1M │ $0.01 · 24s', '  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent'];
    assert.deepEqual(sessionPreview(claudeIdle), { text: 'Ho controllato la release pubblicata: la 0.2.11 è sul feed e il pacchetto firmato è presente.' });
    const codexIdle = ['  >_ OpenAI Codex (v0.169.0)', '     /progetti/esempio', '', '  /model - choose what model and reasoning effort to use', '', '› aggiorna i test', '', '• Ho aggiornato i test della barra laterale.', '', '  Worked for 12s • 14:34', '',
      '› Ask Codex to do anything', '', '  GPT-6.2-Sol medium · Workspace · Context 1% used · 828K window · Standard', '  ← for agents · ? for shortcuts                    ⚠ 4 warnings · f2 to view'];
    assert.deepEqual(sessionPreview(codexIdle), { text: 'Ho aggiornato i test della barra laterale.' }, 'no "Standard", shortcuts or warning counter');
    const codexNew = codexIdle.filter(l => !/aggiorna|Ho aggiornato|Worked/.test(l));
    assert.deepEqual(sessionPreview(codexNew), { text: '' }, 'a session that has done nothing yet has nothing to show: the interface says so');
    assert.deepEqual(sessionPreview(['  >_ OpenAI Codex (v0.169.0)', '     /progetti/una-cartella-dal-nome-molto-lungo/che-va-a-ca', 'po/esempio', '', '› Ask Codex to do anything']), { text: '' }, 'a folder name wrapped under the banner is still banner');
    const working = [...claudeIdle.slice(0, 8), '', '✽ Manifesting… (3m 56s · ↓ 16.4k tokens · esc to interrupt)', '', rule, '❯ ', rule, '  ⏵⏵ auto mode on'];
    assert.equal(sessionPreview(working).text, 'Ho controllato la release pubblicata: la 0.2.11 è sul feed e il pacchetto firmato è presente.', 'spinners are not activity');
    const permission = ['• Calling visual_brain.team_request', '    + Show details', '', '  Field 1/1', '  Allow the visual_brain MCP server to run tool "team_request"?', '  operation: read',
      '  › 1. Allow                   Run the tool and continue', '    2. Allow for this session  Run the tool and remember this choice', '    3. Cancel                  Cancel this tool call', '  enter to submit | esc to cancel'];
    assert.equal(sessionPreview(permission).text, 'Allow the visual_brain MCP server to run tool "team_request"? operation: read', 'the question the session asks, without its choices or the CLI’s own labels');
    const failed = ['❯ continua', '', '⏺ Leggo il file di configurazione.', '  ⎿  API Error: 529 Overloaded', '', '⏺ Riprovo fra poco.', '', rule, '❯ ', rule, '  ? for shortcuts'];
    assert.deepEqual(sessionPreview(failed), { text: 'Riprovo fra poco.', error: 'API Error: 529 Overloaded' }, 'a real error near the end is kept next to the last words');
    const logged = ['❯ ciao', '  ⎿  Not logged in · Please run /login', '', rule, '❯ ', rule];
    assert.equal(sessionPreview(logged).text, 'Not logged in · Please run /login', 'an error that is the last thing said is the text itself');
    assert.equal(sessionPreview(logged).error, undefined);
    const list = ['⏺ Ecco i passi:', '  1. apri il file', '  2. salva', '', rule, '❯ ', rule];
    assert.equal(sessionPreview(list).text, 'Ecco i passi: 1. apri il file 2. salva', 'a numbered list in an answer is not a menu');
    assert.ok(sessionPreview(['x'.repeat(400)]).text.length <= 280);
    console.log('PASS the preview keeps the last useful words or the open question, drops footer, shortcuts, spinners and banners, and keeps real errors');
  }

  // --- The driver, against the stand-ins.
  const terms = new Map();
  const store = { get: id => terms.get(id), list: () => [...terms.values()].map(t => t.info), resize() {} };
  const claimed = () => new Set();
  let n = 0;
  const session = (agent, options = {}) => {
    const id = `s${++n}`, sessionId = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const term = { info: { id, agent, cwd, title: agent, alive: true, createdAt: Date.now(), model: options.model, effort: options.effort, ...(agent === 'claude' ? { resumeId: sessionId } : {}) },
      buffer: [], bufferBytes: 0, listeners: new Set(), exitCode: null, teamToken: '', seenMessage: 0, injectedMessage: 0, activity: newActivity(), keys: [] };
    const out = data => { term.buffer.push(data); for (const l of term.listeners) l(data); };
    // Launched by Visual Brain: the opening message names the session, as the launch text does.
    const cli = new FakeCli({ agent, home: agent === 'claude' ? claudeHome : codexHome, cwd, sessionId, out, opening: `Visual Brain · Nodo 1\nruolo operator, codice OP${n}, sessione ${id}\nObiettivo: prova`, ...options });
    // The PTY answers a moment after the key, as a real one does.
    term.proc = { pid: 1, write: data => { term.keys.push(data); term.onKey?.(data); setTimeout(() => cli.input(data), 5); }, resize() {}, kill() {} };
    terms.set(id, term); noteSize(id, 110, 40);
    return { id, term, cli, fields: () => modelFields(term.info, claimed) };
  };
  const settled = async (s, states = ['done', 'failed']) => {
    for (let i = 0; i < 400; i++) { const c = s.fields().modelChange; if (!c || states.includes(c.state)) return c; await pause(25); }
    throw new Error(`change not settled: ${JSON.stringify(s.fields().modelChange)}`);
  };
  const say = async (s, text) => { s.cli.input(text + '\r'); await pause(20); };
  const never = s => assert.deepEqual(s.cli.savedDefaults, [], 'no key ever saved a default for new sessions');

  {
    // Claude, no conversation yet: no question asked.
    const s = session('claude', { model: 'haiku' });
    assert.deepEqual(switchChoices('claude').map(c => c.id), ['opus', 'fable', 'sonnet', 'haiku']);
    assert.equal(s.fields().modelChoice, 'haiku', 'before any record, the launch model');
    assert.equal(requestModelChange(store, s.id, 'sonnet', claimed).state, 'running');
    assert.throws(() => requestModelChange(store, s.id, 'opus', claimed), /già in corso/);
    assert.equal((await settled(s)).state, 'done');
    let f = s.fields();
    assert.deepEqual([f.modelNow, f.modelNext, f.modelChoice], [undefined, 'Sonnet 5.5', 'sonnet'], 'confirmed by the transcript, no turn has used it yet');
    assert.deepEqual(s.term.keys.join('|'), '/model|\r|\x1b[A|s', 'the command, Enter on the composer, one step up, the session-only key');
    assert.equal(s.term.activity.draft, false, 'board notices are let through again');
    await say(s, 'Rispondi solo con la parola: uno');
    f = s.fields();
    assert.deepEqual([f.modelNow, f.modelNext, f.modelChoice], ['Sonnet 5.5', undefined, 'sonnet'], 'the next turn really used it');
    assert.throws(() => requestModelChange(store, s.id, 'sonnet', claimed), /usa già questo modello/);
    assert.throws(() => requestModelChange(store, s.id, 'gpt-6', claimed), /non disponibile/);

    // With a conversation Claude asks first: the question is the person's, nothing is confirmed for them.
    forgetModelChange(s.id); noteSize(s.id, 110, 40);
    requestModelChange(store, s.id, 'haiku', claimed);
    const ask = await settled(s, ['confirm', 'done', 'failed']);
    assert.equal(ask.state, 'confirm'); assert.match(ask.message, /slower and use more tokens.*Haiku 5\.5/);
    const sent = s.term.keys.length;
    await pause(400);
    assert.equal(s.term.keys.length, sent, 'no key while the question is open'); assert.equal(s.cli.mode, 'ask');
    assert.equal(s.fields().modelChoice, 'sonnet', 'the session is still on its model');
    assert.throws(() => requestModelChange(store, s.id, 'opus', claimed), /già in corso/);
    assert.equal(answerModelChange(s.id, true), true);
    assert.equal((await settled(s)).state, 'done');
    assert.deepEqual([s.fields().modelNow, s.fields().modelNext], ['Sonnet 5.5', 'Haiku 5.5']);
    assert.equal(s.term.keys.at(-1), '\r', 'Enter went on "Yes, switch to Haiku 5.5"');
    await say(s, 'Rispondi solo con la parola: due');
    assert.deepEqual([s.fields().modelNow, s.fields().modelNext], ['Haiku 5.5', undefined]);

    // The person says no from the interface: the question and the selector are closed, the model stays.
    forgetModelChange(s.id); noteSize(s.id, 110, 40);
    requestModelChange(store, s.id, 'opus', claimed);
    assert.equal((await settled(s, ['confirm'])).state, 'confirm');
    assert.equal(cancelModelChange(s.id), true);
    for (let i = 0; i < 200 && s.fields().modelChange; i++) await pause(25);
    assert.equal(s.fields().modelChange, undefined, 'a refusal leaves nothing to report');
    await pause(900);
    assert.equal(s.cli.mode, 'composer'); assert.equal(s.cli.model.label, 'Haiku 5.5'); assert.equal(s.term.activity.draft, false);

    // The person answers in the terminal instead: yes there is as good as yes here.
    requestModelChange(store, s.id, 'opus', claimed);
    await settled(s, ['confirm']);
    s.term.info.lastInputAt = Date.now(); s.cli.input('\r'); // their own Enter, through the pane
    assert.equal((await settled(s)).state, 'done');
    assert.equal(s.fields().modelNext, 'Opus 5.5'); assert.equal(s.term.activity.draft, false);

    // ...and no there closes the change without a word.
    forgetModelChange(s.id); noteSize(s.id, 110, 40);
    await say(s, 'Rispondi solo con la parola: tre');
    requestModelChange(store, s.id, 'fable', claimed);
    await settled(s, ['confirm']);
    const before = s.term.keys.length;
    s.term.info.lastInputAt = Date.now(); s.cli.input('\x1b\x1b');
    for (let i = 0; i < 300 && s.fields().modelChange; i++) await pause(25);
    assert.equal(s.fields().modelChange, undefined); assert.equal(s.term.keys.length, before, 'the terminal the person is using gets no key from us');
    assert.equal(s.cli.model.label, 'Opus 5.5');
    never(s);
    console.log('PASS Claude: session-only change confirmed by the transcript; "Switch model?" is left to the person (yes or no, from the list or in the terminal)');
  }

  {
    // The session is busy or holds something of the person's: the change waits and sends nothing.
    const s = session('claude', { model: 'opus' });
    s.term.info.attention = 'permission';
    assert.equal(requestModelChange(store, s.id, 'haiku', claimed).state, 'waiting');
    assert.match(s.fields().modelChange.message, /aspetta una tua risposta/);
    s.term.info.attention = undefined; s.term.activity.draft = true;
    await pause(1200);
    assert.match(s.fields().modelChange.message, /testo non inviato/); assert.deepEqual(s.term.keys, [], 'nothing typed over a permission or a draft');
    assert.equal(cancelModelChange(s.id), true); assert.equal(s.fields().modelChange, undefined);
    s.term.activity.draft = false; s.term.info.attention = 'input';
    requestModelChange(store, s.id, 'haiku', claimed);
    await pause(300); s.term.info.attention = undefined;
    assert.equal((await settled(s)).state, 'done'); assert.equal(s.fields().modelNext, 'Haiku 5.5');
    never(s);
    console.log('PASS a change asked during a permission, a draft or a turn stays queued with its reason, can be withdrawn, and runs when the session is free');
  }

  {
    // A CLI whose selector can only save the default: refused, selector closed, nothing saved.
    const old = session('claude', { model: 'opus', sessionOnly: false });
    requestModelChange(store, old.id, 'haiku', claimed);
    const end = await settled(old);
    assert.equal(end.state, 'failed'); assert.match(end.message, /solo questa sessione/);
    await pause(100);
    assert.equal(old.cli.mode, 'composer'); assert.equal(old.cli.model.label, 'Opus 5.5'); never(old);

    // The question names another model than the one asked: not confirmed.
    const odd = session('claude', { model: 'opus', askFor: 'Fable 5.2' });
    await say(odd, 'ciao');
    requestModelChange(store, odd.id, 'haiku', claimed);
    const wrong = await settled(odd);
    assert.equal(wrong.state, 'failed'); assert.match(wrong.message, /Fable 5\.2/);
    await pause(900);
    assert.equal(odd.cli.mode, 'composer'); assert.equal(odd.cli.model.label, 'Opus 5.5'); never(odd);

    // The person types while the selector is being driven: the keyboard is theirs, we stop.
    const busy = session('claude', { model: 'opus' });
    busy.term.onKey = data => { if (data === '\r') busy.term.info.lastInputAt = Date.now(); };
    requestModelChange(store, busy.id, 'haiku', claimed);
    const stopped = await settled(busy);
    assert.equal(stopped.state, 'failed'); assert.match(stopped.message, /tastiera/);
    assert.deepEqual(busy.term.keys, ['/model', '\r'], 'not one more key'); never(busy);
    console.log('PASS refused with its reason: a selector without the session-only key, a question about another model, a keyboard in use');
  }

  {
    // Codex: a long list that scrolls, the session's effort kept, the rollout as confirmation.
    const s = session('codex', { model: 'gpt-6.2-sol', effort: 'low' });
    assert.equal(switchChoices('codex').length, 10);
    await say(s, 'Rispondi solo con la parola: uno');
    assert.deepEqual([s.fields().modelNow, s.fields().modelChoice], ['GPT-6.2-Sol low', 'gpt-6.2-sol']);
    requestModelChange(store, s.id, 'gpt-5.6-luna', claimed);
    assert.equal((await settled(s)).state, 'done');
    let f = s.fields();
    assert.deepEqual([f.modelNow, f.modelNext, f.modelChoice], ['GPT-6.2-Sol low', 'GPT-5.6-Luna low', 'gpt-5.6-luna'], 'row 10 of 10, reached by scrolling; effort kept');
    assert.ok(!s.term.keys.slice(2).includes('\r') || s.term.keys.filter(k => k === '\r').length === 2, 'Enter only to open the selector and to pick the model row');
    await say(s, 'Rispondi solo con la parola: due');
    assert.deepEqual([s.fields().modelNow, s.fields().modelNext], ['GPT-5.6-Luna low', undefined]);
    forgetModelChange(s.id); noteSize(s.id, 110, 40);
    requestModelChange(store, s.id, 'gpt-6.2-astra', claimed);
    assert.equal((await settled(s)).state, 'done');
    assert.equal(s.fields().modelNext, 'GPT-6.2-Astra low');
    never(s);
    const old = session('codex', { model: 'gpt-6.2-sol', sessionOnly: false });
    requestModelChange(store, old.id, 'gpt-6-luna', claimed);
    const end = await settled(old);
    assert.equal(end.state, 'failed'); assert.match(end.message, /solo questa sessione/);
    await pause(900);
    assert.equal(old.cli.mode, 'composer'); assert.equal(old.cli.model.id, 'gpt-6.2-sol'); never(old);
    console.log('PASS Codex: the model row is reached in a scrolling list, the effort is kept, the rollout confirms; a selector without "s session" is refused');
  }

  {
    // Three Codex sessions started in the same folder in the same instant: each reads its own conversation, never a
    // neighbour's; one started without Visual Brain's opening text takes the conversation nobody else has.
    const a = session('codex', { model: 'gpt-6.2-sol' }), b = session('codex', { model: 'gpt-6-luna' }), bare = session('codex', { model: 'gpt-6-sol', opening: undefined });
    for (const s of [a, b, bare]) s.term.info.createdAt = a.term.info.createdAt;
    await say(b, 'Rispondi solo con la parola: b'); await say(bare, 'Rispondi solo con la parola: c'); await say(a, 'Rispondi solo con la parola: a');
    assert.deepEqual([a, b, bare].map(s => s.fields().modelNow), ['GPT-6.2-Sol medium', 'GPT-6-Luna medium', 'GPT-6-Sol medium']);
    requestModelChange(store, b.id, 'gpt-5.6-sol', claimed);
    assert.equal((await settled(b)).state, 'done');
    assert.deepEqual([a, b, bare].map(s => s.fields().modelNext), [undefined, 'GPT-5.6-Sol medium', undefined], 'the change of one session is read by that session only');
    const { findCodexSessionOf } = await import('../src/server/launch.ts');
    assert.equal(findCodexSessionOf(a.id, cwd, a.term.info.createdAt), a.cli.id); assert.equal(findCodexSessionOf(b.id, cwd, a.term.info.createdAt), b.cli.id);
    assert.equal(findCodexSessionOf('nessuna', cwd, a.term.info.createdAt), undefined); assert.equal(findCodexSessionOf(bare.id, cwd, a.term.info.createdAt), undefined, 'no opening message, no certain match');
    console.log('PASS Codex sessions started together in one folder each read their own record (the opening message names the session)');
  }

  {
    for (const agent of ['hermes', 'agy']) assert.match(switchLimit(agent), /non esiste un cambio di modello verificabile/);
    assert.equal(switchLimit('claude'), null); assert.equal(switchLimit('codex'), null);
    const other = session('claude', { model: 'opus' }); other.term.info.agent = 'hermes';
    assert.throws(() => requestModelChange(store, other.id, 'opus', claimed), /verificabile/);
    assert.deepEqual(modelFields(other.term.info, claimed), {});
    other.term.info.agent = 'claude'; other.term.info.alive = false;
    assert.throws(() => requestModelChange(store, other.id, 'haiku', claimed), /terminata/);
    console.log('PASS agents without a verifiable change say so; an ended session is not driven');
  }
  console.log('Nessun difetto nel cambio di modello in sessione');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
