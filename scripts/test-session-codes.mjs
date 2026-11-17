// Session codes (ORC1, OP3, REV1): stable per node, never reused, told to the agents and shown with the same number everywhere.
// Uso: node scripts/test-session-codes.mjs — nessun server, nessuna app.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Teams, teamInstructions } from '../src/server/team.ts';
import { setLanguage } from '../src/ui/i18n.ts';
import { CODE_IN_TEXT, roleName } from '../src/ui/work-roles.ts';

const dir = mkdtempSync(join(tmpdir(), 'vb-codes-'));
try {
  const teams = new Teams(dir);
  assert.equal(teams.reserveCode(7, 'orchestrator'), 'ORC1');
  assert.equal(teams.reserveCode(7, 'operator'), 'OP1');
  assert.equal(teams.reserveCode(7, 'operator'), 'OP2', 'a reserved code that was never bound (failed launch) is not reused');
  assert.equal(teams.reserveCode(7, 'reviewer'), 'REV1');
  assert.equal(teams.reserveCode(8, 'operator'), 'OP1', 'numbers are per node');
  teams.bindCode(7, 'aaaa1111', 'OP2');
  assert.equal(new Teams(dir).reserveCode(7, 'operator'), 'OP3', 'counters survive a restart');

  // Sessions launched before codes existed: live ones get a code, oldest first; ended ones are left alone.
  const fresh = new Teams(mkdtempSync(join(dir, 'legacy-')));
  const session = (id, role, createdAt, alive = true) => ({ id, role, createdAt, alive, nodeId: 3, agent: 'codex', cwd: '/x', title: id });
  const list = [session('late', 'operator', 30), session('early', 'operator', 10), session('gone', 'operator', 5, false), session('boss', 'orchestrator', 1), { ...session('sh', undefined, 0), agent: 'shell' }];
  const coded = fresh.withCodes(list);
  assert.deepEqual(coded.map(s => s.code), ['OP2', 'OP1', undefined, 'ORC1', undefined]);
  assert.equal(list[0].code, undefined, 'the store objects are not modified');
  assert.deepEqual(fresh.withCodes(list).map(s => s.code), coded.map(s => s.code), 'codes are stable');
  assert.equal(fresh.resolve(3, coded, 'op2')?.id, 'late', 'a code in any case names the session');
  assert.equal(fresh.resolve(3, coded, 'early')?.id, 'early', 'ids still work');
  assert.equal(fresh.resolve(3, coded, 'OP9'), undefined);

  for (const lang of ['it', 'en']) {
    const text = teamInstructions('http://127.0.0.1:4747/api/work/3', 'abcd1234', 'fake', 'operator', undefined, lang, false, true, 'OP2');
    assert.match(text, lang === 'it' ? /ruolo operator, codice OP2, sessione abcd1234/ : /role operator, code OP2, session abcd1234/);
    assert.match(text, lang === 'it' ? /L’utente vede solo i codici/ : /The user sees only the codes/);
    assert.doesNotMatch(teamInstructions('http://x', 'abcd1234', 'fake', 'operator', undefined, lang), /OP\d|codice|code ORC/);
  }

  setLanguage('it');
  assert.equal(roleName({ role: 'operator', code: 'OP6' }, '5'), 'Operatore 6', 'the code wins over the position: rail and header agree');
  assert.equal(roleName({ role: 'operator' }, '5'), 'Operatore 5');
  assert.equal(roleName({ role: 'reviewer', code: 'REV2' }), 'Revisore 2');
  assert.equal(roleName({ role: 'orchestrator', code: 'ORC3' }), 'Orchestratore');
  assert.equal(roleName({}), '');
  assert.deepEqual('Chiedi a OP3 e REV12, non a TOP3 né OP3x'.match(CODE_IN_TEXT), ['OP3', 'REV12']);
  console.log('session-codes: ok');
} finally { rmSync(dir, { recursive: true, force: true }); }
