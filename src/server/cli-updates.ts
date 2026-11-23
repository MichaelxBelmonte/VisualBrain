// Updates of the agent CLIs from Impostazioni, like the app's own: which version is installed, whether a newer one is
// out, and the update itself in the background with the CLI's own command (no terminal). Running sessions keep the
// version they started with until they are restarted.
// Where the latest version comes from: the npm registry for Claude Code and Codex (the same versions their native
// installers ship; a plain GET with no data about the user), `hermes update --check` for Hermes. Antigravity has no
// check: «Aggiorna» asks the CLI itself.
import { spawn } from 'node:child_process';
import type { Config } from './config.ts';
import { CLI_SPECS, cliPath, forgetCliCatalog, resolvePath, run, type CliName } from './agent-clis.ts';

export interface CliUpdateJob {
  state: 'running' | 'done' | 'failed';
  startedAt: number; endedAt: number | null;
  from: string | null; to: string | null;
  /** The CLI's own output, without colours, at most the last 16 KB. */
  log: string;
}
export interface CliUpdateStatus {
  id: CliName;
  current: string | null;
  /** Latest published version; null when unknown (no check for this CLI, or offline). */
  latest: string | null;
  /** true: a newer version is out; false: up to date; null: unknown. */
  available: boolean | null;
  checkedAt: number | null;
  canCheck: boolean;
  job: CliUpdateJob | null;
}

const NPM: Partial<Record<CliName, string>> = { claude: '@anthropic-ai/claude-code', codex: '@openai/codex' };
/** The CLI's own update, without prompts: stdin is closed, Hermes answers yes by flag. */
const UPDATE_ARGS: Record<CliName, string[]> = { claude: ['update'], codex: ['update'], hermes: ['update', '--yes'], agy: ['update'] };
const CHECK_EVERY = 6 * 3_600_000, UPDATE_TIMEOUT = 10 * 60_000, LOG_MAX = 16_000;

/** «2.1.330» < «2.1.331»; text after the numbers is ignored. Pure. */
export function newer(latest: string | null, current: string | null): boolean | null {
  if (!latest || !current) return null;
  const parts = (v: string) => (v.match(/\d+(?:\.\d+)*/)?.[0] ?? '').split('.').map(Number);
  const a = parts(latest), b = parts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
}

/** The version in `hermes update --check`: «Selected release available: stable v0.23.3». Pure. */
export function parseHermesCheck(code: number | null, out: string, current: string | null): string | null {
  const found = /available:\s*(?:\w+\s+)?v?(\d+\.\d+[\w.+-]*)/i.exec(out)?.[1];
  if (found) return found;
  return code === 0 && /up[ -]to[ -]date|latest|nessun aggiornamento/i.test(out) ? current : null;
}

const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\r(?!\n)/g, '\n');

let checks = new Map<CliName, { at: number; latest: string | null }>();
const jobs = new Map<CliName, CliUpdateJob>();

async function latestOf(id: CliName, path: string, current: string | null): Promise<string | null> {
  const pkg = NPM[id];
  if (pkg) {
    try {
      const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`, { headers: { accept: 'application/json', 'user-agent': 'visual-brain' }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) return null;
      const v = (await res.json() as { version?: unknown }).version;
      return typeof v === 'string' ? v : null;
    } catch { return null; }
  }
  if (id === 'hermes') { const r = await run(path, ['update', '--check'], 30_000); return parseHermesCheck(r.code, r.out, current); }
  return null;
}

/** Installed versions, kept 30 s: while an update runs the window asks every second and a half. */
const versions = new Map<string, { at: number; version: string | null }>();
async function versionOf(path: string, fresh = false): Promise<string | null> {
  const known = versions.get(path);
  if (!fresh && known && Date.now() - known.at < 30_000) return known.version;
  const version = await readVersion(path);
  versions.set(path, { at: Date.now(), version });
  return version;
}
async function readVersion(path: string): Promise<string | null> {
  const r = await run(path, ['--version'], 6000);
  if (r.code !== 0) return null;
  const first = r.out.trim().split('\n')[0];
  return first.match(/\d+\.\d+[\w.+-]*/)?.[0] ?? null;
}

/** Installed and latest version of every installed CLI. Checks at most every 6 hours, unless `fresh`. */
let inflight: Promise<CliUpdateStatus[]> | null = null;
export function cliUpdates(cfg: Config, fresh = false): Promise<CliUpdateStatus[]> {
  // The badge and the Agenti section ask at the same moment: one check answers both.
  if (inflight && !fresh) return inflight;
  const next = readUpdates(cfg, fresh).finally(() => { if (inflight === next) inflight = null; });
  inflight = next;
  return next;
}
async function readUpdates(cfg: Config, fresh: boolean): Promise<CliUpdateStatus[]> {
  const ids = Object.keys(CLI_SPECS) as CliName[];
  return Promise.all(ids.map(async id => {
    const path = await resolvePath(cfg.agents[id]);
    const canCheck = !!NPM[id] || id === 'hermes';
    if (!path) return { id, current: null, latest: null, available: null, checkedAt: null, canCheck, job: jobs.get(id) ?? null };
    const current = await versionOf(path, fresh);
    let check = checks.get(id);
    if (canCheck && jobs.get(id)?.state !== 'running' && (fresh || !check || Date.now() - check.at > CHECK_EVERY)) {
      check = { at: Date.now(), latest: await latestOf(id, path, current) };
      checks.set(id, check);
    }
    const latest = check?.latest ?? null;
    return { id, current, latest, available: newer(latest, current), checkedAt: check?.at ?? null, canCheck, job: jobs.get(id) ?? null };
  }));
}

/** Starts the CLI's own update in the background; one at a time per CLI. */
export async function startCliUpdate(cfg: Config, id: CliName): Promise<CliUpdateJob> {
  const running = jobs.get(id);
  if (running?.state === 'running') return running;
  // Registered before the first await: a second click while the path is looked up finds this job.
  const job: CliUpdateJob = { state: 'running', startedAt: Date.now(), endedAt: null, from: null, to: null, log: '' };
  jobs.set(id, job);
  const path = await resolvePath(cfg.agents[id]);
  if (!path) { jobs.delete(id); throw new Error(`${CLI_SPECS[id].label} non è installato`); }
  job.from = await versionOf(path, true);
  const child = spawn(path, UPDATE_ARGS[id], { env: { ...process.env, PATH: cliPath(), NO_COLOR: '1', TERM: 'dumb' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const add = (d: Buffer) => { job.log = (job.log + strip(String(d))).slice(-LOG_MAX); };
  child.stdout.on('data', add); child.stderr.on('data', add);
  const timer = setTimeout(() => { add(Buffer.from('\n[Visual Brain] Interrotto dopo 10 minuti.\n')); try { child.kill('SIGTERM'); } catch {} }, UPDATE_TIMEOUT);
  let ended = false;
  const finish = async (code: number | null) => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    forgetCliCatalog();
    job.to = await versionOf(path, true);
    job.state = code === 0 ? 'done' : 'failed';
    job.endedAt = Date.now();
    // The next check asks again: the published version may have been reached now.
    checks.delete(id);
  };
  child.on('error', error => { add(Buffer.from(`\n${error.message}\n`)); void finish(-1); });
  child.on('close', code => { void finish(code); });
  return job;
}

/** For tests. */
export function forgetCliUpdates(): void { checks = new Map(); jobs.clear(); versions.clear(); inflight = null; }
