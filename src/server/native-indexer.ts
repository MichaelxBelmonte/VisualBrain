// Bridge to the optional Rust indexer (`vb-indexer walk`): one JSON request on stdin, NDJSON on stdout.
// The TypeScript walk stays the reference: every failure here is reported so the caller can fall back to it.
import { spawn } from 'node:child_process';
import { existsSync, accessSync, constants } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { PROJECT_ROOT, type Config } from './config.ts';
import type { Entry, Progress } from './scan.ts';

export const NATIVE_PROTOCOL = 1;

export class NativeUnavailable extends Error {}

/** Where the binary may live: explicit override, packaged runtime, then the local build output. */
export function nativeCandidates(): string[] {
  const arch = process.arch;
  return [
    process.env.VB_NATIVE_INDEXER,
    join(PROJECT_ROOT, '..', 'bin', `vb-indexer-${arch}`),
    join(PROJECT_ROOT, 'bin', `vb-indexer-${arch}`),
    join(PROJECT_ROOT, 'native', 'indexer', 'bin', `darwin-${arch}`, 'vb-indexer'),
    join(PROJECT_ROOT, 'native', 'indexer', 'target', 'release', 'vb-indexer'),
  ].filter((p): p is string => !!p);
}

function executable(file: string): boolean {
  try { accessSync(file, constants.X_OK); return true; } catch { return false; }
}

export function findNativeBinary(): string | null {
  return nativeCandidates().find((p) => existsSync(p) && executable(p)) ?? null;
}

/** True when this run should try the native engine. `native` fails loudly if the binary is missing; `auto` stays silent. */
export function wantsNative(cfg: Pick<Config, 'engine'>): boolean {
  if (cfg.engine === 'ts') return false;
  if (findNativeBinary()) return true;
  if (cfg.engine === 'native') throw new NativeUnavailable(`engine=native ma vb-indexer non trovato (cercato in: ${nativeCandidates().join(', ')})`);
  return false;
}

/** A run that produces no output for this long is killed (the 100k-entry Desktop walk takes about a second). */
const nativeTimeoutMs = (): number => (Number(process.env.VB_NATIVE_TIMEOUT_MS) > 0 ? Number(process.env.VB_NATIVE_TIMEOUT_MS) : 5 * 60_000);
/** An NDJSON line longer than this is a malformed stream, not an entry. */
const MAX_LINE_BYTES = 1 << 20;

type Line = { t?: string; count?: number; ms?: number; done?: number; message?: string; [k: string]: unknown };

/** Spawns `vb-indexer <command>` and feeds every NDJSON line to `onLine`; rejects on spawn errors and non-zero exit. */
function runNative(command: string, request: object, onLine: (m: Line) => void): Promise<void> {
  const bin = findNativeBinary();
  if (!bin) return Promise.reject(new NativeUnavailable('vb-indexer non trovato'));
  return new Promise<void>((resolve, reject) => {
    const child = spawn(bin, [command], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    let err = '';
    let bad: Error | null = null;
    const fail = (e: Error) => { if (!bad) { bad = e; child.kill('SIGKILL'); } };
    const limit = nativeTimeoutMs();
    let timer = setTimeout(() => fail(new Error(`vb-indexer ${command}: nessuna risposta dopo ${limit} ms`)), limit);
    const rearm = () => { clearTimeout(timer); timer = setTimeout(() => fail(new Error(`vb-indexer ${command}: nessuna risposta dopo ${limit} ms`)), limit); };
    const line = (raw: string) => {
      if (!raw.trim() || bad) return;
      let m: Line;
      try { m = JSON.parse(raw); } catch { fail(new Error('vb-indexer: riga JSON non valida')); return; }
      if (m === null || typeof m !== 'object' || Array.isArray(m)) { fail(new Error('vb-indexer: riga non è un oggetto')); return; }
      try { onLine(m); } catch (e) { fail(e instanceof Error ? e : new Error(String(e))); }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      rearm();
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); line(l); }
      if (buf.length > MAX_LINE_BYTES) { buf = ''; fail(new Error('vb-indexer: riga troppo lunga')); }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => { if (err.length < 4000) err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(new NativeUnavailable(e.message)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      line(buf);
      if (bad) reject(bad);
      else if (code === 0) resolve();
      else reject(new Error(`vb-indexer ${command} terminato con codice ${code}${err ? `: ${err.trim().slice(0, 500)}` : ''}`));
    });
    child.stdin.on('error', () => { /* the child exited early: reported by 'close' */ });
    child.stdin.end(JSON.stringify(request));
  });
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const STAT_KEYS = ['files', 'bytes', 'childCount', 'dataFiles', 'mediaFiles', 'codeFiles', 'docFiles'] as const;

/** Rejects anything the TypeScript walk could not have produced: the index is only written from checked entries. */
export function validateEntry(m: Record<string, unknown>, ctx: { cfg: Config; roots: string[]; seen: Set<string> }): Entry {
  const bad = (why: string): never => { throw new Error(`vb-indexer: voce non valida (${why}): ${String(m.path).slice(0, 200)}`); };
  const path = m.path;
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) return bad('path');
  const root = ctx.roots.find((r) => path === r || path.startsWith(r + '/'));
  if (!root) return bad('fuori dalle radici richieste');
  if (ctx.cfg.excludePaths.some((x) => path === x || path.startsWith(x + '/'))) return bad('percorso escluso');
  if (path.slice(root.length).split('/').some((seg) => ctx.cfg.excludeNames.includes(seg))) return bad('nome escluso');
  if (ctx.seen.has(path)) return bad('duplicata');
  const kind = m.kind;
  if (kind !== 'file' && kind !== 'dir' && kind !== 'symlink') return bad('kind');
  if (typeof m.name !== 'string' || !m.name) return bad('name');
  if (typeof m.ext !== 'string' || typeof m.cls !== 'string' || !m.cls) return bad('ext/cls');
  if (m.lang !== null && typeof m.lang !== 'string') return bad('lang');
  if (!finite(m.size) || m.size < 0 || !finite(m.mtime) || !finite(m.inode) || !finite(m.depth) || !Number.isInteger(m.depth) || m.depth < 0) return bad('numeri');
  if (m.depth !== path.split('/').length - 1) return bad('depth');
  if (m.aggregate !== 0 && m.aggregate !== 1) return bad('aggregate');
  if (m.linkTarget !== null && typeof m.linkTarget !== 'string') return bad('linkTarget');
  if ((kind === 'symlink') !== (m.linkTarget !== null)) return bad('linkTarget/kind');
  // a parent is the directory above, already seen in this stream (parents come first); a requested root may hang from outside
  const configured = ctx.cfg.roots.includes(path);
  if (configured ? m.parent !== null : m.parent !== dirname(path)) return bad('parent');
  if (m.parent !== null && !ctx.seen.has(m.parent as string) && !ctx.roots.includes(path)) return bad('parent dopo il figlio');
  if (kind === 'dir') {
    const st = m.stats as Record<string, unknown> | null;
    if (!st || typeof st !== 'object' || STAT_KEYS.some((k) => !finite(st[k]) || (st[k] as number) < 0) || !Array.isArray(st.markers) || st.markers.some((x) => typeof x !== 'string')) return bad('stats');
  } else if (m.stats !== null) return bad('stats su non-cartella');
  ctx.seen.add(path);
  return m as unknown as Entry;
}

/**
 * Walks `roots` with the native binary. Resolves null when the engine says `ts` or (in `auto`) the native run failed;
 * in `native` mode a failure is thrown instead. The entry stream is accepted only if its `end` line matches what was received.
 */
export async function nativeWalk(cfg: Config, roots: string[], progress?: Progress): Promise<Entry[] | null> {
  if (!wantsNative(cfg)) return null;
  try {
    const entries: Entry[] = [];
    const seen = new Set<string>();
    const wanted = roots;
    let end: Line | null = null;
    await runNative('walk', {
      protocol: NATIVE_PROTOCOL,
      roots,
      configuredRoots: cfg.roots,
      excludePaths: cfg.excludePaths,
      excludeNames: cfg.excludeNames,
      vendorNames: cfg.vendorNames,
      secretPatterns: cfg.secretPatterns,
      dumpMinFiles: cfg.dumpMinFiles,
      dumpDataShare: cfg.dumpDataShare,
      threads: 4,
    }, (m) => {
      if (end) throw new Error('vb-indexer: dati dopo la riga end');
      if (m.t === 'entry') {
        const { t: _t, ...e } = m;
        entries.push(validateEntry(e, { cfg, roots: wanted, seen }));
      } else if (m.t === 'progress') progress?.({ phase: 'scan', done: Number(m.done ?? entries.length) });
      else if (m.t === 'end') end = m;
      else if (m.t === 'error') throw new Error(String(m.message ?? 'errore nativo'));
    });
    if (!end) throw new Error('vb-indexer: flusso senza riga end');
    // every requested root that the walk would enter must come back as a directory: an empty stream with a clean `end`
    // would otherwise read as "everything was deleted"
    const dirs = new Set(entries.filter((e) => e.kind === 'dir').map((e) => e.path));
    for (const r of roots) {
      const skipped = cfg.excludePaths.includes(r) || cfg.excludeNames.includes(r.slice(r.lastIndexOf('/') + 1));
      if (!skipped && !dirs.has(r)) throw new Error(`vb-indexer: manca la voce della radice ${r}`);
    }
    if ((end as Line).count !== entries.length) throw new Error(`vb-indexer: ${entries.length} voci ricevute, ${(end as Line).count} dichiarate`);
    return entries;
  } catch (e) {
    if (cfg.engine === 'native') throw e;
    console.error(`[engine] scansione nativa non riuscita, uso TypeScript: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}
