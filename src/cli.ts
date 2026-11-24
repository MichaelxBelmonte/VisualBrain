// Command line: vb index | serve | stats | analyze | compact | help
import { dirname, join } from 'node:path';
import { existsSync, statSync, statfsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { loadConfig, parseEngine, PROJECT_ROOT } from './server/config.ts';
import { findNativeBinary } from './server/native-indexer.ts';
import { Db } from './server/db.ts';
import { runIndex } from './server/index.ts';
import { startServer } from './server/server.ts';
import { GraphCache } from './server/cache.ts';
import { makeProvider } from './server/llm/provider.ts';
import { analyze, buildPayload } from './server/llm/analyze.ts';

interface Flags { roots: string[]; port?: number; db?: string; watch: boolean; watchUi: boolean; open: boolean; consent: 'metadata' | 'excerpts'; dryRun: boolean; model?: string; provider?: string; subtrees: string[]; index: boolean; reextract: boolean; engine?: string; dropGone?: boolean }

function parse(argv: string[]): { cmd: string; flags: Flags } {
  const flags: Flags = { roots: [], watch: true, watchUi: false, open: false, consent: 'metadata', dryRun: false, subtrees: [], index: false, reextract: false };
  let cmd = 'help';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (!a.startsWith('--') && cmd === 'help') { cmd = a; continue; }
    switch (a) {
      case '--root': flags.roots.push(next()); break;
      case '--port': flags.port = Number(next()); break;
      case '--db': flags.db = next(); break;
      case '--no-watch': flags.watch = false; break;
      case '--watch-ui': flags.watchUi = true; break;
      case '--open': flags.open = true; break;
      case '--index': flags.index = true; break;
      case '--reextract': flags.reextract = true; break;
      case '--consent': flags.consent = next() === 'excerpts' ? 'excerpts' : 'metadata'; break;
      case '--dry-run': flags.dryRun = true; break;
      case '--model': flags.model = next(); break;
      case '--provider': flags.provider = next(); break;
      case '--subtree': flags.subtrees.push(next()); break;
      case '--engine': flags.engine = next(); break;
      case '--drop-gone': flags.dropGone = true; break;
      default: console.error(`opzione sconosciuta: ${a}`); process.exit(2);
    }
  }
  return { cmd, flags };
}

const HELP = `vb — Visual Brain

  vb index   [--root DIR]... [--subtree DIR]... [--reextract]   indicizza (tutto, o solo i sottoalberi dati; --reextract rilegge i contenuti)
  vb serve   [--port N] [--no-watch] [--watch-ui] [--open] [--index]   avvia il server (http://127.0.0.1:4747)
  vb stats                                        numeri dell'indice
  vb analyze [--consent metadata|excerpts] [--dry-run] [--model M] [--provider P]   analisi semantica con l'LLM
  vb compact [--drop-gone]                        toglie le voci dei percorsi spariti e rimpicciolisce il database (con Visual Brain chiuso)

  --root DIR   radice da indicizzare (ripetibile; predefinita: ~/Desktop)
  --db FILE    file SQLite (predefinito: data/brain.db)
  --engine E   motore di indicizzazione: ts (predefinito), native, auto (nativo se presente, altrimenti ts); anche VB_ENGINE
  --drop-gone  con compact: toglie subito le voci sparite, senza aspettare 7 giorni (file) o 90 (cartelle); restano quelle con note, promemoria o collegamenti fatti a mano
`;

/**
 * `vb compact`: removes the rows of vanished paths that are due, then rewrites the database without its free pages.
 * The rewrite needs the file to itself, so it first asks SQLite for it: with Visual Brain (or anything else) connected to
 * the same database the answer is no, and the command stops before changing anything.
 */
function compact(file: string, dropGone: boolean): void {
  const stop = (message: string): never => { console.error(message); process.exit(1); };
  const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;
  if (!existsSync(file)) stop(`Database non trovato: ${file}`);
  const alone = (raw: DatabaseSync): boolean => {
    try {
      raw.exec('PRAGMA busy_timeout = 0');
      raw.prepare('PRAGMA locking_mode = EXCLUSIVE').get();
      raw.prepare('SELECT COUNT(*) FROM sqlite_master').get();   // the first access takes the file, or fails if someone else has it
      return true;
    } catch { return false; }
  };
  const inUse = 'Il database è in uso: chiudi Visual Brain (⌘Q) e riprova. Nulla è stato modificato.';
  const probe = new DatabaseSync(file);
  const free = alone(probe);
  probe.close();
  if (!free) stop(inUse);
  const db = new Db(file);
  if (!alone(db.raw)) { db.close(); stop(inUse); }
  const size = () => statSync(file).size + (existsSync(file + '-wal') ? statSync(file + '-wal').size : 0);
  const before = size();
  let t = Date.now();
  const removed = dropGone ? db.pruneDeleted(Date.now(), 0, 0) : db.pruneDeleted();
  console.log(`Voci di percorsi spariti tolte: ${removed.toLocaleString('it-IT')} (${Date.now() - t} ms)${dropGone ? '' : '. Con --drop-gone escono subito anche quelle ancora in attesa.'}`);
  const space = db.space();
  const live = (space.pages - space.free) * space.pageSize;
  const disk = statfsSync(dirname(file));
  const available = Number(disk.bavail) * Number(disk.bsize);
  // SQLite writes a second copy of the live data and then copies it back through the log: twice the live size, to be safe
  if (available < live * 2) { db.close(); stop(`Spazio libero insufficiente per riscrivere il file: servono circa ${mb(live * 2)}, ce ne sono ${mb(available)}. Le voci sono state tolte, il file non è stato rimpicciolito.`); }
  console.log(`Prima: ${mb(before)}, pagine libere ${Math.round(100 * space.free / Math.max(1, space.pages))}%.`);
  t = Date.now();
  db.compact();
  db.close();
  const after = size();
  console.log(`Dopo:  ${mb(after)} (${mb(before - after)} in meno, ${Date.now() - t} ms).`);
}

async function main(): Promise<void> {
  const { cmd, flags } = parse(process.argv.slice(2));
  const cfg = loadConfig();
  if (flags.roots.length) cfg.roots = flags.roots.map((r) => (r.startsWith('/') ? r : join(process.cwd(), r)));
  if (flags.port) cfg.port = flags.port;
  if (flags.engine) {
    if (!['ts', 'native', 'auto'].includes(flags.engine)) { console.error(`motore sconosciuto: ${flags.engine} (ts, native, auto)`); process.exit(2); }
    cfg.engine = parseEngine(flags.engine);
  }
  if (flags.model) cfg.llm.model = flags.model;
  if (flags.provider) cfg.llm.provider = flags.provider as typeof cfg.llm.provider;
  const dbFile = flags.db ?? join(cfg.dataDir, 'brain.db');
  const log = (m: string) => process.stderr.write(m + '\n');

  switch (cmd) {
    case 'index': {
      const db = new Db(dbFile);
      log(`motore: ${cfg.engine}${cfg.engine !== 'ts' ? ` (nativo ${findNativeBinary() ?? 'non trovato'})` : ''}`);
      let lastPhase = '';
      const s = await runIndex(db, cfg, { subtrees: flags.subtrees.length ? flags.subtrees : undefined, reextract: flags.reextract }, (p) => {
        if (p.message) log(`[${p.phase}] ${p.message}`);
        else if (p.phase !== lastPhase || p.done % 10000 === 0) { lastPhase = p.phase; log(`[${p.phase}] ${p.done}${p.total ? '/' + p.total : ''}`); }
      });
      const cache = new GraphCache();
      cache.load(db, cfg);
      log(`fatto in ${s.ms} ms: ${cache.stats.nodes} nodi (${cache.stats.files} file, ${cache.stats.dirs} cartelle), ${cache.stats.edges} archi (${cache.stats.verifiedEdges} verificati, ${cache.stats.inferredEdges} inferiti), ${cache.stats.projects} progetti`);
      db.close();
      break;
    }
    case 'serve': {
      if (flags.watchUi) {
        const child = spawn(process.execPath, [join(PROJECT_ROOT, 'scripts', 'build-ui.mjs'), '--watch'], { stdio: 'inherit' });
        process.on('exit', () => child.kill());
      }
      const db = new Db(dbFile);
      await startServer(cfg, db, { watch: flags.watch, open: flags.open, indexOnStart: flags.index });
      break;
    }
    case 'stats': {
      const db = new Db(dbFile);
      const cache = new GraphCache();
      cache.load(db, cfg);
      console.log(JSON.stringify(cache.stats, null, 2));
      const kinds = db.all<{ kind: string; n: number; v: number }>('SELECT kind, COUNT(*) n, SUM(verified) v FROM edges WHERE hidden = 0 GROUP BY kind ORDER BY n DESC');
      for (const k of kinds) console.log(`  ${k.kind.padEnd(10)} ${String(k.n).padStart(7)}  verificati ${k.v}`);
      db.close();
      break;
    }
    case 'analyze': {
      const db = new Db(dbFile);
      const cache = new GraphCache();
      cache.load(db, cfg);
      if (flags.dryRun) {
        const p = buildPayload(db, cfg, cache, flags.consent);
        log(`unità: ${p.nodes}, byte: ${p.bytes}, consenso: ${flags.consent}`);
        console.log(p.payload);
        db.close();
        break;
      }
      const provider = makeProvider(cfg);
      if (!provider) { log('nessun provider LLM configurato'); process.exit(1); }
      const r = await analyze(db, cfg, cache, provider, flags.consent, log);
      log(`run ${r.runId}: ${r.summary}`);
      db.close();
      break;
    }
    case 'compact':
      compact(dbFile, flags.dropGone === true);
      break;
    default:
      console.log(HELP);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
