// In-memory graph used by the API: nodes, children by importance, edges, areas, projects. Reloaded after every index run.
import type { Db } from './db.ts';
import { globToRegExp, type Config } from './config.ts';
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
  evidence: Evidence[];
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
    confidence: Number(r.confidence), origin: String(r.origin), count: Number(r.count ?? 1), evidence: parseEvidence(r.evidence as string | null),
    hidden: Number(r.hidden) === 1,
  };
}

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

  load(db: Db, cfg: Config): void {
    const t0 = Date.now();
    this.nodes.clear();
    this.children.clear();
    this.roots = [];
    this.externals = [];
    const rows = db.all<Record<string, unknown>>(
      'SELECT id, path, name, kind, cls, lang, size, bytes, files, depth, mtime, importance, indeg, outdeg, project_id, area_id, aggregate, parent_id, child_count, summary, tags FROM nodes WHERE deleted = 0');
    for (const r of rows) {
      const n: CNode = {
        id: Number(r.id), path: String(r.path), name: String(r.name), kind: r.kind as CNode['kind'], cls: String(r.cls), lang: (r.lang as string | null) ?? null,
        size: Number(r.size), bytes: Number(r.bytes), files: Number(r.files), depth: Number(r.depth), mtime: Number(r.mtime), importance: Number(r.importance),
        indeg: Number(r.indeg), outdeg: Number(r.outdeg), projectId: (r.project_id as number | null) ?? null, areaId: (r.area_id as number | null) ?? null,
        aggregate: Number(r.aggregate) === 1, parentId: (r.parent_id as number | null) ?? null, childCount: Number(r.child_count),
        summary: (r.summary as string | null) ?? null, tags: r.tags ? (JSON.parse(String(r.tags)) as string[]) : undefined,
      };
      this.nodes.set(n.id, n);
      if (n.parentId === null) {
        if (n.kind === 'dir' && cfg.roots.includes(n.path)) this.roots.push(n.id);
        else if (n.kind === 'external') this.externals.push(n.id);
      } else {
        const arr = this.children.get(n.parentId);
        if (arr) arr.push(n.id); else this.children.set(n.parentId, [n.id]);
      }
    }
    for (const [pid, arr] of this.children) {
      arr.sort((a, b) => (this.nodes.get(b)!.importance - this.nodes.get(a)!.importance) || this.nodes.get(a)!.name.localeCompare(this.nodes.get(b)!.name));
      const p = this.nodes.get(pid);
      if (p) p.childCount = arr.length;
    }
    this.edges = db.all<Record<string, unknown>>('SELECT id, src, dst, kind, verified, confidence, origin, count, evidence, hidden FROM edges').map(rowToEdge);
    this.areas = db.all<{ id: number; name: string; description: string | null; origin: string; confidence: number | null }>('SELECT id, name, description, origin, confidence FROM areas')
      .map((a) => ({ ...a, nodeIds: [] }));
    const byArea = new Map(this.areas.map((a) => [a.id, a]));
    for (const n of this.nodes.values()) if (n.areaId !== null && n.areaId !== undefined) byArea.get(n.areaId)?.nodeIds.push(n.id);
    this.loadProjects(db, cfg);
    const count = (sql: string) => Number(db.get<{ c: number }>(sql)!.c);
    this.stats = {
      nodes: this.nodes.size,
      files: count("SELECT COUNT(*) c FROM nodes WHERE deleted = 0 AND kind = 'file'"),
      dirs: count("SELECT COUNT(*) c FROM nodes WHERE deleted = 0 AND kind = 'dir'"),
      edges: this.edges.filter((e) => !e.hidden).length,
      verifiedEdges: this.edges.filter((e) => !e.hidden && e.verified).length,
      inferredEdges: this.edges.filter((e) => !e.hidden && !e.verified).length,
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
    const visibleAncestor = (id: number): number | null => {
      let cur: number | null = id;
      let guard = 0;
      while (cur !== null && guard++ < 64) {
        if (visible.has(cur)) return cur;
        const parent: number | null = this.nodes.get(cur)?.parentId ?? null;
        if (parent !== null && applied.has(parent)) return rest.has(parent) ? -parent : parent;
        cur = parent;
      }
      return null;
    };
    const rolled = new Map<string, GraphEdge>();
    for (const e of this.edges) {
      if (e.hidden) continue;
      if (q.kinds && !q.kinds.has(e.kind)) continue;
      const a = visibleAncestor(e.src);
      const b = visibleAncestor(e.dst);
      if (a === null || b === null || a === b) continue;
      if (a > 0 && b > 0 && (this.isAncestor(a, b) || this.isAncestor(b, a))) continue;
      if ((a < 0 && b === -a) || (b < 0 && a === -b)) continue;
      const key = `${a}|${b}|${e.kind}|${e.verified ? 1 : 0}`;
      const prev = rolled.get(key);
      if (prev) {
        prev.count += e.count;
        prev.confidence = Math.max(prev.confidence, e.confidence);
        if (prev.evidence.length < 3 && e.evidence[0]) prev.evidence.push(e.evidence[0]);
        if (prev.origin !== e.origin) prev.origin = 'misto';
        if (prev.id !== undefined) delete prev.id;
      } else {
        rolled.set(key, { id: e.id, src: a, dst: b, kind: e.kind as GraphEdge['kind'], verified: e.verified, confidence: e.confidence, count: e.count, evidence: e.evidence.slice(0, 1), origin: e.origin });
      }
    }
    return {
      nodes: [...visible.values(), ...rest.values()],
      edges: [...rolled.values()],
      expanded: [...applied],
      view: q.view,
      topLevel: [...top].filter((id) => visible.has(id)),
      projects: [...this.projects.values()],
    };
  }
}
