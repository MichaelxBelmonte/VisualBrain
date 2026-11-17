// Launching Claude Code, Codex CLI or Hermes from a node, with the node's context as the first prompt.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.ts';
import type { AgentName, GraphEdge, LaunchOptions, NodeDetail } from '../shared/types.ts';
import type { Terminals, Term } from './terminals.ts';
import { teamInstructions } from './team.ts';

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function edgeLine(e: GraphEdge, detail: NodeDetail, english: boolean): string {
  const other = e.src === detail.id ? e.dst : e.src;
  const n = detail.neighbors.find((x) => x.id === other);
  const dir = e.src === detail.id ? '→' : '←';
  const ev = e.evidence[0];
  const where = ev?.line ? ` (${english ? 'line' : 'riga'} ${ev.line})` : '';
  const note = ev?.note ? ` — ${ev.note}` : ev?.snippet ? ` — «${ev.snippet.slice(0, 80)}»` : '';
  return `- ${dir} ${e.kind}${e.verified ? '' : (english ? ' (inferred, ' : ' (inferita, ') + Math.round(e.confidence * 100) + '%)'}: ${n ? n.path : '#' + other}${where}${note}`;
}

/** The context handed to the agent as its first prompt. */
export function buildContext(detail: NodeDetail, cfg: Config, userPrompt?: string): string {
  const english = cfg.language === 'en';
  const label = (it: string, en: string) => english ? en : it;
  const lines: string[] = [];
  lines.push(label('Sei stato lanciato dal Visual Brain (grafo locale dei file) sul nodo:', 'You were launched from Visual Brain (local file graph) on this node:'));
  lines.push(`- ${label('percorso', 'path')}: ${detail.path}`);
  lines.push(`- ${label('tipo', 'type')}: ${detail.kind} / ${detail.cls}${detail.lang ? ' / ' + detail.lang : ''}, ${fmtBytes(detail.bytes)}${detail.kind === 'dir' ? `, ${detail.files} file` : ''}`);
  if (detail.project) {
    lines.push(`- ${label('progetto', 'project')}: ${detail.project.label ?? detail.project.name} (${detail.project.type}${detail.project.technologies.length ? '; ' + detail.project.technologies.slice(0, 12).join(', ') : ''})`);
    if (detail.project.description) lines.push(`  ${detail.project.description}`);
  }
  if (detail.summary) lines.push(`- ${label('descrizione', 'description')}: ${detail.summary}`);
  if (detail.area) lines.push(`- ${label('area', 'area')}: ${detail.area.name}`);
  const edges = detail.edges.filter((e) => !e.hidden).slice(0, 25);
  if (edges.length) {
    lines.push('', `${label('Relazioni nel grafo', 'Graph connections')} (${edges.length}/${detail.edges.length}):`);
    for (const e of edges) lines.push(edgeLine(e, detail, english));
  }
  if (detail.children.length) {
    lines.push('', label('Contenuto principale (per importanza):', 'Main contents (by importance):'));
    for (const c of detail.children.slice(0, 15)) lines.push(`- ${c.name}${c.kind === 'dir' ? '/' : ''} (${c.cls}${c.kind === 'dir' ? ', ' + c.files + ' file' : ''})`);
  }
  if (detail.notes.length) {
    lines.push('', label('Note:', 'Notes:'));
    for (const n of detail.notes.slice(0, 10)) lines.push(`- [${n.origin}] ${n.text}`);
  }
  lines.push('', english ? `You can enrich the graph through the local API http://${cfg.host}:${cfg.port}: POST /api/edges with srcPath, dstPath, kind (semantic|manual|uses), confidence, evidence {note}, origin "agent:<name>"; POST /api/nodes/${detail.id}/notes with {text, origin}.` : `Puoi arricchire il grafo con l'API locale http://${cfg.host}:${cfg.port} (vedi docs/API.md del Visual Brain): POST /api/edges con srcPath, dstPath, kind (semantic|manual|uses), confidence, evidence {note}, origin "agent:<nome>"; POST /api/nodes/${detail.id}/notes con {text, origin}.`);
  lines.push('', userPrompt?.trim() ? `${label('Richiesta', 'Request')}: ${userPrompt.trim()}` : label('Richiesta: leggi il contesto, guarda il nodo e proponi in poche righe cosa conviene fare. Poi aspetta istruzioni.', 'Request: read the context, inspect the node and briefly suggest the next step. Then wait for instructions.'));
  if (english) lines.push('Respond in English unless the user requests another language.');
  return lines.join('\n');
}

export function agentCommand(agent: AgentName, cfg: Config, prompt: string, cwd: string, options: LaunchOptions = {}): { file: string; args: string[] } {
  const model = options.model ? ['--model', options.model] : [];
  switch (agent) {
    case 'claude':
      return { file: cfg.agents.claude, args: [...model, ...(options.effort ? ['--effort', options.effort] : []), '--', prompt] };
    case 'codex':
      return { file: cfg.agents.codex, args: ['-C', cwd, ...model, ...(options.effort ? ['-c', `model_reasoning_effort=${JSON.stringify(options.effort)}`] : []), '--', prompt] };
    case 'hermes':
      return { file: cfg.agents.hermes, args: ['chat', '--in', cwd, ...model, ...(options.effort ? ['--reasoning', options.effort] : []), '-q', prompt] };
  }
}

export function workingDir(detail: NodeDetail, projectPath: string | null): string {
  if (detail.kind === 'dir') return detail.path;
  if (detail.kind === 'external') return process.env.HOME ?? '/';
  return projectPath ?? dirname(detail.path);
}

export function launchEmbedded(terms: Terminals, agent: AgentName, cfg: Config, detail: NodeDetail, cwd: string, prompt: string, size?: { cols: number; rows: number }, options: LaunchOptions & { seenMessage?: number } = {}): Term {
  const id = randomUUID().slice(0, 8);
  const teamToken = randomUUID();
  if (options.role) prompt += '\n\n' + teamInstructions(`http://${cfg.host}:${cfg.port}/api/work/${detail.id}`, id, teamToken, options.role, options.task, cfg.language);
  let { file, args } = agentCommand(agent, cfg, prompt, cwd, options);
  if (agent === 'codex') {
    // Match Terminal.app: load the user's interactive login shell before resolving
    // Codex. The native app's PATH can otherwise select an older installation.
    // Pass the command and prompt as positional arguments, never as shell code.
    args = ['-lic', 'exec "$@"', 'visual-brain-codex', file, ...args];
    file = process.env.SHELL || '/bin/zsh';
  }
  return terms.spawn({ ...options, id, teamToken, agent, cwd, file, args, title: `${agent} · ${detail.name}`, nodeId: detail.id, cols: size?.cols, rows: size?.rows });
}

/** Opens Terminal.app with the agent running in `cwd`; the prompt is read from a file to avoid quoting issues. */
export function launchExternal(agent: AgentName, cfg: Config, detail: NodeDetail, cwd: string, prompt: string, options: LaunchOptions = {}): void {
  const dir = join(cfg.dataDir, 'context');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${detail.id}-${Date.now()}.md`);
  writeFileSync(file, prompt);
  const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const command = agentCommand(agent, cfg, '', cwd, options);
  command.args.pop(); // The last argument is always the prompt, supplied from the file.
  const cmd = `cd ${sq(cwd)} && ${[sq(command.file), ...command.args.map(sq)].join(' ')} "$(cat ${sq(file)})"`;
  const script = `tell application "Terminal"\n activate\n do script ${JSON.stringify(cmd)}\nend tell`;
  const p = spawn('osascript', ['-e', script], { stdio: 'ignore', detached: true });
  p.unref();
}

export function openWith(path: string, app: 'finder' | 'default' | 'editor'): void {
  const args = app === 'finder' ? ['-R', path] : app === 'editor' ? ['-t', path] : [path];
  const p = spawn('open', args, { stdio: 'ignore', detached: true });
  p.unref();
}

let agentsCache: { claude: boolean; codex: boolean; hermes: boolean } | null = null;

export function hasAgents(cfg: Config): { claude: boolean; codex: boolean; hermes: boolean } {
  if (agentsCache) return agentsCache;
  const home = homedir();
  const path = [`${home}/.local/bin`, `${home}/.local/node/bin`, '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH ?? ''].join(':');
  const which = (bin: string): boolean => {
    try {
      return spawnSync('/usr/bin/which', [bin], { env: { ...process.env, PATH: path }, encoding: 'utf8' }).status === 0;
    } catch {
      return false;
    }
  };
  agentsCache = { claude: which(cfg.agents.claude), codex: which(cfg.agents.codex), hermes: which(cfg.agents.hermes) };
  return agentsCache;
}
