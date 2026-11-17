// Launching Claude Code, Codex CLI or Hermes from a node, with the node's context as the first prompt.
import { accessSync, closeSync, constants, mkdirSync, openSync, readdirSync, readSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.ts';
import type { AgentName, AgentRole, GraphEdge, LaunchOptions, NodeDetail, TerminalInfo } from '../shared/types.ts';
import type { TerminalStore } from './terminals.ts';
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
    case 'agy':
      // Antigravity CLI: `-i` runs the initial prompt interactively and keeps the session open (the prompt is the last argument).
      return { file: cfg.agents.agy, args: [...model, ...(options.effort ? ['--effort', options.effort] : []), '-i', prompt] };
  }
}

/**
 * Claude Code hooks reporting turn boundaries and prompts waiting for the person to Visual Brain (passed with --settings,
 * which adds to the user's own settings). Silent and bounded: curl gives up after 2 s and the hook always exits 0, so it
 * never blocks or fails the agent. Where to post and the token come from the PTY environment (hookEnv); the header reaches
 * curl on stdin (printf is a shell builtin), so the token never appears in a process list.
 */
export function claudeHookSettings(memoryDir?: string): string {
  const post = (fields: string) => ({ type: 'command', timeout: 5, command: `[ -n "$VB_STATE_URL" ] && printf 'Authorization: Bearer %s\\n' "$VB_TEAM_TOKEN" | curl -s -m 2 -o /dev/null -X POST -H 'Content-Type: application/json' -H @- --data '{"from":"'"$VB_SESSION_ID"'",${fields},"source":"hook"}' "$VB_STATE_URL" >/dev/null 2>&1; true` });
  const state = (s: string) => [{ hooks: [post(`"state":"${s}"`)] }];
  const attention = (matcher: string, kind: string) => ({ matcher, hooks: [post(`"attention":"${kind}"`)] });
  const quotaReporter = [process.execPath,fileURLToPath(new URL('./provider-quota.mjs',import.meta.url))]
    .map(s=>"'"+s.replaceAll("'","'\\''")+"'").join(' ');
  return JSON.stringify({
    // A squad with its own memory: Claude Code reads and writes auto memory there instead of the project's directory.
    ...(memoryDir ? { autoMemoryDirectory: memoryDir } : {}),
    hooks: {
      UserPromptSubmit: state('working'),
      Stop: state('idle'),
      StopFailure: [...state('idle'), {matcher:'rate_limit',hooks:[{type:'command',timeout:3,command:quotaReporter+' >/dev/null 2>&1; true'}]}],
      // notification_type; idle_prompt ("waiting for your input" after a finished turn) is not a question, so it is left out.
      Notification: [attention('permission_prompt|worker_permission_prompt', 'permission'), attention('elicitation_dialog|elicitation_url_dialog|agent_needs_input', 'input')],
    },
  });
}

export function hookEnv(cfg: Config, nodeId: number, id: string, teamToken: string): Record<string, string> {
  return { VB_STATE_URL: `http://${cfg.host}:${cfg.port}/api/work/${nodeId}/state`, VB_SESSION_ID: id, VB_TEAM_TOKEN: teamToken };
}

export function workingDir(detail: NodeDetail, projectPath: string | null): string {
  if (detail.kind === 'dir') return detail.path;
  if (detail.kind === 'external') return process.env.HOME ?? '/';
  return projectPath ?? dirname(detail.path);
}

export function launchEmbedded(terms: TerminalStore, agent: AgentName, cfg: Config, detail: NodeDetail, cwd: string, prompt: string, size?: { cols: number; rows: number }, { code, branch, squad, memory, ...options }: LaunchOptions & { seenMessage?: number; code?: string; branch?: string; squad?: string; memory?: string } = {}) {
  const id = randomUUID().slice(0, 8);
  const teamToken = randomUUID();
  if (options.role) prompt += '\n\n' + teamInstructions(`http://${cfg.host}:${cfg.port}/api/work/${detail.id}`, id, teamToken, options.role, options.task, cfg.language, terms.persistent === true, agent === 'codex' || agent === 'claude', code, squad);
  if (agent === 'codex' || agent === 'claude') prompt += '\n\n' + (cfg.language === 'en'
    ? 'To see which files are linked to this node (imports, paths, mentions, duplicates, similar files), use the brain_explore MCP tool of the visual_brain server before opening many files.'
    : 'Per vedere quali file sono collegati a questo nodo (import, percorsi, menzioni, duplicati, file simili) usa lo strumento MCP brain_explore del server visual_brain prima di aprire molti file.');
  const command = agentCommand(agent, cfg, prompt, cwd, options);
  // Claude takes its conversation id from us, so "Riprendi" finds it without guessing; Codex is found later from its own records.
  const resumeId = agent === 'claude' ? randomUUID() : undefined;
  if (resumeId) command.args.unshift('--session-id', resumeId);
  const { file, args } = embeddedCommand(agent, command, options.role, memory);
  return terms.spawn({ ...options, id, teamToken, resumeId, branch, agent, cwd, file, args, env: embeddedEnv(cfg, agent, detail.id, id, teamToken, options.role, memory), title: `${agent} · ${detail.name}`, nodeId: detail.id, cols: size?.cols, rows: size?.rows });
}

/** The command reopening an ended conversation, with the same model and effort; the optional prompt tells a team member to reread the board. */
export function resumeCommand(agent: 'claude' | 'codex', cfg: Config, cwd: string, resumeId: string, options: LaunchOptions = {}, prompt?: string): { file: string; args: string[] } {
  const model = options.model ? ['--model', options.model] : [];
  if (agent === 'claude') return { file: cfg.agents.claude, args: [...model, ...(options.effort ? ['--effort', options.effort] : []), '--resume', resumeId, ...(prompt ? ['--', prompt] : [])] };
  return { file: cfg.agents.codex, args: ['resume', '-C', cwd, ...model, ...(options.effort ? ['-c', `model_reasoning_effort=${JSON.stringify(options.effort)}`] : []), '--', resumeId, ...(prompt ? [prompt] : [])] };
}

/** An ended session started again under the same id: same team token, code, role and node, so the board still knows it. */
export function resumeEmbedded(terms: TerminalStore, cfg: Config, info: TerminalInfo, resumeId: string, teamToken: string, seenMessage: number, size?: { cols: number; rows: number }, memory?: string) {
  const agent = info.agent as 'claude' | 'codex';
  const options: LaunchOptions = { model: info.model, effort: info.effort, role: info.role, parentId: info.parentId, task: info.task };
  const prompt = info.role ? (cfg.language === 'en'
    ? 'Visual Brain restarted this session after its process ended. Your unfinished assignments went back to the queue: read the board, claim again what is still yours and continue.'
    : 'Visual Brain ha riavviato questa sessione dopo la chiusura del processo. I tuoi incarichi non completati sono tornati in coda: rileggi la bacheca, rivendica di nuovo quelli ancora tuoi e continua.') : undefined;
  const { file, args } = embeddedCommand(agent, resumeCommand(agent, cfg, info.cwd, resumeId, options, prompt), info.role, memory);
  return terms.spawn({ ...options, id: info.id, createdAt: info.createdAt, branch: info.branch, teamToken, seenMessage, resumeId, agent, cwd: info.cwd, file, args, env: embeddedEnv(cfg, agent, info.nodeId ?? null, info.id, teamToken, info.role, memory), title: info.title, nodeId: info.nodeId, cols: size?.cols, rows: size?.rows });
}

/** Claude and Codex get the visual_brain MCP bridge (and Claude the turn hooks of a team member); Codex starts from the login shell. */
function embeddedCommand(agent: AgentName, command: { file: string; args: string[] }, role?: AgentRole, memory?: string): { file: string; args: string[] } {
  let { file, args } = command;
  if (agent === 'codex' || agent === 'claude') {
    const bridge = fileURLToPath(new URL('./team-mcp.mjs', import.meta.url));
    const variables = ['VB_EXPLORE_URL', ...(role ? ['VB_STATE_URL', 'VB_SESSION_ID', 'VB_TEAM_TOKEN'] : [])];
    if (agent === 'codex') {
      // Overrides go after the subcommand, so `codex resume` reads them too.
      const at = args[0] === 'resume' ? 1 : 0;
      // Session-scoped hooks are additive to user/project hooks. Codex enforces its normal hook trust.
      const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
      const reporter = quote(process.execPath) + ' ' + quote(fileURLToPath(new URL('./turn-hook.mjs', import.meta.url)));
      const turnHooks = role ? ['SessionStart','UserPromptSubmit','Stop','Interrupt'].flatMap(event => [
        '-c', `hooks.${event}=[{hooks=[{type="command",command=${JSON.stringify(reporter)},timeout=3}]}]`,
      ]) : [];
      args = [...args.slice(0, at),
        ...turnHooks,
        '-c', `mcp_servers.visual_brain.command=${JSON.stringify(process.execPath)}`,
        '-c', `mcp_servers.visual_brain.args=${JSON.stringify([bridge])}`,
        '-c', `mcp_servers.visual_brain.env_vars=${JSON.stringify(variables)}`,
        ...args.slice(at)];
    } else args = [...(role ? ['--settings', claudeHookSettings(memory && memory !== 'off' ? memoryDirectory(memory) : undefined)] : []), '--mcp-config', JSON.stringify({ mcpServers: { visual_brain: {
      type: 'stdio', command: process.execPath, args: [bridge],
      env: Object.fromEntries(variables.map(name => [name, '${' + name + '}'])),
    } } }), ...args];
  }
  if (agent === 'codex') {
    // Match Terminal.app: load the user's interactive login shell before resolving
    // Codex. The native app's PATH can otherwise select an older installation.
    // Pass the command and prompt as positional arguments, never as shell code.
    args = ['-lic', 'exec "$@"', 'visual-brain-codex', file, ...args];
    file = process.env.SHELL || '/bin/zsh';
  }
  return { file, args };
}

function embeddedEnv(cfg: Config, agent: AgentName, nodeId: number | null, id: string, teamToken: string, role?: AgentRole, memory?: string): Record<string, string> | undefined {
  if (nodeId === null) return undefined;
  const explore = { VB_EXPLORE_URL: `http://${cfg.host}:${cfg.port}/api/explore?node=${nodeId}` };
  // Claude Code's documented switch for auto memory; Codex keeps its own setting (memories, off unless the person enabled it).
  const noMemory: Record<string, string> = agent === 'claude' && memory === 'off' ? { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } : {};
  return role ? { ...hookEnv(cfg, nodeId, id, teamToken), ...explore, ...noMemory } : agent === 'codex' || agent === 'claude' ? explore : undefined;
}

/** A squad's own memory directory, created before Claude Code starts in it. */
function memoryDirectory(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * The Codex conversation of a session, from Codex's own records (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, whose first
 * line names the id, cwd and start time): the earliest one started in the same folder from the session's launch on,
 * skipping conversations already bound to another session. Codex has no flag to choose the id at launch.
 */
export function findCodexSession(cwd: string, createdAt: number, claimed: Set<string>, home = process.env.CODEX_HOME || join(homedir(), '.codex')): string | undefined {
  const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };
  const folder = real(cwd);
  let best: { id: string; at: number } | undefined;
  for (const offset of [-1, 0, 1]) {
    const day = new Date(createdAt + offset * 86_400_000);
    const dir = join(home, 'sessions', String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
      const meta = firstLine(join(dir, name));
      const p = meta?.type === 'session_meta' ? meta.payload : undefined;
      const at = Date.parse(p?.timestamp);
      if (typeof p?.id !== 'string' || typeof p.cwd !== 'string' || claimed.has(p.id) || real(p.cwd) !== folder) continue;
      // A little slack before the launch for clock rounding; nothing that started long after it.
      if (!(at >= createdAt - 5_000 && at <= createdAt + 10 * 60_000)) continue;
      if (!best || at < best.at) best = { id: p.id, at };
    }
  }
  return best?.id;
}

function firstLine(file: string): any {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(256 * 1024);
    const text = buf.toString('utf8', 0, readSync(fd, buf, 0, buf.length, 0));
    const end = text.indexOf('\n');
    return JSON.parse(end < 0 ? text : text.slice(0, end));
  } catch { return undefined; } finally { if (fd !== undefined) closeSync(fd); }
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

let agentsCache: { claude: boolean; codex: boolean; hermes: boolean; agy: boolean } | null = null;

/** After an install or update from Impostazioni → Agenti: the next status probes again. */
export function forgetAgents(): void { agentsCache = null; }

export function hasAgents(cfg: Config): { claude: boolean; codex: boolean; hermes: boolean; agy: boolean } {
  if (agentsCache) return agentsCache;
  const home = homedir();
  const dirs = new Set([`${home}/.local/bin`, `${home}/.local/node/bin`, '/opt/homebrew/bin', '/usr/local/bin', ...(process.env.PATH ?? '').split(':')]);
  const which = (bin: string): boolean => {
    if (!bin || typeof bin !== 'string') return false;
    const candidates = bin.includes('/') ? [bin] : [...dirs].map(dir => `${dir || '.'}/${bin}`);
    return candidates.some(file => {
      try {
        if (!statSync(file, { throwIfNoEntry: false })?.isFile()) return false;
        accessSync(file, constants.X_OK);
        return true;
      } catch { return false; }
    });
  };
  agentsCache = { claude: which(cfg.agents.claude), codex: which(cfg.agents.codex), hermes: which(cfg.agents.hermes), agy: which(cfg.agents.agy) };
  return agentsCache;
}
