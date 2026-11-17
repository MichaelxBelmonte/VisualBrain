// Input helpers of the terminal view that need no DOM: the "new terminal" shortcut and files dropped on a terminal.

export interface KeyLike { code: string; key?: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; repeat?: boolean }

/** ⌘J opens a new terminal in the current node. `code`, not `key`, so the keyboard layout does not matter. */
export const isNewTerminalKey = (e: KeyLike): boolean => e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.repeat && e.code === 'KeyJ';
/** ⌘⇧J: a plain terminal with no dialog. */
export const isPlainTerminalKey = (e: KeyLike): boolean => e.metaKey && !e.ctrlKey && !e.altKey && e.shiftKey && !e.repeat && e.code === 'KeyJ';

/**
 * ⌘+ / ⌘− / ⌘0 make the terminals' text bigger, smaller or back to normal. Both the physical key (US layout: ⌘= is ⌘+)
 * and the character are accepted: on an Italian keyboard + and - sit on other keys.
 */
export function fontZoomKey(e: KeyLike): 1 | -1 | 0 | null {
  if (!e.metaKey || e.ctrlKey || e.altKey) return null;
  if (e.code === 'Equal' || e.code === 'NumpadAdd' || e.key === '+') return 1;
  if (e.code === 'Minus' || e.code === 'NumpadSubtract' || e.key === '-') return -1;
  if (e.code === 'Digit0' || e.code === 'Numpad0') return 0;
  return null;
}
export const DEFAULT_FONT_SIZE = 12;
/** The next terminal text size in px: 9 to 20, 0 restores the default. */
export const zoomFont = (size: number, step: 1 | -1 | 0): number => step === 0 ? DEFAULT_FONT_SIZE : Math.min(20, Math.max(9, (Number.isFinite(size) ? size : DEFAULT_FONT_SIZE) + step));

/** Escapes one path for an interactive shell the way Terminal.app does when a file is dropped on it (backslashes, no quotes). */
export const shellQuotePath = (path: string): string => path.replace(/[^\p{L}\p{N}_\-.,:/@%+=~]/gu, c => (c === '\n' ? "'\n'" : '\\' + c));

/** What is typed into the terminal for a drop: the escaped paths separated by spaces, plus a trailing space. Nothing is executed. */
export const dropText = (paths: string[]): string => paths.filter(p => p.length > 0).map(shellQuotePath).join(' ') + (paths.length ? ' ' : '');

export interface FileDrop { kind: 'over' | 'drop' | 'leave'; paths: string[]; x: number | null; y: number | null }

/** The event sent by the desktop shell (CSS pixels) or anything malformed from the page: only well-formed drops get through. */
export function parseFileDrop(detail: unknown): FileDrop | null {
  const d = detail as Partial<FileDrop> | null;
  if (!d || (d.kind !== 'over' && d.kind !== 'drop' && d.kind !== 'leave')) return null;
  const paths = Array.isArray(d.paths) ? d.paths.filter((p): p is string => typeof p === 'string' && p.startsWith('/')).slice(0, 50) : [];
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return { kind: d.kind, paths, x: num(d.x), y: num(d.y) };
}
