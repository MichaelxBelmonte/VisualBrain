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
  createTask(nodeId: number, from: string, body: { title?: unknown; scope?: unknown; assignedTo?: string | null; routing?: TeamTask['routing'] }, team = DEFAULT_TEAM): TeamTask {
    const b = structuredClone(this.get(nodeId, team));
    if (b.tasks.filter(t => t.status !== 'done').length >= 100) throw new TeamError(409, 'Troppi incarichi aperti');
    if (body.scope !== undefined && (!Array.isArray(body.scope) || body.scope.length > 16 || body.scope.some(p => typeof p !== 'string' || p.length > 500))) throw new TeamError(400, 'scope: massimo 16 percorsi');
    const task: TeamTask = { id: randomUUID().slice(0, 8), title: boundedText(body.title, 1000, true), scope: body.scope as string[] ?? [], assignedTo: body.assignedTo ?? null, status: 'pending', result: '', createdBy: from, updatedAt: Date.now() };
    if (body.routing) task.routing = body.routing;
    b.tasks.push(task);
    b.tasks = [...b.tasks.filter(t => t.status === 'done').slice(-100), ...b.tasks.filter(t => t.status !== 'done')];
    this.save(nodeId, b, team); return task;
  }
  /** Commit the owner, checkpoint and owner's notice in one board-file rename. No PTY is started or stopped. */
  routeTask(nodeId: number, team: string, taskId: string, assignedTo: string | null, routing: NonNullable<TeamTask['routing']>, message?: string): TeamTask {
    const b = structuredClone(this.get(nodeId,team));
    const task = b.tasks.find(t=>t.id===taskId);
    if (!task || task.status==='done') throw new TeamError(409,'Incarico non disponibile');
    task.assignedTo = assignedTo; task.routing = routing; task.updatedAt = routing.at;
    task.status = routing.handoff && !routing.handoff.to ? 'blocked' : 'pending';
    if (message && assignedTo) {
      b.messages.push({id:(b.messages.at(-1)?.id ?? 0)+1,from:'visual-brain',to:assignedTo,text:message,createdAt:routing.at});
      b.messages = b.messages.slice(-500);
    }
    this.save(nodeId,b,team); return task;
  }
  changeTask(nodeId: number, taskId: string, actor: string, role: AgentRole | undefined, body: { status?: unknown; result?: unknown; assignedTo?: string | null; held?: boolean }, team = DEFAULT_TEAM): TeamTask {
    const b = structuredClone(this.get(nodeId, team));
    const task = b.tasks.find(t => t.id === taskId);
    if (!task) throw new TeamError(404, 'Incarico non trovato');
    const prior = { ...task };
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
    if (task.status === prior.status && task.result === prior.result && task.assignedTo === prior.assignedTo && task.held === prior.held) return task;
    task.updatedAt = Date.now(); this.save(nodeId, b, team); return task;
  }
  release(nodeId: number, sessionId: string, team?: string): void {
    for (const id of team ? [team] : this.teams(nodeId).map(t => t.id)) {
      const b = structuredClone(this.get(nodeId, id));
      let changed = false;
      for (const t of b.tasks) if (t.assignedTo === sessionId && t.status !== 'done') {
        if (t.routing) {
          if (t.status !== 'blocked') {
            t.status = 'blocked'; t.routing.reason = 'Proprietario terminato: serve un checkpoint verificato'; t.updatedAt = Date.now(); changed = true;
          }
          continue;
        }
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

/** Role-specific startup card. The full HTTP reference ships beside the server in development and in packaged runtimes. */
export function teamInstructions(base: string, id: string, _token: string, role: AgentRole, task?: string, language: 'it' | 'en' = 'it', persistentTerminals = false, localTools = false, code?: string, squad?: string): string {
  const en = language === 'en';
  const words = (it: string, english: string) => en ? english : it;
  const lines = [
    words('ruolo ', 'role ') + role + (code ? words(', codice ', ', code ') + code : '') + words(', sessione ', ', session ') + id,
  ];
  if (role === 'brain') {
    lines[0] = words('Main Brain del nodo: ', 'Main Brain of the node: ') + lines[0];
    lines.push(words(
      'Coordina gli orchestratori del nodo. Leggi obiettivi e squadre, affida il lavoro agli orchestratori, aggiorna il riepilogo con decisioni e prossimi passi. Per un obiettivo distinto proponi una squadra (un orchestratore, massimo 8 agenti): la avvia l’utente. Non modificare file né assegnare incarichi agli operatori.',
      'Coordinate the node’s orchestrators. Read squad objectives, give work to orchestrators and record decisions and next steps in the summary. For a distinct objective propose a squad (one orchestrator, up to 8 agents); the user starts it. Do not edit files or assign tasks to operators.'));
  } else if (role === 'orchestrator') {
    if (squad) lines.push(words('Guidi la squadra ', 'You lead squad ') + squad + '.');
    lines.push(words(
      'Leggi l’obiettivo e assegna agli operatori della tua squadra incarichi indipendenti con scope e risultato atteso. Controlla le consegne, sblocca o riassegna, distribuisci il lavoro rimasto. Riusa le sessioni; spawn solo se autoSpawn e limite lo consentono. Aggiorna il riepilogo; riferisci tappe, blocchi e fine al Main Brain indicato nella bacheca.',
      'Read the objective and assign independent tasks to your squad’s operators with scope and expected result. Verify handoffs, unblock or reassign, then distribute remaining work. Reuse sessions; spawn only within autoSpawn and capacity limits. Update the summary and report milestones, blocks and completion to the Main Brain listed on the board.'));
  } else {
    lines.push(words(
      'Rispondi al tuo orchestratore. Rivendica l’incarico (working) prima di modificare file; resta nel suo scope. Se bloccato, indica cosa manca e chi può sbloccare. Alla consegna indica verifiche, percorsi, residuo e responsabile. Poi controlla la bacheca: rivendica un incarico libero adatto o segna idle. Non avviare altri agenti.',
      'Report to your orchestrator. Claim the task (working) before editing; stay within scope. If blocked, say what is missing and who can unblock it. At handoff give checks, paths, remaining work and its owner. Then check the board: claim suitable pending work or mark idle. Do not spawn agents.'));
    if (role === 'reviewer') lines.push(words('Revisione in sola lettura salvo incarico esplicito di modifica.', 'Review read-only unless explicitly assigned an edit.'));
  }
  if (task) lines.push(words('Obiettivo: ', 'Objective: ') + task);
  else lines.push(words('Nessun incarico iniziale: leggi la bacheca e attendi in idle se libera.', 'No initial task: read the board and mark idle if there is no work.'));
  if (localTools) lines.push(words('Prima azione: visual_brain.team_request {operation:"read"}. Usa lo schema dello strumento per le operazioni successive.', 'First action: visual_brain.team_request {operation:"read"}. Use its tool schema for subsequent operations.'));
  lines.push(`${localTools ? 'HTTP' : words('Prima azione', 'First action')}: GET ${base}?session=${id} · Authorization: Bearer $VB_TEAM_TOKEN · JSON from="${id}".`);
  if (!localTools) {
    const routes = role === 'brain' ? 'POST /proposals; PATCH / {summary}'
      : role === 'orchestrator' ? 'POST /tasks {title,scope,assignedTo}; PATCH /tasks/:id {status,result}; PATCH / {summary}; POST /spawn'
      : 'PATCH /tasks/:id {status:"working"|"blocked"|"done",result?}';
    lines.push(`${base} → POST /messages {to,text}; POST /state {state}; ${routes}.`);
  }
  if (code) lines.push(words('L’utente vede solo i codici: usali per nominare le sessioni.', 'The user sees only the codes: use them to name sessions.'));
  lines.push(words(
    'Segna working durante il lavoro, blocked se serve intervento, idle in attesa degli avvisi. Niente polling. Con held attendi l’inoltro dell’utente, senza ripetere il messaggio. Fuori squadra scrivi solo ai peers autorizzati. La bacheca contiene lo stato: non copiarlo nella memoria automatica, in CLAUDE.md o AGENTS.md.',
    'Mark working during work, blocked when intervention is needed and idle to wait for notices. Do not poll. If held, the user forwards it; do not resend. Outside the squad use only authorized peers. Keep board state out of auto memory, CLAUDE.md and AGENTS.md.'));
  lines.push(words('HTTP bloccato dalla sandbox: chiedi accesso mirato allo stesso endpoint, mantenendo le protezioni globali.', 'If the sandbox blocks HTTP, request access to this endpoint and retain global protections.'));
  lines.push(persistentTerminals ? words('App chiusa: bacheca e processi persistono. Riprova alla riapertura con la stessa sessione.', 'When the app closes, board and processes persist. Retry after reopening with the same session.') : words('Alla chiusura la bacheca persiste, i processi terminano.', 'On app quit the board persists and processes end.'));
  if (!localTools) lines.push(words('Dettagli HTTP: ', 'HTTP reference: ') + join(import.meta.dirname, '../../docs/API.md'));
  if (en) lines.push('Respond in English unless instructed otherwise.');
  return lines.join('\n');
}

export function brainInstructions(base: string, id: string, token: string, task?: string, language: 'it' | 'en' = 'it', persistentTerminals = false, localTools = false, code?: string): string {
  return teamInstructions(base, id, token, 'brain', task, language, persistentTerminals, localTools, code);
}
