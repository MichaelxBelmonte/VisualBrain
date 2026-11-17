// A pass over files only rewritten in place rebuilds just their edges, and ends where a full pass would.
// Uso: node scripts/test-index-narrow.mjs — cartelle e database temporanei, nessun modello.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Db } from '../src/server/db.ts';
import { DEFAULTS } from '../src/server/config.ts';
import { GLOBAL_EVERY_MS, runIndex } from '../src/server/index.ts';
import { lazyIndex, loadIndex, resolveExisting, resolveRefs } from '../src/server/graph.ts';
import { GraphCache } from '../src/server/cache.ts';

const temp = realpathSync(mkdtempSync(join(tmpdir(), 'vb-narrow-')));
try {
  const root = join(temp, 'Scrivania');
  const copy = 'contenuto ripetuto abbastanza lungo da avere un hash: '.repeat(4) + '\n';
  const files = {
    'app/package.json': '{"name":"app","dependencies":{"left-pad":"1.0.0"}}\n',
    'app/src/a.ts': "import { b } from './b';\nimport { c } from './c';\nexport const a = b + c;\n",
    'app/src/b.ts': 'export const b = 1;\n',
    'app/src/c.ts': 'export const c = 2;\n',
    'app/src/d.ts': 'export const d = 3;\n',
    'app/src/e.ts': "import { a } from './a';\nexport const e = a;\n",
    'app/docs/note.md': 'Vedi [[guida]] e src/b.ts.\n',
    'app/docs/guida.md': '# Guida\n',
    'app/copie/uno.txt': copy,
    'app/copie/due.txt': copy,
    'app/copie/tre.txt': 'altro testo che diventerà una copia '.repeat(4) + '\n',
    'app/py/pkg/__init__.py': '',
    'app/py/pkg/util.py': 'def x():\n    return 1\n',
    'app/py/main.py': 'import os\nfrom pkg.util import x\n',
    'app/py/sub/deep.py': 'from pkg import util\n',
  };
  const write = (rel, text, at = Date.now() / 1000) => { const p = join(root, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); utimesSync(p, at, at); return p; };
  for (const [rel, text] of Object.entries(files)) write(rel, text, Date.now() / 1000 - 60);
  const db = new Db(join(temp, 'i.db'));
  const cfg = { ...DEFAULTS, roots: [root], dataDir: join(temp, 'profile'), excludePaths: [join(temp, 'profile')], llm: { ...DEFAULTS.llm, provider: 'none' } };
  await runIndex(db, cfg);
  const rel = p => p.slice(root.length + 1);
  const snapshot = () => db.all(`SELECT a.path s, b.path d, e.kind, e.count, e.confidence, e.verified, e.hidden, e.evidence FROM edges e
      JOIN nodes a ON a.id = e.src JOIN nodes b ON b.id = e.dst WHERE e.origin = 'scan' AND e.kind <> 'similar'`)
    .map(e => `${rel(e.s)} → ${rel(e.d)} ${e.kind} ×${e.count} ${e.confidence} ${e.verified}${e.hidden} ${e.evidence}`).sort();
  const has = (list, text) => list.some(e => e.startsWith(text));
  const before = snapshot();
  assert.ok(has(before, 'app/src/a.ts → app/src/b.ts imports'));
  assert.ok(has(before, 'app/copie/due.txt → app/copie/uno.txt duplicate') || has(before, 'app/copie/uno.txt → app/copie/due.txt duplicate'));

  // Rewrites in place: a.ts imports d instead of b, due.txt stops being a copy, tre.txt becomes one.
  const changed = [
    write('app/src/a.ts', "import { c } from './c';\nimport { d } from './d';\nexport const a = c + d;\n"),
    write('app/copie/due.txt', 'adesso è un testo diverso, non più una copia '.repeat(3) + '\n'),
    write('app/copie/tre.txt', copy),
  ];
  const ranked = db.getMeta('rankAt');
  const narrow = await runIndex(db, cfg, { subtrees: changed });
  const phases = narrow.phases.map(p => p.phase);
  assert.equal(narrow.scan.changed, 3); assert.equal(narrow.extracted, 3);
  assert.ok(!phases.includes('fts') && !phases.includes('rank') && !phases.includes('projects') && !phases.includes('edges:similar'), `a narrow pass skips the global phases: ${phases.join(', ')}`);
  assert.equal(db.getMeta('rankAt'), ranked, 'the weights wait');
  const after = snapshot();
  assert.ok(has(after, 'app/src/a.ts → app/src/d.ts imports') && !has(after, 'app/src/a.ts → app/src/b.ts imports'), 'the rewritten file has its new imports');
  assert.ok(has(after, 'app/src/e.ts → app/src/a.ts imports'), 'edges into it from untouched files stay');
  assert.ok(has(after, 'app/docs/note.md → app/src/b.ts') && has(after, 'app/docs/note.md → app/docs/guida.md'), 'untouched files keep theirs');
  assert.ok(!after.some(e => e.includes('due.txt') && e.includes('duplicate')), 'a copy that changed leaves its group');
  assert.ok(after.some(e => e.includes('tre.txt') && e.includes('uno.txt') && e.includes('duplicate')), 'a file that became a copy joins one');

  // A full pass over the same tree finds exactly the same edges.
  await runIndex(db, cfg);
  assert.deepEqual(snapshot(), after, 'narrow and full passes agree');
  console.log('PASS narrow pass: only rewritten files rebuilt (imports, duplicates), global phases deferred, same edges as a full pass');

  // Once their time has come, the global phases run again on a narrow pass too.
  db.setMeta('rankAt', Date.now() - GLOBAL_EVERY_MS - 1); db.setMeta('similarAt', Date.now() - GLOBAL_EVERY_MS - 1);
  const due = await runIndex(db, cfg, { subtrees: [write('app/src/c.ts', 'export const c = 20;\n')] });
  assert.ok(due.phases.some(p => p.phase === 'rank') && due.phases.some(p => p.phase === 'edges:similar'), 'rank and similarity are due');
  // A new file is not narrow: names can resolve differently, everything is rebuilt.
  const added = await runIndex(db, cfg, { subtrees: [write('app/src/f.ts', "import { b } from './b';\n")] });
  assert.equal(added.scan.added, 1);
  assert.ok(added.phases.some(p => p.phase === 'fts'), 'a new path refreshes the search index');
  assert.ok(has(snapshot(), 'app/src/f.ts → app/src/b.ts imports'));
  console.log('PASS deferred phases run when due; a new file takes the full path');

  // The lazy index answers like the loaded one.
  const full = loadIndex(db, cfg), lazy = lazyIndex(db, cfg);
  for (const p of ['app/src/a.ts', 'app/src/a', 'app/src', 'app/docs/guida.md', 'app/nope.ts', 'app/package.json']) {
    assert.deepEqual(resolveExisting(lazy, join(root, p)), resolveExisting(full, join(root, p)), p);
  }
  for (const name of ['b.ts', 'guida.md', 'nessuno']) assert.deepEqual(lazy.byName.get(name), full.byName.get(name), name);
  const someId = full.byPath.get(join(root, 'app/src/a.ts'));
  assert.deepEqual(lazy.byId.get(someId), full.byId.get(someId));
  // Root-relative targets (python imports, found under some ancestor folder) resolve the same through the loaded index,
  // which skips the folders a target cannot be under, and through the lazy one, which tries them all.
  const loaded = snapshot();
  assert.ok(has(loaded, 'app/py/main.py → app/py/pkg/util.py imports') && has(loaded, 'app/py/sub/deep.py → app/py/pkg/util.py imports'));
  resolveRefs(db, cfg, lazyIndex(db, cfg));
  assert.deepEqual(snapshot(), loaded, 'same reference edges with and without the folder shortcut');
  console.log('PASS lazy index: same lookups and same reference edges as the loaded index');

  // The map loaded in slices is the map loaded at once; a load overtaken by a newer one ends with the newer maps in place.
  const q = { expanded: [], kinds: null, min: 0, view: 'folders', symlinks: true, externals: true, extra: [] };
  const sync = new GraphCache(); sync.load(db, cfg);
  const sliced = new GraphCache(); await sliced.loadAsync(db, cfg);
  assert.deepEqual(sliced.graph(q), sync.graph(q)); assert.deepEqual(sliced.stats, sync.stats);
  const raced = new GraphCache();
  const first = raced.loadAsync(db, cfg);
  db.run("UPDATE nodes SET name = 'rinominato.ts' WHERE path = ?", join(root, 'app/src/b.ts'));
  const second = raced.loadAsync(db, cfg);
  await first;
  assert.equal(raced.nodes.get(full.byPath.get(join(root, 'app/src/b.ts'))).name, 'rinominato.ts', 'the overtaken load waits for the newer maps');
  await second;
  const a = raced.nodes.get(full.byPath.get(join(root, 'app/src/a.ts')));
  assert.ok(raced.incident(a.id).some(e => raced.nodes.get(e.dst)?.path.endsWith('app/src/d.ts')), 'edges by endpoint');
  assert.ok(raced.evidence(raced.incident(a.id).map(e => e.id)).size > 0, 'evidence read on demand');
  // Reloading keeps the objects of unchanged rows (one copy in memory while loading) and only those.
  const keep = new GraphCache(); keep.load(db, cfg);
  const bId = full.byPath.get(join(root, 'app/src/b.ts')), cId = full.byPath.get(join(root, 'app/src/c.ts')), srcId = full.byPath.get(join(root, 'app/src'));
  const [nodeB, nodeC, edge0, kids] = [keep.nodes.get(bId), keep.nodes.get(cId), keep.edges[0], keep.nodes.get(srcId).childCount];
  db.run('UPDATE nodes SET importance = importance + 1 WHERE id = ?', cId);
  db.run('UPDATE edges SET confidence = 0.5 WHERE id = ?', keep.edges[1].id);
  db.run('UPDATE nodes SET deleted = 1 WHERE id = ?', full.byPath.get(join(root, 'app/src/e.ts')));
  await keep.loadAsync(db, cfg);
  assert.equal(keep.nodes.get(bId), nodeB, 'an unchanged node keeps its object');
  assert.notEqual(keep.nodes.get(cId), nodeC); assert.equal(keep.nodes.get(cId).importance, nodeC.importance + 1, 'a changed node is read again');
  assert.equal(keep.edges[0], edge0, 'an unchanged edge keeps its object');
  assert.equal(keep.edges.find(e => e.confidence === 0.5)?.confidence, 0.5, 'a changed edge is read again');
  assert.equal(keep.nodes.get(srcId).childCount, kids - 1, 'children are recounted on a kept folder');
  const fresh = new GraphCache(); fresh.load(db, cfg);
  assert.deepEqual(keep.graph(q), fresh.graph(q)); assert.deepEqual(keep.stats, fresh.stats);
  console.log('PASS map cache: sliced load equals the direct one, an overtaken load waits for the newer maps, edges by node with evidence on demand, unchanged rows keep their objects on reload');
  db.close?.();
} finally {
  rmSync(temp, { recursive: true, force: true });
}
