// Real reminder API: agents use the live session token and can only access their own node.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Db } from '../src/server/db.ts';
import { handleApi } from '../src/server/api.ts';
const dir=mkdtempSync(join(tmpdir(),'vb-reminder-agent-')), db=new Db(join(dir,'brain.db'));
const member={info:{id:'agent',alive:true,role:'operator',nodeId:1},teamToken:'one-token'};
const terms={get:id=>id==='agent'?member:undefined};
const call=async(method,path,body,token)=>{
 const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);
 Object.assign(req,{method,url:path,headers:token?{authorization:`Bearer ${token}`}:{}});
 let status,data; await handleApi({db,terms},req,{writeHead:s=>status=s,end:s=>data=JSON.parse(s)});return {status,data};
};
try {
 db.run("INSERT INTO nodes(id,path,name,kind) VALUES (1,'/one','One','dir'),(2,'/two','Two','dir')");
 const own=await call('POST','/api/reminders',{nodeId:1,title:'One'});
 const other=await call('POST','/api/reminders',{nodeId:2,title:'Two'});
 const ownPath=`/api/reminders/${own.data.id}`,otherPath=`/api/reminders/${other.data.id}`;
 let result=await call('GET','/api/reminders?session=agent',undefined,'one-token');
 assert.equal(result.status,200);assert.deepEqual(result.data.map(t=>t.title),['One']);
 const added=await call('POST','/api/reminders',{from:'agent',title:'End of day',notes:'Next step'},'one-token');
 assert.equal(added.status,201);assert.equal(added.data.nodeId,1,'node association is automatic for an agent');
 assert.equal((await call('PATCH',ownPath,{from:'agent',status:'done',notes:'Finished today'},'one-token')).status,200);
 assert.equal((await call('PATCH',otherPath,{from:'agent',notes:'Wrong node'},'one-token')).status,404);
 assert.equal((await call('PATCH',ownPath,{from:'agent',nodeId:2},'one-token')).status,403);
 assert.equal((await call('POST','/api/reminders',{from:'agent',nodeId:2,title:'Wrong node'},'one-token')).status,403);
 for (const [session,token] of [['agent','wrong'],['unknown','one-token'],['','one-token']]) {
  assert.equal((await call('GET',`/api/reminders?session=${session}`,undefined,token)).status,403);
 }
 member.info.alive=false;assert.equal((await call('GET','/api/reminders?session=agent',undefined,'one-token')).status,403);member.info.alive=true;
 member.teamToken='rotated';assert.equal((await call('GET','/api/reminders?session=agent',undefined,'one-token')).status,403);member.teamToken='one-token';
 db.run("UPDATE nodes SET path='/replacement' WHERE id=1");
 result=await call('GET','/api/reminders?session=agent',undefined,'one-token');assert.equal(result.status,200);assert.equal(result.data.length,0,'reused node IDs do not expose prior reminders');
 assert.equal((await call('PATCH',ownPath,{from:'agent',notes:'Replacement'},'one-token')).status,404);
 db.run('UPDATE nodes SET deleted=1 WHERE id=1');assert.equal((await call('GET','/api/reminders?session=agent',undefined,'one-token')).status,403);
 result=await call('GET','/api/reminders');assert.equal(result.status,200);assert.equal(result.data.length,3,'UI keeps all reminders independently of agents and node deletion');
 assert.equal(result.data.find(t=>t.nodeId===2).notes,'');
 console.log('PASS reminder agent access: node-scoped reads/writes, automatic node, no cross-node reassignment, session/token validation, ID reuse and UI independence');
} finally {db.close();rmSync(dir,{recursive:true,force:true});}
