// Deterministic observations on three projects (linked or not: every session counts). No actual user data: the Claude
// Code and Codex records live in temporary CLAUDE_CONFIG_DIR / CODEX_HOME folders.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dir = mkdtempSync(join(tmpdir(),'vb-stats-'));
process.env.CLAUDE_CONFIG_DIR = join(dir,'claude'); process.env.CODEX_HOME = join(dir,'codex');
const { MegaStats } = await import('../src/server/mega-stats.ts');
const { Teams } = await import('../src/server/team.ts');
const { usageOf, forgetUsage } = await import('../src/server/session-usage.ts');

const start = Date.UTC(2026,0,1);
const hour = 3_600_000;
const iso = at => new Date(at).toISOString();
const work = join(dir,'progetto'); mkdirSync(work);
const teams = new Teams(dir);
const members = [
  {id:'a',nodeId:11,agent:'codex',role:'orchestrator',workState:'working',cwd:work,resumeId:'0000aaaa-0000-0000-0000-000000000001'},
  {id:'b',nodeId:20,agent:'claude',role:'operator',workState:'blocked',attention:'permission',cwd:work,resumeId:'0000bbbb-0000-0000-0000-000000000002'},
  {id:'idle',nodeId:20,agent:'codex',role:'operator',workState:'idle'},
  {id:'shell',nodeId:20,agent:'shell'},
  {id:'orphan',nodeId:30,agent:'codex',role:'operator'},
].map(s=>({...s,createdAt:start,alive:true}));

// Claude Code transcript of «b»: one request, a tool result and a command echo (not requests), two answers (the first
// written on two lines with the same id: counted once, with its final usage), and a request before the period.
const claudeDir = join(process.env.CLAUDE_CONFIG_DIR,'projects',realpathSync(work).replace(/[^a-zA-Z0-9]/g,'-'));
mkdirSync(claudeDir,{recursive:true});
const claudeFile = join(claudeDir,`${members[1].resumeId}.jsonl`);
const answer = (at,id,usage,model='claude-opus-5-5') => ({type:'assistant',timestamp:iso(at),message:{id,role:'assistant',model,usage}});
writeFileSync(claudeFile,[
  {type:'user',timestamp:iso(start-30*hour),message:{role:'user',content:'vecchia richiesta'}},
  {type:'user',timestamp:iso(start+1000),message:{role:'user',content:'ciao'}},
  answer(start+3000,'m1',{input_tokens:10,output_tokens:1,cache_read_input_tokens:100,cache_creation_input_tokens:20}),
  answer(start+3100,'m1',{input_tokens:10,output_tokens:7,cache_read_input_tokens:100,cache_creation_input_tokens:20}),
  {type:'user',timestamp:iso(start+3200),message:{role:'user',content:[{type:'tool_result',content:'ok'}]}},
  {type:'user',timestamp:iso(start+3300),message:{role:'user',content:'<command-name>/model</command-name>'}},
  answer(start+4000,'m2',{input_tokens:1,output_tokens:2}),
].map(x=>JSON.stringify(x)).join('\n')+'\n');

// Codex rollout of «a»: a running total before the period and one inside it, one request, the model of the turn.
const day = new Date(start);
const codexDir = join(process.env.CODEX_HOME,'sessions',String(day.getFullYear()),String(day.getMonth()+1).padStart(2,'0'),String(day.getDate()).padStart(2,'0'));
mkdirSync(codexDir,{recursive:true});
const total = (at,input,cached,output) => ({timestamp:iso(at),type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:input,cached_input_tokens:cached,output_tokens:output}}}});
writeFileSync(join(codexDir,`rollout-x-${members[0].resumeId}.jsonl`),[
  {timestamp:iso(start-30*hour),type:'session_meta',payload:{id:members[0].resumeId,cwd:work,timestamp:iso(start-30*hour)}},
  total(start-30*hour,1000,400,50),
  {timestamp:iso(start+500),type:'turn_context',payload:{model:'gpt-6.2-sol'}},
  {timestamp:iso(start+1000),type:'event_msg',payload:{type:'user_message',message:'vai'}},
  {timestamp:iso(start+1000),type:'event_msg',payload:{type:'task_started'}},
  total(start+2000,1500,600,80),
].map(x=>JSON.stringify(x)).join('\n')+'\n');

const ctx = {teams, terms:{list:()=>members,get:id=>{const info=members.find(s=>s.id===id);return info&&{info,activity:{}};}},
  cache:{nodes:new Map([[10,{name:'Atlas',projectId:1}],[11,{name:'docs',projectId:1}],[20,{name:'Boreale',projectId:2}],[30,{name:'Estraneo',projectId:3}]]),
    projectByNode:new Map([[10,1],[20,2],[30,3]]), projects:new Map([[1,{nodeId:10}],[2,{nodeId:20}],[3,{nodeId:30}]])}};
const link = teams.link({srcNodeId:10,dstNodeId:20,srcSessionId:null,dstSessionId:null});
let stats = new MegaStats(join(dir,'stats.sqlite'),()=>{},start);
const filters={project:null,team:null,session:null};
try {
  stats.snapshot(ctx,start);
  const [a,b,idle,,outside]=members;
  for(const [i,ms] of [100,200,300,400,900].entries()){
    const at=start+10000*i;
    stats.turn(a,'start',String(i),at); stats.turn(a,'start',String(i),at+1);
    stats.turn(a,'stop',String(i),at+ms); stats.turn(a,'stop',String(i),at+ms+20);
  }
  stats.turn(a,'start','incomplete',start+60000);
  stats.turn(b,'stop','missing-start',start+3000);
  stats.turn(idle,'ready',undefined,start);
  stats.turn(outside,'start','external',start);
  const scope={node:11,team:'1',sid:'a'};
  for(const [i,ms] of [5,10,15,20,100].entries()) stats.http(scope,ms,i===4?503:200,start+ms);
  stats.http({node:20,team:null,sid:null},2,200,start+1);
  stats.http(undefined,200,200,start+1);
  stats.done(11,'1','a','unique',start+100);stats.done(11,'1','a','unique',start+200);
  stats.done(20,'1','b','unique',start+300);
  const boardTask=teams.createTask(20,'user',{title:'Fixture',assignedTo:'b'});
  teams.changeTask(20,boardTask.id,'user',undefined,{status:'blocked'},'1');
  teams.createTask(20,'user',{title:'Da fare'});
  const r=stats.report(ctx,24,filters,start+hour);
  assert.deepEqual(r.projects.map(p=>p.id).sort(),[10,20,30],'every project with sessions, linked or not');
  assert.equal(r.sessions.length,5);
  assert.deepEqual(r.totals.turnLatency,{n:5,p50Ms:300,p95Ms:900});
  assert.deepEqual(r.totals.httpLatency,{n:6,p50Ms:10,p95Ms:100});
  assert.equal(r.totals.turns,7);assert.equal(r.totals.unpairedTurns,3);
  assert.equal(r.totals.httpErrors,1);assert.equal(r.totals.retries,null);
  assert.equal(r.observedMs,hour);assert.equal(r.totals.completedPerHour,2);assert.equal(r.totals.httpPerHour,6);
  assert.equal(r.unattributedHttp,1);
  assert.equal(r.totals.waiting,1);assert.equal(r.totals.blocked,1);
  const boreale=r.teams.find(t=>t.key==='20:1');
  assert.equal(boreale.blockedTasks,1);assert.deepEqual(boreale.tasks,{pending:1,working:0,blocked:1,done:0},'tasks by status, from the board');
  assert.equal(r.teams.some(t=>t.id==='brain'),false,'a Main Brain that never ran is not listed');
  assert.equal(r.sessions.find(s=>s.id==='idle').metrics.turns,0);
  assert.equal(r.sessions.find(s=>s.id==='shell').metrics.turns,null);
  console.log('PASS every project counts, filters, hook turns, deduplication, quantiles, missing pairs, idle/blocked sessions and tasks by status');

  // Requests and tokens, from the CLIs' own records.
  const claude=r.sessions.find(s=>s.id==='b').usage, codex=r.sessions.find(s=>s.id==='a').usage;
  assert.deepEqual(claude,{turns:1,input:11,output:9,cacheRead:100,cacheWrite:20,model:'claude-opus-5-5'},'one request; an answer on two lines counted once with its final usage');
  assert.deepEqual(codex,{turns:1,input:300,output:30,cacheRead:200,cacheWrite:0,model:'gpt-6.2-sol'},'Codex: the running total minus the one before the period, cache apart');
  assert.equal(r.sessions.find(s=>s.id==='shell').usage,null);
  assert.equal(r.usageMissing,2,'two Codex sessions without a record');
  assert.deepEqual({...r.usage,model:null},{turns:2,input:311,output:39,cacheRead:300,cacheWrite:20,model:null});
  assert.deepEqual(r.accounts.map(x=>[x.key,x.sessions,x.usage.output]),[['claude:',1,9],['codex:',3,30]],'per account: the main accounts of each CLI');
  assert.equal(r.sessions.find(s=>s.id==='a').activeMs,hour,'open for the whole period so far');
  const week=stats.report(ctx,168,filters,start+hour);
  assert.equal(week.sessions.find(s=>s.id==='b').usage.turns,2,'a longer period reaches the older request');
  appendFileSync(claudeFile,JSON.stringify(answer(start+5000,'m3',{input_tokens:4,output_tokens:4},'claude-sonnet-5-5'))+'\n');
  assert.deepEqual(usageOf(claudeFile,'claude',start,start+hour),{turns:1,input:15,output:13,cacheRead:100,cacheWrite:20,model:'claude-sonnet-5-5'},'only the appended lines are read again');
  writeFileSync(claudeFile,JSON.stringify(answer(start+6000,'z',{input_tokens:1,output_tokens:1}))+'\n');
  assert.equal(usageOf(claudeFile,'claude',start,start+hour).output,1,'a replaced record is read from the start');
  const legacy=join(dir,'legacy.jsonl'), current=join(dir,'current.jsonl');
  const event=(at,type)=>JSON.stringify({timestamp:iso(at),type:'event_msg',payload:{type}});
  writeFileSync(legacy,[event(start+1,'user_message'),event(start+2,'user_message')].join('\n')+'\n');
  writeFileSync(current,[event(start+1,'task_started'),event(start+1,'user_message'),event(start+2,'task_started')].join('\n')+'\n');
  assert.equal(usageOf(legacy,'codex',start,start+hour).turns,2,'older Codex: one user_message per request');
  assert.equal(usageOf(current,'codex',start,start+hour).turns,2,'current Codex: task_started, never counted twice');
  forgetUsage();
  console.log('PASS requests and tokens from Claude Code transcripts and Codex rollouts, per session, per account and in total');

  for(const selection of [{session:'a'},{project:'10'},{team:'11:1'}]) {
    const sub=stats.report(ctx,1,{...filters,...selection},start+hour);
    assert.equal(sub.sessions.length,1);assert.equal(sub.totals.http,5);assert.equal(sub.totals.completed,1);
    assert.ok(sub.teams.every(t=>t.key==='11:1'),'squads follow the filters too');
  }
  stats.close(start+hour);stats=new MegaStats(join(dir,'stats.sqlite'),()=>{},start+2*hour);
  const after=stats.report(ctx,24,filters,start+3*hour);
  assert.equal(after.observedMs,2*hour);assert.equal(after.totals.completedPerHour,1);
  teams.unlink(link.id);
  assert.equal(stats.report(ctx,24,filters,start+3*hour).sessions.length,5,'removing a link between nodes hides nothing');
  console.log('PASS orthogonal filters, coverage gaps after a restart, links between nodes irrelevant');
} finally {stats.close(start+3*hour);rmSync(dir,{recursive:true,force:true});}
