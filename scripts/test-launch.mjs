// Regression: native-app PATH must not override Codex from the login shell.
// Uses fake Codex binaries and an isolated zsh configuration; no API calls.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { agentCommand, launchEmbedded, sessionName } from '../src/server/launch.ts';
import { DEFAULTS } from '../src/server/config.ts';

const temp = mkdtempSync(join(tmpdir(), 'vb-test-launch-'));
const originalShell = process.env.SHELL;
try {
  const oldBin = join(temp, 'old');
  const currentBin = join(temp, 'current');
  const cwd = join(temp, "project with ' quotes");
  for (const dir of [oldBin, currentBin, cwd]) mkdirSync(dir);
  for (const [dir, version] of [[oldBin, 'old'], [currentBin, 'current']]) {
    writeFileSync(join(dir, 'codex'), `#!${process.execPath}\nconsole.log(JSON.stringify({version:${JSON.stringify(version)}, args:process.argv.slice(2), cwd:process.cwd(), login:process.env.VB_TEST_LOGIN}));\n`, { mode: 0o755 });
  }
  writeFileSync(join(temp, '.zshrc'), `export PATH="${currentBin}:$PATH"\nexport VB_TEST_LOGIN=loaded\n`);
  process.env.SHELL = '/bin/zsh';
  const prompt = `Multiple lines\n' \" ; $(touch ${join(temp, 'injected')}) \u0060touch ${join(temp, 'injected')}\u0060 $HOME`;
  let options;
  const fakeTerm = {};
  const terms = { spawn(opts) { options = opts; return fakeTerm; } };
  const detail = { id: 146, name: 'fixture' };
  assert.equal(launchEmbedded(terms, 'codex', DEFAULTS, detail, cwd, prompt, { cols: 90, rows: 25 }), fakeTerm);
  assert.equal(options.agent, 'codex');
  assert.equal(options.nodeId, 146);
  assert.equal(options.cols, 90);
  assert.equal(options.rows, 25);
  const env = { PATH: `${oldBin}:/usr/bin:/bin`, HOME: temp, ZDOTDIR: temp };
  const result = spawnSync(options.file, options.args, { cwd: options.cwd, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const seen = JSON.parse(result.stdout);
  assert.deepEqual({ ...seen, args: seen.args.slice(6) }, { version: 'current', args: ['-C', cwd, '--', seen.args.at(-1)], cwd: realpathSync(cwd), login: 'loaded' });
  assert.ok(seen.args.at(-1).startsWith(prompt + '\n\n') && /brain_explore/.test(seen.args.at(-1)), 'the prompt is passed unchanged, followed by the graph tool hint');
  assert.deepEqual(seen.args.slice(0, 6).filter((_, i) => i % 2 === 0), ['-c', '-c', '-c']);
  assert.equal(seen.args[5], 'mcp_servers.visual_brain.env_vars=["VB_EXPLORE_URL"]', 'a single agent gets the read-only graph tool, not the team board');
  assert.deepEqual(options.env, { VB_EXPLORE_URL: `http://${DEFAULTS.host}:${DEFAULTS.port}/api/explore?node=146` });
  assert.equal(existsSync(join(temp, 'injected')), false);
  console.log('PASS Codex uses login-shell PATH and environment; cwd and prompt preserved without shell expansion');

  const cfg = { ...DEFAULTS, agents: { ...DEFAULTS.agents, codex: join(oldBin, 'codex') } };
  launchEmbedded(terms, 'codex', cfg, detail, cwd, prompt);
  const explicit = spawnSync(options.file, options.args, { cwd, env, encoding: 'utf8' });
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal(JSON.parse(explicit.stdout).version, 'old');
  console.log('PASS explicitly configured Codex executable is respected');

  for (const agent of ['codex', 'claude', 'hermes']) {
    const command = agentCommand(agent, DEFAULTS, prompt, cwd, { model: 'test-model', effort: 'low' });
    assert.equal(command.args[command.args.indexOf('--model') + 1], 'test-model');
    assert.equal(command.args.at(-1), prompt);
    assert.ok(command.args.includes(agent === 'codex' ? 'model_reasoning_effort="low"' : 'low'));
  }
  const agy = agentCommand('agy', DEFAULTS, prompt, cwd, { model: 'test-model', effort: 'low' });
  assert.equal(agy.file, 'agy');
  assert.deepEqual(agy.args, ['--model', 'test-model', '--effort', 'low', '-i', prompt]);
  assert.deepEqual(agentCommand('agy', DEFAULTS, prompt, cwd).args, ['-i', prompt], 'without model or effort the CLI defaults apply');
  console.log('PASS Antigravity (agy) starts interactively with the prompt as last argument');
  console.log('PASS model and reasoning choices are passed as CLI arguments for all providers');

  // The session's name in the CLI's own lists: code and node. Only Claude Code has a launch option for it.
  assert.equal(sessionName('OP3', 'visual-brain'), 'OP3 · visual-brain');
  assert.equal(sessionName(undefined, 'visual-brain'), 'visual-brain', 'a session outside a team is named after its node');
  assert.equal(sessionName('OP3', ' two\nlines\t here '), 'OP3 · two lines here', 'one line');
  assert.equal(sessionName('OP3', 'x'.repeat(200)).length, 80);
  const named = agentCommand('claude', DEFAULTS, prompt, cwd, { model: 'test-model' }, 'OP3 · visual-brain').args;
  assert.deepEqual(named, ['--model', 'test-model', '--name', 'OP3 · visual-brain', '--', prompt], 'the name comes before the prompt separator');
  assert.equal(agentCommand('claude', DEFAULTS, prompt, cwd).args.includes('--name'), false, 'no name, no option');
  for (const agent of ['codex', 'hermes', 'agy']) {
    assert.deepEqual(agentCommand(agent, DEFAULTS, prompt, cwd, {}, 'OP3 · visual-brain').args, agentCommand(agent, DEFAULTS, prompt, cwd).args, `${agent} has no launch option for a session name`);
  }
  launchEmbedded(terms, 'claude', DEFAULTS, detail, cwd, prompt, undefined, { role: 'operator', code: 'OP3' });
  assert.equal(options.args[options.args.indexOf('--name') + 1], 'OP3 · fixture', 'a team session is named with its code and node');
  assert.ok(options.args.indexOf('--name') < options.args.indexOf('--'), 'before the prompt separator');
  assert.equal(options.name, undefined, 'the name shown by Visual Brain stays the user\'s to choose');
  launchEmbedded(terms, 'claude', DEFAULTS, detail, cwd, prompt);
  assert.equal(options.args[options.args.indexOf('--name') + 1], 'fixture');
  launchEmbedded(terms, 'codex', DEFAULTS, detail, cwd, prompt, undefined, { role: 'operator', code: 'OP4' });
  assert.equal(options.args.some(arg => arg.includes('OP4 · fixture')), false, 'Codex is not given a name');
  console.log('PASS Claude Code sessions are named with code and node; other CLIs are left as they are');

  for (const agent of ['claude', 'hermes', 'agy']) {
    launchEmbedded(terms, agent, DEFAULTS, detail, cwd, prompt);
    assert.equal(options.file, DEFAULTS.agents[agent]);
    if (agent === 'claude') {
      assert.ok(options.args.at(-1).startsWith(prompt + '\n\n'), 'the prompt is unchanged, followed by the graph tool hint');
      assert.equal(options.args.includes('--settings'), false, 'team hooks only for team sessions');
      assert.deepEqual(JSON.parse(options.args[options.args.indexOf('--mcp-config') + 1]).mcpServers.visual_brain.env, { VB_EXPLORE_URL: '${VB_EXPLORE_URL}' });
    } else {
      assert.ok(options.args.includes(prompt));
      assert.equal(options.env, undefined, 'agents without MCP configuration get no graph endpoint');
    }
  }
  console.log('PASS Claude and Hermes launch commands unchanged');
} finally {
  if (originalShell === undefined) delete process.env.SHELL;
  else process.env.SHELL = originalShell;
  rmSync(temp, { recursive: true, force: true });
}
