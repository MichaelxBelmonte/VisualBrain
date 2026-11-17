// Imports hand-verified inventories from data/seed: dependencies (*.jsonl) and project descriptions (projects.json).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { Db } from './db.ts';
import { PROJECT_ROOT, type Config } from './config.ts';
import { loadIndex, normalizePath, getOrCreateExternal, resolveExisting, writeEdges, type EdgeDraft, type Index } from './graph.ts';
import { projectType } from './projects.ts';

const ALL_KINDS = ['imports', 'links', 'refpath', 'mention', 'symlink', 'duplicate', 'derived', 'shared_id', 'similar', 'semantic', 'manual', 'uses', 'policy', 'external'];

export function mapKind(raw: string): string {
  const k = String(raw ?? '').toLowerCase().trim();
  if (/^imports?\b/.test(k)) return 'imports';
  if (/^symlink/.test(k)) return 'symlink';
  if (/^(snapshot-of|git-worktree-of|contains-derived|built-from|bundled-copy-of|derived|clone)/.test(k)) return 'derived';
  if (/^(copy-of|copy|duplicate)/.test(k)) return /divers|partial|parzial|\d+ file|diff/.test(k) ? 'derived' : 'duplicate';
  if (/^(denies-read|allows-read|trusted-dir|permission|policy|allow|deny)/.test(k)) return 'policy';
  if (/^(links?|cites-source|cites)/.test(k)) return 'links';
  if (/^(refpath|mention|manual|external|semantic|similar|uses)\b/.test(k)) return k.split(/\s|\(/)[0];
  return 'uses';
}

function endpoint(db: Db, idx: Index, raw: unknown): number | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const s = raw.trim();
  if (s.startsWith('/') || s.startsWith('~') || s.startsWith('$HOME')) {
    const p = normalizePath(s, idx.home);
    const hit = resolveExisting(idx, p);
    if (hit) return hit.id;
    return getOrCreateExternal(db, idx, p);     // outside the roots, or a path that is gone: kept as an external identity
  }
  // virtual identities such as process:..., app:..., github:... are kept verbatim
  return getOrCreateExternal(db, idx, s);
}

interface SeedProject {
  path: string; name?: string; description?: string; area?: string; status?: string; copyOf?: string; technologies?: string[];
}

export function importSeeds(db: Db, cfg: Config, progress?: (m: string) => void): void {
  const dir = join(cfg.dataDir, 'seed');
  if (!existsSync(dir)) return;
  const idx = loadIndex(db, cfg);
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.jsonl'))) {
    const origin = `import:${basename(f, '.jsonl')}`;
    const drafts = new Map<string, EdgeDraft>();
    let bad = 0;
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let r: Record<string, unknown>;
      try { r = JSON.parse(line); } catch { bad++; continue; }
      const src = endpoint(db, idx, r.from);
      const dst = endpoint(db, idx, r.to);
      if (src === null || dst === null || src === dst) { bad++; continue; }
      const rawKind = String(r.kind ?? 'uses');
      const kind = mapKind(rawKind);
      const evidence = typeof r.evidence === 'string' ? r.evidence : JSON.stringify(r.evidence ?? '');
      const note = evidence.startsWith('[') ? evidence : `[${rawKind}] ${evidence}`;
      const conf = typeof r.confidence === 'number' ? Math.max(0, Math.min(1, r.confidence)) : 1;
      const key = `${src}|${dst}|${kind}`;
      const prev = drafts.get(key);
      if (prev) { prev.count++; if ((prev.evidence.notes as string[]).length < 4) (prev.evidence.notes as string[]).push(note); }
      else drafts.set(key, { src, dst, kind, verified: 1, confidence: conf, evidence: { note, notes: [], source: String(r.origin ?? basename(f, '.jsonl')) }, origin, count: 1 });
    }
    const n = writeEdges(db, drafts, origin, ALL_KINDS);
    progress?.(`${f}: ${n} relazioni importate${bad ? `, ${bad} righe scartate` : ''}`);
  }

  const pj = join(dir, 'projects.json');
  if (!existsSync(pj)) return;
  let list: SeedProject[] = [];
  try { list = JSON.parse(readFileSync(pj, 'utf8')); } catch { progress?.('projects.json non leggibile'); return; }
  const drafts = new Map<string, EdgeDraft>();
  let n = 0;
  db.tx(() => {
    for (const p of list) {
      if (!p || typeof p.path !== 'string') continue;
      const path = normalizePath(p.path, idx.home);
      const id = resolveExisting(idx, path)?.id;
      if (id === undefined) continue;
      const node = idx.byId.get(id)!;
      if (node.kind !== 'dir') continue;
      let row = db.get<{ id: number; technologies: string | null }>('SELECT id, technologies FROM projects WHERE node_id = ?', id);
      if (!row) {
        const { type } = projectType(path);
        const r = db.run('INSERT INTO projects (node_id, name, type, technologies) VALUES (?, ?, ?, ?)', id, node.name, type, '[]');
        row = { id: Number(r.lastInsertRowid), technologies: '[]' };
      }
      const tech = new Set<string>([...(row.technologies ? JSON.parse(row.technologies) as string[] : []), ...(p.technologies ?? [])]);
      let areaId: number | null = null;
      if (p.area) {
        db.run("INSERT INTO areas (name, origin) VALUES (?, 'seed') ON CONFLICT(name) DO NOTHING", p.area);
        areaId = db.get<{ id: number }>('SELECT id FROM areas WHERE name = ?', p.area)!.id;
      }
      db.run('UPDATE projects SET label = COALESCE(?, label), description = COALESCE(?, description), technologies = ?, status = COALESCE(?, status), area_id = COALESCE(?, area_id) WHERE id = ?',
        p.name ?? null, p.description ?? null, JSON.stringify([...tech]), p.status ?? null, areaId, row.id);
      if (areaId !== null) db.run('UPDATE nodes SET area_id = ? WHERE id = ?', areaId, id);
      if (p.description) db.run('UPDATE nodes SET summary = COALESCE(summary, ?) WHERE id = ?', p.description, id);
      if (p.copyOf) {
        const live = resolveExisting(idx, normalizePath(p.copyOf, idx.home))?.id;
        if (live !== undefined && live !== id) {
          drafts.set(`${id}|${live}|duplicate`, { src: id, dst: live, kind: 'duplicate', verified: 1, confidence: 1, evidence: { note: `copia di ${p.copyOf} (inventario)` }, origin: 'import:projects', count: 1 });
        }
      }
      n++;
    }
  });
  writeEdges(db, drafts, 'import:projects', ['duplicate']);
  progress?.(`projects.json: ${n} progetti descritti`);
}
