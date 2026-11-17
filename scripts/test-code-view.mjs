// The Dev tab's code: a repository's files and states, one file (text, binary, oversized, secret), changes, text search,
// paths kept inside the repository; and the explorer's helpers. Uso: node scripts/test-code-view.mjs — repository temporaneo.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_FILE, codeDiff, codeFile, codeSearch, codeTree, insideRepo } from '../src/server/code.ts';
import { buildTree, languageOf, matchFiles } from '../src/ui/code-view.ts';

const temp = realpathSync(mkdtempSync(join(tmpdir(), 'vb-code-')));
const secrets = ['.env', '.env.*', '*.pem', 'id_rsa*'];
try {
  const top = join(temp, 'repo');
  const git = (...args) => execFileSync('git', ['-C', top, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  const write = (rel, data) => { mkdirSync(join(top, rel, '..'), { recursive: true }); writeFileSync(join(top, rel), data); };
  mkdirSync(top); git('init', '-q', '-b', 'main');
  write('src/app.ts', 'export const answer = 42;\n');
  write('src/old.ts', 'export const old = 1;\n');
  write('README.md', '# Progetto\nUsa la funzione Answer.\n');
  write('.gitignore', 'dist/\n');
  git('add', '.'); git('commit', '-q', '-m', 'primo');
  write('src/app.ts', 'export const answer = 43;\n');               // modified
  rmSync(join(top, 'src/old.ts'));                                  // deleted
  write('src/new.ts', 'export const fresh = true;\n');              // untracked
  write('dist/bundle.js', 'ignored();\n');                          // ignored
  write('.env', 'TOKEN=segreto\n');
  write('logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]));
  write('big.txt', 'x'.repeat(MAX_FILE + 1));
  writeFileSync(join(temp, 'outside.txt'), 'fuori\n');
  symlinkSync(join(temp, 'outside.txt'), join(top, 'escape.txt'));

  const tree = await codeTree(top);
  assert.equal(tree.top, top); assert.equal(tree.branch, 'main'); assert.equal(tree.truncated, false);
  for (const f of ['src/app.ts', 'src/old.ts', 'src/new.ts', 'README.md', '.env']) assert.ok(tree.files.includes(f), f);
  assert.ok(!tree.files.includes('dist/bundle.js'), 'ignored files are not listed');
  assert.equal(tree.states['src/app.ts'], 'M'); assert.equal(tree.states['src/old.ts'], 'D'); assert.equal(tree.states['src/new.ts'], 'U');
  assert.equal(tree.states['README.md'], undefined);
  console.log('PASS tree: tracked and untracked files without ignored ones, branch, modified/deleted/untracked states');

  assert.equal((await codeFile(top, 'src/app.ts', secrets)).text, 'export const answer = 43;\n');
  assert.deepEqual(Object.keys(await codeFile(top, '.env', secrets)).sort(), ['mtime', 'path', 'secret', 'size']);
  assert.equal((await codeFile(top, '.env', secrets, true)).text, 'TOKEN=segreto\n', 'shown when asked');
  assert.equal((await codeFile(top, 'logo.png', secrets)).binary, true);
  assert.equal((await codeFile(top, 'big.txt', secrets)).tooLarge, true);
  for (const bad of ['../outside.txt', '/etc/passwd', 'src/../../outside.txt', 'escape.txt', '']) await assert.rejects(codeFile(top, bad, secrets), /Percorso|ENOENT/, bad);
  await assert.rejects(codeFile(top, 'src', secrets), /Non è un file/);
  await assert.rejects(insideRepo(top, 'src/old.ts'), /ENOENT/);
  console.log('PASS file: text, secret only on request, binary, oversized; absolute paths, .. and a symbolic link out of the repository refused');

  assert.match((await codeDiff(top, 'src/app.ts')).diff, /-export const answer = 42;\n\+export const answer = 43;/);
  assert.match((await codeDiff(top, 'src/old.ts')).diff, /deleted file mode/);
  assert.equal((await codeDiff(top, 'README.md')).diff, '');
  await assert.rejects(codeDiff(top, '../outside.txt'), /Percorso/);
  console.log('PASS diff: changes against HEAD, a deleted file too, nothing for an unchanged one');

  const found = await codeSearch(top, 'ANSWER');
  assert.deepEqual(found.hits.map(h => `${h.path}:${h.line}`).sort(), ['README.md:2', 'src/app.ts:1']);
  assert.ok(!(await codeSearch(top, 'ignored')).hits.length, 'ignored files are not searched');
  assert.ok((await codeSearch(top, 'fresh')).hits.some(h => h.path === 'src/new.ts'), 'untracked files are');
  assert.deepEqual(await codeSearch(top, 'x'), { hits: [], truncated: false });
  assert.deepEqual((await codeSearch(top, '-e nothing')).hits, [], 'the query is text, never an option');
  console.log('PASS search: case-insensitive text in tracked and untracked files, never in ignored ones');

  const files = ['code/notes.txt', 'src/ui/code-view.ts', 'src/server/code.ts', 'README.md', 'docs/CODE.md'];
  // a hit in the name before one only in the folders, then the shorter path
  assert.deepEqual(matchFiles(files, 'code'), ['docs/CODE.md', 'src/server/code.ts', 'src/ui/code-view.ts', 'code/notes.txt']);
  assert.deepEqual(matchFiles(files, 'uicv'), ['src/ui/code-view.ts'], 'letters in order, gaps allowed');
  const t = buildTree(files);
  assert.deepEqual([...t.dirs.keys()].sort(), ['code', 'docs', 'src']); assert.deepEqual(t.files, ['README.md']);
  assert.deepEqual(t.dirs.get('src').dirs.get('ui').files, ['code-view.ts']);
  assert.equal(languageOf('a/b.tsx'), 'typescript'); assert.equal(languageOf('Dockerfile'), 'dockerfile'); assert.equal(languageOf('.env'), 'ini'); assert.equal(languageOf('LICENSE'), null);
  console.log('PASS explorer: name search ranks a hit in the file name first, folders from paths, languages by name');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
