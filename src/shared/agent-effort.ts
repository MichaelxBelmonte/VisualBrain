import type { AgentName, ModelChoice } from './types.ts';

export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Custom IDs and Auto must expose the provider's levels too. The CLI resolves aliases. */
export function effortChoices(agent: AgentName | 'shell', model: string, catalog: ModelChoice[] = []): string[] {
  if (agent === 'shell') return [];
  if (agent === 'claude') {
    if (/(?:opus|sonnet)-4[.-]6(?:\[1m\])?$/.test(model)) return CLAUDE_EFFORTS.filter(e => e !== 'xhigh');
    if (/(?:haiku-4|sonnet-4[.-][05]|opus-4[.-][015])/.test(model)) return [];
    return CLAUDE_EFFORTS;
  }
  return catalog.find(m => m.id === model)?.efforts ?? ['low', 'medium', 'high'];
}
