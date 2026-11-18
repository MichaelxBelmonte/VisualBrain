// Impostazioni shows one section at a time: an answer that arrives after the person moved to another section must not
// replace what they are reading (GitHub answering late used to overwrite Aggiornamenti). No browser: a few fake elements.
import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';

class El {
  constructor(connected = false) { this.root = connected; this.parent = null; this.children = []; this.innerHTML = ''; }
  get isConnected() { for (let n = this; n; n = n.parent) if (n.root) return true; return false; }
  replaceChildren(...next) { for (const c of this.children) c.parent = null; this.children = next; for (const c of next) c.parent = this; }
}
const old = globalThis.document;
globalThis.document = { createElement: () => new El() };
const { sectionViews } = await import('../src/ui/section-views.ts');
const gate = () => { let open, fail; const wait = new Promise((ok, no) => { open = ok; fail = no; }); return { wait, open, fail }; };
const tick = () => pause(0);
const shown = body => body.children.map(c => c.innerHTML).join('|');
// the shapes of the real renderers: GitHub checks its root after the request, Cartelle writes without checking
const slow = (name, g) => async root => { root.innerHTML = `${name}: caricamento`; await g.wait; if (!root.isConnected) return; root.innerHTML = `${name}: pronto`; };
const careless = (name, g) => async root => { await g.wait; root.innerHTML = `${name}: pronto`; };
const updates = async root => { root.innerHTML = 'Aggiornamenti: [Verifica aggiornamenti]'; };
const errors = [];
const fail = (root, e) => { errors.push(String(e.message ?? e)); root.innerHTML = `errore: ${e.message ?? e}`; };

try {
  { // GitHub answers after the move to Aggiornamenti
    const body = new El(true), views = sectionViews(body), g = gate();
    const github = views.show(slow('GitHub', g), fail);
    assert.equal(shown(body), 'GitHub: caricamento');
    const row = views.show(updates, fail);
    g.open(); await tick();
    assert.equal(shown(body), 'Aggiornamenti: [Verifica aggiornamenti]');
    assert.equal(body.children.length, 1); assert.equal(body.children[0], row);
    assert.equal(github.isConnected, false); assert.equal(github.innerHTML, 'GitHub: caricamento', 'the late answer wrote nothing');
    console.log('PASS a late GitHub answer leaves Aggiornamenti as it is: one root shown, the old one detached');
  }
  { // the same with a renderer that never checks, and with a request that fails late
    const body = new El(true), views = sectionViews(body), a = gate(), b = gate(); errors.length = 0;
    views.show(careless('Cartelle', a), fail); views.show(slow('GitHub', b), fail); views.show(updates, fail);
    a.open(); b.fail(new Error('gh non risponde')); await tick();
    assert.equal(shown(body), 'Aggiornamenti: [Verifica aggiornamenti]');
    assert.deepEqual(errors, [], 'the error of a section already left is dropped');
    console.log('PASS a renderer that writes without checking and a late error do not touch the section shown');
  }
  { // there and back, answers out of order: only the last GitHub view counts
    const body = new El(true), views = sectionViews(body), first = gate(), second = gate(); errors.length = 0;
    views.show(slow('GitHub 1', first), fail); views.show(updates, fail);
    const last = views.show(slow('GitHub 2', second), fail);
    second.open(); await tick(); assert.equal(shown(body), 'GitHub 2: pronto');
    first.fail(new Error('vecchia risposta')); await tick();
    assert.equal(shown(body), 'GitHub 2: pronto'); assert.deepEqual(errors, []); assert.equal(body.children[0], last);
    views.show(updates, fail); views.show(slow('GitHub 3', gate()), fail); views.show(updates, fail); await tick();
    assert.equal(shown(body), 'Aggiornamenti: [Verifica aggiornamenti]');
    console.log('PASS several moves and answers out of order: title and content follow the last choice only');
  }
  { // the error of the section shown is still told
    const body = new El(true), views = sectionViews(body), g = gate(); errors.length = 0;
    views.show(slow('GitHub', g), fail); g.fail(new Error('rete assente')); await tick();
    assert.equal(shown(body), 'errore: rete assente'); assert.deepEqual(errors, ['rete assente']);
    console.log('PASS the error of the section on screen is shown');
  }
  { // timers belong to the section that asked for them
    const body = new El(true), views = sectionViews(body, 20); let fired = [];
    let again; views.show(async (root, schedule) => { again = schedule; schedule(() => fired.push('agenti')); }, fail);
    views.show(updates, fail); again(() => fired.push('agenti, tardi')); await pause(60);
    assert.deepEqual(fired, [], 'a section left behind neither fires nor arms a timer');
    views.show(async (root, schedule) => { schedule(() => fired.push('agenti di nuovo')); }, fail); await pause(60);
    assert.deepEqual(fired, ['agenti di nuovo']);
    console.log('PASS a refresh timer fires only while its own section is the one shown');
  }
  { // closing drops what was pending; a new window starts clean
    const body = new El(true), views = sectionViews(body, 20), g = gate(); let fired = 0; errors.length = 0;
    views.show(async (root, schedule) => { schedule(() => fired++); await g.wait; root.innerHTML = 'GitHub: pronto'; }, fail);
    views.close(); g.fail(new Error('dopo la chiusura')); await pause(60);
    assert.equal(body.children.length, 0); assert.equal(fired, 0); assert.deepEqual(errors, []);
    const reopened = new El(true), next = sectionViews(reopened); next.show(updates, fail); await tick();
    assert.equal(shown(reopened), 'Aggiornamenti: [Verifica aggiornamenti]');
    console.log('PASS closing drops pending answers and timers; reopening shows the chosen section');
  }
} finally { if (old === undefined) delete globalThis.document; else globalThis.document = old; }
