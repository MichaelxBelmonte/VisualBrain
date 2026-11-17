// Read-only view of a node's Git repository for the "Git" tab: state, branches, worktrees, the commit graph and one
// commit's files; `git fetch` is the only command that changes anything (remote-tracking refs). GitHub pull requests
// and workflow runs come from the GitHub CLI (gh) when it is installed and signed in; nothing here asks for credentials.
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';

import type { GitBranch, GitCommit, GitCommitDetail, GitOverview, GitWorktree, GithubPull, GithubState } from '../shared/types.ts';

const run = promisify(execFile);
const US = '\x1f', RS = '\x1e';

export function gitEnv(): NodeJS.ProcessEnv {
  const home = homedir();
  const path = (process.env.PATH ?? '/usr/bin:/bin').split(delimiter);
  for (const p of [`${home}/.local/bin`, '/opt/homebrew/bin', '/usr/local/bin']) if (!path.includes(p)) path.unshift(p);
  // Never wait for a password, a passphrase or an unknown host key: a fetch that needs one fails instead.
  return { ...process.env, PATH: path.join(delimiter), GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', LC_ALL: 'C' };
}

async function git(dir: string, args: string[], timeout = 20_000): Promise<string> {
  return (await run('git', ['-C', dir, ...args], { timeout, maxBuffer: 16 * 1024 * 1024, env: gitEnv() })).stdout;
}

/** The repository holding `dir`, or null when it is not inside one. */
export async function gitTop(dir: string): Promise<string | null> {
  try { return (await git(dir, ['rev-parse', '--show-toplevel'])).trim() || null; } catch { return null; }
}

/** https://github.com/owner/repo for the usual SSH and HTTPS remote forms; undefined for other hosts. */
export function githubOf(url: string): { owner: string; repo: string; web: string } | undefined {
  const m = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/(?:[^@/]+@)?github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? { owner: m[1], repo: m[2], web: `https://github.com/${m[1]}/${m[2]}` } : undefined;
}

function track(text: string): { ahead?: number; behind?: number; gone?: boolean } {
  if (text.includes('gone')) return { gone: true };
  const a = /ahead (\d+)/.exec(text), b = /behind (\d+)/.exec(text);
  return { ...(a ? { ahead: Number(a[1]) } : {}), ...(b ? { behind: Number(b[1]) } : {}) };
}

async function branches(top: string, kind: 'heads' | 'remotes'): Promise<GitBranch[]> {
  const out = await git(top, ['for-each-ref', '--sort=-committerdate', '--count=300', `--format=%(refname)${US}%(refname:short)${US}%(objectname)${US}%(committerdate:unix)${US}%(subject)${US}%(authorname)${US}%(upstream:short)${US}%(upstream:track)${US}%(HEAD)${RS}`, `refs/${kind}`]);
  const list: GitBranch[] = [];
  for (const rec of out.split(RS)) {
    const [ref, name, hash, date, subject, author, upstream, tr, head] = rec.replace(/^\n/, '').split(US);
    if (!ref || !hash || ref.endsWith('/HEAD')) continue;
    list.push({ name, ref, hash, date: Number(date) * 1000, subject: subject ?? '', author: author ?? '', ...(upstream ? { upstream, ...track(tr ?? '') } : {}), ...(head === '*' ? { current: true } : {}) });
  }
  return list;
}

/** Commits of every branch, remote and tag, newest first (parents before children are never needed: the UI lays out lanes top-down). */
export async function gitLog(top: string, limit = 300): Promise<GitCommit[]> {
  let out: string;
  try { out = await git(top, ['log', '--branches', '--remotes', '--tags', 'HEAD', '--date-order', `-n${Math.max(1, Math.min(2000, limit))}`, `--format=%H${US}%P${US}%an${US}%at${US}%D${US}%s${RS}`]); }
  catch { return []; }   // a repository without commits
  const commits: GitCommit[] = [];
  for (const rec of out.split(RS)) {
    const [hash, parents, author, date, refs, subject] = rec.replace(/^\n/, '').split(US);
    if (!hash) continue;
    commits.push({ hash, parents: parents ? parents.split(' ') : [], author: author ?? '', date: Number(date) * 1000, subject: subject ?? '', refs: refs ? refs.split(', ').filter(r => r && r !== 'origin/HEAD') : [] });
  }
  return commits;
}

export async function gitOverview(top: string): Promise<GitOverview> {
  const [status, local, remote, remotesOut, worktreesOut, commits] = await Promise.all([
    git(top, ['status', '--porcelain=v2', '--branch']),
    branches(top, 'heads'), branches(top, 'remotes'),
    git(top, ['remote', '-v']),
    git(top, ['worktree', 'list', '--porcelain']),
    gitLog(top),
  ]);
  let branch: string | null = null, head: string | null = null, upstream: string | undefined, ahead = 0, behind = 0;
  const changes = { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 };
  for (const line of status.split('\n')) {
    if (line.startsWith('# branch.head ')) { const b = line.slice(14); branch = b === '(detached)' ? null : b; }
    else if (line.startsWith('# branch.oid ')) { const o = line.slice(13); head = o === '(initial)' ? null : o; }
    else if (line.startsWith('# branch.upstream ')) upstream = line.slice(18);
    else if (line.startsWith('# branch.ab ')) { const m = /\+(\d+) -(\d+)/.exec(line); if (m) { ahead = Number(m[1]); behind = Number(m[2]); } }
    else if (line.startsWith('1 ') || line.startsWith('2 ')) { if (line[2] !== '.') changes.staged++; if (line[3] !== '.') changes.unstaged++; }
    else if (line.startsWith('u ')) changes.conflicts++;
    else if (line.startsWith('? ')) changes.untracked++;
  }
  const remotes: GitOverview['remotes'] = [];
  for (const line of remotesOut.split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line);
    if (m && !remotes.some(r => r.name === m[1])) remotes.push({ name: m[1], url: m[2], ...(githubOf(m[2]) ? { web: githubOf(m[2])!.web } : {}) });
  }
  const gh = remotes.find(r => r.name === 'origin' && r.web) ?? remotes.find(r => r.web);
  const worktrees: GitWorktree[] = [];
  for (const block of worktreesOut.split('\n\n')) {
    const lines = block.split('\n');
    const path = lines.find(l => l.startsWith('worktree '))?.slice(9);
    if (!path) continue;
    worktrees.push({ path, hash: lines.find(l => l.startsWith('HEAD '))?.slice(5) ?? '', main: worktrees.length === 0,
      ...(lines.find(l => l.startsWith('branch ')) ? { branch: lines.find(l => l.startsWith('branch '))!.slice(7).replace(/^refs\/heads\//, '') } : {}),
      locked: lines.some(l => l.startsWith('locked')), prunable: lines.some(l => l.startsWith('prunable')) });
  }
  return { top, branch, head, ...(upstream ? { upstream } : {}), ahead, behind, changes, remotes, ...(gh ? { github: githubOf(gh.url)! } : {}), local, remote, worktrees, commits };
}

export async function gitCommit(top: string, hash: string): Promise<GitCommitDetail> {
  if (!/^[0-9a-f]{7,64}$/.test(hash)) throw new Error('Commit non valido');
  const out = await git(top, ['show', '--no-color', '--no-renames', '--diff-merges=first-parent', '--numstat', `--format=%H${US}%P${US}%an${US}%ae${US}%at${US}%B${RS}`, hash]);
  const [head, stat = ''] = out.split(RS);
  const [h, parents, author, email, date, message] = head.split(US);
  const files: GitCommitDetail['files'] = [];
  let total = 0;
  for (const line of stat.split('\n')) {
    const m = /^(-|\d+)\t(-|\d+)\t(.+)$/.exec(line);
    if (!m) continue;
    total++;
    if (files.length < 300) files.push({ path: join(top, m[3]), added: m[1] === '-' ? null : Number(m[1]), deleted: m[2] === '-' ? null : Number(m[2]) });
  }
  return { hash: h, parents: parents ? parents.split(' ') : [], author, email, date: Number(date) * 1000, message: (message ?? '').trim(), files, moreFiles: total - files.length };
}

/** Updates the remote-tracking branches of every remote. Fails rather than waiting for credentials. */
export async function gitFetch(top: string): Promise<void> {
  await git(top, ['fetch', '--all', '--prune', '--quiet'], 90_000);
}

/** Summary of a PR's checks: failure wins over pending, pending over success. */
export function checksOf(rollup: unknown): GithubPull['checks'] {
  if (!Array.isArray(rollup) || rollup.length === 0) return 'none';
  let pending = false;
  for (const c of rollup as Record<string, unknown>[]) {
    const v = String(c.conclusion ?? c.state ?? '').toUpperCase();
    const status = String(c.status ?? '').toUpperCase();
    if (['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(v)) return 'failure';
    if ((status && status !== 'COMPLETED') || v === 'PENDING' || v === 'EXPECTED' || v === '') pending = true;
  }
  return pending ? 'pending' : 'success';
}

const githubCache = new Map<string, { at: number; value: GithubState }>();

/** Open pull requests and recent workflow runs through `gh`; cached for a minute unless `fresh`. */
export async function githubState(repo: { owner: string; repo: string }, fresh = false): Promise<GithubState> {
  const key = `${repo.owner}/${repo.repo}`;
  const hit = githubCache.get(key);
  if (hit && !fresh && Date.now() - hit.at < 60_000) return hit.value;
  const gh = (args: string[]) => run('gh', [...args, '--repo', key], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024, env: gitEnv() }).then(r => JSON.parse(r.stdout));
  let value: GithubState;
  try {
    const [pulls, runs] = await Promise.all([
      gh(['pr', 'list', '--state', 'open', '--limit', '30', '--json', 'number,title,headRefName,baseRefName,author,isDraft,updatedAt,url,reviewDecision,statusCheckRollup']),
      gh(['run', 'list', '--limit', '15', '--json', 'databaseId,displayTitle,headBranch,workflowName,event,status,conclusion,createdAt,url']),
    ]);
    value = {
      state: 'ok', at: Date.now(),
      pulls: (pulls as Record<string, any>[]).map(p => ({ number: p.number, title: p.title, branch: p.headRefName, base: p.baseRefName, author: p.author?.login ?? '', draft: Boolean(p.isDraft), updatedAt: p.updatedAt, url: p.url, review: p.reviewDecision ?? '', checks: checksOf(p.statusCheckRollup) })),
      runs: (runs as Record<string, any>[]).map(r => ({ id: r.databaseId, title: r.displayTitle, branch: r.headBranch, workflow: r.workflowName, event: r.event, status: r.status, conclusion: r.conclusion ?? '', createdAt: r.createdAt, url: r.url })),
    };
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { stderr?: string };
    const text = String(e.stderr || e.message || e);
    value = e.code === 'ENOENT' ? { state: 'missing', message: 'GitHub CLI (gh) non installata' }
      : /auth login|not logged|authenticat/i.test(text) ? { state: 'signed-out', message: 'GitHub CLI non collegata: esegui gh auth login' }
      : { state: 'error', message: text.trim().split('\n')[0].slice(0, 300) };
  }
  githubCache.set(key, { at: Date.now(), value });
  return value;
}
