// Roles and run state share one colour language; ⌘J opens the + Agent dialog; files dropped on a terminal are typed, escaped, never run.
// Uso: node scripts/test-work-input.mjs — nessun server, nessuna app.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TONES, sessionTone } from '../src/ui/work-roles.ts';
import { DEFAULT_FONT_SIZE, dropText, fontZoomKey, isNewTerminalKey, parseFileDrop, shellQuotePath, zoomFont } from '../src/ui/work-input.ts';
import { clampSplit } from '../src/ui/work-tiles.ts';

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.deepEqual(a, b, m); };

// --- tones -------------------------------------------------------------------------------------------------------------
eq(sessionTone({ alive: true, role: 'orchestrator', workState: 'idle' }), 'orchestrator', 'the orchestrator keeps its fixed colour whatever it is doing');
eq(sessionTone({ alive: true, role: 'orchestrator', workState: 'working' }), 'orchestrator', 'fixed also while working');
eq(sessionTone({ alive: true, role: 'operator', workState: 'working' }), 'active', 'working operator');
eq(sessionTone({ alive: true, role: 'operator' }), 'active', 'an operator that has not reported yet is just started: active');
eq(sessionTone({ alive: true, role: 'operator', workState: 'idle' }), 'idle', 'waiting operator');
eq(sessionTone({ alive: true, role: 'reviewer', workState: 'idle' }), 'idle', 'a reviewer follows the operator colours');
eq(sessionTone({ alive: true, role: 'operator', workState: 'blocked' }), 'blocked', 'blocked operator');
eq(sessionTone({ alive: false, role: 'operator', workState: 'working' }), 'ended', 'a terminated session is muted whatever its last state');
eq(sessionTone({ alive: false, role: 'orchestrator' }), 'ended', 'also a terminated orchestrator');
eq(sessionTone({ alive: true }), null, 'a plain terminal has no role and no tone');
eq(TONES.length, new Set(TONES).size, 'tones are distinct');

// --- ⌘J ----------------------------------------------------------------------------------------------------------------
const key = (extra = {}) => ({ code: 'KeyJ', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, ...extra });
ok(isNewTerminalKey(key()), '⌘J');
ok(!isNewTerminalKey(key({ metaKey: false })) && !isNewTerminalKey(key({ ctrlKey: true })) && !isNewTerminalKey(key({ altKey: true })) && !isNewTerminalKey(key({ shiftKey: true })), 'other modifier combinations are left alone');
ok(!isNewTerminalKey(key({ repeat: true })) && !isNewTerminalKey(key({ code: 'KeyK' })), 'holding the key does not open a stream of terminals; other keys are not matched');

// --- dropped files -----------------------------------------------------------------------------------------------------
eq(shellQuotePath('/Users/me/Desktop/file.txt'), '/Users/me/Desktop/file.txt', 'plain paths are untouched');
eq(shellQuotePath('/Users/me/My Files/a b.png'), '/Users/me/My\\ Files/a\\ b.png', 'spaces are escaped like Terminal.app');
eq(shellQuotePath('/tmp/a;rm -rf ~.txt'), '/tmp/a\\;rm\\ -rf\\ ~.txt', 'shell metacharacters cannot start a command');
eq(shellQuotePath('/tmp/$(id)`x`&|<>*?"\'(){}[]#!'), '/tmp/\\$\\(id\\)\\`x\\`\\&\\|\\<\\>\\*\\?\\"\\\'\\(\\)\\{\\}\\[\\]\\#\\!', 'every metacharacter is escaped');
eq(shellQuotePath('/Users/me/Città/è.pdf'), '/Users/me/Città/è.pdf', 'accented letters stay readable');
eq(dropText(['/a b', '/c']), '/a\\ b /c ', 'several files: separated by spaces, with a trailing space, no newline (nothing runs by itself)');
ok(!dropText(['/tmp/x\ny']).includes('\n\n') && !/(^|[^\\'])\n/.test(dropText(['/tmp/x\ny'])), 'a newline inside a name never ends the typed line');
eq(dropText([]), '', 'nothing dropped, nothing typed');
eq(parseFileDrop({ kind: 'drop', paths: ['/a', 'relative', 3], x: 10, y: 20 }), { kind: 'drop', paths: ['/a'], x: 10, y: 20 }, 'only absolute path strings pass');
eq(parseFileDrop({ kind: 'leave' }), { kind: 'leave', paths: [], x: null, y: null }, 'leave has no position');
eq([parseFileDrop(null), parseFileDrop({ kind: 'x' }), parseFileDrop('drop')], [null, null, null], 'malformed events are ignored');
eq(parseFileDrop({ kind: 'drop', paths: Array.from({ length: 80 }, (_, i) => `/f${i}`), x: 1, y: 1 }).paths.length, 50, 'a drop is capped at 50 files');
eq(parseFileDrop({ kind: 'drop', paths: ['/a'], x: NaN, y: 'a' }).x, null, 'bad coordinates are dropped');

// --- reordering with the pointer -----------------------------------------------------------------------------------------
const { dropTarget } = await import('../src/ui/work-reorder.ts');
eq([dropTarget([10, 30, 50], 5), dropTarget([10, 30, 50], 20), dropTarget([10, 30, 50], 49), dropTarget([10, 30, 50], 80), dropTarget([], 5)], [0, 1, 2, null, null], 'the dragged row goes in front of the first row whose middle is below the pointer, or last');

// --- wiring -------------------------------------------------------------------------------------------------------------
const src = readFileSync(new URL('../src/ui/terminal.ts', import.meta.url), 'utf8');
const method = (n) => { let i = src.indexOf(`  private ${n}(`); if (i < 0) i = src.indexOf(`  private async ${n}(`); assert.ok(i >= 0, n); return src.slice(i, i + 2400); };
ok(!/draggable|dragstart/.test(src), 'no HTML5 drag and drop (the desktop shell swallows it)');
ok(/isNewTerminalKey\(e\)/.test(method('shortcutKey')) && /preventDefault\(\)/.test(method('shortcutKey')) && /addEventListener\('keydown', e => this\.shortcutKey\(e\), true\)/.test(src), '⌘J is a capture listener, so xterm never receives it');
ok(/this\.openLauncher\(\)/.test(method('shortcutKey')) && !/newTerminal/.test(src), '⌘J opens the "+ Agent" dialog (a plain terminal is chosen there)');
ok(/term\.paste\(dropText\(/.test(method('fileDrop')) && !/\\r|\\n|send\(/.test(method('fileDrop').replace(/\\n/g, '')), 'a drop is pasted (bracketed paste), it is never sent with a newline');
ok(/readyState !== WebSocket\.OPEN/.test(method('fileDrop')) && /alive/.test(method('fileDrop')), 'a drop on an ended or disconnected terminal inserts nothing');
ok(/vb-file-drop/.test(src), 'the desktop shell event is listened to');
const rust = readFileSync(new URL('../app/src-tauri/src/main.rs', import.meta.url), 'utf8');
ok(/DragDropEvent::Drop/.test(rust) && /vb-file-drop/.test(rust) && /serde_json::json!/.test(rust), 'the desktop shell forwards dropped paths as a JSON event');
ok(/data-tone/.test(method('updateCard')) || /dataset\.tone/.test(method('updateCard')), 'the terminal header carries the tone');
ok(/openNode\(id\)/.test(src) && /private openNode\(/.test(src), 'the rail opens a node through openNode');

// ⌘+ / ⌘− / ⌘0: terminal text size, on US and Italian layouts; never with Ctrl or Alt, never without ⌘.
const zoomKey = (code, key, extra = {}) => ({ code, key, metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, ...extra });
ok(fontZoomKey(zoomKey('Equal', '=')) === 1, '⌘= (⌘+ on a US keyboard) enlarges');
ok(fontZoomKey(zoomKey('BracketRight', '+')) === 1, '⌘+ on an Italian keyboard enlarges');
ok(fontZoomKey(zoomKey('Minus', '-')) === -1 && fontZoomKey(zoomKey('Slash', '-')) === -1, '⌘− shrinks on both layouts');
ok(fontZoomKey(zoomKey('Digit0', '0')) === 0, '⌘0 restores');
ok(fontZoomKey(zoomKey('Equal', '=', { metaKey: false })) === null && fontZoomKey(zoomKey('Equal', '=', { ctrlKey: true })) === null && fontZoomKey(zoomKey('KeyJ', 'j')) === null, 'other keys pass through');
ok(zoomFont(12, 1) === 13 && zoomFont(20, 1) === 20 && zoomFont(9, -1) === 9 && zoomFont(17, 0) === DEFAULT_FONT_SIZE && zoomFont(NaN, 1) === DEFAULT_FONT_SIZE + 1, 'text size stays between 9 and 20 px');
ok(clampSplit(0.7) === 0.7 && clampSplit(0.02) === 0.15 && clampSplit(0.99) === 0.85 && clampSplit(NaN) === 0.5, 'a divider never hides a terminal');
const css = readFileSync(new URL('../src/ui/style.css', import.meta.url), 'utf8');
ok(!/terminal-surface \.xterm \{[^}]*inset: [1-9]/.test(css), 'the terminal margin is padding the fit addon subtracts, so the last row is not cut');

// Drops: positions are CSS pixels, and a drag that brings no file name (promised files, image data) is not lost silently.
const fileDrop = src.slice(src.indexOf('private fileDrop('), src.indexOf('private roleName('));
ok(!/devicePixelRatio/.test(fileDrop) && /elementFromPoint\(drop\.x, drop\.y\)/.test(fileDrop), 'drop positions are CSS pixels: a Retina screen no longer halves them');
ok(/Non ho ricevuto nessun file/.test(fileDrop), 'a drag that brings no file says so instead of doing nothing');
const shell = readFileSync(new URL('../app/src-tauri/src/main.rs', import.meta.url), 'utf8');
ok(/kind == "drop" && paths\.is_empty\(\)/.test(shell) && /NSFilePromiseReceiver/.test(shell) && /NSPasteboardTypeTIFF/.test(shell), 'promised files and image data are read from the drag pasteboard');
ok(/if cfg!\(target_os = "macos"\) \{ 1\.0 \}/.test(shell), 'macOS points are not divided by the scale factor again');

console.log(`test-work-input: ${checks} controlli ok`);
