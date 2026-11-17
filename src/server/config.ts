import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface LlmConfig {
  provider: 'claude-cli' | 'anthropic-api' | 'none';
  model: string;
  effort: 'low' | 'medium' | 'high';
  /** What may leave the machine: names, paths and statistics only, or also short excerpts of README-like files. */
  consent: 'metadata' | 'excerpts';
  apiKeyEnv: string;
  timeoutMs: number;
}

/** Indexing engine: `ts` is the reference implementation, `native` requires the Rust binary, `auto` uses it when present and falls back to `ts`. */
export type Engine = 'ts' | 'native' | 'auto';

export function parseEngine(v: unknown, fallback: Engine = 'ts'): Engine {
  return v === 'ts' || v === 'native' || v === 'auto' ? v : fallback;
}

/** Packaged builds may carry an `engine.default.json` next to the server (written by scripts/prepare-runtime.mjs). */
function packagedEngine(): Engine {
  try { return parseEngine(JSON.parse(readFileSync(join(PROJECT_ROOT, 'engine.default.json'), 'utf8')).engine); } catch { return 'ts'; }
}

export interface Config {
  engine: Engine;
  roots: string[];
  language: 'it' | 'en';
  setupComplete: boolean;
  configFile?: string;
  desktopMode: boolean;
  /** Name shown in the toolbar and the page title, to tell several brains apart (e.g. "Brain VM"). Set only in the config file. */
  label?: string;
  dataDir: string;
  host: string;
  port: number;
  /** Absolute paths never entered. */
  excludePaths: string[];
  /** Directory names never entered. */
  excludeNames: string[];
  /** Directory names indexed only as a total (count + bytes), without their files. */
  vendorNames: string[];
  /** File-name globs whose content is never read. */
  secretPatterns: string[];
  /** Absolute-path globs of folders that only group other projects (transparent in the project view). Empty: heuristic only. */
  containers: string[];
  /** Absolute-path globs of folders that must stay boxes even when the heuristic calls them containers. */
  notContainers: string[];
  maxTextBytes: number;
  maxHashBytes: number;
  /** A directory with at least this many files, of which at least `dumpDataShare` are data files, is a data dump. */
  dumpMinFiles: number;
  dumpDataShare: number;
  llm: LlmConfig;
  agents: { claude: string; codex: string; hermes: string; agy: string };
}

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const home = homedir();
export const DESKTOP_DATA = process.env.VISUAL_BRAIN_DATA_DIR;
export const CONFIG_FILE = process.env.VISUAL_BRAIN_CONFIG || (DESKTOP_DATA ? join(DESKTOP_DATA, 'settings.json') : join(PROJECT_ROOT, 'brain.config.json'));

export const DEFAULTS: Config = {
  engine: packagedEngine(),
  roots: DESKTOP_DATA ? [] : [join(home, 'Desktop')],
  language: (process.env.VISUAL_BRAIN_LANGUAGE || process.env.LANG || '').toLowerCase().startsWith('it') ? 'it' : 'en',
  setupComplete: !DESKTOP_DATA,
  desktopMode: !!DESKTOP_DATA,
  dataDir: DESKTOP_DATA || join(PROJECT_ROOT, 'data'),
  host: '127.0.0.1',
  port: 4747,
  excludePaths: [
    join(PROJECT_ROOT, 'data'),
    join(PROJECT_ROOT, 'dist'),
    // local build outputs: packages, staging and the curated runtime are never part of the graph
    join(PROJECT_ROOT, 'release'),
    join(PROJECT_ROOT, 'release-trial'),
    join(PROJECT_ROOT, '.build'),
    join(PROJECT_ROOT, 'app', 'runtime'),
  ],
  // .worktrees: temporary checkouts agents make of a repository that is already indexed (tens of thousands of copies)
  excludeNames: ['.private', '.ssh', '.aws', '.gnupg', '.codex', '.claude', '.hermes', '.git', '.worktrees', '.DS_Store', '.Trash', '.Spotlight-V100', '.fseventsd', '.TemporaryItems'],
  vendorNames: [
    'node_modules', 'target', '.venv', 'venv', '__pycache__', '.tools', '.build', 'site-packages',
    'dist', 'build', '.cache', '.next', '.turbo', 'DerivedData', 'Pods', '.gradle', '.pytest_cache',
    '.mypy_cache', '.ruff_cache', 'coverage', 'vendor', '.parcel-cache', '.yarn', '.pnpm-store',
  ],
  secretPatterns: [
    '.env', '.env.*', '*.pem', '*.key', 'id_rsa*', 'id_ed25519*', 'id_ecdsa*', '*.p12', '*.pfx',
    'credentials*', 'secrets*', '*.token', '.netrc', '.npmrc', '.pypirc', 'service-account*.json',
    '*.keychain', '*.keystore', 'token.json', 'client_secret*.json',
  ],
  containers: [],
  notContainers: [],
  maxTextBytes: 1024 * 1024,
  maxHashBytes: 4 * 1024 * 1024,
  dumpMinFiles: 100,
  dumpDataShare: 0.85,
  llm: {
    provider: 'claude-cli',
    model: 'claude-opus-5-5',
    effort: 'high',
    consent: 'metadata',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    timeoutMs: 15 * 60 * 1000,
  },
  agents: { claude: 'claude', codex: 'codex', hermes: 'hermes', agy: 'agy' },
};

function expandHome(p: string): string {
  return p.startsWith('~/') ? join(home, p.slice(2)) : p;
}

/** Defaults merged with `brain.config.json` in the project root, when it exists. Its `excludePaths` add to the defaults. */
export function loadConfig(): Config {
  const file = CONFIG_FILE;
  let user: Partial<Config> & { llm?: Partial<LlmConfig> } = {};
  if (existsSync(file)) {
    user = JSON.parse(readFileSync(file, 'utf8'));
  }
  const cfg: Config = {
    ...DEFAULTS,
    ...user,
    desktopMode: !!DESKTOP_DATA,
    engine: parseEngine(process.env.VB_ENGINE, parseEngine(user.engine, DEFAULTS.engine)),
    configFile: file,
    excludePaths: [...DEFAULTS.excludePaths, ...(user.excludePaths ?? [])],
    llm: { ...DEFAULTS.llm, ...(user.llm ?? {}) },
    agents: { ...DEFAULTS.agents, ...(user.agents ?? {}) },
  };
  cfg.roots = cfg.roots.map((r) => resolve(expandHome(r)));
  cfg.excludePaths = [...new Set([...cfg.excludePaths, cfg.dataDir, ...(DESKTOP_DATA ? [PROJECT_ROOT] : [])])].map((r) => resolve(expandHome(r)));
  cfg.containers = (cfg.containers ?? []).map(expandHome);
  cfg.notContainers = (cfg.notContainers ?? []).map(expandHome);
  cfg.dataDir = resolve(expandHome(cfg.dataDir));
  return cfg;
}

/** Converts a glob with `*` into a RegExp anchored on the whole name. */
export function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${esc}$`, 'i');
}

/** Persist only user preferences, never process paths, account credentials or the development config. */
export function savePreferences(cfg: Config, settings: { roots: string[]; language: 'it' | 'en'; setupComplete: boolean }): void {
  const file = cfg.configFile || CONFIG_FILE;
  const previous = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const next = file + '.tmp';
  writeFileSync(next, JSON.stringify({ ...previous, ...settings }, null, 2) + '\n', { mode: 0o600 });
  renameSync(next, file);
  Object.assign(cfg, settings);
}
