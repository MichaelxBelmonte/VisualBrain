// Semantic analysis of the graph with an LLM: areas, project descriptions, inferred relations, suggestions.
// The payload contains names, paths, statistics, technologies and the deterministic cross-links;
// README-like excerpts are added only with consent = 'excerpts'.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db.ts';
import type { Config } from '../config.ts';
import type { GraphCache } from '../cache.ts';
import type { LlmProvider } from './provider.ts';
import { loadIndex, normalizePath, resolveExisting, writeEdges, type EdgeDraft } from '../graph.ts';

export const SCHEMA = {
  type: 'object',
  properties: {
    areas: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, description: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } }, confidence: { type: 'number' } },
        required: ['name', 'description', 'paths', 'confidence'],
      },
    },
    units: {
      type: 'array',
      items: {
        type: 'object',
        properties: { path: { type: 'string' }, label: { type: 'string' }, description: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, role: { type: 'string', enum: ['live', 'copy', 'archive', 'data', 'tool', 'docs', 'unknown'] } },
        required: ['path', 'label', 'description', 'tags', 'role'],
      },
    },
    relations: {
      type: 'array',
      items: {
        type: 'object',
        properties: { from: { type: 'string' }, to: { type: 'string' }, kind: { type: 'string', enum: ['feeds', 'uses', 'documents', 'copy_of', 'same_initiative', 'tests', 'replaces'] }, confidence: { type: 'number' }, reason: { type: 'string' } },
        required: ['from', 'to', 'kind', 'confidence', 'reason'],
      },
    },
    suggestions: {
      type: 'array',
      items: { type: 'object', properties: { path: { type: 'string' }, action: { type: 'string' }, why: { type: 'string' } }, required: ['path', 'action', 'why'] },
    },
  },
  required: ['areas', 'units', 'relations', 'suggestions'],
};

interface Unit {
  id: number;
  path: string;
  name: string;
  cls: string;
  type?: string;
  technologies?: string[];
  files: number;
  bytes: number;
  modified: string;
  description?: string | null;
  status?: string | null;
  top: string[];
  excerpt?: string;
}

const README_NAMES = ['README.md', 'CLAUDE.md', 'AGENTS.md', 'readme.md', 'README.txt', 'LEGGIMI.md', 'BRAIN.md'];

function excerptOf(path: string): string | null {
  for (const n of README_NAMES) {
    try {
      const txt = readFileSync(join(path, n), 'utf8');
      const headings = txt.split('\n').filter((l) => /^#{1,3}\s/.test(l)).slice(0, 8).map((l) => l.replace(/^#+\s*/, '').trim());
      const body = txt.replace(/\s+/g, ' ').trim().slice(0, 400);
      return `${n}: ${body}${headings.length ? ` | titoli: ${headings.join(' · ')}` : ''}`;
    } catch { /* next */ }
  }
  return null;
}

/** Units = top-level folders of every root, project roots up to two levels deep, external groups. */
export function collectUnits(db: Db, cache: GraphCache, consent: 'metadata' | 'excerpts'): Unit[] {
  const units: Unit[] = [];
  const seen = new Set<number>();
  const projects = new Map<number, { type: string; technologies: string[]; description: string | null; status: string | null; label: string | null }>();
  for (const r of db.all<Record<string, unknown>>('SELECT node_id, type, technologies, description, status, label FROM projects')) {
    projects.set(Number(r.node_id), { type: String(r.type), technologies: r.technologies ? JSON.parse(String(r.technologies)) : [], description: (r.description as string | null) ?? null, status: (r.status as string | null) ?? null, label: (r.label as string | null) ?? null });
  }
  const add = (id: number) => {
    const n = cache.nodes.get(id);
    if (!n || seen.has(id)) return;
    if (n.kind !== 'dir' && n.kind !== 'external') return;
    if (n.cls === 'vendor') return;
    seen.add(id);
    const p = projects.get(id);
    const top = (cache.children.get(id) ?? []).slice(0, 14).map((c) => { const k = cache.nodes.get(c)!; return k.kind === 'dir' ? k.name + '/' : k.name; });
    const u: Unit = {
      id, path: n.path, name: n.name, cls: n.cls, type: p?.type, technologies: p?.technologies.slice(0, 15), files: n.files, bytes: n.bytes,
      modified: n.mtime ? new Date(n.mtime).toISOString().slice(0, 10) : '', description: p?.description ?? n.summary ?? null, status: p?.status ?? null, top,
    };
    if (consent === 'excerpts' && n.kind === 'dir') {
      const ex = excerptOf(n.path);
      if (ex) u.excerpt = ex;
    }
    units.push(u);
  };
  for (const r of cache.roots) {
    for (const c of cache.children.get(r) ?? []) {
      add(c);
      const n = cache.nodes.get(c)!;
      if (n.kind !== 'dir') continue;
      for (const g of cache.children.get(c) ?? []) {
        const k = cache.nodes.get(g)!;
        if (k.kind !== 'dir') continue;
        if (k.cls === 'project' || projects.has(g) || (n.cls !== 'project' && k.files >= 20)) add(g);
        if (n.cls !== 'project') for (const gg of cache.children.get(g) ?? []) { const kk = cache.nodes.get(gg)!; if (kk.kind === 'dir' && (kk.cls === 'project' || projects.has(gg))) add(gg); }
      }
    }
  }
  for (const e of cache.externals) add(e);
  return units.filter((u) => u.files > 0 || u.cls === 'project' || cache.nodes.get(u.id)!.kind === 'external').slice(0, 220);
}

function crossLinks(cache: GraphCache, units: Unit[]): { from: string; to: string; kinds: Record<string, number> }[] {
  const unitOf = new Map<number, number>();
  const ids = new Set(units.map((u) => u.id));
  const resolve = (id: number): number | null => {
    let cur: number | null = id;
    let guard = 0;
    let found: number | null = null;
    while (cur !== null && guard++ < 64) {
      if (ids.has(cur)) found = cur;         // the deepest unit wins, so keep walking only until the first hit from below
      if (found !== null) break;
      cur = cache.nodes.get(cur)?.parentId ?? null;
    }
    return found;
  };
  const agg = new Map<string, { from: string; to: string; kinds: Record<string, number> }>();
  for (const e of cache.edges) {
    if (e.hidden || e.kind === 'similar' || e.kind === 'shared_id') continue;
    const a = unitOf.get(e.src) ?? resolve(e.src);
    const b = unitOf.get(e.dst) ?? resolve(e.dst);
    if (a === null || b === null) continue;
    unitOf.set(e.src, a); unitOf.set(e.dst, b);
    if (a === b) continue;
    const key = `${a}|${b}`;
    const ua = cache.nodes.get(a)!.path;
    const ub = cache.nodes.get(b)!.path;
    const prev = agg.get(key) ?? { from: ua, to: ub, kinds: {} };
    prev.kinds[e.kind] = (prev.kinds[e.kind] ?? 0) + e.count;
    agg.set(key, prev);
  }
  return [...agg.values()].sort((x, y) => Object.values(y.kinds).reduce((s, v) => s + v, 0) - Object.values(x.kinds).reduce((s, v) => s + v, 0)).slice(0, 120);
}

export function buildPayload(db: Db, cfg: Config, cache: GraphCache, consent: 'metadata' | 'excerpts'): { payload: string; bytes: number; nodes: number } {
  const units = collectUnits(db, cache, consent);
  const links = crossLinks(cache, units);
  const areas = cache.areas.map((a) => ({ name: a.name, description: a.description, paths: a.nodeIds.map((i) => cache.nodes.get(i)?.path).filter(Boolean) }));
  const data = {
    roots: cfg.roots,
    units: units.map(({ id, ...u }) => u),
    cross_links: links,
    known_areas: areas,
  };
  const instructions = [
    'Sei l\'analista di un grafo locale di file e progetti (il «Visual Brain» di un singolo utente). Ricevi SOLO metadati: nomi, percorsi, classi, tecnologie, statistiche, e i collegamenti deterministici trovati nei file (cross_links: numero di riferimenti per tipo fra due unità).',
    consent === 'excerpts' ? 'Per alcune unità c\'è anche un breve estratto del README (campo excerpt).' : 'Non ci sono contenuti dei file: non inventare dettagli che i nomi e i collegamenti non sostengono.',
    'Compiti, in italiano, frasi brevi:',
    '1. areas: raggruppa le unità in 4–10 aree di conoscenza o iniziative. Usa esattamente i nomi delle aree già presenti in input quando il senso coincide; crea un nome nuovo solo se nessuna area esistente va bene. Ogni area con descrizione di una riga, i path delle unità e una confidence 0–1. Rispetta known_areas se presenti, puoi rinominare o fondere.',
    '2. units: per ogni unità un\'etichetta corta (max 4 parole), una descrizione di una riga su cosa è e a cosa serve, 2–6 tag (tecnologie, temi), e il ruolo: live (lavoro attivo), copy (copia o versione fissata), archive, data (dati e risultati), tool, docs, unknown. Quando status è già noto, usalo.',
    '3. relations: relazioni fra unità NON già evidenti dai cross_links o che li interpretano (feeds = produce dati per; uses; documents = documenta; copy_of; same_initiative; tests; replaces). Per ciascuna una confidence 0–1 e la ragione con il dato che la sostiene (nomi, tecnologie, cross_links). Niente relazioni senza un indizio concreto. Massimo 60.',
    '4. suggestions: massimo 12 azioni utili (es. «unificare le 3 copie di X», «documentare Y», «archiviare Z»), con il path e il perché.',
    'Usa esattamente i path forniti. Rispondi solo nel formato richiesto.',
    '',
    'DATI:',
  ].join('\n');
  const payload = instructions + '\n' + JSON.stringify(data);
  return { payload, bytes: Buffer.byteLength(payload, 'utf8'), nodes: units.length };
}

interface Output {
  areas: { name: string; description: string; paths: string[]; confidence: number }[];
  units: { path: string; label: string; description: string; tags: string[]; role: string }[];
  relations: { from: string; to: string; kind: string; confidence: number; reason: string }[];
  suggestions: { path: string; action: string; why: string }[];
}

export async function analyze(db: Db, cfg: Config, cache: GraphCache, provider: LlmProvider, consent: 'metadata' | 'excerpts', progress?: (m: string) => void): Promise<{ runId: number; summary: string }> {
  const { payload, bytes, nodes } = buildPayload(db, cfg, cache, consent);
  const r = db.run('INSERT INTO llm_runs (provider, model, consent, started_at, bytes_sent, nodes_sent, status, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    provider.name, provider.model, consent, Date.now(), bytes, nodes, 'running', payload);
  const runId = Number(r.lastInsertRowid);
  progress?.(`invio ${nodes} unità (${(bytes / 1024).toFixed(0)} KB) a ${provider.name} / ${provider.model}`);
  let out: Output;
  let costUsd: number | undefined;
  try {
    const res = await provider.complete(payload, SCHEMA, cfg.llm.timeoutMs);
    out = res.output as Output;
    costUsd = res.costUsd;
    db.run('UPDATE llm_runs SET result = ? WHERE id = ?', JSON.stringify(out).slice(0, 2_000_000), runId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    db.run("UPDATE llm_runs SET status = 'error', error = ?, finished_at = ? WHERE id = ?", msg, Date.now(), runId);
    throw err;
  }
  const summary = applyOutput(db, cfg, cache, out, runId);
  const text = `${summary}${costUsd !== undefined ? ` · ${costUsd.toFixed(3)} $` : ''}`;
  db.run("UPDATE llm_runs SET status = 'done', finished_at = ?, summary = ? WHERE id = ?", Date.now(), text, runId);
  progress?.(text);
  return { runId, summary: text };
}

function applyOutput(db: Db, cfg: Config, cache: GraphCache, out: Output, runId: number): string {
  const idx = loadIndex(db, cfg);
  const find = (p: string): number | null => {
    if (typeof p !== 'string') return null;
    return resolveExisting(idx, normalizePath(p, idx.home))?.id ?? null;
  };
  let areas = 0;
  let units = 0;
  let suggestions = 0;
  const drafts = new Map<string, EdgeDraft>();
  db.tx(() => {
    const existingAreas = db.all<{ name: string }>('SELECT name FROM areas').map((r) => r.name);
    for (const a of out.areas ?? []) {
      if (!a?.name) continue;
      a.name = matchArea(existingAreas, String(a.name).slice(0, 80));
      db.run("INSERT INTO areas (name, description, origin, confidence) VALUES (?, ?, 'llm', ?) ON CONFLICT(name) DO UPDATE SET description = excluded.description, confidence = excluded.confidence", a.name.slice(0, 80), String(a.description ?? '').slice(0, 300), a.confidence ?? null);
      const areaId = db.get<{ id: number }>('SELECT id FROM areas WHERE name = ?', a.name.slice(0, 80))!.id;
      for (const p of a.paths ?? []) {
        const id = find(p);
        if (id === null) continue;
        db.run('UPDATE nodes SET area_id = ? WHERE id = ?', areaId, id);
        db.run('UPDATE projects SET area_id = ? WHERE node_id = ?', areaId, id);
      }
      areas++;
    }
    for (const u of out.units ?? []) {
      const id = find(u?.path);
      if (id === null) continue;
      const tags = Array.isArray(u.tags) ? u.tags.map(String).slice(0, 8) : [];
      db.run('UPDATE nodes SET summary = ?, tags = ? WHERE id = ?', String(u.description ?? '').slice(0, 400), JSON.stringify(tags), id);
      const prj = db.get<{ id: number; status: string | null }>('SELECT id, status FROM projects WHERE node_id = ?', id);
      if (prj) db.run('UPDATE projects SET label = ?, description = ?, status = COALESCE(status, ?) WHERE id = ?', String(u.label ?? '').slice(0, 60), String(u.description ?? '').slice(0, 400), u.role && u.role !== 'unknown' ? u.role : null, prj.id);
      units++;
    }
    for (const rel of out.relations ?? []) {
      const a = find(rel?.from);
      const b = find(rel?.to);
      if (a === null || b === null || a === b) continue;
      const conf = Math.max(0, Math.min(1, Number(rel.confidence) || 0.5));
      drafts.set(`${a}|${b}|semantic`, { src: a, dst: b, kind: 'semantic', verified: 0, confidence: conf, evidence: { note: `${rel.kind}: ${String(rel.reason ?? '').slice(0, 300)}`, run: runId }, origin: 'llm', count: 1 });
    }
    db.run("DELETE FROM notes WHERE origin = 'llm' AND kind = 'suggestion'");
    for (const s of out.suggestions ?? []) {
      const id = find(s?.path);
      if (id === null) continue;
      db.run("INSERT INTO notes (node_id, kind, text, origin, created_at) VALUES (?, 'suggestion', ?, 'llm', ?)", id, `${String(s.action ?? '').slice(0, 200)} — ${String(s.why ?? '').slice(0, 300)}`, Date.now());
      suggestions++;
    }
  });
  const relations = writeEdges(db, drafts, 'llm', ['semantic']);
  return `${areas} aree, ${units} unità descritte, ${relations} relazioni inferite, ${suggestions} suggerimenti`;
}

const AREA_STOP = new Set(['e', 'ed', 'di', 'del', 'della', 'dei', 'delle', 'il', 'la', 'lo', 'i', 'gli', 'le', 'bu']);
function areaTokens(s: string): Set<string> {
  return new Set(s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).filter((t) => t && !AREA_STOP.has(t)));
}
/** Reuses an existing area when all of its words appear in the proposed name («Motore di calcolo» → «Motore», «Banco prove e dati» → «Dati e prove»). */
export function matchArea(existing: string[], proposed: string): string {
  const p = areaTokens(proposed);
  let best: string | null = null;
  for (const name of existing) {
    const t = areaTokens(name);
    if (t.size && [...t].every((x) => p.has(x)) && (!best || t.size > areaTokens(best).size)) best = name;
  }
  return best ?? proposed;
}
