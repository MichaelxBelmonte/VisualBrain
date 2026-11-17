// Independent indexing regressions. All files, annotations and databases are synthetic.
// node scripts/test-index-review.mjs [--engine=ts|native|auto]
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Db } from '../src/server/db.ts';
import { DEFAULTS } from '../src/server/config.ts';
import { runIndex } from '../src/server/index.ts';
import { getOrCreateExternal, loadIndex } from '../src/server/graph.ts';

const engine = process.argv.find(arg => arg.startsWith('--engine='))?.slice(9) || 'ts';
assert.ok(['ts', 'native', 'auto'].includes(engine));

async function fixture(body) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'vb-review-')));
  const root = join(temp, 'Documenti');
  await mkdir(root);
  const db = new Db(':memory:');
  const cfg = { ...DEFAULTS, roots: [root], dataDir: join(temp, 'profile'),
    excludePaths: [], engine, llm: { ...DEFAULTS.llm, provider: 'none' } };
  const put = async (relative, contents) => {
    const path = join(root, relative);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, contents);
    return path;
  };
  const node = path => db.get('SELECT * FROM nodes WHERE path = ?', path);
  const index = opts => runIndex(db, cfg, opts);
  try { await body({ temp, root, db, cfg, put, node, index }); }
  finally { db.close(); await rm(temp, { recursive: true, force: true }); }
}

await test(`${engine}: unchanged files retain IDs, notes and hidden scan edges`, () => fixture(async ({ db, put, node, index }) => {
  const a = await put('README.md', '# Italiano / English\n[Guida](guida.md)\n');
  const b = await put('guida.md', '# Guida / Guide\nContenuto originale.\n');
  await index();
  const id = node(a).id, target = node(b).id;
  const link = db.get("SELECT * FROM edges WHERE src = ? AND dst = ? AND kind = 'links' AND origin = 'scan'", id, target);
  assert.ok(link);
  db.run('UPDATE edges SET hidden = 1 WHERE id = ?', link.id);
  db.run("INSERT INTO notes(node_id, kind, text, origin, created_at) VALUES (?, 'note', 'Nota / Note', 'agent:review', 1)", id);
  db.run("INSERT INTO edges(src, dst, kind, origin, evidence) VALUES (?, ?, 'uses', 'agent:review', ?)", id, target, JSON.stringify({ note: 'Reviewed relationship' }));
  const second = await index();
  assert.equal(second.scan.changed, 0);
  assert.equal(second.extracted, 0);
  assert.equal(node(a).id, id);
  assert.equal(node(b).id, target);
  assert.equal(db.get('SELECT hidden FROM edges WHERE id = ?', link.id)?.hidden, 1);
  assert.equal(db.get('SELECT COUNT(*) n FROM notes WHERE node_id = ?', id).n, 1);
  assert.equal(db.get("SELECT COUNT(*) n FROM edges WHERE origin = 'agent:review'").n, 1);
}));

await test(`${engine}: external nodes with only notes keep identity`, () => fixture(async ({ root, db, cfg, put, node, index }) => {
  await put('README.md', '# Prova\n');
  await index();
  const path = join(root, 'future.md');
  const id = getOrCreateExternal(db, loadIndex(db, cfg), path);
  db.run("INSERT INTO notes(node_id, kind, text, origin, created_at) VALUES (?, 'note', 'Conservare / Preserve', 'user', 1)", id);
  await index();
  assert.equal(node(path)?.id, id, 'An annotated external identity must not be garbage collected');
  assert.equal(db.get('SELECT node_id FROM notes WHERE node_id = ?', id)?.node_id, id);
}));

await test(`${engine}: an annotated external node becomes a real file without losing its ID`, () => fixture(async ({ root, db, cfg, put, node, index }) => {
  const readme = await put('README.md', '# Prova / Test\n');
  await index();
  const path = join(root, 'nuovo.md');
  const id = getOrCreateExternal(db, loadIndex(db, cfg), path);
  db.run("INSERT INTO notes(node_id, kind, text, origin, created_at) VALUES (?, 'note', 'Approvato / Approved', 'agent:review', 1)", id);
  db.run("INSERT INTO edges(src, dst, kind, origin, hidden) VALUES (?, ?, 'manual', 'agent:review', 1)", node(readme).id, id);
  const edge = db.get("SELECT id FROM edges WHERE origin = 'agent:review'").id;
  await put('nuovo.md', '# Il file ora esiste / The file now exists\n');
  await index();
  assert.equal(node(path)?.id, id);
  assert.equal(node(path)?.kind, 'file');
  assert.equal(node(path)?.deleted, 0);
  assert.equal(db.get('SELECT COUNT(*) n FROM notes WHERE node_id = ?', id).n, 1);
  assert.equal(db.get('SELECT hidden FROM edges WHERE id = ?', edge)?.hidden, 1);
}));

for (const [selected, sibling] of [['group_one', 'groupXone'], ['100%', '100more']]) {
  await test(`${engine}: partial scans treat ${selected} literally`, () => fixture(async ({ root, db, put, node, index }) => {
    const selectedFile = await put(`${selected}/gone.md`, '# Selected\n');
    const siblingFile = await put(`${sibling}/keep.md`, '# Keep\n');
    await index();
    const siblingId = node(siblingFile).id;
    await rm(selectedFile);
    await index({ subtrees: [join(root, selected)] });
    assert.equal(node(selectedFile).deleted, 1);
    assert.equal(node(siblingFile).deleted, 0, 'A literal subtree must not match a similarly named sibling');
    assert.equal(node(siblingFile).id, siblingId);
    assert.equal(node(root).files, 1, 'Ancestor file totals must reflect a partial deletion');
    assert.equal(db.get('SELECT COUNT(*) n FROM nodes WHERE deleted = 0 AND kind = \'file\'').n, 1);
  }));
}

await test(`${engine}: direct file updates and missing subtrees do not create phantom directories`, () => fixture(async ({ root, put, node, index }) => {
  const path = await put('area/notes.md', '# Initial\n');
  await put('other/stay.md', '# Stay\n');
  await index();
  const id = node(path).id;
  await writeFile(path, '# Changed text with a different size\n');
  await index({ subtrees: [path, path] });
  assert.equal(node(path).kind, 'file');
  assert.equal(node(path).id, id);
  assert.equal(node(path).size, Buffer.byteLength('# Changed text with a different size\n'));
  await rm(join(root, 'area'), { recursive: true });
  await index({ subtrees: [join(root, 'area')] });
  assert.equal(node(path).deleted, 1);
  assert.equal(node(join(root, 'area')).deleted, 1, 'A missing directory must not remain as an empty live node');
  assert.equal(node(root).files, 1);
}));

await test(`${engine}: overlapping partial scopes have no duplicate work or unrelated changes`, () => fixture(async ({ root, put, node, index }) => {
  const path = await put('parent/child/a.md', '# A\n');
  const other = await put('elsewhere/b.md', '# B\n');
  await index();
  const before = node(other);
  const summary = await index({ subtrees: [join(root, 'parent'), join(root, 'parent/child'), path] });
  assert.equal(summary.scan.added, 0);
  assert.equal(summary.scan.changed, 0);
  assert.equal(summary.scan.removed, 0);
  assert.equal(node(other).id, before.id);
  assert.equal(node(other).gen, before.gen, 'An unrelated subtree should not be scanned');
}));

await test(`${engine}: partial updates refresh ancestor classification like a full scan`, () => fixture(async ({ root, cfg, put, node, index }) => {
  cfg.dumpMinFiles = 4;
  cfg.dumpDataShare = 0.75;
  await put('area/readme.md', '# Notes\n');
  await index();
  assert.equal(node(root).cls, 'folder');
  for (let i = 0; i < 4; i++) await put(`area/rows-${i}.csv`, 'id,value\n1,2\n');
  await index({ subtrees: [join(root, 'area')] });
  const partial = node(root);
  await index();
  assert.equal(partial.cls, node(root).cls, 'A partial update must not leave an ancestor classification stale');
  assert.equal(partial.files, node(root).files);
  assert.equal(partial.bytes, node(root).bytes);
}));

await test(`${engine}: a new secret rule clears existing extracted content without touching the file`, () => fixture(async ({ cfg, db, put, node, index }) => {
  const path = await put('notes.md', '# Internal\n[Guide](guide.md)\n');
  await put('guide.md', '# A guide\n');
  await index();
  assert.equal(node(path).cls, 'doc');
  assert.ok(node(path).hash);
  assert.ok(db.get('SELECT COUNT(*) n FROM refs WHERE node_id = ?', node(path).id).n > 0);
  cfg.secretPatterns = [...cfg.secretPatterns, 'notes.md'];
  await index();
  assert.equal(node(path).cls, 'secret');
  assert.equal(node(path).hash, null);
  assert.equal(node(path).terms, null);
  assert.equal(db.get('SELECT COUNT(*) n FROM refs WHERE node_id = ?', node(path).id).n, 0);
}));
