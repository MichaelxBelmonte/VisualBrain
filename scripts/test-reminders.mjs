// Personal reminders survive process restarts and stay separate from team assignments.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Db } from '../src/server/db.ts';
import { handleApi } from '../src/server/api.ts';
const dir = mkdtempSync(join(tmpdir(), 'vb-reminders-'));
let db = new Db(join(dir, 'brain.db'));
const request = async (method, path, body, auth = false) => {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method, url: path, headers: auth ? { authorization: 'Bearer agent' } : {} });
  let status, data;
  // No terms, teams, models or notifications: reminders must work without them.
  await handleApi({ db }, req, { writeHead(code) { status = code; }, end(text) { data = JSON.parse(text); } });
  return { status, data };
};
try {
  db.run("INSERT INTO nodes(id,path,name,kind) VALUES (1,'/one','One','dir'),(2,'/two','Two','file')");
  const a = await request('POST', '/api/reminders', { nodeId: 1, title: '  Follow up <client>  ', notes: 'Tomorrow\nNext step' });
  assert.equal(a.status, 201); assert.equal(a.data.title, 'Follow up <client>');
  assert.equal(a.data.nodePath, '/one'); assert.equal(a.data.status, 'pending');
  const path = `/api/reminders/${a.data.id}`;
  assert.equal((await request('PATCH', path, { status: 'working', notes: 'Day 2: ready' })).status, 200);
  assert.equal((await request('PATCH', path, { nodeId: 2 })).data.nodePath, '/two');
  assert.equal((await request('PATCH', path, { status: 'done' })).data.status, 'done');
  db.close(); db = new Db(join(dir, 'brain.db'));
  const reopened = await request('GET', '/api/reminders');
  assert.equal(reopened.data.length, 1); assert.equal(reopened.data[0].notes, 'Day 2: ready'); assert.equal(reopened.data[0].status, 'done');
  assert.equal(reopened.data[0].createdAt, a.data.createdAt);
  assert.equal((await request('PATCH', path, { status: 'pending' })).data.status, 'pending');
  db.run('UPDATE nodes SET deleted=1 WHERE id=2');
  assert.equal((await request('PATCH', path, { notes: 'Keep this even if the file disappears' })).status, 200);
  for (const body of [{title:''}, {title:null}, {title:42}, {title:'x'.repeat(1001)}, {status:'oops'}, {status:['pending']}, {status:null}, {notes:null}, {notes:3}, {notes:'x'.repeat(10001)}, {nodeId:999}, {nodeId:'1'}, {nodeId:0}]) {
    assert.ok([400,404].includes((await request('PATCH', path, body)).status), JSON.stringify(body).slice(0,100));
  }
  assert.equal((await request('POST', '/api/reminders', {title:'Missing node'})).status, 400);
  assert.equal((await request('PATCH','/api/reminders/missing',{title:'Missing'})).status,404);
  for (const method of ['GET','POST','PATCH']) assert.equal((await request(method, method === 'PATCH' ? path : '/api/reminders', {}, true)).status,403);
  db.run("UPDATE nodes SET path='/reused',deleted=0 WHERE id=2");
  assert.equal((await request('PATCH',path,{notes:'Wrong node'})).status,409);
  assert.equal((await request('PATCH',path,{nodeId:1})).status,200);
  console.log('PASS reminders: create/edit/reassign/complete/reopen, disk persistence, missing/reused node, validation and independence from agents');
} finally { db.close(); rmSync(dir,{recursive:true,force:true}); }
