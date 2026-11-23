// Lavoro board wording: the status line of each task and the "Serve te" hint when nothing waits on the person.
// Uso: node scripts/test-work-board.mjs — nessun server, nessuna app.
import assert from 'node:assert/strict';
import { setLanguage } from '../src/ui/i18n.ts';
import { addAgentChip, boardHint, inboxLane, taskLane, taskStatus, youDisclosure } from '../src/ui/work-board.ts';

setLanguage('it');
const op = (alive = true) => ({ code: 'OP3', alive });

// Lanes: blocked work and held reports wait on the person.
assert.equal(taskLane({ status: 'pending' }), 'todo');
assert.equal(taskLane({ status: 'working' }), 'doing');
assert.equal(taskLane({ status: 'blocked' }), 'you');
assert.equal(taskLane({ status: 'done' }), 'done');
assert.equal(inboxLane({ column: 'new' }), 'you');
assert.equal(inboxLane({ column: 'archived' }), 'done');

// One line per task: who has it and what happens next.
assert.deepEqual(taskStatus({ status: 'pending' }), { text: 'Da assegnare', tone: 'idle' });
assert.deepEqual(taskStatus({ status: 'pending', assignedTo: 'a' }, op()), { text: 'Assegnato a OP3 · non ancora iniziato', tone: 'idle' });
assert.deepEqual(taskStatus({ status: 'working', assignedTo: 'a' }, op()), { text: 'OP3 ci sta lavorando', tone: 'active' });
assert.deepEqual(taskStatus({ status: 'working', assignedTo: 'a' }, op(false)), { text: 'OP3 si è fermato · riassegnalo', tone: 'stale' });
assert.deepEqual(taskStatus({ status: 'working', assignedTo: 'gone' }), { text: 'L’agente si è fermato · riassegnalo', tone: 'stale' });
assert.deepEqual(taskStatus({ status: 'pending', assignedTo: 'gone' }), { text: 'Assegnato a una sessione terminata · riassegnalo', tone: 'stale' });
assert.deepEqual(taskStatus({ status: 'blocked', assignedTo: 'a' }, op()), { text: 'Bloccato · OP3 aspetta una tua decisione', tone: 'blocked' });
assert.equal(taskStatus({ status: 'blocked', assignedTo: 'a', blockedOwnerCode: 'OP3' }).text, 'Bloccato · ultimo responsabile OP3');
assert.deepEqual(taskStatus({ status: 'done', assignedTo: 'a' }, op(false)), { text: 'Completato · OP3', tone: 'done' });
console.log('PASS task status line: unassigned, waiting, working, stopped, blocked, done');

// "Serve te" empty: the squad state in one sentence and the next useful move.
const t = (status, assignedTo) => ({ status, assignedTo });
assert.deepEqual(boardHint([t('working', 'a')], 0), { text: 'Squadra ferma: nessun agente attivo.', action: 'agent' });
// «+ Incarico» stays in the header: the hint never repeats it.
assert.deepEqual(boardHint([], 2), { text: 'Nessun incarico ancora.' });
assert.deepEqual(boardHint([t('working', 'a'), t('pending')], 2), { text: 'In corso: 1 · in coda: 1. Nessuna azione per te.' });
assert.deepEqual(boardHint([t('working', 'a'), t('done', 'a')], 2), { text: 'In corso: 1. Nessuna azione per te.' });
assert.match(boardHint([t('pending'), t('pending', 'a')], 2).text, /^Da assegnare: 1\. /);
assert.deepEqual(boardHint([t('pending', 'a')], 2), { text: 'In attesa di partire: 1.' });
assert.deepEqual(boardHint([t('done', 'a')], 1), { text: 'Tutti gli incarichi sono completati.' });

// «+ Agente» once: the hint offers it with no agent running and nothing waiting; otherwise the + beside the members does.
const member = (alive, role = 'operator') => ({ alive, role });
assert.equal(addAgentChip([], 0), false, 'empty squad, empty «Serve te»: the hint has the button');
assert.equal(addAgentChip([member(false)], 0), false, 'ended agents only: still the hint');
assert.equal(addAgentChip([member(true)], 0), true, 'agents running: the hint has no button, the chip does');
assert.equal(addAgentChip([{ alive: true }], 0), false, 'a plain shell is not an agent of the squad');
assert.equal(addAgentChip([member(false)], 2), true, 'requests waiting and no agent: the hint is hidden, the chip stays');

setLanguage('en');
assert.equal(taskStatus({ status: 'working', assignedTo: 'a' }, op()).text, 'OP3 is working on it');
assert.equal(boardHint([t('working', 'a')], 1).text, 'In progress: 1. Nothing for you to do.');
assert.equal(taskStatus({ status: 'pending' }).text, 'Unassigned');
setLanguage('it');
console.log('PASS "Serve te" hint: stopped squad, no tasks, in progress, unassigned, waiting, all done (IT/EN)');

for (const total of [0, 1, 4, 9]) {
  for (const columns of [1, 2, 3]) {
    const shown = Math.min(total, 2 * columns);
    assert.deepEqual(youDisclosure(total, columns, false), { shown, label: total > shown ? `Mostra altri ${total - shown}` : '' });
    assert.deepEqual(youDisclosure(total, columns, true), { shown: total, label: total > shown ? 'Mostra meno' : '' });
  }
}
setLanguage('en');
assert.deepEqual(youDisclosure(9, 3, false), { shown: 6, label: 'Show 3 more' });
assert.deepEqual(youDisclosure(9, 3, true), { shown: 9, label: 'Show less' });
setLanguage('it');
console.log('PASS "Serve te" shows two grid rows, counts the remaining cards and labels both actions in IT/EN');

// --- Editable board (0.2.65): one-line entry, drops, order, the «now» line, the rail filters.
import { laneMove, nowLine, parseQuickTask, placeAt, sortCards } from '../src/ui/work-tasks.ts';
import { laneDropTarget } from '../src/ui/board-drag.ts';
import { inRailFilter, railCounts } from '../src/ui/work-roles.ts';

assert.deepEqual(parseQuickTask('Rifai il menu !alta #ui #UI @op2'), { title: 'Rifai il menu', priority: 'high', labels: ['ui'], assignee: 'OP2' });
assert.deepEqual(parseQuickTask('  Scrivi i test   !bassa '), { title: 'Scrivi i test', priority: 'low', labels: [] });
assert.deepEqual(parseQuickTask('Correggi #123 e poi rilascia !'), { title: 'Correggi e poi rilascia', priority: 'high', labels: ['123'] });
assert.deepEqual(parseQuickTask('Spiega il caso a@b.it'), { title: 'Spiega il caso a@b.it', labels: [] }, 'an email is not an assignee');
assert.equal(parseQuickTask('#solo @OP1 !alta'), null, 'no title left: nothing to create');
console.log('PASS one-line entry: title plus !alta/!bassa, #labels (no duplicates), @code; nothing without a title');

assert.deepEqual(laneMove({ status: 'pending', assignedTo: 's2' }, 'doing', true), { status: 'working' });
assert.deepEqual(laneMove({ status: 'pending', assignedTo: null }, 'doing', false), { needsOwner: true }, 'nobody to do it: ask first');
assert.deepEqual(laneMove({ status: 'pending', assignedTo: 's2' }, 'doing', false), { needsOwner: true }, 'a stopped owner cannot start');
assert.deepEqual(laneMove({ status: 'done', assignedTo: 's2' }, 'todo', true), { status: 'pending' });
assert.deepEqual(laneMove({ status: 'blocked', assignedTo: 's2' }, 'done', true), { status: 'done' });
assert.equal(laneMove({ status: 'working', assignedTo: 's2' }, 'doing', true), null, 'same column: only the position');
console.log('PASS drops: «In corso» needs a live owner, other columns set the status, the same column only reorders');

const base = { status: 'pending', updatedAt: 0 };
const sorted = sortCards([
  { ...base, id: 'old', createdAt: 1 }, { ...base, id: 'new', createdAt: 5 }, { ...base, id: 'low', priority: 'low', createdAt: 9 },
  { ...base, id: 'high', priority: 'high', createdAt: 2 }, { ...base, id: 'placed2', order: 2048 }, { ...base, id: 'placed1', order: 1024 },
]).map(t => t.id);
assert.deepEqual(sorted, ['high', 'new', 'old', 'low', 'placed1', 'placed2'], 'unplaced by priority then newest, placed ones after in their order');
assert.deepEqual(sortCards([{ status: 'done', updatedAt: 1, id: 'a' }, { status: 'done', updatedAt: 9, id: 'b' }]).map(t => t.id), ['b', 'a'], '«Fatto»: latest first');
assert.deepEqual(placeAt([{ id: 'a', order: 1024 }, { id: 'b', order: 2048 }], 'x', 1), [{ id: 'x', order: 1536 }], 'between neighbours: one write');
assert.deepEqual(placeAt([{ id: 'a', order: 1024 }], 'x', 0), [{ id: 'x', order: 0 }]);
assert.deepEqual(placeAt([{ id: 'a', order: 1024 }], 'x', 1), [{ id: 'x', order: 2048 }]);
assert.deepEqual(placeAt([{ id: 'a' }, { id: 'b', order: 2048 }], 'x', 1), [{ id: 'a', order: 1024 }, { id: 'x', order: 2048 }, { id: 'b', order: 3072 }], 'unplaced cards: the column is numbered once');
assert.deepEqual(placeAt([], 'x', 0), [{ id: 'x', order: 0 }]);
console.log('PASS order: priority and age until placed by hand; a drop writes one position, or numbers the column once');

const boxes = [{ lane: 'todo', left: 0, right: 100, top: 0, bottom: 500, mids: [50, 150] }, { lane: 'doing', left: 120, right: 220, top: 0, bottom: 500, mids: [] }];
assert.deepEqual(laneDropTarget(boxes, 50, 100), { lane: 'todo', index: 1 });
assert.deepEqual(laneDropTarget(boxes, 50, 400), { lane: 'todo', index: 2 });
assert.deepEqual(laneDropTarget(boxes, 115, 20), { lane: 'doing', index: 0 }, 'between columns: the nearest');
assert.equal(laneDropTarget([], 0, 0), null);
console.log('PASS drop target: column under the pointer (or the nearest) and the place among its cards');

const now = 10_000_000;
const working = { alive: true, agent: 'claude', title: '✳ Aggiorna work-board.ts', stateAt: now - 12 * 60_000, lastOutputAt: now - 2000 };
assert.deepEqual(nowLine(working, undefined, now), { doing: 'Aggiorna work-board.ts', meta: 'al lavoro da 12 min · sta scrivendo', live: true });
assert.equal(nowLine({ ...working, title: '✳ Claude Code' }, undefined, now).doing, '', 'a generic title says nothing');
assert.equal(nowLine({ ...working, lastOutputAt: now - 5 * 60_000 }, undefined, now).meta, 'al lavoro da 12 min · ultimo segnale 5 min fa');
assert.equal(nowLine({ ...working, alive: false }, undefined, now), null);
console.log('PASS «now» line: the terminal title when it says something, time at work, output coming or the last signal');

const tone = (extra) => ({ alive: true, role: 'operator', ...extra });
const sessions = [tone({ workState: 'working', lastOutputAt: now - 1000 }), tone({ attention: 'permission' }), tone({ workState: 'blocked' }), tone({ alive: false }), { alive: true }];
assert.deepEqual(railCounts(sessions, now), { all: 5, active: 1, needs: 2, ended: 1 });
assert.ok(inRailFilter('all', { alive: false }, now) && !inRailFilter('needs', sessions[0], now));
console.log('PASS rail filters: Tutti, Attivi, Per te and Chiusi count what each would list');
