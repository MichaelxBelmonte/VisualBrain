// Codex lifecycle hook. Send only the event kind and opaque turn ID to this session's local board.
// Do not forward hook payloads, prompt text, assistant output, environment data or transcript paths.
async function report() {
  const { VB_STATE_URL: address, VB_SESSION_ID: session, VB_TEAM_TOKEN: token } = process.env;
  if (!address || !session || !token) return;
  const url = new URL(address);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !/^\/api\/work\/\d+\/state$/.test(url.pathname) || url.username || url.password || url.search || url.hash) return;
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    if (input.length + chunk.length > 2_000_000) return;
    input += chunk;
  }
  const data = JSON.parse(input);
  if (data.agent_id) return; // a subagent is not a separate Visual Brain terminal
  const phase = {SessionStart:'ready', UserPromptSubmit:'start', Stop:'stop', Interrupt:'interrupted'}[data.hook_event_name];
  if (!phase || (phase !== 'ready' && (typeof data.turn_id !== 'string' || !/^[\w-]{1,100}$/.test(data.turn_id)))) return;
  url.pathname = url.pathname.replace(/state$/, 'turn');
  await fetch(url, { method:'POST', redirect:'error', signal:AbortSignal.timeout(1200),
    headers:{ authorization:'Bearer ' + token, 'content-type':'application/json' },
    body:JSON.stringify({from:session,phase,turnId:data.turn_id}) });
}
await report().catch(() => {}); // telemetry never interrupts or adds context to an agent turn
