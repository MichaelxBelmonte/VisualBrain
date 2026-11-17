// Optional Git worktree per operator: own checkout and branch, created in the profile, removed only when nothing would be lost.
// Uso: node scripts/test-worktrees.mjs — repository Git temporaneo, nessun agente.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWorktree, removeWorktree, worktreesDir } from '../src/server/worktrees.ts';
import { Teams } from '../src/server/team.ts';
import { startSession } from '../src/server/sessions.ts';
import { DEFAULTS } from '../src/server/config.ts';

const temp = realpathSync(mkdtempSync(join(tmpdir(), 'vb-worktrees-')));
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
try {
  const data = join(temp, 'profile'), repo = join(temp, 'repo'), plain = join(temp, 'plain'), empty = join(temp, 'empty');
  for (const dir of [data, join(repo, 'app/src'), plain, empty]) mkdirSync(dir, { recursive: true });
  git(repo, 'init', '-q'); writeFileSync(join(repo, 'app/src/a.txt'), 'a'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'first');
  git(empty, 'init', '-q');

  assert.equal(await createWorktree(data, 5, 'OP1', plain), null, 'outside Git the session shares the folder');
  assert.equal(await createWorktree(data, 5, 'OP1', empty), null, 'a repository without commits has nothing to branch from');

  const one = await createWorktree(data, 5, 'OP1', join(repo, 'app'));
  assert.equal(one.path, join(worktreesDir(data), '5/op1'));
  assert.equal(one.cwd, join(one.path, 'app'), 'the session starts in the same subfolder of its checkout');
  assert.equal(one.branch, 'visual-brain/n5-op1');
  assert.equal(git(one.path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'visual-brain/n5-op1');
  assert.ok(existsSync(join(one.cwd, 'src/a.txt')));
  assert.equal(git(repo, 'status', '--porcelain'), '', 'the project folder gets nothing new');
  const two = await createWorktree(data, 5, 'OP1', repo);
  assert.equal(two.branch, 'visual-brain/n5-op1-2', 'an existing worktree or branch is never reused');
  console.log('PASS worktree per operator: own branch from HEAD, same subfolder, in the profile; plain folders and empty repositories share');

  writeFileSync(join(one.cwd, 'draft.txt'), 'uncommitted');
  assert.equal(await removeWorktree(data, one.cwd), false, 'untracked work keeps the worktree');
  assert.ok(existsSync(one.path));
  git(one.path, 'add', '.'); git(one.path, 'commit', '-qm', 'work');
  assert.equal(await removeWorktree(data, one.cwd), true);
  assert.equal(existsSync(one.path), false);
  assert.match(git(repo, 'log', '--oneline', 'visual-brain/n5-op1'), /work/, 'the branch and its commits stay');
  assert.equal(await removeWorktree(data, repo), false, 'folders outside the profile worktrees are never touched');
  assert.equal(await removeWorktree(data, worktreesDir(data)), false);
  assert.ok(existsSync(join(repo, 'app/src/a.txt')));
  console.log('PASS closing removes a worktree only without losses, keeps the branch, never touches other folders');

  const teams = new Teams(join(temp, 'teams'));
  assert.equal(teams.get(9).policy.worktrees, undefined, 'off by default');
  assert.equal(teams.update(9, { worktrees: true }).policy.worktrees, true);
  assert.throws(() => teams.update(9, { worktrees: 'yes' }), /worktrees non valido/);
  console.log('PASS worktree policy per node, off by default and validated');

  // A launch on a node with the policy: the operator starts in its checkout and is told its branch; the orchestrator is told to merge.
  const spawned = [];
  const terms = { list: () => spawned.map(o => ({ id: o.id, nodeId: o.nodeId, agent: o.agent, role: o.role, alive: true, cwd: o.cwd, createdAt: 1 })), get: () => undefined,
    spawn(opts) { spawned.push(opts); return { info: { id: opts.id, cwd: opts.cwd, branch: opts.branch, role: opts.role } }; } };
  const ctx = { terms, teams, cfg: { ...DEFAULTS, language: 'it', dataDir: data }, cache: { nodes: new Map() } };
  const detail = { id: 9, kind: 'dir', path: repo, name: 'repo', bytes: 0, files: 1, cls: 'project', edges: [], children: [], notes: [], neighbors: [] };
  await startSession(ctx, detail, { id: 9, mode: 'embedded', agent: 'claude', role: 'orchestrator' });
  assert.equal(spawned[0].cwd, repo, 'the orchestrator stays in the project');
  assert.match(spawned[0].args.join(' '), /worktree Git/);
  await startSession(ctx, detail, { id: 9, mode: 'embedded', agent: 'claude', role: 'operator' });
  assert.equal(spawned[1].cwd, join(worktreesDir(data), '9/op1'));
  assert.equal(spawned[1].branch, 'visual-brain/n9-op1');
  assert.match(spawned[1].args.join(' '), /sul ramo visual-brain\/n9-op1/);
  teams.update(9, { worktrees: false });
  await startSession(ctx, detail, { id: 9, mode: 'embedded', agent: 'claude', role: 'operator' });
  assert.equal(spawned[2].cwd, repo, 'without the policy operators share the project folder');
  console.log('PASS launch: operators start in their worktree and know their branch, the orchestrator merges, the policy can be turned off');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
