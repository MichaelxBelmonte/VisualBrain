// LLM providers. Only the prompt text built by analyze.ts leaves the machine; the provider never reads files itself.
import { spawn } from 'node:child_process';
import type { Config } from '../config.ts';

export interface LlmResult {
  output: unknown;
  raw: string;
  costUsd?: number;
  ms: number;
}

export interface LlmProvider {
  name: string;
  model: string;
  complete(prompt: string, schema: object, timeoutMs: number): Promise<LlmResult>;
}

/** Claude Code in headless mode, tools disabled: the model answers only from the prompt. */
export function claudeCli(cfg: Config): LlmProvider {
  return {
    name: 'claude-cli',
    model: cfg.llm.model,
    complete(prompt, schema, timeoutMs) {
      return new Promise((resolve, reject) => {
        const t0 = Date.now();
        const args = ['-p', '--no-session-persistence', '--output-format', 'json', '--json-schema', JSON.stringify(schema), '--tools', '',
          '--model', cfg.llm.model, '--effort', cfg.llm.effort];
        const env = { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH ?? ''}` };
        const p = spawn(cfg.agents.claude, args, { env, cwd: process.env.HOME, stdio: ['pipe', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        const timer = setTimeout(() => { p.kill('SIGTERM'); reject(new Error(`timeout dopo ${Math.round(timeoutMs / 1000)} s`)); }, timeoutMs);
        p.stdout.on('data', (d) => { out += d; });
        p.stderr.on('data', (d) => { err += d; });
        p.on('error', (e) => { clearTimeout(timer); reject(e); });
        p.on('close', (code) => {
          clearTimeout(timer);
          let parsed: Record<string, unknown> | null = null;
          try { parsed = JSON.parse(out); } catch { /* not JSON */ }
          if (!parsed) return reject(new Error(`claude non ha risposto in JSON (codice ${code}): ${(err || out).slice(0, 300)}`));
          if (parsed.is_error) return reject(new Error(`claude: ${String(parsed.result).slice(0, 300)}`));
          const output = parsed.structured_output ?? tryParse(String(parsed.result ?? ''));
          if (!output) return reject(new Error(`risposta senza JSON strutturato: ${String(parsed.result).slice(0, 300)}`));
          resolve({ output, raw: out, costUsd: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : undefined, ms: Date.now() - t0 });
        });
        p.stdin.end(prompt);
      });
    },
  };
}

function tryParse(s: string): unknown {
  try { return JSON.parse(s); } catch { /* ignore */ }
  const m = /\{[\s\S]*\}/.exec(s);
  if (m) { try { return JSON.parse(m[0]); } catch { /* ignore */ } }
  return null;
}

/** Anthropic Messages API with a forced tool call, so the answer is always the schema. */
export function anthropicApi(cfg: Config): LlmProvider {
  const key = process.env[cfg.llm.apiKeyEnv];
  return {
    name: 'anthropic-api',
    model: cfg.llm.model,
    async complete(prompt, schema, timeoutMs) {
      if (!key) throw new Error(`manca la variabile ${cfg.llm.apiKeyEnv}`);
      const t0 = Date.now();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST', signal: ctrl.signal,
          headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: cfg.llm.model, max_tokens: 16000,
            tools: [{ name: 'emit', description: 'Restituisce il risultato dell\'analisi nel formato richiesto.', input_schema: schema }],
            tool_choice: { type: 'tool', name: 'emit' },
            messages: [{ role: 'user', content: prompt }],
          }),
        });
        const raw = await r.text();
        if (!r.ok) throw new Error(`API ${r.status}: ${raw.slice(0, 300)}`);
        const j = JSON.parse(raw);
        const tool = (j.content as { type: string; input?: unknown }[]).find((c) => c.type === 'tool_use');
        if (!tool) throw new Error('nessun tool_use nella risposta');
        return { output: tool.input, raw, ms: Date.now() - t0 };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function makeProvider(cfg: Config): LlmProvider | null {
  switch (cfg.llm.provider) {
    case 'claude-cli': return claudeCli(cfg);
    case 'anthropic-api': return anthropicApi(cfg);
    default: return null;
  }
}
