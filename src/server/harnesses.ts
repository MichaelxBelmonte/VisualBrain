import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { Config } from './config.ts';
import type { NodeDetail } from '../shared/types.ts';
import type { TerminalStore } from './terminals.ts';
import { boundedText, TeamError } from './team.ts';
import { bridgeNode, buildContext, workingDir } from './launch.ts';
import { HARNESS_SPECS, harnessExecutable, harnessInstalled, harnessInstallState, harnessOutdated, harnessVersion, installerAvailable, harnessEnvironment, type HarnessName } from './harness-installer.ts';

export type { HarnessName } from './harness-installer.ts';
export const HARNESS_LABELS = { deepseek: 'DeepSeek Harness', 'harness2-cli': 'Harness² CLI · community', 'harness2-google': 'Harness² · Google Research' };

export function harnessPaths(cfg: Config) {
  return Object.fromEntries(Object.keys(HARNESS_SPECS).map(id => [id, harnessExecutable(cfg, id as HarnessName)])) as Record<HarnessName, string>;
}

export function harnessCatalog(cfg: Config) {
  return (Object.keys(HARNESS_SPECS) as HarnessName[]).map(id => ({
    id, label: HARNESS_LABELS[id], installed: harnessInstalled(cfg, id),
    canInstall: installerAvailable(id), install: harnessInstallState(cfg, id),
    version: harnessVersion(cfg, id), latest: HARNESS_SPECS[id].version, outdated: harnessOutdated(cfg, id),
  }));
}

/** Harness tools are finite runs/laboratories, not interactive team members. */
export async function launchHarness(terms: TerminalStore, cfg: Config, detail: NodeDetail, projectPath: string | null, body: Record<string, unknown>) {
  const harness = body.harness as HarnessName;
  if (!Object.hasOwn(HARNESS_LABELS, harness)) throw new TeamError(400, 'Harness sconosciuto');
  const prompt = boundedText(body.prompt, 1000, harness !== 'harness2-google' && body.action !== 'setup');
  if (!['prepare', 'run', 'setup'].includes(String(body.action))) throw new TeamError(400, 'Azione harness non valida');
  if (body.action === 'setup' && harness !== 'deepseek') throw new TeamError(400, 'Configurazione disponibile solo per DeepSeek');
  if (harness === 'deepseek' && body.action === 'prepare') throw new TeamError(400, 'DeepSeek supporta esecuzione o configurazione');
  if (harness === 'harness2-google' && body.action !== 'prepare') throw new TeamError(400, 'Il laboratorio ufficiale supporta la demo locale');
  const maxCalls = body.maxCalls ?? 20;
  if (!Number.isInteger(maxCalls) || Number(maxCalls) < 1 || Number(maxCalls) > 200) throw new TeamError(400, 'Limite chiamate: da 1 a 200');
  const executable = harnessPaths(cfg)[harness];
  if (!harnessInstalled(cfg, harness)) throw new TeamError(409, 'Harness non installato. Usa Installa nel pannello Harness del nodo.');
  let cwd = workingDir(detail, projectPath);
  if (harness === 'harness2-cli') {
    const git = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 5000 });
    if (git.status !== 0) throw new TeamError(400, 'Harness² CLI richiede un progetto Git con almeno un commit');
    cwd = git.stdout.trim();
    if (spawnSync('git', ['-C', cwd, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8', timeout: 5000 }).status !== 0) throw new TeamError(400, 'Harness² CLI richiede almeno un commit');
  }
  const runId = `node-${detail.id}-${randomUUID().slice(0, 8)}`;
  const runDir = join(cfg.dataDir, 'harness-runs', runId);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const context = buildContext(detail, cfg, prompt);
  const contextFile = join(runDir, 'context.md');
  writeFileSync(contextFile, context, { mode: 0o600 });
  // Harness² executes in disposable worktrees: never instruct it to edit the original absolute path.
  const taskPrompt = [
    `Visual Brain node ${detail.id}: ${detail.name}. Target relative to the repository: ${relative(cwd, detail.path) || '.'}.`,
    'Work only in the checkout provided for this execution. Resolve paths relative to that checkout.',
    detail.summary || detail.project?.description || '',
    prompt,
  ].filter(Boolean).join('\n\n');
  const manifest = join(runDir, 'launch.json');
  writeFileSync(manifest, JSON.stringify({ harness, executable, cwd, prompt: context, taskPrompt, runId, runDir, contextFile, action: body.action, maxCalls, language: cfg.language }), { mode: 0o600 });
  const runner = join(dirname(fileURLToPath(import.meta.url)), 'harness-runner.mjs');
  const env = harnessEnvironment(cfg);
  // The runner lives as long as the terminal (it waits for the harness, then for the shell it leaves open): on the Node
  // kept in the profile, like the MCP bridge of a session, it does not keep a copy of the app in use across an update.
  // It imports only Node's own modules and reads only its manifest, which is in the profile.
  const term = await terms.spawn({ agent: 'shell', cwd, file: bridgeNode(cfg.dataDir), args: [runner, manifest], env: { PATH: env.PATH! }, nodeId: detail.id, title: `${HARNESS_LABELS[harness]} · ${detail.name}` });
  term.info.name = HARNESS_LABELS[harness];
  return { termId: term.info.id, info: term.info };
}
