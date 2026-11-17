import type { AgentName } from './types.ts';
export const quotaProviders: AgentName[] = ['codex','claude','hermes','agy'];
export interface RoutingRule {
  enabled: boolean; marginPct: number; allowUnknown: boolean;
  preference: 'balanced' | AgentName; providers: AgentName[];
  groups: Record<AgentName,string>;
}
export interface QuotaWindow { name: string; minutes: number | null; remainingPct: number; resetsAt: number | null }
export interface QuotaGroup {
  provider: AgentName; group: string; account: string | null; source: string | null;
  observedAt: number | null; freshUntil: number | null; blockedUntil: number | null;
  limited: boolean; windows: QuotaWindow[];
  status: 'available'|'limited'|'margin'|'unknown'|'stale';
}
export interface TaskRoute {
  role: 'operator'|'reviewer'|'orchestrator'; preferred: string | null;
  reason: string; at: number;
  handoff?: { id: string; from: string; verified: string; next: string; to: string | null };
}
export interface RoutingView {
  rule: RoutingRule; quotas: QuotaGroup[]; updatedAt: number;
  decisions: { taskId: string; assignee: string | null; reason: string; at: number }[];
}
