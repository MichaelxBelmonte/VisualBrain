// HTTP + WebSocket server: API, static UI, live events, terminals, filesystem watcher.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs';
import { join, extname, basename, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Db } from './db.ts';
import { PROJECT_ROOT, savePreferences, type Config } from './config.ts';
import { GraphCache } from './cache.ts';
import { TerminalService } from './terminal-service.ts';
import { replayState } from './terminals.ts';
import { Teams } from './team.ts';
import { Updater } from './updater.ts';
import { folderAccess } from './access.ts';
import { startTeamWatch } from './team-watch.ts';
import { stopHarnessInstalls } from './harness-installer.ts';
import { graphJson, handleApi, sendJsonText, type ApiCtx } from './api.ts';
import { MegaStats } from './mega-stats.ts';
import { QuotaRouter } from './quota-router.ts';
import { mapQuery, StartupMap } from './startup-map.ts';
import { dbFileOf, runIndexOffThread } from './index-runner.ts';
import { coalesceSubtrees } from './scan.ts';
import { makeProvider } from './llm/provider.ts';
import { analyze, buildPayload } from './llm/analyze.ts';
import type { EventMessage } from '../shared/types.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.map': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json',
};

class Broadcaster {
  readonly clients = new Set<WebSocket>();
  send(msg: EventMessage): void {
    const data = JSON.stringify(msg);
    for (const c of this.clients) if (c.readyState === c.OPEN) c.send(data);
  }
}

/** Watcher: wait for a quiet period, but never longer than the cap while writes keep coming. */
const WATCH_QUIET_MS = 1200;
const WATCH_MAX_WAIT_MS = 8000;
/** More distinct subtrees than this collapse into their parents. */
const MAX_SUBTREES = 12;
/** Repaint nudge of a reattached full-screen program: the real size returns 80–400 ms after the smaller one. */
const REPAINT_MIN = 80, REPAINT_WAIT = 400;
/**
 * New, vanished or moved paths make the next pass a full one (about a minute on a large Desktop, against under a second for
 * files rewritten in place). Agents create files all the time while they work, so these wait: for a quiet spell, never sooner
 * than a gap after the last such pass, never longer than the cap. Files rewritten in place still go at once.
 */
const envMs = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return process.env[name] === undefined || !Number.isFinite(v) || v < 0 ? fallback : v;
};
const STRUCTURAL_QUIET_MS = envMs('VB_WATCH_STRUCTURAL_QUIET_MS', 20_000);
const STRUCTURAL_GAP_MS = envMs('VB_WATCH_STRUCTURAL_GAP_MS', 3 * 60_000);
const STRUCTURAL_MAX_WAIT_MS = envMs('VB_WATCH_STRUCTURAL_MAX_MS', 5 * 60_000);
/** A burst touching more paths than this is structural without looking each one up. */
const LOOKUP_LIMIT = 200;

export interface ServeOptions {
  watch: boolean;
  open: boolean;
  indexOnStart: boolean;
}

export async function startServer(cfg: Config, db: Db, opts: ServeOptions): Promise<void> {
  const cache = new GraphCache();
  // runs left «running» by a previous process can never finish: mark them so the UI does not wait for them
  db.run("UPDATE llm_runs SET status = 'error', error = 'interrotta: server riavviato', finished_at = ? WHERE status = 'running'", Date.now());
  // The version comes from the desktop shell (VISUAL_BRAIN_VERSION); a development checkout reads its package.json.
  const version = process.env.VISUAL_BRAIN_VERSION || (() => { try { return String(JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8')).version); } catch { return '0.0.0'; } })();
  const file = dbFileOf(db);
  const openStartupMap = () => file && cfg.setupComplete
    ? new StartupMap(cfg.dataDir, JSON.stringify([version, file, cfg.roots, cfg.containers, cfg.notContainers]))
    : undefined;
  const startupMap = openStartupMap();
  let preview = startupMap?.current;
  let verifiedPreview: string | undefined;
  const events = new Broadcaster();
  let mapReady = false, mapFailed = false;
  const loadMap = async () => {
    try {
      await cache.loadAsync(db, cfg);
    } catch (err) {
      mapFailed = true;
      console.error('[cache] mappa non caricata:', err instanceof Error ? err.message : err);
    }
    if (preview && !mapFailed) {
      try {
        const json = graphJson(cache, new URL('/api/graph?' + preview.query, 'http://local'));
        if (preview.json === json) verifiedPreview = preview.id;
        else startupMap?.save(preview.query, json, cache.stats);
      } catch (err) {
        console.error('[cache] verifica anteprima:', err instanceof Error ? err.message : err);
      }
      if (!verifiedPreview) events.send({ type: 'index:map', stats: cache.stats });
    }
    preview = null;
    mapReady = true;
  };
  // An existing preview lets the server open its port before SQLite starts streaming the nodes.
  let mapLoaded = preview ? undefined : loadMap();
  const teams = new Teams(cfg.dataDir);
  let terms: TerminalService;
  terms = await TerminalService.open(cfg.dataDir, cfg.port, (id, code) => {
    const nodeId = terms?.get(id)?.info.nodeId;
    if (nodeId != null) teams.release(nodeId, id);
    events.send({ type: 'term:exit', id, code });
  });
  for (const nodeId of new Set(terms.list().map(t => t.nodeId))) {
    if (nodeId != null) teams.recover(nodeId, terms.list().filter(t => t.nodeId === nodeId));
  }
  const state = { indexing: false, analyzing: false };
  const pendingPaths = new Set<string>();
  let rerun = false;
  let failures = 0;
  let backoff = 0;

  // Index passes run in a worker on their own connection. Notes and edges written from this thread retry asynchronously on
  // a busy database (api-write.ts); an analysis writes in bulk from this thread, so it and an index take turns, and what
  // arrives meanwhile is queued, never dropped.
  const drain = () => {
    if (state.indexing || state.analyzing) return;
    if (rerun) { rerun = false; pendingPaths.clear(); startIndex(); }
    else if (pendingPaths.size) { const p = coalesceSubtrees(pendingPaths, cfg.roots, MAX_SUBTREES); pendingPaths.clear(); startIndex(p); }
  };
  const startIndex = (paths?: string[]): boolean => {
    if (!cfg.setupComplete || !cfg.roots.length) return false;
    if (state.indexing || state.analyzing) {
      if (paths) for (const p of paths) pendingPaths.add(p); else rerun = true;
      return false;
    }
    state.indexing = true;
    const t0 = Date.now();
    runIndexOffThread(db, cfg, { subtrees: paths }, (p) => {
      // first start: the structure is already in the database, show the map while extraction and edges continue
      if (p.phase === 'map') {
        // this runs in the worker's message handler: a failed read must not take the server down, the map then comes at the end
        cache.loadAsync(db, cfg).then(() => events.send({ type: 'index:map', stats: cache.stats }))
          .catch((err) => console.error('[index] mappa anticipata non caricata:', err instanceof Error ? err.message : err));
        return;
      }
      events.send({ type: 'index:progress', phase: p.phase, done: p.done, total: p.total, message: p.message });
    })
      .then(async (s) => {
        failures = 0;
        await cache.loadAsync(db, cfg);   // in slices: terminals and the API keep answering while the new map loads
        events.send({ type: 'index:done', stats: cache.stats, ms: Date.now() - t0 });
        console.log(`[index] ${s.scan.seen} voci, ${s.extracted} estratti, ${s.edges} archi, ${s.ms} ms`);
      })
      .catch((err) => {
        console.error('[index] errore', err);
        // a failed pass must not lose what it was meant to cover: retry it, a couple of times at most
        // (a missing binary or a bad engine setting would fail the same way again: not retried)
        const permanent = /engine=native|vb-indexer non trovato/.test(err instanceof Error ? err.message : String(err));
        if (!permanent && ++failures <= 2) {
          if (paths) for (const p of paths) pendingPaths.add(p); else rerun = true;
          backoff = 1000 * 2 ** (failures - 1);
        }
        events.send({ type: 'index:error', error: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => {
        state.indexing = false;
        const wait = backoff;
        backoff = 0;
        if (wait) setTimeout(drain, wait); else drain();
      });
    return true;
  };

  const startAnalyze = async (consent: 'metadata' | 'excerpts'): Promise<number> => {
    const provider = makeProvider(cfg);
    if (!provider) throw new Error('nessun provider LLM configurato (llm.provider in brain.config.json)');
    if (state.indexing) throw new Error('indicizzazione in corso: riprova quando è finita');
    if (state.analyzing) throw new Error('analisi già in corso');
    state.analyzing = true;
    const runIdHolder = { id: 0 };
    analyze(db, cfg, cache, provider, consent, (m) => events.send({ type: 'analyze:progress', runId: runIdHolder.id, message: m }))
      .then(async ({ runId, summary }) => {
        await cache.loadAsync(db, cfg);
        events.send({ type: 'analyze:done', runId, summary });
        console.log(`[analyze] ${summary}`);
      })
      .catch((err) => {
        console.error('[analyze] errore', err);
        events.send({ type: 'analyze:error', runId: runIdHolder.id, error: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => { state.analyzing = false; drain(); });
    const row = db.get<{ id: number }>('SELECT MAX(id) id FROM llm_runs');
    runIdHolder.id = row?.id ?? 0;
    return runIdHolder.id;
  };

  const configure = (settings: { roots: string[]; language: 'it' | 'en'; setupComplete: boolean }) => {
    if (state.indexing || state.analyzing) throw new Error('Wait for the current scan or analysis to finish.');
    savePreferences(cfg, settings);
    resetWatchers();
    cache.load(db, cfg);
    ctx.startupMap = openStartupMap();
  };

  const updater = new Updater({ dataDir: cfg.dataDir, version, liveSessions: () => terms.list().filter(t => t.alive).length, persistentTerminals: true });
  // A folder macOS refused is mapped again as soon as the user allows it in System Settings.
  const access = folderAccess(() => cfg.setupComplete ? cfg.roots : [], () => { startIndex(); });
  let stats: MegaStats | undefined;
  try { stats = new MegaStats(join(cfg.dataDir, 'work-stats.sqlite'), () => events.send({type:'stats:changed'})); }
  catch { console.warn('[stats] Archivio locale non disponibile.'); }
  const routing = new QuotaRouter(cfg.dataDir);
  const ctx: ApiCtx = {
    db, cfg, cache, startupMap, terms, teams, updater, access, state, startIndex, startAnalyze, configure, stats, routing,
    previewAnalyze: (consent) => buildPayload(db, cfg, cache, consent),
    changed: (reason) => events.send({ type: 'graph:changed', reason }),
  };
  const heartbeat = () => stats?.capture(() => stats!.heartbeat(ctx));
  heartbeat();
  const statsTimer = setInterval(() => { heartbeat(); if(mapReady) routing.tick(ctx); }, 15_000);

  const uiDir = join(PROJECT_ROOT, 'dist', 'ui');
  const serveStatic = (req: IncomingMessage, res: ServerResponse): void => {
    let p = decodeURIComponent(new URL(req.url ?? '/', 'http://local').pathname);
    if (p === '/' || p === '') p = '/index.html';
    const file = join(uiDir, p);
    const info = file.startsWith(uiDir + sep) ? statSync(file, { bigint: true, throwIfNoEntry: false }) : undefined;
    if (!info?.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end(existsSync(uiDir) ? 'non trovato' : 'UI non compilata: esegui `npm run build:ui`');
      return;
    }
    const tag = `"${info.ino.toString(16)}-${info.ctimeNs.toString(16)}-${info.size.toString(16)}"`;
    const headers = { 'cache-control': 'no-cache', etag: 'W/' + tag };
    const matches = req.headers['if-none-match']?.split(',').some(value => {
      const candidate = value.trim();
      return candidate === '*' || candidate === tag || candidate === headers.etag;
    });
    if ((req.method === 'GET' || req.method === 'HEAD') && matches) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    res.writeHead(200, { ...headers, 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(file).pipe(res);
  };

  const trustedRequest = (req: IncomingMessage) => {
    const expected = `127.0.0.1:${cfg.port}`;
    const host = req.headers.host;
    // The 0.1 native launcher probes this exact URL with HTTP/1.0 and a
    // portless loopback Host. Keep existing installations able to start.
    const legacyProbe = req.httpVersion === '1.0' && req.method === 'GET'
      && req.url === '/api/graph?view=projects' && host === '127.0.0.1'
      && !req.headers.origin && !req.headers['sec-fetch-site'];
    if (!legacyProbe && host !== expected && host !== `localhost:${cfg.port}`) return false;
    if (req.headers['sec-fetch-site'] === 'cross-site') return false;
    const origin = req.headers.origin;
    return !origin || origin === `http://${host}`;
  };
  /** Everything but the health probe, updates, preferences and the terminal list reads the map. */
  const needsMap = (req: IncomingMessage): boolean => {
    const path = (req.url ?? '').split('?')[0];
    if (path === '/api/health' || path.startsWith('/api/update') || (path === '/api/preferences' && req.method === 'GET') || path === '/api/models') return false;
    return !(path === '/api/terminals' && req.method === 'GET');
  };
  let stopping = false;
  const server = createServer((req, res) => {
    if (!trustedRequest(req)) { res.writeHead(403); res.end('Local access only'); return; }
    stats?.watch(req, res, ctx);
    // Attachments are raw bytes; octet-stream, like JSON, is not a type a cross-site form can send without a preflight.
    const upload = req.method === 'POST' && (req.url ?? '').startsWith('/api/attachments?') && req.headers['content-type'] === 'application/octet-stream';
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'DELETE' && !upload && !req.headers['content-type']?.startsWith('application/json')) { res.writeHead(415); res.end('JSON required'); return; }
    if (stopping || (!terms.connected && req.url !== '/api/health')) { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'Servizio terminali disconnesso. Riapri Visual Brain per riconnetterti.' })); return; }
    if ((req.url ?? '').startsWith('/api/')) {
      if (preview && req.method === 'GET') {
        const url = new URL(req.url!, 'http://local');
        if (url.pathname === '/api/status' || (url.pathname === '/api/graph' && mapQuery(url) === preview.query)) {
          if (url.pathname === '/api/graph') startupMap?.select(preview.query, req.headers['x-vb-startup-map'] === '1');
          void handleApi(ctx, req, res, preview);
          return;
        }
      }
      if (!needsMap(req)) { void handleApi(ctx, req, res); return; }
      const respond = () => {
        if (mapFailed) sendJsonText(res, 503, JSON.stringify({ error: 'Mappa non disponibile.' }));
        else void handleApi(ctx, req, res);
      };
      if (mapReady) respond(); else void mapLoaded!.then(respond);
    } else serveStatic(req, res);
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (!trustedRequest(req)) { socket.destroy(); return; }
    const url = new URL(req.url ?? '/', 'http://local');
    if (url.pathname === '/ws/events') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        events.clients.add(ws);
        // The canvas opens its socket after the first response. Replay a correction it may have missed.
        const clientPreview = url.searchParams.get('preview');
        if (clientPreview && clientPreview !== (preview?.id ?? verifiedPreview)) {
          ws.send(JSON.stringify({ type: 'index:map', stats: cache.stats } satisfies EventMessage));
        }
        ws.on('close', () => events.clients.delete(ws));
      });
    } else if (url.pathname === '/ws/term') {
      const id = url.searchParams.get('id') ?? '';
      const term = terms.get(id);
      if (!term) { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws) => {
        const replay = replayState(term.buffer);
        if (replay.prefix) ws.send(replay.prefix);
        for (const chunk of term.buffer) ws.send(chunk);
        // Set while a repaint nudge waits for the program to answer the smaller size (see below).
        let restore: (() => void) | null = null;
        const listener = (data: string) => { if (ws.readyState === ws.OPEN) ws.send(data); restore?.(); };
        term.listeners.add(listener);
        // The kept output of a full-screen program is a tail of screen diffs, not a whole screen: on the first size
        // the client sends, a one-row nudge makes the program redraw everything (a same-size resize signals nothing).
        // The real size goes back only once the program has answered the smaller one (its first output), or after
        // REPAINT_WAIT: two resizes that both arrive while the program is busy merge into one SIGWINCH, which then
        // reports the unchanged size and nothing is redrawn.
        let repaint = replay.fullScreen, size = { cols: 0, rows: 0 };
        ws.on('message', (raw) => {
          if (stopping) return;
          try {
            const m = JSON.parse(String(raw));
            if (m.type === 'input') terms.write(id, String(m.data));
            else if (m.type === 'resize') {
              size = { cols: Number(m.cols), rows: Number(m.rows) };
              if (!repaint || size.rows < 3) { terms.resize(id, size.cols, size.rows); return; }
              repaint = false;
              let done = false;
              const back = () => { if (done) return; done = true; restore = null; clearTimeout(timer); if (!stopping && terms.get(id)?.info.alive) terms.resize(id, size.cols, size.rows); };
              const start = Date.now(), timer = setTimeout(back, REPAINT_WAIT);
              // Output may also be unrelated (a spinner): never earlier than REPAINT_MIN, as before; a pause lets the redraw finish.
              restore = () => setTimeout(back, Math.max(20, REPAINT_MIN - (Date.now() - start)));
              terms.resize(id, size.cols, size.rows - 1);
            }
          } catch { /* ignore */ }
        });
        ws.on('close', () => term.listeners.delete(listener));
      });
    } else {
      socket.destroy();
    }
  });

  // filesystem watcher: each burst of events becomes a few targeted paths (a file, a folder, or a vanished path),
  // collected after a quiet period; events that arrive while an index runs are queued by startIndex, never dropped
  const watchers: FSWatcher[] = [];
  let watchTimer: NodeJS.Timeout | null = null;
  let firstTouch = 0;
  const touched = new Set<string>();
  const structural = new Set<string>();
  let structuralTimer: NodeJS.Timeout | null = null;
  let structuralFirst = 0;
  let lastStructuralRun = 0;
  const flushStructural = () => {
    structuralTimer = null;
    structuralFirst = 0;
    const paths = coalesceSubtrees(structural, cfg.roots, MAX_SUBTREES);
    structural.clear();
    lastStructuralRun = Date.now();
    if (paths.length) startIndex(paths);
  };
  const known = db.prepare('SELECT kind FROM nodes WHERE path = ? AND deleted = 0');
  const flushTouched = () => {
    watchTimer = null;
    firstTouch = 0;
    const inPlace = new Set<string>();
    let deferred = 0;
    for (const p of touched) {
      if (touched.size > LOOKUP_LIMIT) { structural.add(p); deferred++; continue; }
      let isFile: boolean | null;
      try { isFile = statSync(p).isFile(); } catch { isFile = null; }
      const kind = (known.get(p) as { kind: string } | undefined)?.kind;
      if (isFile === null && kind === undefined) continue;   // came and went (an editor's temporary file): nothing to index
      if (isFile && kind === 'file') inPlace.add(p); else { structural.add(p); deferred++; }
    }
    touched.clear();
    if (inPlace.size) startIndex(coalesceSubtrees(inPlace, cfg.roots, MAX_SUBTREES));
    if (!deferred) return;
    const now = Date.now();
    if (!structuralFirst) structuralFirst = now;
    const at = Math.min(Math.max(now + STRUCTURAL_QUIET_MS, lastStructuralRun + STRUCTURAL_GAP_MS), structuralFirst + STRUCTURAL_MAX_WAIT_MS);
    if (structuralTimer) clearTimeout(structuralTimer);
    structuralTimer = setTimeout(flushStructural, Math.max(0, at - now));
  };
  const resetWatchers = () => {
    for (const w of watchers.splice(0)) w.close();
    if (watchTimer) clearTimeout(watchTimer);
    if (structuralTimer) clearTimeout(structuralTimer);
    watchTimer = structuralTimer = null;
    touched.clear(); structural.clear();
    firstTouch = structuralFirst = 0;
    if (!opts.watch || !cfg.setupComplete) return;
    const skip = new Set([...cfg.vendorNames, ...cfg.excludeNames]);
    for (const root of cfg.roots) {
      try {
        const w = watch(root, { recursive: true }, (_ev, filename) => {
          if (!filename) return;
          const rel = String(filename);
          const segs = rel.split('/');
          if (segs.some((s) => skip.has(s))) return;
          const full = join(root, rel);
          if (cfg.excludePaths.some((x) => full === x || full.startsWith(x + '/'))) return;
          if (basename(rel) === '.DS_Store') return;
          touched.add(full);
          const now = Date.now();
          if (!firstTouch) firstTouch = now;
          if (watchTimer) clearTimeout(watchTimer);
          watchTimer = setTimeout(flushTouched, Math.max(0, Math.min(WATCH_QUIET_MS, firstTouch + WATCH_MAX_WAIT_MS - now)));
        });
        w.on('error', (err) => console.error('[watch] errore su', root, err));
        watchers.push(w);
      } catch (err) {
        console.error('[watch] non attivo su', root, err);
      }
    }
  };
  resetWatchers();

  if (!mapLoaded) {
    mapLoaded = new Promise<void>(resolve => server.once('listening', () => setImmediate(resolve))).then(loadMap);
  }
  try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(cfg.port, cfg.host, resolve); }); }
  catch (error) { await terms.detach(); throw error; }
  updater.start();
  const stopTeamWatch = startTeamWatch(ctx);
  const url = `http://${cfg.host}:${cfg.port}`;
  console.log(`Visual Brain: ${url}`);
  // an empty index is only known once the map has loaded
  void mapLoaded.then(() => {
    if (mapFailed) return;
    console.log(`[cache] mappa: nodi ${cache.stats.nodes}, archi ${cache.stats.edges}, ${cache.loadedAt} ms`);
    if (cfg.setupComplete && cfg.roots.length && (opts.indexOnStart || cache.stats.nodes === 0)) startIndex();
  });
  if (opts.open) spawn('open', [url], { stdio: 'ignore', detached: true }).unref();

  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    updater.stop();
    clearInterval(statsTimer); stats?.close();
    stopTeamWatch();
    stopHarnessInstalls();
    server.close();
    for (const client of wss.clients) client.close(1012, 'Server restarting');
    // Flush coordination metadata, then detach. The separate host keeps the PTYs and their agent processes alive.
    try { await terms.detach(); } catch (error) { console.error('[terminal-service] detach:', error instanceof Error ? error.message : String(error)); }
    for (const w of watchers) w.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
