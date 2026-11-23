// Changing a session's role while it works: orchestrator, operator, reviewer or none, at the end of the turn or at once,
// and a Claude Code started by hand in a plain terminal joining a squad.
// Uso: node scripts/test-role-change.mjs — nessun agente reale: PTY e tabella dei processi simulate.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { agentOf, claudeProjectDir, findClaudeConversation, findInner, parsePs, resumeIdOf, setProcessTable } from '../src/server/inner-agent.ts';
import { handleApi } from '../src/server/api.ts';
import { Teams } from '../src/server/team.ts';
import { newActivity } from '../src/server/activity.ts';
import { DEFAULTS } from '../src/server/config.ts';

// ── The process table and the agent inside a plain terminal ──
const rows = parsePs([
  '  100     1   02-03:04:05 /bin/zsh -l',
  '  200   100      01:30 node /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js --model opus',
  '  201   200      01:29 /Users/x/.local/share/claude/versions/2.1/claude',
  '  300     1   1:02:03 -zsh',
  '  301   300      00:05 /usr/local/bin/codex resume 0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
  '  400     1      00:10 /bin/zsh -l',
  '  401   400      00:09 vim notes.md',
  'garbage line',
].join('\n'));
assert.equal(rows.length, 7);
assert.equal(rows[0].elapsed, ((2 * 24 + 3) * 3600 + 4 * 60 + 5) * 1000, 'dd-hh:mm:ss');
assert.equal(rows[3].elapsed, (3600 + 2 * 60 + 3) * 1000, 'hh:mm:ss');
assert.equal(rows[1].elapsed, 90_000, 'mm:ss');
assert.equal(agentOf('/Users/x/.local/bin/claude --resume abc'), 'claude');
assert.equal(agentOf('node /usr/lib/node_modules/@openai/codex/bin/codex.js'), 'codex');
assert.equal(agentOf('node /x/visual-brain/src/server/team-mcp.mjs'), null, 'Visual Brain’s own bridge is not an agent');
assert.equal(agentOf('vim claude.md'), null);
assert.equal(resumeIdOf('claude', 'claude --model opus --resume 3f2a9c1e-1111-2222-3333-444455556666'), '3f2a9c1e-1111-2222-3333-444455556666');
assert.equal(resumeIdOf('claude', 'claude --session-id=3f2a9c1e-aaaa-bbbb-cccc-ddddeeeeffff'), '3f2a9c1e-aaaa-bbbb-cccc-ddddeeeeffff');
assert.equal(resumeIdOf('claude', 'claude --continue'), undefined, '--continue names no conversation');
assert.equal(resumeIdOf('codex', 'codex resume --last'), undefined);
const now = 10_000_000;
assert.deepEqual(findInner(rows, 100, now), { agent: 'claude', pid: 200, startedAt: now - 90_000, resumeId: undefined }, 'the launcher, not its native child');
assert.equal(findInner(rows, 300, now).resumeId, '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b');
assert.equal(findInner(rows, 400, now), null, 'an editor is not an agent');
assert.equal(findInner(rows, 999, now), null);
console.log('PASS process table read; Claude Code and Codex found below a shell, with the conversation named on the command line');

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'vb-role-')));
const priorHome = process.env.CLAUDE_CONFIG_DIR;
try {
  const claudeHome = join(dir, 'claude-home'), project = join(dir, 'my project');
  mkdirSync(project);
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  const convDir = claudeProjectDir(claudeHome, project);
  assert.match(convDir, /projects\/-.*-my-project$/, 'every character other than a letter or digit becomes -');
  mkdirSync(convDir, { recursive: true });
  const record = (id, at) => { const f = join(convDir, id + '.jsonl'); writeFileSync(f, '{}\n'); utimesSync(f, at / 1000, at / 1000); };
  const started = Date.now() - 60_000;
  record('old-conversation', started - 3_600_000);
  record('claimed-conversation', Date.now() - 1000);
  record('live-conversation', Date.now() - 5000);
  assert.equal(findClaudeConversation(claudeHome, project, started, new Set(['claimed-conversation'])), 'live-conversation');
  assert.equal(findClaudeConversation(claudeHome, project, Date.now() + 60_000, new Set()), undefined, 'nothing written since the start');
  assert.equal(findClaudeConversation(claudeHome, join(dir, 'missing'), started, new Set()), undefined);
  console.log('PASS Claude conversation of a hand-started process: latest record since its start, claimed ones skipped');

  // ── The route, with a simulated squad ──
  const terms = new Map();
  const PID = 99_999_990; // above macOS's highest pid: never a real process
  const store = {
    persistent: false,
    list: () => [...terms.values()].map(t => t.info),
    get: id => terms.get(id),
    spawn: opts => {
      const info = { id: opts.id ?? Math.random().toString(16).slice(2, 10), agent: opts.agent, cwd: opts.cwd, title: opts.title, alive: true, nodeId: opts.nodeId ?? null, createdAt: opts.createdAt ?? Date.now(), role: opts.role, parentId: opts.parentId, task: opts.task, model: opts.model, resumeId: opts.resumeId, workState: opts.role ? 'idle' : undefined };
      const term = { info, proc: { pid: PID, write() {} }, teamToken: opts.teamToken ?? '', seenMessage: opts.seenMessage ?? 0, injectedMessage: 0, activity: newActivity(), args: opts.args, env: opts.env };
      terms.set(info.id, term); return term;
    },
    kill: id => terms.delete(id),
    rename: (id, name) => { const t = terms.get(id); if (t) t.info.name = name; return t?.info; },
    write() {},
  };
  const node = { id: 1, name: 'project', path: project, kind: 'dir', cls: 'folder', parentId: null, projectId: null, areaId: null, bytes: 0, files: 0 };
  const ctx = {
    cfg: { ...DEFAULTS, dataDir: join(dir, 'profile'), language: 'it', agents: { ...DEFAULTS.agents, claude: 'claude-fake' } },
    cache: { nodes: new Map([[1, node]]), incident: () => [], evidence: () => new Map(), children: new Map(), areas: [] },
    db: { get: () => undefined, all: () => [] },
    teams: new Teams(join(dir, 'profile')),
    terms: store,
  };
  const call = async (method, path, body = {}, headers = {}) => {
    const req = Readable.from(method === 'GET' ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = method; req.url = path; req.headers = headers;
    let status, response;
    await handleApi(ctx, req, { writeHead(code) { status = code; }, end(text) { response = JSON.parse(text); } });
    return { status, body: response };
  };
  const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
  const refused = (r, status, pattern) => { assert.equal(r.status, status, JSON.stringify(r.body)); if (pattern) assert.match(r.body.error, pattern); };
  const prompt = id => terms.get(id).args.at(-1);
  const listed = async id => ok(await call('GET', '/api/terminals')).find(s => s.id === id);

  const squad = ok(await call('POST', '/api/launch-squad', { id: 1, prompt: 'Rifai la UI', members: [{ agent: 'claude' }, { agent: 'claude' }, { agent: 'claude' }] }), 201);
  const [orc, op1, op2] = squad.sessions;
  assert.deepEqual([orc.code, op1.code, op2.code], ['ORC1', 'OP1', 'OP2']);
  const token = terms.get(op1.id).teamToken, conversation = terms.get(op1.id).info.resumeId;
  ctx.teams.createTask(1, orc.id, { title: 'Testata', assignedTo: op1.id }, '1');

  refused(await call('POST', `/api/terminals/${op1.id}/role`, { role: 'reviewer' }, { authorization: `Bearer ${token}` }), 403);
  refused(await call('POST', `/api/terminals/${op1.id}/role`, { role: 'brain' }), 400);
  refused(await call('POST', `/api/terminals/${op1.id}/role`, { role: 'operator' }), 409, /già questo ruolo/);
  refused(await call('POST', `/api/terminals/${op1.id}/role`, { role: 'orchestrator' }), 409, /già un orchestratore/);
  refused(await call('POST', `/api/terminals/${op1.id}/role`, { role: 'operator', teamId: '9' }), 404);

  // Between turns: applied at once, same id, same conversation and token, new code and role card.
  const rev = ok(await call('POST', `/api/terminals/${op1.id}/role`, { role: 'reviewer', cols: 100, rows: 30 })).info;
  assert.equal(rev.id, op1.id); assert.equal(rev.role, 'reviewer'); assert.equal(rev.code, 'REV1'); assert.equal(rev.parentId, orc.id);
  const args = terms.get(op1.id).args;
  assert.equal(args[args.indexOf('--resume') + 1], conversation, 'the same conversation goes on');
  assert.equal(terms.get(op1.id).teamToken, token); assert.equal(terms.get(op1.id).env.VB_TEAM_TOKEN, token);
  assert.match(prompt(op1.id), /Ora sei revisore REV1/); assert.match(prompt(op1.id), /ruolo reviewer, codice REV1/, 'the full role card follows');
  assert.equal(ctx.teams.get(1, '1').tasks.find(t => t.title === 'Testata').assignedTo, op1.id, 'a worker staying in the squad keeps its tasks');
  assert.match(ctx.teams.get(1, '1').messages.at(-1).text, /REV1 \(claude\) ora è revisore nella tua squadra, prima era OP1/);
  console.log('PASS operator → reviewer between turns: same id, conversation and token, new code, role card, orchestrator told');

  // During a turn: queued, listed, cancellable; «Subito» does not wait.
  terms.get(op2.id).info.workState = 'working';
  const queued = ok(await call('POST', `/api/terminals/${op2.id}/role`, { role: 'reviewer' }));
  assert.equal(queued.change.state, 'waiting'); assert.equal(queued.change.message, 'turno in corso');
  assert.equal((await listed(op2.id)).roleChange.role, 'reviewer');
  assert.equal(terms.get(op2.id).info.role, 'operator', 'nothing changes during the turn');
  assert.equal(ok(await call('DELETE', `/api/terminals/${op2.id}/role`)).ok, true);
  assert.equal((await listed(op2.id)).roleChange, undefined);
  ok(await call('POST', `/api/terminals/${op2.id}/role`, { role: 'reviewer' }));
  terms.get(op2.id).info.workState = 'idle';
  await new Promise(done => setTimeout(done, 1300));
  assert.equal(terms.get(op2.id).info.role, 'reviewer', 'applied when the turn ends');
  assert.equal((await listed(op2.id)).roleChange, undefined);
  assert.equal((await listed(op2.id)).code, 'REV2');
  terms.get(op2.id).info.workState = 'working';
  const now2 = ok(await call('POST', `/api/terminals/${op2.id}/role`, { role: 'operator', now: true })).info;
  assert.equal(now2.role, 'operator'); assert.equal(now2.code, 'OP3', 'codes are never reused');
  console.log('PASS during a turn: waits, shows in the list, can be cancelled, applies at the end of the turn; «Subito» restarts at once');

  // The orchestrator steps down, a worker takes over: links follow.
  const down = ok(await call('POST', `/api/terminals/${orc.id}/role`, { role: 'operator' })).info;
  assert.equal(down.code, 'OP4'); assert.equal(down.parentId, undefined);
  assert.equal(terms.get(op1.id).info.parentId, undefined, 'workers lose the link to the old orchestrator');
  const up = ok(await call('POST', `/api/terminals/${op1.id}/role`, { role: 'orchestrator' })).info;
  assert.equal(up.code, 'ORC2');
  assert.equal(terms.get(orc.id).info.parentId, op1.id); assert.equal(terms.get(op2.id).info.parentId, op1.id);
  assert.equal(ctx.teams.get(1, '1').tasks.find(t => t.title === 'Testata').assignedTo, null, 'an orchestrator hands its own tasks back');
  console.log('PASS orchestrator ↔ operator: one orchestrator per squad, workers relinked, tasks handed back');

  // Out of the squad, and into another one.
  const alone = ok(await call('POST', `/api/terminals/${op2.id}/role`, { role: null })).info;
  assert.equal(alone.role, undefined); assert.equal(alone.code, undefined);
  assert.match(prompt(op2.id), /tolto questa sessione dalla squadra \(eri OP3\)/);
  assert.equal(terms.get(op2.id).env?.VB_TEAM_TOKEN, undefined, 'no board tools without a role');
  const beta = ctx.teams.createTeam(1, { name: 'Beta' });
  const moved = ok(await call('POST', `/api/terminals/${op2.id}/role`, { role: 'orchestrator', teamId: beta.id })).info;
  assert.equal(moved.teamId, beta.id); assert.equal(moved.role, 'orchestrator'); assert.equal(moved.code, 'ORC3');
  assert.match(prompt(op2.id), /aggiunto questa sessione alla squadra Beta/);
  assert.match(prompt(op2.id), /Guidi la squadra Beta/);
  console.log('PASS taken out of the squad (no board tools), then made orchestrator of another squad');

  // A Claude Code started by hand in the node's plain terminal joins the squad.
  const shell = ok(await call('POST', '/api/launch', { id: 1, agent: 'shell', mode: 'embedded' }), 201).info;
  refused(await call('POST', `/api/terminals/${shell.id}/role`, { role: 'operator' }), 409, /non è aperto Claude Code né Codex/);
  setProcessTable([{ pid: PID, ppid: 1, elapsed: 600_000, command: '/bin/zsh -l' }, { pid: PID + 1, ppid: PID, elapsed: 120_000, command: '/Users/x/.local/bin/claude' }]);
  assert.equal((await listed(shell.id)).inner, 'claude', 'the list says what runs inside');
  terms.get(orc.id).info.resumeId = 'claimed-conversation'; // newer, but already another session's
  const joined = ok(await call('POST', `/api/terminals/${shell.id}/role`, { role: 'operator' })).info;
  assert.equal(joined.id, shell.id); assert.equal(joined.agent, 'claude'); assert.equal(joined.role, 'operator'); assert.equal(joined.teamId, '1');
  assert.equal(joined.resumeId, 'live-conversation', 'the conversation it was having goes on');
  assert.equal(joined.parentId, op1.id); assert.match(joined.code, /^OP\d+$/);
  assert.equal(joined.title, 'claude · project');
  assert.match(prompt(shell.id), /aggiunto questa sessione alla squadra/);
  assert.ok(terms.get(shell.id).env.VB_TEAM_TOKEN, 'board tools from now on');
  setProcessTable(null);
  console.log('PASS a Claude Code started in a plain terminal joins the squad under the same id, with its conversation');

  // A free terminal outside any node cannot join a squad.
  const free = ok(await call('POST', '/api/launch', { agent: 'shell', mode: 'embedded' }), 201).info;
  refused(await call('POST', `/api/terminals/${free.id}/role`, { role: 'operator' }), 409, /non appartiene a un nodo/);
  console.log('PASS free terminals and the Main Brain keep their place');
} finally {
  if (priorHome === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = priorHome;
  rmSync(dir, { recursive: true, force: true });
}
