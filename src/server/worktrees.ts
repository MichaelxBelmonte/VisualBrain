// Optional Git worktree per operator: parallel agents edit separate checkouts on their own branches, never the same files on disk.
// Worktrees live in the profile (dataDir/worktrees/<node>/<code>), so the project folder gets no extra directories.
import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const git = async (args: string[]) => (await run('git', args, { timeout: 60_000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim();
const ok = async (args: string[]) => { try { await git(args); return true; } catch { return false; } };

export const worktreesDir = (dataDir: string) => join(dataDir, 'worktrees');

export interface Worktree { cwd: string; path: string; branch: string }

/**
 * A new worktree on its own branch from the current commit, mirroring where `cwd` sits inside the repository.
 * Null when `cwd` is not in a Git repository with at least one commit: the session then shares the folder as before.
 */
export async function createWorktree(dataDir: string, nodeId: number, code: string, cwd: string): Promise<Worktree | null> {
  let top: string;
  try { top = await git(['-C', cwd, 'rev-parse', '--show-toplevel']); } catch { return null; }
  if (!(await ok(['-C', top, 'rev-parse', '--verify', '-q', 'HEAD']))) return null;
  const name = code.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'agent';
  const base = join(worktreesDir(dataDir), String(nodeId));
  let path = join(base, name), branch = `visual-brain/n${nodeId}-${name}`;
  // A worktree or branch left from an earlier session is never reused or overwritten.
  for (let n = 2; existsSync(path) || await ok(['-C', top, 'show-ref', '--verify', '-q', `refs/heads/${branch}`]); n++) {
    path = join(base, `${name}-${n}`); branch = `visual-brain/n${nodeId}-${name}-${n}`;
  }
  await git(['-C', top, 'worktree', 'add', '-q', '-b', branch, path, 'HEAD']);
  const inside = relative(realpathSync(top), realpathSync(cwd));
  return { cwd: inside ? join(path, inside) : path, path, branch };
}

/**
 * Removes the worktree of a closed session when Git allows it without force: uncommitted or untracked files keep it on disk.
 * The branch always stays, so committed work is never lost. Returns whether the folder was removed.
 */
export async function removeWorktree(dataDir: string, cwd: string): Promise<boolean> {
  const root = worktreesDir(dataDir);
  const rest = relative(root, cwd);
  if (!rest || rest.startsWith('..') || rest.startsWith(sep)) return false;
  const [node, name] = rest.split(sep);
  if (!node || !name) return false;
  const path = join(root, node, name);
  try {
    const common = await git(['-C', path, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
    await git(['-C', dirname(common), 'worktree', 'remove', path]);
    return true;
  } catch { return false; }
}
