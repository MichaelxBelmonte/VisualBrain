// Deterministic observations on two linked projects (plus an excluded third project). No actual user data.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MegaStats } from '../src/server/mega-stats.ts';
import { Teams } from '../src/server/team.ts';

const dir = mkdtempSync(join(tmpdir(),'vb-stats-'));
const start = Date.UTC(2026,0,1);
const hour = 3_600_000;
const teams = new Teams(dir);
const members = [
  {id:'a',nodeId:11,agent:'codex',role:'orchestrator',workState:'working'},
  {id:'b',nodeId:20,agent:'claude',role:'operator',workState:'blocked',attention:'permission'},
  {id:'idle',nodeId:20,agent:'codex',role:'operator',workState:'idle'},
  {id:'shell',nodeId:20,agent:'shell'},
  {id:'orphan',nodeId:30,agent:'codex',role:'operator'},
].map(s=>({...s,createdAt:start,alive:true}));
const ctx = {teams, terms:{list:()=>members,get:id=>({info:members.find(s=>s.id===id),activity:{}})},
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
  const r=stats.report(ctx,24,filters,start+hour);
  assert.deepEqual(r.projects.map(p=>p.id).sort(),[10,20]);assert.equal(r.sessions.length,4);
  assert.deepEqual(r.totals.turnLatency,{n:5,p50Ms:300,p95Ms:900});
  assert.deepEqual(r.totals.httpLatency,{n:6,p50Ms:10,p95Ms:100});
  assert.equal(r.totals.turns,6);assert.equal(r.totals.unpairedTurns,2);
  assert.equal(r.totals.httpErrors,1);assert.equal(r.totals.retries,null);
  assert.equal(r.observedMs,hour);assert.equal(r.totals.completedPerHour,2);assert.equal(r.totals.httpPerHour,6);
  assert.equal(r.totals.turnsPerHour,6);assert.equal(r.unattributedHttp,1);
  assert.equal(r.totals.waiting,1);assert.equal(r.totals.blocked,1);
  assert.equal(r.teams.find(t=>t.key==='20:1').blockedTasks,1);
  assert.equal(r.sessions.find(s=>s.id==='idle').metrics.turns,0);
  assert.equal(r.sessions.find(s=>s.id==='shell').metrics.turns,null);
  for(const selection of [{session:'a'},{project:'10'},{team:'11:1'}]) {
    const sub=stats.report(ctx,1,{...filters,...selection},start+hour);
    assert.equal(sub.sessions.length,1);assert.equal(sub.totals.http,5);assert.equal(sub.totals.completed,1);
  }
  const pref=stats.setRequest(ctx,20,'1',{cadenceMinutes:15,mode:'suggest',provider:'balanced'});
  assert.equal(pref.status,'pending');assert.throws(()=>stats.setRequest(ctx,30,'1',pref));
  stats.close(start+hour);stats=new MegaStats(join(dir,'stats.sqlite'),()=>{},start+2*hour);
  const after=stats.report(ctx,24,filters,start+3*hour);
  assert.equal(after.observedMs,2*hour);assert.equal(after.totals.completedPerHour,1);
  assert.deepEqual(after.teams.find(t=>t.key==='20:1').requested,pref);
  assert.equal(after.teams.find(t=>t.key==='20:1').autoSpawn,false);
  teams.unlink(link.id);assert.deepEqual(stats.report(ctx,24,filters,start+3*hour).sessions,[]);
  console.log('PASS linked projects, descendant nodes, orthogonal filters, HTTP vs native turns, deduplication, quantiles, missing pairs, idle/blocked sessions, coverage gaps and pending preferences');
} finally {stats.close(start+3*hour);rmSync(dir,{recursive:true,force:true});}
