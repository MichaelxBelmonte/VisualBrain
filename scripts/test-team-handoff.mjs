// Local API and board, with simulated PTYs. No provider requests or user sessions.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { handleApi } from '../src/server/api.ts';
import { Teams } from '../src/server/team.ts';
import { setWorkState, wakeSession } from '../src/server/team-delivery.ts';
import { newActivity } from '../src/server/activity.ts';
import { DEFAULTS } from '../src/server/config.ts';

const dir = mkdtempSync(join(tmpdir(), 'vb-handoff-'));
try {
  const terminals = new Map(), promptBytes = {}, notices = [];
  const store = {
    persistent: true,
    list: () => [...terminals.values()].map(t => t.info),
    get: id => terminals.get(id),
    spawn(opts) {
      const { id, role } = opts;
      const prompt = opts.args.at(-1);
      promptBytes[role] = Buffer.byteLength(prompt);
      const info = { id, role, agent: opts.agent, nodeId: opts.nodeId, alive: true, cwd: opts.cwd,
        parentId: opts.parentId, createdAt: Date.now(), title: role, workState: 'idle' };
      const term = { info, activity: newActivity(), teamToken: opts.teamToken, seenMessage: opts.seenMessage ?? 0,
        proc: { write(data) { if (data.startsWith('\x1b[200~')) notices.push({ id, bytes: Buffer.byteLength(data) - 13 }); } } };
      terminals.set(id, term);
      return term;
    },
  };
  const node = { id: 7, name: 'Fixture', path: dir, kind: 'dir', cls: 'folder', parentId: null, bytes: 0, files: 0 };
  const ctx = { cfg: { ...DEFAULTS, dataDir: dir, language: 'it' },
    cache: { nodes: new Map([[7, node]]), incident: () => [], evidence: () => new Map(), children: new Map(), areas: [] },
    db: { get: () => undefined, all: () => [] }, teams: new Teams(dir), terms: store };
  async function api(method, path, payload, id) {
    const req = Readable.from(method === 'GET' ? [] : [Buffer.from(JSON.stringify(id ? { ...payload, from: id } : payload))]);
    req.method = method; req.url = path;
    req.headers = id ? { authorization: 'Bearer ' + terminals.get(id).teamToken } : {};
    let status, body;
    await handleApi(ctx, req, { writeHead(s) {status = s;}, end(text) {body = JSON.parse(text);} });
    assert.ok(status >= 200 && status < 300, method + ' ' + path + ' -> ' + status + ': ' + (body.error ?? ''));
    return body;
  }
  let reads = 0;
  const read = id => { reads++; return api('GET','/api/work/7?session=' + id, undefined, id); };
  const idle = id => setWorkState(terminals.get(id).info, 'idle', 'hook');
  const brain = (await api('POST','/api/launch',{id:7,agent:'codex',role:'brain',mode:'embedded',prompt:'Coordina la verifica del menu.'})).info.id;
  const squad = await api('POST','/api/launch-squad',{id:7,prompt:'Verifica il menu in italiano e inglese.',members:[{agent:'codex',role:'orchestrator'},{agent:'codex',role:'operator'}]});
  const [orc, op] = squad.sessions.map(s => s.id);
  for (const id of [brain,orc,op]) { await read(id); idle(id); }
  const start = performance.now();
  const task = await api('POST','/api/work/7/tasks',{title:'Verifica il menu in italiano',scope:['ui/menu.ts'],assignedTo:op},orc);
  const path = '/api/work/7/tasks/'+task.id;
  assert.ok((await read(op)).tasks.some(t=>t.id===task.id && t.assignedTo===op && t.status==='pending'));
  const opInfo = terminals.get(op).info;
  assert.equal(opInfo.workState,'idle','delivering and reading the notice do not claim the task');
  const claim = await api('PATCH',path,{status:'working'},op);
  assert.equal(claim.status,'working');
  assert.equal(opInfo.workState,'working');
  assert.equal(opInfo.noticeSentAt,undefined);
  const claimAt = opInfo.stateAt;
  assert.deepEqual(await api('PATCH',path,{status:'working'},op),claim);
  assert.equal(opInfo.stateAt,claimAt,'a retried claim preserves the original report');
  const claimMs = performance.now()-start;
  const block = {status:'blocked',result:'Manca la variante italiana del menu. Responsabile: ORC1.'};
  await api('PATCH',path,block,op);
  const blocked = await read(orc);
  assert.ok(blocked.tasks.some(t=>t.id===task.id && t.status==='blocked'));
  idle(orc);
  const beforeDuplicate = notices.length;
  await api('PATCH',path,block,op);
  const duplicateNotices = notices.length - beforeDuplicate;
  if (duplicateNotices) { await read(orc); idle(orc); }
  assert.equal(duplicateNotices, 0, 'retrying the same block neither wakes the orchestrator nor requires another read');
  idle(op);
  await api('POST','/api/work/7/messages',{to:op,text:'Variante italiana disponibile. Riprendi la verifica.'},orc);
  idle(op);
  assert.equal(wakeSession(ctx,op),false,'a second automatic wake for the same unread batch is suppressed');
  assert.ok((await read(op)).messages.some(m=>m.text.includes('Riprendi')));
  assert.equal((await api('PATCH',path,{status:'working'},op)).status,'working');
  await api('PATCH',path,{status:'done',result:'Verificato: menu IT. Manca: prova EN. Responsabile: ORC1.'},op);
  const done = (await read(orc)).tasks.find(t=>t.id===task.id);
  assert.equal(done.status,'done');assert.equal(done.assignedTo,op);assert.match(done.result,/ORC1/);
  await api('POST','/api/work/7/messages',{to:brain,text:'Verificato menu IT; resta EN a ORC1.'},orc);
  assert.ok((await read(brain)).messages.some(m=>m.from===orc && m.text.includes('resta EN')));
  console.log(JSON.stringify({promptBytes,notices:notices.length,noticeBytes:notices.reduce((n,m)=>n+m.bytes,0),reads,duplicateNotices,claimMs:+claimMs.toFixed(3)}));

  // The consumer reads only 50 messages per request. A new idle turn must still hear about the tail.
  for (let i=0;i<51;i++) ctx.teams.message(7,orc,op,'Fixture '+i);
  idle(op);
  assert.equal(wakeSession(ctx,op),true);
  assert.equal((await read(op)).messages.length,50);
  idle(op);
  assert.equal(wakeSession(ctx,op),true);
  assert.equal((await read(op)).messages.length,1);
  idle(op);
  assert.equal(wakeSession(ctx,op),false);

  // Ownership changes notify only affected sessions. A second board read still carries durable task state.
  const worker = (await api('POST','/api/launch',{id:7,agent:'codex',mode:'embedded',role:'operator'})).info.id;
  const unrelated = (await api('POST','/api/launch',{id:7,agent:'codex',mode:'embedded',role:'reviewer'})).info.id;
  await api('PATCH',path,{status:'pending'},orc);
  assert.ok((await read(op)).messages.some(m=>m.to===op && m.text.includes(task.id) && m.text.includes('riaperto')));
  await api('PATCH',path,{assignedTo:worker},orc);
  assert.ok((await read(op)).messages.some(m=>m.text.includes(task.id) && m.text.includes('Interrompi')));
  assert.ok((await read(worker)).messages.some(m=>m.to===worker && m.text.includes(task.id) && m.text.includes('riassegnato')));
  assert.equal((await read(unrelated)).messages.length,0);
  await api('PATCH',path,{assignedTo:worker},orc);
  assert.equal((await read(worker)).messages.length,0);
  await api('PATCH',path,{status:'blocked',result:'Manca il dato.'},worker);
  assert.equal((await api('PATCH',path,{status:'working'},orc)).status,'pending','the manager can unblock; the owner claims');
  assert.ok((await read(worker)).messages.some(m=>m.text.includes('sbloccato')));
  await api('PATCH',path,{status:'done',result:'Verificato menu EN. Ramo: feature/menu. Commit abcdef1.'},worker);
  const recap = async () => (await read(brain)).teamList.find(t=>t.id===squad.teamId).handoffs.find(h=>h.taskId===task.id);
  let h = await recap();
  assert.deepEqual([h.status,h.assignedTo,h.sha,h.branch,h.withheld],['done','OP2','abcdef1','feature/menu',false]);
  assert.match(h.result,/menu EN/);
  assert.deepEqual(await recap(),h,'recap is not consumed with inbox messages');
  assert.equal((await read(worker)).teamList,undefined,'a worker cannot read the cross-squad recap');

  await api('PATCH','/api/work/7',{team:squad.teamId,delivery:'manual'});
  await api('PATCH',path,{status:'pending'},orc);
  await api('PATCH',path,{status:'blocked',result:'Dati riservati. Ramo: private/hidden. SHA: deadbee.'},worker);
  const hidden = async () => {
    const row = await recap();
    assert.ok(row.withheld);
    assert.deepEqual([row.result,row.branch,row.sha],[null,null,null]);
  };
  await hidden();
  const oldReceipt = ctx.teams.get(7).inbox.at(-1).id;
  await api('POST','/api/work/7/forward',{team:squad.teamId,items:[oldReceipt],to:orc});
  await hidden(); // Forwarding to the orchestrator is a different audience.
  await api('PATCH',path,{status:'blocked',result:'Nuovo blocco. Ramo: other/secret. SHA: beefabc.'},worker);
  await api('POST','/api/work/7/forward',{team:squad.teamId,items:[oldReceipt],to:orc});
  assert.match((await read(orc)).tasks.find(t=>t.id===task.id).result,/in smistamento/);
  await api('POST','/api/work/7/forward',{team:squad.teamId,items:[oldReceipt],to:brain});
  await hidden(); // An old revision cannot release a newer report.
  const currentReceipt = ctx.teams.get(7).inbox.at(-1).id;
  await api('POST','/api/work/7/forward',{team:squad.teamId,items:[currentReceipt],to:brain});
  h = await recap();
  assert.deepEqual([h.withheld,h.assignedTo,h.sha,h.branch],[false,'OP2','beefabc','other/secret']);
  await api('PATCH','/api/work/7',{team:squad.teamId,delivery:'auto'});
  await api('PATCH',path,{status:'done',result:'Verifica conclusa, nessun commit richiesto.'},worker);
  h = await recap();
  assert.equal(h.withheld,false);
  assert.equal(h.sha,null,'never derive a hash from a task id or an older result');
  for (let i=0;i<11;i++) {
    const row = ctx.teams.createTask(7,orc,{title:'Earlier report '+i,assignedTo:worker});
    ctx.teams.changeTask(7,row.id,worker,'operator',{status:'done',result:'Verified.'});
  }
  const recent = (await read(brain)).teamList.find(t=>t.id===squad.teamId);
  assert.equal(recent.handoffs.length,10);
  assert.equal(recent.handoffsTotal,12);
  const full = await api('GET','/api/work/7?session='+brain+'&handoffs=all',undefined,brain);
  assert.equal(full.teamList.find(t=>t.id===squad.teamId).handoffs.length,12);
  console.log('PASS targeted reopen, unblock and transfer; retained Main Brain refs respect manual forwarding and revisions');

  const stopped = await api('POST','/api/work/7/tasks',{title:'Waiting for approval',assignedTo:worker},orc);
  const stoppedPath = '/api/work/7/tasks/' + stopped.id;
  const waiting = await api('PATCH',stoppedPath,{status:'blocked',result:'Approval pending'},worker);
  terminals.delete(worker);
  ctx.teams.release(7,worker);
  ctx.teams = new Teams(dir);
  const retained = (await read(orc)).tasks.find(t=>t.id===stopped.id);
  assert.deepEqual(retained,waiting,'exit, disk reload and recover preserve the block, reason, timestamp and owner');
  assert.equal(retained.blockedOwnerCode,'OP2');
  assert.equal((await read(unrelated)).tasks.some(t=>t.id===stopped.id),false);
  assert.equal((await api('PATCH',stoppedPath,{assignedTo:unrelated},orc)).status,'pending');
  assert.equal((await api('PATCH',stoppedPath,{status:'working'},unrelated)).assignedTo,unrelated);
  console.log('PASS duplicate claim; ordinary block survives owner exit until explicit reassignment');

  const records = '/api/work/7/records';
  const list = async id => (await api('GET',records+'?session='+id,undefined,id)).entries;
  const decision = {entryId:'menu-v1',kind:'decision',decision:'Retain owner on exit',nextOwner:'ORC1',taskId:stopped.id};
  const entry = await api('POST',records,{...decision,author:'spoof',project:'/wrong',createdAt:1},orc);
  assert.deepEqual([entry.author,entry.project,entry.decision,entry.nextOwner],['ORC1',dir,decision.decision,'ORC1']);
  assert.ok(entry.createdAt>1);
  assert.deepEqual(await api('POST',records,decision,orc),entry,'same key and payload yield the original record');
  await assert.rejects(api('POST',records,{...decision,decision:'Changed history'},orc),/409/);
  assert.deepEqual(await list(brain),[entry]);
  await assert.rejects(list(unrelated),/403/);
  await api('PATCH','/api/work/7',{team:'brain',delivery:'manual'});
  const publication = {...decision,entryId:'menu-publication',kind:'publication',decision:'Fixture package built',sha:'1234abc',artifact:'fixture.zip'};
  const recorded = await api('POST',records,publication,orc);
  assert.deepEqual([recorded.sha,recorded.artifact],['1234abc','fixture.zip']);
  assert.deepEqual(await list(brain),[entry]);
  assert.deepEqual(await list(orc),[recorded,entry]);
  await api('PATCH','/api/work/7',{team:'brain',delivery:'auto'});
  assert.deepEqual(await list(brain),[entry],'switching mode cannot expose an earlier private entry');
  for (let i=0; i<49; i++) await api('POST',records,{...decision,entryId:'decision-'+i},orc);
  const page = await api('GET',records+'?session='+orc,undefined,orc);
  assert.equal(page.entries.length,50);
  await api('POST',records,{...decision,entryId:'new-after-page'},orc);
  const tail = await api('GET',records+'?session='+orc+'&before='+page.nextBefore,undefined,orc);
  assert.deepEqual(tail,{entries:[entry],nextBefore:null});
  node.path = join(dir,'different-project');
  assert.deepEqual(await list(brain),[],'a reused node ID cannot expose another project’s records');
  console.log('PASS append-only, idempotent project records, authenticated author, references and manual delivery');
} finally { rmSync(dir, {recursive:true,force:true}); }
