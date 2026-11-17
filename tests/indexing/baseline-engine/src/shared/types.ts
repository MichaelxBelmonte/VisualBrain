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
    llm: { provider: string; model: string; effort: string; consent: 'metadata' | 'excerpts' };
    agents: { claude: boolean; codex: boolean; hermes: boolean };
  };
  indexing: boolean;
  analyzing: boolean;
  terminals: TerminalInfo[];
}

export interface TerminalInfo {
  id: string;
  agent: 'claude' | 'codex' | 'hermes' | 'shell';
  cwd: string;
  title: string;
  alive: boolean;
  nodeId?: number | null;
  createdAt: number;
  model?: string;
  effort?: string;
  role?: AgentRole;
  parentId?: string;
  task?: string;
  workState?: 'working' | 'idle' | 'blocked';
}

export type AgentName = 'claude' | 'codex' | 'hermes';
export type AgentRole = 'orchestrator' | 'operator' | 'reviewer';
export interface ModelChoice { id: string; label: string; efforts: string[] }
export interface LaunchOptions {
  model?: string;
  effort?: string;
  role?: AgentRole;
  parentId?: string;
  task?: string;
}
export interface TeamMessage { id: number; from: string; to: string | null; text: string; createdAt: number }
export interface TeamLink { id: string; srcNodeId: number; dstNodeId: number; srcSessionId: string | null; dstSessionId: string | null }
export interface TeamTask {
  id: string; title: string; scope: string[]; assignedTo: string | null;
  status: 'pending' | 'working' | 'done' | 'blocked'; result: string; createdBy: string; updatedAt: number;
}
export interface TeamBoard {
  summary: string;
  messages: TeamMessage[];
  tasks: TeamTask[];
  policy: { autoSpawn: boolean; maxAgents: number };
}
export interface TeamView extends TeamBoard { sessions: TerminalInfo[]; peers: TerminalInfo[]; links: TeamLink[] }

export interface SquadRequest {
  id: number;
  prompt?: string;
  members: Array<{ agent: AgentName; model?: string; effort?: string }>;
}

export interface LaunchRequest extends LaunchOptions {
  id: number;
  agent: AgentName | 'shell';
  mode: 'embedded' | 'external';
  prompt?: string;
}

/** Messages on /ws/events */
export type EventMessage =
  | { type: 'index:progress'; phase: string; done: number; total?: number; message?: string }
  | { type: 'index:done'; stats: Stats; ms: number }
  | { type: 'index:error'; error: string }
  | { type: 'analyze:progress'; runId: number; message: string }
  | { type: 'analyze:done'; runId: number; summary: string }
  | { type: 'analyze:error'; runId: number; error: string }
  | { type: 'graph:changed'; reason: string }
  | { type: 'term:exit'; id: string; code: number };
