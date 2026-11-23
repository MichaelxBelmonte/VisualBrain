// Integration tests of the scan stage: partial/incremental updates, wildcard-safe paths, engine selector and fallback.
// Uso: node scripts/test-index-integration.mjs — tutto su cartelle e database temporanei; nessun dato reale viene letto.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, appendFileSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS } from '../src/server/config.ts';
import { Db } from '../src/server/db.ts';
import { scan, walk, walkTs, planSubtrees, coalesceSubtrees } from '../src/server/scan.ts';
import { nativeCandidates } from '../src/server/native-indexer.ts';
import { existsSync, accessSync, constants } from 'node:fs';

const tmp = mkdtempSync(join(tmpdir(), 'vb-int-'));
let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };
const eq = (a, b, msg) => { checks++; assert.deepEqual(a, b, msg); };
const put = (root, rel, text = 'x') => { const p = join(root, rel); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, text); return p; };

function makeCfg(root, engine = 'ts') {
  // defaults only (no brain.config.json, no seeds of the real profile): the data dir lives under the temp folder
  const cfg = structuredClone(DEFAULTS);
  Object.assign(cfg, { roots: [root], dataDir: join(tmp, 'profile'), engine, excludePaths: [join(tmp, 'ignored')], setupComplete: true, desktopMode: false });
  return cfg;
}

function fixture(root) {
  put(root, 'a_b/file1.txt', 'one');
  put(root, 'axb/file2.txt', 'two');
  put(root, 'p%q/x.md', '# hi');
  put(root, 'proj/package.json', '{"name":"proj"}');
  put(root, 'proj/src/main.ts', 'export const a = 1;\n');
  put(root, 'proj/node_modules/dep/index.js', 'module.exports = 1;');
  put(root, 'venv1/pyvenv.cfg', 'home = /usr');
  put(root, 'venv1/lib/x.py', 'print(1)');
  // a linked Git worktree of proj: `.git` is a file pointing into proj/.git/worktrees/
  put(root, 'proj-wt/.git', `gitdir: ${join(root, 'proj/.git/worktrees/proj-wt')}\n`);
  put(root, 'proj-wt/package.json', '{"name":"proj"}');
  put(root, 'proj-wt/src/main.ts', 'export const a = 2;\n');
  put(root, 'deep/one/two/three.txt', 'three');
  put(root, 'deep/one/note.txt', 'note');
}

/** What an index must agree on, whichever path produced it. */
function snapshot(db) {
  return db.all(`SELECT path, kind, cls, size, bytes, files, child_count, aggregate, depth FROM nodes
    WHERE deleted = 0 AND kind IN ('file', 'dir', 'symlink') ORDER BY path`);
}
const live = (db, path) => db.get('SELECT * FROM nodes WHERE path = ?', path);
const parentPath = (db, path) => db.get('SELECT p.path FROM nodes n JOIN nodes p ON p.id = n.parent_id WHERE n.path = ?', path)?.path;

try {
  // --- partial updates agree with a full scan -------------------------------------------------
  const root = join(tmp, 'root');
  mkdirSync(root);
  fixture(root);
  const cfg = makeCfg(root);
  const db = new Db(join(tmp, 'inc.db'));
  await scan(db, cfg);
  ok(live(db, join(root, 'axb/file2.txt')), 'full scan sees axb/file2.txt');
  ok(!live(db, join(root, 'proj/node_modules/dep/index.js')), 'vendor contents are not nodes');
  ok(!live(db, join(root, 'venv1/lib')), 'virtualenv contents are not nodes');
  ok(live(db, join(root, 'venv1')).aggregate === 1, 'venv1 is an aggregate');
  ok(live(db, join(root, 'proj-wt')).aggregate === 1 && live(db, join(root, 'proj-wt')).files === 2, 'a worktree of a mapped repository is one total');
  ok(!live(db, join(root, 'proj-wt/src')) && !live(db, join(root, 'proj-wt/package.json')), 'its files are not nodes');

  // wildcard folder: scanning a_b must not touch axb (LIKE '_' would match 'x')
  const axbId = live(db, join(root, 'axb/file2.txt')).id;
  await scan(db, cfg, { subtrees: [join(root, 'a_b')] });
  ok(live(db, join(root, 'axb/file2.txt')).deleted === 0 && live(db, join(root, 'axb/file2.txt')).id === axbId, 'a_b partial scan keeps axb/file2.txt');
  await scan(db, cfg, { subtrees: [join(root, 'p%q')] });
  ok(live(db, join(root, 'p%q/x.md')).deleted === 0, 'p%q partial scan keeps its file');

  // single file changed: stat only, ancestors' totals follow
  const three = join(root, 'deep/one/two/three.txt');
  const before = live(db, join(root, 'deep')).bytes;
  appendFileSync(three, ' more bytes');
  const r1 = await scan(db, cfg, { subtrees: [three] });
  ok(r1.seen === 1 && r1.changed === 1, `file-level scan reads one entry (saw ${r1.seen}, changed ${r1.changed})`);
  eq(live(db, join(root, 'deep')).bytes, before + ' more bytes'.length, 'ancestor bytes updated by a file-level scan');
  eq(live(db, three).extracted, 0, 'a changed file is flagged for extraction');

  // new file in a brand new nested folder: climbs to a known parent, attaches correctly
  const fresh = put(root, 'brand/new/deeper/z.txt', 'z');
  await scan(db, cfg, { subtrees: [fresh] });
  eq(parentPath(db, join(root, 'brand')), root, 'new top folder hangs from the root');
  eq(parentPath(db, fresh), join(root, 'brand/new/deeper'), 'new file hangs from its folder');
  ok(live(db, root).files >= 7, 'root file total includes the new nested file')

  // paths inside ignored areas never create rows
  const nm = put(root, 'proj/node_modules/dep/new.js', 'y');
  const vp = put(root, 'venv1/lib/new.py', 'y');
  put(tmp, 'ignored/s.txt', 'secret');
  await scan(db, cfg, { subtrees: [nm, vp] });
  ok(!live(db, nm) && !live(db, vp), 'vendor/venv paths are not indexed by a partial scan');
  ok(live(db, join(root, 'venv1')).aggregate === 1 && !live(db, join(root, 'venv1/lib')), 'venv stays aggregated');
  const wp = put(root, 'proj-wt/src/new.ts', 'y');
  await scan(db, cfg, { subtrees: [wp] });
  ok(!live(db, wp) && live(db, join(root, 'proj-wt')).aggregate === 1, 'a change inside a worktree does not create nodes');

  // delete a file, then a folder: tombstones only the right rows, totals follow
  rmSync(join(root, 'deep/one/note.txt'));
  const r2 = await scan(db, cfg, { subtrees: [join(root, 'deep/one/note.txt')] });
  ok(r2.seen === 0 && r2.removed === 1, `a deleted file costs no walk (seen ${r2.seen}, removed ${r2.removed})`);
  rmSync(join(root, 'a_b'), { recursive: true });
  await scan(db, cfg, { subtrees: [join(root, 'a_b')] });
  ok(!live(db, join(root, 'a_b/file1.txt')) || live(db, join(root, 'a_b/file1.txt')).deleted === 1, 'a_b rows are gone');
  ok(live(db, join(root, 'axb/file2.txt')).deleted === 0, 'axb survives the deletion of a_b');

  // rows of paths that are gone: removed after a wait, unless something is attached to them
  {
    const gone = join(root, 'deep/one/note.txt');
    const kept = join(root, 'a_b/file1.txt');
    const day = 86_400_000, now = Date.now();
    ok(live(db, gone).deleted === 1 && live(db, gone).deleted_at > 0, 'a vanished path is marked with the time it went');
    eq(db.pruneDeleted(now), 0, 'nothing leaves before its wait is over');
    db.run("INSERT INTO notes (node_id, text, created_at) VALUES (?, 'ricordo', ?)", live(db, kept).id, now);
    const keptId = live(db, kept).id;
    ok(db.pruneDeleted(now + 8 * day) >= 1 && !live(db, gone), 'a file gone for more than a week leaves the database');
    ok(live(db, kept)?.deleted === 1, 'a row with a note stays, however old');
    ok(live(db, join(root, 'a_b'))?.deleted === 1, 'a folder waits longer than its files');
    db.pruneDeleted(now + 91 * day);
    ok(!live(db, join(root, 'a_b')) && live(db, kept), 'the folder leaves after its own wait, the annotated file stays');
    eq(db.get('SELECT COUNT(*) c FROM nodes WHERE deleted = 0 AND path = ?', join(root, 'axb/file2.txt')).c, 1, 'live rows are never touched');
    // the path comes back: same row, same note
    put(root, 'a_b/file1.txt', 'one again');
    await scan(db, cfg, { subtrees: [join(root, 'a_b')] });
    ok(live(db, kept).id === keptId && live(db, kept).deleted === 0, 'a path that comes back keeps its id');
    eq(parentPath(db, kept), join(root, 'a_b'), 'and hangs from its folder again');
    // a database from before deleted_at: old rows start their wait at the first call
    db.run('UPDATE nodes SET deleted = 1, deleted_at = NULL WHERE path = ?', join(root, 'axb/file2.txt'));
    eq(db.pruneDeleted(now), 0, 'a row marked before the column existed is not removed at once');
    ok(live(db, join(root, 'axb/file2.txt')).deleted_at === now, 'its wait starts at the first call');
    await scan(db, cfg, { subtrees: [join(root, 'axb')] });
    ok(live(db, join(root, 'axb/file2.txt')).deleted === 0, 'and the scan brings it back');
  }

  // an external identity at the path of a file that now exists keeps its id
  const futurePath = join(root, 'future.txt');
  db.run("INSERT INTO nodes (path, name, kind, ext, cls, depth, gen, extracted) VALUES (?, 'future.txt', 'external', '', 'other', 0, 0, 1)", futurePath);
  const extId = live(db, futurePath).id;
  put(root, 'future.txt', 'now real');
  await scan(db, cfg, { subtrees: [root] });
  eq(live(db, futurePath).id, extId, 'external identity keeps its id when the file appears');
  eq(live(db, futurePath).kind, 'file', 'and becomes a file');

  // the incremental index equals a clean full scan of the same tree
  const db2 = new Db(join(tmp, 'full.db'));
  await scan(db2, cfg);
  eq(snapshot(db), snapshot(db2), 'partial updates == full scan (paths, sizes, totals, parents)');
  db2.close();

  // --- planning helpers -------------------------------------------------------------------------
  const plan = planSubtrees(db, cfg, [join(root, 'deep'), join(root, 'deep/one'), three, join(tmp, 'ignored/s.txt'), join(tmp, 'elsewhere/x')]);
  eq(plan.walk, [join(root, 'deep')], 'nested subtrees collapse; ignored and out-of-root paths are dropped');
  eq(plan.files, [], 'files under a walked folder are not stat-ed again');
  const many = Array.from({ length: 30 }, (_, i) => join(root, `g${i % 3}`, `h${i}`, 'f.txt'));
  const merged = coalesceSubtrees(many, [root], 12);
  ok(merged.length <= 12 && merged.every((m) => many.some((x) => x.startsWith(m))), `a burst collapses (${many.length} -> ${merged.length})`);

  // --- engine selector -------------------------------------------------------------------------
  const savedEnv = process.env.VB_NATIVE_INDEXER;
  const broken = join(tmp, 'fake-indexer-broken');
  writeFileSync(broken, '#!/bin/sh\necho "boom" >&2\nexit 3\n'); chmodSync(broken, 0o755);
  process.env.VB_NATIVE_INDEXER = broken;
  const reference = (await walkTs(makeCfg(root, 'ts'), [root])).map((e) => e.path).sort();
  eq((await walk(makeCfg(root, 'auto'), [root])).map((e) => e.path).sort(), reference, 'auto falls back to the TypeScript walk when the native one fails');
  await assert.rejects(() => walk(makeCfg(root, 'native'), [root]), /vb-indexer/, 'native mode reports the failure');
  checks++;
  eq((await walk(makeCfg(root, 'ts'), [root])).map((e) => e.path).sort(), reference, 'ts never calls the native binary');

  // a native binary that lies about its entry count is rejected
  const liar = join(tmp, 'fake-indexer-liar');
  writeFileSync(liar, '#!/bin/sh\ncat >/dev/null\necho \'{"t":"entry","path":"/x","parent":null,"name":"x","kind":"dir","ext":"","cls":"folder","lang":null,"size":0,"mtime":0,"inode":0,"depth":1,"aggregate":0,"linkTarget":null,"stats":null}\'\necho \'{"t":"end","count":5,"ms":1}\'\n'); chmodSync(liar, 0o755);
  process.env.VB_NATIVE_INDEXER = liar;
  eq((await walk(makeCfg(root, 'auto'), [root])).map((e) => e.path).sort(), reference, 'a stream whose end count does not match falls back');

  // a misbehaving native helper never reaches the index: auto -> TypeScript result, native -> error and the DB untouched
  const entryLine = (o) => `echo '${JSON.stringify({ t: 'entry', ...o })}'`;
  const rootDir = { path: root, parent: null, name: 'root', kind: 'dir', ext: '', cls: 'folder', lang: null, size: 0, mtime: 1, inode: 1, depth: root.split('/').length - 1, aggregate: 0, linkTarget: null, stats: { files: 0, bytes: 0, childCount: 0, dataFiles: 0, mediaFiles: 0, codeFiles: 0, docFiles: 0, markers: [] } };
  const child = { ...rootDir, path: join(root, 'c.txt'), parent: root, name: 'c.txt', kind: 'file', ext: 'txt', cls: 'doc', depth: rootDir.depth + 1, stats: null };
  const helpers = {
    'crash mid-stream': [entryLine(rootDir), 'exit 1'],
    'malformed JSON': ['echo "{not json"', 'echo \'{"t":"end","count":0}\''],
    'entry without fields': ['echo \'{"t":"entry","foo":1}\'', 'echo \'{"t":"end","count":1}\''],
    'path outside the roots': [entryLine({ ...rootDir, path: '/etc', name: 'etc', depth: 1 }), 'echo \'{"t":"end","count":1}\''],
    'excluded path': [entryLine({ ...rootDir, path: join(tmp, 'ignored'), name: 'ignored', parent: join(tmp) }), 'echo \'{"t":"end","count":1}\''],
    'child before parent': [entryLine(child), entryLine(rootDir), 'echo \'{"t":"end","count":2}\''],
    'duplicate path': [entryLine(rootDir), entryLine(rootDir), 'echo \'{"t":"end","count":2}\''],
    'non-numeric mtime': [entryLine({ ...rootDir, mtime: 'yesterday' }), 'echo \'{"t":"end","count":1}\''],
    'wrong depth': [entryLine({ ...rootDir, depth: 1 }), 'echo \'{"t":"end","count":1}\''],
    'data after end': [entryLine(rootDir), 'echo \'{"t":"end","count":1}\'', entryLine(child)],
    'oversized line': ['head -c 2000000 /dev/zero | tr "\\0" a'],
    'hangs': ['exec sleep 30'],
    'no end line': [entryLine(rootDir)],
    'clean end but no root entry': ['echo \'{"t":"end","count":0}\''],
    'end with a different root only': [entryLine({ ...child, parent: null, kind: 'dir', stats: rootDir.stats, name: 'c.txt', ext: '', cls: 'folder' }), 'echo \'{"t":"end","count":1}\''],
  };
  process.env.VB_NATIVE_TIMEOUT_MS = '600';
  for (const [name, body] of Object.entries(helpers)) {
    const file = join(tmp, `fake-${name.replace(/\W+/g, '-')}`);
    writeFileSync(file, `#!/bin/sh\ncat >/dev/null &\n${body.join('\n')}\n`); chmodSync(file, 0o755);
    process.env.VB_NATIVE_INDEXER = file;
    const realLog = console.error; console.error = () => {};
    try {
      eq((await walk(makeCfg(root, 'auto'), [root])).map((e) => e.path).sort(), reference, `auto + "${name}" falls back to the TypeScript walk`);
      await assert.rejects(() => walk(makeCfg(root, 'native'), [root]), undefined, `native + "${name}" fails`);
      const snap = snapshot(db), gen = db.getMeta('gen');
      await assert.rejects(() => scan(db, makeCfg(root, 'native')), undefined, `native scan + "${name}" fails before writing`);
      eq([snapshot(db), db.getMeta('gen')], [snap, gen], `"${name}" leaves the index untouched`);
    } finally { console.error = realLog; }
    checks += 2;
  }
  delete process.env.VB_NATIVE_TIMEOUT_MS;

  // --- native/TS parity, when a real binary exists ---------------------------------------------
  delete process.env.VB_NATIVE_INDEXER;
  const real = nativeCandidates().find((p) => { try { accessSync(p, constants.X_OK); return existsSync(p); } catch { return false; } });
  if (real) {
    symlinkSync('main.ts', join(root, 'proj/src/alias.ts'));
    const norm = (es) => es.map((e) => ({ ...e, stats: e.stats && { ...e.stats, markers: [...e.stats.markers].sort() } })).sort((a, b) => (a.path < b.path ? -1 : 1));
    const ts = norm(await walkTs(makeCfg(root, 'ts'), [root]));
    const nat = norm(await walk(makeCfg(root, 'native'), [root]));
    eq(nat, ts, `native walk == TypeScript walk (${ts.length} entries, ${real})`);
  } else console.log('  (nessun vb-indexer trovato: parità nativo/TS non verificata)');
  if (savedEnv !== undefined) process.env.VB_NATIVE_INDEXER = savedEnv;
  db.close();
  console.log(`test-index-integration: ${checks} controlli ok`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
