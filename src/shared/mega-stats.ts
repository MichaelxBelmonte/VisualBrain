/** All timestamps are Unix milliseconds. A null measurement has no usable sample. */
export interface StatsLatency { n: number; p50Ms: number | null; p95Ms: number | null }
/** Technical measures of Visual Brain itself (Dettagli tecnici): local API traffic and hook-reported turns. */
export interface StatsMeasures {
  turns: number | null;
  unpairedTurns: number;
  turnsPerHour: number | null;
  turnLatency: StatsLatency;
  http: number;
  httpPerHour: number | null;
  httpLatency: StatsLatency;
  httpErrors: number;
  retries: number | null;
  completed: number;
  completedPerHour: number | null;
  waiting: number;
  blocked: number;
}
/**
 * What an agent did in the period, read from the CLI's own records (Claude Code transcript, Codex rollout), not estimated:
 * the person's requests and the tokens of the answers. Input excludes what was read back from the cache.
 */
export interface StatsUsage {
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Model of the last answer in the period. */
  model: string | null;
}
export interface StatsSession {
  id: string; label: string; agent: string; role: string | null;
  nodeId: number; projectId: number; teamKey: string | null;
  alive: boolean; state: string | null; attention: string | null;
  since: number | null; turnSource: string | null;
  /** Extra account of the CLI (Impostazioni → Agenti); null: the main account. */
  account: string | null; accountLabel: string | null;
  /** Time the session was open within the period. */
  activeMs: number;
  /** null: no record of the CLI found (a shell, another agent, a conversation not on this Mac). */
  usage: StatsUsage | null;
  metrics: StatsMeasures;
}
/** Tasks of a squad's board by status, as they are now. */
export interface StatsTasks { pending: number; working: number; blocked: number; done: number }
export interface StatsTeam {
  key: string; id: string; name: string; nodeId: number; projectId: number;
  recipient: string | null;
  blockedTasks: number;
  tasks: StatsTasks;
}
/** One line of «Per account»: the main account of a CLI or one of its extra accounts. */
export interface StatsAccount { key: string; agent: string; account: string | null; label: string | null; sessions: number; activeMs: number; usage: StatsUsage }
export interface MegaStatsReport {
  from: number; to: number; updatedAt: number; observedMs: number; coverageStart: number;
  projects: { id: number; name: string }[];
  teams: StatsTeam[];
  sessions: StatsSession[];
  totals: StatsMeasures;
  /** Sum of the sessions with a record. */
  usage: StatsUsage;
  /** Sessions whose CLI keeps records but none was found. */
  usageMissing: number;
  accounts: StatsAccount[];
  unattributedHttp: number;
}
