// One read-only view of the graph for agents: a node with its links, the area around it, a search, or the path between two nodes.
// Compact on purpose: an agent gets paths, kinds and evidence it can act on, never file contents.
import { homedir } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';
import type { CEdge, CNode } from './cache.ts';
import type { Evidence } from '../shared/types.ts';

export interface ExploreGraph {
  nodes: Map<number, CNode>;
  children: Map<number, number[]>;
  /** Every edge touching a node (hidden ones included: they are filtered here). */
  links(id: number): CEdge[];
  /** Evidence of some edges, by edge id. */
  evidence(ids: number[]): Map<number, Evidence[]>;
  find(query: string, limit: number): CNode[];
  notes(id: number): { text: string; origin: string }[];
}

export interface ExploreArgs {
  /** Node of the calling session: the default target and the base of relative paths. */
  from?: number;
  target?: string;
  query?: string;
  to?: string;
  depth?: number;
}

const LINKS = 40, AROUND = 30, CHILDREN = 40, RESULTS = 15, MAX_HOPS = 6;

const ISO = (ms: number) => (ms > 0 ? new Date(ms).toISOString().slice(0, 10) : undefined);
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function card(n: CNode) {
  return { path: n.path, kind: n.kind, cls: n.cls, ...(n.lang ? { lang: n.lang } : {}), ...(n.summary ? { summary: clip(n.summary, 240) } : {}) };
}

function evidence(list: Evidence[]): string | undefined {
  const e = list[0];
  if (!e) return undefined;
  const text = e.note ?? (e.snippet ? `${e.line ? `riga ${e.line}: ` : ''}${e.snippet}` : e.token ? `identificatore ${e.token}` : e.terms?.length ? `termini ${e.terms.slice(0, 5).join(', ')}` : undefined);
  return text ? clip(text, 160) : undefined;
}

/** Visible edges of a node, strongest first: verified, then confidence, then how many times the reference occurs. */
function visibleLinks(g: ExploreGraph, id: number): CEdge[] {
  return g.links(id).filter((e) => !e.hidden && e.src !== e.dst)
    .sort((a, b) => Number(b.verified) - Number(a.verified) || b.confidence - a.confidence || b.count - a.count);
}

export function resolveTarget(g: ExploreGraph, ref: string | undefined, from: number | undefined): CNode | undefined {
  const base = from !== undefined ? g.nodes.get(from) : undefined;
  if (!ref) return base;
  const text = ref.trim();
  if (/^\d+$/.test(text)) return g.nodes.get(Number(text));
  const home = homedir();
  const path = text.startsWith('~/') ? join(home, text.slice(2)) : isAbsolute(text) ? normalize(text) : base ? join(base.kind === 'dir' ? base.path : base.path.slice(0, base.path.lastIndexOf('/')), text) : undefined;
  if (!path) return undefined;
  const clean = path.length > 1 ? path.replace(/\/+$/, '') : path;
  for (const n of g.nodes.values()) if (n.path === clean) return n;
  return undefined;
}

export function explore(g: ExploreGraph, args: ExploreArgs): unknown {
  const query = args.query?.trim();
  if (query && !args.target) {
    const results = g.find(query, RESULTS).map(card);
    return { query, results, ...(results.length ? {} : { hint: 'Nessun nodo trovato: prova con il nome di un file o di una cartella.' }) };
  }
  const node = resolveTarget(g, args.target, args.from);
  if (!node) throw new Error(args.target ? `Nodo non trovato: ${args.target}. Usa un percorso assoluto, relativo al tuo nodo, oppure query per cercarlo.` : 'Indica target o query.');
  const linksOf = new Map<number, CEdge[]>();
  const by = { get: (id: number) => { let l = linksOf.get(id); if (!l) { l = visibleLinks(g, id); linksOf.set(id, l); } return l; } };
  if (args.to) {
    const goal = resolveTarget(g, args.to, args.from);
    if (!goal) throw new Error(`Nodo non trovato: ${args.to}`);
    return { from: node.path, to: goal.path, path: shortestPath(g, by, node.id, goal.id) };
  }
  const own = by.get(node.id) ?? [];
  const shownEvidence = g.evidence(own.slice(0, LINKS).map((e) => e.id));
  const links = own.slice(0, LINKS).map((e) => {
    const out = e.src === node.id;
    const other = g.nodes.get(out ? e.dst : e.src);
    const why = evidence(shownEvidence.get(e.id) ?? []);
    return { dir: out ? 'out' : 'in', kind: e.kind, path: other?.path ?? String(out ? e.dst : e.src), verified: e.verified, confidence: Math.round(e.confidence * 100) / 100, ...(why ? { evidence: why } : {}) };
  });
  const children = (g.children.get(node.id) ?? []).slice(0, CHILDREN).map((id) => g.nodes.get(id)).filter((c): c is CNode => Boolean(c))
    .map((c) => ({ name: c.name, kind: c.kind, cls: c.cls, ...(c.kind === 'dir' ? { files: c.files } : {}) }));
  const notes = g.notes(node.id).slice(0, 8).map((n) => ({ text: clip(n.text, 400), origin: n.origin }));
  const parent = node.parentId != null ? g.nodes.get(node.parentId)?.path : undefined;
  const result: Record<string, unknown> = {
    node: { ...card(node), bytes: node.bytes, ...(node.kind === 'dir' ? { files: node.files } : {}), ...(ISO(node.mtime) ? { modified: ISO(node.mtime) } : {}), ...(parent ? { parent } : {}) },
    links,
    ...(own.length > LINKS ? { moreLinks: own.length - LINKS } : {}),
    ...(children.length ? { children, ...((g.children.get(node.id)?.length ?? 0) > CHILDREN ? { moreChildren: g.children.get(node.id)!.length - CHILDREN } : {}) } : {}),
    ...(notes.length ? { notes } : {}),
  };
  if ((args.depth ?? 1) >= 2) {
    const seen = new Set<number>([node.id]);
    for (const e of own) seen.add(e.src === node.id ? e.dst : e.src);
    const around: { via: string; kind: string; path: string; verified: boolean }[] = [];
    for (const e of own.slice(0, LINKS)) {
      const mid = e.src === node.id ? e.dst : e.src;
      for (const f of by.get(mid) ?? []) {
        const far = f.src === mid ? f.dst : f.src;
        if (seen.has(far)) continue;
        seen.add(far);
        around.push({ via: g.nodes.get(mid)?.path ?? String(mid), kind: f.kind, path: g.nodes.get(far)?.path ?? String(far), verified: f.verified });
        if (around.length >= AROUND) break;
      }
      if (around.length >= AROUND) break;
    }
    result.around = around;
  }
  return result;
}

/** Breadth-first over visible links in both directions, verified links first; null beyond MAX_HOPS. */
function shortestPath(g: ExploreGraph, by: { get(id: number): CEdge[] }, start: number, goal: number) {
  if (start === goal) return [{ path: g.nodes.get(start)!.path }];
  const prev = new Map<number, { from: number; edge: CEdge }>();
  let frontier = [start];
  const seen = new Set([start]);
  for (let hop = 0; hop < MAX_HOPS && frontier.length; hop++) {
    const next: number[] = [];
    for (const id of frontier) {
      for (const e of by.get(id) ?? []) {
        const other = e.src === id ? e.dst : e.src;
        if (seen.has(other)) continue;
        seen.add(other); prev.set(other, { from: id, edge: e }); next.push(other);
        if (other === goal) {
          const steps: unknown[] = [{ path: g.nodes.get(goal)?.path }];
          for (let at = goal; at !== start;) {
            const p = prev.get(at)!;
            steps.unshift({ path: g.nodes.get(p.from)?.path }, { link: p.edge.kind, dir: p.edge.src === p.from ? 'out' : 'in', verified: p.edge.verified });
            at = p.from;
          }
          return steps;
        }
      }
    }
    frontier = next;
  }
  return null;
}
