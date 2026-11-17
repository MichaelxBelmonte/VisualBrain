// Optional tools live in the user's profile. The app supplies Node, npm and uv;
// installing never starts a model, asks for sudo or modifies the user's shell.
import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, symlinkSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { PROJECT_ROOT, type Config } from './config.ts';
import { TeamError } from './team.ts';

export const HARNESS_SPECS = {
  deepseek: { label: 'DeepSeek Harness', folder: 'dsh', executable: 'node_modules/.bin/dsh', version: '0.2.1-rc.5' },
  'harness2-cli': {
    label: 'Harness² CLI · community', folder: 'cli-venv', executable: 'bin/harness2',
    version: '0c811344a4edfe34960b2fc8f286369d7e81fb27',
    url: 'https://codeload.github.com/3ae3ae/harness2-cli/tar.gz/0c811344a4edfe34960b2fc8f286369d7e81fb27',
    sha256: 'b42e9fb2b4112f4a18ba95de5dc9e84fe60804a2c977c87c522eec81df6b414a',
  },
  'harness2-google': {
    label: 'Harness² · Google Research', folder: 'google-venv', executable: 'bin/harness2',
    version: '1cfe254e8d25b15f37048c3730134686abe60335',
    url: 'https://codeload.github.com/google-research/harness2/tar.gz/1cfe254e8d25b15f37048c3730134686abe60335',
    sha256: '2337f91b71a130e055d8dfb99ead2667a46087c29df939d4d4f0a3c357b5748f',
  },
} as const;
export type HarnessName = keyof typeof HARNESS_SPECS;
export type InstallState = { state: 'installing' | 'ready' | 'error'; step: 'download' | 'python' | 'packages' | 'verify' | 'done'; updatedAt: number; pid: number; error?: string; version?: string };
export const harnessRoot = (cfg: Config) => process.env.VISUAL_BRAIN_HARNESSES_DIR || join(cfg.dataDir, 'harnesses');
export const harnessExecutable = (cfg: Config, id: HarnessName) => join(harnessRoot(cfg), HARNESS_SPECS[id].folder, HARNESS_SPECS[id].executable);
const stateFile = (cfg: Config, id: HarnessName) => join(harnessRoot(cfg), 'install-state', `${id}.json`);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } };
const running = new Map<string, AbortController>();

export function validHarness(value: unknown): HarnessName {
  if (typeof value !== 'string' || !Object.hasOwn(HARNESS_SPECS, value)) throw new TeamError(400, 'Harness sconosciuto');
  return value as HarnessName;
}

export function harnessInstallState(cfg: Config, id: HarnessName): InstallState | null {
  try {
    const saved = JSON.parse(readFileSync(stateFile(cfg, id), 'utf8')) as InstallState;
    if (saved.state === 'installing' && !alive(saved.pid)) return { ...saved, state: 'error', error: 'Installazione interrotta. Riprova.' };
    return saved;
  } catch { return null; }
}

export function harnessInstalled(cfg: Config, id: HarnessName): boolean {
  const state = harnessInstallState(cfg, id);
  if (state && state.state !== 'ready') return false;
  try { accessSync(harnessExecutable(cfg, id), constants.X_OK); return true; } catch { return false; }
}

/** Version actually on disk: the npm package for DeepSeek, the recorded install for the Python tools (null when unknown). */
export function harnessVersion(cfg: Config, id: HarnessName): string | null {
  if (id === 'deepseek') {
    try { return String(JSON.parse(readFileSync(join(harnessRoot(cfg), HARNESS_SPECS[id].folder, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version); } catch { return null; }
  }
  return harnessInstallState(cfg, id)?.version ?? null;
}

/** Installed, but not the version this release pins: it still runs, and Install updates it in place. */
export function harnessOutdated(cfg: Config, id: HarnessName): boolean {
  const version = harnessVersion(cfg, id);
  return harnessInstalled(cfg, id) && version !== null && version !== HARNESS_SPECS[id].version;
}

export function bootstrapTools() {
  // Packaged layout; development can reuse a locally prepared runtime.
  const npm = process.env.VISUAL_BRAIN_NPM_CLI || [join(PROJECT_ROOT, 'vendor/npm/bin/npm-cli.js'), join(PROJECT_ROOT, 'app/runtime/server/vendor/npm/bin/npm-cli.js')].find(existsSync);
  const uv = process.env.VISUAL_BRAIN_UV || [join(PROJECT_ROOT, '../bin', `uv-${process.arch}`), join(PROJECT_ROOT, 'app/runtime/bin', `uv-${process.arch}`)].find(existsSync);
  return { npm, uv };
}

/** Also used at launch: a clean Mac need not have `node` on PATH for dsh's shebang. */
export function harnessEnvironment(cfg: Config): NodeJS.ProcessEnv {
  const root = harnessRoot(cfg), bin = join(root, 'tools');
  mkdirSync(bin, { recursive: true });
  const link = join(bin, 'node');
  const pending = join(bin, `node-${process.pid}.tmp`);
  try { unlinkSync(pending); } catch {}
  symlinkSync(process.execPath, pending);
  renameSync(pending, link);
  const npm = bootstrapTools().npm;
  if (npm) {
    const npmLink = join(bin, `npm-${process.pid}.tmp`);
    try { unlinkSync(npmLink); } catch {}
    symlinkSync(npm, npmLink);
    renameSync(npmLink, join(bin, 'npm'));
  }
  return { ...process.env, PATH: bin + delimiter + (process.env.PATH || '/usr/bin:/bin'),
    UV_CACHE_DIR: join(root, 'cache/uv'), UV_PYTHON_INSTALL_DIR: join(root, 'python'),
    UV_PYTHON_INSTALL_BIN: '0', UV_NO_MODIFY_PATH: '1',
    npm_config_cache: join(root, 'cache/npm'), npm_config_registry: 'https://registry.npmjs.org/' };
}

export function installerAvailable(id: HarnessName): boolean {
  const tools = bootstrapTools();
  return process.platform === 'darwin' && ['arm64', 'x64'].includes(process.arch) && !!(id === 'deepseek' ? tools.npm : tools.uv);
}

type InstallerIO = {
  command(file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<void>;
  download(url: string, file: string, sha256: string, signal: AbortSignal): Promise<void>;
};
const realIO: InstallerIO = {
  command: (file, args, cwd, env, signal) => new Promise((resolve, reject) => {
    if (signal.aborted) return reject(Error('Installazione interrotta. Riprova.'));
    const child = spawn(file, args, { cwd, env, detached: true, stdio: 'ignore' });
    const kill = () => { if (child.pid) try { process.kill(-child.pid, 'SIGTERM'); } catch {} };
    const timer = setTimeout(kill, 15 * 60_000);
    signal.addEventListener('abort', kill, { once: true });
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', kill); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('exit', code => { cleanup(); code === 0 ? resolve() : reject(Error(`Installazione non riuscita (codice ${code ?? 'interrotta'}). Controlla la connessione e riprova.`)); });
  }),
  download: async (url, file, sha256, signal) => {
    if (existsSync(file) && createHash('sha256').update(await readFile(file)).digest('hex') === sha256) return;
    const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) });
    if (!response.ok) throw Error(`Download non riuscito (${response.status}). Riprova.`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw Error('Checksum del download non valido. Installazione annullata.');
    await writeFile(file, bytes, { mode: 0o600 });
  },
};

/** Exported for isolated installer tests and the optional command-line installer. */
export async function performHarnessInstall(cfg: Config, id: HarnessName, update: (step: InstallState['step']) => void, signal: AbortSignal, io: InstallerIO = realIO): Promise<void> {
  const spec = HARNESS_SPECS[id], root = harnessRoot(cfg), target = join(root, spec.folder);
  const runtimeEnv = harnessEnvironment(cfg), tools = bootstrapTools();
  // Package installers do not need provider keys or the team session's token.
  const env = Object.fromEntries(Object.entries(runtimeEnv).filter(([key]) => [
    'HOME', 'USER', 'LOGNAME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'UV_CACHE_DIR', 'UV_PYTHON_INSTALL_DIR',
    'UV_PYTHON_INSTALL_BIN', 'UV_NO_MODIFY_PATH', 'npm_config_cache', 'npm_config_registry',
  ].includes(key)));
  env.npm_config_userconfig = join(root, 'installer.npmrc');
  mkdirSync(join(root, 'downloads'), { recursive: true });
  if (id === 'deepseek') {
    if (!tools.npm) throw Error('Installer npm mancante nel pacchetto. Reinstalla Visual Brain.');
    update('packages');
    await io.command(process.execPath, [tools.npm, 'install', '--prefix', target, '--no-audit', '--no-fund', '--save-exact', `@deepseek-ai/dsh@${spec.version}`], root, env, signal);
  } else {
    if (!tools.uv) throw Error('Installer Python mancante nel pacchetto. Reinstalla Visual Brain.');
    const source = HARNESS_SPECS[id];
    update('download');
    const archive = join(root, 'downloads', `${id}-${spec.version}.tar.gz`);
    await io.download(source.url, archive, source.sha256, signal);
    update('python');
    const python = join(target, 'bin/python');
    if (!existsSync(python)) await io.command(tools.uv, ['--no-config', 'venv', '--managed-python', '--python', '3.12.15', target], root, env, signal);
    update('packages');
    await io.command(tools.uv, ['--no-config', 'pip', 'install', '--python', python, archive], root, env, signal);
  }
  update('verify');
  await io.command(harnessExecutable(cfg, id), [id === 'deepseek' ? '--version' : '--help'], root, env, signal);
}

export function startHarnessInstall(cfg: Config, value: unknown, perform = performHarnessInstall): InstallState {
  const id = validHarness(value), file = stateFile(cfg, id), root = harnessRoot(cfg);
  const previous = harnessInstallState(cfg, id);
  if (previous?.state === 'installing') return previous;
  if (harnessInstalled(cfg, id) && !harnessOutdated(cfg, id)) return { state: 'ready', step: 'done', updatedAt: Date.now(), pid: process.pid };
  if (!installerAvailable(id)) throw new TeamError(409, 'Installazione non disponibile: serve il pacchetto Mac completo di Visual Brain.');
  mkdirSync(join(root, 'install-state'), { recursive: true });
  const lock = `${file}.lock`;
  try { writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const pid = Number(readFileSync(lock, 'utf8'));
    if (Number.isInteger(pid) && pid > 0 && alive(pid)) throw new TeamError(409, 'Un’altra installazione è già in corso.');
    unlinkSync(lock);
    writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  }
  let state: InstallState = { state: 'installing', step: 'download', updatedAt: Date.now(), pid: process.pid };
  const save = () => { writeFileSync(file + '.tmp', JSON.stringify(state), { mode: 0o600 }); renameSync(file + '.tmp', file); };
  save();
  const controller = new AbortController(); running.set(file, controller);
  // Start after returning 202; every state transition is persisted, including failures.
  void Promise.resolve().then(() => perform(cfg, id, step => { state = { ...state, step, updatedAt: Date.now() }; save(); }, controller.signal))
    .then(() => { state = { ...state, state: 'ready', step: 'done', version: HARNESS_SPECS[id].version, updatedAt: Date.now() }; })
    .catch(error => { state = { ...state, state: 'error', updatedAt: Date.now(), error: controller.signal.aborted ? 'Installazione interrotta. Riprova.' : String(error.message || error).slice(0, 400) }; })
    .finally(() => { save(); running.delete(file); try { unlinkSync(lock); } catch {} });
  return state;
}

export function stopHarnessInstalls(): void { for (const controller of running.values()) controller.abort(); }
