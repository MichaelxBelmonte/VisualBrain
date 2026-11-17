// Publishes a tested build as a public release and updates the feed that installed apps read.
//   node scripts/publish-release.mjs --zip FILE.zip [--notes "testo"] [--dry-run]   the package made here by `npm run package:mac`
//   node scripts/publish-release.mjs RUN_ID [--notes "testo"] [--dry-run]    a package built by GitHub Actions
// Since 0.2.45 only a package signed with the local identity passes: the workflow has no key, so its package is the test
// of the commit, not what gets published. A local package must come from a clean, pushed commit with a green build
// (scripts/release-guard.mjs); --allow-untested publishes anyway and says which checks failed.
// Needs `gh` logged in as the owner. A published version is never overwritten. The feed is signed here, on this Mac.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { UPDATE_PUBLIC_KEY } from '../src/server/update-key.ts';
import { UPDATE_REPO, forget, parseFeed } from '../src/server/updater.ts';
import { buildFeed, signFeed } from './make-feed.mjs';
import { verifyReleaseIdentity } from './local-signing.mjs';
import { sourceFacts, sourceProblems } from './release-guard.mjs';

const root = resolve(import.meta.dirname, '..');
const CODE_REPO = 'MichaelxBelmonte/VisualBrain';
const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const value = name => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const dry = flag('dry-run');
const gh = (...a) => execFileSync('gh', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const run = (file, a) => execFileSync(file, a, { stdio: 'inherit' });

let zip = value('zip') ? resolve(value('zip')) : null;
const work = join(root, '.build/publish'); rmSync(work, { recursive: true, force: true }); mkdirSync(work, { recursive: true });
if (!zip) {
  const runId = args.find(a => /^\d+$/.test(a));
  if (!runId) throw Error('Uso: node scripts/publish-release.mjs RUN_ID | --zip FILE.zip [--notes "testo"] [--dry-run]');
  const conclusion = JSON.parse(gh('run', 'view', runId, '-R', CODE_REPO, '--json', 'conclusion,headSha,workflowName')).conclusion;
  if (conclusion !== 'success') throw Error(`La build ${runId} non è riuscita (${conclusion}).`);
  gh('release', 'download', `build-${runId}`, '-R', CODE_REPO, '-D', work); // the workflow keeps the package in a private draft release
  zip = join(work, readdirSync(work).find(n => /^Visual-Brain-.*-mac-universal\.zip$/.test(n)) ?? '');
}
const name = zip.split('/').pop();
const version = /^Visual-Brain-([0-9.]+)-mac-universal\.zip$/.exec(name)?.[1];
if (!version) throw Error(`Pacchetto inatteso: ${name}`);

// Checks before anything becomes public: checksum file, signature, bundle identity and version.
const hash = createHash('sha256').update(readFileSync(zip)).digest('hex');
try { const expected = readFileSync(`${zip}.sha256`, 'utf8').split(/\s+/)[0]; if (expected !== hash) throw Error('SHA256 diverso da quello della build.'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const probe = join(work, 'probe'); mkdirSync(probe, { recursive: true });
run('/usr/bin/ditto', ['-x', '-k', zip, probe]);
const app = join(probe, 'Visual Brain.app');
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
verifyReleaseIdentity(root, app);
const plist = key => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print ${key}`, join(app, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
if (plist('CFBundleIdentifier') !== 'com.jethr.visualbrain' || plist('CFBundleShortVersionString') !== version) throw Error('L’app nel pacchetto non corrisponde alla versione del nome.');
await forget(probe); // the extracted copy leaves Launch Services and the disk: no "forbidden" icon in Launchpad
const pkgVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
if (!zip.startsWith(work) && pkgVersion !== version) throw Error(`package.json è ${pkgVersion}, il pacchetto ${version}.`);
if (!zip.startsWith(work)) {
  const problems = sourceProblems(sourceFacts(root, zip, hash, CODE_REPO));
  if (problems.length && !flag('allow-untested')) throw Error(`Il pacchetto non è pronto per la pubblicazione:\n- ${problems.join('\n- ')}`);
  for (const problem of problems) console.warn(`ATTENZIONE (--allow-untested): ${problem}`);
}

let exists = true;
try { gh('release', 'view', `v${version}`, '-R', UPDATE_REPO); } catch { exists = false; }
if (exists) throw Error(`La versione v${version} è già pubblicata: non si sovrascrive. Aumenta la versione.`);

const pem = process.env.VB_UPDATE_PRIVATE_KEY || readFileSync(join(root, '.release-keys/update-private.pem'), 'utf8');
const { text, signature } = signFeed(buildFeed(zip, value('notes') ?? `Visual Brain ${version}`), pem);
const feedDir = join(work, 'feed'); mkdirSync(feedDir, { recursive: true });
writeFileSync(join(feedDir, 'latest.json'), text); writeFileSync(join(feedDir, 'latest.json.sig'), signature + '\n');
writeFileSync(join(feedDir, `${name}.sha256`), `${hash}  ${name}\n`);
console.log(`Pronto: ${name} (${(readFileSync(zip).length / 1e6).toFixed(1)} MB), sha256 ${hash.slice(0, 12)}…`);
if (dry) { console.log('Prova: nessuna pubblicazione.'); process.exit(0); }

gh('release', 'create', `v${version}`, '-R', UPDATE_REPO, '--title', `Visual Brain ${version}`, '--notes', value('notes') ?? `Visual Brain ${version}`, '--latest', zip, join(feedDir, `${name}.sha256`), join(feedDir, 'latest.json'), join(feedDir, 'latest.json.sig'));

// The feed an installed app would read, fetched without authentication, must verify and announce this version.
const url = `https://github.com/${UPDATE_REPO}/releases/latest/download/latest.json`;
let verified = null;
for (let i = 0; i < 10 && !verified; i++) {
  try {
    const [t, s] = await Promise.all([fetch(url).then(r => r.text()), fetch(`${url}.sig`).then(r => r.text())]);
    const feed = parseFeed(t, s, UPDATE_PUBLIC_KEY);
    if (feed.version === version) verified = feed;
  } catch { /* CDN may need a moment */ }
  if (!verified) await new Promise(r => setTimeout(r, 3000));
}
if (!verified) throw Error('Release pubblicata, ma il feed pubblico non risulta ancora valido: ricontrolla tra poco.');
console.log(`Pubblicata v${version} e feed verificato: https://github.com/${UPDATE_REPO}/releases/tag/v${version}`);
