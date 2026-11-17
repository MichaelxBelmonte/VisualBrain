import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ApiCtx } from './api.ts';
import { TeamError } from './team.ts';
import { notifyTeam } from './team-delivery.ts';
import { hasAgents } from './launch.ts';
import type { AgentName, TeamTask } from '../shared/types.ts';
import { quotaProviders, type QuotaGroup, type RoutingRule, type RoutingView, type TaskRoute } from '../shared/quota-routing.ts';
import { readCodexQuota, type QuotaSample } from './quota-sources.ts';

const FRESH_MS=5*60_000;
const defaults=():RoutingRule=>({enabled:false,marginPct:10,allowUnknown:false,preference:'balanced',
  providers:[...quotaProviders],groups:{codex:'codex',claude:'claude',hermes:'hermes',agy:'agy'}});
type Records=Record<string,Partial<Record<AgentName,QuotaSample>>>;
type State={rules:Record<string,RoutingRule>;signals:Records;holds?:Records};
const validGroup=(s:unknown):s is string=>typeof s==='string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(s) && !(s in Object.prototype);
const fail=(text:string):never=>{throw new TeamError(400,text);};
function validRule(input:Record<string,unknown>):RoutingRule{
  if(typeof input.enabled!=='boolean'||typeof input.allowUnknown!=='boolean'||typeof input.marginPct!=='number'||!Number.isFinite(input.marginPct)||input.marginPct<0||input.marginPct>100) return fail('Margine o modalità non validi');
  if(input.preference!=='balanced'&&!quotaProviders.includes(input.preference as AgentName)) return fail('Preferenza provider non valida');
  if(!Array.isArray(input.providers)||input.providers.some(p=>!quotaProviders.includes(p))||!input.groups||typeof input.groups!=='object')return fail('Provider o gruppi non validi');
  const groups=defaults().groups;
  for(const p of quotaProviders){const v=(input.groups as Record<string,unknown>)[p];if(!validGroup(v))return fail('Nome del gruppo non valido');groups[p]=v;}
  return {enabled:input.enabled,allowUnknown:input.allowUnknown,marginPct:input.marginPct,preference:input.preference as RoutingRule['preference'],providers:[...new Set(input.providers)],groups};
}
function remaining(sample:QuotaSample,now:number) {
  return sample.windows.filter(w=>w.resetsAt===null||w.resetsAt>now);
}
export class QuotaRouter {
  private file:string;
  private state:State;
  private inFlight?:Promise<void>;
  private lastProbe=0;
  private loadFailed=false;
  constructor(dir:string) {
    this.file=join(dir,'quota-routing.json');
    this.state={rules:{},signals:{}};
    if(existsSync(this.file)) {
      try {
        const saved=JSON.parse(readFileSync(this.file,'utf8'));
        if(!saved?.rules || !saved?.signals)throw Error('Missing quota storage fields');
        for(const rule of Object.values(saved.rules))validRule(rule as Record<string,unknown>);
        this.state=saved;
      } catch {
        this.loadFailed=true;
        console.warn('[quota] Archivio del routing illeggibile; nuove assegnazioni sospese.');
      }
    }
  }
  private checkStorage(){if(this.loadFailed)throw new TeamError(503,'Archivio routing non disponibile');}
  private save(next:State) {
    this.checkStorage();
    writeFileSync(this.file+'.tmp',JSON.stringify(next),{mode:0o600});renameSync(this.file+'.tmp',this.file);this.state=next;
  }
  rule(node:number,team:string):RoutingRule{this.checkStorage();return this.state.rules[node+':'+team]??defaults();}
  permitsProvider(node:number,team:string,provider:AgentName,now=Date.now()){
    const rule=this.rule(node,team);
    if(!rule.enabled)return true;
    const q=this.bucket(provider,rule,now);
    return rule.providers.includes(provider) && (q.status==='available'||(rule.allowUnknown&&(q.status==='stale'||q.status==='unknown')));
  }
  configure(node:number,team:string,data:Record<string,unknown>) {
    const rule=validRule(data);
    this.save({...this.state,rules:{...this.state.rules,[node+':'+team]:rule}});return rule;
  }
  observe(group:string,provider:AgentName,sample:QuotaSample) {
    if(!validGroup(group))return fail('Gruppo non valido');
    const old=this.state.signals[group]?.[provider], holds={...this.state.holds?.[group]}, hold=holds[provider];
    if(sample.observedAt<Math.max(old?.observedAt??0,hold?.observedAt??0))return;
    if(sample.limited){
      const indefinite=sample.blockedUntil===null || (!!hold && hold.blockedUntil===null);
      holds[provider]={...sample,ordinaryAllowed:hold?.ordinaryAllowed===false?false:sample.ordinaryAllowed,
        blockedUntil:indefinite?null:Math.max(hold?.blockedUntil??0,sample.blockedUntil!)};
    } else if(hold && (hold.blockedUntil===null || hold.blockedUntil<=sample.observedAt) &&
      (hold.ordinaryAllowed===false ? sample.ordinaryAllowed===true : sample.windows.some(w=>w.remainingPct>0))) delete holds[provider];
    // A cooldown is independent of the last measured percentage; it must not make old data fresh.
    const signals={...this.state.signals};
    if(sample.windows.length || !sample.limited)signals[group]={...signals[group],[provider]:sample};
    this.save({...this.state,signals,holds:{...this.state.holds,[group]:holds}});
  }
  private bucket(provider:AgentName,rule:RoutingRule,now:number):QuotaGroup{
    const group=rule.groups[provider];
    const shared=(records:Records)=>{
      const sources=new Set(Object.values(records[group]??{}));
      for(const p of quotaProviders)if(rule.groups[p]===group){const s=records[p]?.[p];if(s)sources.add(s);}
      return [...sources];
    };
    const all=shared(this.state.signals),latest=all.toSorted((a,b)=>b.observedAt-a.observedAt)[0];
    const active=shared(this.state.holds??{}).filter(s=>s.blockedUntil===null||s.blockedUntil>now);
    const minimum=(s:QuotaSample)=>Math.min(...remaining(s,now).map(w=>w.remainingPct));
    const low=all.filter(s=>remaining(s,now).some(w=>w.remainingPct===0 || (w.remainingPct<=rule.marginPct && (w.resetsAt!==null || s.observedAt+FRESH_MS>now)))).sort((a,b)=>minimum(a)-minimum(b));
    const fresh=all.filter(s=>s.observedAt+FRESH_MS>now && remaining(s,now).length).sort((a,b)=>minimum(a)-minimum(b));
    const sample=active[0]??low[0]??fresh[0]??latest;
    const status:QuotaGroup['status']=active.length?'limited':low.length?(remaining(low[0],now).some(w=>w.remainingPct===0)?'limited':'margin')
      :fresh.length?'available':latest?.windows.length?'stale':'unknown';
    const deadlines = [...active.map(s=>s.blockedUntil), ...low.flatMap(s=>remaining(s,now).filter(w=>w.remainingPct===0).map(w=>w.resetsAt))];
    const deadline = deadlines.length && deadlines.every((n): n is number => n!==null) ? Math.max(...deadlines) : null;
    return {provider,group,account:sample?.account??null,source:sample?.source??null,observedAt:sample?.observedAt??null,
      freshUntil:sample?sample.observedAt+FRESH_MS:null,limited:status==='limited',blockedUntil:deadline,
      windows:(sample?.windows??[]).map(w=>({...w})),status};
  }
  refresh(ctx:ApiCtx):Promise<void>{
    if(this.inFlight)return this.inFlight;
    this.lastProbe=Date.now();
    this.inFlight=readCodexQuota(ctx.cfg.agents.codex).then(s=>{this.observe('codex','codex',s);this.tick(ctx);ctx.stats?.signal();})
      .finally(()=>{this.inFlight=undefined;});
    return this.inFlight;
  }
  report(node:number,team:string,provider:AgentName,b:Record<string,unknown>,now=Date.now()) {
    if(!Array.isArray(b.windows)||b.windows.length>8||typeof b.limited!=='boolean')return fail('Segnale quota non valido');
    const windows:QuotaSample['windows']=[];
    for(const w of b.windows){
      if(!w||typeof w.name!=='string'||w.name.length>80||typeof w.remainingPct!=='number'||!Number.isFinite(w.remainingPct)||w.remainingPct<0||w.remainingPct>100||
        !(w.minutes===null||(Number.isSafeInteger(w.minutes)&&w.minutes>0))||!(w.resetsAt===null||(Number.isSafeInteger(w.resetsAt)&&w.resetsAt>0)))return fail('Finestra non valida');
      windows.push({name:w.name,minutes:w.minutes,remainingPct:w.remainingPct,resetsAt:w.resetsAt});
    }
    if(provider==='codex' && windows.length)return fail('Leggi le finestre Codex dal CLI');
    if(!windows.length&&!b.limited)return fail('Il provider non ha esposto dati');
    const retry=b.retryAfter;
    let until:number|null=null;
    if(retry!=null){
      if(typeof retry==='number' || (typeof retry==='string'&&/^\d+$/.test(retry)))until=now+Number(retry)*1000;
      else if(typeof retry==='string')until=Date.parse(retry);
      if(until===null||!Number.isSafeInteger(until)||until<now)return fail('Retry-After non valido');
    }
    const source = provider==='claude' && b.origin==='statusline'?'Claude Code · statusLine':
      provider==='claude' && b.origin==='StopFailure'?'Claude Code · StopFailure':provider+' · segnalazione sessione';
    this.observe(this.rule(node,team).groups[provider],provider,{account:null,observedAt:now,windows,limited:b.limited,blockedUntil:b.limited?until:null,source});
  }
  view(ctx:ApiCtx,node:number|null,team:string,now=Date.now()):RoutingView{
    this.checkStorage();
    const rule=node===null?defaults():this.rule(node,team);
    const tasks=node===null?[]:ctx.teams.get(node,team).tasks;
    const codes=node===null?{}:ctx.teams.get(node).codes?.ids??{};
    return {rule,quotas:quotaProviders.map(p=>this.bucket(p,rule,now)),updatedAt:now,decisions:tasks.filter(t=>t.routing)
      .toSorted((a,b)=>b.routing!.at-a.routing!.at).slice(0,25).map(t=>({taskId:t.id,assignee:t.assignedTo?codes[t.assignedTo]??t.assignedTo:null,reason:t.routing!.reason,at:t.routing!.at}))};
  }
  private pick(ctx:ApiCtx,node:number,team:string,route:TaskRoute,taskId:string,now:number) {
    const rule=this.rule(node,team),board=ctx.teams.get(node,team),installed=hasAgents(ctx.cfg);
    const options=ctx.terms.list().filter(s=>s.nodeId===node && s.alive && s.role===route.role && ctx.teams.teamOf(node,s)===team &&
      s.agent!=='shell' && rule.providers.includes(s.agent) && installed[s.agent] && s.workState==='idle' && !s.attention &&
      s.id!==route.handoff?.from && !ctx.terms.get(s.id)?.activity?.draft &&
      !board.tasks.some(t=>t.id!==taskId&&t.assignedTo===s.id&&t.status!=='done'));
    const ranked=options.map(s=>{
      const q=this.bucket(s.agent as AgentName,rule,now);
      const eligible=q.status==='available'||(rule.allowUnknown&&(q.status==='unknown'||q.status==='stale'));
      const pct=q.status==='available'?Math.min(...q.windows.filter(w=>!w.resetsAt||w.resetsAt>now).map(w=>w.remainingPct)):-1;
      const last=board.tasks.reduce((at,t)=>t.assignedTo===s.id?Math.max(at,t.routing?.at??t.updatedAt):at,0);
      return {s,q,eligible,pct,last};
    }).filter(o=>o.eligible).sort((a,b)=>Number(b.s.id===route.preferred)-Number(a.s.id===route.preferred)
      || Number(b.q.status==='available')-Number(a.q.status==='available') || Number(b.s.agent===rule.preference)-Number(a.s.agent===rule.preference)
      || b.pct-a.pct || a.last-b.last || a.s.id.localeCompare(b.s.id));
    const best=ranked[0];
    return best?{id:best.s.id,reason:best.q.status==='available'?`Disponibile · ${best.s.agent} · ${best.q.group} · ${best.pct}% residuo`:`Quota ${best.q.status==='stale'?'scaduta':'ignota'} ammessa · ${best.s.agent}`}
      :{id:null,reason:options.length?'Attesa quota: limite, margine o dato non confermato':'Attesa sessione libera e compatibile'};
  }
  private dispatch(ctx:ApiCtx,node:number,team:string,task:TeamTask,now:number) {
    const r=task.routing!;
    const choice=this.pick(ctx,node,team,r,task.id,now);
    if(!choice.id && r.reason===choice.reason)return task;
    const next={...r,at:now,reason:choice.reason};
    if(next.handoff && choice.id) next.handoff={...next.handoff,to:choice.id};
    const target=choice.id??r.handoff?.from??null;
    const updated=ctx.teams.routeTask(node,team,task.id,target,next,choice.id?
      `Incarico ${task.id} · ${next.handoff?'leggi checkpoint e prossima azione in bacheca':'verifica scope e prendi in carico'}`:undefined);
    if(choice.id)notifyTeam(ctx,node,team);
    ctx.stats?.signal();return updated;
  }
  create(ctx:ApiCtx,node:number,team:string,actor:string,body:Record<string,unknown>,preferred:string|null,now=Date.now()){
    const role=body.requiredRole??(preferred?ctx.terms.get(preferred)?.info.role:'operator');
    if(role!=='operator'&&role!=='reviewer'&&role!=='orchestrator')return fail('Ruolo incompatibile');
    const first=ctx.teams.createTask(node,actor,{title:body.title,scope:body.scope,routing:{role,preferred,at:now,reason:'In coda'}},team);
    return this.dispatch(ctx,node,team,first,now);
  }
  handoff(ctx:ApiCtx,node:number,team:string,id:string,actor:string,data:Record<string,unknown>,now=Date.now()){
    const task=ctx.teams.get(node,team).tasks.find(t=>t.id===id);
    if(!task || !task.assignedTo || task.status==='done') throw new TeamError(409,'Incarico senza proprietario disponibile');
    const prev=task.routing?.handoff;
    if(prev && prev.id===data.handoffId && (actor==='user'||prev.from===actor))return task;
    if(actor!=='user'&&actor!==task.assignedTo)throw new TeamError(403,'Consegna riservata al proprietario o alla persona');
    if(data.safeToResume!==true||typeof data.handoffId!=='string'||!/^[-\w]{1,80}$/.test(data.handoffId)||
      typeof data.verified!=='string'||!data.verified.trim()||data.verified.length>1000||typeof data.next!=='string'||!data.next.trim()||data.next.length>1000)
      return fail('Conferma un punto di arresto sicuro, stato verificato e prossima azione');
    if(prev && !prev.to)throw new TeamError(409,'Consegna già in attesa');
    const priorRole=task.routing?.role??ctx.terms.get(task.assignedTo)?.info.role;
    if(priorRole!=='operator'&&priorRole!=='reviewer'&&priorRole!=='orchestrator')return fail('Ruolo del proprietario sconosciuto');
    const route:TaskRoute={role:priorRole,preferred:null,at:now,reason:'Consegna in attesa',handoff:{id:data.handoffId,from:task.assignedTo,to:null,verified:data.verified.trim(),next:data.next.trim()}};
    const saved=ctx.teams.routeTask(node,team,id,task.assignedTo,route);
    return this.dispatch(ctx,node,team,saved,now);
  }
  tick(ctx:ApiCtx,now=Date.now()) {
    let needsProbe=false;
    for(const [key,rule] of Object.entries(this.state.rules)){
      if(!rule.enabled)continue;
      const [n,team]=key.split(':'),node=Number(n);
      if(!ctx.cache.nodes.has(node)||!ctx.teams.team(node,team))continue;
      for(const task of ctx.teams.get(node,team).tasks){
        if(!task.routing||task.status==='done'||(task.assignedTo && !(task.routing.handoff && !task.routing.handoff.to)))continue;
        const result=this.dispatch(ctx,node,team,task,now);
        if(!result.assignedTo || (result.routing?.handoff&&!result.routing.handoff.to))needsProbe ||= rule.providers.includes('codex');
      }
    }
    if(needsProbe && !this.inFlight && now-this.lastProbe>=60_000) void this.refresh(ctx).catch(()=>{});
  }
}
