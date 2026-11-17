// Project detection: roots, type, technologies, git remote; assignment of every node to its nearest project.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import type { Db } from './db.ts';

interface DirRow { id: number; path: string; name: string; parent_id: number | null; depth: number }

function readText(p: string, max = 512 * 1024): string | null {
  try {
    if (statSync(p).size > max) return null;
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function gitRemote(root: string): string | null {
  let gitDir = join(root, '.git');
  try {
    const st = statSync(gitDir);
    if (st.isFile()) {
      const m = /gitdir:\s*(.+)/.exec(readFileSync(gitDir, 'utf8'));
      if (!m) return null;
      gitDir = m[1].trim();
      if (!gitDir.startsWith('/')) gitDir = join(root, gitDir);
      // worktrees point inside <main>/.git/worktrees/<name>
      const wt = gitDir.indexOf('/.git/worktrees/');
      if (wt > 0) gitDir = gitDir.slice(0, wt + 5);
    }
  } catch {
    return null;
  }
  const cfg = readText(join(gitDir, 'config'));
  if (!cfg) return null;
  const m = /\[remote "origin"\][^[]*?url\s*=\s*(.+)/.exec(cfg);
  if (!m) return null;
  return m[1].trim().replace(/\/\/[^@/]+@/, '//');
}

function depsFromPackageJson(root: string): string[] {
  const txt = readText(join(root, 'package.json'));
  if (!txt) return [];
  try {
    const j = JSON.parse(txt);
    return [...Object.keys(j.dependencies ?? {}), ...Object.keys(j.devDependencies ?? {})];
  } catch {
    return [];
  }
}

function depsFromCargo(root: string): string[] {
  const txt = readText(join(root, 'Cargo.toml'));
  if (!txt) return [];
  const out: string[] = [];
  let inDeps = false;
  for (const line of txt.split('\n')) {
    const sec = /^\s*\[([^\]]+)\]/.exec(line);
    if (sec) { inDeps = /dependencies/.test(sec[1]); continue; }
    if (!inDeps) continue;
    const m = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

function depsFromRequirements(root: string): string[] {
  const out: string[] = [];
  for (const f of ['requirements.txt', 'requirements-dev.txt']) {
    const txt = readText(join(root, f));
    if (!txt) continue;
    for (const line of txt.split('\n')) {
      const m = /^\s*([A-Za-z0-9_.-]+)/.exec(line);
      if (m && !line.trim().startsWith('#') && !line.trim().startsWith('-')) out.push(m[1].toLowerCase());
    }
  }
  const py = readText(join(root, 'pyproject.toml'));
  if (py) {
    const m = /dependencies\s*=\s*\[([^\]]*)\]/s.exec(py);
    if (m) for (const d of m[1].matchAll(/"([A-Za-z0-9_.-]+)/g)) out.push(d[1].toLowerCase());
  }
  return out;
}

export function projectType(root: string): { type: string; markers: string[] } {
  const has = (f: string) => existsSync(join(root, f));
  const markers: string[] = [];
  for (const f of ['Cargo.toml', 'package.json', 'pyproject.toml', 'requirements.txt', 'setup.py', 'go.mod', 'Package.swift',
    'tauri.conf.json', 'appsscript.json', 'CLAUDE.md', 'AGENTS.md', 'Makefile', 'CMakeLists.txt', 'pubspec.yaml', 'manifest.json', '.git']) {
    if (has(f)) markers.push(f);
  }
  let type = 'folder';
  if (has('src-tauri') || has('tauri.conf.json')) type = 'tauri';
  else if (has('Cargo.toml')) type = 'rust';
  else if (has('package.json')) type = 'node';
  else if (has('pyproject.toml') || has('requirements.txt') || has('setup.py')) type = 'python';
  else if (has('go.mod')) type = 'go';
  else if (has('Package.swift')) type = 'swift';
  else if (has('appsscript.json')) type = 'appsscript';
  else if (has('manifest.json') && (has('background.js') || has('popup.html') || has('content.js'))) type = 'extension';
  else if (has('CMakeLists.txt')) type = 'cmake';
  else if (has('CLAUDE.md') || has('AGENTS.md')) type = 'brain';
  else if (has('.git')) type = 'git';
  return { type, markers };
}

/** Rebuilds the projects table from the directories classified as projects and assigns every node to its nearest project. */
export function detectProjects(db: Db, progress?: (m: string) => void): number {
  const dirs = db.all<DirRow>("SELECT id, path, name, parent_id, depth FROM nodes WHERE kind = 'dir' AND deleted = 0 AND cls = 'project' ORDER BY depth, path");
  const known = new Map<number, { id: number; label: string | null; description: string | null; area_id: number | null; technologies: string | null }>();
  for (const r of db.all<{ id: number; node_id: number; label: string | null; description: string | null; area_id: number | null; technologies: string | null }>('SELECT id, node_id, label, description, area_id, technologies FROM projects')) {
    known.set(r.node_id, { id: r.id, label: r.label, description: r.description, area_id: r.area_id, technologies: r.technologies });
  }
  const ins = db.prepare('INSERT INTO projects (node_id, name, type, remote, technologies) VALUES (?, ?, ?, ?, ?)');
  const upd = db.prepare('UPDATE projects SET name = ?, type = ?, remote = ?, technologies = ? WHERE id = ?');
  const seen = new Set<number>();
  db.tx(() => {
    for (const d of dirs) {
      const { type } = projectType(d.path);
      const remote = gitRemote(d.path);
      const deps = new Set<string>([...depsFromPackageJson(d.path), ...depsFromCargo(d.path), ...depsFromRequirements(d.path)]);
      const tech = [type, ...deps].filter((t) => t && t !== 'folder' && t !== 'git').slice(0, 60);
      const prev = known.get(d.id);
      if (prev) {
        // keep technologies added by seeds / LLM
        const merged = new Set<string>([...tech, ...(prev.technologies ? (JSON.parse(prev.technologies) as string[]) : [])]);
        upd.run(d.name, type, remote, JSON.stringify([...merged].slice(0, 80)), prev.id);
        seen.add(prev.id);
      } else {
        const r = ins.run(d.id, d.name, type, remote, JSON.stringify(tech));
        seen.add(Number(r.lastInsertRowid));
      }
    }
    // projects whose directory disappeared
    for (const r of db.all<{ id: number }>('SELECT p.id FROM projects p JOIN nodes n ON n.id = p.node_id WHERE n.deleted = 1 OR n.cls <> \'project\'')) {
      db.run('DELETE FROM projects WHERE id = ?', r.id);
    }
  });
  progress?.(`${dirs.length} progetti`);

  // nearest project for every node: walk nodes by depth so parents come first
  const projByNode = new Map<number, number>();
  for (const r of db.all<{ id: number; node_id: number }>('SELECT id, node_id FROM projects')) projByNode.set(r.node_id, r.id);
  const rows = db.all<{ id: number; parent_id: number | null; project_id: number | null }>("SELECT id, parent_id, project_id FROM nodes WHERE deleted = 0 AND kind IN ('file','dir','symlink') ORDER BY depth, id");
  const assigned = new Map<number, number | null>();
  const upd2 = db.prepare('UPDATE nodes SET project_id = ? WHERE id = ?');
  db.tx(() => {
    for (const r of rows) {
      const own = projByNode.get(r.id);
      const p = own ?? (r.parent_id === null ? null : (assigned.get(r.parent_id) ?? null));
      assigned.set(r.id, p);
      if (p !== r.project_id) upd2.run(p, r.id);
    }
  });
  return dirs.length;
}
