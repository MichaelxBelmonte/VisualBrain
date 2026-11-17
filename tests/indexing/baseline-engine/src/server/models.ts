// Local catalogs only: listing models never sends a paid inference request.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AgentName, ModelChoice } from '../shared/types.ts';

export function modelCatalog(): Record<AgentName, ModelChoice[]> {
  const codex: ModelChoice[] = [];
  try {
    const cache = JSON.parse(readFileSync(join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'models_cache.json'), 'utf8'));
    for (const m of cache.models ?? []) {
      if (m.visibility !== 'list' || typeof m.slug !== 'string') continue;
      codex.push({ id: m.slug, label: m.display_name || m.slug, efforts: (m.supported_reasoning_levels ?? []).map((x: { effort: string }) => x.effort) });
    }
  } catch { /* User may not have a model cache yet; custom model remains available. */ }
  return {
    codex,
    claude: ['opus', 'sonnet', 'haiku'].map(id => ({ id, label: id[0].toUpperCase() + id.slice(1), efforts: ['low', 'medium', 'high'] })),
    hermes: [], // Provider-specific IDs are entered by the user, not guessed.
  };
}
