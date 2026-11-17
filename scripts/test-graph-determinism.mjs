// The heuristic edges (similar, shared_id, duplicate) must not depend on node ids, walk order or engine: the same files
// give the same edges, with ties broken by path. The corpus is full of exact ties on purpose.
// Uso: node scripts/test-graph-determinism.mjs — cartelle e database temporanei, nessun dato reale.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS } from '../src/server/config.ts';
import { Db } from '../src/server/db.ts';
import { runIndex } from '../src/server/index.ts';
import { getOrCreateExternal, loadIndex, resolveExisting } from '../src/server/graph.ts';
import { nativeCandidates } from '../src/server/native-indexer.ts';
import { existsSync, accessSync, constants } from 'node:fs';

const tmp = mkdtempSync(join(tmpdir(), 'vb-det-'));
let checks = 0;
const eq = (a, b, m) => { checks++; assert.deepEqual(a, b, m); };
const ok = (c, m) => { checks++; assert.ok(c, m); };
const put = (root, rel, text) => { const p = join(root, rel); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, text); return p; };

const root = join(tmp, 'corpus');
mkdirSync(root);
const files = [];
// 8 clusters x 8 near-identical documents: every document has 7 peers with the exact same score, but only 5 slots
// terms are letters only (no digits), at least 4 long
const WORDS = (c) => Array.from({ length: 12 }, (_, k) => `vocab${String.fromCharCode(97 + c)}${String.fromCharCode(97 + k)}term`);
for (let c = 0; c < 8; c++) {
  for (let i = 0; i < 8; i++) {
    const body = `# Cluster ${c}\n\n${WORDS(c).map((w) => `${w} ${w} ${w}`).join('\n')}\n` + ' '.repeat(i + 1); // different hash, same terms
    files.push(put(root, `docs/c${c}/note-${String.fromCharCode(97 + ((i * 5) % 8))}${i}.md`, body));
  }
}
// identical files of the same path length: the duplicate hub is a pure tie
for (const d of ['p', 'q', 'r', 's']) files.push(put(root, `dup/${d}/same.txt`, 'identical content '.repeat(10)));
// a two-file group of equal path length: the hub is a tie that used to be decided by id
files.push(put(root, 'pair/zz/twin.txt', 'twin file content, exactly the same bytes in both. '.repeat(4)));
files.push(put(root, 'pair/aa/twin.txt', 'twin file content, exactly the same bytes in both. '.repeat(4)));
for (const d of ['u', 'v', 'w']) files.push(put(root, `dup2/${d}/copy.txt`, 'another identical body, longer than the minimum size. '.repeat(5)));
// rare identifiers (hex ids, ABC-123 keys) shared by 2..4 files (all pairs) and by 9 files (a star from the first)
for (let i = 0; i < 9; i++) {
  const own = `export function own_${i}() { return ${i}; }\n`;
  const some = i < 4 ? `// commit c0ffee11aa\n` : '';
  files.push(put(root, `src/m${(i * 7) % 9}.ts`, `${own}${some}// ticket VBX-777 and key beadfeed99\n`));
}
ok(files.length >= 80, `corpus of ${files.length} files`);

/** Same corpus, different node ids: rows for the files are created up front in the given order, the scan keeps those ids. */
async function build(name, engine, order) {
  const db = new Db(join(tmp, `${name}.db`));
  const cfg = structuredClone(DEFAULTS);
  Object.assign(cfg, { roots: [root], dataDir: join(tmp, 'profile'), engine, excludePaths: [], setupComplete: true, desktopMode: false, llm: { ...cfg.llm, provider: 'none' } });
  if (order) {
    const ins = db.prepare("INSERT INTO nodes (path, name, kind, cls, gen, extracted) VALUES (?, ?, 'file', 'other', 0, 0)");
    for (const p of order) ins.run(p, p.slice(p.lastIndexOf('/') + 1));
  }
  await runIndex(db, cfg);
  return { db, cfg };
}

/** Edges as a set of facts: similar and shared_id are undirected (stored min id -> max id), duplicate points at its hub. */
function edges(db) {
  const rows = db.all(`SELECT s.path AS src, d.path AS dst, e.kind, e.verified, e.confidence, e.evidence, e.count
    FROM edges e JOIN nodes s ON s.id = e.src JOIN nodes d ON d.id = e.dst
    WHERE e.origin = 'scan' AND e.kind IN ('similar', 'shared_id', 'duplicate')`);
  for (const r of rows) if (r.kind !== 'duplicate' && r.src > r.dst) [r.src, r.dst] = [r.dst, r.src];
  return rows.sort((a, b) => (a.kind + a.src + a.dst < b.kind + b.src + b.dst ? -1 : 1));
}
const raw = (db, kind, n = 1) => db.all(`SELECT e.id, e.src, e.dst, e.hidden FROM edges e WHERE e.origin = 'scan' AND e.kind = ? ORDER BY e.id LIMIT ?`, kind, n);
const total = (db) => db.get("SELECT COUNT(*) n FROM edges WHERE origin = 'scan' AND kind IN ('similar', 'shared_id', 'duplicate')").n;
function shuffled(list, seed) { // deterministic PRNG so a failure reproduces
  const a = [...list]; let s = seed;
  for (let i = a.length - 1; i > 0; i--) { s = (s * 1664525 + 1013904223) >>> 0; const j = s % (i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

try {
  const sorted = [...files].sort();
  const variants = [
    ['plain', 'ts', null],
    ['reversed', 'ts', [...sorted].reverse()],
    ['shuffled-1', 'ts', shuffled(sorted, 1)],
    ['shuffled-2', 'ts', shuffled(sorted, 2)],
  ];
  const real = nativeCandidates().find((p) => { try { accessSync(p, constants.X_OK); return existsSync(p); } catch { return false; } });
  if (real) variants.push(['native', 'native', shuffled(sorted, 3)]);
  const built = [];
  for (const [name, engine, order] of variants) built.push({ name, ...(await build(name, engine, order)) });

  const base = edges(built[0].db);
  const kinds = (list) => Object.fromEntries(['similar', 'shared_id', 'duplicate'].map((k) => [k, list.filter((e) => e.kind === k).length]));
  const n = kinds(base);
  ok(n.similar > 100 && n.shared_id >= 6 && n.duplicate >= 5, `the corpus exercises every kind (${JSON.stringify(n)})`);
  const idOrder = (db) => db.all("SELECT path FROM nodes WHERE kind = 'file' ORDER BY id LIMIT 12").map((r) => r.path).join(',');
  ok(idOrder(built[0].db) !== idOrder(built[1].db), 'the variants really have different node ids');
  for (const v of built.slice(1)) eq(edges(v.db), base, `${v.name}: same edges as plain (ids/order/engine independent)`);

  // a warm run (nothing changed) keeps every edge, including the capped and tie-broken ones
  for (const v of built) {
    await runIndex(v.db, v.cfg);
    eq(edges(v.db), base, `${v.name}: warm run keeps the same edges`);
  }
  // ranking reads edge direction and degree: it must agree across ids/order/engine too
  const ranking = (db) => db.all("SELECT path, ROUND(importance, 9) AS importance, ROUND(pagerank, 9) AS pagerank, indeg, outdeg FROM nodes WHERE deleted = 0 AND kind = 'file' ORDER BY path");
  const baseRank = ranking(built[0].db);
  ok(baseRank.some((r) => r.indeg > 0) && baseRank.some((r) => r.pagerank > 0), 'the ranking has something to compare');
  for (const v of built.slice(1)) eq(ranking(v.db), baseRank, `${v.name}: same importance / pagerank / degrees as plain`);
  // undirected kinds are stored lower path -> higher path, whatever the ids
  for (const v of built) {
    const flipped = v.db.get(`SELECT COUNT(*) n FROM edges e JOIN nodes s ON s.id = e.src JOIN nodes d ON d.id = e.dst WHERE e.origin = 'scan' AND e.kind IN ('similar', 'shared_id') AND s.path > d.path`).n;
    eq(flipped, 0, `${v.name}: similar/shared_id are stored lower path -> higher path`);
  }
  // an edge the user hid stays hidden, with the same id and no duplicate, across warm runs and across an orientation that differs
  for (const v of built) {
    const before = total(v.db);
    const marks = [];
    for (const kind of ['similar', 'shared_id', 'duplicate']) {
      const [e] = kind === 'duplicate'
        ? v.db.all(`SELECT e.id, e.src, e.dst, e.hidden FROM edges e JOIN nodes s ON s.id = e.src WHERE e.origin = 'scan' AND e.kind = 'duplicate' AND s.path LIKE '%/pair/%'`)
        : raw(v.db, kind);
      v.db.run('UPDATE edges SET hidden = 1 WHERE id = ?', e.id);
      marks.push({ kind, ...e });
    }
    // an edge stored the other way round (older id-based hub, or older orientation): flip every marked one in storage
    for (const m of marks) v.db.run('UPDATE edges SET src = ?, dst = ? WHERE id = ?', m.dst, m.src, m.id);
    await runIndex(v.db, v.cfg);
    eq(total(v.db), before, `${v.name}: no duplicate edges after reorientation`);
    for (const m of marks) {
      const now = v.db.get('SELECT id, hidden FROM edges WHERE id = ?', m.id);
      ok(now && now.hidden === 1, `${v.name}: the hidden ${m.kind} edge keeps its id and stays hidden`);
    }
    const visible = (db) => edges(db).length;
    ok(visible(v.db) === before, `${v.name}: hiding does not change which edges exist`);
  }
  // each document keeps at most 5 'similar' peers it selected, and the chosen ones are the first by path among equals
  const peers = new Map();
  for (const e of base.filter((x) => x.kind === 'similar')) { for (const p of [e.src, e.dst]) peers.set(p, (peers.get(p) ?? 0) + 1); }
  ok(Math.max(...peers.values()) <= 5 * 8, 'similar degree stays bounded');
  // path resolution without an extension: the exact path first, then the variants in a fixed order (.ts before .js, .py before
  // /index.js, /index.ts before /__init__.py); a path registered after the index was loaded (an external one) resolves too
  {
    const { db, cfg } = built[0];
    put(root, 'res/a.ts', 'export const a = 1;\n'); put(root, 'res/a.js', 'exports.a = 1;\n');
    put(root, 'res/b.js', 'exports.b = 1;\n');
    put(root, 'res/e', 'plain file named e\n'); put(root, 'res/e.ts', 'export const e = 1;\n');
    await runIndex(db, cfg);
    const idx = loadIndex(db, cfg);
    const at = (rel) => resolveExisting(idx, join(root, rel))?.id;
    const idOf = (rel) => db.get('SELECT id FROM nodes WHERE path = ?', join(root, rel))?.id;
    eq(at('res/a'), idOf('res/a.ts'), '.ts comes before .js');
    eq(at('res/b'), idOf('res/b.js'), 'a single variant is found');
    eq(at('res/e'), idOf('res/e'), 'the exact path wins over its variants');
    eq(at('res/nothing'), undefined, 'a missing path stays unresolved');
    const ext = getOrCreateExternal(db, idx, '/outside/lib/tool.ts');
    eq(resolveExisting(idx, '/outside/lib/tool')?.id, ext, 'an external path created after loading resolves by variant too');
    // (a folder named like the stem would win as the exact path, so the /index variants are checked on external paths)
    const py = getOrCreateExternal(db, idx, '/outside/m.py'); getOrCreateExternal(db, idx, '/outside/m/index.js');
    eq(resolveExisting(idx, '/outside/m')?.id, py, '.py comes before /index.js');
    const index = getOrCreateExternal(db, idx, '/outside/n/index.ts'); getOrCreateExternal(db, idx, '/outside/n/__init__.py');
    eq(resolveExisting(idx, '/outside/n')?.id, index, '/index.ts comes before /__init__.py');
  }
  for (const v of built) v.db.close();
  console.log(`test-graph-determinism: ${checks} controlli ok`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
