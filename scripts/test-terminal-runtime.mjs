// Replacing/removing a synthetic source bundle must not invalidate the host's Node, addon or spawn-helper.
import assert from 'node:assert/strict';
import { constants, cpSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const runtime = process.argv.find(a => a.startsWith('--runtime='))?.slice(10);
const root = runtime ? resolve(runtime, 'server') : resolve(import.meta.dirname, '..');
const { TerminalService } = await import(pathToFileURL(join(root, 'src/server/terminal-service.ts')));
const temp = realpathSync(mkdtempSync(join(tmpdir(), 'vb-terminal-runtime-')));
const source = join(temp, 'Source.app'), profile = join(temp, 'profile');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (check, timeout = 10000) => { const until = Date.now() + timeout; while (Date.now() < until) { if (await check()) return; await sleep(25); } throw new Error('Fixture timeout'); };
let client, service;
try {
  mkdirSync(join(source, 'src/server'), { recursive: true });
  copyFileSync(process.execPath, join(source, 'node'), constants.COPYFILE_FICLONE);
  writeFileSync(join(source, 'package.json'), '{"type":"module"}');
  for (const name of ['terminal-service.ts', 'terminal-host.ts', 'terminal-wire.ts', 'terminals.ts', 'activity.ts']) {
    copyFileSync(join(root, 'src/server', name), join(source, 'src/server', name));
  }
  const addon = dirname(createRequire(join(root, 'package.json')).resolve('node-pty/package.json'));
  const destination = join(source, 'node_modules/node-pty');
  mkdirSync(destination, { recursive: true });
  copyFileSync(join(addon, 'package.json'), join(destination, 'package.json'));
  cpSync(join(addon, 'lib'), join(destination, 'lib'), { recursive: true });
  for (const entry of [`prebuilds/${process.platform}-${process.arch}`, 'build/Release']) {
    if (existsSync(join(addon, entry))) cpSync(join(addon, entry), join(destination, entry), { recursive: true });
  }
  const probe = `import {TerminalService} from './src/server/terminal-service.ts';
    const service = await TerminalService.open(process.argv[2], 49123, () => {});
    const term = await service.spawn({id:'bundle-fixture', agent:'shell', cwd:process.argv[2], title:'fixture', file:'/bin/sh', args:['-c','echo READY:$$; while read line; do echo INPUT:$line:$$; done']});
    await service.flush(); console.log(JSON.stringify({pid:term.proc.pid,host:service.hostPid}));`;
  writeFileSync(join(source, 'probe.mjs'), probe);
  let result = '', errors = '';
  client = spawn(join(source, 'node'), ['probe.mjs', profile], { cwd: source, stdio: ['ignore', 'pipe', 'pipe'] });
  client.stdout.on('data', b => result += b); client.stderr.on('data', b => errors += b);
  // A newly copied Intel executable needs Rosetta preparation on Apple Silicon before Node itself starts.
  await waitFor(() => { if (client.exitCode !== null || client.signalCode !== null) throw new Error(`Fixture client exit=${client.exitCode} signal=${client.signalCode}: ${errors}`); return result.includes('\n'); }, 60000);
  const initial = JSON.parse(result.trim());
  const exited = new Promise(r => client.once('exit', r)); client.kill('SIGKILL'); await exited;
  renameSync(source, join(temp, 'old-source'));
  // Leave a wholly different source at the old path, as the app updater does. No runtime comes from it anymore.
  mkdirSync(source); writeFileSync(join(source, 'new-version'), 'replacement');
  rmSync(join(temp, 'old-source'), { recursive: true, force: true });
  service = await TerminalService.open(profile, 49123, () => {});
  assert.equal(service.hostPid, initial.host);
  const term = service.get('bundle-fixture'); assert.equal(term.proc.pid, initial.pid);
  service.write(term.info.id, 'after-swap\r'); await service.flush();
  await waitFor(() => term.buffer.join('').includes(`INPUT:after-swap:${initial.pid}`));
  // Spawning after removal exercises lazy native addon/helper paths, not just already-open file descriptors.
  const extra = await service.spawn({ id: 'after-swap', agent: 'shell', cwd: profile, title: 'extra', file: '/bin/sh', args: ['-c', 'echo NEW-PTY; exit 7'] });
  await waitFor(() => extra.exitCode === 7);
  assert.ok(extra.buffer.join('').includes('NEW-PTY'));
  const noisy = await service.spawn({ id: 'noisy', agent: 'shell', cwd: profile, title: 'noisy', file: '/bin/sh', args: ['-c', "sleep 0.2; head -c 600000 /dev/zero | tr '\\000' x; echo OFFLINE-DONE; exit 3"] });
  await service.detach(); service = null;
  await sleep(600);
  service = await TerminalService.open(profile, 49123, () => {});
  await waitFor(() => service.get(noisy.info.id).exitCode === 3);
  assert.ok(service.get(noisy.info.id).buffer.join('').length <= 200000);
  assert.ok(service.get(noisy.info.id).buffer.join('').includes('OFFLINE-DONE'));
  assert.equal(service.get('bundle-fixture').info.alive, true);
  console.log('PASS source bundle removed/replaced: same PTY PID, new PTY spawn, offline output/exit and bounded replay');
} finally {
  if (client?.exitCode === null && client.signalCode === null) { const done = new Promise(r => client.once('exit', r)); client.kill('SIGKILL'); await done; }
  if (!service && existsSync(join(profile, 'terminal-service/host.json'))) service = await TerminalService.open(profile, 49123, () => {});
  if (service) { service.killAll(); await service.flush(); await service.detach(); }
  await waitFor(() => !existsSync(join(profile, 'terminal-service/host.json')));
  rmSync(temp, { recursive: true, force: true });
}
