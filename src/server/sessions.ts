import type { ApiCtx } from './api.ts';
import type { AgentName, LaunchRequest, NodeDetail, SquadRequest, TerminalInfo } from '../shared/types.ts';
import { existsSync } from 'node:fs';
import { buildContext, findCodexSession, launchEmbedded, launchExternal, resumeEmbedded, workingDir } from './launch.ts';
import { BRAIN_TEAM, boundedText, DEFAULT_TEAM, isTeamId, memoryFor, TeamError } from './team.ts';
import { wakeSession } from './team-delivery.ts';
import { attachedFiles, withAttachments } from './attachments.ts';
import { createWorktree, removeWorktree } from './worktrees.ts';
import { modelCatalog } from './models.ts';
import { effortChoices } from '../shared/agent-effort.ts';

// Awaiting the remote PTY spawn must not let simultaneous requests bypass roster limits or create two orchestrators.
const launches = new WeakMap<ApiCtx, Promise<unknown>>();
function exclusive<T>(ctx: ApiCtx, run: () => Promise<T>): Promise<T> {
  const result = (launches.get(ctx) ?? Promise.resolve()).then(run);
  const settled = result.catch(() => {});
  launches.set(ctx, settled);
  void settled.then(() => { if (launches.get(ctx) === settled) launches.delete(ctx); });
  return result;
}
async function discardCreated(ctx: ApiCtx, nodeId: number, sessions: TerminalInfo[]): Promise<void> {
  for (const session of sessions) {
    ctx.terms.kill(session.id);
    try { ctx.teams.release(nodeId, session.id); } catch { /* a full disk must not prevent PTY cleanup */ }
    if (!ctx.teams.isTeamWorktree(nodeId, session.cwd)) await removeWorktree(ctx.cfg.dataDir, session.cwd).catch(() => false);
  }
  await ctx.terms.flush?.();
}

const SYSTEM = 'visual-brain';
/** Live squad sessions of a squad (the Main Brain belongs to none). */
const squadSessions = (ctx: ApiCtx, nodeId: number, team: string) => ctx.terms.list().filter(s => s.nodeId === nodeId && s.alive && s.agent !== 'shell' && s.role !== 'brain' && ctx.teams.teamOf(nodeId, s) === team);
const liveBrain = (ctx: ApiCtx, nodeId: number) => ctx.terms.list().find(s => s.nodeId === nodeId && s.alive && s.role === 'brain');

/**
 * The squad a launch joins: the one asked for, a new one ("new"), or for clients that name none the squad already at work,
 * otherwise the first. A new squad next to one at work gets its own Git worktree and branch, so squads never edit the
 * same checkout; outside Git it shares the project folder, and the launch says so.
 */
async function squadFor(ctx: ApiCtx, detail: NodeDetail, request: { teamId?: string; teamName?: string; prompt?: string }): Promise<{ id: string; created: boolean; warning?: string }> {
  const atWork = (id: string) => squadSessions(ctx, detail.id, id).length > 0;
  if (request.teamId === 'new') {
    const others = ctx.teams.teams(detail.id).filter(t => !t.archived && atWork(t.id));
    const team = ctx.teams.createTeam(detail.id, { name: request.teamName, objective: typeof request.prompt === 'string' ? request.prompt.trim().slice(0, 4000) : undefined });
    if (!others.length) return { id: team.id, created: true };
    const projectPath = detail.project ? (ctx.cache.nodes.get(detail.project.nodeId)?.path ?? null) : null;
    try {
      const worktree = await createWorktree(ctx.cfg.dataDir, detail.id, `team${team.id}-${team.name}`, workingDir(detail, projectPath));
      if (worktree) { ctx.teams.setTeam(detail.id, team.id, { worktree }); return { id: team.id, created: true }; }
    } catch (error) {
      ctx.teams.removeTeam(detail.id, team.id);
      throw new TeamError(500, `Worktree Git della squadra non creato: ${String((error as { stderr?: string })?.stderr || (error as Error)?.message || error).trim().slice(0, 300)}`);
    }
    return { id: team.id, created: true, warning: ctx.cfg.language === 'en' ? 'Not a Git folder: this squad shares the project folder with the others. Keep their scopes apart.' : 'Cartella senza Git: questa squadra lavora nella cartella del progetto insieme alle altre. Tieni separati i loro scope.' };
  }
  if (request.teamId !== undefined) {
    const team = isTeamId(request.teamId) && request.teamId !== BRAIN_TEAM ? ctx.teams.team(detail.id, request.teamId) : undefined;
    if (!team) throw new TeamError(404, 'Squadra non trovata');
    if (team.archived) ctx.teams.setTeam(detail.id, team.id, { archived: false });
    return { id: team.id, created: false };
  }
  return { id: ctx.teams.teams(detail.id).find(t => atWork(t.id))?.id ?? DEFAULT_TEAM, created: false };
}
/** A squad created by a launch that failed goes away again, with its worktree (its branch stays). */
async function dropSquad(ctx: ApiCtx, nodeId: number, team: string): Promise<void> {
  const worktree = ctx.teams.team(nodeId, team)?.worktree;
  try { ctx.teams.removeTeam(nodeId, team); } catch { /* the launch error is the one to report */ }
  if (worktree) await removeWorktree(ctx.cfg.dataDir, worktree.path).catch(() => false);
}
/** The Main Brain hears about squads it did not propose too, so its picture of the node stays complete. */
function tellBrain(ctx: ApiCtx, nodeId: number, text: string): void {
  const brain = liveBrain(ctx, nodeId);
  if (!brain) return;
  ctx.teams.message(nodeId, SYSTEM, brain.id, text, BRAIN_TEAM);
  wakeSession(ctx, brain.id);
}
export function startSquad(ctx: ApiCtx, detail: NodeDetail, request: SquadRequest) {
  return exclusive(ctx, async () => {
    const proposal = request.proposalId ? ctx.teams.proposal(detail.id, request.proposalId) : null;
    if (request.proposalId && !proposal) throw new TeamError(404, 'Proposta non trovata');
    if (proposal && proposal.status !== 'pending') throw new TeamError(409, 'Proposta già gestita');
    const saved = request.savedId ? ctx.teams.get(detail.id).savedSquads?.find(s => s.id === request.savedId && s.nodePath === detail.path) : null;
    if (request.savedId && !saved) throw new TeamError(404, 'Configurazione non trovata');
    const squad = await squadFor(ctx, detail, { ...request, teamId: proposal ? 'new' : request.teamId, teamName: request.teamName || proposal?.name, prompt: request.prompt || proposal?.objective });
    // A new squad takes the size the person chose (within 8); an existing one keeps its limit.
    if (squad.created && Array.isArray(request.members) && request.members.length > ctx.teams.get(detail.id, squad.id).policy.maxAgents) ctx.teams.update(detail.id, { maxAgents: Math.min(8, request.members.length) }, squad.id);
    const board = ctx.teams.get(detail.id, squad.id);
    const previous = { ...board.policy, worktrees: board.policy.worktrees ?? false };
    let result: { sessions: TerminalInfo[] } | undefined;
    try {
      if (saved && squadSessions(ctx, detail.id, squad.id).length) throw new TeamError(409, 'La squadra ha già agenti attivi');
      if (saved) ctx.teams.update(detail.id, { ...saved.policy, maxAgents: Math.max(saved.policy.maxAgents, saved.members.length), worktrees: saved.policy.worktrees ?? false }, squad.id);
      result = await startSquadNow(ctx, detail, { ...request, prompt: request.prompt || proposal?.objective }, squad.id);
      ctx.teams.saveSquad(detail.id, detail.path, detail.name, ctx.terms.list(), squad.id);
      const leader = result.sessions.find(s => s.role === 'orchestrator');
      // A new orchestrator with an objective starts a new run of the squad: the objective is what the board and the Main Brain show.
      const objective = boundedText(request.prompt || proposal?.objective, 4000);
      if (leader && objective) ctx.teams.setTeam(detail.id, squad.id, { objective });
      const team = ctx.teams.team(detail.id, squad.id)!;
      const codes = result.sessions.map(s => s.code).filter(Boolean).join(', ');
      if (proposal) {
        ctx.teams.settleProposal(detail.id, proposal.id, 'launched', squad.id);
        tellBrain(ctx, detail.id, ctx.cfg.language === 'en' ? `The user started your proposal "${proposal.name}": squad ${team.name} with ${codes}. Talk to ${leader?.code ?? 'its orchestrator'}.` : `L’utente ha avviato la tua proposta «${proposal.name}»: squadra ${team.name} con ${codes}. Parla con ${leader?.code ?? 'il suo orchestratore'}.`);
      } else if (squad.created) {
        tellBrain(ctx, detail.id, ctx.cfg.language === 'en' ? `The user started squad ${team.name} (${codes})${team.objective ? ': ' + team.objective.slice(0, 600) : ''}.` : `L’utente ha avviato la squadra ${team.name} (${codes})${team.objective ? ': ' + team.objective.slice(0, 600) : ''}.`);
      }
      return { ...result, teamId: squad.id, ...(squad.warning ? { warning: squad.warning } : {}) };
    } catch (error) {
      if (result) await discardCreated(ctx, detail.id, result.sessions);
      if (squad.created) await dropSquad(ctx, detail.id, squad.id);
      else if (saved) ctx.teams.update(detail.id, previous, squad.id);
      throw error;
    }
  });
}
export function startSession(ctx: ApiCtx, detail: NodeDetail | null, request: LaunchRequest & { cols?: number; rows?: number }) {
  return exclusive(ctx, async () => {
    if (!detail) {
      if (request.agent !== 'shell') throw new TeamError(400, 'Scegli un nodo per avviare un agente');
      return startShell(ctx, null, request);
    }
    const joins = request.mode === 'embedded' && request.agent !== 'shell' && request.role !== 'brain';
    const squad = joins ? await squadFor(ctx, detail, request) : null;
    let result: Awaited<ReturnType<typeof startSessionNow>>;
    try { result = await startSessionNow(ctx, detail, { ...request, teamId: squad?.id }); }
    catch (error) { if (squad?.created) await dropSquad(ctx, detail.id, squad.id); throw error; }
    if (squad) {
      try { ctx.teams.saveSquad(detail.id, detail.path, detail.name, ctx.terms.list(), squad.id); }
      catch (error) { if (result.info) await discardCreated(ctx, detail.id, [result.info]); throw error; }
    }
    return { ...result, ...(squad ? { teamId: squad.id } : {}), ...(squad?.warning ? { warning: squad.warning } : {}) };
  });
}

/** A plain login shell: in the node's folder, or a free terminal in the home folder that belongs to no node. */
async function startShell(ctx: ApiCtx, detail: NodeDetail | null, request: LaunchRequest & { cols?: number; rows?: number }) {
  if (request.mode === 'external') throw new TeamError(400, 'Il terminale normale si apre nella vista Operativa');
  const size = { cols: Math.max(20, Math.min(500, Number(request.cols) || 120)), rows: Math.max(5, Math.min(200, Number(request.rows) || 30)) };
  const projectPath = detail?.project ? (ctx.cache.nodes.get(detail.project.nodeId)?.path ?? null) : null;
  const cwd = detail ? workingDir(detail, projectPath) : process.env.HOME || '/';
  const term = await ctx.terms.spawn({ agent: 'shell', cwd, file: process.env.SHELL || '/bin/zsh', args: ['-l'], title: detail ? `shell · ${detail.name}` : 'shell · ~', nodeId: detail?.id ?? null, ...size });
  return { termId: term.info.id, info: term.info };
}

export function resumeSession(ctx: ApiCtx, id: string, request: { cols?: number; rows?: number }) {
  return exclusive(ctx, () => resumeSessionNow(ctx, id, request));
}

/**
 * Starts an ended session again under the same id, so its code, name, role, node, links and board messages stay its own.
 * Claude and Codex reopen their conversation; a shell starts fresh in the same folder. Other agents cannot resume.
 */
async function resumeSessionNow(ctx: ApiCtx, id: string, request: { cols?: number; rows?: number }) {
  const old = ctx.terms.get(id);
  if (!old) throw new TeamError(404, 'Sessione non trovata');
  if (old.info.alive) throw new TeamError(409, 'La sessione è ancora attiva');
  const info = { ...old.info };
  if (!['claude', 'codex', 'shell'].includes(info.agent)) throw new TeamError(409, 'Questo agente non permette di riprendere la conversazione');
  if (!existsSync(info.cwd)) throw new TeamError(409, 'La cartella di lavoro della sessione non esiste più');
  const size = { cols: Math.max(20, Math.min(500, Number(request.cols) || 120)), rows: Math.max(5, Math.min(200, Number(request.rows) || 30)) };
  const resumeId = info.resumeId ?? (info.agent === 'codex' ? findCodexSession(info.cwd, info.createdAt, new Set(ctx.terms.list().map(s => s.resumeId).filter((r): r is string => Boolean(r)))) : undefined);
  if (info.agent !== 'shell' && !resumeId) throw new TeamError(409, 'Conversazione non trovata: avvia una nuova sessione');
  if (info.agent !== 'shell' && info.nodeId != null && info.role === 'brain') {
    if (liveBrain(ctx, info.nodeId)) throw new TeamError(409, 'Questo nodo ha già un Main Brain attivo');
  } else if (info.agent !== 'shell' && info.nodeId != null) {
    const peers = squadSessions(ctx, info.nodeId, ctx.teams.teamOf(info.nodeId, info)).filter(s => s.id !== id);
    const limit = ctx.teams.get(info.nodeId, ctx.teams.teamOf(info.nodeId, info)).policy.maxAgents;
    if (peers.length >= limit) throw new TeamError(409, `Limite della squadra: ${limit} agenti. Chiudi una sessione o modifica il limite.`);
    if (info.role === 'orchestrator' && peers.some(s => s.role === 'orchestrator')) throw new TeamError(409, 'Questa squadra ha già un orchestratore attivo');
    if (info.role && info.role !== 'orchestrator') info.parentId = peers.find(s => s.role === 'orchestrator')?.id ?? info.parentId;
  }
  ctx.terms.kill(id);
  const term = info.agent === 'shell'
    ? await ctx.terms.spawn({ id, createdAt: info.createdAt, agent: 'shell', cwd: info.cwd, file: process.env.SHELL || '/bin/zsh', args: ['-l'], title: info.title, nodeId: info.nodeId, ...size })
    : await resumeEmbedded(ctx.terms, ctx.cfg, info, resumeId!, old.teamToken, old.seenMessage, size, info.nodeId != null && info.role
      ? memoryFor(ctx.teams.get(info.nodeId, info.role === 'brain' ? BRAIN_TEAM : ctx.teams.teamOf(info.nodeId, info)).policy, info.role, ctx.cfg.dataDir, info.nodeId, info.role === 'brain' ? BRAIN_TEAM : ctx.teams.teamOf(info.nodeId, info))
      : undefined);
  if (info.name) ctx.terms.rename(id, info.name);
  return { termId: id, info: ctx.teams.withCodes([term.info])[0] };
}

function validateAgent(request: Pick<LaunchRequest, 'agent' | 'model' | 'effort'>) {
  if (!['claude', 'codex', 'hermes', 'agy'].includes(request.agent)) throw new TeamError(400, 'Agente sconosciuto');
  const model = boundedText(request.model, 160);
  if (model && !/^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]*$/.test(model)) throw new TeamError(400, 'Identificativo modello non valido');
  const effort = boundedText(request.effort, 20);
  if (effort && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort)) throw new TeamError(400, 'Livello di ragionamento non valido');
  const choice = modelCatalog()[request.agent as keyof ReturnType<typeof modelCatalog>].find(m => m.id === model);
  if (effort && request.agent === 'claude' && !effortChoices('claude', model).includes(effort)) throw new TeamError(400, 'Livello di ragionamento non supportato per questo modello');
  if (effort && choice && !choice.efforts.includes(effort)) throw new TeamError(400, 'Livello di ragionamento non supportato per questo modello');
  return { model, effort };
}

/** Validate the whole roster before creating any PTY. A failed spawn only removes this batch. */
async function startSquadNow(ctx: ApiCtx, detail: NodeDetail, request: SquadRequest, team: string): Promise<{ sessions: TerminalInfo[] }> {
  if (!Array.isArray(request.members) || request.members.length < 1 || request.members.length > 8) throw new TeamError(400, 'Scegli da 1 a 8 agenti');
  const prompt = withAttachments(boundedText(request.prompt, 4000), attachedFiles(request.files), ctx.cfg.language === 'en');
  const current = squadSessions(ctx, detail.id, team);
  const existing = current.find(s => s.role === 'orchestrator');
  const members = request.members.map((m, i) => {
    if (!m || typeof m !== 'object') throw new TeamError(400, 'Agente non valido');
    const role = m.role ?? (!existing && i === 0 ? 'orchestrator' : 'operator');
    if (!['orchestrator', 'operator', 'reviewer'].includes(role)) throw new TeamError(400, 'Ruolo non valido');
    return { agent: m.agent, role, name: boundedText(m.name, 60), ...validateAgent(m) };
  });
  if (members.filter(m => m.role === 'orchestrator').length > (existing ? 0 : 1)) throw new TeamError(400, 'La squadra deve avere un solo orchestratore');
  if (current.length + members.length > ctx.teams.get(detail.id, team).policy.maxAgents) throw new TeamError(409, 'La squadra supera il limite del nodo. Riduci gli operatori o modifica il limite nelle impostazioni.');
  const created: TerminalInfo[] = [];
  const launch = async (member: typeof members[number], objective = '') => {
    const info = (await startSessionNow(ctx, detail, { id: detail.id, mode: 'embedded', ...member, prompt: objective, parentId: existing?.id, teamId: team })).info!;
    created.push(info);
    if (member.name) { ctx.terms.rename(info.id, member.name); info.name = member.name; }
    return info;
  };
  try {
    // With an orchestrator already running, every member joins it as an operator (startSession links them to it).
    if (existing) {
      for (const member of members) await launch(member);
      return { sessions: created };
    }
    // Operators start without an assignment; the orchestrator gets the objective only
    // after all of its workers exist, so there is no premature duplicate delegation.
    for (const member of members.filter(m => m.role !== 'orchestrator')) await launch(member);
    const leader = members.find(m => m.role === 'orchestrator');
    if (!leader) return { sessions: created };
    const orchestrator = await launch(leader, prompt);
    // The workers' launch responses predate the leader. Return their current link on the first render.
    const workers = created.slice(0, -1).map(worker => ({ ...worker, parentId: ctx.terms.get(worker.id)?.info.parentId }));
    return { sessions: [orchestrator, ...workers] };
  } catch (error) {
    await discardCreated(ctx, detail.id, created);
    throw error;
  }
}

/** The role card includes the short assignment. Keep a separate user prompt and all attachment paths intact. */
function teamLaunchContext(detail: NodeDetail, cwd: string, prompt: string, assignment: string, english: boolean, leader: boolean): string[] {
  const lines = [`Visual Brain · ${english ? 'Node' : 'Nodo'} ${detail.id} · ${detail.path}`];
  if (cwd !== detail.path) lines.push(`${english ? 'Working directory' : 'Cartella di lavoro'}: ${cwd}`);
  if (leader) for (const n of detail.notes.slice(0, 10)) lines.push(`[${n.origin}] ${n.text}`);
  if (prompt && prompt !== assignment) lines.push(`${english ? 'Full request' : 'Richiesta completa'}: ${prompt}`);
  return lines;
}

type Launched = { termId?: string; info?: TerminalInfo; opened?: boolean };
async function startSessionNow(ctx: ApiCtx, detail: NodeDetail, request: LaunchRequest & { cols?: number; rows?: number }): Promise<Launched> {
  if (!['claude', 'codex', 'hermes', 'agy', 'shell'].includes(request.agent)) throw new TeamError(400, 'Agente sconosciuto');
  if (!['embedded', 'external'].includes(request.mode)) throw new TeamError(400, 'Modalità sconosciuta');
  if (request.agent === 'shell') return startShell(ctx, detail, request);
  const projectPath = detail.project ? (ctx.cache.nodes.get(detail.project.nodeId)?.path ?? null) : null;
  const cwd = workingDir(detail, projectPath);
  const size = { cols: Math.max(20, Math.min(500, Number(request.cols) || 120)), rows: Math.max(5, Math.min(200, Number(request.rows) || 30)) };
  const { model, effort } = validateAgent(request);
  const task = boundedText(request.task, 1000);
  const prompt = withAttachments(boundedText(request.prompt, 12000), attachedFiles(request.files), ctx.cfg.language === 'en');
  if (request.mode === 'external') {
    launchExternal(request.agent, ctx.cfg, detail, cwd, buildContext(detail, ctx.cfg, prompt || task), { model, effort });
    return { opened: true };
  }
  if (request.role === 'brain') return startBrain(ctx, detail, cwd, size, request.agent as AgentName, model, effort, prompt || task);
  const team = request.teamId ?? DEFAULT_TEAM;
  const squad = ctx.teams.team(detail.id, team);
  if (!squad) throw new TeamError(404, 'Squadra non trovata');
  const sessions = squadSessions(ctx, detail.id, team);
  const board = ctx.teams.get(detail.id, team);
  ctx.teams.recover(detail.id, ctx.terms.list().filter(s => s.nodeId === detail.id));
  if (sessions.length >= board.policy.maxAgents) throw new TeamError(409, `Limite della squadra: ${board.policy.maxAgents} agenti. Chiudi una sessione o modifica il limite.`);
  const role = request.role ?? (sessions.some(s => s.role === 'orchestrator') ? 'operator' : 'orchestrator');
  if (!['orchestrator', 'operator', 'reviewer'].includes(role)) throw new TeamError(400, 'Ruolo non valido');
  if (role === 'orchestrator' && sessions.some(s => s.role === role)) throw new TeamError(409, 'Questa squadra ha già un orchestratore attivo');
  if (request.parentId && !sessions.some(s => s.id === request.parentId && s.role === 'orchestrator')) throw new TeamError(400, 'Orchestratore non disponibile in questa squadra');
  const english = ctx.cfg.language === 'en';
  const code = ctx.teams.reserveCode(detail.id, role);
  // A squad with its own worktree works there; with the squad's worktree policy, operators and reviewers also get their own.
  const base = squad.worktree && existsSync(squad.worktree.cwd) ? squad.worktree.cwd : cwd;
  const worktree = role !== 'orchestrator' && board.policy.worktrees ? await createWorktree(ctx.cfg.dataDir, detail.id, code, base).catch(error => {
    throw new TeamError(500, `Worktree Git non creato: ${String(error?.stderr || error?.message || error).trim().slice(0, 300)}`);
  }) : null;
  const workdir = worktree?.cwd ?? base;
  const assignment = task || prompt.slice(0, 1000);
  const initial = teamLaunchContext(detail, workdir, prompt, assignment, english, role === 'orchestrator');
  if (squad.worktree && base !== cwd) initial.push(english
    ? `Squad ${squad.name}, branch ${squad.worktree.branch}.${worktree ? '' : ' Commit here.'} The user decides integration into the project.`
    : `Squadra ${squad.name}, ramo ${squad.worktree.branch}.${worktree ? '' : ' Fai commit qui.'} L’integrazione nel progetto spetta all’utente.`);
  if (role === 'orchestrator' && board.policy.worktrees) initial.push(english
    ? 'Workers have separate Git worktrees. Check their commits before integrating into the squad branch.'
    : 'Operatori e revisori usano worktree Git separati. Verifica i commit prima di integrarli nel ramo di squadra.');
  if (worktree) initial.push(english
    ? `Commit on your branch ${worktree.branch} and report the SHA. Do not merge, rebase or push.`
    : `Fai commit sul ramo ${worktree.branch} e comunica lo SHA. Non fare merge, rebase o push.`);
  let term;
  try {
    term = await launchEmbedded(ctx.terms, request.agent as AgentName, ctx.cfg, detail, workdir, initial.join('\n'), size, {
      model: model || undefined, effort: effort || undefined, role, task: assignment, parentId: request.parentId || (role !== 'orchestrator' ? sessions.find(s => s.role === 'orchestrator')?.id : undefined),
      seenMessage: board.messages.at(-1)?.id ?? 0, code, branch: worktree?.branch, squad: ctx.teams.teams(detail.id).length > 1 ? squad.name : undefined,
      memory: memoryFor(board.policy, role, ctx.cfg.dataDir, detail.id, team),
    });
  } catch (error) {
    if (worktree) await removeWorktree(ctx.cfg.dataDir, worktree.path);
    throw error;
  }
  ctx.teams.bindCode(detail.id, term.info.id, code);
  ctx.teams.bindTeam(detail.id, term.info.id, team);
  if (role === 'orchestrator') for (const session of sessions) {
    if (session.role && session.role !== 'orchestrator') {
      const existing = ctx.terms.get(session.id);
      if (existing) existing.info.parentId = term.info.id;
    }
  }
  if (task || (role !== 'orchestrator' && prompt)) ctx.teams.createTask(detail.id, request.parentId || 'user', { title: task || prompt.slice(0, 1000), assignedTo: term.info.id }, team);
  return { termId: term.info.id, info: { ...term.info, code, teamId: team } };
}

/**
 * The node's Main Brain: one per node, in the project folder, with its own board. It reads the squads' summaries, talks
 * to their orchestrators and proposes new squads; the orchestrators at work are told it exists.
 */
async function startBrain(ctx: ApiCtx, detail: NodeDetail, cwd: string, size: { cols: number; rows: number }, agent: AgentName, model: string, effort: string, objective: string) {
  if (liveBrain(ctx, detail.id)) throw new TeamError(409, 'Questo nodo ha già un Main Brain attivo');
  const english = ctx.cfg.language === 'en';
  const code = ctx.teams.reserveCode(detail.id, 'brain');
  const board = ctx.teams.get(detail.id, BRAIN_TEAM);
  const assignment = objective.slice(0, 1000);
  const initial = teamLaunchContext(detail, cwd, objective, assignment, english, true).join('\n');
  const term = await launchEmbedded(ctx.terms, agent, ctx.cfg, detail, cwd, initial, size, {
    model: model || undefined, effort: effort || undefined, role: 'brain', task: assignment, seenMessage: board.messages.at(-1)?.id ?? 0, code,
    memory: memoryFor(board.policy, 'brain', ctx.cfg.dataDir, detail.id, BRAIN_TEAM),
  });
  ctx.teams.bindCode(detail.id, term.info.id, code);
  for (const orchestrator of ctx.terms.list().filter(s => s.nodeId === detail.id && s.alive && s.role === 'orchestrator')) {
    const team = ctx.teams.teamOf(detail.id, orchestrator);
    ctx.teams.message(detail.id, SYSTEM, orchestrator.id, english
      ? `Main Brain ${code} is active in this node: report milestones, blocks and the end of your objective to it (message to ${code}) and follow its priorities.`
      : `Il Main Brain ${code} è attivo nel nodo: riferiscigli tappe, blocchi e fine dell’obiettivo (messaggio a ${code}) e segui le sue priorità.`, team);
    wakeSession(ctx, orchestrator.id);
  }
  return { termId: term.info.id, info: { ...term.info, code, teamId: BRAIN_TEAM } };
}
