// Updates of the installed app: signed feed, verified download, installation that moves the running app aside.
// A synthetic signed app stands in for Visual Brain; nothing touches the real install or the network.
// Uso: node scripts/test-update.mjs — solo macOS per la parte di installazione (ditto, codesign).
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Updater, UPDATE_REPO, appBundleOf, applicationsTarget, compareVersions, forget, inApplications, installedCopy, isTranslocated, parseFeed, reopenCommand } from '../src/server/updater.ts';
import { bannerFor } from '../src/ui/updates.ts';
import { UPDATE_PUBLIC_KEY } from '../src/server/update-key.ts';

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.deepEqual(a, b, m); };
const rejects = async (p, re, m) => { checks++; await assert.rejects(p, re, m); };

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const signText = text => sign(null, Buffer.from(text), privateKey).toString('base64');
const feedFor = (version, sha256, size, extra = {}) => {
  const name = `Visual-Brain-${version}-mac-universal.zip`;
  return { schema: 1, app: 'visual-brain', version, publishedAt: '2026-10-15T00:00:00Z', notes: 'Note di prova', archive: { name, url: `https://github.com/${UPDATE_REPO}/releases/download/v${version}/${name}`, size, sha256 }, ...extra };
};
const sha = 'a'.repeat(64);

// --- versions and paths -------------------------------------------------------------------------------------------------
eq([compareVersions('0.2.10', '0.2.9'), compareVersions('0.2.5', '0.2.5'), compareVersions('0.2.4', '0.2.5'), compareVersions('1', '0.9.9')], [1, 0, -1, 1], 'numeric dotted versions compare numerically');
ok(Number.isNaN(compareVersions('0.2.5-beta', '0.2.5')) && Number.isNaN(compareVersions('x', '1')), 'anything else is unknown, never "newer"');
eq(appBundleOf('/Users/me/Applications/Visual Brain.app/Contents/Resources/runtime/node-arm64'), '/Users/me/Applications/Visual Brain.app', 'the installed bundle is found from the server executable');
eq(appBundleOf('/usr/local/bin/node'), null, 'a development run has no bundle');
ok(isTranslocated('/private/var/folders/x/T/AppTranslocation/0236/d/Visual Brain.app') && !isTranslocated('/Applications/Visual Brain.app'), 'an app opened in place from Downloads is recognised as translocated');
const cmd = reopenCommand(4242, '/Applications/Visual Brain.app');
eq(cmd.slice(2), ['4242', '/Applications/Visual Brain.app'], 'the reopen watcher gets the shell pid and the app as arguments, never quoted into the script');
ok(/kill -0 "\$0"/.test(cmd[1]) && /\/usr\/bin\/open "\$1"/.test(cmd[1]), 'it waits for the shell to exit, then opens the app');
execFileSync('/bin/sh', ['-n', '-c', cmd[1]]); checks++;
ok(inApplications('/Applications/Visual Brain.app', ['/Applications', '/Users/me/Applications']) && inApplications('/Users/me/Applications/Visual Brain.app', ['/Applications', '/Users/me/Applications/']), 'a copy in either Applications folder is the installed one');
ok(!inApplications('/Users/me/Desktop/vb/app/src-tauri/target/universal-apple-darwin/release/bundle/macos/Visual Brain.app', ['/Applications']) && !inApplications('/Applications/Sub/Visual Brain.app', ['/Applications']), 'a build folder or a subfolder is not');
ok(!inApplications('/private/var/folders/x/T/AppTranslocation/0236/d/Visual Brain.app', ['/private/var/folders/x/T/AppTranslocation/0236/d']), 'a translocated copy never counts as installed');
eq(installedCopy(['/nonexistent-a', '/nonexistent-b']), null, 'no copy in Applications');
ok(/^MCowBQYDK2VwAyEA[A-Za-z0-9+/]{43}=$/.test(UPDATE_PUBLIC_KEY), 'the embedded public key is an Ed25519 SPKI');

// --- feed ---------------------------------------------------------------------------------------------------------------
const good = JSON.stringify(feedFor('0.2.6', sha, 1000));
eq(parseFeed(good, signText(good), pub).version, '0.2.6', 'a signed feed is accepted');
const bad = async (text, sig, re, m) => { checks++; assert.throws(() => parseFeed(text, sig, pub), re, m); };
await bad(good, signText(good + ' '), /Firma/, 'a feed that was changed after signing is rejected');
await bad(good.replace('0.2.6', '0.2.7'), signText(good), /Firma/, 'a different version than the signed one is rejected');
await bad(good, 'AAAA', /Firma/, 'a malformed signature is rejected');
const other = generateKeyPairSync('ed25519').privateKey;
await bad(good, sign(null, Buffer.from(good), other).toString('base64'), /Firma/, 'a feed signed with another key is rejected');
const signed = obj => { const t = JSON.stringify(obj); return [t, signText(t)]; };
await bad(...signed(feedFor('0.2.6', sha, 1000, { app: 'other' })), /non riconosciuto/, 'another app is rejected');
await bad(...signed({ ...feedFor('0.2.6', sha, 1000), archive: { ...feedFor('0.2.6', sha, 1000).archive, url: 'https://example.com/Visual-Brain-0.2.6-mac-universal.zip' } }), /repository/, 'a download outside the releases repository is rejected');
await bad(...signed({ ...feedFor('0.2.6', sha, 1000), archive: { ...feedFor('0.2.6', sha, 1000).archive, url: `https://github.com/${UPDATE_REPO}/releases/download/v0.2.5/Visual-Brain-0.2.6-mac-universal.zip` } }), /repository/, 'the tag has to match the version');
await bad(...signed({ ...feedFor('0.2.6', sha, 1000), archive: { ...feedFor('0.2.6', sha, 1000).archive, name: '../evil.zip' } }), /Nome/, 'a path-like archive name is rejected');
await bad(...signed(feedFor('0.2.6', 'xyz', 1000)), /checksum/, 'a bad checksum is rejected');
await bad(...signed(feedFor('0.2.6', sha, 500 * 1024 * 1024)), /Dimensione/, 'an absurd size is rejected');
await bad(...signed(feedFor('0.2.x', sha, 1000)), /Versione|Nome/, 'a non numeric version is rejected');

// --- wording ------------------------------------------------------------------------------------------------------------
const view = (extra = {}) => ({ enabled: true, current: '0.2.5', status: 'idle', latest: null, notes: '', error: '', checkedAt: null, liveSessions: 0, ...extra });
eq(bannerFor(view(), null), null, 'nothing to say when up to date');
eq(bannerFor(view({ enabled: false, status: 'ready', latest: '0.2.6' }), null), null, 'a development run never shows the banner');
ok(/0\.2\.6/.test(bannerFor(view({ status: 'ready', latest: '0.2.6' }), null).text) && /non chiude nessun terminale/.test(bannerFor(view({ status: 'ready', latest: '0.2.6' }), null).text), 'ready: says it keeps the terminals');
eq(bannerFor(view({ status: 'ready', latest: '0.2.6' }), '0.2.6'), null, '"later" hides that version');
ok(/3 terminali attivi/.test(bannerFor(view({ status: 'installed', latest: '0.2.6', liveSessions: 3 }), null).text), 'installed: says what a restart costs');
eq(bannerFor(view({ status: 'error', error: 'Boom' }), null).kind, 'error', 'errors are shown');
ok(/si chiuderanno/.test(bannerFor(view({ status: 'installed', latest: '0.2.17', liveSessions: 3 }), null).text), 'new downloaded version does not promise persistence on a legacy backend');
for (const relocated of [false, true]) {
  const persistent = bannerFor(view({ status: 'installed', latest: '0.2.18', liveSessions: 3, persistentTerminals: true, relocated }), null);
  ok(/I terminali restano attivi/.test(persistent.text) && !/si chiuderanno/.test(persistent.text), 'persistent backend preserves terminals across restart, including relocation');
}
const moved = bannerFor(view({ status: 'installed', latest: '0.2.12', relocated: true, installedTo: '/Applications/Visual Brain.app', liveSessions: 3 }), null);
ok(/0\.2\.12 installata in Applicazioni/.test(moved.text) && /si riaprirà da Applicazioni/.test(moved.text) && /cestinare la copia/.test(moved.text), 'relocated: says where it went and that it reopens from Applications');
const outside = bannerFor(view({ outsideApplications: true, applicationsCopy: '/Applications/Visual Brain.app', app: '/x/target/Visual Brain.app' }), null);
ok(outside.kind === 'location' && /fuori da Applicazioni \(\/x\/target\/Visual Brain\.app\)/.test(outside.text) && /apri Visual Brain da Applicazioni/.test(outside.text), 'a copy outside Applications is pointed to the installed one');
ok(/trascinala nella cartella Applicazioni/.test(bannerFor(view({ outsideApplications: true, applicationsCopy: null }), null).text), 'with no installed copy it says to move this one there');
eq(bannerFor(view({ outsideApplications: true }), null, true), null, 'the location notice can be dismissed');
eq(bannerFor(view({ outsideApplications: true, status: 'ready', latest: '0.2.6' }), null).kind, 'ready', 'a ready update comes first');
eq(bannerFor(view({ enabled: false, outsideApplications: true }), null), null, 'a development run never shows it');
const erofs = bannerFor(view({ status: 'error', error: "Installazione non riuscita: EROFS: read-only file system, rename '/private/var/folders/x/T/AppTranslocation/0236/d/Visual Brain.app' -> '/Users/x/…'" }), null);
ok(/sola lettura/.test(erofs.text) && /spostala in Applicazioni/.test(erofs.text) && !/EROFS/.test(erofs.text), 'a read-only location is explained, not shown as an errno');

// --- the whole flow with fake network and a synthetic app --------------------------------------------------------------
if (process.platform === 'darwin') {
  const temp = mkdtempSync(join(tmpdir(), 'vb-update-test-'));
  try {
    const makeApp = (dir, version, marker) => {
      const app = join(dir, 'Visual Brain.app'); mkdirSync(join(app, 'Contents/MacOS'), { recursive: true });
      copyFileSync('/usr/bin/true', join(app, 'Contents/MacOS/vb'));
      writeFileSync(join(app, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>vb</string><key>CFBundleIdentifier</key><string>com.jethr.visualbrain</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
      mkdirSync(join(app, 'Contents/Resources'), { recursive: true }); writeFileSync(join(app, 'Contents/Resources/marker.txt'), marker);
      execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'ignore' });
      return app;
    };
    const installedDir = join(temp, 'Applications'); mkdirSync(installedDir);
    const installed = makeApp(installedDir, '0.2.5', 'old');
    const newDir = join(temp, 'new'); mkdirSync(newDir); makeApp(newDir, '0.2.6', 'new');
    const zip = join(temp, 'Visual-Brain-0.2.6-mac-universal.zip');
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', join(newDir, 'Visual Brain.app'), zip]);
    const zipBytes = readFileSync(zip);
    const zipSha = createHash('sha256').update(zipBytes).digest('hex');
    const feedText = JSON.stringify(feedFor('0.2.6', zipSha, zipBytes.length));
    const calls = [];
    const network = (overrides = {}) => async (url) => {
      calls.push(String(url));
      if (String(url).endsWith('latest.json')) return new Response(overrides.feed ?? feedText);
      if (String(url).endsWith('latest.json.sig')) return new Response(overrides.sig ?? signText(overrides.feed ?? feedText));
      if (String(url).endsWith('.zip')) return new Response(overrides.zip ?? zipBytes, { status: overrides.zipStatus ?? 200 });
      return new Response('?', { status: 404 });
    };
    const make = (name, fetchImpl, extra = {}) => new Updater({ dataDir: join(temp, name), version: '0.2.5', bundle: installed, enabled: true, publicKey: pub, feedUrl: 'https://feed.test/latest.json', fetchImpl, liveSessions: () => 2, applicationFolders: [installedDir], ...extra });
    const settle = async (u, status) => { for (let i = 0; i < 200 && u.state.status !== status; i++) await new Promise(r => setTimeout(r, 25)); return u.state.status; };

    // not enabled: nothing happens, nothing is fetched
    const off = make('off', network(), { enabled: false });
    await rejects(off.check(), /solo nell’app installata/, 'a development run never updates');
    eq(calls.length, 0, 'and fetches nothing');
    // up to date
    const same = new Updater({ dataDir: join(temp, 'same'), version: '0.2.6', bundle: installed, enabled: true, publicKey: pub, feedUrl: 'https://feed.test/latest.json', fetchImpl: network() });
    eq((await same.check()).status, 'idle', 'the same version is not an update');
    // a check that finds nothing must not block the following ones (it did: a release published later was never found)
    const first = (await same.check()).checkedAt; await new Promise(r => setTimeout(r, 5));
    ok((await same.check()).checkedAt > first, 'a second check runs after one that found no update');
    const older = new Updater({ dataDir: join(temp, 'older'), version: '0.3.0', bundle: installed, enabled: true, publicKey: pub, feedUrl: 'https://feed.test/latest.json', fetchImpl: network() });
    eq((await older.check()).status, 'idle', 'an older feed is never a downgrade');
    // bad signature: error, no download
    calls.length = 0;
    const forged = make('forged', network({ sig: signText('something else') }));
    await rejects(forged.check(), /Firma/, 'a forged feed is refused');
    eq(forged.state.status, 'error', 'and the state says so');
    ok(!calls.some(u => u.endsWith('.zip')), 'no package is downloaded for a forged feed');
    // wrong package bytes: refused by the signed checksum
    const tampered = make('tampered', network({ zip: Buffer.concat([zipBytes, Buffer.from('x')]) }));
    await tampered.check(); eq(await settle(tampered, 'error'), 'error', 'a package that differs from the signed checksum is refused');
    ok(!existsSync(join(temp, 'tampered/updates', 'Visual-Brain-0.2.6-mac-universal.zip')) && !readdirSync(join(temp, 'tampered/updates')).some(n => n.endsWith('.part')), 'and nothing is kept on disk');
    // good flow
    const spawned = [];
    const u = make('good', network(), { spawnImpl: (c, a) => spawned.push([c, a]), shellPid: 4242 });
    eq([u.snapshot.outsideApplications, u.snapshot.applicationsCopy, u.snapshot.app], [false, installed, installed], 'the copy in Applications is the right one');
    await u.check(); eq(await settle(u, 'ready'), 'ready', 'a signed, newer feed is downloaded and verified in the background');
    eq(u.snapshot.latest, '0.2.6', 'the new version is reported');
    eq(u.snapshot.liveSessions, 2, 'with the number of live terminals');
    ok(readFileSync(join(installed, 'Contents/Resources/marker.txt'), 'utf8') === 'old', 'nothing is installed before the user confirms');
    // a process keeps living in the old copy while the swap happens (as the running server does)
    const holder = (await import('node:child_process')).spawn('/bin/sh', ['-c', 'cd "$0"/Contents/Resources && exec sleep 30', installed], { stdio: 'ignore' });
    await new Promise(r => setTimeout(r, 300));
    await u.install();
    eq(u.state.status, 'installed', 'installed');
    ok(readFileSync(join(installed, 'Contents/Resources/marker.txt'), 'utf8') === 'new', 'the installed path now holds the new app');
    eq([u.state.relocated, u.state.installedTo, spawned.length], [false, installed, 0], 'the app in Applications is updated in place, with no reopen watcher');
    const asides = readdirSync(join(temp, 'good/running-app-backups'));
    eq(asides.length, 1, 'the old app was moved aside, not deleted');
    ok(readFileSync(join(temp, 'good/running-app-backups', asides[0], 'Visual Brain.app/Contents/Resources/marker.txt'), 'utf8') === 'old', 'with its files intact for the process still running in it');
    await u.cleanup();
    eq(readdirSync(join(temp, 'good/running-app-backups')).length, 1, 'a moved-aside copy that a process still uses is kept');
    holder.kill(); await new Promise(r => holder.once('exit', r));
    await u.cleanup();
    eq(readdirSync(join(temp, 'good/running-app-backups')).length, 0, 'it is removed once no process uses it: always one app on disk');
    ok(!existsSync(join(temp, 'good/updates', 'Visual-Brain-0.2.6-mac-universal.zip')), 'the downloaded package is removed after installing');
    await rejects(u.install(), /Nessun aggiornamento pronto/, 'installing twice is refused');
    // a package whose app does not match the announced version is refused and the install is untouched
    const mismatchZip = join(temp, 'Visual-Brain-0.2.7-mac-universal.zip');
    makeApp(join(newDir, '..'), '0.2.6', 'liar'); // 0.2.6 app announced as 0.2.7
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', join(temp, 'Visual Brain.app'), mismatchZip]);
    const mz = readFileSync(mismatchZip);
    const liar = JSON.stringify(feedFor('0.2.7', createHash('sha256').update(mz).digest('hex'), mz.length));
    const installed2 = makeApp(mkdtempSync(join(temp, 'inst-')), '0.2.6', 'keep');
    const v = new Updater({ dataDir: join(temp, 'liar'), version: '0.2.6', bundle: installed2, enabled: true, publicKey: pub, feedUrl: 'https://feed.test/latest.json', fetchImpl: network({ feed: liar, zip: mz }) });
    await v.check(); await settle(v, 'ready'); await rejects(v.install(), /non corrisponde/, 'an app that is not the announced version is refused');
    ok(readFileSync(join(installed2, 'Contents/Resources/marker.txt'), 'utf8') === 'keep', 'and the installed app is untouched');

    // --- App Translocation: opened from Downloads without moving it, the running path is a read-only copy ------------------
    const ready = async (name, bundle, extra = {}) => {
      const w = make(name, network(), { bundle, ...extra });
      await w.check(); eq(await settle(w, 'ready'), 'ready', `${name}: package ready`);
      return w;
    };
    const marker = app => readFileSync(join(app, 'Contents/Resources/marker.txt'), 'utf8');
    const translocatedDir = join(temp, 'T/AppTranslocation/0236/d'); mkdirSync(translocatedDir, { recursive: true });
    const translocated = makeApp(translocatedDir, '0.2.5', 'translocated');
    const appsA = join(temp, 'appsA'), appsB = join(temp, 'appsB'); mkdirSync(appsA);
    const reopen = [];
    const t1 = await ready('transloc', translocated, { applicationFolders: [appsA, appsB], spawnImpl: (c, a) => reopen.push([c, a]), shellPid: 4242 });
    await t1.install();
    const dest = join(appsA, 'Visual Brain.app');
    eq([t1.state.status, t1.state.relocated, t1.state.installedTo], ['installed', true, dest], 'a translocated app is installed in Applications');
    eq(marker(dest), 'new', 'with the new version');
    eq(marker(translocated), 'translocated', 'the translocated copy is never touched');
    ok(!existsSync(appsB), 'the first writable Applications folder is used, no other is created');
    eq(reopen, [['/bin/sh', reopenCommand(4242, dest)]], 'a reopen watcher waits for the desktop shell and opens the app from Applications');
    eq(t1.snapshot.relocated, true, 'the API snapshot says it was relocated');

    // an existing app in one of the Applications folders is preferred and swapped
    const appsC = join(temp, 'appsC'), appsD = join(temp, 'appsD'); mkdirSync(appsC); mkdirSync(appsD);
    const existingApp = makeApp(appsD, '0.2.4', 'existing');
    const t2 = await ready('existing', translocated, { applicationFolders: [appsC, appsD], spawnImpl: () => {}, shellPid: 4242 });
    await t2.install();
    eq([t2.state.installedTo, marker(existingApp), readdirSync(appsC).length], [existingApp, 'new', 0], 'an app already in Applications is replaced instead of adding a second one');
    const aside2 = readdirSync(join(temp, 'existing/running-app-backups'));
    ok(aside2.length === 1 && marker(join(temp, 'existing/running-app-backups', aside2[0], 'Visual Brain.app')) === 'existing', 'the replaced copy is moved aside like the in-place swap');
    eq(marker(translocated), 'translocated', 'and the translocated copy is still untouched');

    // a folder the user cannot write (not translocated): fallback to Applications; no watcher without the real app
    const lockedDir = join(temp, 'locked-folder'); mkdirSync(lockedDir);
    const lockedApp = makeApp(lockedDir, '0.2.5', 'locked');
    const appsE = join(temp, 'appsE'), appsF = join(temp, 'appsF/nested');
    chmodSync(lockedDir, 0o555);
    try {
      const t3 = await ready('locked', lockedApp, { applicationFolders: [appsE, appsF] });
      await t3.install();
      eq([t3.state.relocated, t3.state.installedTo, marker(lockedApp)], [true, join(appsF, 'Visual Brain.app'), 'locked'], 'a non-writable folder falls back to Applications (created if missing), leaving the old copy');
      eq(marker(join(appsF, 'Visual Brain.app')), 'new', 'with the new version');
    } finally { chmodSync(lockedDir, 0o755); }
    // a path that looks writable but refuses the move (here an immutable bundle, EPERM; EROFS on a read-only volume)
    const frozenDir = join(temp, 'frozen-folder'); mkdirSync(frozenDir);
    const frozenApp = makeApp(frozenDir, '0.2.5', 'frozen');
    const appsG = join(temp, 'appsG'); mkdirSync(appsG);
    execFileSync('/usr/bin/chflags', ['uchg', frozenApp]);
    try {
      const t4 = await ready('frozen', frozenApp, { applicationFolders: [frozenDir, appsG] });
      await t4.install();
      eq([t4.state.relocated, t4.state.installedTo, marker(frozenApp), marker(join(appsG, 'Visual Brain.app'))], [true, join(appsG, 'Visual Brain.app'), 'frozen', 'new'], 'a move refused by the file system falls back to Applications without changing the old copy');
    } finally { execFileSync('/usr/bin/chflags', ['nouchg', frozenApp]); }
    ok(applicationsTarget([join(temp, 'missing'), appsA]) === join(appsA, 'Visual Brain.app'), 'an existing app wins over an earlier folder without one');

    // a copy outside Applications (a build folder): never updated in place, the new version goes to Applications
    const buildDir = join(temp, 'repo/app/src-tauri/target/universal-apple-darwin/release/bundle/macos'); mkdirSync(buildDir, { recursive: true });
    const buildApp = makeApp(buildDir, '0.2.5', 'build');
    const appsH = join(temp, 'appsH'); mkdirSync(appsH);
    const installedH = makeApp(appsH, '0.2.4', 'installed');
    const reopenH = [];
    const t5 = make('build', network(), { bundle: buildApp, applicationFolders: [appsH], spawnImpl: (c, a) => reopenH.push([c, a]), shellPid: 4242 });
    eq([t5.snapshot.outsideApplications, t5.snapshot.applicationsCopy], [true, installedH], 'a build copy knows it is not the installed one');
    await t5.check(); eq(await settle(t5, 'ready'), 'ready', 'build: package ready');
    await t5.install();
    eq([t5.state.relocated, t5.state.installedTo, marker(installedH), marker(buildApp)], [true, installedH, 'new', 'build'], 'the update replaces the app in Applications and leaves the build copy alone');
    eq(reopenH, [['/bin/sh', reopenCommand(4242, installedH)]], 'and reopens from Applications after ⌘Q');

    // what an interrupted installation leaves in updates/ is removed later, an installation in progress is not
    const updates = join(temp, 'build/updates');
    const stale = join(updates, 'stage-1'), fresh = join(updates, 'stage-2');
    makeApp(stale, '0.2.6', 'stale'); makeApp(fresh, '0.2.6', 'fresh');
    const old = new Date(Date.now() - 60 * 60 * 1000); utimesSync(stale, old, old);
    await t5.cleanup();
    eq([existsSync(stale), existsSync(fresh)], [false, true], 'an old unpacked package is removed, a recent one is kept');
  } finally { await forget(temp, 8); } // the synthetic apps leave Launch Services too: no "forbidden" icons after a test run
}

// --- wiring -------------------------------------------------------------------------------------------------------------
const src = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
ok(/VISUAL_BRAIN_UPDATES/.test(src('app/src-tauri/src/main.rs')) && /!TRIAL/.test(src('app/src-tauri/src/main.rs')), 'only the installed regular app enables updates');
ok(/\/api\/update\/install/.test(src('src/server/api.ts')) && /updater\.start\(\)/.test(src('src/server/server.ts')), 'API and background check are wired');
ok(!/killTerminal|killAll|\.kill\(/.test(src('src/server/updater.ts')), 'the updater never kills a terminal or process');
console.log(`test-update: ${checks} controlli ok`);
