// Launching Claude Code, Codex CLI or Hermes from a node, with the node's context as the first prompt.
import { accessSync, chmodSync, closeSync, constants, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.ts';
import type { AgentName, AgentRole, GraphEdge, LaunchOptions, NodeDetail, TerminalInfo } from '../shared/types.ts';
import type { TerminalStore } from './terminals.ts';
import { teamInstructions } from './team.ts';
import { accountById, accountEnv, agentHome } from './accounts.ts';
import { sharedClaudeSettings, syncShared } from './account-share.ts';
import { appBundleOf } from './updater.ts';

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

/**
 * What the session is called in the CLI's own lists: its code and its node, "OP3 · visual-brain"; the node alone for a
 * session outside a team. One line, at most 80 characters.
 */
export function sessionName(code: string | undefined, node: string): string {
  return [code, node].map(part => (part ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(' · ').slice(0, 80);
}

/**
 * `name` reaches Claude Code as --name: it shows in its /resume picker, prompt box and terminal title, and is saved with
 * the conversation, so a resumed session keeps it. Codex (0.171) names sessions only from inside its own interface and
 * has no launch option for it; Hermes and Antigravity have none either.
 */
export function agentCommand(agent: AgentName, cfg: Config, prompt: string, cwd: string, options: LaunchOptions = {}, name = ''): { file: string; args: string[] } {
  const model = options.model ? ['--model', options.model] : [];
  switch (agent) {
    case 'claude':
      return { file: cfg.agents.claude, args: [...model, ...(options.effort ? ['--effort', options.effort] : []), ...(name ? ['--name', name] : []), '--', prompt] };
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
  const command = agentCommand(agent, cfg, prompt, cwd, options, sessionName(code, detail.name));
  // Claude takes its conversation id from us, so "Riprendi" finds it without guessing; Codex is found later from its own records.
  const resumeId = agent === 'claude' ? randomUUID() : undefined;
  if (resumeId) command.args.unshift('--session-id', resumeId);
  const { file, args } = embeddedCommand(agent, command, options.role, memory, options.account, cwd, cfg.dataDir);
  return terms.spawn({ ...options, id, teamToken, resumeId, branch, agent, cwd, file, args, env: embeddedEnv(cfg, agent, detail.id, id, teamToken, options.role, memory, options.account), title: `${agentTitle(agent, options.account)} · ${detail.name}`, nodeId: detail.id, cols: size?.cols, rows: size?.rows });
}

/** The command reopening an ended conversation, with the same model and effort; the optional prompt tells a team member to reread the board. */
export function resumeCommand(agent: 'claude' | 'codex', cfg: Config, cwd: string, resumeId: string, options: LaunchOptions = {}, prompt?: string): { file: string; args: string[] } {
  const model = options.model ? ['--model', options.model] : [];
  if (agent === 'claude') return { file: cfg.agents.claude, args: [...model, ...(options.effort ? ['--effort', options.effort] : []), '--resume', resumeId, ...(prompt ? ['--', prompt] : [])] };
  return { file: cfg.agents.codex, args: ['resume', '-C', cwd, ...model, ...(options.effort ? ['-c', `model_reasoning_effort=${JSON.stringify(options.effort)}`] : []), '--', resumeId, ...(prompt ? [prompt] : [])] };
}

/** An ended session started again under the same id: same team token, code, role and node, so the board still knows it. */
export function resumeEmbedded(terms: TerminalStore, cfg: Config, info: TerminalInfo, resumeId: string, teamToken: string, seenMessage: number, size?: { cols: number; rows: number }, memory?: string, notice?: string) {
  const agent = info.agent as 'claude' | 'codex';
  const options: LaunchOptions = { model: info.model, effort: info.effort, role: info.role, parentId: info.parentId, task: info.task, ...(info.account ? { account: info.account } : {}) };
  // A role change brings its own notice (the new role card); otherwise a team member is told to reread the board.
  const prompt = notice !== undefined ? notice || undefined : info.role ? (cfg.language === 'en'
    ? 'Visual Brain restarted this session after its process ended. Read the board before resuming. Check each task’s current owner, blocker and checkpoint. Claim available work before starting.'
    : 'Visual Brain ha riavviato questa sessione dopo la chiusura del processo. Prima di riprendere, rileggi la bacheca. Verifica proprietario, blocco e checkpoint di ogni incarico. Rivendica il lavoro disponibile prima di iniziare.') : undefined;
  const { file, args } = embeddedCommand(agent, resumeCommand(agent, cfg, info.cwd, resumeId, options, prompt), info.role, memory, info.account, info.cwd, cfg.dataDir);
  return terms.spawn({ ...options, id: info.id, createdAt: info.createdAt, branch: info.branch, teamToken, seenMessage, resumeId, agent, cwd: info.cwd, file, args, env: embeddedEnv(cfg, agent, info.nodeId ?? null, info.id, teamToken, info.role, memory, info.account), title: info.title, nodeId: info.nodeId, cols: size?.cols, rows: size?.rows });
}

/**
 * The Node the MCP bridge of a session runs on. A bridge lives as long as its session, across updates of the app; started
 * on the Node inside the app, it kept the whole copy of the app it came from in use, and every update left one more copy
 * (350 MB) in running-app-backups for as long as a session opened before it stayed open. The executable is the only file a
 * bridge keeps open (team-mcp.mjs imports nothing but node:readline and reads no file), so it runs on one copy of that
 * Node kept in the profile, `agent-runtime/node`. The copy is replaced only when the app brings another Node version, with
 * a rename: a bridge already running keeps the file it started from until it ends.
 * Outside an app bundle (a development run) no copy of the app can be held: the bridge runs on this server's own Node.
 */
export function bridgeNode(dataDir: string | undefined, execPath = process.execPath, version = `${process.version} ${process.arch}`): string {
  if (!dataDir || !appBundleOf(execPath)) return execPath;
  try {
    const dir = join(dataDir, 'agent-runtime'), node = join(dir, 'node'), stamp = join(dir, 'node.version');
    let kept = '';
    try { kept = readFileSync(stamp, 'utf8'); } catch { /* first time */ }
    if (kept !== version || !existsSync(node)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const fresh = `${node}.new-${process.pid}`;
      rmSync(fresh, { force: true });
      copyFileSync(execPath, fresh, constants.COPYFILE_FICLONE);
      chmodSync(fresh, 0o700);
      renameSync(fresh, node);
      writeFileSync(`${stamp}.new-${process.pid}`, version, { mode: 0o600 });
      renameSync(`${stamp}.new-${process.pid}`, stamp);
    }
    return node;
  } catch (error) {
    // the bridge still works from the app, it only keeps that copy in use
    console.warn('[launch] Node per il collegamento MCP non copiato nel profilo:', (error as Error).message);
    return execPath;
  }
}

/** Claude and Codex get the visual_brain MCP bridge (and Claude the turn hooks of a team member); Codex starts from the login shell. */
function embeddedCommand(agent: AgentName, command: { file: string; args: string[] }, role?: AgentRole, memory?: string, account?: string, cwd = '', dataDir?: string): { file: string; args: string[] } {
  let { file, args } = command;
  // An extra account that borrows skills and plugins from the main one: links made now, so a new entry of the main
  // folder is seen too. A failure (a file in the way) never stops the launch.
  const borrowing = accountById(account);
  if (borrowing && borrowing.agent === agent) try { syncShared(borrowing); } catch (error) { console.warn('[account] condivisione non aggiornata:', (error as Error).message); }
  if (agent === 'codex' || agent === 'claude') {
    const bridge = fileURLToPath(new URL('./team-mcp.mjs', import.meta.url));
    const node = bridgeNode(dataDir);
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
        '-c', `mcp_servers.visual_brain.command=${JSON.stringify(node)}`,
        '-c', `mcp_servers.visual_brain.args=${JSON.stringify([bridge])}`,
        '-c', `mcp_servers.visual_brain.env_vars=${JSON.stringify(variables)}`,
        ...args.slice(at)];
    } else args = [...claudeSettingsFlag(role, memory, account, cwd), '--mcp-config', JSON.stringify({ mcpServers: { visual_brain: {
      type: 'stdio', command: node, args: [bridge],
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

/** The agent's name in a session title; with an extra account, its name too ("claude (Lavoro)"). */
function agentTitle(agent: AgentName, account?: string): string {
  const label = accountById(account)?.label;
  return label ? `${agent} (${label})` : agent;
}

function embeddedEnv(cfg: Config, agent: AgentName, nodeId: number | null, id: string, teamToken: string, role?: AgentRole, memory?: string, account?: string): Record<string, string> | undefined {
  // An extra account: the CLI reads sign-in and conversations from that account's folder.
  const own = accountEnv(agent, account);
  const env = nodeEnv(cfg, agent, nodeId, id, teamToken, role, memory);
  return env || Object.keys(own).length ? { ...env, ...own } : undefined;
}

function nodeEnv(cfg: Config, agent: AgentName, nodeId: number | null, id: string, teamToken: string, role?: AgentRole, memory?: string): Record<string, string> | undefined {
  if (nodeId === null) return undefined;
  const explore = { VB_EXPLORE_URL: `http://${cfg.host}:${cfg.port}/api/explore?node=${nodeId}` };
  // Claude Code's documented switch for auto memory; Codex keeps its own setting (memories, off unless the person enabled it).
  const noMemory: Record<string, string> = agent === 'claude' && memory === 'off' ? { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } : {};
  return role ? { ...hookEnv(cfg, nodeId, id, teamToken), ...explore, ...noMemory } : agent === 'codex' || agent === 'claude' ? explore : undefined;
}

/**
 * The --settings of a Claude Code session: the turn hooks of a team member, and for an extra account what it borrows
 * from the main one (memory, enabled plugins). A squad memory of its own wins over the borrowed memory. Nothing to add:
 * no flag at all, as before.
 */
function claudeSettingsFlag(role: AgentRole | undefined, memory: string | undefined, account: string | undefined, cwd: string): string[] {
  const squad = memory && memory !== 'off' ? memoryDirectory(memory) : undefined;
  const shared = sharedClaudeSettings(account, cwd, memory);
  if (!Object.keys(shared).length) return role ? ['--settings', claudeHookSettings(squad)] : [];
  return ['--settings', JSON.stringify({ ...shared, ...(role ? JSON.parse(claudeHookSettings(squad)) : {}) })];
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
export function findCodexSession(cwd: string, createdAt: number, claimed: Set<string>, home = agentHome('codex')): string | undefined {
  let best: { id: string; at: number } | undefined;
  for (const r of codexRollouts(cwd, createdAt, home)) if (!claimed.has(r.id) && (!best || r.at < best.at)) best = r;
  return best?.id;
}

/**
 * The Codex conversation that Visual Brain's own launch text opened for this session: its first message names the session
 * ("sessione <id>" / "session <id>"). Unlike the guess above it cannot take the conversation of another session started
 * in the same folder in the same seconds; undefined until Codex has recorded that first message.
 */
export function findCodexSessionOf(session: string, cwd: string, createdAt: number, home = agentHome('codex')): string | undefined {
  if (!/^[a-z0-9-]+$/i.test(session)) return undefined;
  const named = new RegExp(`\\bsessione? ${session}\\b`);
  for (const r of codexRollouts(cwd, createdAt, home)) if (named.test(r.head)) return r.id;
  return undefined;
}

/** Codex conversations recorded in this folder around the launch of a session, with the start of their record. */
function* codexRollouts(cwd: string, createdAt: number, home: string): Generator<{ id: string; at: number; head: string }> {
  const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };
  const folder = real(cwd);
  for (const offset of [-1, 0, 1]) {
    const day = new Date(createdAt + offset * 86_400_000);
    const dir = join(home, 'sessions', String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
      // A conversation started from the launch on was written after it: older records are not even opened.
      if (!((statSync(join(dir, name), { throwIfNoEntry: false })?.mtimeMs ?? 0) >= createdAt - 5_000)) continue;
      const head = fileHead(join(dir, name));
      let meta: any;
      try { const end = head.indexOf('\n'); meta = JSON.parse(end < 0 ? head : head.slice(0, end)); } catch { continue; }
      const p = meta?.type === 'session_meta' ? meta.payload : undefined;
      const at = Date.parse(p?.timestamp);
      if (typeof p?.id !== 'string' || typeof p.cwd !== 'string' || real(p.cwd) !== folder) continue;
      // A little slack before the launch for clock rounding; nothing that started long after it.
      if (!(at >= createdAt - 5_000 && at <= createdAt + 10 * 60_000)) continue;
      yield { id: p.id, at, head };
    }
  }
}

function fileHead(file: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(256 * 1024);
    return buf.toString('utf8', 0, readSync(fd, buf, 0, buf.length, 0));
  } catch { return ''; } finally { if (fd !== undefined) closeSync(fd); }
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
  const borrowing = accountById(options.account);
  if (borrowing && borrowing.agent === agent) {
    try { syncShared(borrowing); } catch (error) { console.warn('[account] condivisione non aggiornata:', (error as Error).message); }
    if (agent === 'claude') command.args.unshift(...claudeSettingsFlag(undefined, undefined, options.account, cwd));
  }
  const vars = Object.entries(accountEnv(agent, options.account)).map(([name, value]) => `${name}=${sq(value)} `).join('');
  const cmd = `cd ${sq(cwd)} && ${vars}${[sq(command.file), ...command.args.map(sq)].join(' ')} "$(cat ${sq(file)})"`;
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
