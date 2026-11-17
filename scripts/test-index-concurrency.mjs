// Concurrency and consistency tests for the index pipeline: write-lock handling between connections, external identities
// created concurrently, and incremental == fresh when a folder moves in or out of the dump/media role.
// Uso: node scripts/test-index-concurrency.mjs — cartelle e database temporanei, nessun dato reale.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS } from '../src/server/config.ts';
import { Db } from '../src/server/db.ts';
import { runIndex } from '../src/server/index.ts';
import { runIndexOffThread } from '../src/server/index-runner.ts';
import { apiWrite } from '../src/server/api-write.ts';
import { getOrCreateExternal, loadIndex } from '../src/server/graph.ts';

const tmp = mkdtempSync(join(tmpdir(), 'vb-conc-'));
let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.deepEqual(a, b, m); };
const put = (root, rel, text = 'x') => { const p = join(root, rel); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, text); return p; };
const code = (e) => Number(e?.errcode) & 0xff;

function makeCfg(root, over = {}) {
  // defaults only (no brain.config.json, no seeds of the real profile): the data dir lives under the temp folder
  const cfg = structuredClone(DEFAULTS);
  return Object.assign(cfg, { roots: [root], dataDir: join(tmp, 'profile'), engine: 'ts', excludePaths: [], setupComplete: true, desktopMode: false, llm: { ...cfg.llm, provider: 'none' } }, over);
}
const open = (file) => { const d = new Db(file); return d; };

try {
  // --- 1. the write lock: no SQLITE_BUSY_SNAPSHOT for read-then-write transactions ----------------
  const file = join(tmp, 'lock.db');
  const a = open(file); const b = open(file);
  a.run("INSERT INTO notes (node_id, kind, text, origin, created_at) VALUES (1, 'note', 'seed', 'user', 1)");
  // the hazard Db.tx removes: a deferred transaction that read, then lost the race to a commit from another connection
  a.exec('BEGIN');
  a.get('SELECT COUNT(*) n FROM notes');
  b.run("INSERT INTO notes (node_id, kind, text, origin, created_at) VALUES (1, 'note', 'racer', 'user', 2)");
  let snapshot; try { a.run("UPDATE notes SET text = 'x' WHERE id = 1"); } catch (e) { snapshot = e; }
  a.exec('ROLLBACK');
  ok(snapshot && code(snapshot) === 5, `a deferred read-then-write transaction fails with BUSY_SNAPSHOT (${snapshot?.errcode})`);
  // Db.tx holds the lock from the first statement: the other connection waits (or is told BUSY) instead of sneaking in
  b.exec('PRAGMA busy_timeout = 0');
  let raced = null;
  a.tx(() => {
    a.get('SELECT COUNT(*) n FROM notes');
    try { b.run("INSERT INTO notes (node_id, kind, text, origin, created_at) VALUES (1, 'note', 'blocked', 'user', 3)"); } catch (e) { raced = e; }
    a.run("UPDATE notes SET text = 'updated' WHERE id = 1");
  });
  ok(raced && code(raced) === 5, 'inside Db.tx the other connection is refused the lock, not interleaved');
  eq(a.get('SELECT text FROM notes WHERE id = 1').text, 'updated', 'and the read-then-write transaction commits');
  // a failing callback rolls back and keeps its own error even if ROLLBACK has nothing to do
  await assert.rejects(async () => a.tx(() => { a.run("UPDATE notes SET text = 'lost' WHERE id = 1"); throw new Error('boom'); }), /boom/);
  eq(a.get('SELECT text FROM notes WHERE id = 1').text, 'updated', 'a throwing transaction rolls back');
  // apiWrite retries the lock asynchronously: it succeeds once the holder is done
  let release; const held = new Promise((r) => { release = r; });
  a.exec('BEGIN IMMEDIATE');
  const pending = apiWrite(b, () => b.run("INSERT INTO notes (node_id, kind, text, origin, created_at) VALUES (1, 'note', 'queued', 'user', 4)"), 5000);
  setTimeout(() => { a.exec('COMMIT'); release(); }, 150);
  await held; await pending;
  ok(b.get("SELECT 1 x FROM notes WHERE text = 'queued'"), 'apiWrite waits for the lock without blocking, then writes');
  a.close(); b.close();

  // an index in the worker and a stream of API writes on the same file: everything lands, the pass never errors
  const root = join(tmp, 'live'); mkdirSync(root);
  for (let i = 0; i < 1500; i++) put(root, `d${i % 30}/f${i}.ts`, `export const v${i} = ${i};\nimport './f${(i + 1) % 1500}.ts';\n`);
  const dbFile = join(tmp, 'live.db');
  const main = open(dbFile);
  main.exec('PRAGMA busy_timeout = 0');
  const first = await runIndex(main, makeCfg(root));
  ok(first.scan.seen > 1500, 'first index done');
  const node = main.get("SELECT id FROM nodes WHERE kind = 'file' LIMIT 1");
  for (let i = 0; i < 300; i++) put(root, `d${i % 30}/g${i}.ts`, `export const g${i} = ${i};\n`);
  let stop = false; let written = 0; const failures = [];
  const writer = (async () => {
    while (!stop) {
      try { await apiWrite(main, () => main.run("INSERT INTO notes (node_id, kind, text, origin, created_at) VALUES (?, 'note', 'live', 'user', ?)", node.id, Date.now())); written++; } catch (e) { failures.push(e); }
      await new Promise((r) => setTimeout(r, 3));
    }
  })();
  const summary = await runIndexOffThread(main, makeCfg(root), {});
  stop = true; await writer;
  ok(summary.scan.added >= 300, `the worker pass indexed the new files (${summary.scan.added} added)`);
  eq(failures.length, 0, `no concurrent write failed (${written} notes)`);
  eq(main.get("SELECT COUNT(*) n FROM notes WHERE text = 'live'").n, written, 'every accepted note is stored');
  main.close();

  // --- 2. an external identity created while the graph is built keeps its id ------------------------
  const ext = open(join(tmp, 'ext.db'));
  const eroot = join(tmp, 'extroot'); mkdirSync(eroot); put(eroot, 'a.md', '# a\n');
  const ecfg = makeCfg(eroot);
  await runIndex(ext, ecfg);
  const idx = loadIndex(ext, ecfg); // the in-memory index the graph stage works from
  const ghost = join(eroot, 'ghost.md');
  ext.run("INSERT INTO nodes (path, name, kind, ext, cls, depth, gen, extracted) VALUES (?, 'ghost.md', 'external', '', 'other', 0, 0, 1)", ghost); // the API got there first
  const apiId = ext.get('SELECT id FROM nodes WHERE path = ?', ghost).id;
  let got; try { got = getOrCreateExternal(ext, idx, ghost); } catch (e) { got = e; }
  eq(got, apiId, 'getOrCreateExternal adopts the row another connection created instead of failing on UNIQUE(path)');
  eq(ext.get('SELECT COUNT(*) n FROM nodes WHERE path = ?', ghost).n, 1, 'and creates no duplicate');
  ext.close();

  // --- 3. incremental == fresh when a folder changes role -------------------------------------------
  const snap = (d) => d.all(`SELECT n.path, n.cls, n.extracted, n.hash IS NOT NULL AS hashed, n.terms IS NOT NULL AS termed, n.lines,
      (SELECT COUNT(*) FROM refs r WHERE r.node_id = n.id) AS refs, (SELECT COUNT(*) FROM identifiers i WHERE i.node_id = n.id) AS ids
    FROM nodes n WHERE n.deleted = 0 AND n.kind IN ('file', 'dir') ORDER BY n.path`);
  async function compare(name, root, build, change, subtrees) {
    const inc = open(join(tmp, `${name}-inc.db`));
    const cfg = makeCfg(root);
    build();
    await runIndex(inc, cfg);
    change();
    await runIndex(inc, cfg, { subtrees });
    const fresh = open(join(tmp, `${name}-fresh.db`));
    await runIndex(fresh, cfg);
    eq(snap(inc), snap(fresh), `${name}: incremental == fresh (cls, extraction, hashes, refs, identifiers)`);
    inc.close(); fresh.close();
  }
  // 120 csv + docs: a dump; shrinks to 5 csv + a json: no longer a dump, so what is below must be read again
  const r3 = join(tmp, 'dump'); mkdirSync(r3);
  await compare('dump->folder', r3, () => {
    for (let i = 0; i < 120; i++) put(r3, `data/rows-${i}.csv`, `id,v\n${i},1\n`);
    put(r3, 'data/readme.md', '# Data\nSee [meta](meta.json)\n');
  }, () => {
    for (let i = 5; i < 120; i++) rmSync(join(r3, `data/rows-${i}.csv`));
    put(r3, 'data/meta.json', '{"name":"rows"}');
  }, [join(r3, 'data')]);
  // the other direction, and through an ancestor that was only refreshed (the walk was below it)
  const r4 = join(tmp, 'anc'); mkdirSync(r4);
  const cfgSmall = { dumpMinFiles: 10, dumpDataShare: 0.7 };
  const inc = open(join(tmp, 'anc-inc.db')); const fresh = open(join(tmp, 'anc-fresh.db'));
  const cfg4 = makeCfg(r4, cfgSmall);
  put(r4, 'area/readme.md', '# Area\n[notes](notes.md)\n'); put(r4, 'area/notes.md', '# Notes\n'); put(r4, 'area/sub/a.csv', 'a\n1\n');
  await runIndex(inc, cfg4);
  for (let i = 0; i < 8; i++) put(r4, `area/sub/r${i}.csv`, `a\n${i}\n`);
  await runIndex(inc, cfg4, { subtrees: [join(r4, 'area/sub')] });
  await runIndex(fresh, cfg4);
  eq(inc.get("SELECT cls FROM nodes WHERE path = ?", join(r4, 'area')).cls, fresh.get("SELECT cls FROM nodes WHERE path = ?", join(r4, 'area')).cls, 'ancestor role agrees with a fresh index');
  eq(snap(inc), snap(fresh), 'ancestor->dump: incremental == fresh');
  inc.close(); fresh.close();

  console.log(`test-index-concurrency: ${checks} controlli ok`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
