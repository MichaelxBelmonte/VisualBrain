// Actual HTTP API, detached PTYs and a backend restart. The provider executables and usage data are fixtures.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp,mkdir,writeFile,readFile,realpath,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const rt=process.argv.find(a=>a.startsWith('--runtime='))?.slice(10);
const server=rt?resolve(rt,'server'):resolve(import.meta.dirname,'..'),node=rt?resolve(rt,'node-'+process.arch):process.execPath;
const dir=await realpath(await mkdtemp(join(tmpdir(),'vb-quota-live-'))),files=join(dir,'fixture'),profile=join(dir,'profile');
await mkdir(files);await mkdir(profile);await writeFile(join(files,'README.md'),'# Fixture');
const provider=join(dir,'fixture.mjs');
await writeFile(provider,`#!${process.execPath}
import {writeFileSync} from 'node:fs';import {createInterface} from 'node:readline';
const args=process.argv.slice(2);
if(args.includes('app-server')){
  const input=createInterface({input:process.stdin});
  for await(const line of input){
    const m=JSON.parse(line);if(!m.id)continue;
    const result=m.method==='initialize'?{userAgent:'fixture'}:{accountId:'fixture',ordinaryUsageAllowed:true,rateLimits:{primary:{usedPercent:30,windowDurationMins:300,resetsAt:Math.floor(Date.now()/1000)+18000}}};
    console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));
  }
}else if(process.env.VB_TEAM_TOKEN){
  writeFileSync(process.env.HOME+'/'+process.env.VB_SESSION_ID+'.key',process.env.VB_TEAM_TOKEN,{mode:0o600});
  setInterval(()=>{},30000);
}
`,{mode:0o700});
await writeFile(join(profile,'settings.json'),JSON.stringify({language:'it',roots:[files],setupComplete:true,agents:{codex:provider,claude:provider,hermes:'fixture-missing',agy:'fixture-missing'}}));
const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(ok=>socket.close(ok));
const base='http://127.0.0.1:'+port,owned=[];
let child,ended,log='',key;
const waitFor=async(fn,ms=15_000)=>{const until=Date.now()+ms;while(Date.now()<until){const val=await fn();if(val)return val;await delay(80);}throw Error('Fixture timeout '+log.slice(-1200));};
async function call(path,method='GET',body,session,status){
  const res=await fetch(base+path,{method,signal:AbortSignal.timeout(6000),headers:{'content-type':'application/json','sec-fetch-site':'same-origin',...(session?{authorization:'Bearer '+session.key}:{})},
    ...(body?{body:JSON.stringify(session?{...body,from:session.id}:body)}:{})});
  const value=await res.json();assert.ok(status?res.status===status:res.ok,method+' '+path+' '+res.status+' '+JSON.stringify(value));return value;
}
async function boot(){
  child=spawn(node,['src/cli.ts','serve','--no-watch','--port',String(port)],{cwd:server,env:{PATH:dirname(process.execPath)+':/usr/bin:/bin',HOME:dir,TMPDIR:dir,SHELL:'/bin/sh',VISUAL_BRAIN_DATA_DIR:profile,VB_ENGINE:'ts'},stdio:['ignore','pipe','pipe']});
  ended=once(child,'exit');
  for(const s of [child.stdout,child.stderr])s.on('data',b=>log=(log+b).slice(-2000));
  await waitFor(async()=>{if(child.exitCode!==null)throw Error(log);return (await call('/api/health').catch(()=>({}))).profile===profile;});
}
async function stop(){if(child?.exitCode===null)child.kill('SIGTERM');if(ended)await ended;}
try{
  await boot();
  key=(await waitFor(()=>call('/api/path?p='+encodeURIComponent(files)).catch(()=>null))).id;
  const work='/api/work/'+key,ruleUrl='/api/mega-stats/routing?node='+key+'&team=1';
  async function launch(agent,role){
    const s=(await call('/api/launch','POST',{id:key,agent,role,mode:'embedded'})).info;
    owned.push(s.id);s.key=await waitFor(()=>readFile(join(dir,s.id+'.key'),'utf8').catch(()=>null));
    return s;
  }
  const orc=await launch('codex','orchestrator'),c=await launch('codex','operator'),a=await launch('claude','operator');
  for(const s of [orc,c,a]){await call(work+'?session='+s.id,'GET',undefined,s);await call(work+'/state','POST',{state:'idle'},s);}
  const rule=(await call(ruleUrl)).rule;
  await call(ruleUrl,'PUT',{...rule,enabled:true,preference:'codex',providers:['codex','claude']});
  await call('/api/mega-stats/routing/refresh','POST',{});
  const q=await call(ruleUrl);
  assert.equal(q.quotas.find(v=>v.provider==='codex').windows[0].minutes,300);
  const claudeWindow={name:'five_hour',minutes:300,remainingPct:80,resetsAt:Date.now()+18_000_000};
  await call(work+'/quota','POST',{limited:false,windows:[claudeWindow],origin:'statusline'},a);
  const task=await call(work+'/tasks','POST',{title:'Checkpoint di prova'},orc,201);
  assert.equal(task.assignedTo,c.id);await call(work+'/tasks/'+task.id,'PATCH',{status:'working'},c);
  await call(work+'/quota','POST',{limited:true,windows:[],retryAfter:120},c);
  await call(work+'/quota','POST',{limited:true,windows:[],retryAfter:5},a);
  const checkpoint={handoffId:'file-2',safeToResume:true,verified:'File 1 verificato e chiuso',next:'Verificare il file 2'};
  const path=work+'/handoff/'+task.id;
  const pending=await call(path,'POST',checkpoint,c);
  assert.equal(pending.assignedTo,c.id);assert.equal(pending.routing.handoff.to,null);
  const hostPath=join(profile,'terminal-service/host.json');
  const host=JSON.parse(await readFile(hostPath)).pid;
  await stop();await boot();assert.equal(JSON.parse(await readFile(hostPath)).pid,host);
  const after=await waitFor(async()=>{const board=await call(work+'?team=1');return board.tasks[0].assignedTo===a.id?board:null;},35_000);
  assert.equal(after.tasks.length,1);assert.equal(after.tasks[0].routing.handoff.next,checkpoint.next);
  const count=after.messages.filter(m=>m.to===a.id && m.text.includes(task.id)).length;assert.equal(count,1);
  await call(path,'POST',checkpoint,c);const replay=await call(work+'?team=1');
  assert.equal(replay.messages.filter(m=>m.to===a.id && m.text.includes(task.id)).length,count);
  assert.equal((await call('/api/terminals')).filter(s=>s.alive).length,3);
  await call(work+'/tasks/'+task.id,'PATCH',{status:'done',result:'Secondo file verificato'},a);
  console.log('PASS HTTP → quota-aware assignment → checkpoint → backend restart with same terminal host → one successor at reset → completion, no duplicate launch');
} finally{
  if((await call('/api/health').catch(()=>({}))).profile===profile)for(const id of owned)await call('/api/terminals/'+id,'DELETE').catch(()=>{});
  await stop();
  // The detached fixture host removes its own lock after the last PTY and API detach.
  await waitFor(async()=>!(await readFile(join(profile,'terminal-service/host.json')).then(()=>true,()=>false)));
  await rm(dir,{recursive:true,force:true});
}
