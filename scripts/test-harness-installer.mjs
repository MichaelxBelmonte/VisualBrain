// Deterministic installer lifecycle checks; no downloads, accounts or models.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readlinkSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULTS } from '../src/server/config.ts';
import { HARNESS_SPECS, performHarnessInstall, startHarnessInstall, harnessInstallState, harnessInstalled, harnessExecutable, harnessOutdated, harnessVersion, stopHarnessInstalls } from '../src/server/harness-installer.ts';
import { prepareHarnessTools } from './prepare-harness-tools.mjs';
const temp = mkdtempSync(join(tmpdir(), 'vb-installer-'));
const cfg = { ...DEFAULTS, dataDir: temp };
const keys = ['VISUAL_BRAIN_HARNESSES_DIR', 'VISUAL_BRAIN_NPM_CLI', 'VISUAL_BRAIN_UV'];
const prior = Object.fromEntries(keys.map(k => [k, process.env[k]]));
delete process.env.VISUAL_BRAIN_HARNESSES_DIR;
process.env.VISUAL_BRAIN_NPM_CLI = '/fixture/npm-cli.js';
process.env.VISUAL_BRAIN_UV = '/fixture/uv';
const tick = () => new Promise(ok => setImmediate(ok));
const executable = id => { const file = harnessExecutable(cfg, id); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 }); };
try {
  assert.throws(() => startHarnessInstall(cfg, '../escape'), /sconosciuto/);
  assert.throws(() => startHarnessInstall(cfg, '__proto__'), /sconosciuto/);
  let attempts = 0, release;
  const gate = new Promise(ok => { release = ok; });
  const failing = async (_cfg, _id, update) => { attempts++; update('packages'); await gate; throw Error('simulated offline'); };
  assert.equal(startHarnessInstall(cfg, 'deepseek', failing).state, 'installing');
  assert.equal(startHarnessInstall(cfg, 'deepseek', failing).state, 'installing');
  await tick();
  assert.equal(attempts, 1, 'double click does not start a second install');
  executable('deepseek');
  assert.equal(harnessInstalled(cfg, 'deepseek'), false, 'partially created executable is not ready');
  release(); await tick(); await tick();
  assert.equal(harnessInstallState(cfg, 'deepseek').state, 'error');
  assert.equal(harnessInstalled(cfg, 'deepseek'), false);
  startHarnessInstall(cfg, 'deepseek', async () => { executable('deepseek'); });
  await tick(); await tick();
  assert.equal(harnessInstallState(cfg, 'deepseek').state, 'ready');
  assert.equal(harnessInstalled(cfg, 'deepseek'), true);
  startHarnessInstall(cfg, 'deepseek', () => { throw Error('must not overwrite ready install'); });
  console.log('PASS validation, duplicate clicks, persisted failure, partial installs, retry and preservation of ready tools');

  // An install of an older pinned DeepSeek keeps running and can be updated in place.
  const manifest = join(temp, 'harnesses/dsh/node_modules/@deepseek-ai/dsh/package.json');
  mkdirSync(dirname(manifest), { recursive: true });
  writeFileSync(manifest, JSON.stringify({ version: '0.2.1-rc.2' }));
  assert.equal(harnessVersion(cfg, 'deepseek'), '0.2.1-rc.2');
  assert.equal(harnessOutdated(cfg, 'deepseek'), true);
  assert.equal(harnessInstalled(cfg, 'deepseek'), true, 'an older version still runs');
  let updated = false;
  startHarnessInstall(cfg, 'deepseek', async () => { updated = true; writeFileSync(manifest, JSON.stringify({ version: HARNESS_SPECS.deepseek.version })); });
  await tick(); await tick();
  assert.equal(updated, true, 'Install updates an outdated tool');
  assert.equal(harnessOutdated(cfg, 'deepseek'), false);
  assert.equal(harnessVersion(cfg, 'harness2-google'), null, 'unknown versions are never reported as outdated');
  console.log('PASS outdated DeepSeek detected from its package and updated in place');

  const file = join(temp, 'harnesses/install-state/harness2-google.json');
  writeFileSync(file, JSON.stringify({ state: 'installing', step: 'download', pid: 2147483647, updatedAt: 1 }));
  writeFileSync(file + '.lock', '2147483647');
  assert.equal(harnessInstallState(cfg, 'harness2-google').state, 'error');
  startHarnessInstall(cfg, 'harness2-google', async () => { executable('harness2-google'); });
  await tick(); await tick();
  assert.equal(harnessInstalled(cfg, 'harness2-google'), true);
  let aborted = false;
  startHarnessInstall(cfg, 'harness2-cli', async (_cfg, _id, _update, signal) => {
    await new Promise((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(Error('aborted')); }));
  });
  await tick(); stopHarnessInstalls(); await tick(); await tick();
  assert.equal(aborted, true);
  assert.equal(harnessInstallState(cfg, 'harness2-cli').state, 'error');
  console.log('PASS interrupted install detection, stale lock recovery and shutdown cancellation');

  const commands = [], downloads = [], steps = [];
  const io = { async command(file, args, cwd, env) { commands.push({ file, args, cwd, env }); },
    async download(url, file, hash) { downloads.push({ url, file, hash }); } };
  for (const id of Object.keys(HARNESS_SPECS)) await performHarnessInstall(cfg, id, step => steps.push(step), new AbortController().signal, io);
  assert.equal(downloads.length, 2);
  assert.ok(downloads.every(d => d.url.startsWith('https://codeload.github.com/') && /^[a-f0-9]{64}$/.test(d.hash)));
  assert.ok(commands.some(c => c.file === process.execPath && c.args.includes('@deepseek-ai/dsh@0.2.1-rc.5')));
  assert.ok(commands.some(c => c.args.includes('--managed-python') && c.args.includes('3.12.15')));
  assert.ok(commands.every(c => c.env.PATH.startsWith(join(temp, 'harnesses/tools'))));
  assert.ok(commands.every(c => !Object.keys(c.env).some(k => /(?:TOKEN|API_KEY|SECRET)/i.test(k))), 'installer receives no provider or team credentials');
  assert.equal(readlinkSync(join(temp, 'harnesses/tools/node')), process.execPath);
  assert.ok(commands.every(c => !c.args.some(arg => arg.startsWith('git+'))), 'install does not require Git/Xcode');
  assert.ok(commands.filter(c => c.args.includes('--help') || c.args.includes('--version')).length === 3);
  assert.ok(!commands.some(c => c.args.includes('run') || c.args.includes('headless')), 'verification never starts a model');
  console.log('PASS bundled npm/uv, isolated managed Python, checksum-pinned sources and no model calls');

  const downloadsDir = join(temp, 'bad-downloads'); mkdirSync(downloadsDir);
  writeFileSync(join(downloadsDir, 'uv-0.13.3-aarch64-apple-darwin.tar.gz'), 'not a verified binary');
  await assert.rejects(prepareHarnessTools(join(temp, 'out'), ['arm64'], downloadsDir), /Checksum mismatch/);
  console.log('PASS a corrupt uv archive cannot enter the app bundle');
} finally {
  for (const key of keys) { if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; }
  rmSync(temp, { recursive: true, force: true });
}
