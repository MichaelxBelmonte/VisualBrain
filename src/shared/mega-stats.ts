/** All timestamps are Unix milliseconds. A null measurement has no usable sample. */
export interface StatsLatency { n: number; p50Ms: number | null; p95Ms: number | null }
export interface StatsMeasures {
  turns: number | null;
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
export interface StatsSession {
  id: string; label: string; agent: string; role: string | null;
  nodeId: number; projectId: number; teamKey: string | null;
  alive: boolean; state: string | null; attention: string | null;
  since: number | null; turnSource: string | null;
  metrics: StatsMeasures;
}
export interface CoordinationRequest {
  cadenceMinutes: number; mode: 'suggest' | 'assign'; provider: 'balanced' | 'codex' | 'claude';
  status: 'pending'; updatedAt: number;
}
export interface StatsTeam {
  key: string; id: string; name: string; nodeId: number; projectId: number;
  recipient: string | null; autoSpawn: boolean; requested: CoordinationRequest | null;
}
export interface MegaStatsReport {
  from: number; to: number; updatedAt: number; observedMs: number; coverageStart: number;
  projects: { id: number; name: string }[];
  teams: StatsTeam[];
  sessions: StatsSession[];
  totals: StatsMeasures;
  unattributedHttp: number;
}
