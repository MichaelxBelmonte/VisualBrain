import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { gitEnv, gitTop, githubOf } from './git.ts';
import { TeamError } from './team.ts';
import type { GithubRepositories } from '../shared/types.ts';

const run = promisify(execFile);
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+$/;
const busy = new Set<string>();
async function gh(args: string[]) {
  return (await run('gh', args, { env: gitEnv(), timeout: 30_000, maxBuffer: 8 * 1024 * 1024 })).stdout;
}
async function git(top: string, args: string[], raw = false) {
  const { stdout } = await run('git', ['-C', top, '-c', 'credential.helper=', '-c', 'credential.https://github.com.helper=!gh auth git-credential', ...args], { env: gitEnv(), timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  return raw ? stdout : stdout.trim();
}

async function checkoutMissing(top: string): Promise<void> {
  const paths = (await git(top, ['ls-files', '-z'], true)).split('\0').filter(Boolean), missing: string[] = [];
  for (const path of paths) {
    const parts = path.split('/');
    let safe = true;
    for (let i = 1; i <= parts.length; i++) {
      const info = await lstat(join(top, ...parts.slice(0, i))).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      // Preserve every existing leaf, and never descend through a local file or symbolic link.
      if (info && (i === parts.length || !info.isDirectory() || info.isSymbolicLink())) { safe = false; break; }
    }
    if (safe) missing.push(path);
  }
  for (let i = 0; i < missing.length; i += 100) await git(top, ['checkout-index', '--', ...missing.slice(i, i + 100)]);
}
export async function githubRepositories(page: number): Promise<GithubRepositories> {
  try { await gh(['--version']); }
  catch { return { state: 'missing', message: 'Installa GitHub CLI (gh) per collegare il tuo account.' }; }
  try { await gh(['auth', 'status', '--hostname', 'github.com']); }
  catch { return { state: 'signed-out', message: 'Collega il tuo account GitHub per scegliere un repository.' }; }
  const [user, data] = await Promise.all([
    gh(['api', '--hostname', 'github.com', 'user', '--jq', '.login']),
    gh(['api', '--hostname', 'github.com', `user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`]),
  ]);
  const repos = JSON.parse(data) as Array<{ full_name: string; private: boolean }>;
  return { state: 'ok', login: user.trim(), repos: repos.filter(r => REPOSITORY.test(r.full_name)).map(r => ({ name: r.full_name, private: !!r.private })), more: repos.length === 100 };
}

/** Explicit UI action. No forced checkout, reset, auto-commit, stash or history rewrite. */
export async function connectGithub(folder: string, repository: string, push = false): Promise<{ top: string; branch: string; pushed: boolean; localChanges?: boolean }> {
  if (!REPOSITORY.test(repository) || repository.split('/').some(p => p === '.' || p === '..')) throw new TeamError(400, 'Repository non valido');
  const top = await realpath(await gitTop(folder) ?? folder);
  if (busy.has(top)) throw new TeamError(409, 'Sincronizzazione già in corso');
  busy.add(top);
  try {
    const metadata = JSON.parse(await gh(['api', '--hostname', 'github.com', `repos/${repository}`])) as { full_name: string; default_branch: string; size: number };
    if (metadata.full_name.toLowerCase() !== repository.toLowerCase()) throw new TeamError(409, 'Il repository è stato rinominato: aggiorna l’elenco');
    const branch = metadata.default_branch;
    await git(top, ['check-ref-format', `refs/heads/${branch}`]);
    const wasRepo = !!await gitTop(top);
    const head = wasRepo ? await git(top, ['rev-parse', '--verify', 'HEAD']).catch(() => '') : '';
    if (head && await git(top, ['status', '--porcelain'])) throw new TeamError(409, 'Salva le modifiche locali in un commit prima di sincronizzare.');
    if (!wasRepo) await git(top, ['init']);
    const remote = await git(top, ['config', '--get', 'remote.origin.url']).catch(() => '');
    if (remote && githubOf(remote)?.web.toLowerCase() !== `https://github.com/${repository}`.toLowerCase()) throw new TeamError(409, 'La cartella è già collegata a un altro origin. Il collegamento non è stato cambiato.');
    if (!remote) await git(top, ['remote', 'add', 'origin', `https://github.com/${repository}.git`]);
    await git(top, ['fetch', 'origin']);
    const remoteRef = `refs/remotes/origin/${branch}`;
    const remoteHead = await git(top, ['rev-parse', '--verify', remoteRef]).catch(() => '');
    if (!remoteHead) {
      if (!head) throw new TeamError(409, 'Repository remoto vuoto: crea un commit locale prima di pubblicarlo. Il collegamento è salvato.');
      if (!push) return { top, branch: await git(top, ['symbolic-ref', '--short', 'HEAD']), pushed: false };
    } else if (!head) {
      if (await git(top, ['ls-files'])) throw new TeamError(409, 'La cartella contiene file già preparati per un commit. Completa il commit prima di collegarla.');
      // Adopt the remote baseline without replacing existing local files. checkout-index without --force
      // creates only missing files; differing existing files remain ordinary working-tree changes.
      await git(top, ['update-ref', `refs/heads/${branch}`, remoteHead, '']);
      await git(top, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
      await git(top, ['read-tree', remoteRef]);
      await checkoutMissing(top);
      await git(top, ['branch', '--set-upstream-to', `origin/${branch}`]);
    } else {
      const localBranch = await git(top, ['symbolic-ref', '--short', 'HEAD']);
      const upstream = await git(top, ['rev-parse', '--abbrev-ref', '@{upstream}']).catch(() => '');
      if (localBranch !== branch && upstream !== `origin/${branch}`) throw new TeamError(409, `Per sincronizzare questo repository seleziona prima il ramo ${branch}. Il ramo corrente è ${localBranch}.`);
      await git(top, ['merge', '--ff-only', '--no-edit', remoteRef]);
      await git(top, ['branch', '--set-upstream-to', `origin/${branch}`]);
    }
    const localChanges = !!await git(top, ['status', '--porcelain']);
    if (push && localChanges) throw new TeamError(409, 'Cartella collegata; modifiche locali conservate. Crea un commit prima di pubblicarle.');
    if (push) {
      const localBranch = await git(top, ['symbolic-ref', '--short', 'HEAD']);
      await git(top, ['push', '--set-upstream', 'origin', `refs/heads/${localBranch}:refs/heads/${branch}`]);
    }
    return { top, branch, pushed: push, localChanges };
  } catch (error) {
    if (error instanceof TeamError) throw error;
    // Never include command lines or credentials in an API error.
    const detail = String((error as { stderr?: string }).stderr ?? '').trim();
    const collision = /overwritten|would be removed|not possible to fast-forward/i.test(detail);
    throw new TeamError(409, collision
      ? 'Sincronizzazione interrotta: file locali in conflitto o cronologie divergenti. I file locali sono conservati; risolvi il conflitto nel tuo editor.'
      : 'Sincronizzazione non completata. Controlla accesso GitHub, rete, ramo e stato Git della cartella.');
  } finally { busy.delete(top); }
}
