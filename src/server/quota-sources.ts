import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { cliPath } from './agent-clis.ts';
import type { QuotaWindow } from '../shared/quota-routing.ts';

export interface QuotaSample {
  windows: QuotaWindow[]; account: string | null; source: string;
  observedAt: number; limited: boolean; blockedUntil: number | null;
  ordinaryAllowed?: boolean | null;
}
interface CodexWindow {usedPercent?:number;windowDurationMins?:number|null;resetsAt?:number|null}
interface Bucket {limitId?:string;primary?:CodexWindow|null;secondary?:CodexWindow|null;spendControlReached?:boolean;rateLimitReachedType?:string|null}
interface Usage {accountId?:string|null;rateLimits?:Bucket;rateLimitsByLimitId?:Record<string,Bucket>;ordinaryUsageAllowed?:boolean|null}
export function codexSample(data: Usage, now=Date.now()): QuotaSample {
  const bucket = data.rateLimitsByLimitId?.codex ?? data.rateLimits;
  if (!bucket || typeof bucket !== 'object') throw Error('Finestra Codex non disponibile');
  const windows: QuotaWindow[] = [];
  for (const [key,w] of [['primary',bucket.primary],['secondary',bucket.secondary]] as const) {
    if (!w || typeof w.usedPercent !== 'number' || !Number.isFinite(w.usedPercent) || w.usedPercent<0 || w.usedPercent>100) continue;
    windows.push({name:key,remainingPct:100-w.usedPercent,minutes:typeof w.windowDurationMins==='number'&&w.windowDurationMins>0?w.windowDurationMins:null,
      resetsAt:typeof w.resetsAt==='number'&&w.resetsAt>0?w.resetsAt*1000:null});
  }
  const account=typeof data.accountId==='string'&&data.accountId?'#'+createHash('sha256').update(data.accountId).digest('hex').slice(0,12):null;
  const denied=data.ordinaryUsageAllowed===false || bucket.spendControlReached===true || !!bucket.rateLimitReachedType;
  return {account,windows,source:'Codex · account/rateLimits/read',observedAt:now,limited:denied,blockedUntil:null,ordinaryAllowed:data.ordinaryUsageAllowed};
}

/** One read on the CLI's supported stdio protocol, no inference and no credential files. */
export function readCodexQuota(executable:string):Promise<QuotaSample> {
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,['app-server','--listen','stdio://'],{env:{...process.env,PATH:cliPath()},stdio:['pipe','pipe','ignore']});
    const lines=createInterface({input:child.stdout});
    let done=false;
    const finish=(sample?:QuotaSample)=>{
      if(done)return; done=true;clearTimeout(timer);lines.close();child.stdin.end();child.kill();
      if(sample)resolve(sample);else reject(Error('Quota Codex non disponibile dal profilo CLI'));
    };
    const timer=setTimeout(()=>finish(),12_000);
    const send=(id:number,method:string,params:unknown)=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
    child.once('error',()=>finish());child.once('exit',()=>finish());child.stdin.on('error',()=>finish());
    lines.on('line',line=>{
      if(done || line.length>1_000_000)return;
      try {
        const msg=JSON.parse(line);
        if(msg.id===1 && msg.result) {
          child.stdin.write('{"jsonrpc":"2.0","method":"initialized"}\n');
          send(2,'account/rateLimits/read',{excludeResetCreditDetails:true});
        } else if(msg.id===2 && msg.result) finish(codexSample(msg.result));
        else if(msg.id && msg.error) finish();
      } catch {finish();}
    });
    send(1,'initialize',{clientInfo:{name:'visual-brain-quota',version:'1'},capabilities:{experimentalApi:true}});
  });
}
