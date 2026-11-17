// Real board handlers and durable files, deterministic time, fixture CLI metadata and terminal identities.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Teams } from '../src/server/team.ts';
import { handleApi } from '../src/server/api.ts';
import { QuotaRouter } from '../src/server/quota-router.ts';
import { codexSample } from '../src/server/quota-sources.ts';
import { observation } from '../src/server/provider-quota.mjs';
import { DEFAULTS } from '../src/server/config.ts';

const tmp=mkdtempSync(join(tmpdir(),'vb-quota-')), clock=Date.now;
let now=clock();Date.now=()=>now;
const node=7, ui='/api/mega-stats/routing?node=7&team=1',work='/api/work/7';
const sessions=[
  ['leader','codex','orchestrator'],['c','codex','operator'],['a','claude','operator'],['r','claude','reviewer'],['h','hermes','operator'],
].map(([id,agent,role])=>({id,agent,role,nodeId:node,alive:true,createdAt:now,workState:'idle'}));
const terms=new Map(sessions.map(info=>[info.id,{info,teamToken:'fixture-'+info.id,seenMessage:0,activity:{}}]));
const ctx={cfg:{...DEFAULTS,dataDir:tmp,agents:{codex:'/usr/bin/true',claude:'/usr/bin/true',hermes:'/usr/bin/true',agy:'/bin/false'}},
  terms:{get:id=>terms.get(id),list:()=>sessions,deliver:()=>true},cache:{nodes:new Map([[node,{id:node,name:'Fixture',kind:'dir',path:tmp}]])},
  teams:new Teams(tmp),routing:new QuotaRouter(tmp)};
async function api(method,url,payload,id=null,expected=200){
  const req=Readable.from(payload==null?[]:[Buffer.from(JSON.stringify(id?{...payload,from:id}:payload))]);req.method=method;req.url=url;
  req.headers=id?{authorization:'Bearer '+terms.get(id).teamToken}:{'sec-fetch-site':'same-origin'};
  let status,data;await handleApi(ctx,req,{writeHead(s){status=s;},end(text){data=JSON.parse(text);}});
  assert.equal(status,expected,JSON.stringify(data));return data;
}
const rules=()=>api('GET',ui);
const quota=(id,body)=>api('POST',work+'/quota',body,id);
const create=(title,options={})=>api('POST',work+'/tasks',{title,...options},'leader',201);
const patch=(id,status,owner)=>api('PATCH',work+'/tasks/'+id,{status},owner);
const hand=(task,body,owner,status=200)=>api('POST',work+'/handoff/'+task.id,body,owner,status);
const checkpoint={handoffId:'step-1',safeToResume:true,verified:'Checksum verificato, nessuna operazione in corso',next:'Controllare il secondo file'};
const reset=Math.floor(now/1000)+18_000;
const native=(used=30,allowed=true)=>codexSample({accountId:'fixture-account',ordinaryUsageAllowed:allowed,rateLimits:{primary:{usedPercent:used,windowDurationMins:300,resetsAt:reset}}},now);
try{
  let rule=(await rules()).rule;
  rule={...rule,enabled:true,providers:['codex','claude'],preference:'codex',marginPct:15};
  await api('PUT',ui,rule);
  const task=await create('Verificare due file');
  assert.equal(task.assignedTo,null,'unknown quota waits by default');
  await api('PATCH',work+'/tasks/'+task.id,{status:'working'},'c',409);
  ctx.routing.observe('codex','codex',native());
  ctx.routing.tick(ctx,now);
  assert.equal(ctx.teams.get(node).tasks[0].assignedTo,'c');
  await patch(task.id,'working','c');
  const claude=observation({rate_limits:{five_hour:{used_percentage:20,resets_at:reset}}});
  assert.equal(claude.windows[0].minutes,300);
  assert.equal(observation({error:'unknown'}),null);
  await quota('a',claude);
  await quota('c',{limited:true,windows:[],retryAfter:120});
  await quota('a',observation({hook_event_name:'StopFailure',error:'rate_limit',error_details:'Retry-After: 60'}));
  const q=(await rules()).quotas;
  assert.equal(q.find(g=>g.provider==='claude').blockedUntil,now+60_000);
  assert.equal(ctx.teams.get(node).tasks[0].assignedTo,'c','rate limit does not interrupt current work');
  await hand(task,{...checkpoint,safeToResume:false},'c',400);
  await hand(task,checkpoint,'r',403);
  const waiting=await hand(task,checkpoint,'c');
  assert.equal(waiting.status,'blocked');assert.equal(waiting.assignedTo,'c');assert.equal(waiting.routing.handoff.to,null);
  const second=await create('In coda durante i due limiti');assert.equal(second.assignedTo,null);
  const beforeMessages=ctx.teams.get(node).messages.length;
  ctx.teams=new Teams(tmp);ctx.routing=new QuotaRouter(tmp);
  now+=59_999;ctx.routing.tick(ctx,now);
  assert.equal(ctx.teams.get(node).tasks[0].assignedTo,'c');
  now+=1;ctx.routing.tick(ctx,now);
  const assigned=ctx.teams.get(node).tasks[0];assert.equal(assigned.assignedTo,'a');assert.equal(assigned.status,'pending');
  assert.equal(assigned.routing.handoff.verified,checkpoint.verified);assert.equal(assigned.routing.handoff.next,checkpoint.next);
  assert.equal(assigned.routing.handoff.to,'a');
  await hand(task,checkpoint,'c');ctx.routing.tick(ctx,now);
  assert.equal(ctx.teams.get(node).messages.length,beforeMessages+1,'restart, replayed handoff and scheduler produce one successor notice');
  assert.equal(ctx.teams.get(node).tasks[1].assignedTo,null,'one owner cannot start two routed tasks');
  await patch(task.id,'working','a');await patch(task.id,'done','a');
  ctx.routing.tick(ctx,now);assert.equal(ctx.teams.get(node).tasks[1].assignedTo,'a');
  await patch(second.id,'done','a');
  const pooled={...rule,groups:{...rule.groups,codex:'shared',claude:'shared'}};
  await api('PUT',ui,pooled);await quota('a',{limited:true,windows:[],retryAfter:200});
  assert.ok((await rules()).quotas.filter(q=>['codex','claude'].includes(q.provider)).every(q=>q.limited),'shared limit applies across providers');
  const review=await create('Serve un revisore',{requiredRole:'reviewer'});assert.equal(review.assignedTo,null);
  now+=200_000;await quota('r',claude);ctx.routing.tick(ctx,now);
  assert.equal(ctx.teams.get(node).tasks.at(-1).assignedTo,'r','only compatible role is selected');
  await patch(review.id,'done','r');
  ctx.routing.observe('codex','codex',native(93));await api('PUT',ui,{...rule,providers:['codex']});
  const margin=await create('Margine riservato');assert.equal(margin.assignedTo,null);
  assert.equal((await rules()).quotas.find(q=>q.provider==='codex').status,'margin');
  now+=360_000;await api('PUT',ui,{...rule,providers:['hermes'],allowUnknown:true});
  assert.equal(ctx.teams.get(node).tasks.find(t=>t.id===margin.id).assignedTo,'h');
  assert.match(ctx.teams.get(node).tasks.find(t=>t.id===margin.id).routing.reason,/ignota/);
  await patch(margin.id,'working','h');ctx.teams.release(node,'h');
  assert.equal(ctx.teams.get(node).tasks.at(-1).assignedTo,'h','lost owner never silently replays non-repeatable work');
  console.log('PASS local task API: role/provider eligibility, margin, unknown quota, shared pool, simultaneous exhaustion, Retry-After, safe handoff, restart, one notice and resumption at reset');
} finally{Date.now=clock;rmSync(tmp,{recursive:true,force:true});}
