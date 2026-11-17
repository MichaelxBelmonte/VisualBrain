// Indexing quality on a hand-written corpus (tests/indexing/fixture.mjs): exact precision/recall of the deterministic
// edges, exclusions, secrets, vendor folders, symlinks, Italian/English names, deletions; with a second engine,
// parity of all edges and an engine switch that does not re-extract. Temp folders and DBs only.
//
//   node scripts/test-index-quality.mjs [--engine=ts|native|auto] [--verbose]
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/server/db.ts';
import { DEFAULTS } from '../src/server/config.ts';
import { runIndex } from '../src/server/index.ts';
import { writeFixture, EXPECTED, EXPECTED_AFTER, EXCLUDED } from '../tests/indexing/fixture.mjs';

const engine = process.argv.find((a) => a.startsWith('--engine='))?.slice(9) || 'ts';
const verbose = process.argv.includes('--verbose');
const DETERMINISTIC = new Set(['imports', 'links', 'refpath', 'mention', 'symlink', 'duplicate', 'external']);
const HOME = homedir();
let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

function setup(eng) {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'vb-quality-')));
  const root = join(temp, 'Scrivania');
  writeFixture(root);
  const db = new Db(join(temp, 'q.db'));
  const cfg = {
    ...DEFAULTS, roots: [root], dataDir: join(temp, 'profilo'), engine: eng,
    excludePaths: [join(temp, 'profilo'), ...EXCLUDED.map((d) => join(root, d))], llm: { ...DEFAULTS.llm, provider: 'none' },
  };
  return { temp, root, db, cfg };
}

/** Scan edges as `kind src → dst`, paths relative to the root; duplicate edges sorted (undirected). */
function edges(db, root, kinds) {
  const rel = (p) => (p.startsWith(root + '/') ? p.slice(root.length + 1) : p === root ? '.' : p.startsWith(HOME + '/') ? '~' + p.slice(HOME.length) : p);
  const out = new Set();
  for (const e of db.all("SELECT e.kind, a.path AS s, b.path AS d FROM edges e JOIN nodes a ON a.id = e.src JOIN nodes b ON b.id = e.dst WHERE e.origin = 'scan'")) {
    if (kinds && !kinds.has(e.kind)) continue;
    let [s, d] = [rel(e.s), rel(e.d)];
    if (e.kind === 'duplicate' && s > d) [s, d] = [d, s];
    out.add(`${e.kind} ${s} → ${d}`);
  }
  return out;
}

function score(actual, expected, label) {
  const exp = new Set(expected.map((e) => {
    const m = /^duplicate (.+) → (.+)$/.exec(e);
    return m && m[1] > m[2] ? `duplicate ${m[2]} → ${m[1]}` : e;
  }));
  const tp = [...actual].filter((e) => exp.has(e));
  const fp = [...actual].filter((e) => !exp.has(e));
  const fn = [...exp].filter((e) => !actual.has(e));
  const precision = actual.size ? tp.length / actual.size : 1;
  const recall = exp.size ? tp.length / exp.size : 1;
  console.log(`${label}: precisione ${precision.toFixed(3)} · richiamo ${recall.toFixed(3)} (${tp.length} giusti, ${fp.length} in più, ${fn.length} mancanti)`);
  for (const e of fp) console.log(`  + in più:   ${e}`);
  for (const e of fn) console.log(`  - mancante: ${e}`);
  return { precision, recall, fp, fn };
}

// --- 1. first index ---------------------------------------------------------------------------
const A = setup(engine);
const first = await runIndex(A.db, A.cfg);
if (verbose) for (const e of edges(A.db, A.root)) console.log('  ', e);
const s1 = score(edges(A.db, A.root, DETERMINISTIC), EXPECTED, `[${engine}] primo indice`);
ok(s1.precision === 1 && s1.recall === 1, 'archi deterministici diversi da quelli attesi');

const node = (rel) => A.db.get('SELECT * FROM nodes WHERE path = ?', rel === '.' ? A.root : join(A.root, rel));
// exclusions: no node at all
ok(!node('Archivio-escluso'), 'cartella in excludePaths indicizzata');
ok(!node('Note/.private'), 'cartella .private indicizzata');
// secrets: listed, never read
for (const rel of ['progetto-app/.env', 'credentials.json']) {
  const n = node(rel);
  ok(n && n.cls === 'secret', `${rel} non classificato come segreto`);
  ok(n.hash === null && n.terms === null, `${rel}: contenuto letto (hash/termini)`);
  ok(A.db.get('SELECT COUNT(*) n FROM refs WHERE node_id = ?', n.id).n === 0, `${rel}: riferimenti estratti`);
}
// vendor folders: one aggregate node, contents not listed nor read
for (const rel of ['progetto-app/node_modules', 'progetto-app/dist']) {
  const n = node(rel);
  ok(n && n.aggregate === 1 && n.cls === 'vendor', `${rel} non aggregato`);
  ok(A.db.get('SELECT COUNT(*) n FROM nodes WHERE parent_id = ?', n.id).n === 0, `${rel}: figli indicizzati`);
}
ok(node('progetto-app/node_modules').files === 2, 'totale file di node_modules errato');
// symlinks: the broken one has a node and no edge
ok(node('Collegamenti/rotto')?.kind === 'symlink', 'collegamento rotto non indicizzato');
// Italian names with accents and spaces
ok(node('Note/Riunione città.md')?.cls === 'doc', 'nome con accento e spazio non indicizzato');
// project detection
ok(A.db.get("SELECT COUNT(*) n FROM projects p JOIN nodes n ON n.id = p.node_id WHERE n.path = ?", join(A.root, 'progetto-app')).n === 1, 'progetto non riconosciuto');
ok(first.phases.some((p) => p.phase === 'extract') && first.phases.every((p) => p.ms >= 0), 'metriche per fase mancanti');

// --- 2. unchanged re-index: nothing re-read, same edges -----------------------------------------
const before = edges(A.db, A.root);
const ids = new Map(A.db.all('SELECT id, path FROM nodes').map((r) => [r.path, r.id]));
const second = await runIndex(A.db, A.cfg);
ok(second.scan.added === 0 && second.scan.changed === 0 && second.scan.removed === 0, `secondo indice con cambi: ${JSON.stringify(second.scan)}`);
ok(second.extracted === 0, `secondo indice ha riestratto ${second.extracted} file`);
ok(JSON.stringify([...edges(A.db, A.root)].sort()) === JSON.stringify([...before].sort()), 'archi cambiati senza modifiche');
ok(A.db.all('SELECT id, path FROM nodes').every((r) => !ids.has(r.path) || ids.get(r.path) === r.id), 'id dei nodi cambiati');

// --- 3. deletions, additions, edits -------------------------------------------------------------
const gone = join(A.root, 'progetto-app/docs/guide-en.md');
const goneId = node('progetto-app/docs/guide-en.md').id;
rmSync(gone);
writeFileSync(join(A.root, 'progetto-app/docs/nuovo.md'), '# Nuovo\n\nParte dalla [guida](./guida.md).\n');
const readme = join(A.root, 'progetto-app/README.md');
const { readFileSync } = await import('node:fs');
writeFileSync(readme, readFileSync(readme, 'utf8').replace(/.*Downloads.*\n/, ''));
const third = await runIndex(A.db, A.cfg);
ok(third.scan.removed === 1 && third.scan.added === 1, `cancellazioni/aggiunte contate male: ${JSON.stringify(third.scan)}`);
const s3 = score(edges(A.db, A.root, DETERMINISTIC), EXPECTED_AFTER, `[${engine}] dopo modifiche`);
ok(s3.precision === 1 && s3.recall === 1, 'archi dopo cancellazione/aggiunta diversi da quelli attesi');
ok(A.db.get('SELECT deleted FROM nodes WHERE id = ?', goneId)?.deleted === 1, 'file cancellato non marcato deleted');
ok(A.db.get("SELECT COUNT(*) n FROM nodes WHERE kind = 'external' AND path LIKE '%rapporto-vb-test%'").n === 0, 'identità esterna non più citata rimasta');
A.db.close();

// --- 4. parity and engine switch (only when a second engine is available) -----------------------
const other = engine === 'ts' ? 'native' : 'ts';
const { findNativeBinary } = await import('../src/server/native-indexer.ts').catch(() => ({ findNativeBinary: () => null }));
if (findNativeBinary()) {
  const B = setup(other);
  await runIndex(B.db, B.cfg);
  const C = setup(engine);
  await runIndex(C.db, C.cfg);
  const eb = [...edges(B.db, B.root)].sort();
  const ec = [...edges(C.db, C.root)].sort();
  ok(JSON.stringify(eb) === JSON.stringify(ec), `archi diversi fra ${engine} e ${other} (tutti i tipi): ${eb.filter((e) => !ec.includes(e)).concat(ec.filter((e) => !eb.includes(e))).slice(0, 5).join(' | ')}`);
  // switching engine on the same index must not look like a change of every file (mtime rounding, inode…)
  C.cfg.engine = other;
  const sw = await runIndex(C.db, C.cfg);
  ok(sw.scan.changed === 0 && sw.extracted === 0, `cambio motore ${engine}→${other} ha riestratto: ${JSON.stringify(sw.scan)} estratti ${sw.extracted}`);
  console.log(`[${engine}↔${other}] archi identici (${eb.length}); cambio motore senza riestrazione`);
  for (const x of [B, C]) { x.db.close(); rmSync(x.temp, { recursive: true, force: true }); }
} else {
  console.log('motore nativo non disponibile: parità e cambio motore saltati');
}
rmSync(A.temp, { recursive: true, force: true });
ok(!existsSync(A.temp), 'cartella temporanea non rimossa');
console.log(`test-index-quality: ${checks} controlli ok`);
