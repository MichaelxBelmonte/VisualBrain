// Command-line equivalent of the in-app installer; uses the prepared runtime.
// node scripts/install-harnesses.mjs [--data-dir=/path] [--only=deepseek|harness2-cli|harness2-google]
import { resolve } from 'node:path';
import { loadConfig } from '../src/server/config.ts';
import { HARNESS_SPECS, validHarness, startHarnessInstall, harnessInstallState, stopHarnessInstalls } from '../src/server/harness-installer.ts';
process.once('SIGINT', stopHarnessInstalls);
process.once('SIGTERM', stopHarnessInstalls);
const option = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const cfg = loadConfig();
if (option('data-dir')) cfg.dataDir = resolve(option('data-dir'));
const ids = option('only') ? [validHarness(option('only'))] : Object.keys(HARNESS_SPECS);
for (const id of ids) {
  let state = startHarnessInstall(cfg, id), last = '';
  while (state.state === 'installing') {
    if (last !== state.step) { console.log(`${id}: ${state.step}`); last = state.step; }
    await new Promise(ok => setTimeout(ok, 500));
    state = harnessInstallState(cfg, id);
  }
  if (state.state === 'error') throw Error(state.error);
  console.log(`${id}: installed`);
}
