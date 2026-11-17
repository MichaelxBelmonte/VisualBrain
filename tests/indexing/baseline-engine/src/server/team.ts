// A small durable board per node, shared by independent CLI providers.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentRole, TeamBoard, TeamLink, TeamMessage, TeamTask, TerminalInfo } from '../shared/types.ts';

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

export class Teams {
  private readonly boards = new Map<number, TeamBoard>();
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
  canTalk(a: TerminalInfo, b: TerminalInfo): boolean {
    if (a.nodeId === b.nodeId) return true;
    return this.getLinks().some(l => {
      const matches = (src: TerminalInfo, dst: TerminalInfo) => src.nodeId === l.srcNodeId && dst.nodeId === l.dstNodeId && (l.srcSessionId ? src.id === l.srcSessionId : src.role === 'orchestrator') && (l.dstSessionId ? dst.id === l.dstSessionId : dst.role === 'orchestrator');
      return matches(a, b) || matches(b, a);
    });
  }
  get(nodeId: number): TeamBoard {
    if (!Number.isSafeInteger(nodeId) || nodeId <= 0) throw new TeamError(400, 'Nodo non valido');
    if (!this.boards.has(nodeId)) {
      let saved: TeamBoard = { summary: '', messages: [], tasks: [], policy: { autoSpawn: false, maxAgents: 4 } };
      try { saved = JSON.parse(readFileSync(join(this.dir, `${nodeId}.json`), 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      this.boards.set(nodeId, saved);
    }
    return this.boards.get(nodeId)!;
  }
  private save(nodeId: number, board: TeamBoard): void {
    mkdirSync(this.dir, { recursive: true });
    const file = join(this.dir, `${nodeId}.json`);
    const temp = `${file}.tmp`;
    writeFileSync(temp, JSON.stringify(board), { mode: 0o600 });
    renameSync(temp, file);
    this.boards.set(nodeId, board);
  }
  update(nodeId: number, body: { summary?: unknown; autoSpawn?: unknown; maxAgents?: unknown }): TeamBoard {
    const b = structuredClone(this.get(nodeId));
    if (body.summary !== undefined) b.summary = boundedText(body.summary, 4000);
    if (body.autoSpawn !== undefined) {
      if (typeof body.autoSpawn !== 'boolean') throw new TeamError(400, 'autoSpawn non valido');
      b.policy.autoSpawn = body.autoSpawn;
    }
    if (body.maxAgents !== undefined) {
      if (!Number.isInteger(body.maxAgents) || Number(body.maxAgents) < 1 || Number(body.maxAgents) > 8) throw new TeamError(400, 'Limite agenti: da 1 a 8');
      b.policy.maxAgents = Number(body.maxAgents);
    }
    this.save(nodeId, b); return b;
  }
  message(nodeId: number, from: string, to: string | null, text: unknown): TeamMessage {
    const b = structuredClone(this.get(nodeId));
    const m: TeamMessage = { id: (b.messages.at(-1)?.id ?? 0) + 1, from, to, text: boundedText(text, 1200, true), createdAt: Date.now() };
    b.messages.push(m); b.messages = b.messages.slice(-500);
    this.save(nodeId, b); return m;
  }
  createTask(nodeId: number, from: string, body: { title?: unknown; scope?: unknown; assignedTo?: string | null }): TeamTask {
    const b = structuredClone(this.get(nodeId));
    if (b.tasks.filter(t => t.status !== 'done').length >= 100) throw new TeamError(409, 'Troppi incarichi aperti');
    if (body.scope !== undefined && (!Array.isArray(body.scope) || body.scope.length > 16 || body.scope.some(p => typeof p !== 'string' || p.length > 500))) throw new TeamError(400, 'scope: massimo 16 percorsi');
    const task: TeamTask = { id: randomUUID().slice(0, 8), title: boundedText(body.title, 1000, true), scope: body.scope as string[] ?? [], assignedTo: body.assignedTo ?? null, status: 'pending', result: '', createdBy: from, updatedAt: Date.now() };
    b.tasks.push(task);
    b.tasks = [...b.tasks.filter(t => t.status === 'done').slice(-100), ...b.tasks.filter(t => t.status !== 'done')];
    this.save(nodeId, b); return task;
  }
  changeTask(nodeId: number, taskId: string, actor: string, role: AgentRole | undefined, body: { status?: unknown; result?: unknown; assignedTo?: string | null }): TeamTask {
    const b = structuredClone(this.get(nodeId));
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
    task.updatedAt = Date.now(); this.save(nodeId, b); return task;
  }
  release(nodeId: number, sessionId: string): void {
    const b = structuredClone(this.get(nodeId));
    let changed = false;
    for (const t of b.tasks) if (t.assignedTo === sessionId && t.status !== 'done') {
      t.assignedTo = null; t.status = 'pending'; t.updatedAt = Date.now(); changed = true;
    }
    if (changed) this.save(nodeId, b);
  }
  recover(nodeId: number, sessions: TerminalInfo[]): void {
    for (const id of new Set(this.get(nodeId).tasks.filter(t => t.status !== 'done' && t.assignedTo && !sessions.some(s => s.id === t.assignedTo && s.alive)).map(t => t.assignedTo!))) this.release(nodeId, id);
  }
}

export function teamInstructions(base: string, id: string, token: string, role: AgentRole, task?: string, language: 'it' | 'en' = 'it'): string {
  if (language === 'en') return `Node team: role ${role}, session ${id}. API ${base}. Authentication: Authorization: Bearer ${token}.
Use JSON requests with from="${id}". Start with GET ${base}?session=${id}; this returns relevant tasks and messages, not other terminals' transcripts.
${role === 'orchestrator' ? 'Split work into independent tasks with explicit scopes. Assign focused tasks and reviews, keep the shared summary current and reuse existing sessions. Only spawn more operators when autoSpawn permits it, via POST ' + base + '/spawn {from,agent,model?,effort?,role:"operator"|"reviewer",task}. Choose models and effort for the task without assuming availability. Do not duplicate operators’ work.' : 'Work only on your assignment, claim it before editing and respect its scope. Do not explore the whole project. Reviewers report findings without edits unless explicitly assigned. Do not launch other agents.'}
POST ${base}/tasks {from,title,scope:["path"],assignedTo?:"session"}; PATCH ${base}/tasks/:id {from,status:"working"|"done"|"blocked",result?:"summary and paths"}. Each working task has one assignee; do not take over others’ tasks.
POST ${base}/messages {from,to:"session"|null,text:"maximum 1200 characters"}. A null recipient means the team. Cross-node recipients must be listed in peers: the user creates these channels in Workspace. Send concise results with paths and checks, not full logs. Only the orchestrator may PATCH ${base} {from,summary:"decisions and status, maximum 4000 characters"}.
POST ${base}/state {from,state:"working"|"idle"|"blocked"}. Mark working before starting; read your inbox at handoffs and before stopping. Mark idle only when finished: queued messages notify idle terminals. Do not poll or call an LLM while waiting. The board persists; processes end when the app quits. Respond in English unless instructed otherwise.
${task ? 'Initial task: ' + task : 'No initial task: read the board and wait if nothing is assigned.'}`;
  return `Squadra del nodo: ruolo ${role}, sessione ${id}. API ${base}. Autenticazione: header Authorization: Bearer ${token}.
Usa richieste JSON con from="${id}". Inizia leggendo GET ${base}?session=${id}; ricevi solo incarichi e messaggi utili, non i transcript degli altri terminali.
${role === 'orchestrator' ? 'Dividi il lavoro in incarichi indipendenti con scope esplicito. Assegna compiti mirati agli operatori e revisioni al revisore. Mantieni il riepilogo condiviso. Riusa le sessioni esistenti; avvia altri agenti solo se la policy autoSpawn lo consente, tramite POST ' + base + '/spawn {from,agent,model?,effort?,role:"operator"|"reviewer",task}. Scegli modello ed effort in base alla difficoltà, senza presumere disponibilità. Non duplicare il lavoro degli operatori.' : 'Esegui solo l’incarico ricevuto. Non esplorare l’intero progetto. Prima di modificare file, rivendica il tuo incarico; rispetta lo scope. Se sei revisore, verifica e riferisci, senza modificare file salvo incarico esplicito. Non avviare altri agenti.'}
POST ${base}/tasks {from,title,scope:["percorso"],assignedTo?:"sessione"}; PATCH ${base}/tasks/:id {from,status:"working"|"done"|"blocked",result?:"sintesi e percorsi"}. Un incarico working ha un solo assegnatario: non lavorare su incarichi altrui.
POST ${base}/messages {from,to:"sessione"|null,text:"massimo 1200 caratteri"}. to=null comunica alla squadra. Per un altro nodo usa solo una sessione elencata in peers: i canali espliciti vengono creati dall’utente in Operativa. Risultati brevi con percorsi e verifiche; niente log completi. PATCH ${base} {from,summary:"decisioni e stato, massimo 4000 caratteri"} riservato all’orchestratore.
POST ${base}/state {from,state:"working"|"idle"|"blocked"}. Segna working prima del lavoro; rileggi la casella ai passaggi di incarico e prima di fermarti. Segna idle solo alla fine: i messaggi in coda vengono notificati al terminale quando è idle. Non usare cicli di polling o chiamate LLM in attesa. Il riepilogo e la bacheca persistono; i processi terminano al riavvio.
${task ? 'Incarico iniziale: ' + task : 'Nessun incarico iniziale: controlla la bacheca e attendi istruzioni se non c’è lavoro assegnato.'}`;
}
