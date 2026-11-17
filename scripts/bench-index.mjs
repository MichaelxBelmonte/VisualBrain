// Indexing benchmark on throwaway indexes: time, memory and event-loop stalls per phase, plus an edge fingerprint
// so that two engines can be compared on the same input and configuration. Never touches the live database.
//
//   node scripts/bench-index.mjs [--files 20000] [--label baseline] [--runs cold,warm,incremental,reextract]
//                                [--root DIR]... [--repo] [--keep] [--out tests/indexing/results]
//                                [--src tests/indexing/baseline-engine/src] [--engine ts|native|auto] [--repeat 3]
//   node scripts/bench-index.mjs --compare before.json after.json
//
// --files N   synthetic Desktop with ≈N files (0 skips it); --root DIR indexes a real tree read-only into a temp DB;
// --repo      indexes this repository. Each run is a separate process on the same temp DB (cold → warm → incremental
// → reextract), so RSS and peaks belong to that run only. --src runs another copy of the engine (the baseline) on
// the same input and exclusions; --engine sets VB_ENGINE / cfg.engine for the run.
// Memory: peak RSS of the Node process and of the whole process tree (Node + native helpers), sampled with ps.
// Responsiveness: the run process serves HTTP and the parent probes it every 50 ms, as the UI would the server.
import { spawn, execFile } from 'node:child_process';
import { createServer, request } from 'node:http';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir, cpus, totalmem } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const argv = process.argv.slice(2);
const flag = (name, def) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; };
const multi = (name) => argv.flatMap((a, i) => (a === name ? [argv[i + 1]] : []));

/** Edge kinds whose result must not depend on the engine (same input → same edges). */
export const EXACT_KINDS = ['imports', 'links', 'refpath', 'mention', 'symlink', 'duplicate', 'external'];

// ---------------------------------------------------------------------------------------------
// child: one indexing run, prints a JSON line
if (argv[0] === '--child') {
  const job = JSON.parse(argv[1]);
  const src = (m) => import(new URL(`file://${join(job.src, 'server', m)}`).href);
  const { Db } = await src('db.ts');
  const { DEFAULTS } = await src('config.ts');
  const { runIndex } = await src('index.ts');
  const { IndexMetrics } = await src('metrics.ts');
  // same exclusions for every engine copy: never the live data dir of this repository
  const cfg = { ...DEFAULTS, roots: job.roots, dataDir: job.dataDir, excludePaths: job.excludePaths, llm: { ...DEFAULTS.llm, provider: 'none' }, ...(job.engine ? { engine: job.engine } : {}) };
  const engineLog = [];
  const error = console.error;
  console.error = (...a) => { if (String(a[0]).startsWith('[engine]')) engineLog.push(String(a[0])); error(...a); };
  let binary = null;
  try { binary = (await src('native-indexer.ts')).findNativeBinary(); } catch { /* engine copy without the native adapter */ }
  const db = new Db(job.db);
  const hb = createServer((_q, res) => res.end('ok'));
  await new Promise((r) => hb.listen(0, '127.0.0.1', r));
  process.stdout.write(JSON.stringify({ port: hb.address().port }) + '\n');
  await new Promise((r) => process.stdin.once('data', r));
  const metrics = new IndexMetrics().sample(10);
  const t0 = performance.now();
  const s = await runIndex(db, cfg, { reextract: job.mode === 'reextract', metrics });
  const wall = performance.now() - t0;
  metrics.stop();
  // answer the probe that waited through the last synchronous phases before doing more work or exiting
  await new Promise((r) => setTimeout(r, 120));
  const rows = db.all(`SELECT e.kind, a.path AS src, b.path AS dst FROM edges e JOIN nodes a ON a.id = e.src JOIN nodes b ON b.id = e.dst WHERE e.origin = 'scan'`);
  const byKind = {};
  const fp = {};
  const lines = [];
  for (const k of [...EXACT_KINDS, 'shared_id', 'similar']) fp[k] = createHash('sha1');
  // paths relative to the roots: two runs on copies of the same tree in different temp folders compare equal
  const norm = (p) => { const i = job.roots.findIndex((r) => p === r || p.startsWith(r + '/')); return i < 0 ? p : `<root${i}>${p.slice(job.roots[i].length)}`; };
  for (const e of rows) {
    e.src = norm(e.src); e.dst = norm(e.dst);
    // symmetric relations: src/dst follow the node ids, which depend on the walk order, not on the content
    if ((e.kind === 'similar' || e.kind === 'shared_id') && e.src > e.dst) [e.src, e.dst] = [e.dst, e.src];
  }
  rows.sort((x, y) => (x.kind + x.src + x.dst < y.kind + y.src + y.dst ? -1 : 1));
  for (const e of rows) {
    byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    fp[e.kind]?.update(`${e.src}\t${e.dst}\n`);
    lines.push(`${e.kind}\t${e.src}\t${e.dst}`);
  }
  if (job.edgesOut) writeFileSync(job.edgesOut, lines.join('\n') + '\n');
  const nodes = Object.fromEntries(db.all("SELECT kind, COUNT(*) AS n FROM nodes WHERE deleted = 0 GROUP BY kind").map((r) => [r.kind, r.n]));
  db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  hb.close();
  process.stdout.write(JSON.stringify({
    mode: job.mode, wallMs: Math.round(wall),
    engine: { requested: cfg.engine ?? 'ts (copia senza selettore)', binary: (cfg.engine === 'native' || cfg.engine === 'auto') ? binary : null, fallback: engineLog.length > 0, log: engineLog.slice(0, 3) }, summary: { seen: s.scan.seen, added: s.scan.added, changed: s.scan.changed, removed: s.scan.removed, extracted: s.extracted, projects: s.projects, edges: s.edges },
    phases: s.phases, peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024), nodes, edgesByKind: byKind,
    fingerprint: Object.fromEntries(Object.entries(fp).map(([k, h]) => [k, h.digest('hex').slice(0, 16)])),
    dbMb: Math.round(statSync(job.db).size / 1048576 * 10) / 10,
  }) + '\n');
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------
// compare two result files
if (argv[0] === '--compare') {
  const [a, b] = [JSON.parse(readFileSync(argv[1], 'utf8')), JSON.parse(readFileSync(argv[2], 'utf8'))];
  console.log(`prima: ${a.label} (${a.date})   dopo: ${b.label} (${b.date})`);
  let regress = false;
  for (const ca of a.cases) {
    const cb = b.cases.find((c) => c.name === ca.name);
    if (!cb) continue;
    console.log(`\n== ${ca.name}`);
    for (const ra of ca.runs) {
      const rb = cb.runs.find((r) => r.mode === ra.mode);
      if (!rb) continue;
      const pct = (x, y) => (x ? `${y < x ? '' : '+'}${Math.round(((y - x) / x) * 100)}%` : '');
      console.log(`  ${ra.mode.padEnd(12)} totale ${ra.wallMs} → ${rb.wallMs} ms (${pct(ra.wallMs, rb.wallMs)})   picco Node ${ra.peakRssMb} → ${rb.peakRssMb} MB   albero ${ra.memory?.treePeakSampledMb ?? '?'} → ${rb.memory?.treePeakSampledMb ?? '?'} MB   blocco max ${maxStall(ra)} → ${maxStall(rb)} ms   HTTP max ${ra.http?.max ?? '?'} → ${rb.http?.max ?? '?'} ms`);
      for (const pa of ra.phases.filter((p) => !p.phase.includes(':'))) {
        const pb = rb.phases.find((p) => p.phase === pa.phase);
        if (pb && (pa.ms > 50 || pb.ms > 50)) console.log(`    ${pa.phase.padEnd(10)} ${String(pa.ms).padStart(9)} → ${String(pb.ms).padStart(9)} ms ${pct(pa.ms, pb.ms).padStart(6)}`);
      }
      for (const k of EXACT_KINDS) {
        if ((ra.fingerprint[k] ?? '') !== (rb.fingerprint[k] ?? '')) {
          console.log(`    ! archi ${k} diversi: ${ra.edgesByKind[k] ?? 0} → ${rb.edgesByKind[k] ?? 0}`);
          regress = true;
        }
      }
      for (const k of ['shared_id', 'similar']) if ((ra.edgesByKind[k] ?? 0) !== (rb.edgesByKind[k] ?? 0)) console.log(`    ~ archi ${k}: ${ra.edgesByKind[k] ?? 0} → ${rb.edgesByKind[k] ?? 0}`);
    }
  }
  console.log(regress ? '\nATTENZIONE: archi deterministici diversi a parità di input (diff con --keep e i file edges-*.tsv).' : '\nArchi deterministici identici.');
  process.exit(regress ? 1 : 0);
}

function relativeTo(p) {
  return p.startsWith(REPO + '/') ? p.slice(REPO.length + 1) : p;
}

function maxStall(run) {
  return Math.max(0, ...run.phases.filter((p) => !p.phase.includes(':')).map((p) => p.stallMs));
}

// ---------------------------------------------------------------------------------------------
// parent: prepare inputs, run each mode in its own process
const { generateCorpus, mutateCorpus } = await import('../tests/indexing/corpus.mjs');
const files = Number(flag('--files', '20000'));
const label = flag('--label', 'run');
const runs = flag('--runs', 'cold,warm,incremental,reextract').split(',');
const outDir = resolve(flag('--out', join(REPO, 'tests/indexing/results')));
const engineSrc = resolve(flag('--src', join(REPO, 'src')));
const engine = flag('--engine', '');
const repeat = Math.max(1, Number(flag('--repeat', '1')));
const keep = argv.includes('--keep');
const work = mkdtempSync(join(tmpdir(), 'vb-bench-'));
const HOME = process.env.HOME;
// Extra private folders to skip on a real Desktop run: VB_BENCH_EXCLUDE="~/Desktop/private:~/Desktop/other".
const baseExcludes = [...(process.env.VB_BENCH_EXCLUDE ?? '').split(':').filter(Boolean).map(p => p.replace(/^~(?=\/|$)/, HOME)), join(REPO, 'data'), join(REPO, 'dist')];
const cases = [];
if (files > 0) cases.push({ name: `sintetico-${files}`, roots: [join(work, 'Desktop')], synthetic: true });
if (argv.includes('--repo')) cases.push({ name: 'repo', roots: [REPO], excludePaths: [join(REPO, 'release'), join(REPO, 'app'), join(REPO, 'tests/indexing/baseline-engine')] });
for (const r of multi('--root')) cases.push({ name: `reale-${r.split('/').filter(Boolean).pop()}`, roots: [resolve(r)], readOnly: true });

const run$ = promisify(execFile);
/** RSS (MB) of `pid` and of its descendants, from one `ps` snapshot. */
async function treeRss(pid) {
  const { stdout } = await run$('ps', ['-A', '-o', 'pid=,ppid=,rss=']);
  const kids = new Map();
  const rss = new Map();
  for (const l of stdout.trim().split('\n')) {
    const [p, pp, r] = l.trim().split(/\s+/).map(Number);
    rss.set(p, r);
    if (!kids.has(pp)) kids.set(pp, []);
    kids.get(pp).push(p);
  }
  let others = 0;
  const stack = [...(kids.get(pid) ?? [])];
  while (stack.length) { const p = stack.pop(); others += rss.get(p) ?? 0; stack.push(...(kids.get(p) ?? [])); }
  return { self: (rss.get(pid) ?? 0) / 1024, others: others / 1024 };
}

function probe(port) {
  return new Promise((res) => {
    const t = performance.now();
    const at = Date.now();
    const q = request({ host: '127.0.0.1', port, path: '/', agent: false }, (r) => { r.resume(); r.on('end', () => res({ at, ms: performance.now() - t })); });
    q.on('error', (e) => res({ at, ms: performance.now() - t, error: e.code || true }));
    q.end();
  });
}

const pctl = (xs, p) => { if (!xs.length) return 0; const a = [...xs].sort((x, y) => x - y); return Math.round(a[Math.min(a.length - 1, Math.floor(p * a.length))] * 10) / 10; };

/** One indexing run in its own process, with HTTP probes and process-tree RSS sampling. */
async function runChild(job) {
  const tSpawn = performance.now();
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', JSON.stringify(job)], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...(job.engine ? { VB_ENGINE: job.engine } : {}) },
  });
  let out = '';
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  const probes = [];
  let peakSelf = 0, peakOthers = 0, peakTree = 0;
  let done = false;
  const exited = new Promise((r) => child.on('exit', (code) => { done = true; r(code); }));
  const port = await new Promise((r) => child.stdout.on('data', (d) => {
    out += d;
    const nl = out.indexOf('\n');
    if (nl >= 0 && r) { const p = JSON.parse(out.slice(0, nl)).port; out = out.slice(nl + 1); r(p); r = null; }
  }));
  const prober = (async () => { while (!done) { probes.push(await probe(port)); await new Promise((r) => setTimeout(r, 50)); } })();
  const sampler = (async () => {
    while (!done) {
      try { const m = await treeRss(child.pid); peakSelf = Math.max(peakSelf, m.self); peakOthers = Math.max(peakOthers, m.others); peakTree = Math.max(peakTree, m.self + m.others); } catch { /* process gone */ }
      await new Promise((r) => setTimeout(r, 100));
    }
  })();
  child.stdin.write('go\n');
  const code = await exited;
  const processMs = Math.round(performance.now() - tSpawn);
  await Promise.all([prober, sampler]);
  if (code !== 0) { console.error(err); process.exit(1); }
  const run = JSON.parse(out.trim().split('\n').pop());
  // a failed probe (connection reset at exit) still waited that long: kept as a lower bound
  const ok = probes.map((p) => p.ms);
  run.processMs = processMs;    // spawn → exit: includes Node start, module load, DB open/close
  run.memory = { nodePeakMb: run.peakRssMb, treePeakSampledMb: Math.round(peakTree), nativePeakSampledMb: Math.round(peakOthers) };
  run.http = { probes: ok.length, errors: probes.filter((p) => p.error).length, p50: pctl(ok, 0.5), p95: pctl(ok, 0.95), max: pctl(ok, 1) };
  // latency of the probes sent during each top-level phase
  let prev = 0;
  for (const ph of run.phases.filter((x) => !x.phase.includes(':'))) {
    const xs = probes.filter((p) => p.at > prev && p.at <= ph.endAt).map((p) => p.ms);
    ph.httpMaxMs = xs.length ? pctl(xs, 1) : null;
    prev = ph.endAt;
  }
  return run;
}

const result = { label, date: new Date().toISOString(), src: relativeTo(engineSrc), engine: engine || 'default', machine: { cpu: cpus()[0]?.model, cores: cpus().length, memGb: Math.round(totalmem() / 2 ** 30), node: process.version, arch: process.arch }, cases: [] };
for (const c of cases) {
  const dataDir = join(work, `${c.name}-data`);
  const db = join(dataDir, 'bench.db');
  const entry = { name: c.name, roots: c.synthetic ? ['<sintetico>'] : c.roots, repeat, runs: [], raw: [] };
  for (let rep = 1; rep <= repeat; rep++) {
    rmSync(dataDir, { recursive: true, force: true });
    mkdirSync(dataDir, { recursive: true });
    if (c.synthetic) {
      const t = performance.now();
      entry.corpus = generateCorpus(c.roots[0], { files, seed: 1 });
      entry.corpus.generateMs = Math.round(performance.now() - t);
      if (rep === 1) console.log(`[${c.name}] corpus: ${entry.corpus.files} file, ${Math.round(entry.corpus.bytes / 1048576)} MB, ${entry.corpus.vendorFiles} in vendor (${entry.corpus.generateMs} ms)`);
    }
    for (const mode of runs) {
      if (mode === 'incremental') {
        if (!c.synthetic) continue;      // never change a real tree
        entry.mutation = mutateCorpus(c.roots[0], { share: 0.01, seed: 7 });
      }
      const job = { mode, src: engineSrc, engine, roots: c.roots, dataDir, db, excludePaths: [...baseExcludes, dataDir, ...(c.excludePaths ?? [])], edgesOut: keep ? join(work, `edges-${c.name}-${mode}-${rep}.tsv`) : null };
      const run = await runChild(job);
      run.rep = rep;
      entry.raw.push(run);
      const top = run.phases.filter((x) => !x.phase.includes(':')).sort((a, b) => b.ms - a.ms).slice(0, 3).map((x) => `${x.phase} ${x.ms}`).join(', ');
      console.log(`[${c.name}#${rep}] ${mode.padEnd(11)} ${String(run.wallMs).padStart(7)} ms (processo ${run.processMs}) · picco ${run.peakRssMb} MB · albero ${run.memory.treePeakSampledMb} MB · blocco max ${maxStall(run)} ms · HTTP p95/max ${run.http.p95}/${run.http.max} ms · archi ${run.summary.edges} · ${top}${run.engine.fallback ? ' · FALLBACK TS' : ''}`);
    }
  }
  // representative run per mode: the one with the median wall time (its phases stay consistent with each other)
  for (const mode of runs) {
    const all = entry.raw.filter((r) => r.mode === mode).sort((a, b) => a.wallMs - b.wallMs);
    if (!all.length) continue;
    const med = all[Math.floor((all.length - 1) / 2)];
    entry.runs.push({ ...med, wallMsAll: all.map((r) => r.wallMs), processMsAll: all.map((r) => r.processMs), fingerprintsStable: all.every((r) => JSON.stringify(r.fingerprint) === JSON.stringify(all[0].fingerprint)) });
  }
  if (repeat === 1) delete entry.raw;
  result.cases.push(entry);
}
mkdirSync(outDir, { recursive: true });
const file = join(outDir, `${label}.json`);
writeFileSync(file, JSON.stringify(result, null, 1) + '\n');
console.log(`\nrisultati: ${file}`);
if (keep) console.log(`indici e archi conservati in ${work}`); else rmSync(work, { recursive: true, force: true });
