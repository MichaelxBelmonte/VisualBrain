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
const { usageOf, forgetUsage, usageBuckets, bucketOf } = await import('../src/server/session-usage.ts');
const { routeOf, timelineEdges } = await import('../src/server/mega-stats.ts');
const { niceScale } = await import('../src/ui/stats-charts.ts');
const { hints } = await import('../src/ui/mega-stats.ts');

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
  // Intervals: they start with the period, end now, and add up to the period's figures.
  const tl=r.timeline, sum=a=>a.reduce((x,y)=>x+y,0);
  assert.equal(tl.edges[0],r.from); assert.equal(tl.edges.at(-1),r.to);
  assert.ok(tl.edges.slice(1,-1).every(e=>new Date(e).getMinutes()===0),'inner edges on the hour (local clock)');
  assert.equal(sum(tl.requests),r.usage.turns,'requests per interval add up to the total');
  assert.equal(sum(tl.tokens.flatMap(s=>s.values)),r.usage.input+r.usage.output,'tokens per interval add up to the total');
  assert.deepEqual(tl.tokens.map(s=>s.key).sort(),['claude:','codex:']);
  assert.equal(timelineEdges(start,start+hour,1).length,13,'an hour: twelve intervals of five minutes');
  assert.equal(timelineEdges(start,start+168*hour,168).length-1>=28,true,'a week: intervals of six hours');
  assert.deepEqual([bucketOf([0,10,20],0),bucketOf([0,10,20],10),bucketOf([0,10,20],20),bucketOf([0,10,20],21)],[0,1,1,-1]);
  assert.deepEqual(niceScale(47_300),{top:60_000,step:20_000}); assert.deepEqual(niceScale(5),{top:6,step:2});
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

  // --- Qualità: task transitions, waits for the person, failed routes (a fresh store, fixed times).
  const q0 = start + 2*hour, min = 60_000;
  const quality = new MegaStats(join(dir,'quality.sqlite'),()=>{},q0);
  try {
    const task = (id,status,assignedTo='b') => ({id,title:'x',scope:[],assignedTo,status,result:'',createdBy:'user',updatedAt:0});
    const step = (before,after,at) => quality.tasks(20,'1',before,after,at);
    step([],[task('x','pending')],q0);
    step([task('x','pending')],[task('x','working')],q0+min);
    step([task('x','working')],[task('x','done')],q0+10*min);
    step([task('x','done')],[task('y','pending'),task('x','done')],q0+10*min+1);
    step([task('x','done'),task('y','pending')],[task('x','pending'),task('y','pending','idle')],q0+11*min);
    step([task('x','pending')],[task('x','blocked')],q0+12*min);
    step([task('x','blocked')],[task('x','working')],q0+20*min);
    step([task('x','working')],[task('x','done')],q0+30*min);
    members[1].attention='permission'; quality.snapshot(ctx,q0+31*min);
    delete members[1].attention; quality.snapshot(ctx,q0+33*min);
    quality.http({node:20,team:null,sid:null},3,404,q0+34*min,'GET '+routeOf('/api/terminals/a1b2c3d4/input?x=1'));
    quality.http({node:20,team:null,sid:null},3,404,q0+34*min,'GET '+routeOf('/api/terminals/e5f6a7b8/input'));
    quality.http(undefined,3,200,q0+34*min,undefined);
    assert.equal(routeOf('/api/work/20/tasks/9f8e7d6c'),'/api/work/:id/tasks/:id','ids and numbers never leave as they are');
    const r=quality.report(ctx,24,filters,q0+40*min).quality;
    assert.deepEqual([r.created,r.completed,r.reopened,r.blocked,r.reassigned],[2,2,1,1,1]);
    assert.deepEqual(r.cycle,{n:2,p50Ms:10*min,p95Ms:30*min},'from creation to «fatto», both closings');
    assert.equal(r.blockedMs,8*min);
    assert.deepEqual([r.waits.n,r.waits.permission,r.waits.open,r.waits.response.p50Ms],[1,1,0,2*min],'a permission answered after two minutes');
    assert.deepEqual(r.waits.histogram,[0,1,0,0,0],'in the 1–5 min group');
    const all=quality.report(ctx,24,filters,q0+40*min);
    assert.equal(all.timeline.completed.reduce((a,b)=>a+b,0),2); assert.equal(all.timeline.reopened.reduce((a,b)=>a+b,0),1);
    const op=r.workers.find(w=>w.role==='operator');
    assert.deepEqual([op.agent,op.model,op.completed,op.reopened],['claude','claude-opus-5-5',2,1],'the reopening counts against whoever closed the task');
    assert.equal(op.tokensPerTask,1,'tokens of the line’s sessions divided by the tasks it closed');
    assert.deepEqual(r.teams.map(t=>[t.key,t.completed]),[['20:1',2]]);
    assert.deepEqual(r.failures,[{route:'GET /api/terminals/:id/input',status:404,n:2}]);
    assert.equal(quality.report(ctx,24,{...filters,project:'10'},q0+40*min).quality.completed,0,'quality follows the filters');
    // Teams reports every save; only changes become rows.
    teams.onTasks=(n,t,b,a)=>quality.tasks(n,t,b,a);
    const live=teams.createTask(20,'user',{title:'Live',assignedTo:'b'});
    teams.message(20,'user','b','ciao');
    teams.changeTask(20,live.id,'user',undefined,{status:'done'},'1');
    quality.heartbeat(ctx,Date.now());
    const today=quality.report(ctx,1,filters,Date.now()+1000).quality;
    assert.deepEqual([today.created,today.completed],[1,1],'a message saves the board without adding rows');
    teams.onTasks=undefined;
    console.log('PASS quality: time to done, rework, blocks, reassignments, waits for the person, failed routes, filters, board hook');

    // Hints: fixed rules on the figures.
    const lat=(p50Ms)=>({n:5,p50Ms,p95Ms:p50Ms});
    const row=(model,completed,reopened,tokensPerTask)=>({key:model,label:'claude',agent:'claude',model,role:'operator',created:completed,completed,reopened,blocked:0,cycle:lat(min),tokensPerTask});
    const base={since:q0,created:10,completed:10,reopened:0,blocked:0,reassigned:0,cycle:lat(min),blockedMs:0,waits:{n:0,open:0,permission:0,input:0,response:lat(null)},workers:[],teams:[],failures:[]};
    assert.deepEqual(hints(base),[]);
    const tips=hints({...base,blocked:4,waits:{n:6,open:0,permission:5,input:1,response:lat(5*min)},
      workers:[row('claude-opus-5-5',4,0,90_000),row('claude-sonnet-5-5',5,2,30_000)]});
    assert.equal(tips.length,4,'slow answers, mostly permissions, rework of one line, frequent blocks');
    assert.ok(tips.some(x=>x.includes('Sonnet 5.5') && x.includes('40%')));
    assert.equal(hints({...base,workers:[row('claude-opus-5-5',4,0,90_000),row('claude-sonnet-5-5',4,0,30_000)]}).filter(x=>x.includes('conviene')).length,1,'same rework, a third of the tokens');
    console.log('PASS hints from fixed rules: waits, permissions, rework, cost per task, blocks');
  } finally { quality.close(Date.now()+2000); }
} finally {stats.close(start+3*hour);rmSync(dir,{recursive:true,force:true});}
