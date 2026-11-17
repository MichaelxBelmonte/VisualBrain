// A local package is published only from a clean, pushed commit with a green build.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceProblems, sourceState } from './release-guard.mjs';

const head = 'a'.repeat(40), other = 'b'.repeat(40);
const archive = 'Visual-Brain-9.9.9-mac-universal.zip', sha256 = 'c'.repeat(64);
const good = { build: { archive, sha256, commit: head, dirty: false }, archive, sha256, head, dirty: false, pushed: true, ci: 'success' };
const problems = change => sourceProblems({ ...good, ...change });

assert.deepEqual(problems({}), []);
assert.match(problems({ build: null })[0], /Manca build\.json/);
assert.match(problems({ build: { ...good.build, sha256: 'd'.repeat(64) } })[0], /un altro pacchetto/);
// a package made before the commit was recorded cannot prove where it comes from
assert.match(problems({ build: { archive, sha256 } })[0], /non dichiara il commit/);
assert.match(problems({ build: { ...good.build, commit: other } })[0], /viene dal commit bbbbbbb, ma qui c’è aaaaaaa/);
// the 0.2.49 case: packaged before the release commit, published before the workflow ran, tests failed afterwards
const as0249 = problems({ build: { ...good.build, dirty: true }, pushed: false, ci: 'failure' });
assert.equal(as0249.length, 3);
assert.match(as0249[0], /creato con modifiche non ancora in git/);
assert.match(as0249[1], /non è su origin/);
assert.match(as0249[2], /non è riuscito sul commit aaaaaaa \(failure\)/);
assert.match(problems({ dirty: true })[0], /La cartella ha modifiche/);
assert.match(problems({ ci: 'in_progress' })[0], /in_progress/);
assert.match(problems({ ci: 'nessuna build' })[0], /nessuna build/);

// the state package-mac records: commit and whether anything is uncommitted; unknown outside a checkout
const repo = mkdtempSync(join(tmpdir(), 'vb-release-guard-'));
try {
  assert.deepEqual(sourceState(repo), { commit: null, dirty: null });
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
  git('init', '-q'); writeFileSync(join(repo, 'a.txt'), 'a');
  git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'one');
  const clean = sourceState(repo);
  assert.match(clean.commit, /^[0-9a-f]{40}$/); assert.equal(clean.dirty, false);
  writeFileSync(join(repo, 'a.txt'), 'b');
  assert.deepEqual(sourceState(repo), { commit: clean.commit, dirty: true });
} finally { rmSync(repo, { recursive: true, force: true }); }

console.log('PASS release guard: a local package is published only from a clean, pushed commit with a green build');
