// Opt-in regression with the installed Codex TUI, real PTYs/MCP, and a deterministic local Responses endpoint.
// Run: node scripts/test-codex-notice.mjs [absolute-path-to-codex]
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const executable = process.argv[2] || execFileSync('which', ['codex'], { encoding: 'utf8' }).trim();
const root = resolve(import.meta.dirname, '..');
const dir = mkdtempSync(join(tmpdir(), 'vb-codex-notice-'));
const profile = join(dir, 'profile'), home = join(dir, 'codex');
mkdirSync(profile); mkdirSync(home);
const clean = { PATH: process.env.PATH, HOME: dir, CODEX_HOME: home, VISUAL_BRAIN_DATA_DIR: profile,
  TMPDIR: dir, SHELL: '/bin/sh', TERM: 'xterm-256color', LANG: 'en_US.UTF-8', OPENAI_API_KEY: 'fixture-only' };
// The detached host inherits this process's environment before it spawns either CLI.
for (const name of Object.keys(process.env)) delete process.env[name];
Object.assign(process.env, clean);

const { TerminalService } = await import('../src/server/terminal-service.ts');
const { Teams } = await import('../src/server/team.ts');
const { handleApi } = await import('../src/server/api.ts');
const { startTeamWatch } = await import('../src/server/team-watch.ts');
const bridge = join(root, 'src/server/team-mcp.mjs');
const receipts = [], submitted = [], roles = ['brain', 'orchestrator'];
let service, ctx, stopWatch, sequence = 0;
const server = createServer(async (req, res) => {
  if (req.url.startsWith('/api/')) {
    if (req.method === 'GET') {
      const end = res.end.bind(res);
      res.end = (body, ...rest) => {
        const board = JSON.parse(body);
        const to = new URL(req.url, 'http://localhost').searchParams.get('session');
        for (const message of board.messages ?? []) receipts.push({ to, id: message.id });
        return end(body, ...rest);
      };
    }
    return handleApi(ctx, req, res);
  }
  if (!req.url.endsWith('/responses')) { res.writeHead(404); return res.end('{}'); }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const request = JSON.parse(Buffer.concat(chunks));
  const input = request.input, last = input.findLastIndex(item => item.role === 'user');
  const text = JSON.stringify(input[last]?.content);
  const notice = text?.includes('Visual Brain ·');
  const answered = input.slice(last + 1).some(item => item.type === 'function_call_output');
  const n = ++sequence;
  let item = { type: 'message', id: 'msg_' + n, role: 'assistant', content: [{ type: 'output_text', text: 'Fixture ready.' }] };
  if (notice && !answered) {
    submitted.push(text);
    const ns = request.tools.find(t => t.tools?.some(tool => tool.name === 'team_request'));
    const flat = request.tools.find(t => t.name?.endsWith('team_request'));
    item = { type: 'function_call', id: 'fc_' + n, call_id: 'call_' + n,
      ...(ns ? { namespace: ns.name } : {}), name: ns ? 'team_request' : flat?.name, arguments: '{"operation":"read"}' };
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const event = (type, fields) => res.write('data: ' + JSON.stringify({ type, ...fields }) + '\n\n');
  const id = 'resp_' + n;
  event('response.created', { response: { id, status: 'in_progress', output: [] } });
  event('response.output_item.added', { output_index: 0, item });
  event('response.output_item.done', { output_index: 0, item });
  event('response.completed', { response: { id, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } });
  res.end();
});
async function until(check, label) {
  const end = Date.now() + 15_000;
  while (!check() && Date.now() < end) await delay(50);
  assert.ok(check(), label);
}
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port, origin = 'http://127.0.0.1:' + port;
  const identity = id => ({ VB_SESSION_ID: id, VB_STATE_URL: origin + '/api/work/7/state', VB_TEAM_TOKEN: 'fixture-' + id });
  writeFileSync(join(home, 'config.toml'), `model = "gpt-5.4"
model_provider = "fixture"
check_for_update_on_startup = false
approval_policy = "never"
sandbox_mode = "read-only"
[analytics]
enabled = false
[model_providers.fixture]
name = "Fixture"
base_url = "${origin}/v1"
wire_api = "responses"
supports_websockets = false
[mcp_servers.visual_brain.tools.team_request]
approval_mode = "approve"
[projects.${JSON.stringify(dir)}]
trust_level = "trusted"
`);
  service = await TerminalService.open(profile, port, () => {});
  ctx = { cfg: { dataDir: profile, host: '127.0.0.1', port }, terms: service,
    teams: new Teams(profile), cache: { nodes: new Map([[7, { id: 7, name: 'fixture', path: dir, kind: 'dir' }]]) } };
  stopWatch = startTeamWatch(ctx);
  async function team(id, operation, data) {
    const env = { ...clean, ...identity(id) };
    const json = await new Promise((ok, fail) => {
      const child = execFile(process.execPath, [bridge], { cwd: dir, env, timeout: 10_000 },
        (error, stdout) => error ? fail(error) : ok(JSON.parse(stdout)));
      child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'team_request', arguments: { operation, data } } }) + '\n');
    });
    assert.ok(!json.result.isError, json.result.content[0].text);
    return JSON.parse(json.result.content[0].text);
  }
  for (const role of roles) {
    const before = sequence;
    const args = ['--no-alt-screen', '-c', 'mcp_servers.visual_brain.command=' + JSON.stringify(process.execPath),
      '-c', 'mcp_servers.visual_brain.args=' + JSON.stringify([bridge]), '-c', 'mcp_servers.visual_brain.env_vars=["VB_SESSION_ID","VB_STATE_URL","VB_TEAM_TOKEN"]', 'fixture setup'];
    const t = await service.spawn({ id: role, role, agent: 'codex', nodeId: 7, cwd: dir, title: role,
      file: executable, args, env: { ...clean, ...identity(role) }, teamToken: identity(role).VB_TEAM_TOKEN });
    // Answer terminal device queries only. No keys, input text or submit from the fixture.
    const render = raw => {
      if (raw.includes('\x1b[6n')) service.write(role, '\x1b[1;1R');
      if (raw.includes('\x1b[c')) service.write(role, '\x1b[?1;2c');
    };
    t.buffer.forEach(render); t.listeners.add(render);
    await until(() => sequence > before && t.buffer.join('').includes('Fixture ready'), role + ' initial turn');
    await team(role, 'state', { state: 'idle' });
  }
  for (const from of roles) {
    const to = roles.find(role => role !== from);
    const message = await team(from, 'message', { to, text: 'Fixture board text only' });
    await until(() => receipts.some(r => r.to === to && r.id === message.id), from + ' → ' + to + ' automatic MCP read');
    console.log('PASS', from, '→', to, 'message', message.id);
  }
  await delay(400);
  assert.equal(receipts.length, 2);
  assert.equal(submitted.length, 2);
  assert.ok(submitted.every(notice => !notice.includes('Fixture board text only')));
} finally {
  stopWatch?.();
  if (service) {
    service.killAll(); await service.flush(); await service.detach();
    await until(() => !existsSync(join(profile, 'terminal-service/host.json')), 'fixture host shutdown');
  }
  server.closeAllConnections(); server.close();
  rmSync(dir, { recursive: true, force: true });
}
