// Changing the model of a session that is already open, in place: same process, same conversation.
// Both CLIs offer it only inside their own /model selector, with a key that limits the choice to the running session
// (Claude Code 2.1: "s to use this session only"; Codex 0.169: "s session" on the reasoning step). Typing the model's name
// after /model, or Enter in the selector, would also rewrite the person's default for every new session: never used here.
// The selector is driven one key at a time and read back from the screen before each key that commits; the change counts
// as done only when the CLI's own record confirms it (see session-model.ts). A question the CLI asks before switching
// (Claude Code: "Switch model?", the next answer costs more) is the person's to answer: it stays open until they do,
// from the list of sessions or in the terminal.
import { setTimeout as pause } from 'node:timers/promises';
import type { ModelChange, ModelSwitchChoice, TerminalInfo } from '../shared/types.ts';
import type { Term, TerminalStore } from './terminals.ts';
import { noticeInputBlocked, noteInjected, setAttention } from './activity.ts';
import { modelCatalog } from './models.ts';
import { Screen } from './screen.ts';
import { claudeLabel, sessionModel, type ModelRecord } from './session-model.ts';

export type SwitchChoice = ModelSwitchChoice;
export type ModelFields = Pick<TerminalInfo, 'modelNow' | 'modelNext' | 'modelChoice' | 'modelChange'>;

/** Families the Claude Code selector lists by name; the row is matched on the screen, so a missing one fails cleanly. */
const CLAUDE_CHOICES: SwitchChoice[] = ['opus', 'fable', 'sonnet', 'haiku'].map(id => ({ id, label: id[0].toUpperCase() + id.slice(1) }));
const CODEX_EFFORTS: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high' };
const WAIT_FOR_MS = 10 * 60_000, RETRY_EVERY_MS = 1_000, KEEP_RESULT_MS = 20_000, ANSWER_WITHIN_MS = 5 * 60_000;
const UP = '\x1b[A', DOWN = '\x1b[B', ESC = '\x1b';

export function switchChoices(agent: TerminalInfo['agent']): SwitchChoice[] {
  if (agent === 'claude') return CLAUDE_CHOICES;
  if (agent === 'codex') return modelCatalog().codex.map(m => ({ id: m.id, label: m.label }));
  return [];
}

/** Why this agent's model cannot be changed in the open session, or null when it can. */
export function switchLimit(agent: TerminalInfo['agent']): string | null {
  if (agent === 'claude' || agent === 'codex') return null;
  if (agent === 'shell') return 'Un terminale non ha un modello';
  return 'Per questo agente non esiste un cambio di modello verificabile nella sessione aperta: avvia una nuova sessione con il modello che vuoi.';
}

const sizes = new Map<string, { cols: number; rows: number }>();
/** The size the PTY was last given: the screen is read with the same geometry. */
export function noteSize(id: string, cols: number, rows: number): void {
  if (cols > 1 && rows > 1) sizes.set(id, { cols: Math.min(500, Math.floor(cols)), rows: Math.min(200, Math.floor(rows)) });
}
export function screenSize(id: string): { cols: number; rows: number } | undefined { return sizes.get(id); }

interface Pending extends ModelChange { timer?: NodeJS.Timeout; cancelled?: boolean; answer?: boolean }
const changes = new Map<string, Pending>();

const family = (text: string) => /(opus|fable|sonnet|haiku|mythos)/i.exec(text)?.[1].toLowerCase();

/** What the list of sessions says about each session's model: last turn, confirmed next, and a change in progress. */
export function modelFields(info: TerminalInfo, claimed: () => Set<string>, now = Date.now()): ModelFields {
  if (info.agent !== 'claude' && info.agent !== 'codex') return {};
  const record = sessionModel(info, claimed, now);
  const change = changes.get(info.id);
  const shown = change && (change.state === 'waiting' || change.state === 'running' || change.state === 'confirm' || now - change.at < KEEP_RESULT_MS)
    ? { state: change.state, target: change.target, label: change.label, message: change.message, at: change.at } : undefined;
  const label = (model: string | undefined, effort?: string) => {
    if (!model) return undefined;
    if (info.agent === 'claude') return claudeLabel(model);
    return (modelCatalog().codex.find(m => m.id === model)?.label ?? model) + (effort ? ` ${effort}` : '');
  };
  const current = record?.next ?? record?.now ?? info.model;
  return {
    modelNow: label(record?.now, record?.nowEffort),
    modelNext: label(record?.next, record?.nextEffort ?? record?.nowEffort),
    modelChoice: current ? (info.agent === 'claude' ? family(current) : current) : undefined,
    modelChange: shown,
  };
}

class SwitchError extends Error {
  /** False when the keyboard must be left alone (the person typed meanwhile, the process ended). */
  readonly close: boolean;
  /** The person said no: nothing to report, the session keeps its model. */
  readonly declined: boolean;
  constructor(message: string, close = true, declined = false) { super(message); this.close = close; this.declined = declined; }
}

interface Row { n: number; label: string; hot: boolean }
/** Numbered rows of a selector, below its title: "❯ 5.  Haiku 5.5 ✔   Fastest…", "› 2. GPT-6.2-Astra (current)  Our most…". */
export function selectorRows(lines: string[], title: RegExp): Row[] | null {
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (title.test(lines[i])) { at = i; break; }
  if (at < 0) return null;
  const rows: Row[] = [];
  for (const line of lines.slice(at + 1)) {
    const m = /^\s*([❯›>])?\s*(\d{1,2})\.\s+(\S.*)$/.exec(line);
    if (!m) { if (rows.length && line.trim() && !/^[↑↓▸]/.test(line.trim())) break; continue; }
    rows.push({ n: Number(m[2]), hot: !!m[1], label: m[3].split(/\s{2,}/)[0].replace(/\s*(?:✔|\(current\)|\(default\))\s*/g, ' ').trim() });
  }
  return rows;
}

const CLAUDE_TITLE = /^\s*Select model\s*$/, CODEX_TITLE = /^\s*Select Model and Effort\s*$/, CODEX_LEVEL = /^\s*Select Reasoning Level for (.+?)\s*$/;

interface Drive {
  term: Term;
  screen: Screen;
  send(data: string): void;
  until<T>(what: string, check: (lines: string[]) => T | undefined | null | false, ms?: number): Promise<T>;
  record(): ModelRecord | undefined;
  /** Leaves the CLI's question to the person: their answer from the interface, or 'terminal' once it is gone from the screen. */
  decide(question: string, open: (lines: string[]) => boolean): Promise<'yes' | 'no' | 'terminal' | 'late'>;
}

/** Moves the highlight to the wanted row, one key at a time, reading the selector again after each key. */
async function highlight(d: Drive, title: RegExp, wanted: (row: Row) => boolean, fallback: (rows: Row[], hot: Row) => number | null, what: string): Promise<Row> {
  for (let step = 0; step < 40; step++) {
    const rows = await d.until(`il selettore ${what}`, lines => { const r = selectorRows(lines, title); return r?.some(row => row.hot) ? r : null; }, 4000);
    const hot = rows.find(row => row.hot)!;
    if (wanted(hot)) return hot;
    // The wanted row may be scrolled out of a long list: then its catalog position says which way to go.
    const target = rows.find(wanted)?.n ?? fallback(rows, hot);
    if (target === null || target === hot.n) throw new SwitchError(`Il selettore ${what} non elenca la voce richiesta.`);
    d.send(target > hot.n ? DOWN : UP);
    await d.until(`lo spostamento nel selettore ${what}`, lines => { const r = selectorRows(lines, title)?.find(row => row.hot); return r && r.n !== hot.n; }, 2500);
  }
  throw new SwitchError(`Non sono riuscito a raggiungere la voce nel selettore ${what}.`);
}

/** Types the command as a person would: the composer must show it before Enter. */
async function openSelector(d: Drive, prompt: RegExp, title: RegExp, what: string): Promise<void> {
  d.send('/model');
  try { await d.until('il comando nel campo di scrittura', lines => lines.some(line => prompt.test(line)), 3000); }
  catch { d.send('\x7f'.repeat(6)); throw new SwitchError(`Il campo di scrittura ${what} non ha mostrato il comando /model.`, false); }
  d.send('\r');
  await d.until(`il selettore ${what}`, lines => selectorRows(lines, title)?.some(row => row.hot), 6000);
}

async function confirmed(d: Drive, before: string, matches: (record: ModelRecord) => boolean, onScreen: RegExp, seenBefore: number, what: string, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    const record = d.record();
    if (record ? record.mark !== before && matches(record) : d.screen.lines().filter(line => onScreen.test(line)).length > seenBefore) return true;
    if (Date.now() > end) return false;
    await pause(150);
  }
}

const CLAUDE_ASK = /^\s*Switch model\?\s*$/;
/** Claude Code's question before switching, with the row it highlights: "❯ 1. Yes, switch to Sonnet 5.5". */
function claudeAsk(lines: string[]): { text: string; hot: string } | null {
  const at = lines.findLastIndex(l => CLAUDE_ASK.test(l));
  if (at < 0) return null;
  const rest = lines.slice(at + 1), first = rest.findIndex(l => /^\s*[❯›>]?\s*1\.\s/.test(l));
  if (first < 0) return null;
  return { text: rest.slice(0, first).map(l => l.trim()).filter(Boolean).join(' '), hot: rest.find(l => /^\s*[❯›>]\s*\d\.\s/.test(l))?.replace(/^\s*[❯›>]\s*/, '').trim() ?? '' };
}

async function driveClaude(d: Drive, choice: SwitchChoice): Promise<void> {
  const before = d.record()?.mark ?? '';
  const line = /Set model to .* for this session only/, seen = d.screen.lines().filter(l => line.test(l)).length;
  await openSelector(d, /^\s*[❯>]\s*\/model\s*$/, CLAUDE_TITLE, 'di Claude Code');
  if (!d.screen.lines().some(l => /\bs to use this session only\b/.test(l))) throw new SwitchError('Questa versione di Claude Code non offre nel selettore la scelta «solo questa sessione»: il cambio salverebbe il modello come predefinito, quindi non lo faccio.');
  const row = await highlight(d, CLAUDE_TITLE, r => r.label.toLowerCase().startsWith(choice.id), () => null, 'di Claude Code');
  d.send('s');
  const yes = `1. Yes, switch to ${row.label}`.toLowerCase();
  const next = await d.until('la risposta di Claude Code', lines => {
    const ask = claudeAsk(lines);
    if (ask) return { ask };
    return selectorRows(lines, CLAUDE_TITLE) === null ? { ask: null } : null;
  }, 6000);
  const done = (ms?: number) => confirmed(d, before, r => family(r.next ?? r.now ?? '') === choice.id, line, seen, 'Claude Code', ms);
  if (next.ask) {
    // Claude warns that the next answer will cost more (the conversation is cached for the current model): that is the
    // person's call. Enter goes only on the highlighted "Yes" that names the model asked for.
    if (next.ask.hot.toLowerCase() !== yes) throw new SwitchError(`Claude Code chiede conferma per «${next.ask.hot}» invece che per «${row.label}».`);
    const answer = await d.decide(next.ask.text, lines => claudeAsk(lines) !== null);
    if (answer === 'terminal') {
      if (await done(4000)) return;
      throw new SwitchError('', false, true);
    }
    if (answer === 'late') throw new SwitchError('Conferma non arrivata in cinque minuti: cambio annullato, il modello resta quello di prima.');
    if (answer === 'no') throw new SwitchError('', true, true);
    if (claudeAsk(d.screen.lines())?.hot.toLowerCase() !== yes) throw new SwitchError('La conferma di Claude Code è cambiata nel terminale: controlla lì.', false);
    d.send('\r');
  }
  if (!(await done())) throw new SwitchError('Claude Code non ha confermato il cambio di modello.', false);
}

async function driveCodex(d: Drive, choice: SwitchChoice, effort: string | undefined): Promise<void> {
  const before = d.record()?.mark ?? '';
  const line = /Model changed to \S+.* for this session only/, seen = d.screen.lines().filter(l => line.test(l)).length;
  const catalog = modelCatalog().codex;
  await openSelector(d, /^\s*›\s*\/model\b/, CODEX_TITLE, 'di Codex');
  const at = catalog.findIndex(m => m.id === choice.id);
  await highlight(d, CODEX_TITLE, r => r.label.toLowerCase() === choice.label.toLowerCase(), () => (at < 0 ? null : at + 1), 'di Codex');
  d.send('\r');
  const level = await d.until('i livelli di ragionamento di Codex', lines => lines.map(l => CODEX_LEVEL.exec(l)).find(Boolean), 5000);
  if (level[1].toLowerCase() !== choice.label.toLowerCase()) throw new SwitchError(`Codex ha aperto i livelli di «${level[1]}» invece di «${choice.label}».`);
  if (!d.screen.lines().some(l => /\bs session\b/.test(l))) throw new SwitchError('Questa versione di Codex non offre la scelta «solo questa sessione»: il cambio salverebbe il modello come predefinito, quindi non lo faccio.');
  // Keep the session's effort when the new model lists it; otherwise the level Codex proposes.
  const wanted = effort ? CODEX_EFFORTS[effort] : undefined;
  const rows = selectorRows(d.screen.lines(), CODEX_LEVEL) ?? [];
  if (wanted && rows.some(r => r.label === wanted)) await highlight(d, CODEX_LEVEL, r => r.label === wanted, () => null, 'dei livelli di Codex');
  d.send('s');
  await d.until('la chiusura del selettore di Codex', lines => selectorRows(lines, CODEX_LEVEL) === null && selectorRows(lines, CODEX_TITLE) === null, 5000);
  if (!(await confirmed(d, before, r => (r.next ?? r.now) === choice.id, line, seen, 'Codex'))) throw new SwitchError('Codex non ha confermato il cambio di modello.', false);
}

function blockedBy(term: Term): string | null {
  const a = term.activity, info = term.info;
  if (info.attention) return 'la sessione aspetta una tua risposta';
  if (a.draft) return 'c’è un testo non inviato nel campo di scrittura';
  if (a.navigation) return 'nel terminale è aperto un menu o la cronologia';
  if (noticeInputBlocked(a, info)) return 'turno in corso';
  return null;
}

async function run(terms: TerminalStore, id: string, choice: SwitchChoice, claimed: () => Set<string>, change: Pending): Promise<void> {
  const term = terms.get(id);
  if (!term?.info.alive) throw new SwitchError('La sessione è terminata.', false);
  const info = term.info, a = term.activity;
  let size = sizes.get(id);
  if (!size) {
    // Never seen by an interface since this server started: give the PTY a size we know.
    size = { cols: 120, rows: 32 };
    terms.resize(id, size.cols, size.rows); noteSize(id, size.cols, size.rows);
    await pause(700);
  }
  const screen = new Screen(size.cols, size.rows);
  for (const chunk of term.buffer) screen.write(chunk);
  const listener = (data: string) => screen.write(data);
  term.listeners.add(listener);
  const typedAt = info.lastInputAt, hadAttention = info.attention;
  const untouched = () => term.info.alive && info.lastInputAt === typedAt;
  const d: Drive = {
    term, screen,
    send(data) {
      if (!untouched()) throw new SwitchError('La tastiera del terminale è stata usata durante il cambio: controlla il terminale e riprova.', false);
      noteInjected(a); term.proc.write(data);
    },
    async until(what, check, ms = 4000) {
      const end = Date.now() + ms;
      for (;;) {
        const value = check(screen.lines());
        if (value) return value;
        if (!term.info.alive) throw new SwitchError('La sessione è terminata durante il cambio.', false);
        if (Date.now() > end) throw new SwitchError(`Non ho visto ${what}.`);
        await pause(40);
      }
    },
    record: () => sessionModel(info, claimed, Date.now(), true),
    async decide(question, open) {
      Object.assign(change, { state: 'confirm', message: question, at: Date.now(), answer: undefined });
      const end = Date.now() + ANSWER_WITHIN_MS;
      try {
        for (;;) {
          if (!term.info.alive) throw new SwitchError('La sessione è terminata durante il cambio.', false);
          if (!open(screen.lines())) return 'terminal';
          if (change.answer !== undefined) return change.answer ? 'yes' : 'no';
          if (Date.now() > end) return 'late';
          await pause(100);
        }
      } finally { Object.assign(change, { state: 'running', message: undefined, answer: undefined }); }
    },
  };
  // Board notices wait while the selector is open, as they do for a text the person has not sent.
  a.draft = true;
  try {
    if (info.agent === 'claude') await driveClaude(d, choice);
    else await driveCodex(d, choice, sessionModel(info, claimed)?.nextEffort ?? sessionModel(info, claimed)?.nowEffort ?? info.effort);
  } catch (error) {
    if (error instanceof SwitchError && error.close && untouched()) {
      // Leave the terminal as it was: Esc closes the confirmation and the selector, never more than what we opened.
      for (let i = 0; i < 3; i++) {
        const lines = screen.lines();
        if (!lines.some(l => CLAUDE_TITLE.test(l) || CODEX_TITLE.test(l) || CODEX_LEVEL.test(l) || CLAUDE_ASK.test(l))) break;
        noteInjected(a); term.proc.write(ESC);
        await pause(400);
      }
    }
    throw error;
  } finally {
    // Answered in the terminal: the person's own keys keep their meaning, ours is over once the composer is empty again.
    if (untouched() || screen.lines().some(l => /^\s*[❯›]\s*$/.test(l))) a.draft = false;
    // The selector looks like a question to the activity scan, which may still be reading it: it was ours, nobody has to
    // answer it. For a moment after the last key, a question that the screen no longer shows is taken back.
    let checks = 8;
    const settle = (): void => {
      const asking = screen.lines().some(l => /[❯›] ?\d{1,2}\. ?\S|Enter to select/.test(l));
      if (!hadAttention && info.attention && untouched() && term.info.alive && !asking) setAttention(a, info, null);
      if (--checks > 0 && untouched() && term.info.alive) setTimeout(settle, 300).unref(); else term.listeners.delete(listener);
    };
    settle();
  }
}

/** Starts (or queues until the session is free) the change of a session's model. Throws with a message when it cannot. */
export function requestModelChange(terms: TerminalStore, id: string, model: string, claimed: () => Set<string>): ModelChange {
  const term = terms.get(id);
  if (!term) throw new Error('Sessione non trovata');
  const limit = switchLimit(term.info.agent);
  if (limit) throw new Error(limit);
  if (!term.info.alive) throw new Error('La sessione è terminata: riprendila prima di cambiare modello');
  const choice = switchChoices(term.info.agent).find(c => c.id === model);
  if (!choice) throw new Error('Modello non disponibile per questa sessione');
  const pending = changes.get(id);
  if (pending?.state === 'running' || pending?.state === 'confirm') throw new Error('Un cambio di modello è già in corso su questa sessione');
  if (pending?.timer) { clearTimeout(pending.timer); pending.cancelled = true; }
  const fields = modelFields(term.info, claimed);
  if (fields.modelChoice === choice.id) throw new Error('La sessione usa già questo modello');
  const change: Pending = { state: 'waiting', target: choice.id, label: choice.label, at: Date.now() };
  changes.set(id, change);
  const deadline = Date.now() + WAIT_FOR_MS;
  const attempt = (): void => {
    change.timer = undefined;
    if (change.cancelled) return;
    const t = terms.get(id);
    if (!t?.info.alive) { Object.assign(change, { state: 'failed', message: 'La sessione è terminata prima del cambio.', at: Date.now() }); return; }
    const blocked = blockedBy(t);
    if (blocked) {
      if (Date.now() > deadline) { Object.assign(change, { state: 'failed', message: `Cambio annullato dopo dieci minuti di attesa: ${blocked}.`, at: Date.now() }); return; }
      change.message = `In attesa: ${blocked}`;
      change.timer = setTimeout(attempt, RETRY_EVERY_MS); change.timer.unref();
      return;
    }
    change.state = 'running'; change.message = undefined; change.at = Date.now();
    void run(terms, id, choice, claimed, change).then(
      () => Object.assign(change, { state: 'done', message: undefined, at: Date.now() }),
      (error: unknown) => {
        if (error instanceof SwitchError && error.declined) { if (changes.get(id) === change) changes.delete(id); return; }
        Object.assign(change, { state: 'failed', message: error instanceof Error ? error.message : String(error), at: Date.now() });
      },
    );
  };
  attempt();
  return { state: change.state, target: change.target, label: change.label, message: change.message, at: change.at };
}

/** The person's answer to the question the CLI asked before switching. */
export function answerModelChange(id: string, yes: boolean): boolean {
  const change = changes.get(id);
  if (change?.state !== 'confirm') return false;
  change.answer = yes;
  return true;
}

/** A change the person no longer wants: a queued one is dropped, an open question gets "no"; a running one finishes its few keys. */
export function cancelModelChange(id: string): boolean {
  const change = changes.get(id);
  if (change?.state === 'confirm') return answerModelChange(id, false);
  if (!change || change.state !== 'waiting') return false;
  if (change.timer) clearTimeout(change.timer);
  change.cancelled = true; changes.delete(id);
  return true;
}

export function forgetModelChange(id: string): void {
  const change = changes.get(id);
  if (change?.timer) clearTimeout(change.timer);
  changes.delete(id); sizes.delete(id);
}
