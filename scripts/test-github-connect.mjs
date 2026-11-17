// Real Git against temporary file remotes; fake gh, no account, credential or network access.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, symlinkSync, lstatSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { connectGithub, githubRepositories } from '../src/server/github-connect.ts';
const temp = realpathSync(mkdtempSync(join(tmpdir(), 'vb-github-')));
const savedEnv = { ...process.env };
try {
  const bin = join(temp, 'bin'), source = join(temp, 'source'), remote = join(temp, 'remote.git');
  mkdirSync(bin); mkdirSync(source);
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: join(temp, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' });
  process.env.PATH = `${bin}:${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin:${homedir()}/.local/bin`;
  writeFileSync(join(bin, 'gh'), `#!${process.execPath}\nconst a=process.argv.slice(2); if(a[0]==='--version') console.log('gh fixture'); else if(a[0]==='auth') process.exit(process.env.FAKE_SIGNED_OUT ? 1 : 0); else if(a.includes('user')) console.log('fixture'); else if(a.some(v=>v.startsWith('user/repos?'))) console.log(JSON.stringify([{full_name:'fixture/project',private:true}])); else if(a.includes('repos/fixture/project')) console.log(JSON.stringify({full_name:'fixture/project',default_branch:'main',size:1})); else process.exit(2);\n`, { mode: 0o700 });
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(source, 'init', '-q', '-b', 'main'); mkdirSync(join(source, 'src'));
  writeFileSync(join(source, 'src', 'app.ts'), 'original\n'); writeFileSync(join(source, 'README.md'), '# Fixture\n');
  git(source, 'add', '.'); git(source, 'commit', '-qm', 'initial');
  execFileSync('git', ['clone', '--bare', source, remote], { stdio: 'ignore' });
  writeFileSync(process.env.GIT_CONFIG_GLOBAL, `[url "file://${remote}"]\n\tinsteadOf = https://github.com/fixture/project.git\n[protocol "file"]\n\tallow = always\n`);
  assert.deepEqual((await githubRepositories(1)).repos, [{ name: 'fixture/project', private: true }]);
  process.env.FAKE_SIGNED_OUT = '1'; assert.equal((await githubRepositories(1)).state, 'signed-out'); delete process.env.FAKE_SIGNED_OUT;
  const fresh = join(temp, 'fresh'); mkdirSync(fresh);
  await connectGithub(fresh, 'fixture/project');
  assert.equal(readFileSync(join(fresh, 'src/app.ts'), 'utf8'), 'original\n');
  assert.equal(git(fresh, 'status', '--porcelain'), '');
  assert.equal(git(fresh, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/main');

  // An existing project with no Git metadata must keep local edits, copy missing files, and gain a Git baseline.
  const populated = join(temp, 'populated'); mkdirSync(populated); mkdirSync(join(populated, 'src'));
  writeFileSync(join(populated, 'src/app.ts'), 'local edit\n'); writeFileSync(join(populated, 'notes.txt'), 'local only');
  assert.equal((await connectGithub(populated, 'fixture/project')).localChanges, true);
  assert.equal(readFileSync(join(populated, 'src/app.ts'), 'utf8'), 'local edit\n');
  assert.equal(readFileSync(join(populated, 'README.md'), 'utf8'), '# Fixture\n');
  assert.equal(readFileSync(join(populated, 'notes.txt'), 'utf8'), 'local only');
  assert.match(git(populated, 'diff'), /local edit/);
  await assert.rejects(connectGithub(populated, 'fixture/project'), /commit prima/);

  // A local directory symlink cannot redirect checkout outside the selected project.
  const linked = join(temp, 'linked'), outside = join(temp, 'outside'); mkdirSync(linked); mkdirSync(outside);
  writeFileSync(join(outside, 'sentinel'), 'untouched'); symlinkSync(outside, join(linked, 'src'));
  await connectGithub(linked, 'fixture/project').catch(() => {});
  assert.equal(readFileSync(join(outside, 'sentinel'), 'utf8'), 'untouched');
  assert.throws(() => readFileSync(join(outside, 'app.ts')), /ENOENT/);
  assert.ok(lstatSync(join(linked, 'src')).isSymbolicLink(), 'existing directory symlink is preserved');

  writeFileSync(join(source, 'update.txt'), 'remote update'); git(source, 'add', '.'); git(source, 'commit', '-qm', 'remote update'); git(source, 'push', remote, 'main');
  await connectGithub(fresh, 'fixture/project'); assert.equal(readFileSync(join(fresh, 'update.txt'), 'utf8'), 'remote update');
  writeFileSync(join(fresh, 'publish.txt'), 'local commit'); git(fresh, 'add', '.'); git(fresh, 'commit', '-qm', 'publish');
  await connectGithub(fresh, 'fixture/project', true); assert.equal(git(remote, 'rev-parse', 'main'), git(fresh, 'rev-parse', 'HEAD'));
  writeFileSync(join(source, 'divergent.txt'), 'different history'); git(source, 'add', '.'); git(source, 'commit', '-qm', 'diverge'); git(source, 'push', remote, 'main:other');
  const oldHead = git(fresh, 'rev-parse', 'HEAD');
  // Make the default remote diverge without touching the local checkout (fixture only).
  git(remote, 'update-ref', 'refs/heads/main', git(source, 'rev-parse', 'HEAD'));
  await assert.rejects(connectGithub(fresh, 'fixture/project'), /cronologie divergenti/);
  assert.equal(git(fresh, 'rev-parse', 'HEAD'), oldHead);
  assert.equal(readFileSync(join(fresh, 'publish.txt'), 'utf8'), 'local commit');
  git(fresh, 'remote', 'set-url', 'origin', 'https://github.com/different/project.git');
  await assert.rejects(connectGithub(fresh, 'fixture/project'), /altro origin/);
  assert.equal(git(fresh, 'remote', 'get-url', 'origin'), 'https://github.com/different/project.git');
  await assert.rejects(connectGithub(fresh, '--upload/evil'), /non valido/);
  console.log('PASS GitHub account/list; initial linking of empty and populated folders; local preservation; symlink containment; fast-forward and explicit push; dirty and mismatched origin rejected');
} finally {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv); rmSync(temp, { recursive: true, force: true });
}
