// Extraction on worker threads must give the same index as extraction on the calling thread: same hashes, terms,
// references (in the same order), identifiers and edges. Also covers the inline path for small trees and VB_EXTRACT_WORKERS.
// Uso: node scripts/test-extract-parallel.mjs [--files N] — corpus sintetico e database temporanei, nessun dato reale.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS } from '../src/server/config.ts';
import { Db } from '../src/server/db.ts';
import { runIndex } from '../src/server/index.ts';
import { extractWorkers } from '../src/server/extract-pool.ts';
import { generateCorpus } from '../tests/indexing/corpus.mjs';

const FILES = Number(process.argv[process.argv.indexOf('--files') + 1]) || 4000;
const tmp = mkdtempSync(join(tmpdir(), 'vb-xpar-'));
let checks = 0;
const eq = (a, b, m) => { checks++; assert.deepEqual(a, b, m); };
const ok = (c, m) => { checks++; assert.ok(c, m); };

const root = join(tmp, 'corpus');
generateCorpus(root, { files: FILES, seed: 3 });

async function build(name, workers, dir = root) {
  process.env.VB_EXTRACT_WORKERS = String(workers);
  const db = new Db(join(tmp, `${name}.db`));
  const cfg = structuredClone(DEFAULTS);
  Object.assign(cfg, { roots: [dir], dataDir: join(tmp, 'profile'), engine: 'ts', excludePaths: [], setupComplete: true, desktopMode: false, llm: { ...cfg.llm, provider: 'none' } });
  const t = performance.now();
  const summary = await runIndex(db, cfg);
  return { db, ms: performance.now() - t, summary };
}

/** The index as facts keyed by path, so the comparison does not depend on node ids. */
function dump(db) {
  const path = new Map(db.all('SELECT id, path FROM nodes').map((r) => [r.id, r.path]));
  return {
    nodes: db.all("SELECT path, kind, cls, hash, lines, complexity, terms, extracted FROM nodes WHERE deleted = 0 ORDER BY path"),
    // node ids follow the asynchronous walk, so files are compared by path; inside a file the order must be the same
    refs: db.all('SELECT node_id, kind, target, line, snippet, relative_to FROM refs ORDER BY rowid').map((r) => ({ ...r, node_id: path.get(r.node_id) }))
      .map((r, i) => [r, i]).sort((x, y) => (x[0].node_id < y[0].node_id ? -1 : x[0].node_id > y[0].node_id ? 1 : x[1] - y[1])).map(([r]) => r),
    identifiers: db.all('SELECT token, node_id, line FROM identifiers').map((r) => `${r.token}\t${path.get(r.node_id)}\t${r.line}`).sort(),
    edges: db.all('SELECT src, dst, kind, verified, confidence, evidence, origin, hidden, count FROM edges')
      .map((e) => JSON.stringify({ ...e, src: path.get(e.src), dst: path.get(e.dst) })).sort(),
  };
}

try {
  const inline = await build('inline', 0);
  const pooled = await build('pool', 4);
  const a = dump(inline.db), b = dump(pooled.db);
  ok(a.refs.length > 1000 && a.edges.length > 100, `corpus is meaningful (${a.refs.length} refs, ${a.identifiers.length} identifiers, ${a.edges.length} edges)`);
  eq(b.nodes.length, a.nodes.length, 'same nodes');
  eq(b.nodes, a.nodes, 'same hashes, lines, complexity and terms per file');
  eq(b.refs, a.refs, 'same references, in the same order');
  eq(b.identifiers, a.identifiers, 'same identifiers');
  eq(b.edges, a.edges, 'same edges');
  eq(pooled.summary.extracted, inline.summary.extracted, 'same number of extracted files');
  const xa = inline.summary.phases.find((p) => p.phase === 'extract'), xb = pooled.summary.phases.find((p) => p.phase === 'extract');
  console.log(`extract: inline ${Math.round(xa?.ms ?? 0)} ms, 4 workers ${Math.round(xb?.ms ?? 0)} ms; whole index ${Math.round(inline.ms)} -> ${Math.round(pooled.ms)} ms (${FILES} files)`);
  inline.db.close(); pooled.db.close();

  // a small tree stays on the calling thread and still indexes the same way
  const small = join(tmp, 'small');
  mkdirSync(small);
  writeFileSync(join(small, 'a.md'), '# A\nSee [b](b.md) and ticket ABC-1234.\n');
  writeFileSync(join(small, 'b.md'), '# B\nBack to a.md, ticket ABC-1234.\n');
  const s0 = await build('small-inline', 0, small), s4 = await build('small-pool', 4, small);
  eq(dump(s4.db), dump(s0.db), 'small tree: same index with and without the pool setting');
  s0.db.close(); s4.db.close();

  process.env.VB_EXTRACT_WORKERS = '3'; eq(extractWorkers(), 3, 'VB_EXTRACT_WORKERS sets the pool size');
  process.env.VB_EXTRACT_WORKERS = 'x'; eq(extractWorkers(), 0, 'an invalid value falls back to the calling thread');
  delete process.env.VB_EXTRACT_WORKERS; ok(extractWorkers() >= 1 && extractWorkers() <= 4, 'default is 1..4 workers');
  console.log(`PASS extraction on workers matches the calling thread (${checks} checks)`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
