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
/** One line of «Qualità»: an agent·model·role, or a squad. */
export interface StatsQualityRow {
  key: string; label: string; agent: string | null; model: string | null; role: string | null;
  created: number; completed: number; reopened: number; blocked: number;
  /** From creation to «fatto», for the tasks closed in the period. */
  cycle: StatsLatency;
  /** Tokens of the line's sessions in the period divided by the tasks they closed; null without closed tasks or records. */
  tokensPerTask: number | null;
}
/**
 * How the squads' work went, from the boards' transitions recorded by Visual Brain (from 0.2.63 on), and how long the
 * agents waited for the person. Counts only: no titles, results or prompts.
 */
export interface StatsQuality {
  /** First recorded transition; null: none yet. */
  since: number | null;
  created: number; completed: number;
  /** Closed tasks put back to «da fare» or «in corso»: work to redo. */
  reopened: number;
  blocked: number; reassigned: number;
  cycle: StatsLatency;
  blockedMs: number;
  /** Permission dialogs and questions in the terminals: how many, and how long until the person answered. */
  waits: { n: number; open: number; permission: number; input: number; response: StatsLatency;
    /** Answers by time to answer: under 1 min, 1–5 min, 5–15 min, 15–60 min, over an hour. */
    histogram: number[] };
  workers: StatsQualityRow[];
  teams: StatsQualityRow[];
  /** Local API calls that failed, by route (ids replaced), most frequent first. */
  failures: { route: string; status: number; n: number }[];
}
/**
 * The period in intervals (5 min for an hour, 1 h for a day, 6 h for a week), aligned to the local clock; the first
 * interval starts with the period, so the sums match the totals.
 */
export interface StatsTimeline {
  /** Interval edges: interval i is [edges[i], edges[i+1]). */
  edges: number[];
  /** Tokens (read + written, cache apart) per account; the main account of a CLI has key «agent:». */
  tokens: { key: string; agent: string; label: string | null; values: number[] }[];
  requests: number[];
  completed: number[];
  reopened: number[];
}
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
  quality: StatsQuality;
  timeline: StatsTimeline;
  unattributedHttp: number;
}
