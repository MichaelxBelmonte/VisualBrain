// The rules behind the editable Lavoro board, kept pure so they can be tested without a page: what a one-line entry
// means, where a card goes when it is dropped in a column, the order of the cards and the «what is it doing now» line.
import { t as tr } from './i18n.ts';
import type { TeamTask } from '../shared/types.ts';

export type Column = 'todo' | 'doing' | 'done';

/** A translated sentence with its {placeholders} filled; values are inserted as they are (a «$» in a title stays). */
export function fill(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (match, key: string) => key in values ? String(values[key]) : match);
}

/**
 * «Rifai il menu !alta #ui @OP2» → title, priority, labels and the session code to assign. Words that are not
 * shortcuts stay in the title, in their order. Null when no title is left.
 */
export function parseQuickTask(text: string): { title: string; priority?: 'high' | 'low'; labels: string[]; assignee?: string } | null {
  let priority: 'high' | 'low' | undefined, assignee: string | undefined;
  const labels: string[] = [], words: string[] = [];
  for (const word of text.trim().split(/\s+/)) {
    const lower = word.toLowerCase();
    if (/^!(alta|high|!|urgente|urgent)$/.test(lower) || lower === '!') priority = 'high';
    else if (/^!(bassa|low)$/.test(lower)) priority = 'low';
    else if (/^#[\p{L}\p{N}_-]{1,24}$/u.test(word)) { const label = word.slice(1); if (!labels.some(l => l.toLowerCase() === label.toLowerCase()) && labels.length < 8) labels.push(label); }
    else if (/^@[A-Za-z]+\d*$/.test(word)) assignee = word.slice(1).toUpperCase();
    else if (word) words.push(word);
  }
  const title = words.join(' ').slice(0, 1000);
  return title ? { title, ...(priority ? { priority } : {}), labels, ...(assignee ? { assignee } : {}) } : null;
}

/** The column a task shows in; blocked ones wait in «Serve te» above the columns. */
export function columnOf(t: Pick<TeamTask, 'status'>): Column | 'you' {
  return t.status === 'pending' ? 'todo' : t.status === 'working' ? 'doing' : t.status === 'blocked' ? 'you' : 'done';
}

/**
 * What a drop asks the server. In «In corso» a task needs a live owner: without one the card opens on «Assegna a»
 * instead. Same column: only the position changes (`null`, the caller sends the order).
 */
export function laneMove(t: Pick<TeamTask, 'status' | 'assignedTo'>, to: Column, ownerAlive: boolean): { status: TeamTask['status'] } | { needsOwner: true } | null {
  const from = columnOf(t);
  if (from === to) return null;
  if (to === 'todo') return { status: 'pending' };
  if (to === 'done') return { status: 'done' };
  return t.assignedTo && ownerAlive ? { status: 'working' } : { needsOwner: true };
}

const RANK = { high: 0, undefined: 1, low: 2 } as const;
/**
 * The order of a column: cards the person placed by hand (with `order`) after the unplaced ones, which go by
 * priority then newest first, right under the entry field. «Fatto» goes by latest completion.
 */
export function sortCards<T extends Pick<TeamTask, 'order' | 'priority' | 'createdAt' | 'updatedAt' | 'status'>>(tasks: T[]): T[] {
  return [...tasks].sort((a, b) => {
    if (a.status === 'done' && b.status === 'done') return b.updatedAt - a.updatedAt;
    const ao = a.order, bo = b.order;
    if (ao !== undefined && bo !== undefined) return ao - bo;
    if (ao !== undefined) return 1;
    if (bo !== undefined) return -1;
    return RANK[String(a.priority) as keyof typeof RANK] - RANK[String(b.priority) as keyof typeof RANK] || (b.createdAt ?? b.updatedAt) - (a.createdAt ?? a.updatedAt);
  });
}

/**
 * Positions after a card is dropped at `index` in a column (the list without it, in shown order). When every card
 * already has a position, one number between its neighbours; otherwise the whole column is numbered once.
 */
export function placeAt(column: Array<{ id: string; order?: number }>, movedId: string, index: number): Array<{ id: string; order: number }> {
  const others = column.filter(c => c.id !== movedId);
  const at = Math.max(0, Math.min(index, others.length));
  if (others.every(c => c.order !== undefined)) {
    const prev = others[at - 1]?.order, next = others[at]?.order;
    const order = prev === undefined && next === undefined ? 0 : prev === undefined ? next! - 1024 : next === undefined ? prev + 1024 : (prev + next) / 2;
    return [{ id: movedId, order }];
  }
  const ids = [...others.map(c => c.id)];
  ids.splice(at, 0, movedId);
  return ids.map((id, i) => ({ id, order: (i + 1) * 1024 })).filter(p => column.find(c => c.id === p.id)?.order !== p.order);
}

const GENERIC = /^(✳\s*)?(claude( code)?|codex|hermes|antigravity|agy|zsh|bash|shell|orchestrat\w*|operat\w*|review\w*|revisor\w*)?$/i;
const since = (ms: number) => ms < 60_000 ? tr('meno di un minuto') : ms < 3_600_000 ? `${Math.floor(ms / 60_000)} min` : `${Math.floor(ms / 3_600_000)} h ${Math.floor(ms % 3_600_000 / 60_000)} min`;
/**
 * «What it is doing now» on a card in progress: the terminal title when it says something (Claude Code writes its
 * current step there), how long it has been at it, and whether output is coming. Null for a stopped owner.
 */
export function nowLine(s: { alive: boolean; title?: string; agent?: string; stateAt?: number; createdAt?: number; lastOutputAt?: number }, startedAt: number | undefined, now = Date.now()): { doing: string; meta: string; live: boolean } | null {
  if (!s.alive) return null;
  const title = (s.title ?? '').replace(/^[\s✳⠂⠐·*]+/, '').trim();
  const doing = title && !GENERIC.test(title) && title.toLowerCase() !== (s.agent ?? '').toLowerCase() ? title : '';
  const live = s.lastOutputAt !== undefined && now - s.lastOutputAt < 10_000;
  const from = startedAt ?? s.stateAt;
  const parts = [from ? fill(tr('al lavoro da {n}'), { n: since(Math.max(0, now - from)) }) : '', live ? tr('sta scrivendo') : s.lastOutputAt ? fill(tr('ultimo segnale {n} fa'), { n: since(Math.max(0, now - s.lastOutputAt)) }) : ''].filter(Boolean);
  return { doing, meta: parts.join(' · '), live };
}
