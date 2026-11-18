// Real HTTP and separate API processes over one temporary profile; terminal agents are fixtures.
import assert from 'node:assert/strict';
import { fork, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleApi } from '../src/server/api.ts';
import { Teams } from '../src/server/team.ts';
import { newActivity } from '../src/server/activity.ts';
import { readConsumer, acknowledgeConsumer, notificationCursor } from '../src/server/work-cursors.ts';

async function serve(dataDir, drop) {
  const nodes = new Map([[7, { id: 7, path: dataDir }]]);
  const terminals = new Map(['a','b','brain'].map(id => [id, {
    info: { id, nodeId: 7, agent: 'codex', role: id === 'brain' ? 'brain' : 'operator', alive: true, createdAt: 1, workState: 'idle' },
    teamToken: 'fixture-' + id, seenMessage: 2, injectedMessage: 0, proc: {write() {}}, activity: newActivity(),
  }]));
  const ctx = { cfg: { dataDir, host:'127.0.0.1', port:1 }, cache:{nodes}, teams:new Teams(dataDir),
    terms: { list: () => [...terminals.values()].map(t=>t.info), get: id=>terminals.get(id) } };
  const server = createServer((req, res) => {
    if (req.url === '/fixture-offsets') {
      const a = terminals.get('a');
      res.end(JSON.stringify({ legacy: a.seenMessage, notice: a.injectedMessage, confirmed: !!a.info.noticeConfirmed, state: a.info.workState }));
      return;
    }
    if (drop && req.url.includes('consumer=terminal')) {
      drop = false;
      res.end = data => {
        process.send({ lost: JSON.parse(data).messages.map(m=>m.id) });
        res.destroy();
        return res;
      };
    }
    void handleApi(ctx,req,res);
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  process.send({ port:server.address().port });
}

async function run() {
  const profile = mkdtempSync(join(tmpdir(),'vb-ack-'));
  let child, origin;
  async function start(drop = false) {
    child = fork(import.meta.filename,['--serve',profile,drop?'drop':'ok'], { stdio:['ignore','ignore','inherit','ipc'] });
    const [{ port }] = await Promise.race([
      once(child, 'message'),
      once(child, 'exit').then(([code]) => { throw new Error('Fixture API exited before listening: ' + code); }),
    ]);
    origin = 'http://127.0.0.1:' + port;
  }
  async function stop() {
    if (!child) return;
    if (child.exitCode === null && child.signalCode === null) {
      const ended = once(child,'exit');
      child.kill();
      await ended;
    }
    child = undefined;
  }
  async function call(method, path, actor='a', body, expected=200) {
    const headers = actor ? { authorization: 'Bearer fixture-' + actor } : {};
    const options = { method, headers, signal: AbortSignal.timeout(5000) };
    if (body) { headers['content-type']='application/json'; options.body=JSON.stringify({ ...body, from:actor }); }
    const res=await fetch(origin+path,options);
    const data=await res.json();
    assert.equal(res.status,expected,JSON.stringify(data.error));
    return data;
  }
  const read = (name, actor='a', tail='') => call('GET','/api/work/7?session='+actor+'&consumer='+name+tail,actor);
  const ack = (name,through,expected=200,actor='a') => call('POST','/api/work/7/ack',actor,{consumer:name,through},expected);
  const idle = () => call('POST','/api/work/7/state','a',{state:'idle'});
  const offsets = async () => (await fetch(origin+'/fixture-offsets')).json();
  function bridge(operation, data) {
    const message = { jsonrpc:'2.0', id:1, method:'tools/call', params:{name:'team_request',arguments:{operation,data}} };
    const output = execFileSync(process.execPath,[join(import.meta.dirname,'../src/server/team-mcp.mjs')],{
      input:JSON.stringify(message)+'\n', encoding:'utf8', timeout:12_000,
      env:{PATH:process.env.PATH,VB_STATE_URL:origin+'/api/work/7/state',VB_SESSION_ID:'a',VB_TEAM_TOKEN:'fixture-a'},
    });
    return JSON.parse(output).result;
  }
  try {
    const teams = new Teams(profile);
    for (const text of ['old one','old two']) teams.message(7,'orc',null,text);
    teams.message(7,'orc','b','private to b');
    teams.message(7,'a',null,'own message');
    for(let i=0;i<60;i++) teams.message(7,'orc','a','update '+i);
    teams.message(7,'orc','brain','brain only','brain');

    await start(true);
    await idle();
    const lost = once(child,'message');
    assert.equal(bridge('read',{consumer:'terminal'}).isError,true);
    const [{ lost: lostIds }] = await lost;
    assert.equal(lostIds.length,50);
    await stop();
    await start();
    const first = JSON.parse(bridge('read',{consumer:'terminal'}).content[0].text);
    assert.deepEqual(first.messages.map(m=>m.id),lostIds,'disconnect before ACK and process restart replay exactly the lost page');
    assert.deepEqual([first.delivery.ackedThrough,first.delivery.next,first.delivery.hasMore,first.delivery.gap],[2,54,true,null]);
    await idle();
    assert.equal((await offsets()).notice,54);

    const observer=await read('observer');
    await ack('observer',observer.delivery.next);
    const observerTail=await read('observer');
    await ack('observer',observerTail.delivery.next);
    assert.equal((await offsets()).confirmed,false,'observer ACK is not a terminal confirmation');
    assert.deepEqual((await read('terminal')).messages.map(m=>m.id),lostIds,'consumer ledgers are independent');
    assert.equal(notificationCursor(profile,7,'1','a',2),2,'observer ACK does not drive terminal announcements');
    await idle(); // The terminal may report idle again before its client confirms processing.

    const skipped=await read('terminal','a','&after=54');
    assert.equal(skipped.messages.length,10);
    assert.equal(skipped.delivery.replay,true);
    await ack('terminal',skipped.delivery.next,409);
    assert.equal(JSON.parse(bridge('ack',{consumer:'terminal',through:54}).content[0].text).ackedThrough,54);
    assert.deepEqual(await offsets(),{legacy:2,notice:54,confirmed:true,state:'idle'},'primary ACK confirms the notice without claiming work');
    assert.equal((await ack('terminal',40)).ackedThrough,54,'late ACK cannot move backwards');
    await idle();
    assert.equal((await offsets()).notice,64,'primary ACK alone enables the next notice on idle');
    const second=await read('terminal');
    assert.deepEqual(second.messages.map(m=>m.id),skipped.messages.map(m=>m.id));
    await Promise.all([ack('terminal',60),ack('terminal',64)]);
    await stop(); await start();
    assert.equal((await read('terminal')).delivery.ackedThrough,64);
    assert.equal((await offsets()).legacy,2);
    const replay=await read('terminal','a','&after=2');
    assert.deepEqual(replay.messages.map(m=>m.id),lostIds);
    assert.equal((await read('terminal')).messages.length,0,'replay is non-consuming in either direction');
    const legacy=await call('GET','/api/work/7?session=a');
    assert.equal(legacy.delivery,undefined); assert.deepEqual(legacy.messages.map(m=>m.id),lostIds);
    assert.equal((await call('GET','/api/work/7?session=a')).messages.length,10);
    assert.equal((await call('GET','/api/work/7?session=a')).messages.length,0);
    const other=await read('terminal','b');
    assert.deepEqual(other.messages.map(m=>m.id),[3,4],'visibility still depends on the authenticated recipient');
    await ack('terminal',1,409,'brain');
    await call('GET','/api/work/7?session=a&after=0','a',undefined,400);
    await call('GET','/api/work/7?consumer=terminal',null,undefined,403);
    await call('GET','/api/work/7?session=a&consumer=','a',undefined,400);
    await ack('terminal',1.5,400);
    await stop();

    // A frozen page can itself expire. Report the missing interval and continue with the retained suffix.
    const key = { dataDir:profile, nodeId:7, team:'1', session:'a', consumer:'slow' };
    const log=teams.get(7).messages;
    const shortKey={...key,consumer:'short'};
    const emptyKey={...key,consumer:'sparse'};
    assert.equal(readConsumer(emptyKey,log.slice(0,4),2,null).delivery.next,2);
    assert.equal(readConsumer(emptyKey,log,2,null).messages[0].id,5,'empty read does not starve later addressed messages');
    const short=readConsumer(shortKey,log.slice(0,6),2,null);
    assert.deepEqual(readConsumer(shortKey,log,2,null).messages,short.messages,'late arrivals do not change an outstanding page');
    const pending=readConsumer(key,log,2,null).delivery;
    const retainedTeams = new Teams(profile);
    for(let i=0;i<520;i++) retainedTeams.message(7,'orc','a','new '+i);
    const retained=retainedTeams.get(7).messages;
    const firstId=retained[0].id;
    await start();
    await ack('slow',pending.next,409); // Even a direct ACK of the original page cannot acknowledge expired data.
    const gapPage=await read('slow');
    assert.deepEqual(gapPage.delivery.gap,{from:3,to:firstId-1});
    assert.equal(gapPage.messages.length,0);
    await ack('slow',gapPage.delivery.next,409);
    const gapReplay=await read('slow','a','&after=0');
    assert.deepEqual(gapReplay.delivery.gap,{from:1,to:firstId-1});
    assert.equal(gapReplay.messages[0].id,firstId);
    await ack('slow',gapReplay.delivery.next,409);
    const reconcile=through=>bridge('ack',{consumer:'slow',through,acceptGapThrough:through});
    // If more data expires, confirmation of the old gap is stale too.
    await stop(); new Teams(profile).message(7,'orc','a','one later');
    await start();
    assert.equal(reconcile(firstId-1).isError,true);
    assert.equal(reconcile(firstId).isError,true,'must first observe the new gap');
    const revised=await read('slow');
    assert.equal(revised.delivery.gap.to,firstId);
    assert.equal(JSON.parse(reconcile(firstId).content[0].text).ackedThrough,firstId);
    assert.equal(JSON.parse(reconcile(firstId).content[0].text).ackedThrough,firstId,'repeated reconciliation is idempotent');
    const following=await read('slow');
    assert.equal(following.delivery.gap,null);
    assert.equal(following.messages[0].id,firstId+1);
    assert.equal(following.delivery.oldestAvailable,firstId+1);
    await stop();
    for(const isolated of [{...key,nodeId:8},{...key,team:'2'}]) {
      assert.throws(()=>acknowledgeConsumer(isolated,pending.next,retained),e=>e.status===409);
    }
    console.log('PASS ACK/replay: lost response, restart before/after ACK, ordered pages, independent consumers, terminal notices, scoped replay, retention gaps and legacy GET');
  } finally { await stop(); rmSync(profile,{recursive:true,force:true}); }
}

if (process.argv[2]==='--serve') await serve(process.argv[3],process.argv[4]==='drop');
else await run();
