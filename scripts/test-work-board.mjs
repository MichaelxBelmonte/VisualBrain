// Lavoro board wording: the status line of each task and the "Serve te" hint when nothing waits on the person.
// Uso: node scripts/test-work-board.mjs — nessun server, nessuna app.
import assert from 'node:assert/strict';
import { setLanguage } from '../src/ui/i18n.ts';
import { boardHint, inboxLane, taskLane, taskStatus, youDisclosure } from '../src/ui/work-board.ts';

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
