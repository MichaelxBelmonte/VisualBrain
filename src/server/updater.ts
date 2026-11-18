// Updates of the installed desktop app: a signed feed, a verified download, and an installation that never closes a terminal.
// Only active inside the installed app (the desktop shell sets VISUAL_BRAIN_UPDATES=1): development runs and tests never update.
//
// Installation = the same swap scripts/update-app.mjs does by hand. The running app is MOVED aside (a rename keeps every open
// file of the running server valid), the new bundle is cloned at the same path, and the moved-aside copy is deleted only once
// no process uses it any more. The new version starts with the next launch, which the user chooses; until then the open
// sessions keep running on the old engine and the page already serves the new interface from the same path.
//
// The update always lands in Applications: there is one Visual Brain on the Mac, and it is the one there. A copy running from
// anywhere else (a build folder, Downloads, an App Translocation read-only copy) is never touched: the new version goes to
// Applications (an existing copy there is swapped the same way) and the app reopens from there once the user quits.
//
// Every copy that leaves the disk (moved-aside apps, unpacked packages) is also removed from Launch Services first:
// otherwise macOS keeps listing it in Launchpad and Spotlight as a "forbidden" icon long after the files are gone.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { accessSync, constants, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { UPDATE_PUBLIC_KEY } from './update-key.ts';

const run = promisify(execFile);

export const UPDATE_REPO = 'MichaelxBelmonte/VisualBrain-releases';
export const FEED_URL = `https://github.com/${UPDATE_REPO}/releases/latest/download/latest.json`;
export const BUNDLE_ID = 'com.jethr.visualbrain';
const MAX_ARCHIVE = 400 * 1024 * 1024;
const CHECK_EVERY = 6 * 60 * 60 * 1000;
const APP_NAME = 'Visual Brain.app';
/** Errors of a path that cannot be changed (read-only volume, permissions): the update goes to Applications instead. */
const LOCKED = new Set(['EROFS', 'EACCES', 'EPERM']);
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
/** An unpacked package left by an interrupted installation is removed after this long. */
const STAGE_TTL = 10 * 60 * 1000;

export interface Feed {
  schema: 1;
  app: 'visual-brain';
  version: string;
  publishedAt: string;
  notes: string;
  archive: { name: string; url: string; size: number; sha256: string };
}

export type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'installing' | 'installed' | 'error';
export interface UpdateState {
  enabled: boolean;
  current: string;
  status: UpdateStatus;
  latest: string | null;
  notes: string;
  error: string;
  checkedAt: number | null;
  /** Where the last installation put the new app. */
  installedTo: string | null;
  /** True when it went to Applications instead of the running app's path (a copy outside Applications, App Translocation). */
  relocated: boolean;
  /** The running app is not the one in Applications (build folder, Downloads…): updates and macOS permissions go elsewhere. */
  outsideApplications: boolean;
  /** The copy in Applications, when there is one. */
  applicationsCopy: string | null;
  /** Bytes of the package received so far, only while it downloads. */
  progress: { received: number; total: number } | null;
}

/** -1 / 0 / 1 for numeric dotted versions ("0.2.10" > "0.2.9"). Anything that is not dotted numbers compares as unknown (NaN). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => (/^\d+(\.\d+){0,3}$/.test(v) ? v.split('.').map(Number) : null);
  const x = parse(a), y = parse(b);
  if (!x || !y) return NaN;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** The `.app` that contains this executable (…/Visual Brain.app/Contents/Resources/runtime/node-*), or null outside an installed app. */
export function appBundleOf(execPath: string): string | null {
  const marker = `.app${sep}Contents${sep}Resources${sep}runtime${sep}`;
  const at = execPath.indexOf(marker);
  return at > 0 ? execPath.slice(0, at + 4) : null;
}

/** macOS runs a quarantined app opened in place from a read-only random copy; that path cannot be updated. */
export function isTranslocated(bundle: string): boolean { return bundle.includes('/AppTranslocation/'); }

const writable = (dir: string): boolean => { try { accessSync(dir, constants.W_OK); return true; } catch { return false; } };

/** True when `bundle` sits directly in one of the Applications folders (and is not a translocated copy). */
export function inApplications(bundle: string, folders: string[]): boolean {
  if (isTranslocated(bundle)) return false;
  const parent = resolve(dirname(bundle));
  return folders.some(dir => resolve(dir) === parent);
}

/** The Visual Brain already installed in one of `folders`, or null. */
export function installedCopy(folders: string[]): string | null {
  return folders.map(dir => join(dir, APP_NAME)).find(path => existsSync(path)) ?? null;
}

/** Every `.app` bundle at or below `dir` (not inside another bundle), for Launch Services. */
function bundlesIn(dir: string, depth = 3): string[] {
  if (dir.endsWith('.app')) return [dir];
  if (depth <= 0) return [];
  try { return readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).flatMap(e => bundlesIn(join(dir, e.name), depth - 1)); } catch { return []; }
}

/** Removes the bundles under `dir` (down to `depth` folders) from Launch Services, then the folder itself. */
export async function forget(dir: string, depth = 3): Promise<void> {
  for (const app of bundlesIn(dir, depth)) await run(LSREGISTER, ['-u', app]).catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}

/** Only "lsof found nothing" (exit 1, no output) means unused. Any other failure counts as in use. */
async function unused(dir: string): Promise<boolean> {
  return run('/usr/sbin/lsof', ['-F', 'p', '+D', dir]).then(({ stdout }) => !stdout.split('\n').some(line => line.startsWith('p')), (error: { code?: number; stdout?: string }) => error.code === 1 && !error.stdout);
}

/**
 * The Applications folder for a relocated install: one that already holds the app (it is swapped), else the first writable
 * folder, else the first that can be created. `folders` defaults to /Applications and ~/Applications.
 */
export function applicationsTarget(folders: string[]): string {
  const existing = folders.find(dir => existsSync(join(dir, APP_NAME)) && writable(dir));
  if (existing) return join(existing, APP_NAME);
  const open = folders.find(dir => existsSync(dir) && writable(dir));
  if (open) return join(open, APP_NAME);
  for (const dir of folders.slice(1)) {
    try { mkdirSync(dir, { recursive: true }); if (writable(dir)) return join(dir, APP_NAME); } catch { /* next */ }
  }
  throw new Error('Nessuna cartella Applicazioni scrivibile.');
}

/**
 * The profile the reopened app must use, or null for the default one. `open` goes through Launch Services, which does not
 * pass this server's environment on: without `--env` a copy started on its own profile would come back on the real one.
 * The shell always sets VISUAL_BRAIN_DATA_DIR for the server, so only a folder other than the default counts: the installed
 * app keeps exactly the command it always had.
 */
export function reopenProfile(dir: string | undefined = process.env.VISUAL_BRAIN_DATA_DIR, home = homedir()): string | null {
  if (!dir) return null;
  return resolve(dir) === join(home, 'Library/Application Support', APP_NAME.replace(/\.app$/, '')) ? null : resolve(dir);
}

/** Waits for the desktop shell `pid` to exit, then opens `app` (on `profile`, when given). Arguments for /bin/sh; values are positional, never quoted in. */
export function reopenCommand(pid: number, app: string, profile: string | null = null): string[] {
  if (!profile) return ['-c', 'while kill -0 "$0" 2>/dev/null; do sleep 1; done; exec /usr/bin/open "$1"', String(pid), app];
  return ['-c', 'while kill -0 "$0" 2>/dev/null; do sleep 1; done; exec /usr/bin/open --env "VISUAL_BRAIN_DATA_DIR=$2" "$1"', String(pid), app, profile];
}

/**
 * "Riavvia" after an installation. Waits for this server (`serverPid`) to finish its clean shutdown, ends the desktop shell,
 * which has nothing left to save, and opens `app` once it is gone. `app` is null when a reopen watcher already waits for the
 * shell (a relocated install). Arguments for /bin/sh, never quoted in.
 *
 * It never stops halfway: a server still closing after 30 s and a shell still there 10 s after SIGTERM are ended with
 * SIGKILL (the terminals live in their own host, SQLite survives an abrupt exit), so the app is always reopened. Exit 1
 * only when a process outlives SIGKILL. `ticks` (×0.2 s) exist for tests.
 *
 * "Gone" is read from the process state, not from `kill -0`: the shell starts the server and never waits on it, so the
 * server that has exited stays a zombie, which still answers `kill -0`, for as long as the shell lives.
 */
export function restartCommand(serverPid: number, shellPid: number, app: string | null, ticks = { server: 150, shell: 50 }, profile: string | null = null): string[] {
  // gone PID TICKS: true once PID has exited (absent, or a zombie nobody reaps), false after TICKS × 0.2 s
  const gone = 'gone() { n=0; while /bin/ps -o stat= -p "$1" 2>/dev/null | /usr/bin/grep -qv \'^ *Z\'; do n=$((n+1)); [ "$n" -gt "$2" ] && return 1; sleep 0.2; done; return 0; }';
  const end = (arg: string, ticks: number) => `gone "${arg}" ${ticks} || { kill -KILL "${arg}" 2>/dev/null; gone "${arg}" 25 || exit 1; }`;
  const head = `${gone}; s="$0"; w="$1"; a="$2"; ${end('$s', ticks.server)}; kill -TERM "$w" 2>/dev/null; ${end('$w', ticks.shell)}; `;
  if (!profile) return ['-c', `${head}[ -n "$a" ] && exec /usr/bin/open -n "$a"; exit 0`, String(serverPid), String(shellPid), app ?? ''];
  return ['-c', `${head}[ -n "$a" ] && exec /usr/bin/open -n --env "VISUAL_BRAIN_DATA_DIR=$3" "$a"; exit 0`, String(serverPid), String(shellPid), app ?? '', profile];
}

/**
 * Checks the signature of the feed text (Ed25519 over its exact bytes) and its content. Throws on anything unexpected:
 * a wrong signature, another app, a download outside the releases repository, a size or hash that cannot be right.
 */
export function parseFeed(text: string, signature: string, publicKey: string = UPDATE_PUBLIC_KEY): Feed {
  const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
  const sig = Buffer.from(signature.trim(), 'base64');
  if (sig.length !== 64 || !verify(null, Buffer.from(text, 'utf8'), key, sig)) throw new Error('Firma dell’aggiornamento non valida.');
  const feed = JSON.parse(text) as Feed;
  const a = feed?.archive;
  if (feed?.schema !== 1 || feed.app !== 'visual-brain' || !a) throw new Error('Feed degli aggiornamenti non riconosciuto.');
  if (Number.isNaN(compareVersions(feed.version, '0'))) throw new Error('Versione non valida nel feed.');
  if (!/^Visual-Brain-[0-9.]+-mac-universal\.zip$/.test(a.name) || a.name !== `Visual-Brain-${feed.version}-mac-universal.zip`) throw new Error('Nome del pacchetto non valido.');
  if (a.url !== `https://github.com/${UPDATE_REPO}/releases/download/v${feed.version}/${a.name}`) throw new Error('Il pacchetto non è nel repository delle release.');
  if (!/^[0-9a-f]{64}$/.test(a.sha256) || !Number.isInteger(a.size) || a.size <= 0 || a.size > MAX_ARCHIVE) throw new Error('Dimensione o checksum del pacchetto non validi.');
  return { ...feed, notes: String(feed.notes ?? '').slice(0, 2000) };
}

export interface UpdaterOptions {
  dataDir: string;
  version: string;
  execPath?: string;
  /** The installed `.app` (the desktop shell passes it in VISUAL_BRAIN_APP, which stays right after a hot swap). */
  bundle?: string | null;
  enabled?: boolean;
  feedUrl?: string;
  publicKey?: string;
  /** Number of live terminals, only to tell the user what a restart costs. */
  liveSessions?: () => number;
  /** Capability of the running server, not of the version merely installed on disk. */
  persistentTerminals?: boolean;
  fetchImpl?: typeof fetch;
  /** Where a relocated install may go (default /Applications, ~/Applications). Tests pass temporary folders. */
  applicationFolders?: string[];
  /** The desktop shell, which spawns the server directly: when it exits the user has quit. */
  shellPid?: number;
  /** Starts the detached reopen watcher. Default: only in the real app (VISUAL_BRAIN_UPDATES=1), never in tests. */
  spawnImpl?: ((command: string, args: string[]) => void | Promise<void>) | null;
  /** Clean shutdown of this server, for "Riavvia". Without it the user quits with ⌘Q as before. */
  quit?: (() => void) | null;
  /** Profile the reopened app must use (see reopenProfile); null for the default one. */
  profile?: string | null;
}

/** Resolves once the process runs; a failure to start (EAGAIN, missing /bin/sh) rejects instead of being an unhandled 'error'. */
const spawnDetached = (command: string, args: string[]): Promise<void> => new Promise((resolve, reject) => {
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.once('error', reject);
  child.once('spawn', () => { child.unref(); resolve(); });
});

export class Updater {
  private readonly o: Required<Omit<UpdaterOptions, 'liveSessions' | 'bundle' | 'spawnImpl' | 'quit'>> & Pick<UpdaterOptions, 'liveSessions' | 'spawnImpl' | 'quit'>;
  private readonly bundle: string | null;
  private feed: Feed | null = null;
  private busy = false;
  /** A watcher already opens the installed app when the shell exits. */
  private reopening = false;
  /** True once the restart watcher runs: only then may the server quit. */
  private restarting = false;
  /** The restart being started; a second request waits for the same outcome. */
  private restartAsked: Promise<void> | null = null;
  /** The last cleanup pass queued: the next one starts after it. */
  private cleaning: Promise<void> = Promise.resolve();
  /** A newer version downloading behind the one that is ready (exposed for tests). */
  replacing: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  state: UpdateState;

  constructor(options: UpdaterOptions) {
    this.o = {
      execPath: process.execPath, enabled: process.env.VISUAL_BRAIN_UPDATES === '1', feedUrl: FEED_URL, publicKey: UPDATE_PUBLIC_KEY, fetchImpl: fetch, persistentTerminals: false,
      applicationFolders: ['/Applications', join(homedir(), 'Applications')], shellPid: process.ppid,
      spawnImpl: process.env.VISUAL_BRAIN_UPDATES === '1' ? spawnDetached : null, profile: reopenProfile(),
      ...options,
    };
    const given = options.bundle ?? process.env.VISUAL_BRAIN_APP ?? appBundleOf(this.o.execPath);
    this.bundle = given && given.endsWith('.app') ? given : null;
    const enabled = this.o.enabled && !!this.bundle;
    this.state = {
      enabled, current: options.version, status: 'idle', latest: null, notes: '', error: '', checkedAt: null, installedTo: null, relocated: false,
      outsideApplications: enabled && !inApplications(this.bundle!, this.o.applicationFolders),
      applicationsCopy: enabled ? installedCopy(this.o.applicationFolders) : null, progress: null,
    };
  }

  get snapshot(): UpdateState & { liveSessions: number; persistentTerminals: boolean; app: string | null; canRestart: boolean } { return { ...this.state, liveSessions: this.o.liveSessions?.() ?? 0, persistentTerminals: this.o.persistentTerminals, app: this.state.enabled ? this.bundle : null, canRestart: this.canRestart }; }
  /** "Riavvia" needs the real app around this server: a shell to end, a way to reopen it and a clean exit. */
  private get canRestart(): boolean { return this.state.enabled && !!this.o.spawnImpl && !!this.o.quit && Number.isInteger(this.o.shellPid) && this.o.shellPid > 1; }
  private get updatesDir(): string { return join(this.o.dataDir, 'updates'); }
  private get asideDir(): string { return join(this.o.dataDir, 'running-app-backups'); }

  /** Checks 30 s after start and then every 6 hours; also removes copies left by a previous installation. */
  start(): void {
    if (!this.state.enabled) return;
    void this.cleanup();
    setTimeout(() => void this.check().catch(() => {}), 30_000).unref();
    this.timer = setInterval(() => void this.check().catch(() => {}), CHECK_EVERY);
    this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  private fail(error: unknown): never {
    this.state = { ...this.state, status: 'error', progress: null, error: error instanceof Error ? error.message : String(error) };
    throw error instanceof Error ? error : new Error(String(error));
  }

  async check(): Promise<UpdateState> {
    if (!this.state.enabled) throw new Error('Gli aggiornamenti sono disponibili solo nell’app installata.');
    if (this.busy || ['downloading', 'installing', 'installed'].includes(this.state.status)) return this.state;
    // A version waiting in "ready" stays offered while the feed is read again: a newer one replaces it only once verified.
    const waiting = this.state.status === 'ready' ? this.feed : null;
    this.busy = true;
    if (!waiting) this.state = { ...this.state, status: 'checking', error: '' };
    let feed: Feed;
    try {
      const get = async (url: string) => {
        const response = await this.o.fetchImpl(url, { signal: AbortSignal.timeout(20_000), headers: { 'user-agent': `visual-brain/${this.o.version}` } });
        if (!response.ok) throw new Error(`Feed non raggiungibile (${response.status}).`);
        return response.text();
      };
      const [text, sig] = await Promise.all([get(this.o.feedUrl), get(`${this.o.feedUrl}.sig`)]);
      feed = parseFeed(text, sig, this.o.publicKey);
    } catch (error) {
      this.busy = false;
      if (waiting) return this.state; // the verified package stays ready, without an error to show
      this.fail(error);
    }
    this.busy = false;
    this.state = { ...this.state, checkedAt: Date.now() };
    if (waiting) {
      if (compareVersions(feed.version, waiting.version) > 0) void this.replaceWaiting(waiting, feed);
      return this.state;
    }
    if (!(compareVersions(feed.version, this.o.version) > 0)) { this.state = { ...this.state, status: 'idle', latest: null, notes: '' }; return this.state; } // no update: the next check must be allowed to run
    this.feed = feed;
    this.state = { ...this.state, status: 'available', latest: feed.version, notes: feed.notes };
    void this.download().catch(() => {});
    return this.state;
  }

  /**
   * Downloads `feed`'s package to a partial file, checks size and SHA256 against the signed feed, and only then keeps it.
   * Returns its path; on any failure nothing is left behind.
   */
  private async fetchPackage(feed: Feed, onBytes?: (received: number) => void): Promise<string> {
    const target = join(this.updatesDir, feed.archive.name), part = `${target}.part`;
    try {
      mkdirSync(this.updatesDir, { recursive: true, mode: 0o700 });
      const response = await this.o.fetchImpl(feed.archive.url, { signal: AbortSignal.timeout(15 * 60_000), headers: { 'user-agent': `visual-brain/${this.o.version}` } });
      if (!response.ok || !response.body) throw new Error(`Download non riuscito (${response.status}).`);
      const hash = createHash('sha256');
      let bytes = 0;
      const source = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
      source.on('data', (chunk: Buffer) => {
        bytes += chunk.length; hash.update(chunk);
        if (bytes > feed.archive.size) source.destroy(new Error('Il pacchetto è più grande del previsto.'));
        else onBytes?.(bytes);
      });
      await pipeline(source, createWriteStream(part, { mode: 0o600 }));
      if (bytes !== feed.archive.size || hash.digest('hex') !== feed.archive.sha256) throw new Error('Il pacchetto scaricato non corrisponde al checksum firmato.');
      renameSync(part, target);
      return target;
    } catch (error) { rmSync(part, { force: true }); throw error; }
  }

  /** Downloads the package of the feed found by check(), showing the bytes received. */
  async download(): Promise<UpdateState> {
    const feed = this.feed;
    if (!feed || this.busy) return this.state;
    this.busy = true;
    this.state = { ...this.state, status: 'downloading', error: '', progress: { received: 0, total: feed.archive.size } };
    try {
      await this.fetchPackage(feed, received => { this.state.progress = { received, total: feed.archive.size }; });
      this.state = { ...this.state, status: 'ready', progress: null };
    } catch (error) { this.busy = false; this.fail(error); }
    this.busy = false;
    return this.state;
  }

  /**
   * A newer version came out while `waiting` was ready: download it quietly behind the one on offer and swap only once it is
   * verified, removing the superseded package. Any failure keeps the verified one ready, without an error; an installation
   * that started meanwhile wins and the new package is dropped.
   */
  private replaceWaiting(waiting: Feed, feed: Feed): Promise<void> {
    if (this.replacing) return this.replacing;
    this.replacing = (async () => {
      let path: string;
      try { path = await this.fetchPackage(feed); } catch { return; }
      if (this.state.status !== 'ready' || this.feed !== waiting) { if (feed.archive.name !== waiting.archive.name) rmSync(path, { force: true }); return; }
      this.feed = feed;
      this.state = { ...this.state, latest: feed.version, notes: feed.notes };
      if (feed.archive.name !== waiting.archive.name) rmSync(join(this.updatesDir, waiting.archive.name), { force: true });
    })().finally(() => { this.replacing = null; });
    return this.replacing;
  }

  /**
   * Installs the downloaded package in place, or in Applications when the running app's path cannot change (translocated,
   * read-only, not writable). Terminals are not touched; the new version starts at the next launch.
   */
  async install(): Promise<UpdateState> {
    const feed = this.feed, bundle = this.bundle;
    if (this.state.status !== 'ready' || !feed || !bundle || this.busy) throw new Error('Nessun aggiornamento pronto da installare.');
    this.busy = true;
    this.state = { ...this.state, status: 'installing', error: '' };
    const stage = join(this.updatesDir, `stage-${Date.now()}`);
    const aside = join(this.asideDir, new Date().toISOString().replace(/\D/g, '').slice(0, 14));
    try {
      const zip = join(this.updatesDir, feed.archive.name);
      mkdirSync(stage, { recursive: true, mode: 0o700 });
      await run('/usr/bin/ditto', ['-x', '-k', zip, stage]);
      const fresh = join(stage, APP_NAME);
      if (!existsSync(fresh)) throw new Error('Il pacchetto non contiene Visual Brain.app.');
      await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', fresh]);
      const { stdout: id } = await run('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleIdentifier', join(fresh, 'Contents/Info.plist')]);
      const { stdout: version } = await run('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleShortVersionString', join(fresh, 'Contents/Info.plist')]);
      if (id.trim() !== BUNDLE_ID || version.trim() !== feed.version) throw new Error('L’app nel pacchetto non corrisponde alla versione annunciata.');
      // In place only when the running app is the one in Applications; any other copy is left alone.
      let relocated = !inApplications(bundle, this.o.applicationFolders) || !writable(dirname(bundle));
      let dest = relocated ? applicationsTarget(this.o.applicationFolders) : bundle;
      try { await this.swap(fresh, dest, aside); } catch (error) {
        // A path that refuses the first move was left as it was: install in Applications instead.
        if (relocated || !(error as { untouched?: boolean }).untouched || !LOCKED.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
        relocated = true; dest = applicationsTarget(this.o.applicationFolders.filter(dir => join(dir, APP_NAME) !== dest));
        await this.swap(fresh, dest, aside);
      }
      await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', dest]).catch(() => {});
      await forget(stage);
      rmSync(zip, { force: true });
      await run(LSREGISTER, ['-f', dest]).catch(() => {});
      this.state = { ...this.state, status: 'installed', installedTo: dest, relocated, applicationsCopy: installedCopy(this.o.applicationFolders) };
      if (relocated) this.scheduleReopen(dest);
      void this.cleanup();
    } catch (error) {
      await forget(stage);
      if (!existsSync(join(aside, APP_NAME))) rmSync(aside, { recursive: true, force: true }); // never the old app if putting it back failed
      this.busy = false; this.fail(new Error(`Installazione non riuscita: ${error instanceof Error ? error.message : String(error)}`));
    }
    this.busy = false;
    return this.state;
  }

  /** Moves the app at `dest` (if any) aside, clones `fresh` there and verifies it; on failure puts the old app back. */
  private async swap(fresh: string, dest: string, aside: string): Promise<void> {
    const moved = join(aside, APP_NAME);
    const had = existsSync(dest);
    if (had) {
      mkdirSync(aside, { recursive: true, mode: 0o700 });
      try { renameSync(dest, moved); } catch (error) { throw Object.assign(error as Error, { untouched: true }); }
    }
    try {
      await run('/usr/bin/ditto', [fresh, dest]);
      await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', dest]);
    } catch (error) {
      rmSync(dest, { recursive: true, force: true });
      if (had) renameSync(moved, dest);
      throw error;
    }
  }

  /** The running copy cannot become the new one: once the desktop shell exits (⌘Q), open the installed app. */
  private scheduleReopen(dest: string): void {
    const pid = this.o.shellPid;
    if (!this.o.spawnImpl || !Number.isInteger(pid) || pid <= 1) return;
    // the user can open it from Applications when the watcher cannot start; "Riavvia" then opens it itself
    this.reopening = true;
    try { void Promise.resolve(this.o.spawnImpl('/bin/sh', reopenCommand(pid, dest, this.o.profile))).catch(() => { this.reopening = false; }); } catch { this.reopening = false; }
  }

  /**
   * "Riavvia" after an installation: starts the watcher that reopens the installed app and resolves once it runs, so the
   * caller answers and then calls `quit()` only with someone left to reopen the app. Terminals live in their own host and
   * are found again; without that host a restart would close them, so it is refused.
   */
  async restart(): Promise<void> {
    const dest = this.state.installedTo;
    if (this.state.status !== 'installed' || !dest) throw new Error('Nessun aggiornamento installato da avviare.');
    if (!this.canRestart) throw new Error('Riavvio non disponibile: chiudi Visual Brain con ⌘Q e riaprila.');
    // a second request while the first waits for its watcher gets the same outcome: never a quit without a watcher
    if (this.restartAsked) return this.restartAsked;
    const live = this.o.liveSessions?.() ?? 0;
    if (!this.o.persistentTerminals && live > 0) throw new Error(`Ci sono ${live} terminali attivi che si chiuderebbero: chiudi Visual Brain con ⌘Q quando hai finito.`);
    this.restartAsked = (async () => {
      try { await this.o.spawnImpl!('/bin/sh', restartCommand(process.pid, this.o.shellPid, this.reopening ? null : dest, undefined, this.o.profile)); } catch (error) {
        this.restartAsked = null;
        throw new Error(`Riavvio non riuscito (${error instanceof Error ? error.message : String(error)}): chiudi Visual Brain con ⌘Q e riaprila.`);
      }
      this.restarting = true;
    })();
    return this.restartAsked;
  }

  /** Ends this server cleanly once the answer to "Riavvia" is out. */
  quit(): void { if (this.restarting) this.o.quit?.(); }

  /**
   * Removes what installations leave behind: moved-aside apps that no process uses any more (one that a running server still
   * lives in is kept) and unpacked packages of an installation that never finished. Each one also leaves Launch Services.
   *
   * Calls never overlap: each one is a full pass that starts when the previous one has ended. Two passes at once saw each
   * other's lsof/lsregister on the same folder as "in use" and both left it for later. A pass that fails never blocks the
   * next one and never rejects, so `void this.cleanup()` cannot become an unhandled rejection.
   */
  cleanup(): Promise<void> {
    const pass = this.cleaning.then(() => this.sweep()).catch(() => { /* what is left is retried by the next pass */ });
    this.cleaning = pass;
    return pass;
  }

  private async sweep(): Promise<void> {
    if (existsSync(this.asideDir)) for (const name of readdirSync(this.asideDir)) {
      const dir = join(this.asideDir, name);
      try { if (statSync(dir).isDirectory() && await unused(dir)) await forget(dir); } catch { /* leave it for the next time */ }
    }
    if (this.busy || !existsSync(this.updatesDir)) return;
    for (const name of readdirSync(this.updatesDir).filter(n => n.startsWith('stage-'))) {
      const dir = join(this.updatesDir, name);
      try { if (Date.now() - statSync(dir).mtimeMs > STAGE_TTL && await unused(dir)) await forget(dir); } catch { /* next time */ }
    }
  }
}
