// "Riprendi": an ended session starts again under the same id and reopens its Claude or Codex conversation.
// Uso: node scripts/test-resume.mjs — nessun server, nessun agente reale.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { findCodexSession, launchEmbedded, resumeCommand, resumeEmbedded } from '../src/server/launch.ts';
import { resumeSession } from '../src/server/sessions.ts';
import { Terminals } from '../src/server/terminals.ts';
import { handleApi } from '../src/server/api.ts';
import { DEFAULTS as BASE } from '../src/server/config.ts';

// Prompts follow the system language: pin Italian so the checks do not depend on the machine.
const DEFAULTS = { ...BASE, language: 'it' };
import { resumable } from '../src/ui/work-roles.ts';

const temp = realpathSync(mkdtempSync(join(tmpdir(), 'vb-resume-')));
const priorShell = process.env.SHELL;
const terms = new Terminals(() => {});
try {
  // Codex conversations are found in its own records: same folder, from the launch on, not bound to another session.
  const home = join(temp, 'codex'), cwd = join(temp, 'project'), other = join(temp, 'other');
  mkdirSync(cwd); mkdirSync(other); symlinkSync(cwd, join(temp, 'link'));
  const createdAt = new Date(2026, 10, 2, 14, 0, 0).getTime();
  const day = join(home, 'sessions/2026/11/02'); mkdirSync(day, { recursive: true });
  const rollout = (id, folder, at) => writeFileSync(join(day, `rollout-x-${id}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id, cwd: folder, timestamp: new Date(at).toISOString(), base_instructions: 'x'.repeat(5000) } }) + '\n{"type":"event"}\n');
  rollout('before', cwd, createdAt - 60_000);
  rollout('first', cwd, createdAt + 1_500);
  rollout('second', cwd, createdAt + 3_000);
  rollout('elsewhere', other, createdAt + 500);
  rollout('much-later', cwd, createdAt + 3_600_000);
  writeFileSync(join(day, 'rollout-broken.jsonl'), 'not json');
  assert.equal(findCodexSession(cwd, createdAt, new Set(), home), 'first');
  assert.equal(findCodexSession(join(temp, 'link'), createdAt, new Set(), home), 'first', 'a symlinked folder matches the real path Codex records');
  assert.equal(findCodexSession(cwd, createdAt, new Set(['first']), home), 'second', 'a conversation bound to another session is skipped');
  assert.equal(findCodexSession(cwd, createdAt, new Set(['first', 'second']), home), undefined, 'nothing started long after the launch');
  assert.equal(findCodexSession(cwd, createdAt, new Set(), join(temp, 'missing')), undefined);
  console.log('PASS Codex conversation found by folder and launch time, claimed and unrelated records skipped');

  // Claude gets its conversation id from Visual Brain at launch; resuming reuses it with the same model and effort.
  let options;
  const fake = { spawn(opts) { options = opts; return { info: { id: opts.id } }; } };
  launchEmbedded(fake, 'claude', DEFAULTS, { id: 7, name: 'fixture' }, cwd, 'ciao', undefined, { model: 'sonnet', role: 'operator' });
  assert.match(options.resumeId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(options.args.slice(options.args.indexOf('--session-id'), options.args.indexOf('--session-id') + 2), ['--session-id', options.resumeId]);
  launchEmbedded(fake, 'hermes', DEFAULTS, { id: 7, name: 'fixture' }, cwd, 'ciao');
  assert.equal(options.resumeId, undefined, 'Hermes keeps its own sessions');
  assert.deepEqual(resumeCommand('claude', DEFAULTS, cwd, 'abc', { model: 'opus', effort: 'high' }).args, ['--model', 'opus', '--effort', 'high', '--resume', 'abc']);
  assert.deepEqual(resumeCommand('codex', DEFAULTS, cwd, 'abc', { model: 'gpt-5', effort: 'low' }, 'go').args, ['resume', '-C', cwd, '--model', 'gpt-5', '-c', 'model_reasoning_effort="low"', '--', 'abc', 'go']);

  const info = { id: 'ab12cd34', agent: 'claude', cwd, title: 'claude · fixture', alive: false, nodeId: 7, createdAt, role: 'operator', model: 'sonnet', task: 'test' };
  resumeEmbedded(fake, DEFAULTS, info, 'conv-1', 'token-1', 12);
  assert.equal(options.id, 'ab12cd34'); assert.equal(options.teamToken, 'token-1'); assert.equal(options.seenMessage, 12); assert.equal(options.resumeId, 'conv-1');
  assert.ok(options.args.includes('--settings'), 'a team member keeps its turn hooks');
  assert.equal(options.args[options.args.indexOf('--resume') + 1], 'conv-1');
  assert.match(options.args.at(-1), /rileggi la bacheca/, 'the team member is told to reread the board');
  assert.equal(options.env.VB_SESSION_ID, 'ab12cd34'); assert.equal(options.env.VB_TEAM_TOKEN, 'token-1');
  process.env.SHELL = '/bin/zsh';
  resumeEmbedded(fake, DEFAULTS, { ...info, agent: 'codex', role: undefined }, 'conv-2', 'token-2', 0);
  const codex = options.args.slice(options.args.indexOf(DEFAULTS.agents.codex) + 1);
  assert.equal(codex[0], 'resume'); assert.equal(codex[1], '-c', 'the MCP bridge goes after the subcommand');
  assert.deepEqual(codex.slice(-2), ['--', 'conv-2'], 'a single agent is not sent a prompt');
  assert.deepEqual(options.env, { VB_EXPLORE_URL: `http://${DEFAULTS.host}:${DEFAULTS.port}/api/explore?node=7` });
  console.log('PASS Claude conversation id chosen at launch; resume keeps id, token, cursor, hooks, MCP bridge, model and effort');

  // The route: only ended sessions, only from the interface, only agents that can resume.
  process.env.SHELL = '/bin/sh';
  const teams = { get: () => ({ policy: { maxAgents: 2 } }), teamOf: () => '1', withCodes: list => list.map(s => ({ ...s, code: s.role ? 'OP1' : undefined })) };
  const ctx = { terms, teams, cfg: DEFAULTS };
  const call = async (path, body = {}, headers = {}) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]); req.method = 'POST'; req.url = path; req.headers = headers;
    let status, response; await handleApi(ctx, req, { writeHead(code) { status = code; }, end(text) { response = JSON.parse(text); } });
    return { status, body: response };
  };
  const ended = async (opts) => { const t = terms.spawn({ cwd, file: '/bin/sh', args: ['-c', 'exit 0'], title: 'x', nodeId: 7, ...opts }); await new Promise(ok => { const wait = () => t.info.alive ? setTimeout(wait, 20) : ok(); wait(); }); return t; };
  const shell = await ended({ agent: 'shell' });
  terms.rename(shell.info.id, 'Build');
  assert.equal((await call(`/api/terminals/${shell.info.id}/resume`, {}, { authorization: 'Bearer x' })).status, 403, 'agents cannot restart sessions');
  const resumed = await call(`/api/terminals/${shell.info.id}/resume`, { cols: 100, rows: 20 });
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  assert.equal(resumed.body.termId, shell.info.id); assert.equal(resumed.body.info.createdAt, shell.info.createdAt, 'it keeps its place in tabs and lists'); assert.equal(resumed.body.info.alive, true); assert.equal(resumed.body.info.name, 'Build', 'the name survives');
  assert.equal(terms.list().filter(s => s.id === shell.info.id).length, 1);
  assert.equal((await call(`/api/terminals/${shell.info.id}/resume`)).status, 409, 'a running session is not restarted');
  assert.equal((await call('/api/terminals/nope/resume')).status, 404);
  const hermes = await ended({ agent: 'hermes', role: 'operator' });
  assert.match((await call(`/api/terminals/${hermes.info.id}/resume`)).body.error, /non permette/);
  const claude = await ended({ agent: 'claude', role: 'operator' });
  assert.match((await call(`/api/terminals/${claude.info.id}/resume`)).body.error, /Conversazione non trovata/, 'a Claude session started before this version has no id to resume');
  const orchestrator = await ended({ agent: 'claude', role: 'orchestrator', resumeId: 'conv-3' });
  terms.spawn({ agent: 'claude', role: 'orchestrator', cwd, file: '/bin/sh', args: ['-c', 'sleep 30'], title: 'live', nodeId: 7 });
  assert.match((await call(`/api/terminals/${orchestrator.info.id}/resume`)).body.error, /già un orchestratore/);
  terms.spawn({ agent: 'claude', role: 'operator', cwd, file: '/bin/sh', args: ['-c', 'sleep 30'], title: 'live', nodeId: 7 });
  const operator = await ended({ agent: 'claude', role: 'operator', resumeId: 'conv-4' });
  assert.match((await call(`/api/terminals/${operator.info.id}/resume`)).body.error, /Limite della squadra/);
  await Promise.all([resumeSession(ctx, 'nope', {}).catch(e => e.status), resumeSession(ctx, 'nope', {}).catch(e => e.status)]).then(codes => assert.deepEqual(codes, [404, 404]));
  console.log('PASS POST /api/terminals/:id/resume: same id and name, interface only, ended sessions only, team limits and a single orchestrator');

  assert.equal(resumable({ alive: false, agent: 'shell' }), true);
  assert.equal(resumable({ alive: false, agent: 'codex' }), true);
  assert.equal(resumable({ alive: false, agent: 'claude' }), false);
  assert.equal(resumable({ alive: false, agent: 'claude', resumeId: 'x' }), true);
  assert.equal(resumable({ alive: true, agent: 'shell' }), false);
  assert.equal(resumable({ alive: false, agent: 'agy' }), false);
  console.log('PASS the Riprendi button only for ended sessions that can resume');
} finally {
  terms.killAll();
  if (priorShell === undefined) delete process.env.SHELL; else process.env.SHELL = priorShell;
  rmSync(temp, { recursive: true, force: true });
}
