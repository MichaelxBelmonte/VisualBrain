import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync, cpSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { localSigning, unlockLocalSigning, signLocal } from './local-signing.mjs';
import { sourceState } from './release-guard.mjs';
const root = resolve(import.meta.dirname, '..');
const arch = process.argv.find(a => a.startsWith('--arch='))?.split('=')[1] || 'universal';
// --trial: a separate test package. Own app name, own target dir, own output folder (release-trial/); the regular
// release/ files, the installed app and the previous build output are never touched. The native engine runs in `auto`.
const trial = process.argv.includes('--trial');
const targetOverride = process.argv.find(a => a.startsWith('--target-dir='))?.slice('--target-dir='.length);
const target = { arm64: 'aarch64-apple-darwin', x64: 'x86_64-apple-darwin', universal: 'universal-apple-darwin' }[arch];
if (!target || process.platform !== 'darwin') throw Error('Build this package on macOS; use --arch=arm64|x64|universal.');
const run = (file, args, cwd = root) => execFileSync(file, args, { cwd, stdio: 'inherit' });
// Read before anything is built: publish-release refuses a package that does not come from a clean commit.
const source = sourceState(root);
run(process.execPath, ['scripts/build-ui.mjs']);
const appName = trial ? 'Visual Brain Trial' : 'Visual Brain';
// An isolated target also lets us prepare an update while an older development bundle is still running.
const targetDir = targetOverride ? resolve(root, targetOverride) : trial ? join(root, '.build/trial-target') : join(root, 'app/src-tauri/target');
run(process.execPath, ['scripts/prepare-runtime.mjs', `--arch=${arch}`, '--engine-default=auto']);
const trialConfig = join(root, '.build/trial-tauri.json');
if (trial) {
  // Tauri merges --config as a JSON patch and replaces arrays whole: the window list is repeated in full, with its own title.
  const base = JSON.parse(readFileSync(join(root, 'app/src-tauri/tauri.conf.json')));
  mkdirSync(join(root, '.build'), { recursive: true });
  writeFileSync(trialConfig, JSON.stringify({ productName: appName, identifier: 'com.jethr.visualbrain.trial', app: { windows: base.app.windows.map(w => ({ ...w, title: appName })) } }));
}
const buildEnv = { ...process.env, CARGO_TARGET_DIR: targetDir };
if (trial) buildEnv.VB_TRIAL_BUILD = '1'; else delete buildEnv.VB_TRIAL_BUILD;
execFileSync(join(root, 'node_modules/.bin/tauri'), ['build', '--target', target, '--bundles', 'app', ...(trial ? ['--config', trialConfig] : [])], { cwd: join(root, 'app'), stdio: 'inherit', env: buildEnv });
const app = join(targetDir, `${target}/release/bundle/macos/${appName}.app`);
// Sign nested Mach-O binaries from the inside out; Tauri resources can include Node and N-API addons.
const identity = process.env.APPLE_SIGNING_IDENTITY || '-';
const local = !process.env.APPLE_SIGNING_IDENTITY ? localSigning(root) : null;
if (local) unlockLocalSigning(local);
const files = [];
function visit(dir) { for (const name of readdirSync(dir)) { const file = join(dir, name); if (statSync(file).isDirectory()) visit(file); else files.push(file); } }
visit(join(app, 'Contents/Resources/runtime'));
for (const file of files.filter(p => /\/(node-arm64|node-x64|uv-arm64|uv-x64|vb-indexer-arm64|vb-indexer-x64|spawn-helper)$|\.node$/.test(p))) {
  if (local) { signLocal(file, local, 'com.jethr.visualbrain.runtime.' + file.slice(file.indexOf('/runtime/') + 9).replace(/[^A-Za-z0-9._-]/g, '.')); continue; }
  run('codesign', ['--force', '--sign', identity, ...(identity === '-' ? [] : ['--options', 'runtime', '--timestamp', '--entitlements', join(root, 'app/src-tauri/Entitlements.plist')]), file]);
}
if (local) signLocal(app, local, trial ? 'com.jethr.visualbrain.trial' : 'com.jethr.visualbrain');
else run('codesign', ['--force', '--sign', identity, ...(identity === '-' ? [] : ['--options', 'runtime', '--timestamp']), app]);
run('codesign', ['--verify', '--deep', '--strict', app]);
const release = join(root, trial ? 'release-trial' : 'release'); mkdirSync(release, { recursive: true });
const version = JSON.parse(readFileSync(join(root, 'package.json'))).version;
const name = trial ? `Visual-Brain-${version}-mac-${arch}-indexer-trial.zip` : `Visual-Brain-${version}-mac-${arch}.zip`, archive = join(release, name);
const stage = join(root, '.build', `${trial ? 'trial' : 'release'}-${arch}`);
const trialNote = `VISUAL BRAIN ${version} — PACCHETTO DI PROVA / TRIAL PACKAGE

IT  Prova del nuovo motore di indicizzazione (Rust, con ripiego automatico su TypeScript). L'app si chiama
    "${appName}" e NON sostituisce Visual Brain. Ha un profilo proprio, ~/Library/Application Support/Visual Brain Trial/
    (indice, impostazioni, bacheche), e un proprio server su una porta casuale: non legge né modifica i dati di
    Visual Brain e può restare aperta insieme a lui. Al primo avvio scegli le cartelle da mappare. Per tornare al
    motore precedente avviala da Terminale con VB_ENGINE=ts. Build interna, firma ad-hoc, non notarizzata
    (macOS può chiedere di autorizzarla; vedi LEGGIMI di Visual Brain).

EN  Test of the new indexing engine (Rust, automatically falling back to TypeScript). The app is named
    "${appName}" and does NOT replace Visual Brain. It has its own profile, ~/Library/Application Support/Visual Brain Trial/
    (index, settings, boards), and its own server on a random port: it neither reads nor modifies Visual Brain's data
    and can stay open next to it. On first launch choose the folders to map. To go back to the previous engine launch it
    from Terminal with VB_ENGINE=ts. Internal build, ad-hoc signature, not notarized (macOS may ask you to authorize it;
    see Visual Brain's README).
`;
const makeArchive = () => {
  rmSync(stage, { recursive: true, force: true }); mkdirSync(stage, { recursive: true });
  run('ditto', [app, join(stage, `${appName}.app`)]);
  if (trial) writeFileSync(join(stage, 'LEGGIMI-PROVA-TRIAL.txt'), trialNote);
  else {
    cpSync(join(root, 'docs/INSTALL-IT.txt'), join(stage, 'LEGGIMI.txt'));
    cpSync(join(root, 'docs/INSTALL-EN.txt'), join(stage, 'README.txt'));
  }
  // Keep installation instructions inside the same file the user shares.
  run('ditto', ['-c', '-k', '--sequesterRsrc', stage, archive]);
};
makeArchive();
if (process.env.VB_NOTARY_PROFILE) {
  if (identity === '-') throw Error('Notarization requires a Developer ID signing identity.');
  run('xcrun', ['notarytool', 'submit', archive, '--keychain-profile', process.env.VB_NOTARY_PROFILE, '--wait']);
  run('xcrun', ['stapler', 'staple', app]);
  makeArchive();
}
const hash = createHash('sha256').update(readFileSync(archive)).digest('hex');
writeFileSync(archive + '.sha256', hash + '  ' + name + '\n');
if (trial) writeFileSync(join(release, 'LEGGIMI-PROVA-TRIAL.txt'), trialNote);
else {
  cpSync(join(root, 'docs/INSTALL-IT.txt'), join(release, 'LEGGIMI.txt'));
  cpSync(join(root, 'docs/INSTALL-EN.txt'), join(release, 'README.txt'));
}
const runtimeManifest = JSON.parse(readFileSync(join(root, 'app/runtime/manifest.json')));
writeFileSync(join(release, 'build.json'), JSON.stringify({ version, arch, signed: !!local || identity !== '-', signing: local ? 'local' : identity === '-' ? 'adhoc' : 'apple', notarized: !!process.env.VB_NOTARY_PROFILE, archive: name, sha256: hash, commit: source.commit, dirty: source.dirty, app: `${appName}.app`, engines: runtimeManifest.engines, ...(trial ? { trial: true } : {}) }, null, 2));
console.log(`Package: ${archive}\n${local ? 'Stable local signature (non-Apple), not notarized.' : identity === '-' ? 'Internal build: ad-hoc signature, not notarized.' : 'Signed build.'}`);
rmSync(stage, { recursive: true, force: true });
