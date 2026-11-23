// More than one account per agent CLI. Claude Code and Codex keep their sign-in and conversations in one folder
// (~/.claude, ~/.codex), chosen with an environment variable (CLAUDE_CONFIG_DIR, CODEX_HOME). An extra account is a
// folder of its own in the Visual Brain profile: a session started with it gets that variable, so two subscriptions can
// run at the same time. The main account is the CLI's own folder and is never listed here.
// Only the folder and a name are kept: credentials stay with the CLI (Claude Code: the macOS keychain; Codex: its folder).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AccountShare, AgentAccount, AccountAgent } from '../shared/types.ts';

export type { AccountShare, AgentAccount, AccountAgent };
export const ACCOUNT_AGENTS: readonly AccountAgent[] = ['claude', 'codex'];
export const ACCOUNT_ENV: Record<AccountAgent, 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME'> = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' };
const DEFAULT_FOLDER: Record<AccountAgent, string> = { claude: '.claude', codex: '.codex' };
/** At most this many extra accounts in all. */
export const MAX_ACCOUNTS = 8;

export const isAccountAgent = (v: unknown): v is AccountAgent => v === 'claude' || v === 'codex';
const validId = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(v);

/** The accounts of this server: loaded with the config, changed only by addAccount / removeAccount. */
let known: AgentAccount[] = [];

/** Keeps the well-formed entries of a config file's `accounts`. */
export function parseAccounts(value: unknown): AgentAccount[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.filter((a): a is AgentAccount => !!a && typeof a === 'object' && validId(a.id) && isAccountAgent(a.agent)
    && typeof a.label === 'string' && !!a.label.trim() && typeof a.home === 'string' && a.home.startsWith('/') && !seen.has(a.id) && !!seen.add(a.id))
    .slice(0, MAX_ACCOUNTS).map(a => {
      const share = parseShare(a.agent, a.share);
      return { id: a.id, agent: a.agent, label: a.label.trim().slice(0, 40), home: a.home, ...(share ? { share } : {}) };
    });
}

/** Only true options are kept; memory is shared only by Claude Code (Codex keeps it in a database of its own). */
export function parseShare(agent: AccountAgent, value: unknown): AccountShare | undefined {
  const v = value as AccountShare | null | undefined;
  const share: AccountShare = { ...(v?.memory === true && agent === 'claude' ? { memory: true } : {}), ...(v?.tools === true ? { tools: true } : {}) };
  return Object.keys(share).length ? share : undefined;
}

export function useAccounts(list: AgentAccount[]): void { known = list.map(a => ({ ...a, ...(a.share ? { share: { ...a.share } } : {}) })); }
export function listAccounts(): AgentAccount[] { return known.map(a => ({ ...a, ...(a.share ? { share: { ...a.share } } : {}) })); }
export function accountById(id: string | undefined): AgentAccount | undefined { return id ? known.find(a => a.id === id) : undefined; }

/** The account of a launch: absent for the main one; an unknown id or one of another agent is an error. */
export function accountFor(agent: string, id: unknown): AgentAccount | undefined {
  if (id === undefined || id === null || id === '') return undefined;
  const account = typeof id === 'string' ? accountById(id) : undefined;
  if (!account || account.agent !== agent) throw new Error('Account non valido per questo agente');
  return account;
}

/** Where the CLI keeps sign-in and conversations for this account: its own folder, or the CLI's default. */
export function agentHome(agent: AccountAgent, id?: string): string {
  return accountById(id)?.home ?? (process.env[ACCOUNT_ENV[agent]] || join(homedir(), DEFAULT_FOLDER[agent]));
}

/** The variable that points the CLI at the account's folder; nothing for the main account. */
export function accountEnv(agent: string, id?: string): Record<string, string> {
  const account = accountById(id);
  return account && account.agent === agent ? { [ACCOUNT_ENV[account.agent]]: account.home } : {};
}

/** A short id from the name: lowercase letters, digits and dashes, unique among the accounts. Pure. */
export function accountId(label: string, taken: Iterable<string>): string {
  const base = label.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'account';
  const used = new Set(taken);
  let id = base, n = 2;
  while (used.has(id)) id = `${base}-${n++}`;
  return id;
}

/** Writes `accounts` into the settings file, keeping everything else in it. */
function persist(configFile: string, list: AgentAccount[], key = 'accounts'): void {
  write(configFile, { [key]: list });
}
function write(configFile: string, patch: Record<string, unknown>): void {
  const previous = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : {};
  mkdirSync(dirname(configFile), { recursive: true, mode: 0o700 });
  const next = configFile + '.tmp';
  writeFileSync(next, JSON.stringify({ ...previous, ...patch }, null, 2) + '\n', { mode: 0o600 });
  renameSync(next, configFile);
}

/** A new account with an empty folder in the profile; signing in is the next step (a visible terminal). */
export function addAccount(cfg: { dataDir: string; configFile?: string }, agent: unknown, label: unknown): AgentAccount {
  if (!isAccountAgent(agent)) throw new Error('Più account solo per Claude Code e Codex');
  const name = typeof label === 'string' ? label.replace(/\s+/g, ' ').trim().slice(0, 40) : '';
  if (!name) throw new Error('Dai un nome all’account');
  if (known.length >= MAX_ACCOUNTS) throw new Error(`Al massimo ${MAX_ACCOUNTS} account aggiuntivi`);
  if (known.some(a => a.agent === agent && a.label.toLowerCase() === name.toLowerCase()) || mainNames[agent]?.toLowerCase() === name.toLowerCase()) throw new Error('Esiste già un account con questo nome');
  const id = accountId(name, known.map(a => a.id));
  const home = join(cfg.dataDir, 'accounts', `${agent}-${id}`);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const account: AgentAccount = { id, agent, label: name, home };
  const list = [...known, account];
  if (cfg.configFile) persist(cfg.configFile, list);
  useAccounts(list);
  return account;
}

/** Changes what the account borrows from the main one; the links themselves are made by account-share.ts. */
export function setAccountShare(cfg: { configFile?: string }, id: string, value: unknown): AgentAccount {
  const account = accountById(id);
  if (!account) throw new Error('Account non trovato');
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== 'object' || Object.values(v).some(x => typeof x !== 'boolean')) throw new Error('Opzioni di condivisione non valide');
  if (v.memory === true && account.agent !== 'claude') throw new Error('La memoria si condivide solo con Claude Code');
  const share = parseShare(account.agent, v);
  const { share: _old, ...rest } = account;
  const next: AgentAccount = { ...rest, ...(share ? { share } : {}) };
  const list = known.map(a => a.id === id ? next : a);
  if (cfg.configFile) persist(cfg.configFile, list);
  useAccounts(list);
  return next;
}

/** A name typed by the person: spaces collapsed, at most 40 characters; empty when nothing is left. */
const cleanName = (value: unknown) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 40) : '';

/** A new name for an extra account. Its id and folder stay, so sign-in, conversations and sessions keep working. */
export function renameAccount(cfg: { configFile?: string }, id: string, label: unknown): AgentAccount {
  const account = accountById(id);
  if (!account) throw new Error('Account non trovato');
  const name = cleanName(label);
  if (!name) throw new Error('Dai un nome all’account');
  if (known.some(a => a.id !== id && a.agent === account.agent && a.label.toLowerCase() === name.toLowerCase())
    || mainNames[account.agent]?.toLowerCase() === name.toLowerCase()) throw new Error('Esiste già un account con questo nome');
  const next = { ...account, label: name };
  const list = known.map(a => a.id === id ? next : a);
  if (cfg.configFile) persist(cfg.configFile, list);
  useAccounts(list);
  return next;
}

/** Names the person gave to the main account of each CLI (shown on its sessions); absent: «Principale». */
let mainNames: Partial<Record<AccountAgent, string>> = {};
export function parseMainNames(value: unknown): Partial<Record<AccountAgent, string>> {
  const v = value as Record<string, unknown> | null, names: Partial<Record<AccountAgent, string>> = {};
  if (v && typeof v === 'object') for (const agent of ACCOUNT_AGENTS) { const name = cleanName(v[agent]); if (name) names[agent] = name; }
  return names;
}
export function useMainNames(names: Partial<Record<AccountAgent, string>>): void { mainNames = { ...names }; }
export function mainName(agent: string): string | undefined { return isAccountAgent(agent) ? mainNames[agent] : undefined; }
export function mainNamesNow(): Partial<Record<AccountAgent, string>> { return { ...mainNames }; }

/** Names the main account of a CLI; an empty name goes back to «Principale». */
export function setMainName(cfg: { configFile?: string }, agent: unknown, name: unknown): Partial<Record<AccountAgent, string>> {
  if (!isAccountAgent(agent)) throw new Error('Nomi degli account solo per Claude Code e Codex');
  const clean = cleanName(name);
  if (clean && known.some(a => a.agent === agent && a.label.toLowerCase() === clean.toLowerCase())) throw new Error('Esiste già un account con questo nome');
  const next = { ...mainNames };
  if (clean) next[agent] = clean; else delete next[agent];
  if (cfg.configFile) write(cfg.configFile, { accountNames: next });
  useMainNames(next);
  return next;
}

/** Forgets the account. Its folder stays (conversations, sign-in): adding it again with the same name finds it. */
export function removeAccount(cfg: { configFile?: string }, id: string): AgentAccount {
  const account = accountById(id);
  if (!account) throw new Error('Account non trovato');
  const list = known.filter(a => a.id !== id);
  if (cfg.configFile) persist(cfg.configFile, list);
  useAccounts(list);
  return account;
}
