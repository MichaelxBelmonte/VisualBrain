// The names of the CLI accounts (Impostazioni → Agenti → Account), for the label on each Claude Code and Codex session.
// Loaded once and again after every change of name; listeners hear «vb:accounts-changed».
import { api } from './api.ts';
import { t } from './i18n.ts';

export interface AccountNames { accounts: { id: string; agent: string; label: string }[]; main: Partial<Record<string, string>> }
let names: AccountNames = { accounts: [], main: {} };
let pending: Promise<void> | null = null;

export function accountNames(): AccountNames { return names; }

/** Reads the names again and tells the views; a failed read keeps the last ones. */
export function refreshAccountNames(): Promise<void> {
  pending ??= api.accountNames().then(next => {
    names = { accounts: next.accounts ?? [], main: next.main ?? {} };
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('vb:accounts-changed'));
  }).catch(() => {}).finally(() => { pending = null; });
  return pending;
}

/** For tests: names as the server would give them. */
export function useAccountNames(next: AccountNames): void { names = next; }

/** The main account's name: the one the person gave it, otherwise «Principale». */
export function mainAccountName(agent: string): string { return names.main[agent] ?? t('Principale'); }

/**
 * The account a session runs with, as its label shows it. Nothing for other agents, nor while a CLI has a single
 * account the person never named: there is nothing to tell apart.
 */
export function accountTag(info: { agent: string; account?: string }): string | null {
  if (info.agent !== 'claude' && info.agent !== 'codex') return null;
  if (info.account) return names.accounts.find(a => a.id === info.account)?.label ?? info.account;
  return names.main[info.agent] ?? (names.accounts.some(a => a.agent === info.agent) ? t('Principale') : null);
}
