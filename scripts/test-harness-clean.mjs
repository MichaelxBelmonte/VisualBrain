// End-to-end installer test against the distributed runtime and a new, empty profile.
// Downloads real pinned packages, with no global npm/uv/Python or provider credentials.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';

const runtime = resolve(process.argv.find(a => a.startsWith('--runtime='))?.slice(10) || 'app/runtime');
const arch = process.argv.find(a => a.startsWith('--arch='))?.slice(7) || process.arch;
const temp = await mkdtemp(join(tmpdir(), 'vb-clean-harnesses-'));
const profile = join(temp, 'profile');
await mkdir(profile);
const probe = createServer();
await new Promise((ok, fail) => { probe.once('error', fail); probe.listen(0, '127.0.0.1', ok); });
const port = probe.address().port; await new Promise(ok => probe.close(ok));
const base = `http://127.0.0.1:${port}`;
const serverModule = file => pathToFileURL(join(runtime, 'server/src/server', file)).href;
const script = join(temp, 'serve.mjs');
await writeFile(script, `
import { loadConfig } from ${JSON.stringify(serverModule('config.ts'))};
import { Db } from ${JSON.stringify(serverModule('db.ts'))};
import { startServer } from ${JSON.stringify(serverModule('server.ts'))};
const cfg = {...loadConfig(), port: ${port}, roots: [], setupComplete: false, desktopMode: false};
await startServer(cfg, new Db(cfg.dataDir + '/brain.db'), {watch:false,open:false,indexOnStart:false});
`);
const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME, LANG: 'en_US.UTF-8',
  VISUAL_BRAIN_DATA_DIR: profile, DSH_HOME: join(temp, 'dsh'), SHELL: '/bin/zsh' };
const node = join(runtime, `node-${arch}`);
const child = spawn(node, [script], { cwd: temp, env, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '', startupError = '';
child.once('error', error => { startupError = error.message; });
child.stdout.on('data', b => { logs = (logs + b).slice(-4000); });
child.stderr.on('data', b => { logs = (logs + b).slice(-4000); });
const ended = new Promise(ok => { child.once('exit', ok); child.once('error', ok); });
const pause = ms => new Promise(ok => setTimeout(ok, ms));
const request = async (path, body) => {
  const response = await fetch(base + path, { signal: AbortSignal.timeout(5000),
    ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  assert.ok(response.ok, JSON.stringify(data));
  return data;
};
try {
  let ready = false;
  for (let i = 0; i < 600; i++) {
    try { await request('/api/health'); ready = true; break; } catch {}
    if (startupError || child.exitCode !== null || child.signalCode !== null) break;
    await pause(100);
  }
  assert.ok(ready, `Runtime ${arch}: ${startupError || `exit=${child.exitCode}, signal=${child.signalCode}`}\n${logs}`);
  const before = await request('/api/harnesses');
  assert.ok(before.every(h => !h.installed && h.canInstall), JSON.stringify(before));
  for (const { id } of before) {
    assert.equal((await request('/api/harnesses/install', { harness: id })).state, 'installing');
    assert.equal((await request('/api/harnesses/install', { harness: id })).state, 'installing', 'double click shares the install');
    let result, last = '';
    for (let i = 0; i < 600; i++) {
      result = (await request('/api/harnesses')).find(h => h.id === id);
      if (result.install?.step !== last) { console.log(`${id}: ${result.install?.step}`); last = result.install?.step; }
      if (result.install?.state !== 'installing') break;
      await pause(1000);
    }
    assert.equal(result.install?.state, 'ready', JSON.stringify(result));
    assert.equal(result.installed, true);
    assert.equal((await request('/api/harnesses/install', { harness: id })).state, 'ready');
  }
  const root = join(profile, 'harnesses');
  const cliEnv = { ...env, PATH: join(root, 'tools') + ':' + env.PATH };
  const run = (file, args) => {
    const result = spawnSync(file, args, { cwd: temp, env: cliEnv, encoding: 'utf8', timeout: 60_000 });
    assert.equal(result.status, 0, (result.stdout || '') + (result.stderr || '') + (result.error || ''));
    return result.stdout;
  };
  assert.match(run(join(root, 'tools/node'), ['--version']), /^v24/);
  assert.match(run(join(root, 'tools/npm'), ['--version']), /^\d+\./);
  assert.match(run(join(root, 'dsh/node_modules/.bin/dsh'), ['headless', '--help']), /Answer one task/);
  assert.match(run(join(root, 'google-venv/bin/harness2-demo'), ['--output', join(temp, 'google-demo'), '--k', '1']), /2 tasks completed; 0 failed/);
  assert.match(run(join(root, 'cli-venv/bin/harness2'), ['demo', '--output', join(temp, 'cli-demo'), '--k', '1']), /2 tasks completed; 0 failed/);
  const manifest = JSON.parse(await readFile(join(runtime, 'manifest.json')));
  assert.equal(manifest.harnessInstallers.uv, '0.13.3');
  console.log(`PASS clean ${arch} profile: API installs all harnesses; bundled Node/npm/uv; DSH boot; both demos; no model calls`);
} finally {
  if (child.exitCode === null) child.kill('SIGTERM');
  await ended;
  await rm(temp, { recursive: true, force: true });
}
