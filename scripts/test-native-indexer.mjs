// Parity test: the native walker (native/indexer) must return exactly the entries of walk() in src/server/scan.ts.
//   node scripts/test-native-indexer.mjs                      fixture tree in a temp dir (both engines, every field)
//   node scripts/test-native-indexer.mjs --root <dir> [--runs 3] [--threads 4]
//                                                             also compare on a real tree (read-only) and time both
// The binary is native/indexer/bin/darwin-<arch>/vb-indexer (build: node scripts/build-indexer.mjs) or $VB_NATIVE_INDEXER.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, chmodSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// the reference is always the TypeScript walker, whatever engine the config selects
const scanTs = await import(join(ROOT, 'src/server/scan.ts'));
const walk = scanTs.walkTs ?? scanTs.walk;
const { DEFAULTS } = await import(join(ROOT, 'src/server/config.ts'));

const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; };
const BIN = process.env.VB_NATIVE_INDEXER || join(ROOT, 'native', 'indexer', 'bin', `darwin-${process.arch}`, 'vb-indexer');
if (!existsSync(BIN)) {
  console.error(`binario mancante: ${BIN} — esegui node scripts/build-indexer.mjs`);
  process.exit(1);
}

function cfgFor(roots, extra = {}) {
  return { ...DEFAULTS, engine: 'ts', roots, excludePaths: [], ...extra };
}

function request(cfg, roots, threads) {
  return {
    protocol: 1, roots, configuredRoots: cfg.roots, excludePaths: cfg.excludePaths, excludeNames: cfg.excludeNames,
    vendorNames: cfg.vendorNames, secretPatterns: cfg.secretPatterns, dumpMinFiles: cfg.dumpMinFiles,
    dumpDataShare: cfg.dumpDataShare, threads,
  };
}

/** Runs the binary; resolves entries, end line and the child's peak RSS (via /usr/bin/time -l when available). */
function runNative(cfg, roots, threads = 4) {
  return new Promise((res, rej) => {
    const t0 = performance.now();
    const useTime = existsSync('/usr/bin/time');
    const child = useTime ? spawn('/usr/bin/time', ['-l', BIN, 'walk']) : spawn(BIN, ['walk']);
    let buf = '';
    let err = '';
    const entries = [];
    let end = null;
    let progress = 0;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const m = JSON.parse(line);
        if (m.t === 'entry') { delete m.t; entries.push(m); } else if (m.t === 'end') end = m; else if (m.t === 'progress') progress++;
      }
    });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', rej);
    child.on('close', (code) => {
      if (code !== 0) return rej(new Error(`exit ${code}: ${err.trim()}`));
      const rss = /(\d+)\s+maximum resident set size/.exec(err);
      res({ entries, end, progress, wallMs: performance.now() - t0, rssMB: rss ? Number(rss[1]) / 1048576 : null });
    });
    child.stdin.end(JSON.stringify(request(cfg, roots, threads)));
  });
}

const norm = (e) => ({ ...e, stats: e.stats ? { ...e.stats, markers: [...e.stats.markers].sort() } : null });

function compare(label, ts, nat) {
  assert.ok(nat.end, `${label}: riga end mancante`);
  assert.equal(nat.end.count, nat.entries.length, `${label}: end.count`);
  // parent before children
  const all = new Set(nat.entries.map((e) => e.path));
  const seen = new Set();
  for (const e of nat.entries) {
    if (e.parent && all.has(e.parent)) assert.ok(seen.has(e.parent), `${label}: ${e.path} prima del genitore`);
    seen.add(e.path);
  }
  const a = new Map(ts.map((e) => [e.path, norm(e)]));
  const b = new Map(nat.entries.map((e) => [e.path, norm(e)]));
  const onlyTs = [...a.keys()].filter((p) => !b.has(p));
  const onlyNat = [...b.keys()].filter((p) => !a.has(p));
  assert.deepEqual({ onlyTs: onlyTs.slice(0, 10), onlyNat: onlyNat.slice(0, 10) }, { onlyTs: [], onlyNat: [] }, `${label}: insiemi di percorsi`);
  assert.equal(a.size, ts.length, `${label}: percorsi duplicati in TS`);
  let diffs = 0;
  for (const [p, e] of a) {
    try { assert.deepEqual(b.get(p), e); } catch (err) {
      if (++diffs <= 5) console.error(`${label}: differenza su ${p}\n${err.message.split('\n').slice(0, 30).join('\n')}`);
    }
  }
  assert.equal(diffs, 0, `${label}: ${diffs} voci diverse`);
}

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'vb-native-'));
  const root = join(base, 'Desktop');
  const f = (rel, content = 'x') => { const p = join(root, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, content); return p; };
  f('proj/package.json', '{}');
  f('proj/src/a.ts', 'export const a = 1;\n');
  f('proj/src/deep/b/c/d/e.py', 'print(1)\n');
  f('proj/node_modules/x/index.js', 'module.exports = 1;\n');
  f('proj/node_modules/x/lib/y.js', 'y'.repeat(5000));
  f('proj/node_modules/.bin/keep', '');
  f('gitonly/.git/HEAD', 'ref: x');
  f('gitonly/readme.md', '# r');
  f('venv/pyvenv.cfg', 'home = x');
  f('venv/lib/site.py', 'pass');
  f('venv/lib/.git/x', 'excluded inside aggregate');
  symlinkSync('../lib/site.py', join(root, 'venv/python'));
  for (let i = 0; i < 120; i++) f(`dump/r${i}.csv`, 'a,b\n'.repeat(i + 1));
  f('dump/notes.md', 'n');
  for (let i = 0; i < 25; i++) f(`media/p${i}.png`, 'png');
  f('few-media/a.png'); f('few-media/b.mov');
  f('secrets/.env', 'A=1'); f('secrets/id_rsa', 'k'); f('secrets/key.PEM', 'k'); f('secrets/token.json', '{}');
  f('secrets/service-account-x.json', '{}'); f('secrets/.npmrc', 'x'); f('secrets/settings.json', '{}');
  f('secrets/data.json', '[]'); f('secrets/Makefile', 'all:'); f('secrets/.gitignore', 'x'); f('secrets/noext', 'x');
  mkdirSync(join(root, 'links'));
  symlinkSync('/tmp', join(root, 'links/abs'));
  symlinkSync('../proj/./src/', join(root, 'links/rel'));
  symlinkSync('./nope/../missing', join(root, 'links/dangling'));
  symlinkSync('../proj', join(root, 'links/dirlink'));
  f('spazi e àccenti/ñ é.md', 'ü');
  f('spazi e àccenti/café.txt', 'nfd');
  f('spazi e àccenti/日本語.ts', 'x');
  f('.private/hidden.txt', 'no');
  f('skipme/x.txt', 'no');
  f('build/out.bin', '0'.repeat(100));
  f('empty.txt', '');
  f('deep/' + 'd/'.repeat(440) + 'leaf.txt', 'deep'); // close to PATH_MAX: phase 2 recursion depth
  f('.DS_Store', 'x');
  mkdirSync(join(root, 'emptydir'));
  f('locked/inner.txt', 'x');
  chmodSync(join(root, 'locked'), 0o000);
  spawnSync('mkfifo', [join(root, 'fifo')]);
  const t = new Date('2024-03-01T10:20:30.123Z');
  utimesSync(join(root, 'empty.txt'), t, new Date(1709288430123.4567));
  return { base, root };
}

const results = [];
const { base, root } = fixture();
try {
  const cfg = cfgFor([root], { excludePaths: [join(root, 'skipme')] });
  for (const threads of [1, 4, 16]) {
    const ts = await walk(cfg, cfg.roots);
    const nat = await runNative(cfg, cfg.roots, threads);
    compare(`fixture threads=${threads}`, ts, nat);
    results.push(`fixture threads=${threads}: ${nat.entries.length} voci identiche`);
  }
  // partial rescan of a subtree: parent = dirname(subtree)
  const sub = [join(root, 'proj'), join(root, 'spazi e àccenti')];
  const ts = await walk(cfg, sub);
  const nat = await runNative(cfg, sub);
  compare('sottoalbero', ts, nat);
  assert.equal(nat.entries[0].parent, root);
  results.push(`sottoalbero: ${nat.entries.length} voci identiche`);
  // excluded root and missing root
  const miss = [join(root, 'skipme'), join(root, 'does-not-exist')];
  compare('radici escluse/mancanti', await walk(cfg, miss), await runNative(cfg, miss));
  results.push('radici escluse/mancanti: identiche');
  // protocol errors fall back (non-zero exit, no end line)
  const bad = spawnSync(BIN, ['walk'], { input: '{"protocol":99,"roots":[],"dumpMinFiles":1,"dumpDataShare":1}' });
  assert.notEqual(bad.status, 0);
  assert.ok(!String(bad.stdout).includes('"end"'));
  results.push('protocollo errato: exit≠0 senza end');
} finally {
  chmodSync(join(root, 'locked'), 0o755);
  rmSync(base, { recursive: true, force: true });
}

const real = opt('--root');
if (real) {
  const runs = Number(opt('--runs', 3));
  const threads = Number(opt('--threads', 4));
  const cfg = cfgFor([real], { excludePaths: DEFAULTS.excludePaths });
  const tsMs = [];
  const natMs = [];
  let ts;
  let nat;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    ts = await walk(cfg, cfg.roots);
    tsMs.push(performance.now() - t0);
    nat = await runNative(cfg, cfg.roots, threads);
    natMs.push(nat.wallMs);
  }
  compare(`albero reale ${real}`, ts, nat);
  const med = (xs) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)];
  results.push(`albero reale: ${nat.entries.length} voci identiche; mediana TS ${Math.round(med(tsMs))} ms, nativo ${Math.round(med(natMs))} ms (subprocess+parse, threads=${threads}), RSS figlio ${nat.rssMB?.toFixed(1) ?? '?'} MB`);
}
console.log(results.map((r) => '✓ ' + r).join('\n'));
