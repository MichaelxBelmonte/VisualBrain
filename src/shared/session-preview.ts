// The last thing a session did, in a line or two, for the list of sessions: the agent's own words or the question it is
// asking, never the CLI's furniture (rules, composer, status line, shortcuts, spinners, start banner). A real error is
// always kept. Pure text in, text out: the caller renders the terminal's screen first.

export interface SessionPreview {
  /** The end of the session's activity, as one readable text; empty when the screen holds nothing worth showing. */
  text: string;
  /** A real error near the end that the text above does not already contain. */
  error?: string;
}

const MAX_TEXT = 280, BLOCK_LINES = 6, ERROR_WINDOW = 12;

const RULE = /^[\s─━═▔▁▂╌╍┄┈╭╮╰╯┌┐└┘├┤│┃|+·↑↓-]*$/;
const NUMBERED = /^\s*[❯›>]?\s*\d{1,2}\.\s+\S/, HOT = /^\s*[❯›]\s*\d{1,2}\.\s+\S/;
/** A row that starts with the prompt mark and is not a numbered choice: the composer, or something the person sent. */
const PROMPT = /^\s{0,2}[❯›](?:\s|$)(?!\s*\d{1,2}\.\s)/;
const BULLET = /^\s*[⏺●•]\s+/;
const KEYS_HINT = /\b(?:enter|esc|tab|↑\/↓|←\/→|ctrl\+\w)\b.*\b(?:to |confirm|select|cancel|submit|back|navigate|expand)\b/i;
const STATUS = [
  /\besc to interrupt\b/i,                                   // a turn in progress, both CLIs
  /^\s*[✻✽✢✶✳*∗·]\s*\S+(?:ed|ing|…)\b.*\bfor\s+\d/i,          // "✻ Worked for 1m 46s", "✻ Brewed for 9s"
  /^\s*[✻✽✢✶✳*∗·]\s*\S+…/,                                    // "✽ Manifesting… (3m · ↓ 16k tokens)"
  /^\s*[─\s]*Worked for \d/i,                                 // Codex's "─ Worked for 12s ─────"
  /^\s*(?:[⎿└]\s*)?Tip:\s/i,
  /\?\s+for shortcuts\b/i, /\bfor agents\b.*\bshortcuts\b/i,
  /\b\d+\s+warnings?\s+·\s+f2 to view\b/i,
  /⏵⏵|\bshift\+tab to cycle\b/i,
  /\bctrl\+o to expand\b/i, /^\s*…\s*\+\d+ lines\b/,
  /^\s*\+\s*Show details\s*$/i, /^\s*Field \d+\/\d+\s*$/i,
  /\bcontext left\b/i, /\bChecking for updates\b/i,
  /^\s*●\s*\w+\s*·\s*\/effort\b/,                             // Claude Code's effort mark, right-aligned above the composer
];
const BANNER = [
  /^\s*[▀-▟]/, /\bClaude Code v\d/i, /\bWelcome back\b/i, /\bTips for getting started\b/i, /\b(?:No )?recent activity\b/i,
  /\bOpenAI Codex\b/i, /^\s*(?:model|directory|cwd|approval|sandbox):\s/i, /\/model to change\b/i, /^\s*>_\s/,
  /\bTo get started, describe a task\b/i, /^\s*\/[a-z-]+ - \S/, /\bRun \/init\b/i, /\/help for help\b/i,
  /^\s*(?:~|\/)\S*$/,                                         // the working folder under the banner
];
const ERROR = /\b(?:error|errore|failed|failure|fallit[oa]|not logged in|unauthori[sz]ed|forbidden|denied|refused|exception|traceback|panic|rate limit|limit reached|quota exceeded|overloaded|timed out|timeout)\b|[✗✘⚠]/i;
const ERRNO = /\bE[A-Z]{4,}\b/;

const unbox = (line: string) => line.replace(/^\s*[│┃|]\s?/, '').replace(/\s*[│┃|]\s*$/, '');
const plain = (line: string) => unbox(line).replace(BULLET, '').replace(/^\s*[⎿└↳]\s*/, '').replace(/\s+/g, ' ').trim();
const furniture = (line: string) => RULE.test(line) || PROMPT.test(line) || KEYS_HINT.test(line) || STATUS.some(r => r.test(line)) || BANNER.some(r => r.test(line));
const clip = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1).trimEnd()}…` : text);

export function sessionPreview(lines: string[]): SessionPreview {
  let rows = lines.map(l => unbox(l.replace(/\s+$/, '')));
  // A question with numbered choices, one of them highlighted: the choices and the key hints under them are the CLI's,
  // the words above them are what the session is asking.
  const hot = rows.findLastIndex(l => HOT.test(l));
  let asking = false;
  if (hot >= 0) {
    let first = hot;
    while (first > 0 && (NUMBERED.test(rows[first - 1]) || (!rows[first - 1].trim() && first > 1 && NUMBERED.test(rows[first - 2])))) first--;
    rows = rows.slice(0, first); asking = true;
  } else {
    // Otherwise everything from the composer down is the CLI's own: the text being typed, status line, shortcuts, counters.
    const composer = rows.findLastIndex(l => PROMPT.test(l));
    // Choices without numbers ("❯ No, exit") still end with the keys that answer them.
    asking = composer >= 0 && rows.slice(composer).some(l => /\benter to (?:confirm|select|submit)\b/i.test(l));
    if (composer >= 0) rows = rows.slice(0, composer);
  }
  // '' is a blank row, null a piece of furniture: both separate blocks, only furniture bounds a question.
  // A long folder name under the start banner wraps: the rest of it, a single word right below, is banner too.
  let banner = false;
  const kept = rows.map(l => {
    if (!l.trim()) return '';
    const own = furniture(l) || (banner && !/\s/.test(l.trim()));
    banner = BANNER.some(r => r.test(l)) || (banner && own);
    return own ? null : l;
  });
  while (kept.length && !kept[kept.length - 1]) kept.pop();
  if (!kept.length) return { text: '' };
  // The last block: back to the mark that opens the agent's message, or to the separator above it.
  const block: string[] = [];
  for (let i = kept.length - 1; i >= 0 && block.length < BLOCK_LINES; i--) {
    const line = kept[i];
    if (line === null || (line === '' && !asking)) break;
    if (line === '') continue;
    block.unshift(line);
    if (BULLET.test(line)) break;
  }
  const text = block.map(plain).filter(Boolean).join(' ');
  const errors = kept.slice(Math.max(0, kept.length - ERROR_WINDOW)).filter((l): l is string => !!l).map(plain).filter(l => ERROR.test(l) || ERRNO.test(l));
  const error = errors.findLast(l => !text.includes(l));
  return { text: clip(text), ...(error ? { error: clip(error) } : {}) };
}
