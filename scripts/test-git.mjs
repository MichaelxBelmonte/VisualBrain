// The Git tab: lane layout and badges, GitHub remotes and checks, a real temporary repository through the server and the route.
// Uso: node scripts/test-git.mjs — repository temporaneo, nessuna rete, nessun gh.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { graphRows, refBadges, rowSegments } from '../src/ui/git-graph.ts';
import { checksOf, gitCommit, gitLog, gitOverview, gitTop, githubOf } from '../src/server/git.ts';
import { handleApi } from '../src/server/api.ts';

// main: A ← B ← M(merge of F), feature: A ← F. Newest first, as git log --date-order lists them.
const commits = [
  { hash: 'M', parents: ['B', 'F'] },
  { hash: 'F', parents: ['A'] },
  { hash: 'B', parents: ['A'] },
  { hash: 'A', parents: [] },
];
const rows = graphRows(commits);
assert.deepEqual(rows.map(r => r.col), [0, 1, 0, 0], 'the merged branch gets its own lane and the first parent keeps the main one');
assert.deepEqual(rows[0].bottom, ['B', 'F']);
assert.deepEqual(rows[1].bottom, ['B', 'A']);
assert.deepEqual(rows[3].bottom, [], 'the root closes every lane');
assert.deepEqual(rowSegments(rows[0], commits[0].parents, 'M'), [{ x1: 0, y1: 0.5, x2: 0, y2: 1, lane: 0 }, { x1: 0, y1: 0.5, x2: 1, y2: 1, lane: 1 }], 'a merge opens a line to each parent');
assert.deepEqual(rowSegments(rows[3], [], 'A'), [{ x1: 0, y1: 0, x2: 0, y2: 0.5, lane: 0 }, { x1: 1, y1: 0, x2: 0, y2: 0.5, lane: 1 }], 'both branches end in their fork point');
assert.ok(rowSegments(rows[2], ['A'], 'B').some(s => s.x1 === 1 && s.x2 === 1 && s.y1 === 0 && s.y2 === 1), 'a lane passing a row stays straight');
// Two unrelated tips: the second takes a fresh lane, and a freed lane is reused.
assert.deepEqual(graphRows([{ hash: 'X', parents: [] }, { hash: 'Y', parents: ['Z'] }, { hash: 'Z', parents: [] }]).map(r => r.col), [0, 0, 0]);
assert.deepEqual(refBadges(['HEAD -> main', 'origin/main', 'tag: v1', 'feature/x', 'upstream/dev'], ['origin', 'upstream']).map(b => `${b.kind}:${b.text}`),
  ['head:main', 'remote:origin/main', 'tag:v1', 'local:feature/x', 'remote:upstream/dev']);
console.log('PASS graph: lanes for branches and merges, straight pass-through lines, badges for head, local, remote and tags');

for (const [url, web] of [
  ['git@github.com:acme/app.git', 'https://github.com/acme/app'],
  ['https://github.com/acme/app', 'https://github.com/acme/app'],
  ['https://token@github.com/acme/my.repo.git', 'https://github.com/acme/my.repo'],
  ['ssh://git@github.com/acme/app.git/', 'https://github.com/acme/app'],
]) assert.equal(githubOf(url)?.web, web, url);
for (const url of ['https://gitlab.com/acme/app.git', 'https://github.com.evil.io/acme/app', 'git@github.com:acme/app/extra', '/tmp/repo']) assert.equal(githubOf(url), undefined, url);
assert.equal(checksOf([]), 'none');
assert.equal(checksOf([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { state: 'SUCCESS' }]), 'success');
assert.equal(checksOf([{ status: 'IN_PROGRESS', conclusion: '' }, { status: 'COMPLETED', conclusion: 'SUCCESS' }]), 'pending');
assert.equal(checksOf([{ status: 'IN_PROGRESS' }, { status: 'COMPLETED', conclusion: 'FAILURE' }]), 'failure', 'a failure wins over pending');
console.log('PASS GitHub: SSH and HTTPS remotes recognised, other hosts refused; check summaries');

const temp = realpathSync(mkdtempSync(join(tmpdir(), 'vb-git-')));
try {
  const repo = join(temp, 'repo');
  const g = (...args) => execFileSync('git', ['-C', repo, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 'Prova', GIT_AUTHOR_EMAIL: 'p@example.com', GIT_COMMITTER_NAME: 'Prova', GIT_COMMITTER_EMAIL: 'p@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).toString().trim();
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  assert.deepEqual(await gitLog(repo), [], 'a repository without commits has an empty log');
  writeFileSync(join(repo, 'a.txt'), 'uno\n'); g('add', '.'); g('commit', '-qm', 'Primo');
  g('switch', '-qc', 'feature');
  writeFileSync(join(repo, 'b.txt'), 'due\ntre\n'); g('add', '.'); g('commit', '-qm', 'Feature');
  g('switch', '-q', 'main');
  writeFileSync(join(repo, 'a.txt'), 'uno\nquattro\n'); g('commit', '-qam', 'Secondo');
  g('merge', '-q', '--no-ff', '-m', 'Merge feature', 'feature');
  g('tag', 'v1');
  g('remote', 'add', 'origin', 'git@github.com:acme/app.git');
  writeFileSync(join(repo, 'a.txt'), 'cambiato\n'); writeFileSync(join(repo, 'nuovo.txt'), 'x\n');
  writeFileSync(join(repo, 'b.txt'), 'staged\n'); g('add', 'b.txt');

  assert.equal(await gitTop(join(repo)), repo);
  assert.equal(await gitTop(temp), null, 'a folder outside any repository');
  const o = await gitOverview(repo);
  assert.equal(o.branch, 'main'); assert.equal(o.head, g('rev-parse', 'HEAD'));
  assert.deepEqual(o.changes, { staged: 1, unstaged: 1, untracked: 1, conflicts: 0 });
  assert.deepEqual(o.github, { owner: 'acme', repo: 'app', web: 'https://github.com/acme/app' });
  assert.deepEqual(o.local.map(b => b.name).sort(), ['feature', 'main']);
  assert.equal(o.local.find(b => b.current)?.name, 'main');
  assert.equal(o.worktrees.length, 1); assert.equal(o.worktrees[0].main, true); assert.equal(o.worktrees[0].branch, 'main');
  assert.deepEqual(o.commits.map(c => c.subject), ['Merge feature', 'Secondo', 'Feature', 'Primo']);
  assert.deepEqual(o.commits[0].refs, ['HEAD -> main', 'tag: v1']);
  assert.equal(o.commits[0].parents.length, 2);
  assert.deepEqual(graphRows(o.commits).map(r => r.col), [0, 0, 1, 0], 'the real log lays out as a merge');

  const merge = await gitCommit(repo, o.commits[0].hash.slice(0, 10));
  assert.equal(merge.message, 'Merge feature');
  assert.deepEqual(merge.files.map(f => [f.path, f.added, f.deleted]), [[join(repo, 'b.txt'), 2, 0]], 'a merge shows what it brought into the first parent');
  const second = await gitCommit(repo, o.commits[1].hash);
  assert.deepEqual(second.files.map(f => [f.path, f.added, f.deleted]), [[join(repo, 'a.txt'), 1, 0]]);
  await assert.rejects(gitCommit(repo, 'HEAD~1'), /non valido/, 'only hashes, never revisions or options');
  console.log('PASS repository: branch, changes, GitHub remote, branches, worktree, log with refs and merge, commit files');

  // The route, as the interface calls it.
  const ctx = {
    cache: { nodes: new Map([[1, { id: 1, kind: 'dir', path: repo }], [2, { id: 2, kind: 'dir', path: temp }], [3, { id: 3, kind: 'file', path: join(repo, 'a.txt') }]]) },
    db: { all: () => [{ id: 3, path: join(repo, 'a.txt') }] },
    terms: { list: () => [{ id: 's1', agent: 'claude', branch: 'feature', alive: true }, { id: 's2', agent: 'shell', branch: 'main', alive: true }] },
    teams: { withCodes: list => list.map(s => ({ ...s, code: 'OP1' })) },
  };
  const call = async (method, path, body, headers = {}) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]); req.method = method; req.url = path; req.headers = headers;
    let status, response; await handleApi(ctx, req, { writeHead(code) { status = code; }, end(text) { response = JSON.parse(text); } });
    return { status, body: response };
  };
  const view = await call('GET', '/api/git/3');
  assert.equal(view.status, 200); assert.equal(view.body.repo.top, repo, 'a file shows the repository it is in');
  assert.deepEqual(view.body.agents, { feature: { id: 's1', code: 'OP1', alive: true } }, 'agent branches, not shells');
  assert.deepEqual((await call('GET', '/api/git/2')).body, { repo: null });
  assert.equal((await call('GET', '/api/git/99')).status, 404);
  const detail = await call('GET', `/api/git/1/commit/${o.commits[1].hash}`);
  assert.equal(detail.body.files[0].nodeId, 3, 'files still in the map can be opened there');
  assert.equal((await call('GET', '/api/git/1/commit/zzz')).status, 404);
  for (const url of ['https://github.com/acme/application', 'https://evil.io/acme/app', 'https://github.com/acme/app/pulls" onload', 'file:///etc/passwd'])
    assert.equal((await call('POST', '/api/git/1/open', { url })).status, 400, url);
  assert.equal((await call('POST', '/api/git/1/open', { url: 'https://github.com/acme/app' }, { authorization: 'Bearer x' })).status, 403, 'agents cannot open pages');
  assert.equal((await call('POST', '/api/git/1/fetch', {}, { authorization: 'Bearer x' })).status, 403, 'agents cannot fetch');
  console.log('PASS route: repository of a folder or file, agent branches, no repository, commit files linked to the map, open limited to the repository on GitHub, interface only');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
