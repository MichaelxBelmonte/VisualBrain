// Per-session stdio bridge: the CLI's tool process talks to the local API, independently of shell sandbox networking.
// Every agent gets the read-only graph tool; team sessions also get their board.
// No filesystem tools, arbitrary URLs, user impersonation or automatic retries of writes.
import { createInterface } from 'node:readline';

const tool = {
  name: 'team_request',
  description: 'Visual Brain team board for this session only. read gets relevant tasks/messages and connected peers. Plain read consumes messages as before. Opt in with read data {consumer}: process the returned page, then explicitly ack {consumer,through:delivery.next}. Until ACK the page is redelivered. read {consumer,after:N} replays retained messages without advancing the cursor. The board keeps 500 messages. A normal read with delivery.gap returns no messages. Reconcile from current board state, then explicitly ack {consumer,through:gap.to,acceptGapThrough:gap.to} before continuing. The first forward consumer drives this terminal’s notices; other cursors are independent. records {before?} lists the project register; record {entryId,kind,decision,nextOwner,taskId?,sha?,artifact?} adds a decision or publication. state sets working/idle/blocked. message sends {to:session|null,text}. create_task uses {title,scope,assignedTo?}. update_task needs taskId and {status,result?,assignedTo?}. summary uses {summary}. spawn uses {agent,model?,effort?,role,task}, only when the orchestrator policy allows it. propose (Main Brain only) uses {name,objective,members:[{agent,role,model?,effort?}]} and asks the user to start a new squad. handoff(taskId) needs {handoffId,verified,next,safeToResume:true} at a verified safe checkpoint. quota reports an explicit provider limit with {limited:true,windows:[],retryAfter?} (seconds or HTTP date). A message answered with held is waiting on the user\'s sorting board: do not repeat it. data contains those fields; session identity and authentication are automatic. Never use a different node URL or from identity.',
  inputSchema: { type: 'object', properties: {
    operation: { type: 'string', enum: ['read', 'state', 'message', 'create_task', 'update_task', 'summary', 'spawn', 'propose', 'handoff', 'quota', 'ack', 'records', 'record'] },
    taskId: { type: 'string' }, data: { type: 'object', additionalProperties: true },
  }, required: ['operation'], additionalProperties: false },
};

const exploreTool = {
  name: 'brain_explore',
  description: 'Read-only map of the user\'s files built by Visual Brain. No arguments: your own node with its links (imports, links, paths, mentions, duplicates, similar files), children and notes. target: a path (absolute, ~/, or relative to your node) or node id. depth 2 adds the files linked to those links. query alone searches names and indexed text. to with target gives the shortest chain of links between two files. Use it before reading many files to find what is related; verified links are certain, the others are hints.',
  inputSchema: { type: 'object', properties: {
    target: { type: 'string' }, query: { type: 'string' }, to: { type: 'string' }, depth: { type: 'integer', minimum: 1, maximum: 2 },
  }, additionalProperties: false },
};

async function exploreRequest(args) {
  const url = new URL(process.env.VB_EXPLORE_URL || 'about:blank');
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/api/explore' || !/^\?node=[1-9]\d*$/.test(url.search) || url.username || url.password || url.hash) throw Error('Visual Brain: invalid local graph endpoint. Launch the agent from its node.');
  if (args !== undefined && (!args || typeof args !== 'object' || Array.isArray(args))) throw Error('Invalid arguments');
  for (const key of ['target', 'query', 'to']) {
    const value = args?.[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length > 1000) throw Error(`${key} must be a string of at most 1000 characters`);
    url.searchParams.set(key, value);
  }
  if (args?.depth !== undefined) url.searchParams.set('depth', String(args.depth === 2 ? 2 : 1));
  let response;
  try { response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(8000) }); }
  catch { throw Error('Visual Brain API unavailable. Check that the app is open.'); }
  const text = await response.text();
  if (!response.ok) { let message; try { message = JSON.parse(text).error; } catch {} throw Error(`Visual Brain ${response.status}: ${message || 'request refused'}`); }
  return { content: [{ type: 'text', text }] };
}
const team = Boolean(process.env.VB_STATE_URL);
const tools = [exploreTool, ...(team ? [tool] : [])];

async function request(args) {
  const state = new URL(process.env.VB_STATE_URL || 'about:blank');
  if (state.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(state.hostname) || !/^\/api\/work\/[1-9]\d*\/state$/.test(state.pathname) || state.username || state.password || state.search || state.hash) throw Error('Visual Brain: invalid local session endpoint. Launch the agent from its node.');
  const session = process.env.VB_SESSION_ID, token = process.env.VB_TEAM_TOKEN;
  if (!session || !token) throw Error('Visual Brain: missing session identity. Launch the agent from its node.');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw Error('Invalid arguments');
  const routes = { read: ['GET', ''], state: ['POST', '/state'], message: ['POST', '/messages'], create_task: ['POST', '/tasks'], update_task: ['PATCH', '/tasks'], summary: ['PATCH', ''], spawn: ['POST', '/spawn'], propose: ['POST', '/proposals'], handoff:['POST','/handoff'], quota:['POST','/quota'], ack:['POST','/ack'], records:['GET','/records'], record:['POST','/records'] };
  if (!Object.hasOwn(routes, args.operation)) throw Error('Unknown team operation');
  const [method, suffix] = routes[args.operation];
  const data = args.data ?? {};
  if (typeof data !== 'object' || Array.isArray(data) || (data.from !== undefined && data.from !== session)) throw Error('This tool can act only as its own session');
  state.pathname = state.pathname.slice(0, -6) + suffix;
  if (args.operation === 'update_task' || args.operation === 'handoff') {
    if (typeof args.taskId !== 'string' || !/^[a-z0-9-]{1,80}$/.test(args.taskId)) throw Error('A valid taskId is required');
    state.pathname += '/' + args.taskId;
  }
  if (method === 'GET') {
    state.searchParams.set('session', session);
    if (args.operation === 'records' && data.before !== undefined) state.searchParams.set('before', String(data.before));
    if (args.operation === 'read') {
      if (data.consumer !== undefined) {
        if (typeof data.consumer !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(data.consumer)) throw Error('Invalid consumer name');
        state.searchParams.set('consumer', data.consumer);
      }
      if (data.after !== undefined) {
        if (data.consumer === undefined || !Number.isSafeInteger(data.after) || data.after < 0) throw Error('Replay needs a consumer and a nonnegative integer offset');
        state.searchParams.set('after', String(data.after));
      }
    }
  }
  const body = method === 'GET' ? undefined : JSON.stringify({ ...data, from: session });
  if (body && body.length > 64_000) throw Error('Team request too large');
  let response;
  try {
    response = await fetch(state, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body, redirect: 'error', signal: AbortSignal.timeout(8000) });
  } catch { throw Error('Visual Brain API unavailable. Check that the app is open; retry when it is available. A write is never retried automatically.'); }
  const text = await response.text();
  if (!response.ok) { let message; try { message = JSON.parse(text).error; } catch {} throw Error(`Visual Brain ${response.status}: ${message || 'request refused'}`); }
  return { content: [{ type: 'text', text: text || '{}' }] };
}
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
// Serialize calls so reading the board cannot race the same session's next state/message update.
let pending = Promise.resolve();
lines.on('line', line => {
  pending = pending.then(async () => {
    let message;
    try { if (line.length > 256_000) throw Error(); message = JSON.parse(line); }
    catch { send({ id: null, error: { code: -32700, message: 'Invalid JSON-RPC input' } }); return; }
    if (message.id === undefined) return; // MCP initialized/cancel notifications have no response.
    const id = message.id;
    if (message.method === 'initialize') send({ id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'visual-brain-team', version: '1.0.0' } } });
    else if (message.method === 'ping') send({ id, result: {} });
    else if (message.method === 'tools/list') send({ id, result: { tools } });
    else if (message.method === 'tools/call') {
      try {
        const name = message.params?.name;
        if (name === exploreTool.name) send({ id, result: await exploreRequest(message.params.arguments) });
        else if (name === tool.name && team) send({ id, result: await request(message.params.arguments) });
        else throw Error('Unknown tool');
      } catch (error) { send({ id, result: { isError: true, content: [{ type: 'text', text: error.message }] } }); }
    } else send({ id, error: { code: -32601, message: 'Method not found' } });
  }).catch(() => send({ id: null, error: { code: -32603, message: 'Visual Brain bridge error' } }));
});
