// Durable task API, model/effort validation and safe harness dispatch. No model calls.
import assert from 'node:assert/strict';
import { constants, copyFileSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readlinkSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { DEFAULTS } from '../src/server/config.ts';
import { Db } from '../src/server/db.ts';
import { GraphCache } from '../src/server/cache.ts';
import { Teams } from '../src/server/team.ts';
import { handleApi } from '../src/server/api.ts';
import { modelCatalog } from '../src/server/models.ts';
import { startSession } from '../src/server/sessions.ts';
import { effortChoices } from '../src/shared/agent-effort.ts';
import { launchHarness, harnessCatalog, harnessPaths } from '../src/server/harnesses.ts';

const temp = mkdtempSync(join(tmpdir(), 'vb-harness-test-'));
const cfg = { ...DEFAULTS, dataDir: temp, language: 'it', roots: [temp] };
const db = new Db(join(temp, 'test.db'));
const oldHarnessRoot = process.env.VISUAL_BRAIN_HARNESSES_DIR;
delete process.env.VISUAL_BRAIN_HARNESSES_DIR;
try {
  db.run("INSERT INTO nodes(path,name,kind,cls) VALUES (?, 'fixture', 'dir', 'folder')", temp);
  const nodeId = db.get('SELECT id FROM nodes').id;
  const cache = new GraphCache(); cache.load(db, cfg);
  let spawned;
  const terms = { list: () => [], get: () => undefined, spawn: opts => { spawned = opts; return { info: { id: 'fixture', agent: opts.agent } }; } };
  const ctx = { cfg, db, cache, teams: new Teams(temp), terms, changed() {} };
  const request = async (path, method, body, authorization) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { url: path, method, headers: authorization ? { authorization } : {} });
    let status, data;
    await handleApi(ctx, req, { writeHead(code) { status = code; }, end(text) { data = JSON.parse(text); } });
    return { status, data };
  };
  const task = await request(`/api/work/${nodeId}/tasks`, 'POST', { from: 'user', title: 'A task <with> content', assignedTo: null, scope: [] });
  assert.equal(task.status, 201);
  assert.equal(new Teams(temp).get(nodeId).tasks[0].title, 'A task <with> content');
  assert.equal((await request(`/api/work/${nodeId}/tasks/${task.data.id}`, 'PATCH', { from: 'user', status: 'done' })).data.status, 'done');
  assert.equal((await request(`/api/work/${nodeId}/tasks/${task.data.id}`, 'PATCH', { from: 'user', status: 'pending', assignedTo: null })).data.status, 'pending');
  assert.equal((await request(`/api/work/${nodeId}/tasks`, 'POST', { from: 'user', title: ' ' })).status, 400);
  assert.equal(new Teams(temp).get(nodeId).tasks.length, 1);
  console.log('PASS create, persist, complete and reopen tasks without agents; invalid input rejected');

  const detail = { id: nodeId, path: temp, name: 'fixture', kind: 'dir', cls: 'folder', bytes: 0, files: 0, edges: [], children: [], notes: [] };
  for (const model of ['', 'opus', 'sonnet', 'haiku', 'claude-opus-5-5']) {
    assert.ok(effortChoices('claude', model).includes('max'));
    for (const effort of ['xhigh', 'max']) {
      await startSession(ctx, detail, { id: nodeId, agent: 'claude', mode: 'embedded', model, effort });
      assert.equal(spawned.args[spawned.args.indexOf('--effort') + 1], effort);
    }
  }
  assert.deepEqual(modelCatalog().claude[0].efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  await assert.rejects(() => startSession(ctx, detail, { agent: 'claude', mode: 'embedded', model: 'claude-opus-4-6', effort: 'xhigh' }), /non supportato/);
  await assert.rejects(() => startSession(ctx, detail, { agent: 'claude', mode: 'embedded', effort: 'ultra' }), /non supportato/);
  assert.deepEqual(effortChoices('claude', 'claude-haiku-4-5'), []);
  console.log('PASS Claude Auto, aliases, custom model IDs and supported/rejected effort levels');

  assert.ok(harnessCatalog(cfg).every(h => !h.installed));
  assert.equal((await request('/api/harnesses/install', 'POST', { harness: 'deepseek' }, 'Bearer fake')).status, 403);
  assert.equal((await request('/api/harnesses/install', 'POST', { harness: '../escape' })).status, 400);
  await assert.rejects(() => launchHarness(terms, cfg, detail, null, { harness: 'deepseek', action: 'run', prompt: 'task' }), /non installato/);
  for (const path of Object.values(harnessPaths(cfg))) {
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, `#!${process.execPath}\nrequire('node:fs').appendFileSync(process.env.VB_TEST_ARGS, JSON.stringify(process.argv.slice(2))+'\\n');\n`, { mode: 0o755 });
  }
  assert.ok(harnessCatalog(cfg).every(h => h.installed));
  const ready = await request('/api/harnesses/install', 'POST', { harness: 'deepseek' });
  assert.equal(ready.status, 202); assert.equal(ready.data.state, 'ready');
  assert.equal((await request('/api/launch-harness', 'POST', { id: nodeId }, 'Bearer fake')).status, 403);
  await assert.rejects(() => launchHarness(terms, cfg, detail, null, { harness: '__proto__', action: 'run', prompt: 'task' }), /sconosciuto/);
  await assert.rejects(() => launchHarness(terms, cfg, detail, null, { harness: 'deepseek', action: 'run', prompt: '' }), /Testo richiesto/);
  await assert.rejects(() => launchHarness(terms, cfg, detail, null, { harness: 'harness2-cli', action: 'run', prompt: 'task', maxCalls: 201 }), /Limite/);
  await assert.rejects(() => launchHarness(terms, cfg, detail, null, { harness: 'harness2-cli', action: 'prepare', prompt: 'task' }), /progetto Git/);
  const prompt = `quotes " ' ; $(touch ${join(temp, 'injected')})\n--help`;
  await launchHarness(terms, cfg, detail, null, { harness: 'deepseek', action: 'run', prompt });
  assert.equal(spawned.agent, 'shell'); assert.equal(spawned.role, undefined);
  const manifest = JSON.parse(readFileSync(spawned.args[1], 'utf8'));
  assert.ok(manifest.prompt.includes(prompt));
  const log = join(temp, 'argv.jsonl');
  const output = spawnSync(spawned.file, spawned.args, { cwd: temp, encoding: 'utf8', env: { ...process.env, VB_TEST_ARGS: log } });
  assert.equal(output.status, 0, output.stderr);
  assert.deepEqual(JSON.parse(readFileSync(log, 'utf8').trim()), ['headless', '--', manifest.prompt]);
  assert.ok(!existsSync(join(temp, 'injected')));
  console.log('PASS installed/missing harnesses, auth and input guards, shell-safe prompt forwarding; no team role');

  // A server that runs inside the app: the runner of a harness terminal, and the `node` a harness finds on its PATH, are
  // the copy of Node kept in the profile. A harness left open through an update keeps nothing of the old app in use.
  if (process.platform === 'darwin') {
    const app = join(temp, 'Live/Visual Brain.app'), runtime = join(app, 'Contents/Resources/runtime');
    mkdirSync(join(runtime, 'server/src/server'), { recursive: true });
    const bundled = join(runtime, `node-${process.arch}`), runner = join(runtime, 'server/src/server/harness-runner.mjs');
    copyFileSync(process.execPath, bundled, constants.COPYFILE_FICLONE);
    copyFileSync(fileURLToPath(new URL('../src/server/harness-runner.mjs', import.meta.url)), runner);
    const ready = join(temp, 'dsh-ready'), stop = join(temp, 'dsh-stop');
    // a harness that stays open, started through `node` on PATH as the real dsh is
    writeFileSync(harnessPaths(cfg).deepseek, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.VB_READY, process.execPath);
const wait = setInterval(() => { if (fs.existsSync(process.env.VB_STOP)) clearInterval(wait); }, 50);
`, { mode: 0o755 });
    const own = process.execPath;
    process.execPath = bundled;
    try { await launchHarness(terms, cfg, detail, null, { harness: 'deepseek', action: 'run', prompt: 'task' }); } finally { process.execPath = own; }
    const node = join(temp, 'agent-runtime/node');
    assert.equal(spawned.file, node, 'the runner starts on the Node of the profile');
    assert.equal(readlinkSync(join(temp, 'harnesses/tools/node')), node, 'and so does what a harness starts with `node`');
    const child = spawn(spawned.file, [runner, spawned.args[1]], { cwd: temp, stdio: 'ignore', env: { ...spawned.env, VB_READY: ready, VB_STOP: stop } });
    const ended = new Promise(done => child.once('exit', done));
    try {
      for (let i = 0; i < 200 && !existsSync(ready); i++) await new Promise(r => setTimeout(r, 50));
      assert.equal(readFileSync(ready, 'utf8'), realpathSync(node), 'the harness itself runs on that Node');
      const users = spawnSync('/usr/sbin/lsof', ['-F', 'p', '+D', app], { encoding: 'utf8' }).stdout;
      assert.equal(users.split('\n').filter(line => line.startsWith('p')).length, 0, 'neither the runner nor the harness keeps a file of the app open');
      rmSync(app, { recursive: true, force: true });   // the copy of the app they were started from leaves the disk
      writeFileSync(stop, '');
      assert.equal(await ended, 0, 'and the run ends cleanly without it');
    } finally { child.kill(); }
    console.log('PASS harness terminal, live: runner and harness on the Node of the profile, nothing of the app held, clean end after the app copy is removed');
  }
} finally {
  db.close();
  if (oldHarnessRoot === undefined) delete process.env.VISUAL_BRAIN_HARNESSES_DIR; else process.env.VISUAL_BRAIN_HARNESSES_DIR = oldHarnessRoot;
  rmSync(temp, { recursive: true, force: true });
}
