import type { ApiCtx } from './api.ts';
import type { LaunchRequest, NodeDetail, SquadRequest, TerminalInfo } from '../shared/types.ts';
import { buildContext, launchEmbedded, launchExternal, workingDir } from './launch.ts';
import { boundedText, TeamError } from './team.ts';
import { modelCatalog } from './models.ts';

function validateAgent(request: Pick<LaunchRequest, 'agent' | 'model' | 'effort'>) {
  if (!['claude', 'codex', 'hermes'].includes(request.agent)) throw new TeamError(400, 'Agente sconosciuto');
  const model = boundedText(request.model, 160);
  if (model && !/^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]*$/.test(model)) throw new TeamError(400, 'Identificativo modello non valido');
  const effort = boundedText(request.effort, 20);
  if (effort && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort)) throw new TeamError(400, 'Livello di ragionamento non valido');
  const choice = modelCatalog()[request.agent as keyof ReturnType<typeof modelCatalog>].find(m => m.id === model);
  if (effort && choice && !choice.efforts.includes(effort)) throw new TeamError(400, 'Livello di ragionamento non supportato per questo modello');
  return { model, effort };
}

/** Validate the whole roster before creating any PTY. A failed spawn only removes this batch. */
export function startSquad(ctx: ApiCtx, detail: NodeDetail, request: SquadRequest): { sessions: TerminalInfo[] } {
  if (!Array.isArray(request.members) || request.members.length < 1 || request.members.length > 8) throw new TeamError(400, 'Scegli da 1 a 8 agenti');
  const prompt = boundedText(request.prompt, 1000);
  const members = request.members.map(m => {
    if (!m || typeof m !== 'object') throw new TeamError(400, 'Agente non valido');
    return { agent: m.agent, ...validateAgent(m) };
  });
  const current = ctx.terms.list().filter(s => s.nodeId === detail.id && s.agent !== 'shell' && s.alive);
  if (current.some(s => s.role === 'orchestrator')) throw new TeamError(409, 'La squadra ha già un orchestratore. Aggiungi un singolo agente.');
  if (current.length + members.length > ctx.teams.get(detail.id).policy.maxAgents) throw new TeamError(409, 'La squadra supera il limite del nodo. Riduci gli operatori o modifica il limite nelle impostazioni.');
  const created: TerminalInfo[] = [];
  try {
    // Operators start without an assignment; the orchestrator gets the objective only
    // after all of its workers exist, so there is no premature duplicate delegation.
    for (const member of members.slice(1)) created.push(startSession(ctx, detail, { id: detail.id, mode: 'embedded', ...member, role: 'operator' }).info!);
    const orchestrator = startSession(ctx, detail, { id: detail.id, mode: 'embedded', ...members[0], role: 'orchestrator', prompt }).info!;
    created.push(orchestrator);
    return { sessions: [orchestrator, ...created.slice(0, -1)] };
  } catch (error) {
    for (const session of created) { ctx.teams.release(detail.id, session.id); ctx.terms.kill(session.id); }
    throw error;
  }
}

export function startSession(ctx: ApiCtx, detail: NodeDetail, request: LaunchRequest & { cols?: number; rows?: number }) {
  if (!['claude', 'codex', 'hermes', 'shell'].includes(request.agent)) throw new TeamError(400, 'Agente sconosciuto');
  if (!['embedded', 'external'].includes(request.mode)) throw new TeamError(400, 'Modalità sconosciuta');
  const projectPath = detail.project ? (ctx.cache.nodes.get(detail.project.nodeId)?.path ?? null) : null;
  const cwd = workingDir(detail, projectPath);
  const size = { cols: Math.max(20, Math.min(500, Number(request.cols) || 120)), rows: Math.max(5, Math.min(200, Number(request.rows) || 30)) };
  if (request.agent === 'shell') {
    if (request.mode === 'external') throw new TeamError(400, 'Il terminale normale si apre nella vista Operativa');
    const term = ctx.terms.spawn({ agent: 'shell', cwd, file: process.env.SHELL || '/bin/zsh', args: ['-l'], title: `shell · ${detail.name}`, nodeId: detail.id, ...size });
    return { termId: term.info.id, info: term.info };
  }
  const { model, effort } = validateAgent(request);
  const task = boundedText(request.task, 1000);
  const prompt = boundedText(request.prompt, 12000);
  if (request.mode === 'external') {
    launchExternal(request.agent, ctx.cfg, detail, cwd, buildContext(detail, ctx.cfg, prompt || task), { model, effort });
    return { opened: true };
  }
  const sessions = ctx.terms.list().filter(s => s.nodeId === detail.id && s.agent !== 'shell' && s.alive);
  const board = ctx.teams.get(detail.id);
  ctx.teams.recover(detail.id, sessions);
  if (sessions.length >= board.policy.maxAgents) throw new TeamError(409, `Limite della squadra: ${board.policy.maxAgents} agenti. Chiudi una sessione o modifica il limite.`);
  const role = request.role ?? (sessions.some(s => s.role === 'orchestrator') ? 'operator' : 'orchestrator');
  if (!['orchestrator', 'operator', 'reviewer'].includes(role)) throw new TeamError(400, 'Ruolo non valido');
  if (role === 'orchestrator' && sessions.some(s => s.role === role)) throw new TeamError(409, 'Questo nodo ha già un orchestratore attivo');
  if (request.parentId && !sessions.some(s => s.id === request.parentId && s.role === 'orchestrator')) throw new TeamError(400, 'Orchestratore non disponibile su questo nodo');
  const english = ctx.cfg.language === 'en';
  const initial = role === 'orchestrator' ? buildContext(detail, ctx.cfg, prompt || task) : english ? [
    `Visual Brain: ${detail.path}. Working directory: ${cwd}. Node ${detail.id}, ${detail.project?.description || detail.summary || detail.name}.`,
    `Task: ${task || prompt || 'Read the node board and wait for an assignment.'}`,
    'Read only files relevant to your task. Do not repeat a full project analysis.',
  ].join('\n') : [
    `Visual Brain: ${detail.path}. Cartella di lavoro: ${cwd}. Nodo ${detail.id}, ${detail.project?.description || detail.summary || detail.name}.`,
    `Incarico: ${task || prompt || 'Consulta la bacheca del nodo e attendi un incarico.'}`,
    'Leggi solo i file utili al tuo incarico. Non ripetere l’analisi completa del progetto.',
  ].join('\n');
  const term = launchEmbedded(ctx.terms, request.agent, ctx.cfg, detail, cwd, initial + (board.summary ? (english ? '\nShared summary: ' : '\nRiepilogo condiviso: ') + board.summary : ''), size, {
    model: model || undefined, effort: effort || undefined, role, task: task || prompt.slice(0, 1000), parentId: request.parentId || (role !== 'orchestrator' ? sessions.find(s => s.role === 'orchestrator')?.id : undefined),
    seenMessage: board.messages.at(-1)?.id ?? 0,
  });
  if (role === 'orchestrator') for (const session of sessions) {
    if (session.role && session.role !== 'orchestrator') {
      const existing = ctx.terms.get(session.id);
      if (existing) existing.info.parentId = term.info.id;
    }
  }
  if (task || (role !== 'orchestrator' && prompt)) ctx.teams.createTask(detail.id, request.parentId || 'user', { title: task || prompt.slice(0, 1000), assignedTo: term.info.id });
  return { termId: term.info.id, info: term.info };
}
