// node-pty ships a prebuilt spawn-helper without the execute bit: without it every spawn fails with "posix_spawnp failed".
import { chmodSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const arch of ['darwin-arm64', 'darwin-x64']) {
  const helper = join(root, 'node_modules/node-pty/prebuilds', arch, 'spawn-helper');
  if (existsSync(helper)) chmodSync(helper, 0o755);
}
