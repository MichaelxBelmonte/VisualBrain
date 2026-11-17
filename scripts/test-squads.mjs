// Several squads in one node, the node's Main Brain, the sorting board (manual delivery) and free terminals.
// Uso: node scripts/test-squads.mjs — nessun agente reale: le PTY sono simulate, Git è vero in una cartella temporanea.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { handleApi } from '../src/server/api.ts';
import { Teams, classify, memoryFor } from '../src/server/team.ts';
import { newActivity } from '../src/server/activity.ts';
import { DEFAULTS } from '../src/server/config.ts';

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'vb-squads-')));
try {
  const project = join(dir, 'project');
  mkdirSync(project);
  const git = (...args) => execFileSync('git', ['-C', project, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  git('init', '-q'); writeFileSync(join(project, 'a.txt'), 'a'); git('add', '.'); git('commit', '-q', '-m', 'init');

  const terms = new Map();
  const store = {
    list: () => [...terms.values()].map(t => t.info),
    get: id => terms.get(id),
    spawn: opts => {
      const info = { id: opts.id ?? Math.random().toString(16).slice(2, 10), agent: opts.agent, cwd: opts.cwd, title: opts.title, alive: true, nodeId: opts.nodeId ?? null, createdAt: Date.now(), role: opts.role, parentId: opts.parentId, task: opts.task, model: opts.model, workState: opts.role ? 'idle' : undefined, idleSince: opts.role ? Date.now() : undefined };
      const term = { info, proc: { write() {} }, teamToken: opts.teamToken ?? '', seenMessage: opts.seenMessage ?? 0, injectedMessage: 0, activity: newActivity(), args: opts.args, env: opts.env };
      terms.set(info.id, term); return term;
    },
    kill: id => terms.delete(id),
    rename: () => undefined,
  };
  const node = { id: 1, name: 'project', path: project, kind: 'dir', cls: 'folder', parentId: null, projectId: null, areaId: null, bytes: 0, files: 0 };
  const ctx = {
    cfg: { ...DEFAULTS, dataDir: join(dir, 'profile'), language: 'it', agents: { ...DEFAULTS.agents, claude: 'claude-fake' } },
    cache: { nodes: new Map([[1, node]]), incident: () => [], evidence: () => new Map(), children: new Map(), areas: [] },
    db: { get: () => undefined, all: () => [] },
    teams: new Teams(join(dir, 'profile')),
    terms: store,
  };
  const call = async (method, path, body = {}, as = null) => {
    const req = Readable.from(method === 'GET' ? [] : [Buffer.from(JSON.stringify(as ? { ...body, from: as } : body))]);
    req.method = method; req.url = path; req.headers = as ? { authorization: `Bearer ${terms.get(as).teamToken}` } : {};
    let status, response;
    await handleApi(ctx, req, { writeHead(code) { status = code; }, end(text) { response = JSON.parse(text); } });
    return { status, body: response };
  };
  const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
  const claude = role => ({ agent: 'claude', ...(role ? { role } : {}) });

  // Two squads in one node: the first works in the project folder, the second in a worktree and branch of its own.
  const alfa = ok(await call('POST', '/api/launch-squad', { id: 1, prompt: 'Rifai la UI', members: [claude(), claude(), claude()] }), 201);
  assert.equal(alfa.teamId, '1');
  assert.deepEqual(alfa.sessions.map(s => s.code), ['ORC1', 'OP1', 'OP2']);
  assert.ok(alfa.sessions.every(s => s.cwd === project && s.teamId === '1'));
  const beta = ok(await call('POST', '/api/launch-squad', { id: 1, teamId: 'new', teamName: 'Beta', prompt: 'Scrivi i test', members: [claude(), claude()] }), 201);
  assert.equal(beta.teamId, '2');
  assert.deepEqual(beta.sessions.map(s => s.code), ['ORC2', 'OP3'], 'codes stay unique in the node');
  const squad2 = ctx.teams.team(1, '2');
  assert.equal(squad2.name, 'Beta'); assert.equal(squad2.objective, 'Scrivi i test');
  assert.match(squad2.worktree.branch, /^visual-brain\/n1-team2-beta/);
  assert.ok(beta.sessions.every(s => s.cwd === squad2.worktree.cwd), 'the second squad works in its own checkout');
  assert.ok(existsSync(join(squad2.worktree.cwd, 'a.txt')));
  const [orc1, op1, op2] = alfa.sessions.map(s => s.id), [orc2, op3] = beta.sessions.map(s => s.id);
  assert.ok(terms.get(orc2).args.at(-1).includes('Guidi la squadra Beta'), 'the orchestrator knows its squad');
  console.log('PASS two squads in one node: own codes, own board, the second in its own Git worktree');

  // Squads stay apart: boards, recipients and closing a session never touch the other squad.
  const board1 = ok(await call('GET', `/api/work/1?session=${orc1}`, undefined, orc1));
  assert.deepEqual(board1.sessions.map(s => s.code).sort(), ['OP1', 'OP2', 'ORC1']);
  assert.equal((await call('POST', '/api/work/1/messages', { to: 'OP3', text: 'ciao' }, op1)).status, 403, 'operators of different squads cannot talk');
  assert.equal((await call('POST', '/api/work/1/messages', { to: 'ORC2', text: 'ciao' }, orc1)).status, 403, 'orchestrators of different squads need a channel');
  ok(await call('POST', '/api/work/1/tasks', { title: 'test e2e', assignedTo: 'OP3' }, orc2), 201);
  assert.equal((await call('POST', '/api/work/1/tasks', { title: 'x', assignedTo: 'OP1' }, orc2)).status, 400, 'an orchestrator assigns only within its squad');
  assert.equal(ctx.teams.get(1, '2').tasks.length, 1); assert.equal(ctx.teams.get(1).tasks.length, 0);
  const user = ok(await call('GET', '/api/work/1?team=2'));
  assert.deepEqual(user.teamList.map(t => [t.id, t.name, t.alive]), [['1', 'Alfa', 3], ['2', 'Beta', 2]]);
  assert.deepEqual(user.sessions.map(s => s.code).sort(), ['OP3', 'ORC2']);
  console.log('PASS squads are isolated: boards, recipients, tasks; the person sees every squad');

  // The Main Brain: one per node, told the squads, talks to their orchestrators, proposes squads the person starts.
  const brain = ok(await call('POST', '/api/launch', { id: 1, agent: 'claude', mode: 'embedded', role: 'brain', prompt: 'Coordina' }), 201).info;
  assert.equal(brain.code, 'BRAIN1'); assert.equal(brain.teamId, 'brain');
  assert.match(terms.get(brain.id).args.at(-1), /Main Brain del nodo: ruolo brain, codice BRAIN1/);
  assert.match(terms.get(brain.id).args.at(-1), /Squadre del nodo: Alfa: Rifai la UI; Beta: Scrivi i test/);
  assert.equal((await call('POST', '/api/launch', { id: 1, agent: 'claude', mode: 'embedded', role: 'brain' })).status, 409);
  assert.ok(ctx.teams.get(1).messages.some(m => m.to === orc1 && /BRAIN1 è attivo/.test(m.text)) && ctx.teams.get(1, '2').messages.some(m => m.to === orc2 && /BRAIN1/.test(m.text)), 'orchestrators learn about the Main Brain');
  const brainView = ok(await call('GET', `/api/work/1?session=${brain.id}`, undefined, brain.id));
  assert.deepEqual(brainView.teamList.map(t => [t.name, t.orchestrator, t.tasks.pending]), [['Alfa', 'ORC1', 0], ['Beta', 'ORC2', 1]]);
  assert.equal(brainView.inbox, undefined, 'the sorting board is the person’s');
  ok(await call('POST', '/api/work/1/messages', { to: 'ORC2', text: 'Priorità ai test di login' }, brain.id), 201);
  assert.ok(ctx.teams.get(1, '2').messages.some(m => m.from === brain.id && m.to === orc2));
  ok(await call('POST', '/api/work/1/messages', { to: 'BRAIN1', text: 'Tappa 1 chiusa' }, orc1), 201);
  assert.ok(ctx.teams.get(1, 'brain').messages.some(m => m.from === orc1 && m.text === 'Tappa 1 chiusa'));
  assert.equal((await call('POST', '/api/work/1/messages', { to: 'BRAIN1', text: 'ciao' }, op1)).status, 403, 'operators do not talk to the Main Brain');
  assert.equal((await call('POST', '/api/work/1/tasks', { title: 'x' }, brain.id)).status, 403, 'the Main Brain gives no tasks');
  assert.equal((await call('POST', '/api/work/1/proposals', { name: 'X', objective: 'y', members: [claude()] }, orc1)).status, 403);
  const discarded = ok(await call('POST', '/api/work/1/proposals', { name: 'Docs', objective: 'Documenta', members: [claude(), claude('operator')] }, brain.id), 201);
  assert.equal(discarded.members[0].role, 'orchestrator');
  ok(await call('PATCH', `/api/work/1/proposals/${discarded.id}`, { status: 'discarded' }));
  assert.ok(ctx.teams.get(1, 'brain').messages.some(m => m.to === brain.id && /scartato la tua proposta «Docs»/.test(m.text)));
  const proposal = ok(await call('POST', '/api/work/1/proposals', { name: 'Perf', objective: 'Misura i tempi', members: [claude('orchestrator'), claude('operator')] }, brain.id), 201);
  const gamma = ok(await call('POST', '/api/launch-squad', { id: 1, proposalId: proposal.id, members: proposal.members }), 201);
  assert.equal(gamma.teamId, '3'); assert.equal(ctx.teams.team(1, '3').name, 'Perf'); assert.equal(ctx.teams.team(1, '3').objective, 'Misura i tempi');
  assert.equal(ctx.teams.proposal(1, proposal.id).status, 'launched');
  assert.ok(ctx.teams.get(1, 'brain').messages.some(m => m.to === brain.id && /avviato la tua proposta «Perf»: squadra Perf con ORC3, OP4/.test(m.text)));
  assert.equal((await call('POST', '/api/launch-squad', { id: 1, proposalId: proposal.id, members: proposal.members })).status, 409, 'a proposal starts once');
  console.log('PASS Main Brain: one per node, sees squad summaries, talks only to orchestrators, proposals started or discarded by the person');

  // Manual delivery: the orchestrator sees that an operator finished, the content waits for the person to forward it.
  ok(await call('PATCH', '/api/work/1', { team: '1', delivery: 'manual' }));
  assert.equal((await call('PATCH', '/api/work/1', { delivery: 'manual' }, orc1)).status, 403, 'only the person changes delivery');
  const task = ok(await call('POST', '/api/work/1/tasks', { title: 'Header nuovo', assignedTo: 'OP1' }, orc1), 201);
  ok(await call('PATCH', `/api/work/1/tasks/${task.id}`, { status: 'done', result: 'Header rifatto in src/ui/header.ts, test verdi' }, op1));
  const inbox = ctx.teams.get(1).inbox;
  assert.equal(inbox.length, 1); assert.equal(inbox[0].kind, 'result'); assert.equal(inbox[0].column, 'new'); assert.equal(inbox[0].taskTitle, 'Header nuovo');
  const notice = ctx.teams.get(1).messages.at(-1);
  assert.equal(notice.to, orc1); assert.match(notice.text, /Completato .* in smistamento dall’utente.*Sessione libera/); assert.doesNotMatch(notice.text, /header\.ts/);
  const orcView = ok(await call('GET', `/api/work/1?session=${orc1}`, undefined, orc1));
  assert.equal(orcView.tasks.find(t => t.id === task.id).status, 'done');
  assert.equal(orcView.tasks.find(t => t.id === task.id).result, '(consegnato, in smistamento dall’utente)');
  assert.equal(orcView.inbox, undefined);
  const held = ok(await call('POST', '/api/work/1/messages', { to: null, text: 'Uso la palette nuova o la vecchia?' }, op2), 201);
  assert.equal(held.held, true);
  assert.equal(ctx.teams.get(1).inbox.at(-1).kind, 'question');
  ok(await call('POST', '/api/work/1/messages', { to: 'OP2', text: 'ti passo il file' }, op1), 201);
  assert.equal(ctx.teams.get(1).messages.at(-1).to, op2, 'operators still talk to each other directly');
  ok(await call('PATCH', `/api/work/1/inbox/${held.item}`, { team: '1', column: 'ready', note: 'decidi tu' }));
  assert.equal((await call('PATCH', `/api/work/1/inbox/${held.item}`, { column: 'ready' }, orc1)).status, 403);
  const forwarded = ok(await call('POST', '/api/work/1/forward', { team: '1', items: [inbox[0].id, held.item], note: 'Bene, prosegui' }), 201);
  assert.equal(forwarded.message.to, orc1); assert.equal(forwarded.message.from, 'user');
  assert.match(forwarded.message.text, /\[Risultato · OP1 · incarico .*\] Header rifatto/);
  assert.match(forwarded.message.text, /\[Domanda · OP2\] Uso la palette .* \(nota: decidi tu\)/);
  assert.match(forwarded.message.text, /Nota dell’utente: Bene, prosegui/);
  assert.ok(ctx.teams.get(1).inbox.every(i => i.column === 'forwarded' && i.forwardedTo === orc1));
  assert.equal(ok(await call('GET', `/api/work/1?session=${orc1}`, undefined, orc1)).tasks.find(t => t.id === task.id).result, 'Header rifatto in src/ui/header.ts, test verdi', 'forwarded: the orchestrator sees the result');
  // Forwarded elsewhere (to the Main Brain): the squad's orchestrator still does not see it.
  const t2 = ok(await call('POST', '/api/work/1/tasks', { title: 'Footer', assignedTo: 'OP2' }, orc1), 201);
  ok(await call('PATCH', `/api/work/1/tasks/${t2.id}`, { status: 'blocked', result: 'manca il design' }, op2));
  assert.equal(ctx.teams.get(1).inbox.at(-1).kind, 'blocked');
  ok(await call('POST', '/api/work/1/forward', { team: '1', items: [ctx.teams.get(1).inbox.at(-1).id], to: 'BRAIN1' }), 201);
  assert.ok(ctx.teams.get(1, 'brain').messages.at(-1).text.includes('manca il design'));
  assert.ok(ctx.teams.get(1).tasks.find(t => t.id === t2.id).held);
  ok(await call('PATCH', '/api/work/1', { team: 'brain', delivery: 'manual' }));
  assert.equal(ok(await call('POST', '/api/work/1/messages', { to: 'BRAIN1', text: 'Fine obiettivo' }, orc1), 201).held, true, 'reports to the Main Brain can be sorted too');
  assert.equal(ctx.teams.get(1, 'brain').inbox.at(-1).from, orc1);
  assert.equal(classify('Va bene?'), 'question'); assert.equal(classify('Fatto.'), 'note');
  console.log('PASS manual delivery: status to the orchestrator, content on the sorting board, classified, forwarded with notes');

  // Archiving a squad: only without live sessions; its worktree goes when Git can remove it, its branch stays.
  assert.equal((await call('PATCH', '/api/work/1', { team: '2', archived: true })).status, 409);
  for (const id of [orc2, op3]) ok(await call('DELETE', `/api/terminals/${id}`));
  assert.ok(existsSync(squad2.worktree.path), 'closing a session keeps the squad’s worktree');
  ok(await call('PATCH', '/api/work/1', { team: '2', archived: true, name: 'Beta test' }));
  assert.equal(ctx.teams.team(1, '2').archived, true); assert.equal(ctx.teams.team(1, '2').name, 'Beta test');
  assert.equal(existsSync(squad2.worktree.path), false);
  assert.match(git('branch', '--list', 'visual-brain/*').toString(), /n1-team2-beta/);
  console.log('PASS archive a squad only when idle; its worktree is removed, its branch kept');

  // Plain terminals: in a node with one call, or free, in the home folder, belonging to no node.
  const shell = ok(await call('POST', '/api/launch', { id: 1, agent: 'shell', mode: 'embedded' }), 201).info;
  assert.equal(shell.nodeId, 1); assert.equal(shell.cwd, project); assert.equal(shell.role, undefined);
  const free = ok(await call('POST', '/api/launch', { agent: 'shell', mode: 'embedded' }), 201).info;
  assert.equal(free.nodeId, null); assert.equal(free.cwd, process.env.HOME);
  assert.equal((await call('POST', '/api/launch', { agent: 'claude', mode: 'embedded' })).status, 404, 'agents need a node');
  console.log('PASS plain terminals: one call in a node, or free in the home folder');

  // Claude auto memory per squad: by default only the leaders (orchestrator, Main Brain) use the project's memory.
  const noMemory = id => terms.get(id).env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY === '1';
  const settingsOf = id => { const a = terms.get(id).args; return JSON.parse(a[a.indexOf('--settings') + 1]); };
  assert.equal(noMemory(orc1), false); assert.equal(noMemory(brain.id), false);
  assert.equal(noMemory(op1), true, 'operators run without auto memory by default');
  assert.equal(settingsOf(orc1).autoMemoryDirectory, undefined, 'the orchestrator keeps the project memory');
  assert.equal((await call('PATCH', '/api/work/1', { memory: 'squad' }, orc1)).status, 403, 'only the person chooses the memory');
  assert.equal((await call('PATCH', '/api/work/1', { team: '1', memory: 'tutto' })).status, 400);
  const lone = ok(await call('POST', '/api/launch', { id: 1, agent: 'claude', mode: 'embedded', role: 'operator', teamId: 'new', teamName: 'Memo' }), 201);
  ok(await call('PATCH', '/api/work/1', { team: lone.teamId, memory: 'squad' }));
  const leader = ok(await call('POST', '/api/launch', { id: 1, agent: 'claude', mode: 'embedded', role: 'orchestrator', teamId: lone.teamId }), 201).info;
  const own = join(dir, 'profile', 'memory', 'node-1', `team-${lone.teamId}`);
  assert.equal(settingsOf(leader.id).autoMemoryDirectory, own, 'a separate memory lives in the app profile');
  assert.ok(existsSync(own)); assert.equal(noMemory(leader.id), false); assert.ok(settingsOf(leader.id).hooks.Stop, 'hooks stay');
  assert.ok(ctx.teams.get(1).savedSquads.length >= 1);
  ok(await call('PATCH', '/api/work/1', { team: '1', memory: 'all' }));
  assert.equal(ctx.teams.get(1).savedSquads[0].policy.memory, 'all', 'the choice is saved with the squad configuration');
  const policy = mode => ({ autoSpawn: false, maxAgents: 4, memory: mode });
  assert.equal(memoryFor(policy('all'), 'operator', '/p', 1, '1'), undefined);
  assert.equal(memoryFor(policy('off'), 'orchestrator', '/p', 1, '1'), 'off');
  assert.equal(memoryFor(policy('squad'), 'reviewer', '/p', 1, '1'), 'off');
  assert.equal(memoryFor({ autoSpawn: false, maxAgents: 4 }, 'brain', '/p', 1, 'brain'), undefined);
  assert.equal(memoryFor(policy('off'), undefined, '/p', 1, '1'), undefined, 'plain terminals and single agents keep the person’s settings');
  assert.match(terms.get(op1).args.at(-1), /non copiarlo nella memoria automatica/, 'agents keep squad state on the board');
  console.log('PASS Claude memory per squad: leaders only by default, whole squad, separate directory or off; saved with the squad');
} finally { rmSync(dir, { recursive: true, force: true }); }
