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
        proc: { write(data) { if (data.startsWith('\x1b[200~')) notices.push({ id, bytes: Buffer.byteLength(data) - 12 }); } } };
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
  assert.ok((await read(op)).tasks.some(t=>t.id===task.id && t.assignedTo===op));
  assert.equal((await api('PATCH',path,{status:'working'},op)).status,'working');
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
} finally { rmSync(dir, {recursive:true,force:true}); }
