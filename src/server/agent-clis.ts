// The agent CLIs Visual Brain starts (Claude Code, Codex, Hermes, Antigravity): where they are, which version,
// whether they are signed in, and the official commands to install, update, sign in and sign out.
// Nothing here installs silently: every action runs in a visible terminal, with the user's own login shell.
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import type { Config } from './config.ts';
import { ACCOUNT_ENV, listAccounts, type AgentAccount } from './accounts.ts';
import type { AgentAccountStatus } from '../shared/types.ts';

export type CliName = 'claude' | 'codex' | 'hermes' | 'agy';
type Action = 'install' | 'update' | 'login' | 'logout';

interface CliSpec {
  label: string;
  /** Official installer, run with the user's login shell. */
  install: string;
  /** Arguments of the CLI itself; `null` falls back to the installer (update) or is not offered (logout). */
  update: string[] | null;
  login: string[];
  logout: string[] | null;
  /** How to ask the CLI whether it is signed in; `null`: the CLI has no such command. */
  status: string[] | null;
  docs: string;
}

export const CLI_SPECS: Record<CliName, CliSpec> = {
  claude: { label: 'Claude Code', install: 'curl -fsSL https://claude.ai/install.sh | bash', update: ['update'], login: ['auth', 'login'], logout: ['auth', 'logout'], status: ['auth', 'status'], docs: 'https://docs.claude.com/en/docs/claude-code/setup' },
  codex: { label: 'Codex', install: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh', update: null, login: ['login'], logout: ['logout'], status: ['login', 'status'], docs: 'https://developers.openai.com/codex/cli' },
  hermes: { label: 'Hermes', install: 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash', update: null, login: ['setup'], logout: ['logout'], status: null, docs: 'https://hermes-agent.nousresearch.com' },
  agy: { label: 'Antigravity', install: 'curl -fsSL https://antigravity.google/cli/install.sh | bash', update: null, login: [], logout: null, status: null, docs: 'https://antigravity.google' },
};

export interface CliStatus {
  id: CliName;
  label: string;
  command: string;
  path: string | null;
  version: string | null;
  /** true / false when the CLI can tell; null when it cannot (or did not answer in time). */
  signedIn: boolean | null;
  account: string | null;
  installCommand: string;
  canLogout: boolean;
  docs: string;
}

export const isCli = (value: unknown): value is CliName => typeof value === 'string' && Object.hasOwn(CLI_SPECS, value);

/** PATH of the native app plus the usual install folders: the same search the launcher uses. */
export function cliPath(): string {
  const home = homedir();
  return [`${home}/.local/bin`, `${home}/.local/node/bin`, '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH ?? '/usr/bin:/bin'].join(':');
}

function run(file: string, args: string[], ms: number, env: Record<string, string> = {}): Promise<{ code: number | null; out: string }> {
  return new Promise(resolve => {
    let out = '', done = false;
    const child = spawn(file, args, { env: { ...process.env, PATH: cliPath(), NO_COLOR: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (code: number | null) => { if (!done) { done = true; clearTimeout(timer); resolve({ code, out }); } };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish(null); }, ms);
    child.stdout.on('data', d => { if (out.length < 8000) out += d; });
    child.stderr.on('data', d => { if (out.length < 8000) out += d; });
    child.on('error', () => finish(-1));
    child.on('close', code => finish(code));
  });
}

async function resolvePath(command: string): Promise<string | null> {
  if (command.includes('/')) return (await run('/bin/test', ['-x', command], 2000)).code === 0 ? command : null;
  const r = await run('/usr/bin/which', [command], 3000);
  return r.code === 0 ? r.out.trim().split('\n')[0] || null : null;
}

/** Reads the CLI's own answer. Exported for tests. */
export function parseSignedIn(id: CliName, code: number | null, out: string): { signedIn: boolean | null; account: string | null } {
  if (code === null) return { signedIn: null, account: null };
  if (id === 'claude') {
    try {
      const j = JSON.parse(out.slice(out.indexOf('{'))) as { loggedIn?: boolean; authMethod?: string; email?: string; account?: { email?: string } };
      return { signedIn: j.loggedIn === true, account: j.email || j.account?.email || j.authMethod || null };
    } catch { return { signedIn: code === 0 ? null : false, account: null }; }
  }
  if (id === 'codex') {
    const line = out.trim().split('\n').find(l => /logged in/i.test(l)) ?? '';
    if (/not logged in/i.test(line)) return { signedIn: false, account: null };
    if (code === 0 && line) return { signedIn: true, account: line.replace(/^logged in (using|with)\s*/i, '') || null };
    return { signedIn: code === 0 ? null : false, account: null };
  }
  return { signedIn: null, account: null };
}

let cache: { at: number; list: CliStatus[] } | null = null;
let pending: Promise<CliStatus[]> | null = null;

async function probe(cfg: Config, id: CliName): Promise<CliStatus> {
  const spec = CLI_SPECS[id], command = cfg.agents[id];
  const path = await resolvePath(command);
  const base: CliStatus = { id, label: spec.label, command, path, version: null, signedIn: null, account: null, installCommand: spec.install, canLogout: !!spec.logout, docs: spec.docs };
  if (!path) return base;
  const [version, auth] = await Promise.all([
    run(path, ['--version'], 6000),
    spec.status ? run(path, spec.status, 10_000) : Promise.resolve(null),
  ]);
  const v = version.code === 0 ? version.out.trim().split('\n')[0].match(/\d+\.\d+[\w.+-]*/)?.[0] ?? version.out.trim().split('\n')[0].slice(0, 40) : null;
  return { ...base, version: v, ...(auth ? parseSignedIn(id, auth.code, auth.out) : {}) };
}

/** Probes run in parallel and are cached for a minute; `fresh` forces a new probe (after an install or a login). */
export function cliCatalog(cfg: Config, fresh = false): Promise<CliStatus[]> {
  if (!fresh && cache && Date.now() - cache.at < 60_000) return Promise.resolve(cache.list);
  pending ??= Promise.all((Object.keys(CLI_SPECS) as CliName[]).map(id => probe(cfg, id)))
    .then(list => { cache = { at: Date.now(), list }; return list; })
    .finally(() => { pending = null; });
  return pending;
}

export function forgetCliCatalog(): void { cache = null; accountCache = null; }

let accountCache: { at: number; list: Omit<AgentAccountStatus, 'sessions'>[] } | null = null;

/** Sign-in of each extra account: the CLI's own status command, run with the account's folder. Cached like the CLIs. */
export async function accountCatalog(cfg: Config, fresh = false): Promise<Omit<AgentAccountStatus, 'sessions'>[]> {
  const accounts = listAccounts();
  if (!fresh && accountCache && Date.now() - accountCache.at < 60_000 && accountCache.list.length === accounts.length
    && accountCache.list.every((a, i) => a.id === accounts[i].id)) return accountCache.list;
  const list = await Promise.all(accounts.map(async (a: AgentAccount) => {
    const path = await resolvePath(cfg.agents[a.agent]);
    const spec = CLI_SPECS[a.agent];
    if (!path || !spec.status) return { ...a, signedIn: null, email: null };
    const auth = await run(path, spec.status, 10_000, { [ACCOUNT_ENV[a.agent]]: a.home });
    const { signedIn, account } = parseSignedIn(a.agent, auth.code, auth.out);
    return { ...a, signedIn, email: account };
  }));
  accountCache = { at: Date.now(), list };
  return list;
}

/** The terminal command for an action: arguments for the login shell, never user text. */
export function cliAction(cfg: Config, id: CliName, action: Action, account?: AgentAccount): { title: string; file: string; args: string[] } {
  const spec = CLI_SPECS[id], shell = process.env.SHELL || '/bin/zsh';
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  if (account && (account.agent !== id || (action !== 'login' && action !== 'logout'))) throw new Error('Azione non disponibile per questo account');
  // An extra account: the CLI signs in and out in that account's folder, never in the main one.
  const vars = account ? `${ACCOUNT_ENV[account.agent]}=${quote(account.home)} ` : '';
  const own = (args: string[]) => vars + [cfg.agents[id], ...args].map(quote).join(' ');
  let script: string;
  if (action === 'install' || (action === 'update' && !spec.update)) script = spec.install;
  else if (action === 'update') script = own(spec.update!);
  else if (action === 'login') script = own(spec.login);
  else if (spec.logout) script = own(spec.logout);
  else throw new Error('Uscita non disponibile per questa CLI');
  const titles: Record<Action, string> = { install: 'installazione', update: 'aggiornamento', login: 'accesso', logout: 'uscita' };
  // The terminal stays open on the result, so the user can read it before closing.
  const done = `vb_code=$?; echo; echo "— ${spec.label}: ${titles[action]} terminato (codice $vb_code). Puoi chiudere questo terminale."`;
  const label = account ? `${spec.label} (${account.label})` : spec.label;
  return { title: `${label} · ${titles[action]}`, file: shell, args: ['-lic', `${script}; ${done}; exec ${quote(shell)} -l`] };
}
