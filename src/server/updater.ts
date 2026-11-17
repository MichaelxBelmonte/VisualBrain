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

/** Removes the bundles under `dir` from Launch Services, then the folder itself. */
export async function forget(dir: string): Promise<void> {
  for (const app of bundlesIn(dir)) await run(LSREGISTER, ['-u', app]).catch(() => {});
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

/** Waits for the desktop shell `pid` to exit, then opens `app`. Arguments for /bin/sh; values are positional, never quoted in. */
export function reopenCommand(pid: number, app: string): string[] {
  return ['-c', 'while kill -0 "$0" 2>/dev/null; do sleep 1; done; exec /usr/bin/open "$1"', String(pid), app];
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
  spawnImpl?: ((command: string, args: string[]) => void) | null;
}

const spawnDetached = (command: string, args: string[]): void => { spawn(command, args, { detached: true, stdio: 'ignore' }).unref(); };

export class Updater {
  private readonly o: Required<Omit<UpdaterOptions, 'liveSessions' | 'bundle' | 'spawnImpl'>> & Pick<UpdaterOptions, 'liveSessions' | 'spawnImpl'>;
  private readonly bundle: string | null;
  private feed: Feed | null = null;
  private busy = false;
  private timer: NodeJS.Timeout | null = null;
  state: UpdateState;

  constructor(options: UpdaterOptions) {
    this.o = {
      execPath: process.execPath, enabled: process.env.VISUAL_BRAIN_UPDATES === '1', feedUrl: FEED_URL, publicKey: UPDATE_PUBLIC_KEY, fetchImpl: fetch, persistentTerminals: false,
      applicationFolders: ['/Applications', join(homedir(), 'Applications')], shellPid: process.ppid,
      spawnImpl: process.env.VISUAL_BRAIN_UPDATES === '1' ? spawnDetached : null,
      ...options,
    };
    const given = options.bundle ?? process.env.VISUAL_BRAIN_APP ?? appBundleOf(this.o.execPath);
    this.bundle = given && given.endsWith('.app') ? given : null;
    const enabled = this.o.enabled && !!this.bundle;
    this.state = {
      enabled, current: options.version, status: 'idle', latest: null, notes: '', error: '', checkedAt: null, installedTo: null, relocated: false,
      outsideApplications: enabled && !inApplications(this.bundle!, this.o.applicationFolders),
      applicationsCopy: enabled ? installedCopy(this.o.applicationFolders) : null,
    };
  }

  get snapshot(): UpdateState & { liveSessions: number; persistentTerminals: boolean; app: string | null } { return { ...this.state, liveSessions: this.o.liveSessions?.() ?? 0, persistentTerminals: this.o.persistentTerminals, app: this.state.enabled ? this.bundle : null }; }
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
    this.state = { ...this.state, status: 'error', error: error instanceof Error ? error.message : String(error) };
    throw error instanceof Error ? error : new Error(String(error));
  }

  async check(): Promise<UpdateState> {
    if (!this.state.enabled) throw new Error('Gli aggiornamenti sono disponibili solo nell’app installata.');
    if (this.busy || ['downloading', 'installing', 'ready', 'installed'].includes(this.state.status)) return this.state;
    this.busy = true;
    this.state = { ...this.state, status: 'checking', error: '' };
    try {
      const get = async (url: string) => {
        const response = await this.o.fetchImpl(url, { signal: AbortSignal.timeout(20_000), headers: { 'user-agent': `visual-brain/${this.o.version}` } });
        if (!response.ok) throw new Error(`Feed non raggiungibile (${response.status}).`);
        return response.text();
      };
      const [text, sig] = await Promise.all([get(this.o.feedUrl), get(`${this.o.feedUrl}.sig`)]);
      const feed = parseFeed(text, sig, this.o.publicKey);
      this.state = { ...this.state, checkedAt: Date.now() };
      if (!(compareVersions(feed.version, this.o.version) > 0)) { this.state = { ...this.state, status: 'idle', latest: null, notes: '' }; this.busy = false; return this.state; } // no update: the next check must be allowed to run
      this.feed = feed;
      this.state = { ...this.state, status: 'available', latest: feed.version, notes: feed.notes };
    } catch (error) { this.busy = false; this.fail(error); }
    this.busy = false;
    void this.download().catch(() => {});
    return this.state;
  }

  /** Downloads to a partial file, checks size and SHA256 against the signed feed, and only then keeps it. */
  async download(): Promise<UpdateState> {
    const feed = this.feed;
    if (!feed || this.busy) return this.state;
    this.busy = true;
    this.state = { ...this.state, status: 'downloading', error: '' };
    const target = join(this.updatesDir, feed.archive.name), part = `${target}.part`;
    try {
      mkdirSync(this.updatesDir, { recursive: true, mode: 0o700 });
      const response = await this.o.fetchImpl(feed.archive.url, { signal: AbortSignal.timeout(15 * 60_000), headers: { 'user-agent': `visual-brain/${this.o.version}` } });
      if (!response.ok || !response.body) throw new Error(`Download non riuscito (${response.status}).`);
      const hash = createHash('sha256');
      let bytes = 0;
      const source = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
      source.on('data', (chunk: Buffer) => { bytes += chunk.length; hash.update(chunk); if (bytes > feed.archive.size) source.destroy(new Error('Il pacchetto è più grande del previsto.')); });
      await pipeline(source, createWriteStream(part, { mode: 0o600 }));
      if (bytes !== feed.archive.size || hash.digest('hex') !== feed.archive.sha256) { rmSync(part, { force: true }); throw new Error('Il pacchetto scaricato non corrisponde al checksum firmato.'); }
      renameSync(part, target);
      this.state = { ...this.state, status: 'ready' };
    } catch (error) { rmSync(part, { force: true }); this.busy = false; this.fail(error); }
    this.busy = false;
    return this.state;
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
    try { this.o.spawnImpl('/bin/sh', reopenCommand(pid, dest)); } catch { /* the user can open it from Applications */ }
  }

  /**
   * Removes what installations leave behind: moved-aside apps that no process uses any more (one that a running server still
   * lives in is kept) and unpacked packages of an installation that never finished. Each one also leaves Launch Services.
   */
  async cleanup(): Promise<void> {
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
