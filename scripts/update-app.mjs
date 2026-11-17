// Installs the packaged Visual Brain over the installed one, so there is always ONE app, without closing open sessions.
// Uso: node scripts/update-app.mjs [--bundle=<Visual Brain.app>] [--app=</Applications/Visual Brain.app>] [--remove-bundle] [--dry-run]
// npm run install:mac = package:mac + this script with --remove-bundle: after the copy the build bundle leaves the disk and
// Launch Services, so Spotlight and Launchpad only ever show the app in Applications.
//
// Terminals live in the server process of the running app. Replacing the files under it would not touch that process, but
// deleting or rewriting its executables could. So when the app is running the old bundle is MOVED aside (a rename keeps every
// open file valid) and the new bundle is cloned at the same path: the running server keeps its processes and the next
// reload (⌘R) already serves the new UI from the same path. Backend changes and the new engine start with the next full
// launch, which is the only moment sessions end. The moved-aside bundle goes to the profile's running-app-backups, the same
// folder the app's updater uses: it is deleted by the next update (or this one, or the app at its next start) as soon as no
// process uses it any more, and leaves Launch Services with it. Nothing accumulates.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const root = resolve(import.meta.dirname, '..');
const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const dry = process.argv.includes('--dry-run');
const removeBundle = process.argv.includes('--remove-bundle');
// The installed copy is the one in /Applications; a Mac that still has it in ~/Applications keeps it there, so a second
// copy never appears. Never the build folder: an app run from there sits inside a folder macOS protects (Desktop).
const installed = ['/Applications', join(homedir(), 'Applications')].map(dir => join(dir, 'Visual Brain.app'));
const app = resolve(arg('app') ?? installed.find(path => existsSync(path)) ?? installed[0]);
const target = 'universal-apple-darwin';
const bundle = resolve(arg('bundle') ?? join(root, `app/src-tauri/target/${target}/release/bundle/macos/Visual Brain.app`));
const profile = process.env.VISUAL_BRAIN_DATA_DIR || join(homedir(), 'Library/Application Support/Visual Brain');
const aside = join(profile, 'running-app-backups');
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
const out = (file, args) => { try { return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return typeof e.stdout === 'string' ? e.stdout : ''; } };
const run = (file, args) => execFileSync(file, args, { stdio: 'inherit' });
const version = path => /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)/.exec(readFileSync(join(path, 'Contents/Info.plist'), 'utf8'))?.[1] ?? '?';
/** Processes whose executable or open files live under `dir`. */
const users = dir => new Set(out('lsof', ['-F', 'p', '+D', dir]).split('\n').filter(l => l.startsWith('p')).map(l => l.slice(1)));
/** Removes a bundle (or a folder holding one) from Launch Services and from the disk: no "forbidden" icon is left behind. */
const forget = dir => {
  const apps = dir.endsWith('.app') ? [dir] : existsSync(dir) ? readdirSync(dir).filter(n => n.endsWith('.app')).map(n => join(dir, n)) : [];
  for (const app of apps) out(LSREGISTER, ['-u', app]);
  rmSync(dir, { recursive: true, force: true });
};

if (!existsSync(bundle)) throw Error(`New bundle not found: ${bundle}. Run npm run package:mac first.`);
run('codesign', ['--verify', '--deep', '--strict', bundle]);
const manifest = JSON.parse(readFileSync(join(root, 'release/build.json'), 'utf8'));
const zip = join(root, 'release', manifest.archive);
if (existsSync(zip) && createHash('sha256').update(readFileSync(zip)).digest('hex') !== manifest.sha256) throw Error('release/build.json does not match the archive.');
console.log(`Nuova ${version(bundle)} → ${app}${existsSync(app) ? ` (installata ${version(app)})` : ''}`);

const running = existsSync(app) ? users(app) : new Set();
const serverChanged = existsSync(app) && out('diff', ['-rq', join(app, 'Contents/Resources/runtime/server/src'), join(bundle, 'Contents/Resources/runtime/server/src')]).trim() !== '';
if (dry) { console.log(`dry-run: processi che usano l'app: ${running.size}; backend cambiato: ${serverChanged}`); process.exit(0); }

if (running.size) {
  // Hot swap: nothing under the running processes is deleted or rewritten.
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  mkdirSync(join(aside, stamp), { recursive: true, mode: 0o700 });
  renameSync(app, join(aside, stamp, 'Visual Brain.app'));
  run('ditto', [bundle, app]);
  run('codesign', ['--verify', '--deep', '--strict', app]);
  console.log(`App in esecuzione (${running.size} processi): sessioni intatte. Premi ⌘R nella finestra per la nuova interfaccia.`);
  console.log(serverChanged ? 'Il backend è cambiato: sarà attivo dopo ⌘Q e riapertura. I terminali restano attivi sul servizio persistente e li ritrovi alla riapertura.' : 'Il backend è identico: nessun riavvio necessario.');
} else {
  mkdirSync(resolve(app, '..'), { recursive: true });
  rmSync(app, { recursive: true, force: true });
  run('ditto', [bundle, app]);
  run('codesign', ['--verify', '--deep', '--strict', app]);
  const held = existsSync(aside) ? readdirSync(aside).filter(name => users(join(aside, name)).size) : [];
  console.log(held.length ? 'Nessun processo usa questo percorso (l\'app in esecuzione parte da una copia già spostata): sostituita, sessioni intatte. Il backend nuovo parte al prossimo avvio completo.' : 'App non in esecuzione: sostituita, nessuna copia lasciata.');
}
// One app only: drop every moved-aside bundle that no process uses any more.
if (existsSync(aside)) for (const name of readdirSync(aside)) {
  const dir = join(aside, name);
  if (users(dir).size) { console.log(`Copia precedente ancora in uso, la tengo: ${dir}`); continue; }
  forget(dir); console.log(`Rimossa copia precedente non più in uso: ${name}`);
}
out(LSREGISTER, ['-f', app]);
if (removeBundle && resolve(bundle) !== resolve(app)) {
  forget(bundle);
  console.log(`Copia di build rimossa: l'unica Visual Brain è ${app}. Il pacchetto resta in release/.`);
}
