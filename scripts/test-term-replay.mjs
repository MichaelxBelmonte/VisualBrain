// A client attaching to a running full-screen program is put back on the alternate screen and asks for a repaint.
// Uso: node scripts/test-term-replay.mjs — solo stringhe, nessun processo.
import assert from 'node:assert/strict';
import { replayState } from '../src/server/terminals.ts';

const ESC = '\x1b';
const frame = `${ESC}[?1000h${ESC}[?1002h${ESC}[?1003h${ESC}[?1006h${ESC}[2;1Hrisposta${ESC}[49;1H> `;

// Claude's fullscreen view entered the alternate screen before the kept tail: only its mouse tracking shows.
assert.deepEqual(replayState(['vecchio output', frame, frame]), { prefix: `${ESC}[?1049h`, fullScreen: true });
// A combined sequence counts too, and a chunk boundary inside the tail does not hide it.
assert.deepEqual(replayState([`${ESC}[?1000;10`, `06h testo`]), { prefix: `${ESC}[?1049h`, fullScreen: true });
// The tail holds the switch itself: the replay enters the alternate screen on its own, a repaint is still due.
assert.deepEqual(replayState([`$ claude\r\n${ESC}[?1049h`, frame]), { prefix: '', fullScreen: true });
// The program left: alternate screen and mouse off, nothing to add.
assert.deepEqual(replayState([`${ESC}[?1049h`, frame, `${ESC}[?1006l${ESC}[?1003l${ESC}[?1002l${ESC}[?1000l${ESC}[?1049l$ `]), { prefix: '', fullScreen: false });
// Left long ago (its exit sequences are in the tail, the entry is not): still nothing.
assert.deepEqual(replayState([frame, `${ESC}[?1000l${ESC}[?1002l${ESC}[?1003l${ESC}[?1006l$ ls\r\n`]), { prefix: '', fullScreen: false });
// A plain shell, Codex's inline view (synchronized output, no mouse), bracketed paste: the normal screen stays.
assert.deepEqual(replayState([`${ESC}[?2004h$ `, `${ESC}[?2026h${ESC}[?25l• lavoro${ESC}[?2026l`]), { prefix: '', fullScreen: false });
assert.deepEqual(replayState([]), { prefix: '', fullScreen: false });
console.log('PASS terminal replay: full-screen programs resume on the alternate screen with a repaint, other sessions untouched');
