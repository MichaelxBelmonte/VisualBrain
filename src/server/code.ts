// The code of a repository for the "Dev" tab, read-only: the files Git knows (tracked and untracked, ignored ones left
// out, as an editor's explorer shows them), their state, one file's text, its changes against HEAD and a text search.
// Every path is relative to the repository and checked to stay inside it, symbolic links included.
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { open, realpath, stat, readdir } from 'node:fs/promises';
import { basename, isAbsolute, join, normalize, sep } from 'node:path';
import { promisify } from 'node:util';
import { globToRegExp } from './config.ts';
import { gitEnv } from './git.ts';
import type { CodeFile, CodeSearchHit, CodeTree } from '../shared/types.ts';

const run = promisify(execFile);
/** Files listed for one repository; a larger one is shown up to here, with a note. */
export const MAX_TREE = 100_000;
/** Text shown in the viewer; larger files are opened in an editor. */
export const MAX_FILE = 2 * 1024 * 1024;
const MAX_DIFF = 1024 * 1024, MAX_HITS = 400;

async function git(top: string, args: string[], timeout = 20_000): Promise<string> {
  return (await run('git', ['-C', top, ...args], { timeout, maxBuffer: 64 * 1024 * 1024, env: gitEnv() })).stdout;
}

/** A repository-relative path as written: not absolute, never climbing out with `..`. */
function relative(rel: string): string {
  const clean = normalize(rel);
  if (!rel || isAbsolute(rel) || clean === '..' || clean.startsWith('..' + sep) || rel.includes('\0')) throw new Error('Percorso non valido');
  return clean;
}

/** `rel` as an existing path inside `top`, or an error: no absolute paths, no `..`, no symbolic link leading outside. */
export async function insideRepo(top: string, rel: string): Promise<string> {
  const full = join(top, relative(rel));
  const [root, real] = await Promise.all([realpath(top), realpath(full)]);
  if (real !== root && !real.startsWith(root + sep)) throw new Error('Percorso fuori dal repository');
  return real;
}

/** Porcelain codes reduced to what the explorer colours: modified, added, deleted, renamed, untracked, conflict. */
function stateOf(xy: string): string {
  if (xy === '??') return 'U';
  if (xy.includes('U') || xy === 'AA' || xy === 'DD') return 'C';
  if (xy.includes('D')) return 'D';
  if (xy.includes('R')) return 'R';
  if (xy.includes('A')) return 'A';
  return 'M';
}

export async function codeTree(top: string, repository = true): Promise<CodeTree> {
  if (!repository) return localTree(top);
  const [listed, status, head] = await Promise.all([
    git(top, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--deduplicate']),
    git(top, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    git(top, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => ''),   // no commit yet
  ]);
  const files = listed.split('\0').filter(Boolean);
  const states: Record<string, string> = {};
  const recs = status.split('\0');
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    if (rec.length < 4) continue;
    const xy = rec.slice(0, 2);
    states[rec.slice(3)] = stateOf(xy);
    if (xy[0] === 'R' || xy[0] === 'C') i++;   // the original path follows a rename
  }
  const truncated = files.length > MAX_TREE;
  const branch = head.trim();
  return { top, git: true, branch: branch && branch !== 'HEAD' ? branch : null, files: truncated ? files.slice(0, MAX_TREE) : files, states, truncated };
}

const SKIP_DIRS = new Set(['.git', '.hg', '.svn', 'node_modules', 'vendor', 'target', '.build', 'dist', 'build', '__pycache__', '.venv', 'venv']);
/** Plain folders need no Git setup. Do not follow symlinks or descend into generated trees. */
async function localTree(top: string): Promise<CodeTree> {
  const files: string[] = [], pending = [''];
  let visited = 0, truncated = false;
  const deadline = Date.now() + 10_000;
  while (pending.length) {
    if (Date.now() > deadline || visited >= MAX_TREE) { truncated = true; break; }
    const rel = pending.pop()!;
    const dir = rel ? await insideRepo(top, rel) : top;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (++visited > MAX_TREE) { truncated = true; break; }
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) pending.push(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  return { top, git: false, branch: null, files: files.sort(), states: {}, truncated };
}

export async function localCodeSearch(top: string, query: string, secrets: string[]): Promise<{ hits: CodeSearchHit[]; truncated: boolean }> {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return { hits: [], truncated: false };
  const tree = await localTree(top), hits: CodeSearchHit[] = [];
  const deadline = Date.now() + 10_000;
  let bytes = 0;
  for (const path of tree.files) {
    if (Date.now() > deadline || bytes > 32 * 1024 * 1024) return { hits, truncated: true };
    const file = await codeFile(top, path, secrets).catch(() => null);
    if (file?.text === undefined) continue;
    bytes += file.size;
    const lines = file.text.split('\n');
    for (let i = 0; i < lines.length; i++) if (lines[i].toLowerCase().includes(q)) {
      if (hits.length >= MAX_HITS) return { hits, truncated: true };
      hits.push({ path, line: i + 1, text: lines[i].slice(0, 300) });
    }
  }
  return { hits, truncated: tree.truncated };
}

/** One file as text. Binary, oversized and secret files (credentials, keys: the index's secret patterns) come back without text. */
export async function codeFile(top: string, rel: string, secretPatterns: string[], reveal = false): Promise<CodeFile> {
  const full = await insideRepo(top, rel);
  const info = await stat(full);
  if (!info.isFile()) throw new Error('Non è un file');
  const base: CodeFile = { path: rel, size: info.size, mtime: info.mtimeMs };
  if (!reveal && secretPatterns.some((g) => globToRegExp(g).test(basename(rel)))) return { ...base, secret: true };
  if (info.size > MAX_FILE) return { ...base, tooLarge: true };
  const handle = await open(full, 'r');
  try {
    const buf = Buffer.alloc(info.size);
    await handle.read(buf, 0, info.size, 0);
    if (buf.subarray(0, 8192).includes(0)) return { ...base, binary: true };
    return { ...base, text: buf.toString('utf8') };
  } finally { await handle.close(); }
}

/** The file's changes against HEAD (staged and not); an untracked file has none to show: it is all new. */
export async function codeDiff(top: string, rel: string): Promise<{ diff: string; truncated: boolean }> {
  rel = relative(rel);   // not insideRepo: a deleted file has a diff too, and git itself refuses paths outside the repository
  let diff: string;
  try { diff = await git(top, ['diff', '--no-color', '--no-ext-diff', 'HEAD', '--', rel]); }
  catch { diff = await git(top, ['diff', '--no-color', '--no-ext-diff', '--cached', '--', rel]).catch(() => ''); }   // no commit yet
  return diff.length > MAX_DIFF ? { diff: diff.slice(0, MAX_DIFF), truncated: true } : { diff, truncated: false };
}

/** Lines containing `query` (plain text, case-insensitive) in the files the explorer shows. */
export async function codeSearch(top: string, query: string): Promise<{ hits: CodeSearchHit[]; truncated: boolean }> {
  const q = query.trim();
  if (q.length < 2) return { hits: [], truncated: false };
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', top, 'grep', '-n', '-I', '-i', '-F', '--untracked', '--exclude-standard', '--no-color', '-e', q], { env: gitEnv() });
    const hits: CodeSearchHit[] = [];
    let rest = '', truncated = false, err = '';
    const timer = setTimeout(() => { truncated = true; child.kill(); }, 15_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      const lines = (rest + chunk).split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) {
        const m = /^(.+?):(\d+):(.*)$/.exec(line);
        if (!m) continue;
        if (hits.length >= MAX_HITS) { truncated = true; child.kill(); return; }
        hits.push({ path: m[1], line: Number(m[2]), text: m[3].length > 300 ? m[3].slice(0, 300) + '…' : m[3] });
      }
    });
    child.stderr.on('data', (b) => { err += b; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      // 1 = no match; a kill after enough hits is not an error
      if (code !== 0 && code !== 1 && !truncated) reject(new Error(err.trim().split('\n')[0] || 'ricerca non riuscita'));
      else resolve({ hits, truncated });
    });
  });
}

/** VS Code or Cursor at the line, through their command line; otherwise the system's text editor. */
export function openInEditor(full: string, line?: number): string {
  const editors: [string, string][] = [
    ['Visual Studio Code', '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'],
    ['Cursor', '/Applications/Cursor.app/Contents/Resources/app/bin/cursor'],
  ];
  for (const [name, bin] of editors) {
    if (!existsSync(bin)) continue;
    spawn(bin, ['-g', line ? `${full}:${line}` : full], { stdio: 'ignore', detached: true, env: gitEnv() }).unref();
    return name;
  }
  spawn('open', ['-t', full], { stdio: 'ignore', detached: true }).unref();
  return 'TextEdit';
}
