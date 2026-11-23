// Impostazioni → Agenti: reading each CLI's own sign-in answer, and the commands run in a visible terminal.
import assert from 'node:assert/strict';
import { CLI_SPECS, cliAction, isCli, parseSignedIn } from '../src/server/agent-clis.ts';
import { DEFAULTS } from '../src/server/config.ts';

assert.deepEqual(parseSignedIn('claude', 0, '{"loggedIn": true, "authMethod": "claude.ai"}'), { signedIn: true, account: 'claude.ai' });
assert.deepEqual(parseSignedIn('claude', 1, '{"loggedIn": false}'), { signedIn: false, account: null });
assert.deepEqual(parseSignedIn('codex', 0, 'Logged in using ChatGPT\n'), { signedIn: true, account: 'ChatGPT' });
assert.deepEqual(parseSignedIn('codex', 1, 'Not logged in\n'), { signedIn: false, account: null });
assert.deepEqual(parseSignedIn('claude', null, ''), { signedIn: null, account: null }, 'a probe that timed out says nothing');
assert.deepEqual(parseSignedIn('hermes', 0, 'anything'), { signedIn: null, account: null });
console.log('PASS sign-in read from claude auth status and codex login status; unknown stays unknown');

const cfg = { ...DEFAULTS, agents: { ...DEFAULTS.agents, claude: "/opt/my claude's/bin/claude" } };
const login = cliAction(cfg, 'claude', 'login');
assert.equal(login.args[0], '-lic');
assert.ok(login.args[1].startsWith(`'/opt/my claude'\\''s/bin/claude' 'auth' 'login';`), 'the configured path is quoted, never interpreted');
assert.ok(cliAction(cfg, 'claude', 'update').args[1].includes("'update'"));
assert.ok(cliAction(cfg, 'codex', 'update').args[1].startsWith("'codex' 'update'"), 'every CLI updates with its own command');
assert.ok(Object.values(CLI_SPECS).every(spec => spec.update?.[0] === 'update'));
assert.ok(cliAction(cfg, 'codex', 'install').args[1].startsWith('curl -fsSL https://chatgpt.com/codex/install.sh | sh;'));
assert.throws(() => cliAction(cfg, 'agy', 'logout'));
assert.ok(/vb_code=\$\?/.test(login.args[1]), 'the exit code of the command itself is reported');
assert.ok(isCli('codex') && !isCli('shell') && !isCli('__proto__'));
console.log('PASS official install/update/login commands, quoted executables, no logout where the CLI has none');
