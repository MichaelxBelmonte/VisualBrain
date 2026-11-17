// Disposable HTTP API + actual stdio child processes. No models, user sessions or live profile.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { launchEmbedded } from '../src/server/launch.ts';
import { DEFAULTS } from '../src/server/config.ts';

const runtimeArg=process.argv.find(a=>a.startsWith('--runtime='));
const runtime=runtimeArg?resolve(runtimeArg.slice(10)):null;
const arch=process.argv.find(a=>a.startsWith('--arch='))?.slice(7)||process.arch;
const executable=runtime?join(runtime,`node-${arch}`):process.execPath;
const bridge=runtime?join(runtime,'server/src/server/team-mcp.mjs'):new URL('../src/server/team-mcp.mjs',import.meta.url).pathname;
const children=[], calls=[], inbox=[];
let expired=false;
const server=createServer(async(req,res)=>{
  let text=''; for await(const data of req) text+=data;
  const data=text?JSON.parse(text):null, url=new URL(req.url,'http://local');
  calls.push({path:url.pathname,session:url.searchParams.get('session'),method:req.method,auth:req.headers.authorization,data});
  if(expired) {res.writeHead(403);res.end(JSON.stringify({error:'Session expired'}));return;}
  assert.match(req.headers.authorization,/^Bearer fixture-[ab]$/);
  if(req.method==='POST' && url.pathname.endsWith('/messages')) inbox.push(data);
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({messages:inbox,ok:true}));
});
await new Promise((ok,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',ok);});
const base=`http://127.0.0.1:${server.address().port}`;
function client(id='a',endpoint=base+'/api/work/1/state'){
  const child=spawn(executable,[bridge],{
    env:{PATH:process.env.PATH,VB_STATE_URL:endpoint,VB_SESSION_ID:id,VB_TEAM_TOKEN:'fixture-'+id},stdio:['pipe','pipe','pipe'],
  });
  children.push(child); const pending=new Map(); let next=1,logs='';
  child.stderr.on('data',d=>logs+=d);
  createInterface({input:child.stdout}).on('line',line=>{const message=JSON.parse(line);pending.get(message.id)?.(message);pending.delete(message.id);});
  const rpc=(method,params)=>new Promise((resolve,reject)=>{
    const requestId=next++, timer=setTimeout(()=>reject(Error('stdio timeout: '+logs)),20000);
    pending.set(requestId,message=>{clearTimeout(timer);resolve(message);});
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:requestId,method,params})+'\n');
  });
  const call=(operation,data,taskId)=>rpc('tools/call',{name:'team_request',arguments:{operation,data,taskId}}).then(r=>r.result);
  return {child,rpc,call};
}
try{
  const a=client();
  assert.equal((await a.rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'test',version:'1'}})).result.protocolVersion,'2024-11-05');
  a.child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  assert.deepEqual((await a.rpc('tools/list',{})).result.tools.map(t=>t.name),['brain_explore','team_request']);
  assert.deepEqual((await a.rpc('ping',{})).result,{});
  await a.call('read'); assert.deepEqual(calls.at(-1),{path:'/api/work/1',session:'a',method:'GET',auth:'Bearer fixture-a',data:null});
  await a.call('state',{state:'working'}); assert.equal(calls.at(-1).data.from,'a');
  await a.call('message',{to:'b',text:'hello from Codex'});
  const b=client('b',base+'/api/work/2/state');
  const board=await b.call('read'); assert.equal(JSON.parse(board.content[0].text).messages.at(-1).text,'hello from Codex');
  await b.call('message',{to:'a',text:'reply from Claude'});
  assert.equal(JSON.parse((await a.call('read')).content[0].text).messages.at(-1).text,'reply from Claude');
  await a.call('create_task',{title:'fixture',scope:['/fixture']});assert.equal(calls.at(-1).path,'/api/work/1/tasks');
  await a.call('update_task',{status:'done',result:'checked'},'task-1');assert.equal(calls.at(-1).path,'/api/work/1/tasks/task-1');assert.equal(calls.at(-1).method,'PATCH');
  await a.call('summary',{summary:'test'});assert.equal(calls.at(-1).path,'/api/work/1');
  await a.call('spawn',{agent:'claude',role:'operator',task:'test'});assert.equal(calls.at(-1).path,'/api/work/1/spawn');
  const count=calls.length;
  for(const args of [ ['message',{from:'user',text:'forged'}],['../team-links',{}],['update_task',{},'../../other'],['message',{text:'x'.repeat(65000)}] ]) assert.equal((await a.call(...args)).isError,true);
  assert.equal(calls.length,count,'invalid requests never reach HTTP');
  const invalid=client('a','https://example.com/api/work/1/state');assert.equal((await invalid.call('read')).isError,true);assert.equal(calls.length,count);
  expired=true;const denied=await a.call('read');assert.equal(denied.isError,true);assert.match(denied.content[0].text,/403/);
  console.log('PASS MCP stdio: handshake, discovery, bidirectional messages, scoped identity, task/state/summary/spawn routes, forged identity/path/host refusal, size limit and expired authentication');

  const launches=[];const terms={spawn:o=>{launches.push(o);return {};}};
  const detail={id:42,name:'fixture'};
  for(const agent of ['codex','claude','hermes']) launchEmbedded(terms,agent,DEFAULTS,detail,'/fixture','prompt',undefined,{role:'operator'});
  const [codex,claude,hermes]=launches;
  const overrides=codex.args.filter(a=>a.startsWith('mcp_servers.visual_brain.'));
  assert.equal(overrides.length,3);assert.ok(overrides.some(a=>a.includes('env_vars=') && a.includes('VB_TEAM_TOKEN')));
  assert.ok(overrides.every(a=>!a.includes(codex.teamToken)),'no token in MCP argv');
  const cfg=JSON.parse(claude.args[claude.args.indexOf('--mcp-config')+1]);
  assert.equal(cfg.mcpServers.visual_brain.type,'stdio');assert.equal(cfg.mcpServers.visual_brain.env.VB_TEAM_TOKEN,'${VB_TEAM_TOKEN}');
  assert.ok(claude.args.includes('--settings'),'existing hooks retained');
  for(const entry of [codex,claude]) {assert.ok(entry.args.every(a=>!a.includes(entry.teamToken)),'session token is never in argv or prompt');assert.match(entry.args.at(-1),/team_request/);assert.ok(!entry.args.includes('--dangerously-bypass-approvals-and-sandbox'));}
  assert.ok(!hermes.args.includes('--mcp-config'));assert.match(hermes.args.at(-1),/sandbox/);
  console.log('PASS launch integration: Codex per-session MCP overrides, Claude merged config and hooks, environment-only credentials, no global permission changes, HTTP fallback instructions');

  // Graph tool alone (agent without a team): read-only, own node by default, no team board.
  const graphCalls=[];
  const graph=createServer((req,res)=>{graphCalls.push({url:req.url,auth:req.headers.authorization});res.writeHead(req.url.includes('missing')?404:200,{'content-type':'application/json'});res.end(JSON.stringify(req.url.includes('missing')?{error:'Nodo non trovato: missing'}:{node:{path:'/fixture'}}));});
  await new Promise(ok=>graph.listen(0,'127.0.0.1',ok));
  try{
    const solo=(url)=>{const child=spawn(executable,[bridge],{env:{PATH:process.env.PATH,VB_EXPLORE_URL:url},stdio:['pipe','pipe','pipe']});children.push(child);const pending=new Map();let next=1;
      createInterface({input:child.stdout}).on('line',line=>{const m=JSON.parse(line);pending.get(m.id)?.(m);pending.delete(m.id);});
      return (method,params)=>new Promise(ok=>{const id=next++;pending.set(id,ok);child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});};
    const rpc=solo(`http://127.0.0.1:${graph.address().port}/api/explore?node=7`);
    assert.deepEqual((await rpc('tools/list',{})).result.tools.map(t=>t.name),['brain_explore'],'no team board without a team session');
    assert.equal((await rpc('tools/call',{name:'team_request',arguments:{operation:'read'}})).result.isError,true);
    assert.equal(JSON.parse((await rpc('tools/call',{name:'brain_explore',arguments:{}})).result.content[0].text).node.path,'/fixture');
    assert.deepEqual(graphCalls.at(-1),{url:'/api/explore?node=7',auth:undefined},'own node by default, no credentials sent');
    await rpc('tools/call',{name:'brain_explore',arguments:{target:'src/a b.ts',depth:2}});
    assert.equal(graphCalls.at(-1).url,'/api/explore?node=7&target=src%2Fa+b.ts&depth=2');
    const missing=(await rpc('tools/call',{name:'brain_explore',arguments:{target:'missing'}})).result;
    assert.equal(missing.isError,true);assert.match(missing.content[0].text,/404: Nodo non trovato/);
    assert.equal((await rpc('tools/call',{name:'brain_explore',arguments:{target:42}})).result.isError,true);
    const before=graphCalls.length;
    const remote=solo('http://example.com/api/explore?node=7');
    assert.match((await remote('tools/call',{name:'brain_explore',arguments:{}})).result.content[0].text,/invalid local graph endpoint/);
    const other=solo(`http://127.0.0.1:${graph.address().port}/api/work/7/state`);
    assert.equal((await other('tools/call',{name:'brain_explore',arguments:{}})).result.isError,true);
    assert.equal(graphCalls.length,before,'refused endpoints are never contacted');
    console.log('PASS brain_explore: read-only graph tool for every Claude/Codex agent, own node by default, local endpoint only');
  } finally { await new Promise(ok=>graph.close(ok)); }
} finally {
  await Promise.all(children.map(async c=>{if(c.exitCode===null){const ended=once(c,'exit');c.kill();await ended;}}));
  await new Promise(resolve=>server.close(resolve));
}
