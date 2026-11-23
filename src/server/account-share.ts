// What an extra account may borrow from the main one (Impostazioni → Agenti → Avanzate), off unless the person turns it on.
// - tools: skills, plugins, commands, agents and the personal instructions of the main folder, as symbolic links in the
//   account's folder, so a change made from either account is seen by both. Whatever the account already had of its own
//   is set aside under `<name>.own` and put back when the option is turned off.
// - memory (Claude Code only): the project's auto memory of the main account, through Claude Code's autoMemoryDirectory.
// Never shared: credentials, the account's state file and settings.json (default model, permissions). The main account's
// enabled plugins are handed to a session as flag settings instead.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, renameSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { accountById, agentHome, type AgentAccount, type AccountAgent } from './accounts.ts';

/** Entries of the main folder linked by the «tools» option. */
export const SHARED_TOOLS: Record<AccountAgent, readonly string[]> = {
  claude: ['skills', 'commands', 'agents', 'output-styles', 'plugins', 'CLAUDE.md'],
  codex: ['skills', 'rules', 'prompts', 'AGENTS.md'],
};
const OWN = '.own';

const isLink = (path: string) => { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } };
const present = (path: string) => { try { lstatSync(path); return true; } catch { return false; } };

/**
 * Brings the account's folder in line with its options: links what is shared, removes our links when it is not.
 * Idempotent, run when the option changes and before each launch (the main folder may have gained an entry since).
 * Returns the entries now linked.
 */
export function syncShared(account: AgentAccount): string[] {
  const main = agentHome(account.agent), linked: string[] = [];
  for (const name of SHARED_TOOLS[account.agent]) {
    const source = join(main, name), target = join(account.home, name), own = target + OWN;
    const ours = isLink(target) && readlinkSync(target) === source;
    if (account.share?.tools) {
      if (ours) { linked.push(name); continue; }
      if (!existsSync(source)) continue;
      if (present(target)) {
        // The account's own entry is kept beside, never deleted; a second one already set aside wins over this one.
        if (present(own)) continue;
        renameSync(target, own);
      }
      symlinkSync(source, target);
      linked.push(name);
    } else if (ours) {
      unlinkSync(target);
      if (present(own)) renameSync(own, target);
    }
  }
  return linked;
}

/** The folder Claude Code files a project under: its path with every other character than a letter or digit as «-». */
const projectFolder = (path: string) => path.replace(/[^a-zA-Z0-9]/g, '-');

/**
 * The project of a working folder as Claude Code's auto memory sees it: the Git repository (its main checkout, so
 * every worktree shares it), otherwise the folder itself.
 */
export function memoryProject(cwd: string): string {
  const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };
  try {
    const common = execFileSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (common.endsWith('/.git')) return real(dirname(common));
  } catch { /* not a repository, or no git */ }
  return real(cwd);
}

/**
 * Flag settings that give a Claude Code session of an extra account what it shares with the main one: the main
 * account's memory of this project and the plugins enabled there. Empty for the main account, Codex, or nothing shared.
 * `memory` is the squad's choice: «off» keeps auto memory off; a squad memory of its own overrides this one (launch.ts).
 */
export function sharedClaudeSettings(accountId: string | undefined, cwd: string, memory?: string): Record<string, unknown> {
  const account = accountById(accountId);
  if (!account || account.agent !== 'claude') return {};
  const settings: Record<string, unknown> = {};
  const main = agentHome('claude');
  if (account.share?.memory && memory !== 'off') settings.autoMemoryDirectory = join(main, 'projects', projectFolder(memoryProject(cwd)), 'memory');
  if (account.share?.tools) {
    try {
      const own = JSON.parse(readFileSync(join(main, 'settings.json'), 'utf8'));
      for (const key of ['enabledPlugins', 'extraKnownMarketplaces']) if (own?.[key] && typeof own[key] === 'object') settings[key] = own[key];
    } catch { /* no settings in the main folder */ }
  }
  return settings;
}
