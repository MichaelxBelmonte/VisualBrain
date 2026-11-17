// HTTP + WebSocket server: API, static UI, live events, terminals, filesystem watcher.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync, watch, type FSWatcher } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Db } from './db.ts';
import { PROJECT_ROOT, savePreferences, type Config } from './config.ts';
import { GraphCache } from './cache.ts';
import { Terminals } from './terminals.ts';
import { Teams } from './team.ts';
import { handleApi, type ApiCtx } from './api.ts';
import { runIndex } from './index.ts';
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

export interface ServeOptions {
  watch: boolean;
  open: boolean;
  indexOnStart: boolean;
}

export async function startServer(cfg: Config, db: Db, opts: ServeOptions): Promise<void> {
  const cache = new GraphCache();
  // runs left «running» by a previous process can never finish: mark them so the UI does not wait for them
  db.run("UPDATE llm_runs SET status = 'error', error = 'interrotta: server riavviato', finished_at = ? WHERE status = 'running'", Date.now());
  cache.load(db, cfg);
  const events = new Broadcaster();
  const teams = new Teams(cfg.dataDir);
  const terms = new Terminals((id, code) => {
    const nodeId = terms.get(id)?.info.nodeId;
    if (nodeId != null) teams.release(nodeId, id);
    events.send({ type: 'term:exit', id, code });
  });
  const state = { indexing: false, analyzing: false };
  const pendingPaths = new Set<string>();
  let rerun = false;

  const startIndex = (paths?: string[]): boolean => {
    if (!cfg.setupComplete || !cfg.roots.length) return false;
    if (state.indexing) {
      if (paths) for (const p of paths) pendingPaths.add(p); else rerun = true;
      return false;
    }
    state.indexing = true;
    const t0 = Date.now();
    runIndex(db, cfg, { subtrees: paths }, (p) => events.send({ type: 'index:progress', phase: p.phase, done: p.done, total: p.total, message: p.message }))
      .then((s) => {
        cache.load(db, cfg);
        events.send({ type: 'index:done', stats: cache.stats, ms: Date.now() - t0 });
        console.log(`[index] ${s.scan.seen} voci, ${s.extracted} estratti, ${s.edges} archi, ${s.ms} ms`);
      })
      .catch((err) => {
        console.error('[index] errore', err);
        events.send({ type: 'index:error', error: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => {
        state.indexing = false;
        if (rerun) { rerun = false; pendingPaths.clear(); startIndex(); }
        else if (pendingPaths.size) { const p = [...pendingPaths]; pendingPaths.clear(); startIndex(p); }
      });
    return true;
  };

  const startAnalyze = async (consent: 'metadata' | 'excerpts'): Promise<number> => {
    const provider = makeProvider(cfg);
    if (!provider) throw new Error('nessun provider LLM configurato (llm.provider in brain.config.json)');
    state.analyzing = true;
    const runIdHolder = { id: 0 };
    analyze(db, cfg, cache, provider, consent, (m) => events.send({ type: 'analyze:progress', runId: runIdHolder.id, message: m }))
      .then(({ runId, summary }) => {
        cache.load(db, cfg);
        events.send({ type: 'analyze:done', runId, summary });
        console.log(`[analyze] ${summary}`);
      })
      .catch((err) => {
        console.error('[analyze] errore', err);
        events.send({ type: 'analyze:error', runId: runIdHolder.id, error: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => { state.analyzing = false; });
    const row = db.get<{ id: number }>('SELECT MAX(id) id FROM llm_runs');
    runIdHolder.id = row?.id ?? 0;
    return runIdHolder.id;
  };

  const configure = (settings: { roots: string[]; language: 'it' | 'en'; setupComplete: boolean }) => {
    if (state.indexing || state.analyzing) throw new Error('Wait for the current scan or analysis to finish.');
    savePreferences(cfg, settings);
    resetWatchers();
    cache.load(db, cfg);
  };

  const ctx: ApiCtx = {
    db, cfg, cache, terms, teams, state, startIndex, startAnalyze, configure,
    previewAnalyze: (consent) => buildPayload(db, cfg, cache, consent),
    changed: (reason) => events.send({ type: 'graph:changed', reason }),
  };

  const uiDir = join(PROJECT_ROOT, 'dist', 'ui');
  const serveStatic = (req: IncomingMessage, res: ServerResponse): void => {
    let p = decodeURIComponent(new URL(req.url ?? '/', 'http://local').pathname);
    if (p === '/' || p === '') p = '/index.html';
    const file = join(uiDir, p);
    if (!file.startsWith(uiDir) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end(existsSync(uiDir) ? 'non trovato' : 'UI non compilata: esegui `npm run build:ui`');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    createReadStream(file).pipe(res);
  };

  const trustedRequest = (req: IncomingMessage) => {
    const expected = `127.0.0.1:${cfg.port}`;
    const host = req.headers.host;
    if (host !== expected && host !== `localhost:${cfg.port}`) return false;
    if (req.headers['sec-fetch-site'] === 'cross-site') return false;
    const origin = req.headers.origin;
    return !origin || origin === `http://${host}`;
  };
  const server = createServer((req, res) => {
    if (!trustedRequest(req)) { res.writeHead(403); res.end('Local access only'); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'DELETE' && !req.headers['content-type']?.startsWith('application/json')) { res.writeHead(415); res.end('JSON required'); return; }
    if ((req.url ?? '').startsWith('/api/')) void handleApi(ctx, req, res);
    else serveStatic(req, res);
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (!trustedRequest(req)) { socket.destroy(); return; }
    const url = new URL(req.url ?? '/', 'http://local');
    if (url.pathname === '/ws/events') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        events.clients.add(ws);
        ws.on('close', () => events.clients.delete(ws));
      });
    } else if (url.pathname === '/ws/term') {
      const id = url.searchParams.get('id') ?? '';
      const term = terms.get(id);
      if (!term) { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws) => {
        for (const chunk of term.buffer) ws.send(chunk);
        const listener = (data: string) => { if (ws.readyState === ws.OPEN) ws.send(data); };
        term.listeners.add(listener);
        ws.on('message', (raw) => {
          try {
            const m = JSON.parse(String(raw));
            if (m.type === 'input') terms.write(id, String(m.data));
            else if (m.type === 'resize') terms.resize(id, Number(m.cols), Number(m.rows));
          } catch { /* ignore */ }
        });
        ws.on('close', () => term.listeners.delete(listener));
      });
    } else {
      socket.destroy();
    }
  });

  // filesystem watcher: partial reindex of the touched top-level folder, debounced
  const watchers: FSWatcher[] = [];
  let watchTimer: NodeJS.Timeout | null = null;
  const resetWatchers = () => {
    for (const w of watchers.splice(0)) w.close();
    if (watchTimer) clearTimeout(watchTimer);
    if (!opts.watch || !cfg.setupComplete) return;
    const skip = new Set([...cfg.vendorNames, ...cfg.excludeNames]);
    const touched = new Set<string>();
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
          touched.add(join(root, segs[0]));
          if (watchTimer) clearTimeout(watchTimer);
          watchTimer = setTimeout(() => {
            const paths = [...touched].filter((p) => existsSync(p));
            const gone = [...touched].filter((p) => !existsSync(p));
            touched.clear();
            if (gone.length) startIndex();            // a top-level folder disappeared: full pass to mark it deleted
            else if (paths.length) startIndex(paths);
          }, 3000);
        });
        watchers.push(w);
      } catch (err) {
        console.error('[watch] non attivo su', root, err);
      }
    }
  };
  resetWatchers();

  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(cfg.port, cfg.host, resolve); });
  const url = `http://${cfg.host}:${cfg.port}`;
  console.log(`Visual Brain: ${url}  (nodi ${cache.stats.nodes}, archi ${cache.stats.edges})`);
  if (cfg.setupComplete && cfg.roots.length && (opts.indexOnStart || cache.stats.nodes === 0)) startIndex();
  if (opts.open) spawn('open', [url], { stdio: 'ignore', detached: true }).unref();

  const shutdown = () => {
    terms.killAll();
    for (const w of watchers) w.close();
    server.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
