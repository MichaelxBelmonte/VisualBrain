// Types shared by the server and the browser UI. Keep this file free of Node or DOM imports.

export type NodeKind = 'file' | 'dir' | 'symlink' | 'external' | 'area';

/** File classes, then folder roles. */
export type NodeClass =
  | 'code' | 'doc' | 'data' | 'sheet' | 'image' | 'video' | 'audio' | 'archive' | 'binary'
  | 'config' | 'notebook' | 'log' | 'font' | 'secret' | 'other'
  | 'project' | 'folder' | 'dump' | 'vendor' | 'media';

export type EdgeKind =
  | 'imports'    // resolved code import (verified)
  | 'links'      // markdown / html link to a local file (verified)
  | 'refpath'    // a path written in the file points to a node (verified)
  | 'mention'    // a file name mentioned in text, resolved to a unique node (verified, weaker)
  | 'symlink'    // symbolic link -> target (verified)
  | 'duplicate'  // identical content hash (verified)
  | 'derived'    // snapshot, build, worktree or partial copy of the target (verified, not identical)
  | 'shared_id'  // the same rare identifier appears in both files (verified, weak)
  | 'similar'    // text similarity (inferred, score)
  | 'semantic'   // LLM-inferred relationship (inferred, confidence + reason)
  | 'manual'     // created by the user
  | 'uses'       // generic verified dependency (runs, reads, writes, cwd, schedules...), from imported inventories
  | 'policy'     // a rule that names the target (allowed dir, denied dir, trusted dir)
  | 'external';  // reference to a path outside the indexed roots

export interface Evidence {
  file?: string;     // path of the file holding the evidence
  line?: number;
  snippet?: string;
  token?: string;    // shared identifier
  score?: number;    // similarity score
  note?: string;     // free text (LLM reason, user note)
  terms?: string[];  // shared terms for 'similar'
}

export interface GraphNode {
  id: number;
  path: string;
  name: string;
  kind: NodeKind;
  cls: NodeClass | string;
  lang?: string | null;
  size: number;        // bytes of the file itself
  bytes: number;       // bytes of the subtree (dirs) or size (files)
  files: number;       // files in the subtree (dirs)
  depth: number;
  mtime: number;       // ms since epoch
  importance: number;  // 0..1
  indeg: number;
  outdeg: number;
  projectId?: number | null;
  areaId?: number | null;
  aggregate: boolean;  // vendor / build dir indexed only as a total
  parentId: number | null;
  childCount: number;
  summary?: string | null;
  tags?: string[];
}

export interface GraphEdge {
  id?: number;         // present for a single stored edge, absent for a rolled-up one
  src: number;
  dst: number;
  kind: EdgeKind;
  verified: boolean;
  confidence: number;  // 0..1
  count: number;       // underlying edges in a rolled-up edge
  evidence: Evidence[];
  origin: string;      // scan | llm | user | agent:<name> | import:<file>
  hidden?: boolean;
}

export interface Area {
  id: number;
  name: string;
  description?: string | null;
  origin: string;
  confidence?: number | null;
  nodeIds: number[];   // project / folder nodes assigned to the area
}

export interface Stats {
  nodes: number;
  files: number;
  dirs: number;
  edges: number;
  verifiedEdges: number;
  inferredEdges: number;
  projects: number;
  areas: number;
  lastScan?: number | null;
  scanMs?: number | null;
  llmRuns: number;
  roots: string[];
}

export type GraphView = 'projects' | 'folders';

export interface GraphPayload {
  nodes: GraphNode[];
  edges: GraphEdge[];
  areas: Area[];
  expanded: number[];
  stats: Stats;
  view: GraphView;
  /** Nodes drawn as boxes of their area (project view): every other visible node sits inside its parent box. */
  topLevel: number[];
  projects: ProjectInfo[];
}

export interface ProjectInfo {
  id: number;
  nodeId: number;
  name: string;
  label?: string | null;
  type: string;
  remote?: string | null;
  technologies: string[];
  description?: string | null;
  areaId?: number | null;
  /** live | archive | copy | data, from the imported inventory; null when unknown. */
  status?: string | null;
  /** Nearest project up the tree, when the project sits inside another one. */
  parentProjectId?: number | null;
  /** A folder that only groups other projects (e.g. the folders of the reorganised Desktop): transparent in the project view. */
  container?: boolean;
  path?: string;
}

export interface Note {
  id: number;
  nodeId: number;
  kind: string;        // note | suggestion
  text: string;
  origin: string;
  createdAt: number;
}

export interface NodeDetail extends GraphNode {
  linkTarget?: string | null;
  hash?: string | null;
  lines?: number | null;
  complexity?: number | null;
  pagerank?: number | null;
  project?: ProjectInfo | null;
  area?: Area | null;
  edges: GraphEdge[];       // single stored edges touching this node (not rolled up)
  neighbors: GraphNode[];   // nodes referenced by `edges`
  children: GraphNode[];    // first page of children, by importance
  notes: Note[];
  ancestors: number[];      // from the parent up to the root
}

export interface LlmRun {
  id: number;
  provider: string;
  model: string;
  consent: 'metadata' | 'excerpts';
  startedAt: number;
  finishedAt?: number | null;
  bytesSent: number;
  nodesSent: number;
  status: 'running' | 'done' | 'error';
  error?: string | null;
  summary?: string | null;
}

export interface Preferences {
  roots: string[]; language: 'it' | 'en'; setupComplete: boolean; home: string; desktopMode: boolean;
}

export interface StatusPayload {
  stats: Stats;
  config: {
    roots: string[];
    language?: 'it' | 'en';
    setupComplete?: boolean;
    /** Name of this brain, from the config file (several brains: Mac, VM). */
    label?: string;
    llm: { provider: string; model: string; effort: string; consent: 'metadata' | 'excerpts' };
    agents: { claude: boolean; codex: boolean; hermes: boolean; agy: boolean };
  };
  indexing: boolean;
  analyzing: boolean;
  terminals: TerminalInfo[];
}

export interface TerminalInfo {
  id: string;
  agent: 'claude' | 'codex' | 'hermes' | 'agy' | 'shell';
  cwd: string;
  title: string;
  /** Name chosen by the user for this session; replaces the generated agent/model label. */
  name?: string;
  /** Stable code of a team session inside its node (ORC1, OP3, REV1): the UI and the agents name the session with it. */
  code?: string;
  alive: boolean;
  nodeId?: number | null;
  createdAt: number;
  model?: string;
  effort?: string;
  role?: AgentRole;
  parentId?: string;
  task?: string;
  workState?: 'working' | 'idle' | 'blocked';
  /** When the session last became idle (ms): lets the team spot operators left without work. */
  idleSince?: number;
  /** Latest terminal notice while waiting. Repeated idle reports can precede the client acknowledgement. */
  noticeSentAt?: number;
  /** The primary consumer explicitly confirmed the whole announced batch. */
  noticeConfirmed?: boolean;
  /** Who reported the work state: the agent, a lifecycle hook, or the server at launch. */
  stateSource?: 'agent' | 'hook' | 'server';
  /** When workState last changed (ms). */
  stateAt?: number;
  /** Observed by the server, whatever the agent reports: last meaningful terminal output and last key typed by a person (ms). */
  lastOutputAt?: number;
  lastInputAt?: number;
  /** The agent waits for the person: a permission prompt or a question. Cleared by the next input or turn. */
  attention?: 'permission' | 'input';
  /** Conversation of the agent CLI (Claude session id, Codex session id): "Riprendi" reopens it after the process ended. */
  resumeId?: string;
  /** Git branch of the session's own worktree, when the node gives each operator one. */
  branch?: string;
  /** Extra account of the agent CLI the session runs with (an AgentAccount id); absent: the CLI's main account. */
  account?: string;
  /** Squad of the node the session belongs to ("1" for the node's first squad, "brain" for the node's Main Brain). */
  teamId?: string;
  /** Read from the agent CLI's own records each time the sessions are listed, never stored: the model of the last turn
   *  and the model the CLI confirmed for the next one (absent when it is the same), as the person reads them. */
  modelNow?: string;
  modelNext?: string;
  /** The entry of the model selector the session is on now (Claude: family; Codex: model id). */
  modelChoice?: string;
  /** A change of model asked from the interface: queued until the session is free, running, held by a question of the
   *  CLI that the person must answer (`confirm`, with the CLI's own words as message), then its outcome for a while. */
  modelChange?: ModelChange;
  /** Listed, never stored: a role change the person asked for, waiting for the end of the agent's turn, or why it failed. */
  roleChange?: RoleChange;
  /** Listed, never stored: the agent CLI a person started by hand inside this plain terminal. */
  inner?: 'claude' | 'codex';
}
/** A role (or squad, or none) asked for a session; `role: null` takes it out of its squad. */
export interface RoleChange { role: 'orchestrator' | 'operator' | 'reviewer' | null; teamId?: string; state: 'waiting' | 'failed'; message?: string; at: number }
export interface ModelChange { state: 'waiting' | 'running' | 'confirm' | 'done' | 'failed'; target: string; label: string; message?: string; at: number }
export interface ModelSwitchChoice { id: string; label: string }

export type AgentName = 'claude' | 'codex' | 'hermes' | 'agy';
/** The agents whose CLI can run under more than one account at the same time. */
export type AccountAgent = 'claude' | 'codex';
/** An extra account of an agent CLI: a folder of its own (CLAUDE_CONFIG_DIR / CODEX_HOME), never its credentials. */
export interface AgentAccount { id: string; agent: AccountAgent; label: string; home: string; share?: AccountShare }
/** What an extra account borrows from the main one (Avanzate): its memory (Claude Code) and its skills, plugins and instructions. */
export interface AccountShare { memory?: boolean; tools?: boolean }
/** An extra account as Impostazioni → Agenti shows it: what the CLI answers about its sign-in in that folder. */
export interface AgentAccountStatus extends AgentAccount { signedIn: boolean | null; email: string | null; sessions: number }
/** brain: the node's Main Brain, above the orchestrators of its squads (one per node, it edits no files). */
export type AgentRole = 'orchestrator' | 'operator' | 'reviewer' | 'brain';
export interface ModelChoice { id: string; label: string; efforts: string[] }
export interface LaunchOptions {
  model?: string;
  effort?: string;
  /** Extra account of the agent CLI (AgentAccount id); absent: the main account. */
  account?: string;
  role?: AgentRole;
  parentId?: string;
  task?: string;
  /** Squad of the node to join: an existing id, "new" for a new squad. Absent: the squad already at work, otherwise the first. */
  teamId?: string;
  /** Name of a new squad. */
  teamName?: string;
}
export interface TeamMessage { id: number; from: string; to: string | null; text: string; createdAt: number }
export interface TeamLink { id: string; srcNodeId: number; dstNodeId: number; srcSessionId: string | null; dstSessionId: string | null }
export interface TeamTask {
  routing?: import('./quota-routing.ts').TaskRoute;
  id: string; title: string; scope: string[]; assignedTo: string | null;
  status: 'pending' | 'working' | 'done' | 'blocked'; result: string; createdBy: string; updatedAt: number;
  /** The result waits on the sorting board (manual delivery): the orchestrator sees the status, not the result, until it is forwarded. */
  held?: boolean;
  /** Display code for a blocked task even after its owner's terminal has been removed. */
  blockedOwnerCode?: string;
  /** Written by the person or the orchestrator; agents may ignore them. Absent in boards from before 0.2.65. */
  description?: string;
  /** Absent means normal. */
  priority?: 'high' | 'low';
  labels?: string[];
  /** Position chosen by the person inside its column (smaller first); absent: priority, then age. */
  order?: number;
  createdAt?: number;
  /** A column of the squad's own (policy.columns) inside the task's status; ignored when the status no longer matches. */
  column?: string;
}
/** A column the person adds to a squad board. It rests on one of the statuses, so agents and Stats see no difference. */
export interface BoardColumn { id: string; name: string; status: 'pending' | 'working' | 'done' }
/** What reaches the sorting board instead of the orchestrator, classified by rule (no model call). */
export type InboxKind = 'result' | 'blocked' | 'question' | 'note';
export type InboxColumn = 'new' | 'ready' | 'forwarded' | 'archived';
export interface InboxItem {
  id: number; kind: InboxKind; column: InboxColumn; from: string; text: string; createdAt: number; updatedAt: number;
  taskId?: string; taskTitle?: string; note?: string; forwardedTo?: string; forwardedAt?: number;
}
/** A squad the Main Brain asks the person to start: nothing runs until the person launches it. */
export interface SwarmProposal {
  id: string; name: string; objective: string; members: SquadRequest['members']; createdBy: string; createdAt: number;
  status: 'pending' | 'launched' | 'discarded'; teamId?: string;
}
/** A squad inside a node: its own board, orchestrator and (from the second squad at work) its own Git worktree. */
export interface TeamInfo {
  id: string; name: string; color: number; createdAt: number; objective?: string; archived?: boolean;
  worktree?: { path: string; cwd: string; branch: string };
}
/** One squad as the board lists it: who works in it and what waits for the person. */
export interface TeamSummary extends TeamInfo {
  summary: string; delivery: 'auto' | 'manual';
  sessions: number; alive: number; orchestrator: string | null; maxAgents: number;
  tasks: Record<TeamTask['status'], number>; inbox: number;
  /** Recent task references on the authenticated Main Brain board. Read handoffs=all for the full retained list. */
  handoffs?: BrainTaskHandoff[];
  handoffsTotal?: number;
}
export interface BrainTaskHandoff {
  taskId: string; title: string; assignedTo: string | null; status: TeamTask['status']; updatedAt: number;
  withheld: boolean; result: string | null; branch: string | null; sha: string | null;
  branchSource: 'report' | 'session' | 'team' | null;
}
/**
 * Claude Code auto memory for a squad's sessions. leaders: the orchestrator (and the Main Brain) use the project's memory,
 * operators and reviewers run without it. all: every session uses the project's memory. squad: the orchestrator uses a
 * memory of this squad only, in the app profile; operators and reviewers run without. off: no session uses it.
 */
export type ClaudeMemory = 'leaders' | 'all' | 'squad' | 'off';

export interface TeamBoard {
  savedSquads?: SavedSquad[];
  summary: string;
  messages: TeamMessage[];
  tasks: TeamTask[];
  /** worktrees: each operator and reviewer works in its own Git worktree and branch (off by default).
   *  delivery: manual sends what operators report to the sorting board; the person forwards it to the orchestrator.
   *  memory: which Claude sessions use Claude Code's auto memory (default "leaders"). */
  policy: { autoSpawn: boolean; maxAgents: number; worktrees?: boolean; delivery?: 'auto' | 'manual'; memory?: ClaudeMemory; columns?: BoardColumn[] };
  /** Session codes of this node: the last number given per role and the code of each session id. Never reused. */
  codes?: { next: Partial<Record<AgentRole, number>>; ids: Record<string, string> };
  /** Sorting board: operator reports held for the person (manual delivery). */
  inbox?: InboxItem[];
  /** Main Brain board only: squads it proposes to start. */
  proposals?: SwarmProposal[];
  /** Node file only: the node's squads, the squad of each session, the next squad number. */
  teams?: TeamInfo[];
  members?: Record<string, string>;
  nextTeam?: number;
}
export interface TeamView extends TeamBoard {
  sessions: TerminalInfo[]; peers: TerminalInfo[]; links: TeamLink[];
  /** The squad this board belongs to ("brain" for the Main Brain), the node's squads and its Main Brain session, if any. */
  team?: TeamInfo; teamList?: TeamSummary[]; brain?: TerminalInfo | null;
}

export interface SquadRequest {
  id: number;
  savedId?: string;
  prompt?: string;
  /** Absolute paths of attached files: listed in the objective, never read by Visual Brain. */
  files?: string[];
  members: Array<{ agent: AgentName; model?: string; effort?: string; account?: string; role?: AgentRole; name?: string }>;
  /** An existing squad of the node, or "new"; name of a new squad; the Main Brain proposal being launched. */
  teamId?: string; teamName?: string; proposalId?: string;
}

/** Configuration only; conversations, running processes and credentials are never copied. */
export interface SavedSquad {
  id: string; savedAt: number; nodePath: string; name: string;
  members: SquadRequest['members'];
  policy: TeamBoard['policy'];
}

export interface LaunchRequest extends LaunchOptions {
  id: number;
  agent: AgentName | 'shell';
  mode: 'embedded' | 'external';
  prompt?: string;
  files?: string[];
}

/** Messages on /ws/events */
export type EventMessage =
  | { type: 'stats:changed' }
  | { type: 'index:progress'; phase: string; done: number; total?: number; message?: string }
  | { type: 'index:map'; stats: Stats }
  | { type: 'index:done'; stats: Stats; ms: number }
  | { type: 'index:error'; error: string }
  | { type: 'analyze:progress'; runId: number; message: string }
  | { type: 'analyze:done'; runId: number; summary: string }
  | { type: 'analyze:error'; runId: number; error: string }
  | { type: 'graph:changed'; reason: string }
  | { type: 'term:exit'; id: string; code: number }
  /** A squad's board was saved (tasks, messages, settings): the open board reads it again at once. */
  | { type: 'team:changed'; nodeId: number; team: string }
  | { type: 'reminders:changed' };

/** Personal reminders, independent of team assignments and terminal lifetimes. */
export interface NodeReminder {
  id: string; nodeId: number; nodePath: string; nodeName: string;
  title: string; status: 'pending' | 'working' | 'done'; notes: string; folderId?: string | null;
  createdAt: number; updatedAt: number;
}

/** Spatial task folders belong to one node; links do not create agent communication channels. */
export interface ReminderFolder {
  id: string; nodeId: number; nodePath: string; name: string;
  x: number; y: number; isInbox: number; createdAt: number; updatedAt: number;
}
export interface ReminderFolderLink { id: string; src: string; dst: string; createdAt: number }
export interface ReminderBoard { folders: ReminderFolder[]; links: ReminderFolderLink[] }

// Git tab: a node's repository (read-only), the sessions on its branches and GitHub through gh.
export interface GitBranch { name: string; ref: string; hash: string; date: number; subject: string; author: string; upstream?: string; ahead?: number; behind?: number; gone?: boolean; current?: boolean }

export interface GitWorktree { path: string; branch?: string; hash: string; main: boolean; locked: boolean; prunable: boolean }

export interface GitCommit { hash: string; parents: string[]; author: string; date: number; subject: string; refs: string[] }

export interface GitOverview {
  top: string; branch: string | null; head: string | null; upstream?: string; ahead: number; behind: number;
  changes: { staged: number; unstaged: number; untracked: number; conflicts: number };
  remotes: { name: string; url: string; web?: string }[];
  github?: { owner: string; repo: string; web: string };
  local: GitBranch[]; remote: GitBranch[]; worktrees: GitWorktree[]; commits: GitCommit[];
}

export interface GitCommitDetail { hash: string; parents: string[]; author: string; email: string; date: number; message: string; files: { path: string; added: number | null; deleted: number | null }[]; moreFiles: number }

export type GithubState =
  | { state: 'ok'; pulls: GithubPull[]; runs: GithubRun[]; at: number }
  | { state: 'missing' | 'signed-out' | 'error'; message: string };

export interface GithubPull { number: number; title: string; branch: string; base: string; author: string; draft: boolean; updatedAt: string; url: string; review: string; checks: 'success' | 'failure' | 'pending' | 'none' }

export interface GithubRun { id: number; title: string; branch: string; workflow: string; event: string; status: string; conclusion: string; createdAt: string; url: string }
export interface GitRepoView { repo: GitOverview | null; agents?: Record<string, { id: string; code?: string; name?: string; alive: boolean }> }
export type GitCommitFile = GitCommitDetail['files'][number] & { nodeId?: number };
/** Files of a repository for the Dev tab: repository-relative paths, and the state of the changed ones (M, A, D, R, U untracked, C conflict). */
export interface CodeTree { top: string; git?: boolean; branch: string | null; files: string[]; states: Record<string, string>; truncated: boolean }
export interface CodeFile { path: string; size: number; mtime: number; text?: string; binary?: boolean; tooLarge?: boolean; secret?: boolean }
export interface CodeSearchHit { path: string; line: number; text: string }
/** A repository the Dev tab can connect to: the folder of an indexed project that holds a Git checkout. */
export interface RepoChoice { nodeId: number; name: string; path: string }
export type GithubRepositories = { state: 'ok'; login: string; repos: Array<{ name: string; private: boolean }>; more: boolean }
  | { state: 'missing' | 'signed-out'; message: string };
