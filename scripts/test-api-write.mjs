// SQLite contention and API mutation regressions, using only a temporary database and invented paths.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Db } from '../src/server/db.ts';
import { apiWrite } from '../src/server/api-write.ts';
import { handleApi } from '../src/server/api.ts';
import { GraphCache } from '../src/server/cache.ts';
import { DEFAULTS } from '../src/server/config.ts';
import { writeEdges } from '../src/server/graph.ts';

const temp = await mkdtemp(join(tmpdir(), 'vb-api-write-'));
const file = join(temp, 'test.db');
const db = new Db(file), locker = new Db(file);
try {
  await test('writer contention yields to the event loop and applies each mutation once', async () => {
    db.exec('PRAGMA busy_timeout = 1000');
    locker.exec('BEGIN IMMEDIATE');
    let ticks = 0, writes = 0;
    const heartbeat = setInterval(() => ticks++, 10);
    const release = setTimeout(() => locker.exec('COMMIT'), 120);
    const start = performance.now();
    try {
      await Promise.all(Array.from({ length: 5 }, (_, i) => apiWrite(db, () => {
        writes++;
        db.setMeta(`concurrent-${i}`, i);
      })));
    } finally { clearInterval(heartbeat); clearTimeout(release); }
    assert.equal(writes, 5);
    assert.ok(ticks >= 5, `heartbeat stalled: ${ticks} ticks`);
    assert.ok(performance.now() - start < 1000, 'SQLite must not synchronously wait for its busy timeout');
    assert.equal(db.get('PRAGMA busy_timeout').timeout, 1000);
    for (let i = 0; i < 5; i++) assert.equal(db.getMeta(`concurrent-${i}`), String(i));
  });

  await test('lock timeout does not run the callback or leave a transaction open', async () => {
    locker.exec('BEGIN IMMEDIATE');
    let writes = 0;
    try { await assert.rejects(apiWrite(db, () => writes++, 35), error => (error.errcode & 255) === 5); }
    finally { locker.exec('ROLLBACK'); }
    assert.equal(writes, 0);
    await apiWrite(db, () => db.setMeta('after-timeout', 'ok'));
    assert.equal(db.getMeta('after-timeout'), 'ok');
  });

  await test('failed mutations roll back and are never replayed', async () => {
    let calls = 0;
    await assert.rejects(apiWrite(db, () => {
      calls++;
      db.setMeta('must-rollback', 'temporary');
      throw Error('validation failed');
    }), /validation failed/);
    assert.equal(calls, 1);
    assert.equal(db.getMeta('must-rollback'), null);
  });

  const cfg = { ...DEFAULTS, roots: [join(temp, 'files')], dataDir: temp, llm: { ...DEFAULTS.llm, provider: 'none' } };
  db.run("INSERT INTO nodes(path,name,kind,cls) VALUES (?, 'a.md', 'file', 'doc')", join(cfg.roots[0], 'a.md'));
  db.run("INSERT INTO nodes(path,name,kind,cls) VALUES (?, 'b.md', 'file', 'doc')", join(cfg.roots[0], 'b.md'));
  const nodes = db.all('SELECT id FROM nodes ORDER BY id');
  const cache = new GraphCache(); cache.load(db, cfg);
  const ctx = { db, cfg, cache, changed: () => {} };
  async function request(path, method, body) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = method; req.url = path;
    let status, response;
    const res = { writeHead(code) { status = code; }, end(text) { response = JSON.parse(text); } };
    await handleApi(ctx, req, res);
    return { status, body: response };
  }

  await test('edge upsert returns its own stable ID after unrelated inserts', async () => {
    const edge = { src: nodes[0].id, dst: nodes[1].id, kind: 'uses', origin: 'agent:review' };
    const first = await request('/api/edges', 'POST', edge);
    assert.equal(first.status, 201);
    // Force lastInsertRowid away from the edge ID with real API writes.
    for (let i = 0; i < 3; i++) assert.equal((await request(`/api/nodes/${nodes[0].id}/notes`, 'POST', { text: `Nota ${i}` })).status, 201);
    const second = await request('/api/edges', 'POST', { ...edge, confidence: 0.8 });
    assert.equal(second.status, 201);
    assert.equal(second.body.id, first.body.id);
    assert.equal(second.body.confidence, 0.8);
    assert.equal(db.get("SELECT COUNT(*) n FROM edges WHERE origin = 'agent:review'").n, 1);
    const patched = await request(`/api/edges/${first.body.id}`, 'PATCH', { hidden: true });
    assert.equal(patched.body.hidden, true);
    assert.equal((await request(`/api/edges/${first.body.id}`, 'DELETE')).status, 200);
  });

  await test('invalid edge creation leaves neither external rows nor cache ghosts', async () => {
    const before = db.get('SELECT COUNT(*) n FROM nodes').n, cached = cache.nodes.size;
    const path = join(temp, 'not-created.md');
    const result = await request('/api/edges', 'POST', { srcPath: path, dstPath: path });
    assert.equal(result.status, 400);
    assert.equal(db.get('SELECT COUNT(*) n FROM nodes').n, before);
    assert.equal(cache.nodes.size, cached);
  });

  await test('analysis waits for indexing while its local preview remains available', async () => {
    let providerCalls = 0;
    ctx.state = { indexing: true, analyzing: false };
    ctx.startAnalyze = async () => { providerCalls++; throw Error('must not call a provider'); };
    ctx.previewAnalyze = () => ({ payload: 'synthetic local preview', bytes: 23, nodes: 2 });
    assert.equal((await request('/api/analyze', 'POST', {})).status, 409);
    const preview = await request('/api/analyze', 'POST', { dryRun: true });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.payload, 'synthetic local preview');
    assert.equal(providerCalls, 0);
  });

  await test('index reconciliation preserves a visibility change committed just before its write lock', () => {
    const src = nodes[0].id, dst = nodes[1].id;
    db.run("INSERT INTO edges(src,dst,kind,origin,hidden) VALUES (?, ?, 'similar', 'scan', 0)", src, dst);
    const id = db.get("SELECT id FROM edges WHERE kind = 'similar' AND origin = 'scan'").id;
    const tx = db.tx;
    // The second connection models an API commit at the last possible moment before the index takes its write lock.
    // Reading hidden before that lock used to overwrite this committed choice with a stale snapshot.
    db.tx = function (fn) {
      locker.run('UPDATE edges SET hidden = 1 WHERE id = ?', id);
      return tx.call(this, fn);
    };
    try {
      const draft = { src, dst, kind: 'similar', verified: 0, confidence: 0.8, evidence: {}, origin: 'scan', count: 1 };
      writeEdges(db, new Map([['pair', draft]]), 'scan', ['similar']);
      assert.equal(db.get('SELECT hidden FROM edges WHERE id = ?', id)?.hidden, 1);
      assert.equal(db.get("SELECT COUNT(*) n FROM edges WHERE kind = 'similar' AND origin = 'scan'").n, 1);
    } finally {
      db.tx = tx;
      db.run('DELETE FROM edges WHERE id = ?', id);
    }
  });

  await test('a stale cache cannot attach an accepted note or edge to a recycled node ID', async () => {
    const stale = nodes[1].id;
    const notes = db.get('SELECT COUNT(*) n FROM notes').n;
    db.run('DELETE FROM nodes WHERE id = ?', stale);
    assert.equal((await request(`/api/nodes/${stale}/notes`, 'POST', { text: 'must not become orphaned' })).status, 409);
    db.run("INSERT INTO nodes(id,path,name,kind,cls) VALUES (?, ?, 'replacement.md', 'file', 'doc')", stale, join(temp, 'replacement.md'));
    assert.equal((await request(`/api/nodes/${stale}/notes`, 'POST', { text: 'must not attach to another file' })).status, 409);
    assert.equal((await request('/api/edges', 'POST', { src: nodes[0].id, dst: stale, kind: 'uses' })).status, 409);
    assert.equal(db.get('SELECT COUNT(*) n FROM notes').n, notes);
    assert.equal(db.get('SELECT COUNT(*) n FROM edges').n, 0);
  });
} finally {
  locker.close(); db.close();
  await rm(temp, { recursive: true, force: true });
}
