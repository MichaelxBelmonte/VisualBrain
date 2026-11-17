// Small durable boards per node, shared by independent CLI providers: one per squad of the node, plus the Main Brain's.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentName, AgentRole, ClaudeMemory, InboxColumn, InboxItem, InboxKind, SavedSquad, SwarmProposal, TeamBoard, TeamInfo, TeamLink, TeamMessage, TeamSummary, TeamTask, TerminalInfo } from '../shared/types.ts';

export class TeamError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export function boundedText(value: unknown, max: number, required = false): string {
  if (value !== undefined && typeof value !== 'string') throw new TeamError(400, 'Testo non valido');
  const text = (value as string | undefined)?.trim() ?? '';
  if (text.length > max || (required && !text)) throw new TeamError(400, `Testo richiesto, massimo ${max} caratteri`);
  return text;
}

/** Codes name team sessions for people and agents alike: one prefix per role and a number that is never reused in the node. */
const CODE_PREFIX: Record<AgentRole, string> = { orchestrator: 'ORC', operator: 'OP', reviewer: 'REV', brain: 'BRAIN' };
const KEEP_CODES = 300;
/** The node's first squad: its board is the node file that existed before squads, so nothing older changes. */
export const DEFAULT_TEAM = '1';
/** The Main Brain's board: squad summaries, its messages, the proposals it makes and what orchestrators report to it. */
export const BRAIN_TEAM = 'brain';
export const TEAM_COLORS = 8;
const TEAM_NAMES = ['Alfa', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta', 'Iota', 'Kappa', 'Lambda', 'Mu'];
const KEEP_INBOX = 300;
const teamName = (n: number) => TEAM_NAMES[(n - 1) % TEAM_NAMES.length] + (n > TEAM_NAMES.length ? ` ${n}` : '');
export const isTeamId = (value: unknown): value is string => typeof value === 'string' && /^(?:[1-9]\d{0,3}|brain)$/.test(value);
const emptyBoard = (): TeamBoard => ({ summary: '', messages: [], tasks: [], policy: { autoSpawn: false, maxAgents: 4 } });
const INBOX_KINDS: InboxKind[] = ['result', 'blocked', 'question', 'note'];
export const MEMORY_MODES: ClaudeMemory[] = ['leaders', 'all', 'squad', 'off'];

/**
 * Claude Code auto memory for one session of a squad: undefined keeps the project's memory (one per Git repository, shared by
 * its worktrees), 'off' disables it, a path gives the session that directory. Orchestrators and the Main Brain lead; operators
 * and reviewers report through the board, so by default only the leader writes to memory.
 */
export function memoryFor(policy: TeamBoard['policy'], role: AgentRole | undefined, dataDir: string, nodeId: number, team: string): string | undefined {
  if (!role) return undefined;
  const mode = policy.memory ?? 'leaders', leader = role === 'orchestrator' || role === 'brain';
  if (mode === 'all') return undefined;
  if (mode === 'off' || !leader) return 'off';
  return mode === 'squad' ? join(dataDir, 'memory', `node-${nodeId}`, `team-${team}`) : undefined;
}
const INBOX_COLUMNS: InboxColumn[] = ['new', 'ready', 'forwarded', 'archived'];
const KIND_WORDS: Record<'it' | 'en', Record<InboxKind, string>> = {
  it: { result: 'Risultato', blocked: 'Bloccato', question: 'Domanda', note: 'Nota' },
  en: { result: 'Result', blocked: 'Blocked', question: 'Question', note: 'Note' },
};
/** By rule, no model: a finished task is a result, a blocked one a block, a message ending in a question a question. */
export const classify = (text: string): InboxKind => /\?\s*$|\?\s/.test(text) ? 'question' : 'note';

export class Teams {
  private readonly boards = new Map<string, TeamBoard>();
  private readonly dir: string;
  private links: TeamLink[] | null = null;
  constructor(dataDir: string) { this.dir = join(dataDir, 'teams'); }
  getLinks(): TeamLink[] {
    if (this.links === null) {
      try { this.links = JSON.parse(readFileSync(join(this.dir, 'links.json'), 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; this.links = []; }
    }
    return this.links!;
  }
  private saveLinks(links: TeamLink[]): void {
    mkdirSync(this.dir, { recursive: true });
    const file = join(this.dir, 'links.json');
    writeFileSync(file + '.tmp', JSON.stringify(links), { mode: 0o600 });
    renameSync(file + '.tmp', file); this.links = links;
  }
  link(endpoints: Omit<TeamLink, 'id'>): TeamLink {
    const links = this.getLinks();
    const equal = (a: TeamLink, b: Omit<TeamLink, 'id'>) => a.srcNodeId === b.srcNodeId && a.dstNodeId === b.dstNodeId && a.srcSessionId === b.srcSessionId && a.dstSessionId === b.dstSessionId;
    const reverse = { srcNodeId: endpoints.dstNodeId, dstNodeId: endpoints.srcNodeId, srcSessionId: endpoints.dstSessionId, dstSessionId: endpoints.srcSessionId };
    const existing = links.find(l => equal(l, endpoints) || equal(l, reverse));
    if (existing) return existing;
    if (links.length >= 500) throw new TeamError(409, 'Troppi collegamenti tra squadre');
    const link = { id: randomUUID().slice(0, 8), ...endpoints };
    this.saveLinks([...links, link]); return link;
  }
  unlink(id: string): void { this.saveLinks(this.getLinks().filter(l => l.id !== id)); }
  /**
   * Inside a node, a squad talks within itself and the Main Brain with the orchestrators; squads stay apart otherwise.
   * Between nodes (or between squads of a node) only the channels the person created.
   */
  canTalk(a: TerminalInfo, b: TerminalInfo): boolean {
    if (a.nodeId != null && a.nodeId === b.nodeId) {
      if (this.teamOf(a.nodeId, a) === this.teamOf(b.nodeId, b)) return true;
      if ((a.role === 'brain' && b.role === 'orchestrator') || (b.role === 'brain' && a.role === 'orchestrator')) return true;
    }
    return this.getLinks().some(l => {
      const matches = (src: TerminalInfo, dst: TerminalInfo) => src.nodeId === l.srcNodeId && dst.nodeId === l.dstNodeId && (l.srcSessionId ? src.id === l.srcSessionId : src.role === 'orchestrator') && (l.dstSessionId ? dst.id === l.dstSessionId : dst.role === 'orchestrator');
      return matches(a, b) || matches(b, a);
    });
  }
  private key(nodeId: number, team: string): string {
    if (!Number.isSafeInteger(nodeId) || nodeId <= 0) throw new TeamError(400, 'Nodo non valido');
    if (!isTeamId(team)) throw new TeamError(400, 'Squadra non valida');
    return team === DEFAULT_TEAM ? String(nodeId) : `${nodeId}-${team}`;
  }
  /** The board of a squad (the node's first squad by default). The first squad's file also keeps the node's codes and squads. */
  get(nodeId: number, team = DEFAULT_TEAM): TeamBoard {
    const key = this.key(nodeId, team);
    if (!this.boards.has(key)) {
      let saved = emptyBoard();
      try { saved = JSON.parse(readFileSync(join(this.dir, `${key}.json`), 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      this.boards.set(key, saved);
    }
    return this.boards.get(key)!;
  }
  private save(nodeId: number, board: TeamBoard, team = DEFAULT_TEAM): void {
    const key = this.key(nodeId, team);
    mkdirSync(this.dir, { recursive: true });
    const file = join(this.dir, `${key}.json`);
    const temp = `${file}.tmp`;
    writeFileSync(temp, JSON.stringify(board), { mode: 0o600 });
    renameSync(temp, file);
    this.boards.set(key, board);
  }

  /** The node's squads, oldest first. The first squad exists implicitly: boards from before squads are its board. */
  teams(nodeId: number): TeamInfo[] {
    const list = this.get(nodeId).teams ?? [];
    return list.some(t => t.id === DEFAULT_TEAM) ? list : [{ id: DEFAULT_TEAM, name: teamName(1), color: 0, createdAt: 0 }, ...list];
  }
  team(nodeId: number, id: string): TeamInfo | undefined { return this.teams(nodeId).find(t => t.id === id); }
  createTeam(nodeId: number, body: { name?: unknown; objective?: unknown } = {}): TeamInfo {
    const node = structuredClone(this.get(nodeId));
    const list = this.teams(nodeId);
    if (list.filter(t => !t.archived).length >= 12) throw new TeamError(409, 'Troppe squadre nel nodo: archiviane una');
    const number = Math.max(node.nextTeam ?? 2, ...list.map(t => Number(t.id) + 1).filter(Number.isFinite));
    const name = boundedText(body.name, 40) || teamName(number);
    const team: TeamInfo = { id: String(number), name, color: (number - 1) % TEAM_COLORS, createdAt: Date.now(), ...(boundedText(body.objective, 4000) ? { objective: boundedText(body.objective, 4000) } : {}) };
    node.teams = [...list, team]; node.nextTeam = number + 1;
    this.save(nodeId, node); return team;
  }
  setTeam(nodeId: number, id: string, patch: Partial<Pick<TeamInfo, 'name' | 'objective' | 'archived' | 'worktree'>>): TeamInfo {
    if (!this.team(nodeId, id)) throw new TeamError(404, 'Squadra non trovata');
    const node = structuredClone(this.get(nodeId));
    node.teams = this.teams(nodeId).map(t => {
      if (t.id !== id) return t;
      const next = { ...t, ...patch };
      for (const k of Object.keys(next) as (keyof TeamInfo)[]) if (next[k] === undefined || next[k] === '' || next[k] === false) delete next[k];
      return next;
    });
    this.save(nodeId, node); return this.team(nodeId, id)!;
  }
  /** Forgets a squad created by a launch that failed (never the first squad). */
  removeTeam(nodeId: number, id: string): void {
    if (id === DEFAULT_TEAM) return;
    const node = structuredClone(this.get(nodeId));
    node.teams = this.teams(nodeId).filter(t => t.id !== id);
    this.save(nodeId, node);
  }
  /** The squad of a session: the Main Brain has its own board; sessions from before squads belong to the first squad. */
  teamOf(nodeId: number, session: Pick<TerminalInfo, 'id' | 'role'>): string {
    if (session.role === 'brain') return BRAIN_TEAM;
    return this.get(nodeId).members?.[session.id] ?? DEFAULT_TEAM;
  }
  bindTeam(nodeId: number, sessionId: string, team: string): void {
    if (team === BRAIN_TEAM) return;
    const node = structuredClone(this.get(nodeId));
    node.members = Object.fromEntries(Object.entries({ ...node.members, [sessionId]: team }).slice(-KEEP_CODES));
    this.save(nodeId, node);
  }
  /** Whether a folder is a squad's own worktree: closing one of its sessions must not remove it under the others. */
  isTeamWorktree(nodeId: number, cwd: string): boolean {
    return this.teams(nodeId).some(t => t.worktree && (cwd === t.worktree.path || cwd.startsWith(t.worktree.path + '/')));
  }

  update(nodeId: number, body: { summary?: unknown; autoSpawn?: unknown; maxAgents?: unknown; worktrees?: unknown; delivery?: unknown; memory?: unknown }, team = DEFAULT_TEAM): TeamBoard {
    const b = structuredClone(this.get(nodeId, team));
    if (body.summary !== undefined) b.summary = boundedText(body.summary, 4000);
    if (body.autoSpawn !== undefined) {
      if (typeof body.autoSpawn !== 'boolean') throw new TeamError(400, 'autoSpawn non valido');
      b.policy.autoSpawn = body.autoSpawn;
    }
    if (body.worktrees !== undefined) {
      if (typeof body.worktrees !== 'boolean') throw new TeamError(400, 'worktrees non valido');
      b.policy.worktrees = body.worktrees;
    }
    if (body.delivery !== undefined) {
      if (body.delivery !== 'auto' && body.delivery !== 'manual') throw new TeamError(400, 'Consegna non valida: auto o manual');
      b.policy.delivery = body.delivery;
    }
    if (body.memory !== undefined) {
      if (!MEMORY_MODES.includes(body.memory as ClaudeMemory)) throw new TeamError(400, 'Memoria non valida: leaders, all, squad o off');
      b.policy.memory = body.memory as ClaudeMemory;
    }
    if (body.maxAgents !== undefined) {
      if (!Number.isInteger(body.maxAgents) || Number(body.maxAgents) < 1 || Number(body.maxAgents) > 8) throw new TeamError(400, 'Limite agenti: da 1 a 8');
      b.policy.maxAgents = Number(body.maxAgents);
    }
    this.save(nodeId, b, team); return b;
  }
  saveSquad(nodeId: number, nodePath: string, name: string, sessions: TerminalInfo[], team = DEFAULT_TEAM): void {
    const members = sessions.filter(s => s.nodeId === nodeId && s.alive && s.agent !== 'shell' && s.role && s.role !== 'brain' && this.teamOf(nodeId, s) === team)
      .map(s => ({ agent: s.agent as AgentName, role: s.role!, model: s.model ?? '', effort: s.effort ?? '', ...(s.name ? { name: s.name } : {}) }))
      .sort((a, b) => Number(b.role === 'orchestrator') - Number(a.role === 'orchestrator'));
    if (!members.length) return;
    const policy = { ...this.get(nodeId, team).policy };
    const b = structuredClone(this.get(nodeId));
    const squadName = team === DEFAULT_TEAM ? name : `${name} · ${this.team(nodeId, team)?.name ?? team}`;
    const same = (s: SavedSquad) => s.nodePath === nodePath && JSON.stringify(s.members) === JSON.stringify(members) && JSON.stringify(s.policy) === JSON.stringify(policy);
    if (b.savedSquads?.[0] && same(b.savedSquads[0])) return;
    b.savedSquads = [{ id: randomUUID().slice(0, 8), savedAt: Date.now(), nodePath, name: squadName, members, policy }, ...(b.savedSquads ?? []).filter(s => !same(s))].slice(0, 12);
    this.save(nodeId, b);
  }
  message(nodeId: number, from: string, to: string | null, text: unknown, team = DEFAULT_TEAM, max = 1200): TeamMessage {
    const b = structuredClone(this.get(nodeId, team));
    const m: TeamMessage = { id: (b.messages.at(-1)?.id ?? 0) + 1, from, to, text: boundedText(text, max, true), createdAt: Date.now() };
    b.messages.push(m); b.messages = b.messages.slice(-500);
    this.save(nodeId, b, team); return m;
  }
  createTask(nodeId: number, from: string, body: { title?: unknown; scope?: unknown; assignedTo?: string | null }, team = DEFAULT_TEAM): TeamTask {
    const b = structuredClone(this.get(nodeId, team));
    if (b.tasks.filter(t => t.status !== 'done').length >= 100) throw new TeamError(409, 'Troppi incarichi aperti');
    if (body.scope !== undefined && (!Array.isArray(body.scope) || body.scope.length > 16 || body.scope.some(p => typeof p !== 'string' || p.length > 500))) throw new TeamError(400, 'scope: massimo 16 percorsi');
    const task: TeamTask = { id: randomUUID().slice(0, 8), title: boundedText(body.title, 1000, true), scope: body.scope as string[] ?? [], assignedTo: body.assignedTo ?? null, status: 'pending', result: '', createdBy: from, updatedAt: Date.now() };
    b.tasks.push(task);
    b.tasks = [...b.tasks.filter(t => t.status === 'done').slice(-100), ...b.tasks.filter(t => t.status !== 'done')];
    this.save(nodeId, b, team); return task;
  }
  changeTask(nodeId: number, taskId: string, actor: string, role: AgentRole | undefined, body: { status?: unknown; result?: unknown; assignedTo?: string | null; held?: boolean }, team = DEFAULT_TEAM): TeamTask {
    const b = structuredClone(this.get(nodeId, team));
    const task = b.tasks.find(t => t.id === taskId);
    if (!task) throw new TeamError(404, 'Incarico non trovato');
    const manages = actor === 'user' || role === 'orchestrator';
    if (!manages && task.assignedTo !== null && task.assignedTo !== actor) throw new TeamError(409, 'Incarico già assegnato a un altro agente');
    if (!manages && task.status === 'done') throw new TeamError(409, 'Incarico già completato');
    if (body.assignedTo !== undefined) {
      if (!manages) throw new TeamError(403, 'Solo l’orchestratore può riassegnare');
      task.assignedTo = body.assignedTo;
    }
    if (body.status !== undefined) {
      if (!['pending', 'working', 'done', 'blocked'].includes(String(body.status))) throw new TeamError(400, 'Stato non valido');
      if (!manages && body.status === 'pending') throw new TeamError(403, 'Solo l’orchestratore può riaprire');
      task.status = body.status as TeamTask['status'];
      if (!manages && task.assignedTo === null) task.assignedTo = actor; // Atomic claim in this single server process.
    }
    if (body.result !== undefined) task.result = boundedText(body.result, 2000);
    if (body.held !== undefined) { if (body.held) task.held = true; else delete task.held; }
    task.updatedAt = Date.now(); this.save(nodeId, b, team); return task;
  }
  release(nodeId: number, sessionId: string, team?: string): void {
    for (const id of team ? [team] : this.teams(nodeId).map(t => t.id)) {
      const b = structuredClone(this.get(nodeId, id));
      let changed = false;
      for (const t of b.tasks) if (t.assignedTo === sessionId && t.status !== 'done') {
        t.assignedTo = null; t.status = 'pending'; t.updatedAt = Date.now(); changed = true;
      }
      if (changed) this.save(nodeId, b, id);
    }
  }

  /** Puts a report on the sorting board instead of delivering it: the person classifies it and decides whether to forward it. */
  hold(nodeId: number, team: string, item: { kind: InboxKind; from: string; text: string; taskId?: string; taskTitle?: string }): InboxItem {
    const b = structuredClone(this.get(nodeId, team));
    const inbox = b.inbox ?? [];
    const now = Date.now();
    const held: InboxItem = { id: (inbox.at(-1)?.id ?? 0) + 1, column: 'new', createdAt: now, updatedAt: now, ...item, text: item.text.slice(0, 2000) };
    // Old forwarded or archived items go first when the board is full; what still waits for the person is never dropped.
    const done = (i: InboxItem) => i.column === 'forwarded' || i.column === 'archived';
    let list = [...inbox, held];
    while (list.length > KEEP_INBOX && list.some(done)) list.splice(list.findIndex(done), 1);
    b.inbox = list;
    this.save(nodeId, b, team); return held;
  }
  changeInbox(nodeId: number, team: string, id: number, body: { column?: unknown; kind?: unknown; note?: unknown }): InboxItem {
    const b = structuredClone(this.get(nodeId, team));
    const item = b.inbox?.find(i => i.id === id);
    if (!item) throw new TeamError(404, 'Elemento non trovato');
    if (body.column !== undefined) {
      if (!INBOX_COLUMNS.includes(body.column as InboxColumn) || body.column === 'forwarded') throw new TeamError(400, 'Colonna non valida');
      item.column = body.column as InboxColumn;
    }
    if (body.kind !== undefined) {
      if (!INBOX_KINDS.includes(body.kind as InboxKind)) throw new TeamError(400, 'Categoria non valida');
      item.kind = body.kind as InboxKind;
    }
    if (body.note !== undefined) { const note = boundedText(body.note, 1000); if (note) item.note = note; else delete item.note; }
    item.updatedAt = Date.now(); this.save(nodeId, b, team); return item;
  }
  /**
   * The message that carries the chosen items to their recipient, and the items marked as forwarded. `release` lets the
   * squad's orchestrator see the held task results again (only when they are forwarded to it).
   */
  forward(nodeId: number, team: string, ids: unknown, to: string, note: unknown, codeOf: (id: string) => string, language: 'it' | 'en' = 'it', release = false): { text: string; items: InboxItem[] } {
    if (!Array.isArray(ids) || !ids.length || ids.length > 20 || ids.some(id => !Number.isSafeInteger(id))) throw new TeamError(400, 'Scegli da 1 a 20 elementi');
    const comment = boundedText(note, 1000);
    const b = structuredClone(this.get(nodeId, team));
    const items = (ids as number[]).map(id => b.inbox?.find(i => i.id === id));
    if (items.some(i => !i)) throw new TeamError(404, 'Elemento non trovato');
    const words = KIND_WORDS[language];
    const lines = (items as InboxItem[]).map(i => `• [${words[i.kind]} · ${codeOf(i.from)}${i.taskId ? (language === 'en' ? ` · task ${i.taskId}` : ` · incarico ${i.taskId}`) : ''}] ${i.text}${i.note ? (language === 'en' ? ` (note: ${i.note})` : ` (nota: ${i.note})`) : ''}`);
    const head = language === 'en' ? 'Forwarded by the user from the sorting board:' : 'Inoltrato dall’utente dalla bacheca di smistamento:';
    const tail = comment ? (language === 'en' ? `\nUser note: ${comment}` : `\nNota dell’utente: ${comment}`) : '';
    let text = [head, ...lines].join('\n');
    if (text.length + tail.length > 4000) text = text.slice(0, 3990 - tail.length) + '…';
    const now = Date.now();
    for (const i of items as InboxItem[]) { i.column = 'forwarded'; i.forwardedTo = to; i.forwardedAt = now; i.updatedAt = now; }
    if (release) for (const i of items as InboxItem[]) { const task = i.taskId ? b.tasks.find(t => t.id === i.taskId) : undefined; if (task) delete task.held; }
    this.save(nodeId, b, team);
    return { text: text + tail, items: items as InboxItem[] };
  }

  /** A squad the Main Brain asks the person to start. Validated here for shape; models and limits are checked at launch. */
  propose(nodeId: number, from: string, body: { name?: unknown; objective?: unknown; members?: unknown }): SwarmProposal {
    const b = structuredClone(this.get(nodeId, BRAIN_TEAM));
    const proposals = b.proposals ?? [];
    if (proposals.filter(p => p.status === 'pending').length >= 10) throw new TeamError(409, 'Troppe proposte in attesa: aspetta che l’utente le avvii o le scarti');
    const members = body.members;
    if (!Array.isArray(members) || members.length < 1 || members.length > 8) throw new TeamError(400, 'members: da 1 a 8 agenti');
    const clean = members.map(m => {
      if (!m || typeof m !== 'object' || !['claude', 'codex', 'hermes', 'agy'].includes(String(m.agent))) throw new TeamError(400, 'Agente non valido: claude, codex, hermes o agy');
      const role = m.role ?? 'operator';
      if (!['orchestrator', 'operator', 'reviewer'].includes(role)) throw new TeamError(400, 'Ruolo non valido: orchestrator, operator o reviewer');
      return { agent: m.agent as AgentName, role: role as AgentRole, ...(boundedText(m.model, 160) ? { model: boundedText(m.model, 160) } : {}), ...(boundedText(m.effort, 20) ? { effort: boundedText(m.effort, 20) } : {}) };
    });
    if (clean.filter(m => m.role === 'orchestrator').length > 1) throw new TeamError(400, 'Un solo orchestratore per squadra');
    if (!clean.some(m => m.role === 'orchestrator')) clean[0].role = 'orchestrator';
    const proposal: SwarmProposal = { id: randomUUID().slice(0, 8), name: boundedText(body.name, 40, true), objective: boundedText(body.objective, 4000, true), members: clean, createdBy: from, createdAt: Date.now(), status: 'pending' };
    b.proposals = [...proposals.filter(p => p.status === 'pending'), ...proposals.filter(p => p.status !== 'pending').slice(-20), proposal];
    this.save(nodeId, b, BRAIN_TEAM); return proposal;
  }
  proposal(nodeId: number, id: string): SwarmProposal | undefined { return this.get(nodeId, BRAIN_TEAM).proposals?.find(p => p.id === id); }
  settleProposal(nodeId: number, id: string, status: 'launched' | 'discarded', teamId?: string): SwarmProposal {
    const b = structuredClone(this.get(nodeId, BRAIN_TEAM));
    const proposal = b.proposals?.find(p => p.id === id);
    if (!proposal) throw new TeamError(404, 'Proposta non trovata');
    if (proposal.status !== 'pending') throw new TeamError(409, 'Proposta già gestita');
    proposal.status = status; if (teamId) proposal.teamId = teamId;
    this.save(nodeId, b, BRAIN_TEAM); return proposal;
  }

  /** Each squad of the node with its counts: what the board, the map and the Main Brain show. */
  summaries(nodeId: number, sessions: TerminalInfo[]): TeamSummary[] {
    return this.teams(nodeId).map(team => {
      const board = this.get(nodeId, team.id);
      const own = sessions.filter(s => s.nodeId === nodeId && s.role && s.role !== 'brain' && this.teamOf(nodeId, s) === team.id);
      const tasks = { pending: 0, working: 0, done: 0, blocked: 0 };
      for (const t of board.tasks) tasks[t.status]++;
      const orchestrator = own.find(s => s.alive && s.role === 'orchestrator');
      return {
        ...team, summary: board.summary, delivery: board.policy.delivery ?? 'auto', maxAgents: board.policy.maxAgents, sessions: own.length, alive: own.filter(s => s.alive).length,
        orchestrator: orchestrator ? orchestrator.code ?? orchestrator.id : null, tasks,
        inbox: (board.inbox ?? []).filter(i => i.column === 'new' || i.column === 'ready').length,
      };
    });
  }

  /** The next code of a role in the node (ORC1, OP3, REV1). A launch that fails leaves a gap: numbers are never reused. */
  reserveCode(nodeId: number, role: AgentRole): string {
    const b = structuredClone(this.get(nodeId));
    const codes = b.codes ??= { next: {}, ids: {} };
    codes.next[role] = (codes.next[role] ?? 0) + 1;
    this.save(nodeId, b);
    return CODE_PREFIX[role] + codes.next[role];
  }
  bindCode(nodeId: number, sessionId: string, code: string): void {
    const b = structuredClone(this.get(nodeId));
    const codes = b.codes ??= { next: {}, ids: {} };
    codes.ids[sessionId] = code;
    codes.ids = Object.fromEntries(Object.entries(codes.ids).slice(-KEEP_CODES));
    this.save(nodeId, b);
  }
  /** The session id behind an id or a code (any case) among the given sessions of the node. */
  resolve(nodeId: number, sessions: TerminalInfo[], value: string): TerminalInfo | undefined {
    const ids = this.get(nodeId).codes?.ids ?? {};
    return sessions.find(s => s.id === value) ?? sessions.find(s => ids[s.id]?.toUpperCase() === value.toUpperCase());
  }
  /** Sessions with their code and squad. Live team sessions started before codes existed get one now, oldest first. */
  withCodes(sessions: TerminalInfo[]): TerminalInfo[] {
    const codeOf = (s: TerminalInfo) => s.role && s.nodeId != null ? this.get(s.nodeId).codes?.ids[s.id] : undefined;
    for (const s of sessions.filter(s => s.alive && s.role && s.nodeId != null && !codeOf(s)).sort((a, b) => a.createdAt - b.createdAt)) {
      this.bindCode(s.nodeId!, s.id, this.reserveCode(s.nodeId!, s.role!));
    }
    return sessions.map(s => {
      if (!s.role || s.nodeId == null) return s;
      const code = codeOf(s), teamId = this.teamOf(s.nodeId, s);
      return { ...s, ...(code ? { code } : {}), teamId };
    });
  }
  recover(nodeId: number, sessions: TerminalInfo[]): void {
    for (const team of this.teams(nodeId)) {
      const dead = new Set(this.get(nodeId, team.id).tasks.filter(t => t.status !== 'done' && t.assignedTo && !sessions.some(s => s.id === t.assignedTo && s.alive)).map(t => t.assignedTo!));
      for (const id of dead) this.release(nodeId, id, team.id);
    }
  }
}

/** What an orchestrator and its workers are told about squads, the Main Brain and the sorting board. */
function squadNote(role: AgentRole, language: 'it' | 'en', squad?: string): string {
  if (language === 'en') return role === 'orchestrator'
    ? `${squad ? `You lead squad ${squad}. ` : ''}Other squads may work in this node, separate from yours: you see and lead only your own. If the board lists a Main Brain (field brain), message it by its code when you close a milestone, when you are blocked and when the objective is reached, and follow its priorities. With manual delivery, what operators report goes to the user first: you see the status (delivered, being sorted) but not the content until the user forwards it; still hand out the next task at once and do not ask operators to repeat it.\n`
    : 'If a message you send comes back held (being sorted by the user), do not repeat it: the user decides whether to forward it to the orchestrator.\n';
  return role === 'orchestrator'
    ? `${squad ? `Guidi la squadra ${squad}. ` : ''}Nel nodo possono lavorare altre squadre, separate dalla tua: vedi e guidi solo la tua. Se la bacheca indica un Main Brain (campo brain), scrivigli al suo codice quando chiudi una tappa, quando sei bloccato e quando l’obiettivo è raggiunto, e segui le sue priorità. Con la consegna manuale ciò che riportano gli operatori passa prima dall’utente: vedi lo stato (consegnato, in smistamento) ma non il contenuto finché l’utente non lo inoltra; assegna comunque subito il prossimo incarico e non chiedere agli operatori di ripeterlo.\n`
    : 'Se un tuo messaggio torna con held (in smistamento dall’utente), non ripeterlo: l’utente decide se inoltrarlo all’orchestratore.\n';
}

/** The Main Brain coordinates the node's squads through their orchestrators: it proposes squads, it never edits files. */
export function brainInstructions(base: string, id: string, token: string, task?: string, language: 'it' | 'en' = 'it', persistentTerminals = false, localTools = false, code?: string): string {
  const auth = localTools ? '$VB_TEAM_TOKEN' : token;
  if (language === 'en') return `Main Brain of the node: role brain${code ? `, code ${code}` : ''}, session ${id}. API ${base}. Authentication: Authorization: Bearer ${auth} (also in this terminal's VB_TEAM_TOKEN environment variable).
${localTools ? 'Prefer the visual_brain MCP tool team_request: {operation:"read"} reads your board; the others are message, propose, summary and state, with fields in data. Identity and authentication are automatic. ' : ''}If an HTTP request fails inside the command sandbox, request narrowly scoped permission for this local API and retry; do not disable protections globally.
You coordinate the squads (swarms) of this node: each has an orchestrator (ORC1, ORC2…) and its operators. You do not edit files and do not work on tasks: you decide what is needed, ask the orchestrators for it and keep track of progress.
GET ${base}?session=${id} returns the squads (objective, summary, orchestrator, open and finished tasks, items waiting for the user), your new messages and your proposals.
POST ${base}/messages {from,to:"ORC2",text} writes to a squad's orchestrator (at most 1200 characters). You talk only to orchestrators, never to operators.
To start a new swarm POST ${base}/proposals {from,name,objective,members:[{agent:"claude"|"codex"|"hermes"|"agy",role:"orchestrator",model?,effort?},{agent,role:"operator"}…]}: it is a proposal, the user starts it with one click or discards it; you get a message when it starts. One orchestrator per proposal, at most 8 agents. Propose a squad only for an objective distinct from those already running; otherwise ask the existing orchestrator.
PATCH ${base} {from,summary} keeps your summary (at most 4000 characters): state of the swarms, decisions, next steps.
POST ${base}/state {from,state:"working"|"idle"|"blocked"}. Mark idle when you wait: messages from orchestrators are announced to you. Do not poll. ${persistentTerminals ? 'Board and terminals survive an app restart.' : 'The board persists; processes end when the app quits.'} Respond in English unless instructed otherwise.
The state of the swarms lives on their boards and in your summary: do not copy it into auto memory, CLAUDE.md or AGENTS.md.
${task ? 'Objective: ' + task + '\nIn your first turn read the board, then split the objective into proposals for new squads or requests to the running orchestrators.' : 'No initial objective: read the board, write the summary, then mark idle and wait.'}`;
  return `Main Brain del nodo: ruolo brain${code ? `, codice ${code}` : ''}, sessione ${id}. API ${base}. Autenticazione: header Authorization: Bearer ${auth} (anche nella variabile d’ambiente VB_TEAM_TOKEN di questo terminale).
${localTools ? 'Usa prima lo strumento MCP team_request del server visual_brain: {operation:"read"} legge la tua bacheca; le altre operazioni sono message, propose, summary e state, con i campi in data. Identità e autenticazione sono automatiche. ' : ''}Se una richiesta HTTP fallisce nella sandbox dei comandi, chiedi il permesso mirato per questa API locale e riprova; non disattivare le protezioni globali.
Coordini le squadre (sciami) di questo nodo: ognuna ha un orchestratore (ORC1, ORC2…) e i suoi operatori. Non modifichi file e non lavori sugli incarichi: decidi cosa serve, lo chiedi agli orchestratori e tieni traccia dell’avanzamento.
GET ${base}?session=${id} restituisce le squadre (obiettivo, riepilogo, orchestratore, incarichi aperti e chiusi, elementi in attesa dell’utente), i tuoi messaggi nuovi e le tue proposte.
POST ${base}/messages {from,to:"ORC2",text} scrive all’orchestratore di una squadra (massimo 1200 caratteri). Parli solo con gli orchestratori, mai con gli operatori.
Per avviare un nuovo sciame POST ${base}/proposals {from,name,objective,members:[{agent:"claude"|"codex"|"hermes"|"agy",role:"orchestrator",model?,effort?},{agent,role:"operator"}…]}: è una proposta, l’utente la avvia con un clic o la scarta; ricevi un messaggio quando parte. Un solo orchestratore per proposta, al massimo 8 agenti. Proponi una squadra solo per un obiettivo diverso da quelli già in corso; altrimenti chiedi all’orchestratore esistente.
PATCH ${base} {from,summary} mantiene il tuo riepilogo (massimo 4000 caratteri): stato degli sciami, decisioni, prossimi passi.
POST ${base}/state {from,state:"working"|"idle"|"blocked"}. Segna idle quando aspetti: i messaggi degli orchestratori ti vengono annunciati. Niente polling. ${persistentTerminals ? 'Bacheca e terminali sopravvivono al riavvio dell’app.' : 'La bacheca persiste; i processi terminano alla chiusura dell’app.'}
Lo stato degli sciami sta nelle loro bacheche e nel tuo riepilogo: non copiarlo nella memoria automatica, in CLAUDE.md o in AGENTS.md.
${task ? 'Obiettivo: ' + task + '\nNel primo turno leggi la bacheca, poi dividi l’obiettivo in proposte di nuove squadre o in richieste agli orchestratori già attivi.' : 'Nessun obiettivo iniziale: leggi la bacheca, scrivi il riepilogo, poi segna idle e attendi.'}`;
}

export function teamInstructions(base: string, id: string, token: string, role: AgentRole, task?: string, language: 'it' | 'en' = 'it', persistentTerminals = false, localTools = false, code?: string, squad?: string): string {
  if (role === 'brain') return brainInstructions(base, id, token, task, language, persistentTerminals, localTools, code);
  if (language === 'en') return `Node team: role ${role}${code ? `, code ${code}` : ''}, session ${id}. API ${base}. Authentication: Authorization: Bearer ${localTools ? '$VB_TEAM_TOKEN' : token} (also in this terminal's VB_TEAM_TOKEN environment variable).
${localTools ? 'Prefer the visual_brain MCP tool team_request for team communication: {operation:"read"} reads this board; other operations are state, message, create_task, update_task, summary and spawn, with fields in data and taskId for an update. The tool supplies your identity and authentication. No shell network access is needed. ' : ''}For HTTP requests, a connection failure inside the command sandbox is not proof the app is down: request narrowly scoped permission to access this local API and retry outside that sandbox before reporting it unreachable. Do not disable sandbox protections globally or change host/port at random.
Use JSON requests with from="${id}". Start with GET ${base}?session=${id}; this returns relevant tasks and messages, not other terminals' transcripts.
${code ? 'Every session has a code (ORC1, OP3, REV1…) listed on the board next to its id. The user sees only the codes: use them whenever you name a session in messages, the summary and your answers. to and assignedTo accept either the id or the code.\n' : ''}${squadNote(role, 'en', squad)}${role === 'orchestrator' ? 'You keep every operator busy: this is your main job. In your first turn read the board and the objective, split it into at least one independent task per operator (explicit scope, no overlapping files) and assign them all at once with POST ' + base + '/tasks and assignedTo, before doing anything yourself. When an operator reports done or blocked, hand it the next task immediately; queue extra tasks unassigned so idle operators can claim them. If real work runs out, assign verification, tests, review or documentation of what is already done instead of leaving a session idle. Prefer small tasks (minutes, not hours) with a stated result to report. Keep the shared summary current and reuse existing sessions. Only spawn more operators when autoSpawn permits it, via POST ' + base + '/spawn {from,agent,model?,effort?,role:"operator"|"reviewer",task}. Choose models and effort for the task without assuming availability. Do not duplicate operators’ work. Visual Brain tells you when a session has been idle for a while: act on it at once.' : 'Work only on your assignment, claim it before editing and respect its scope. Do not explore the whole project. When you finish, report the result with paths and checks, then read the board: if there is an unassigned pending task that fits, claim it and continue; otherwise mark idle so the orchestrator can assign you more. Reviewers report findings without edits unless explicitly assigned. Do not launch other agents.'}
POST ${base}/tasks {from,title,scope:["path"],assignedTo?:"session"}; PATCH ${base}/tasks/:id {from,status:"working"|"done"|"blocked",result?:"summary and paths"}. Each working task has one assignee; do not take over others’ tasks.
POST ${base}/messages {from,to:"session"|null,text:"maximum 1200 characters"}. A null recipient means the team. Cross-node recipients must be listed in peers: the user creates these channels in Workspace. Send concise results with paths and checks, not full logs. Only the orchestrator may PATCH ${base} {from,summary:"decisions and status, maximum 4000 characters"}.
POST ${base}/state {from,state:"working"|"idle"|"blocked"}. Mark working before starting; read your inbox at handoffs and before stopping. Mark idle only when finished: queued messages notify idle terminals. Do not poll or call an LLM while waiting. ${persistentTerminals ? "The board and terminal processes survive an app restart. The API is unavailable while the app is closed; retry after it reopens, without recreating the session." : "The board persists; processes end when the app quits."} Respond in English unless instructed otherwise.
Squad state (tasks, results, messages, summary) lives on this board: do not copy it into auto memory, CLAUDE.md or AGENTS.md.
${task ? 'Initial task: ' + task : 'No initial task: read the board; if nothing is assigned, mark idle and wait: you will be notified when work arrives.'}`;
  return `Squadra del nodo: ruolo ${role}${code ? `, codice ${code}` : ''}, sessione ${id}. API ${base}. Autenticazione: header Authorization: Bearer ${localTools ? '$VB_TEAM_TOKEN' : token} (anche nella variabile d’ambiente VB_TEAM_TOKEN di questo terminale).
${localTools ? 'Per comunicare usa prima lo strumento MCP team_request del server visual_brain: {operation:"read"} legge questa bacheca; le altre operazioni sono state, message, create_task, update_task, summary e spawn, con i campi in data e taskId per aggiornare un incarico. Identità e autenticazione sono automatiche; non serve accesso alla rete dalla shell. ' : ''}Se usi HTTP e la connessione fallisce nella sandbox dei comandi, non significa che l’app sia spenta: richiedi il permesso mirato di accedere a questa API locale e riprova fuori da quella sandbox prima di dichiararla irraggiungibile. Non disattivare le protezioni globali e non cambiare host o porta a caso.
Usa richieste JSON con from="${id}". Inizia leggendo GET ${base}?session=${id}; ricevi solo incarichi e messaggi utili, non i transcript degli altri terminali.
${code ? 'Ogni sessione ha un codice (ORC1, OP3, REV1…), elencato nella bacheca accanto al suo id. L’utente vede solo i codici: usali ogni volta che nomini una sessione nei messaggi, nel riepilogo e nelle risposte. to e assignedTo accettano sia l’id sia il codice.\n' : ''}${squadNote(role, 'it', squad)}${role === 'orchestrator' ? 'Il tuo compito principale è non lasciare nessun operatore fermo. Nel primo turno leggi bacheca e obiettivo, dividilo in almeno un incarico indipendente per operatore (scope esplicito, nessun file in comune) e assegnali tutti subito con POST ' + base + '/tasks e assignedTo, prima di lavorare tu. Quando un operatore segnala completato o bloccato, dagli subito l’incarico successivo; metti in coda incarichi non assegnati perché gli operatori liberi possano rivendicarli. Se il lavoro vero finisce, affida verifica, test, revisione o documentazione di quanto già fatto invece di lasciare una sessione ferma. Preferisci incarichi piccoli (minuti, non ore) con un risultato da riportare. Mantieni il riepilogo condiviso e riusa le sessioni esistenti; avvia altri agenti solo se la policy autoSpawn lo consente, tramite POST ' + base + '/spawn {from,agent,model?,effort?,role:"operator"|"reviewer",task}. Scegli modello ed effort in base alla difficoltà, senza presumere disponibilità. Non duplicare il lavoro degli operatori. Visual Brain ti avvisa quando una sessione resta ferma: agisci subito.' : 'Esegui solo l’incarico ricevuto. Non esplorare l’intero progetto. Prima di modificare file, rivendica il tuo incarico; rispetta lo scope. Quando finisci, riporta risultato con percorsi e verifiche, poi rileggi la bacheca: se c’è un incarico non assegnato adatto a te rivendicalo e prosegui; altrimenti segna idle così l’orchestratore può darti altro lavoro. Se sei revisore, verifica e riferisci, senza modificare file salvo incarico esplicito. Non avviare altri agenti.'}
POST ${base}/tasks {from,title,scope:["percorso"],assignedTo?:"sessione"}; PATCH ${base}/tasks/:id {from,status:"working"|"done"|"blocked",result?:"sintesi e percorsi"}. Un incarico working ha un solo assegnatario: non lavorare su incarichi altrui.
POST ${base}/messages {from,to:"sessione"|null,text:"massimo 1200 caratteri"}. to=null comunica alla squadra. Per un altro nodo usa solo una sessione elencata in peers: i canali espliciti vengono creati dall’utente in Operativa. Risultati brevi con percorsi e verifiche; niente log completi. PATCH ${base} {from,summary:"decisioni e stato, massimo 4000 caratteri"} riservato all’orchestratore.
POST ${base}/state {from,state:"working"|"idle"|"blocked"}. Segna working prima del lavoro; rileggi la casella ai passaggi di incarico e prima di fermarti. Segna idle solo alla fine: i messaggi in coda vengono notificati al terminale quando è idle. Non usare cicli di polling o chiamate LLM in attesa. ${persistentTerminals ? "Bacheca e processi dei terminali sopravvivono al riavvio dell’app. L’API non è disponibile mentre l’app è chiusa: riprova dopo la riapertura, senza ricreare la sessione." : "Il riepilogo e la bacheca persistono; i processi terminano al riavvio."}
Lo stato della squadra (incarichi, risultati, messaggi, riepilogo) sta in questa bacheca: non copiarlo nella memoria automatica, in CLAUDE.md o in AGENTS.md.
${task ? 'Incarico iniziale: ' + task : 'Nessun incarico iniziale: controlla la bacheca; se non c’è lavoro assegnato segna idle e attendi: sarai avvisato quando arriva.'}`;
}
