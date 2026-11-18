// Stand-ins for the Claude Code and Codex terminal interfaces, for tests of the model change of an open session:
// the composer, the /model selector with its "this session only" key, Claude's "Switch model?" question, and the records
// each CLI keeps (Claude's transcript, Codex's rollout). Screens are laid out as Claude Code 2.1 and Codex 0.169 draw them.
// They write only under CLAUDE_CONFIG_DIR / CODEX_HOME, which must be set: never in a person's real profile.
//   in a test:   new FakeCli({ agent, home, cwd, sessionId, model, out })   then  cli.input(keys)
//   as a process: node fake-agent-cli.mjs claude|codex [the CLI's own arguments]
import { appendFileSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', label: 'Default (recommended)', note: 'Opus 5.5 · Best for everyday, complex tasks' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', note: 'For complex work and everyday tasks' },
  { id: 'claude-fable-5-2', label: 'Fable 5.2', note: 'For your toughest challenges' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', note: 'Most efficient for simpler tasks' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', note: 'Fastest for quick answers' },
];
const CODEX_LEVELS = [['low', 'Low'], ['medium', 'Medium (default)'], ['high', 'High'], ['xhigh', 'Extra high']];
const VISIBLE = 8; // Codex shows a window of its list and scrolls it

export class FakeCli {
  /**
   * @param {{ agent: 'claude' | 'codex', home: string, cwd: string, out: (data: string) => void, sessionId?: string,
   *   model?: string, effort?: string, prompt?: string, opening?: string, cols?: number,
   *   sessionOnly?: boolean,   false: an older CLI whose selector can only save the default
   *   askFor?: string,         Claude's question names this model instead of the chosen one
   *   ask?: boolean }} o       false: Claude switches without asking even with a conversation
   */
  constructor(o) {
    this.o = { sessionOnly: true, ask: true, cols: 110, ...o };
    this.agent = o.agent; this.mode = 'composer'; this.text = ''; this.history = []; this.turns = 0; this.hot = 0;
    /** Every time a key saved the choice as the default for new sessions: a test asserts this stays empty. */
    this.savedDefaults = [];
    if (this.agent === 'claude') {
      this.models = CLAUDE_MODELS;
      this.model = CLAUDE_MODELS.findLast(m => m.id.includes(o.model ?? 'opus')) ?? CLAUDE_MODELS[1];
      this.id = o.sessionId ?? randomUUID();
      const dir = join(o.home, 'projects', realpathSync(o.cwd).replace(/[^a-zA-Z0-9]/g, '-'));
      mkdirSync(dir, { recursive: true }); this.record = join(dir, `${this.id}.jsonl`);
    } else {
      const cache = JSON.parse(readFileSync(join(o.home, 'models_cache.json'), 'utf8'));
      this.models = cache.models.filter(m => m.visibility === 'list').map(m => ({ id: m.slug, label: m.display_name }));
      this.model = this.models.find(m => m.id === o.model) ?? this.models[0];
      this.effort = o.effort ?? 'medium'; this.id = o.sessionId ?? randomUUID();
      const now = new Date(), day = [String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')];
      const dir = join(o.home, 'sessions', ...day);
      mkdirSync(dir, { recursive: true }); this.record = join(dir, `rollout-${now.toISOString().slice(0, 19).replace(/:/g, '-')}-${this.id}.jsonl`);
      this.write({ type: 'session_meta', payload: { id: this.id, timestamp: now.toISOString(), cwd: realpathSync(o.cwd) } });
    }
    // The text the session was launched with is recorded as its opening message, as the real CLIs do; it is not answered.
    if (o.opening) this.write(this.agent === 'claude' ? { type: 'user', isSidechain: false, message: { role: 'user', content: o.opening }, sessionId: this.id }
      : { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: o.opening }] } });
    this.render();
    if (o.prompt) { this.text = o.prompt; this.submit(); }
  }

  write(entry) { appendFileSync(this.record, JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n'); }

  /** Keys as a terminal sends them: text, Enter, Esc, arrows, backspace. */
  input(data) {
    for (const key of data.match(/\x1b\[[0-9;]*[A-Za-z]|\x1b|[\s\S]/g) ?? []) this.key(key);
    this.render();
  }

  key(k) {
    const up = k === '\x1b[A', down = k === '\x1b[B', enter = k === '\r', esc = k === '\x1b';
    if (this.mode === 'composer') {
      if (enter) this.submit();
      else if (k === '\x7f') this.text = this.text.slice(0, -1);
      else if (!k.startsWith('\x1b') && k >= ' ') this.text += k;
      return;
    }
    if (up || down) { const n = this.rows().length; this.hot = (this.hot + (down ? 1 : n - 1)) % n; return; }
    if (this.mode === 'picker') {
      if (esc) this.mode = 'composer';
      else if (this.agent === 'codex' && enter) { this.picked = this.models[this.hot]; this.mode = 'level'; this.hot = 1; }
      else if (this.agent === 'claude' && enter) { this.savedDefaults.push(this.models[this.hot].label); this.apply(this.models[this.hot], ' and saved as your default for new sessions'); }
      else if (this.agent === 'claude' && k === 's' && this.o.sessionOnly) {
        this.picked = this.models[this.hot];
        if (this.turns && this.o.ask) { this.mode = 'ask'; this.hot = 0; } else this.apply(this.picked, ' for this session only');
      }
    } else if (this.mode === 'ask') {
      if (esc || (enter && this.hot === 1)) { this.mode = 'picker'; this.hot = this.models.indexOf(this.picked); }
      else if (enter) this.apply(this.picked, ' for this session only');
    } else if (this.mode === 'level') {
      if (esc) { this.mode = 'picker'; this.hot = this.models.indexOf(this.picked); }
      else if (enter) { this.savedDefaults.push(this.picked.label); this.applyCodex(CODEX_LEVELS[this.hot][0], ''); }
      else if (k === 's' && this.o.sessionOnly) this.applyCodex(CODEX_LEVELS[this.hot][0], ' for this session only');
    }
  }

  rows() { return this.mode === 'ask' ? [0, 1] : this.mode === 'level' ? CODEX_LEVELS : this.models; }

  submit() {
    const text = this.text.trim(); this.text = '';
    if (!text) return;
    if (text === '/model') { this.mode = 'picker'; this.hot = Math.max(0, this.models.lastIndexOf(this.model)); this.asked = true; return; }
    // "di' …" is answered with those words, anything else with its last word.
    const reply = /^di' (.+)$/.exec(text)?.[1] ?? text.split(/\s+/).pop();
    this.turns++;
    if (this.agent === 'claude') {
      this.history.push(`❯ ${text}`, '', `⏺ ${reply}`, '', '✻ Churned for 1s', '');
      this.write({ type: 'user', isSidechain: false, message: { role: 'user', content: text }, sessionId: this.id });
      this.write({ type: 'assistant', isSidechain: false, message: { role: 'assistant', model: this.model.id, content: [{ type: 'text', text: reply }] }, sessionId: this.id });
    } else {
      this.history.push(`› ${text}`, '', `• ${reply}`, '', '  Worked for 1s', '');
      this.write({ type: 'turn_context', payload: { model: this.model.id, effort: this.effort } });
      this.write({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: reply }] } });
    }
  }

  apply(model, how) {
    this.model = model; this.mode = 'composer';
    this.history.push('❯ /model', `  ⎿  Set model to ${model.label}${how}`, '');
    this.write({ type: 'user', isSidechain: false, message: { role: 'user', content: `<local-command-stdout>Set model to \`${model.label}\`${how}</local-command-stdout>` }, sessionId: this.id });
  }

  applyCodex(effort, how) {
    this.model = this.picked; this.effort = effort; this.mode = 'composer';
    this.history.push(`• Model changed to ${this.model.id} ${effort}${how}`, '');
    this.write({ type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model: this.model.id, reasoning_effort: effort } } });
  }

  screen() {
    const rule = '─'.repeat(this.o.cols), mark = i => (i === this.hot ? (this.agent === 'claude' ? '❯' : '›') : ' ');
    if (this.agent === 'claude') {
      const head = [' ▐▛███▛█   Claude Code v2.1.327', `▝▜██████▀  ${this.model.label} with high effort · Claude Team`, ` ▝▝   ▝▝   ${this.o.cwd}`, '', ...this.history];
      if (this.mode === 'picker') return [...head, '▔'.repeat(this.o.cols), '  Select model', '  Your pick is the default for new sessions. For other models, use --model.', '',
        ...this.models.map((m, i) => `  ${mark(i)} ${i + 1}.  ${(m.label + (m === this.model ? ' ✔' : '')).padEnd(22)} ${m.note}`), '    ▸   More models', '', '  ● High effort', '',
        `  ←/→ to adjust · ${this.o.sessionOnly ? 's to use this session only · ' : ''}Enter to save · Esc to cancel`];
      if (this.mode === 'ask') return [...head, '▔'.repeat(this.o.cols), '  Switch model?', '  Your next response will be slower and use more tokens', '',
        `  This conversation is cached for the current model. Switching to ${this.o.askFor ?? this.picked.label} means the full history gets`, '  re-read.', '',
        `  ${mark(0)} 1. Yes, switch to ${this.o.askFor ?? this.picked.label}`, `  ${mark(1)} 2. No, go back`, '', '  Enter to confirm · Esc to cancel'];
      return [...head, rule, `❯ ${this.text}`, rule, `  ◆ ${this.model.label} ◇high 🧠 │ ░░░░░░░░░░░░ 5% 58.8k/1M │ $0.01 · 24s`, '  ⏵⏵ auto mode on (shift+tab to cycle)'];
    }
    const head = ['  >_ OpenAI Codex (v0.169.0)', `     ${this.o.cwd}`, '', '  To get started, describe a task or try one of these commands:', '', '  /model - choose what model and reasoning effort to use', '', ...this.history];
    if (this.mode === 'picker') {
      const from = Math.max(0, Math.min(this.hot - VISIBLE + 1, this.models.length - VISIBLE)), shown = this.models.slice(from, from + VISIBLE);
      return [...head, '  Select Model and Effort', '', ...shown.map((m, i) => `${mark(from + i)} ${from + i + 1}. ${(m.label + (m === this.model ? ' (current)' : '')).padEnd(26)} A model.`),
        ...(from + VISIBLE < this.models.length ? ['↓'] : []), '', '  enter select · esc back'];
    }
    if (this.mode === 'level') return [...head, `  Select Reasoning Level for ${this.picked.label}`, '', ...CODEX_LEVELS.map(([, label], i) => `${mark(i)} ${i + 1}. ${label.padEnd(18)} A level.`),
      '  5. More reasoning…   Max and Ultra consume usage limits faster', '', `  enter default${this.o.sessionOnly ? ' · s session' : ''} · esc back`];
    return [...head, `› ${this.text || 'Ask Codex to do anything'}`, '', `  ${this.model.label} ${this.effort} · Workspace · Context 1% used · 828K window · Standard`,
      '  ← for agents · ? for shortcuts                                        ⚠ 1 warning · f2 to view'];
  }

  render() { this.o.out(`\x1b[H\x1b[2J${this.screen().join('\r\n')}`); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [agent, ...args] = process.argv.slice(2);
  const home = agent === 'claude' ? process.env.CLAUDE_CONFIG_DIR : process.env.CODEX_HOME;
  if (!home || !['claude', 'codex'].includes(agent)) { console.error('fake-agent-cli: set CLAUDE_CONFIG_DIR or CODEX_HOME and name the agent'); process.exit(2); }
  const flag = (...names) => { const at = args.findIndex(a => names.includes(a)); return at >= 0 ? args[at + 1] : undefined; };
  const cli = new FakeCli({ agent, home, cwd: process.cwd(), sessionId: flag('--session-id'), model: flag('--model', '-m'), cols: process.stdout.columns || 110,
    opening: args.at(-1)?.includes(' ') ? args.at(-1) : undefined, effort: /model_reasoning_effort="?(\w+)/.exec(args.join(' '))?.[1] ?? flag('--effort'),
    out: data => process.stdout.write(data), ...(process.env.FAKE_AGENT_OPTIONS ? JSON.parse(process.env.FAKE_AGENT_OPTIONS) : {}) });
  process.stdin.setRawMode?.(true); process.stdin.setEncoding('utf8');
  process.stdin.on('data', data => {
    if (data === '\x03') process.exit(0);
    cli.input(data);
    // Left where a test can find it: a key that saved a default is a defect of whoever sent it.
    if (cli.savedDefaults.length) appendFileSync(join(home, 'defaults-saved.log'), `${cli.savedDefaults.splice(0).join('\n')}\n`);
  });
  process.stdout.on('resize', () => { cli.o.cols = process.stdout.columns || 110; cli.render(); });
}
