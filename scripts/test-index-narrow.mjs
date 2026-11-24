// A pass over files only rewritten in place rebuilds just their edges, and one in which a few paths appeared or vanished
// just the edges of the files that name them: both end where a full pass would.
// Uso: node scripts/test-index-narrow.mjs — cartelle e database temporanei, nessun modello.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Db } from '../src/server/db.ts';
import { DEFAULTS } from '../src/server/config.ts';
import { GLOBAL_EVERY_MS, LOCAL_MAX_PATHS, runIndex } from '../src/server/index.ts';
import { lazyIndex, loadIndex, namedBy, resolveExisting, resolveRefs } from '../src/server/graph.ts';
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
    // references to paths that do not exist yet
    'app/src/g.ts': "import { n } from './nuovo';\nimport lib from './lib';\nexport const g = n + lib;\n",
    'app/py/other.py': 'from pkg.extra import y\n',
    'app/docs/todo.md': 'Vedi [[futuro]], [[unico]] e src/nuovo.ts.\n',
    'app/docs/unico.md': '# Unico\n',
  };
  const write = (rel, text, at = Date.now() / 1000) => { const p = join(root, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); utimesSync(p, at, at); return p; };
  for (const [rel, text] of Object.entries(files)) write(rel, text, Date.now() / 1000 - 60);
  write('app/docs/assoluto.md', `Il file ${join(root, 'app/src/poi.ts')} arriva dopo.\n`, Date.now() / 1000 - 60);
  write('app/avvia.sh', `#!/bin/sh\nnode "${join(root, 'app/src/poi.ts')}"\nsource ${join(root, 'app/src/poi.ts')}\n`, Date.now() / 1000 - 60);
  symlinkSync(join(root, 'app/src/poi.ts'), join(root, 'app/collegamento'));
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
  console.log('PASS deferred phases run when due');

  // Paths that appear: the files naming them resolve again, the rest of the graph is not read.
  await runIndex(db, cfg);
  const phasesOf = r => r.phases.map(p => p.phase);
  const local = (r, what) => {
    const ph = phasesOf(r);
    assert.ok(ph.includes('edges:named') && !ph.includes('rank') && !ph.includes('edges:similar'), `${what}: a local pass, global phases wait (${ph.join(', ')})`);
    const here = snapshot();
    return here;
  };
  const sameAsFull = async (here, what) => { await runIndex(db, cfg); assert.deepEqual(snapshot(), here, `${what}: local and full passes agree`); };
  const start = snapshot();
  const ends = (list, text) => list.some(e => e.split(' ', 3).join(' ').includes(text));
  assert.ok(has(start, 'app/docs/todo.md → app/docs/unico.md') && !ends(start, 'nuovo') && !ends(start, 'futuro') && !ends(start, 'poi.ts'));
  const arrived = [
    write('app/src/f.ts', "import { b } from './b';\n"),
    write('app/src/nuovo.ts', 'export const n = 1;\n'),
    write('app/src/lib/index.ts', 'export default 2;\n'),
    write('app/py/pkg/extra.py', 'y = 1\n'),
    write('app/docs/futuro.md', '# Futuro\n'),
    write('app/altro/unico.md', '# Un altro unico\n'),
    write('app/copie/quattro.txt', copy),
    write('app/src/poi.ts', 'export const poi = 1;\n'),
  ];
  const grown = await runIndex(db, cfg, { subtrees: [...arrived.filter(p => !p.endsWith('index.ts')), join(root, 'app/src/lib'), join(root, 'app/altro')] });
  assert.equal(grown.scan.added, 10, 'eight files and two folders');
  const afterAdd = local(grown, 'added');
  assert.ok(has(afterAdd, 'app/src/f.ts → app/src/b.ts imports'), 'a new file has its own edges');
  assert.ok(has(afterAdd, 'app/src/g.ts → app/src/nuovo.ts imports'), 'an import waiting for the file finds it');
  assert.ok(has(afterAdd, 'app/src/g.ts → app/src/lib imports'), 'an import of a folder finds the folder');
  assert.ok(has(afterAdd, 'app/py/other.py → app/py/pkg/extra.py imports'), 'a dotted module finds its file');
  assert.ok(has(afterAdd, 'app/docs/todo.md → app/docs/futuro.md') && has(afterAdd, 'app/docs/todo.md → app/src/nuovo.ts'), 'names and paths written in a note find the files');
  assert.ok(!has(afterAdd, 'app/docs/todo.md → app/docs/unico.md') && !has(afterAdd, 'app/docs/todo.md → app/altro/unico.md'), 'a name that is no longer the only one stops resolving');
  assert.ok(has(afterAdd, 'app/collegamento → app/src/poi.ts symlink'), 'a symbolic link finds its target');
  assert.ok(afterAdd.some(e => e.includes('quattro.txt') && e.includes('duplicate')), 'a new copy joins its group');
  const nuovo = db.get('SELECT id, importance FROM nodes WHERE path = ?', join(root, 'app/src/nuovo.ts'));
  assert.ok(nuovo.importance >= 0.25, `a new file is shown before the next ranking (${nuovo.importance})`);
  assert.equal(db.all('SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH ?', '"nuovo.ts"').length, 1, 'and found by the search');
  await sameAsFull(afterAdd, 'added');

  // Paths that vanish: what pointed at them falls back, a name that is unique again resolves again.
  for (const p of ['app/src/nuovo.ts', 'app/altro/unico.md', 'app/copie/uno.txt', 'app/src/lib', 'app/src/poi.ts']) rmSync(join(root, p), { recursive: true });
  const shrunk = await runIndex(db, cfg, { subtrees: ['app/src/nuovo.ts', 'app/altro/unico.md', 'app/copie/uno.txt', 'app/src/lib', 'app/src/poi.ts'].map(p => join(root, p)) });
  assert.equal(shrunk.scan.removed, 6);
  const afterGone = local(shrunk, 'removed');
  assert.ok(!['nuovo.ts', 'lib/index.ts', 'uno.txt', 'poi.ts'].some(p => ends(afterGone, p)), 'no edge is left on a path that is gone');
  assert.ok(has(afterGone, 'app/docs/todo.md → app/docs/unico.md'), 'the name is unique again');
  assert.ok(afterGone.some(e => e.includes('quattro.txt') && e.includes('tre.txt') && e.includes('duplicate')), 'the copies left pick another hub');
  assert.equal(db.all('SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH ?', '"nuovo.ts"').length, 0, 'gone from the search');
  await sameAsFull(afterGone, 'removed');
  // The same path back: the row and its id are the ones it had.
  const back = await runIndex(db, cfg, { subtrees: [write('app/src/nuovo.ts', 'export const n = 3;\n')] });
  const afterBack = local(back, 'back');
  assert.equal(db.get('SELECT id FROM nodes WHERE path = ? AND deleted = 0', join(root, 'app/src/nuovo.ts')).id, nuovo.id);
  assert.ok(has(afterBack, 'app/src/g.ts → app/src/nuovo.ts imports'));
  await sameAsFull(afterBack, 'back');
  console.log('PASS local pass: paths that appear, vanish or come back rebuild only the files naming them, same edges as a full pass; new files ranked and searchable');

  // What cannot be local: a new project (files resolve names through it), too many paths, too many files naming them.
  write('app/tools/package.json', '{"name":"tools"}\n'); write('app/tools/t.ts', 'export {};\n');
  const project = await runIndex(db, cfg, { subtrees: [join(root, 'app/tools')] });
  assert.equal(db.get('SELECT cls FROM nodes WHERE path = ?', join(root, 'app/tools')).cls, 'project');
  assert.ok(phasesOf(project).includes('rank') && !phasesOf(project).includes('edges:named'), 'a new project takes the full path');
  const many = [];
  for (let i = 0; i <= LOCAL_MAX_PATHS; i++) many.push(write(`app/tanti/f${i}.txt`, `file numero ${i}\n`));
  const crowd = await runIndex(db, cfg, { subtrees: [join(root, 'app/tanti')] });
  assert.ok(phasesOf(crowd).includes('rank') && !phasesOf(crowd).includes('edges:named'), 'many new paths take the full path');
  assert.equal(namedBy(db, [nuovo.id], 0), null, 'more files than the limit: no list');
  assert.deepEqual(namedBy(db, [nuovo.id], 100).map(id => rel(db.get('SELECT path FROM nodes WHERE id = ?', id).path)).sort(), ['app/docs/todo.md', 'app/src/g.ts']);
  console.log('PASS full path kept for a new project, for many paths and for names written in too many files');

  // Nothing new since the last global run: nothing is computed, however old that run is.
  await runIndex(db, cfg);
  db.setMeta('rankAt', Date.now() - GLOBAL_EVERY_MS - 1); db.setMeta('similarAt', Date.now() - GLOBAL_EVERY_MS - 1);
  const idle = await runIndex(db, cfg, { subtrees: [join(root, 'app/src/b.ts')] });
  assert.equal(idle.scan.changed + idle.scan.added + idle.scan.removed, 0);
  assert.ok(!phasesOf(idle).some(p => p === 'rank' || p.startsWith('edges')), `a pass that found nothing computes nothing: ${phasesOf(idle).join(', ')}`);
  // A change waiting for its turn: when the time comes, similarity and rank run on their own.
  db.setMeta('rankAt', Date.now()); db.setMeta('similarAt', Date.now());
  await runIndex(db, cfg, { subtrees: [write('app/src/d.ts', 'export const d = 30;\n')] });
  db.setMeta('rankAt', Date.now() - GLOBAL_EVERY_MS - 1); db.setMeta('similarAt', Date.now() - GLOBAL_EVERY_MS - 1);
  const turn = await runIndex(db, cfg, { subtrees: [join(root, 'app/src/b.ts')] });
  assert.ok(phasesOf(turn).includes('rank') && phasesOf(turn).includes('edges:similar') && !phasesOf(turn).includes('edges:refs'), `only the global phases: ${phasesOf(turn).join(', ')}`);
  const again = await runIndex(db, cfg, { subtrees: [join(root, 'app/src/b.ts')] });
  assert.ok(!phasesOf(again).some(p => p === 'rank' || p.startsWith('edges')));
  console.log('PASS global phases: never when nothing changed since their last run, alone when a change was waiting');

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
