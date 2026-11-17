// In-memory graph used by the API: nodes, children by importance, edges, areas, projects. Reloaded after every index run.
// Edges stay compact (no evidence: on a Desktop it is hundreds of MB of JSON); evidence is read from the database only for
// the edges an answer actually returns.
import type { Db } from './db.ts';
import { globToRegExp, type Config } from './config.ts';
import { computeRank, type NodeRow } from './rank.ts';
import type { Area, Evidence, GraphEdge, GraphNode, GraphView, ProjectInfo, Stats } from '../shared/types.ts';

export interface CNode extends GraphNode {}

export interface CEdge {
  id: number;
  src: number;
  dst: number;
  kind: string;
  verified: boolean;
  confidence: number;
  origin: string;
  count: number;
  hidden: boolean;
}

export interface CProject extends ProjectInfo {
  areaId: number | null;
  status: string | null;
  parentProjectId: number | null;
  container: boolean;
  path: string;
}

export interface GraphQuery {
  /** The canvas needs the visible projects and edge geometry. The node panel requests evidence separately. */
  mapOnly?: boolean;
  expanded: number[];
  kinds: Set<string> | null;
  /** Minimum importance of the files shown inside folders with more than 40 entries. */
  min: number;
  view: GraphView;
  /** Show symbolic links of the first level (always shown inside expanded folders). */
  symlinks: boolean;
  /** Show references outside the roots and to missing paths. */
  externals: boolean;
  /** Nodes forced into the view (e.g. revealed by a search) even when nothing contains them. */
  extra: number[];
}

function parseEvidence(s: string | null): Evidence[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [v];
  } catch {
    return [{ note: s }];
  }
}

export function rowToEdge(r: Record<string, unknown>): CEdge {
  return {
    id: Number(r.id), src: Number(r.src), dst: Number(r.dst), kind: String(r.kind), verified: Number(r.verified) === 1,
    confidence: Number(r.confidence), origin: String(r.origin), count: Number(r.count ?? 1), hidden: Number(r.hidden) === 1,
  };
}

const collator = new Intl.Collator();
const NONE = -0x80000000;   // "no visible ancestor" in the per-request memo (node ids are positive, rolled-up rests negative)

export class GraphCache {
  nodes = new Map<number, CNode>();
  children = new Map<number, number[]>();
  edges: CEdge[] = [];
  roots: number[] = [];
  externals: number[] = [];
  areas: Area[] = [];
  /** Projects by project id. */
  projects = new Map<number, CProject>();
  /** Project id by node id. */
  projectByNode = new Map<number, number>();
  stats: Stats = { nodes: 0, files: 0, dirs: 0, edges: 0, verifiedEdges: 0, inferredEdges: 0, projects: 0, areas: 0, llmRuns: 0, roots: [] };
  loadedAt = 0;
  private db: Db | null = null;
  /** Parent id by node id (0 for none) and the largest node id, for the typed arrays of `graph`. */
  private parentOf = new Int32Array(0);
  private maxId = 0;
  /** Edges by endpoint (CSR over `edges` indexes), built on first use and dropped when the edges change. */
  private incidence: { start: Int32Array; list: Int32Array } | null = null;

  load(db: Db, cfg: Config): void {
    const steps = this.build(db, cfg);
    while (!steps.next().done);
  }

  /**
   * The same load, a slice at a time: the server thread also carries the terminals, and reading a Desktop index in one go
   * would freeze them for seconds. The current maps keep answering until the new ones replace them at once.
   */
  async loadAsync(db: Db, cfg: Config): Promise<void> {
    const steps = this.build(db, cfg);
    const mine = this.loadToken;
    while (!steps.next().done) await new Promise<void>((resolve) => setImmediate(resolve));
    // overtaken by a newer load: done when that one is in place, never with the old maps
    if (this.swapped < mine) await new Promise<void>((resolve) => this.waiters.push({ token: mine, resolve }));
  }

  /** The load whose maps are in place, and the loads waiting for a newer one to land. */
  private swapped = 0;
  private waiters: { token: number; resolve: () => void }[] = [];

  /** Edges changed through the API while a load is in progress, applied again to what it loaded. */
  private edgeEdits: [number, CEdge | null][] | null = null;
  private loadToken = 0;

  private *build(db: Db, cfg: Config): Generator<void, void, void> {
    const t0 = Date.now();
    const token = ++this.loadToken;
    this.edgeEdits = [];
    const SLICE = 10_000;
    const nodes = new Map<number, CNode>();
    const children = new Map<number, number[]>();
    const roots: number[] = [];
    const externals: number[] = [];
    const maxId = Number(db.get<{ m: number | null }>('SELECT MAX(id) m FROM nodes')?.m ?? 0);
    const parentOf = new Int32Array(maxId + 1);
    const areas: Area[] = db.all<{ id: number; name: string; description: string | null; origin: string; confidence: number | null }>('SELECT id, name, description, origin, confidence FROM areas')
      .map((a) => ({ ...a, nodeIds: [] }));
    const byArea = new Map(areas.map((a) => [a.id, a]));
    // arrays instead of row objects: this runs on the server thread, and on a Desktop it is 100k+ rows
    const query = db.prepare('SELECT id, path, name, kind, cls, lang, size, bytes, files, depth, mtime, importance, indeg, outdeg, project_id, area_id, aggregate, parent_id, child_count, summary, tags FROM nodes WHERE deleted = 0');
    query.setReturnArrays(true);
    let ranked = false;
    let files = 0;
    let dirs = 0;
    let i = 0;
    // Kinds, classes, languages and origins are a handful of strings repeated a million times: keep one copy of each.
    const words = new Map<string, string>();
    const word = <T extends string>(s: T): T => { let w = words.get(s); if (w === undefined) { w = s; words.set(s, s); } return w as T; };
    // A row that has not changed since the maps in place keeps their object: while loading, the unchanged part of a Desktop
    // (nearly all of it) is in memory once, not twice. childCount is recounted below either way.
    const prev = this.nodes;
    for (const r of query.iterate() as unknown as Iterable<unknown[]>) {
      const old = r[20] ? undefined : prev.get(r[0] as number);
      let n: CNode;
      if (old && old.path === r[1] && old.name === r[2] && old.kind === r[3] && old.cls === r[4] && old.lang === (r[5] ?? null)
        && old.size === r[6] && old.bytes === r[7] && old.files === r[8] && old.depth === r[9] && old.mtime === r[10] && old.importance === r[11]
        && old.indeg === r[12] && old.outdeg === r[13] && old.projectId === (r[14] ?? null) && old.areaId === (r[15] ?? null)
        && old.aggregate === (Number(r[16]) === 1) && old.parentId === (r[17] ?? null) && old.summary === (r[19] ?? null) && old.tags === undefined) {
        n = old;
        n.childCount = r[18] as number;
      } else {
        n = {
          id: r[0] as number, path: r[1] as string, name: r[2] as string, kind: word(r[3] as CNode['kind']), cls: word(r[4] as string), lang: r[5] == null ? null : word(r[5] as string),
          size: r[6] as number, bytes: r[7] as number, files: r[8] as number, depth: r[9] as number, mtime: r[10] as number, importance: r[11] as number,
          indeg: r[12] as number, outdeg: r[13] as number, projectId: (r[14] as number | null) ?? null, areaId: (r[15] as number | null) ?? null,
          aggregate: Number(r[16]) === 1, parentId: (r[17] as number | null) ?? null, childCount: r[18] as number,
          summary: (r[19] as string | null) ?? null, tags: r[20] ? (JSON.parse(String(r[20])) as string[]) : undefined,
        };
      }
      if (n.importance > 0) ranked = true;
      if (n.kind === 'file') files++; else if (n.kind === 'dir') dirs++;
      nodes.set(n.id, n);
      if (n.areaId != null) byArea.get(n.areaId)?.nodeIds.push(n.id);
      if (n.id <= maxId && n.parentId !== null) parentOf[n.id] = n.parentId;
      if (n.parentId === null) {
        if (n.kind === 'dir' && cfg.roots.includes(n.path)) roots.push(n.id);
        else if (n.kind === 'external') externals.push(n.id);
      } else {
        const arr = children.get(n.parentId);
        if (arr) arr.push(n.id); else children.set(n.parentId, [n.id]);
      }
      if (++i % SLICE === 0) yield;
    }
    // First index not ranked yet: rank the loaded nodes here (no edges exist yet), so the first map is ordered like the
    // stored ranking will be. Nothing is written; the database gets the real ranking at the end of the pass.
    if (!ranked && nodes.size > 0) {
      const rows: NodeRow[] = [...nodes.values()].map((n) => ({ id: n.id, kind: n.kind, cls: n.cls, parent_id: n.parentId, size: n.size, bytes: n.bytes, files: n.files, mtime: n.mtime, aggregate: n.aggregate ? 1 : 0 }));
      for (const [id, x] of computeRank(rows, [])) { const n = nodes.get(id)!; n.importance = x.importance; n.indeg = x.indeg; n.outdeg = x.outdeg; }
      yield;
    }
    i = 0;
    for (const [pid, arr] of children) {
      if (arr.length > 1) {
        const kids = arr.map((id) => nodes.get(id)!);
        kids.sort((a, b) => (b.importance - a.importance) || collator.compare(a.name, b.name));
        for (let k = 0; k < kids.length; k++) arr[k] = kids[k].id;
        i += arr.length;
      }
      const p = nodes.get(pid);
      if (p) p.childCount = arr.length;
      if (i >= SLICE) { i = 0; yield; }
    }
    const edgeQuery = db.prepare('SELECT id, src, dst, kind, verified, confidence, origin, count, hidden FROM edges');
    edgeQuery.setReturnArrays(true);
    const edges: CEdge[] = [];
    let shown = 0, verified = 0;
    // unchanged edges keep their object too; both lists are in id order (rowid scan; replaceEdge keeps the order)
    const before = this.edges;
    let j = 0;
    for (const r of edgeQuery.iterate() as unknown as Iterable<unknown[]>) {
      const id = r[0] as number, count = (r[7] as number | null) ?? 1;
      while (j < before.length && before[j].id < id) j++;
      const old = before[j];
      const e: CEdge = old && old.id === id && old.src === r[1] && old.dst === r[2] && old.kind === r[3] && old.verified === (r[4] === 1)
        && old.confidence === Number(r[5]) && old.origin === r[6] && old.count === count && old.hidden === (r[8] === 1)
        ? old
        : { id, src: r[1] as number, dst: r[2] as number, kind: word(r[3] as string), verified: r[4] === 1, confidence: Number(r[5]),
          origin: word(r[6] as string), count, hidden: r[8] === 1 };
      edges.push(e);
      if (!e.hidden) { shown++; if (e.verified) verified++; }
      if (edges.length % SLICE === 0) yield;
    }
    // A newer load started meanwhile: it replaces the maps, not this one.
    if (token !== this.loadToken) return;
    this.db = db;
    this.incidence = null;
    this.nodes = nodes;
    this.children = children;
    this.roots = roots;
    this.externals = externals;
    this.parentOf = parentOf;
    this.maxId = maxId;
    this.edges = edges;
    const edits = this.edgeEdits ?? [];
    this.edgeEdits = null;
    for (const [id, e] of edits) this.replaceEdge(id, e);
    this.areas = areas;
    this.swapped = token;
    for (const w of this.waiters.splice(0)) if (w.token <= token) w.resolve(); else this.waiters.push(w);
    this.loadProjects(db, cfg);
    const count = (sql: string) => Number(db.get<{ c: number }>(sql)!.c);
    this.stats = {
      nodes: nodes.size,
      files,
      dirs,
      edges: shown,
      verifiedEdges: verified,
      inferredEdges: shown - verified,
      projects: this.projects.size,
      areas: this.areas.length,
      lastScan: db.getMeta('lastScan') ? Number(db.getMeta('lastScan')) : null,
      scanMs: db.getMeta('scanMs') ? Number(db.getMeta('scanMs')) : null,
      llmRuns: count('SELECT COUNT(*) c FROM llm_runs'),
      roots: cfg.roots,
    };
    this.loadedAt = Date.now() - t0;
  }

  private loadProjects(db: Db, cfg: Config): void {
    this.projects.clear();
    this.projectByNode.clear();
    const rows = db.all<Record<string, unknown>>('SELECT id, node_id, name, label, type, remote, technologies, description, area_id, status FROM projects');
    for (const r of rows) {
      const nodeId = Number(r.node_id);
      const n = this.nodes.get(nodeId);
      if (!n) continue;
      let technologies: string[] = [];
      try { technologies = r.technologies ? (JSON.parse(String(r.technologies)) as string[]) : []; } catch { technologies = []; }
      const p: CProject = {
        id: Number(r.id), nodeId, name: String(r.name), label: (r.label as string | null) ?? null, type: String(r.type), remote: (r.remote as string | null) ?? null,
        technologies, description: (r.description as string | null) ?? null, areaId: (r.area_id as number | null) ?? null, status: (r.status as string | null) ?? null,
        parentProjectId: null, container: false, path: n.path,
      };
      this.projects.set(p.id, p);
      this.projectByNode.set(nodeId, p.id);
    }
    for (const p of this.projects.values()) {
      let cur = this.nodes.get(p.nodeId)?.parentId ?? null;
      let guard = 0;
      while (cur !== null && guard++ < 64) {
        const pid = this.projectByNode.get(cur);
        if (pid !== undefined) { p.parentProjectId = pid; break; }
        cur = this.nodes.get(cur)?.parentId ?? null;
      }
    }
    const yes = cfg.containers.map(globToRegExp);
    const no = cfg.notContainers.map(globToRegExp);
    for (const p of this.projects.values()) p.container = this.isContainer(p, cfg, yes, no);
  }

  /**
   * A container is a folder, at most two levels under a root, that holds only project folders (and links):
   * the organising folders of the Desktop. Configurable with `containers` / `notContainers`.
   */
  private isContainer(p: CProject, cfg: Config, yes: RegExp[], no: RegExp[]): boolean {
    const n = this.nodes.get(p.nodeId);
    if (!n) return false;
    if (no.some((r) => r.test(n.path))) return false;
    if (yes.some((r) => r.test(n.path))) return true;
    if (p.type !== 'folder' || n.cls !== 'folder') return false;
    const root = cfg.roots.find((r) => n.path.startsWith(r + '/'));
    if (!root) return false;
    if (n.path.slice(root.length + 1).split('/').length > 2) return false;
    let dirs = 0;
    let projs = 0;
    for (const k of this.children.get(n.id) ?? []) {
      const c = this.nodes.get(k)!;
      if (c.kind === 'file') return false;
      if (c.kind === 'dir') { dirs++; if (this.projectByNode.has(k)) projs++; }
    }
    return projs >= 1 && projs === dirs;
  }

  isAncestor(maybeAncestor: number, node: number): boolean {
    let cur: number | null = this.nodes.get(node)?.parentId ?? null;
    let guard = 0;
    while (cur !== null && guard++ < 64) {
      if (cur === maybeAncestor) return true;
      cur = this.nodes.get(cur)?.parentId ?? null;
    }
    return false;
  }

  /**
   * Project nodes drawn as boxes of their area: every project with an area, except the containers and the
   * projects nested in a project of the same area (those appear when the parent is expanded).
   */
  topLevel(): Set<number> {
    const out = new Set<number>();
    for (const p of this.projects.values()) {
      if (p.areaId === null || p.container) continue;
      let anc = p.parentProjectId !== null ? this.projects.get(p.parentProjectId) : undefined;
      while (anc && anc.container) anc = anc.parentProjectId !== null ? this.projects.get(anc.parentProjectId) : undefined;
      if (anc && anc.areaId !== null && anc.areaId === p.areaId) continue;
      out.add(p.nodeId);
    }
    return out;
  }

  /** The nodes shown for a view and a set of expanded folders, plus the rolled-up edges between them. */
  graph(q: GraphQuery): { nodes: GraphNode[]; edges: GraphEdge[]; expanded: number[]; view: GraphView; topLevel: number[]; projects: ProjectInfo[] } {
    const visible = new Map<number, GraphNode>();
    const show = (id: number) => { const n = this.nodes.get(id); if (n) visible.set(id, n); };
    const top = q.view === 'projects' ? this.topLevel() : new Set<number>();
    if (q.view === 'projects') {
      for (const id of top) show(id);
      for (const r of this.roots) {
        for (const c of this.children.get(r) ?? []) {
          const n = this.nodes.get(c)!;
          if (n.kind === 'symlink') { if (q.symlinks) show(c); continue; }
          if (n.kind === 'external') { if (q.externals) show(c); continue; }
          if (n.kind === 'file') { if (!n.name.startsWith('.')) show(c); continue; }   // loose files of the root, hidden ones aside
          const pid = this.projectByNode.get(c);
          if (pid === undefined) { show(c); continue; }             // a folder that is not a project: a loose box
          const p = this.projects.get(pid)!;
          if (!p.container && p.areaId === null) show(c);           // detected project without area: loose box
        }
      }
      if (q.externals) for (const e of this.externals) show(e);
      for (const id of q.extra) show(id);
    } else {
      for (const r of this.roots) for (const c of this.children.get(r) ?? []) {
        const n = this.nodes.get(c)!;
        if (n.kind === 'symlink' && !q.symlinks) continue;
        if (n.kind === 'external' && !q.externals) continue;
        show(c);
      }
      if (q.externals) for (const e of this.externals) show(e);
      for (const id of q.extra) show(id);
    }
    const exp = new Set(q.expanded);
    const applied = new Set<number>();
    const rest = new Map<number, GraphNode>();
    const queue = [...visible.keys()].filter((id) => exp.has(id));
    while (queue.length) {
      const id = queue.shift()!;
      if (applied.has(id)) continue;
      const n = this.nodes.get(id);
      if (!n || (n.kind !== 'dir' && n.kind !== 'external')) continue;
      applied.add(id);
      const kids = this.children.get(id) ?? [];
      let shown = 0;
      let hidden = 0;
      for (const kid of kids) {
        const k = this.nodes.get(kid)!;
        if ((k.kind === 'file' || k.kind === 'symlink') && kids.length > 40 && k.importance < q.min) { hidden++; continue; }
        if (shown >= 150) { hidden++; continue; }
        show(kid);
        shown++;
        if (exp.has(kid)) queue.push(kid);
      }
      if (hidden > 0) {
        rest.set(id, {
          id: -id, path: n.path, name: `+${hidden} altri`, kind: 'dir', cls: 'rest', size: 0, bytes: 0, files: hidden, depth: n.depth + 1, mtime: 0,
          importance: 0.05, indeg: 0, outdeg: 0, aggregate: true, parentId: id, childCount: 0,
        });
      }
    }
    // The visible box of every edge end, resolved once per node: a node shows itself, or the "+N" rest of an expanded
    // folder it is hidden in, or whatever its parent resolves to.
    const size = this.maxId + 1;
    const shownMark = new Uint8Array(size), appliedMark = new Uint8Array(size), restMark = new Uint8Array(size);
    for (const id of visible.keys()) if (id > 0 && id < size) shownMark[id] = 1;
    for (const id of applied) if (id < size) appliedMark[id] = 1;
    for (const id of rest.keys()) if (id < size) restMark[id] = 1;
    const memo = new Int32Array(size);
    const parentOf = this.parentOf;
    const chain: number[] = [];
    const visibleAncestor = (id: number): number | null => {
      if (id <= 0 || id >= size) return visible.has(id) ? id : null;
      let cur = id, found = NONE;
      chain.length = 0;
      while (cur > 0 && cur < size && chain.length < 64) {
        if (memo[cur] !== 0) { found = memo[cur]; break; }
        chain.push(cur);
        if (shownMark[cur]) { found = cur; break; }
        const parent = parentOf[cur];
        if (parent > 0 && parent < size && appliedMark[parent]) { found = restMark[parent] ? -parent : parent; break; }
        cur = parent;
      }
      for (const c of chain) memo[c] = found;
      return found === NONE ? null : found;
    };
    // Ancestors of each visible box, to drop edges between a box and something inside it.
    const ancestorsOf = new Map<number, Set<number>>();
    const isAncestor = (a: number, b: number): boolean => {
      let set = ancestorsOf.get(b);
      if (!set) {
        set = new Set();
        for (let cur = b < size ? parentOf[b] : 0, guard = 0; cur > 0 && guard < 64; cur = cur < size ? parentOf[cur] : 0, guard++) set.add(cur);
        ancestorsOf.set(b, set);
      }
      return set.has(a);
    };
    const kindIndex = new Map<string, number>();
    const base = 2 * size + 1;
    const numericKeys = base * base * 64 < Number.MAX_SAFE_INTEGER;
    const rolled = new Map<number | string, GraphEdge & { sample: number[] }>();
    for (const e of this.edges) {
      if (e.hidden) continue;
      if (q.kinds && !q.kinds.has(e.kind)) continue;
      const a = visibleAncestor(e.src);
      if (a === null) continue;
      const b = visibleAncestor(e.dst);
      if (b === null || a === b) continue;
      if (a > 0 && b > 0 && (isAncestor(a, b) || isAncestor(b, a))) continue;
      if ((a < 0 && b === -a) || (b < 0 && a === -b)) continue;
      let k = kindIndex.get(e.kind);
      if (k === undefined) { k = kindIndex.size; kindIndex.set(e.kind, k); }
      const key = numericKeys && k < 32 ? ((a + size) * base + (b + size)) * 64 + k * 2 + (e.verified ? 1 : 0) : `${a}|${b}|${e.kind}|${e.verified ? 1 : 0}`;
      const prev = rolled.get(key);
      if (prev) {
        prev.count += e.count;
        prev.confidence = Math.max(prev.confidence, e.confidence);
        if (!q.mapOnly && prev.sample.length < 3) prev.sample.push(e.id);
        if (prev.origin !== e.origin) prev.origin = 'misto';
        if (prev.id !== undefined) delete prev.id;
      } else {
        rolled.set(key, { id: e.id, src: a, dst: b, kind: e.kind as GraphEdge['kind'], verified: e.verified, confidence: e.confidence, count: e.count, evidence: [], origin: e.origin, sample: q.mapOnly ? [] : [e.id] });
      }
    }
    // A sample of evidence (at most three) for each rolled-up edge, read now for just these edges.
    const evidence = q.mapOnly ? null : this.evidence([...rolled.values()].flatMap((r) => r.sample));
    const edges: GraphEdge[] = [];
    for (const { sample, ...edge } of rolled.values()) {
      if (evidence) for (const id of sample) { const first = evidence.get(id)?.[0]; if (first) edge.evidence.push(first); }
      edges.push(edge);
    }
    return {
      nodes: [...visible.values(), ...rest.values()],
      edges,
      expanded: [...applied],
      view: q.view,
      topLevel: [...top].filter((id) => visible.has(id)),
      projects: [...this.projects.values()].filter(p => !q.mapOnly || visible.has(p.nodeId)),
    };
  }

  /** Evidence of some edges, read from the database: the cache does not keep it. */
  evidence(ids: number[]): Map<number, Evidence[]> {
    const out = new Map<number, Evidence[]>();
    if (!this.db || ids.length === 0) return out;
    for (let i = 0; i < ids.length; i += 5000) {
      const rows = this.db.all<{ id: number; evidence: string | null }>('SELECT id, evidence FROM edges WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(ids.slice(i, i + 5000)));
      for (const r of rows) out.set(r.id, parseEvidence(r.evidence));
    }
    return out;
  }

  /** Every edge touching a node, hidden ones included. */
  incident(id: number): CEdge[] {
    if (!this.incidence) {
      // Counting sort of edge indexes by endpoint: two passes, two typed arrays.
      const ids = new Map<number, number>();
      const slot = (n: number) => { let s = ids.get(n); if (s === undefined) { s = ids.size; ids.set(n, s); } return s; };
      const ends = new Int32Array(this.edges.length * 2);
      this.edges.forEach((e, i) => { ends[2 * i] = slot(e.src); ends[2 * i + 1] = e.dst === e.src ? -1 : slot(e.dst); });
      const start = new Int32Array(ids.size + 1);
      for (const s of ends) if (s >= 0) start[s + 1]++;
      for (let i = 0; i < ids.size; i++) start[i + 1] += start[i];
      const fill = start.slice(0, ids.size);
      const list = new Int32Array(start[ids.size]);
      for (let i = 0; i < ends.length; i++) if (ends[i] >= 0) list[fill[ends[i]]++] = i >> 1;
      this.incidence = { start, list };
      this.incidenceSlots = ids;
    }
    const s = this.incidenceSlots.get(id);
    if (s === undefined) return [];
    const { start, list } = this.incidence;
    const out: CEdge[] = [];
    for (let i = start[s]; i < start[s + 1]; i++) out.push(this.edges[list[i]]);
    return out;
  }
  private incidenceSlots = new Map<number, number>();

  /** After a user or agent edit of one edge: replace, add or (with null) remove it. */
  replaceEdge(id: number, e: CEdge | null): void {
    this.edgeEdits?.push([id, e]);
    const i = this.edges.findIndex((x) => x.id === id);
    if (e === null) { if (i >= 0) this.edges.splice(i, 1); }
    else if (i >= 0) this.edges[i] = e;
    else this.edges.push(e);
    this.incidence = null;
    let shown = 0, verified = 0;
    for (const x of this.edges) if (!x.hidden) { shown++; if (x.verified) verified++; }
    this.stats = { ...this.stats, edges: shown, verifiedEdges: verified, inferredEdges: shown - verified };
  }
}
