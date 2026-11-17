// What a local package must prove before it becomes public: it was built from a clean, pushed commit that the build
// workflow has tested. 0.2.49 was packaged from files not yet committed and published five seconds before its tag
// reached the workflow, where the tests then failed: the public package matched no tested commit.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** The commit a package is built from, recorded in release/build.json. Outside a git checkout both are unknown. */
export function sourceState(root) {
  try { return { commit: git(root, 'rev-parse', 'HEAD'), dirty: git(root, 'status', '--porcelain') !== '' }; }
  catch { return { commit: null, dirty: null }; }
}

/** Pure: the reasons this package must not be published; empty when it may. */
export function sourceProblems({ build, archive, sha256, head, dirty, pushed, ci }) {
  const short = sha => String(sha).slice(0, 7);
  if (!build) return ['Manca build.json accanto al pacchetto: ricrealo con `npm run package:mac`.'];
  const problems = [];
  if (build.archive !== archive || build.sha256 !== sha256) problems.push('build.json descrive un altro pacchetto: ricrealo con `npm run package:mac`.');
  if (!build.commit) problems.push('Il pacchetto non dichiara il commit da cui è stato creato: ricrealo con `npm run package:mac`.');
  else if (build.commit !== head) problems.push(`Il pacchetto viene dal commit ${short(build.commit)}, ma qui c’è ${short(head)}: ricrealo da questo commit.`);
  if (build.dirty) problems.push('Il pacchetto è stato creato con modifiche non ancora in git: fai il commit e ricrealo.');
  if (dirty) problems.push('La cartella ha modifiche non ancora in git: fai il commit (o mettile da parte) prima di pubblicare.');
  if (!pushed) problems.push(`Il commit ${short(head)} non è su origin: fai il push.`);
  if (ci !== 'success') problems.push(`Il workflow Build Visual Brain non è riuscito sul commit ${short(head)} (${ci}): aspetta una build verde.`);
  return problems;
}

/** Reads the same facts from the package folder, git and GitHub. */
export function sourceFacts(root, zip, sha256, repo) {
  let build = null;
  try { build = JSON.parse(readFileSync(join(dirname(zip), 'build.json'), 'utf8')); } catch { /* reported as missing */ }
  const { commit: head, dirty } = sourceState(root);
  let pushed = false, ci = 'nessuna build';
  try { pushed = git(root, 'branch', '-r', '--contains', head).split('\n').some(line => line.trim().startsWith('origin/')); } catch { /* not pushed */ }
  try {
    const runs = JSON.parse(execFileSync('gh', ['run', 'list', '-R', repo, '--workflow', 'build.yml', '--commit', head, '--json', 'status,conclusion', '-L', '20'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    if (runs.some(r => r.conclusion === 'success')) ci = 'success';
    else if (runs.length) ci = runs[0].conclusion || runs[0].status;
  } catch (e) { ci = `gh: ${String(e.stderr || e.message).trim().split('\n')[0]}`; }
  return { build, archive: zip.split('/').pop(), sha256, head, dirty, pushed, ci };
}
