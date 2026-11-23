// Updates of the agent CLIs from Impostazioni: version compare, the Hermes check, and the update itself run in the
// background with a fake CLI (a shell script), never a real one.
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliUpdates, forgetCliUpdates, newer, parseHermesCheck, startCliUpdate } from '../src/server/cli-updates.ts';
import { DEFAULTS } from '../src/server/config.ts';

assert.equal(newer('2.1.331', '2.1.330'), true);
assert.equal(newer('2.1.330', '2.1.330'), false);
assert.equal(newer('2.1.330', '2.1.331'), false, 'an older registry answer is not an update');
assert.equal(newer('0.10.0', '0.9.9'), true, 'numbers, not text');
assert.equal(newer('1.2', '1.2.0'), false);
assert.equal(newer('v0.23.3', '0.23.1 (stable)'), true, 'prefixes and suffixes are ignored');
assert.equal(newer(null, '1.0.0'), null);
assert.equal(newer('1.0.0', null), null);
console.log('PASS version compare: numeric, tolerant of prefixes, unknown when a side is missing');

assert.equal(parseHermesCheck(0, 'Checking…\nSelected release available: stable v0.23.3\n', '0.23.1'), '0.23.3');
assert.equal(parseHermesCheck(0, 'You are up to date.', '0.23.3'), '0.23.3');
assert.equal(parseHermesCheck(1, 'network error', '0.23.1'), null);
assert.equal(parseHermesCheck(null, '', '0.23.1'), null, 'a check that timed out says nothing');
console.log('PASS hermes update --check: the release it names, or the current one when up to date');

const dir = mkdtempSync(join(tmpdir(), 'vb-cli-updates-'));
try {
  // A fake Antigravity (no published version, so no network): --version reads a file the update rewrites.
  const state = join(dir, 'version'), bin = join(dir, 'agy');
  writeFileSync(state, '1.5.12\n');
  writeFileSync(bin, `#!/bin/sh
case "$1" in
  --version) echo "agy $(cat '${state}')";;
  update) if [ -t 0 ]; then echo "stdin is a terminal"; exit 3; fi
          printf '\\033[32mDownloading\\033[0m 1.5.13\\n'; sleep 0.2; echo '1.5.13' > '${state}'; echo "Updated"; exit 0;;
  fail) exit 1;;
esac
`);
  chmodSync(bin, 0o755);
  const cfg = { ...DEFAULTS, agents: { ...DEFAULTS.agents, agy: bin, claude: join(dir, 'missing-claude'), codex: join(dir, 'missing-codex'), hermes: join(dir, 'missing-hermes') } };
  forgetCliUpdates();

  let list = await cliUpdates(cfg);
  let agy = list.find(u => u.id === 'agy');
  assert.equal(agy.current, '1.5.12');
  assert.equal(agy.canCheck, false);
  assert.equal(agy.available, null, 'no check: unknown, not «up to date»');
  assert.equal(list.find(u => u.id === 'claude').current, null, 'a missing CLI has no version and no check');

  const job = await startCliUpdate(cfg, 'agy');
  assert.equal(job.state, 'running');
  assert.equal(job.from, '1.5.12');
  assert.strictEqual(await startCliUpdate(cfg, 'agy'), job, 'one update at a time per CLI');
  for (let i = 0; i < 100 && job.state === 'running'; i++) await new Promise(r => setTimeout(r, 50));
  assert.equal(job.state, 'done', job.log);
  assert.equal(job.to, '1.5.13', 'the version is read again after the update');
  assert.ok(job.log.includes('Downloading 1.5.13') && !job.log.includes('\x1b'), 'the log keeps the text, not the colours');
  assert.ok(!job.log.includes('stdin is a terminal'), 'no prompt can wait for an answer');
  list = await cliUpdates(cfg);
  agy = list.find(u => u.id === 'agy');
  assert.equal(agy.current, '1.5.13', 'the card shows the new version without waiting for the cache');
  assert.equal(agy.job.state, 'done');

  await assert.rejects(startCliUpdate(cfg, 'claude'), /non è installato/);
  assert.equal((await cliUpdates(cfg)).find(u => u.id === 'claude').job, null, 'a refused update leaves no job behind');
  console.log('PASS background update: one job per CLI, no prompts, log without colours, new version read back');

  // A failing update ends as failed with its output.
  writeFileSync(bin, `#!/bin/sh\ncase "$1" in --version) echo "1.5.13";; update) echo "permission denied" >&2; exit 1;; esac\n`);
  forgetCliUpdates();
  const failed = await startCliUpdate(cfg, 'agy');
  for (let i = 0; i < 100 && failed.state === 'running'; i++) await new Promise(r => setTimeout(r, 50));
  assert.equal(failed.state, 'failed');
  assert.ok(failed.log.includes('permission denied'));
  console.log('PASS a failed update keeps its log for the window');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
