// File classes and languages from names; folder roles from their content.
import { globToRegExp } from './config.ts';

export const TEXT_CLASSES = new Set(['code', 'doc', 'config', 'notebook']);
export const DATA_CLASSES = new Set(['data', 'sheet', 'archive', 'binary', 'image', 'video', 'audio', 'font', 'log']);
export const MEDIA_CLASSES = new Set(['image', 'video', 'audio']);

const LANG: Record<string, string> = {
  py: 'python', pyw: 'python', pyi: 'python',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript',
  gs: 'appsscript', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', swift: 'swift',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', cu: 'cuda', cuh: 'cuda',
  m: 'objc', mm: 'objc', rb: 'ruby', php: 'php', sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
  ps1: 'powershell', sql: 'sql', r: 'r', scala: 'scala', lua: 'lua', pl: 'perl', vue: 'vue', svelte: 'svelte',
  dart: 'dart', cs: 'csharp', ex: 'elixir', exs: 'elixir', hs: 'haskell', clj: 'clojure', cmake: 'cmake',
  mk: 'make', applescript: 'applescript', scpt: 'applescript', html: 'html', htm: 'html', css: 'css', scss: 'scss',
  less: 'less', md: 'markdown', mdx: 'markdown', rst: 'rst', txt: 'text', tex: 'latex', json: 'json', jsonl: 'jsonl',
  ndjson: 'jsonl', yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini', cfg: 'ini', conf: 'ini', plist: 'plist',
  xml: 'xml', svg: 'svg', ipynb: 'notebook', csv: 'csv', tsv: 'csv', sqlite: 'sqlite', db: 'sqlite', sqlite3: 'sqlite',
  log: 'log', env: 'env', dockerfile: 'docker', proto: 'protobuf', graphql: 'graphql', wasm: 'wasm',
};

const CLASS: Record<string, string> = {
  // code
  py: 'code', pyw: 'code', pyi: 'code', js: 'code', mjs: 'code', cjs: 'code', jsx: 'code', ts: 'code', mts: 'code',
  cts: 'code', tsx: 'code', gs: 'code', rs: 'code', go: 'code', java: 'code', kt: 'code', swift: 'code', c: 'code',
  h: 'code', cpp: 'code', cc: 'code', cxx: 'code', hpp: 'code', hh: 'code', hxx: 'code', cu: 'code', cuh: 'code',
  m: 'code', mm: 'code', rb: 'code', php: 'code', sh: 'code', bash: 'code', zsh: 'code', fish: 'code', ps1: 'code',
  sql: 'code', r: 'code', scala: 'code', lua: 'code', pl: 'code', vue: 'code', svelte: 'code', dart: 'code',
  cs: 'code', ex: 'code', exs: 'code', hs: 'code', clj: 'code', cmake: 'code', mk: 'code', applescript: 'code',
  scpt: 'code', css: 'code', scss: 'code', less: 'code', proto: 'code', graphql: 'code',
  // docs
  md: 'doc', mdx: 'doc', rst: 'doc', txt: 'doc', tex: 'doc', html: 'doc', htm: 'doc', pdf: 'doc', doc: 'doc',
  docx: 'doc', odt: 'doc', pages: 'doc', rtf: 'doc', epub: 'doc', ppt: 'doc', pptx: 'doc', key: 'doc',
  // config
  yaml: 'config', yml: 'config', toml: 'config', ini: 'config', cfg: 'config', conf: 'config', plist: 'config',
  lock: 'config', editorconfig: 'config', properties: 'config',
  // data
  csv: 'data', tsv: 'data', jsonl: 'data', ndjson: 'data', xml: 'data', parquet: 'data', feather: 'data',
  arrow: 'data', sqlite: 'data', db: 'data', sqlite3: 'data', pkl: 'data', pickle: 'data', npy: 'data', npz: 'data',
  xls: 'sheet', xlsx: 'sheet', xlsm: 'sheet', ods: 'sheet', numbers: 'sheet',
  gz: 'archive', zip: 'archive', tar: 'archive', tgz: 'archive', '7z': 'archive', rar: 'archive', bz2: 'archive',
  xz: 'archive', dmg: 'archive', pkg: 'archive', whl: 'archive',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', svg: 'image', webp: 'image', heic: 'image', bmp: 'image',
  tiff: 'image', tif: 'image', ico: 'image', psd: 'image', icns: 'image',
  mp4: 'video', mov: 'video', avi: 'video', mkv: 'video', webm: 'video', m4v: 'video',
  mp3: 'audio', wav: 'audio', m4a: 'audio', aac: 'audio', flac: 'audio', ogg: 'audio',
  ttf: 'font', otf: 'font', woff: 'font', woff2: 'font',
  log: 'log', ipynb: 'notebook',
  o: 'binary', so: 'binary', dylib: 'binary', dll: 'binary', a: 'binary', exe: 'binary', bin: 'binary', node: 'binary',
  pyc: 'binary', pcm: 'binary', class: 'binary', jar: 'binary', wasm: 'binary', d: 'binary', obj: 'binary',
  lib: 'binary', pdb: 'binary', rlib: 'binary', rmeta: 'binary',
};

const CONFIG_JSON = [
  'package.json', 'package-lock.json', 'tsconfig.json', 'jsconfig.json', 'composer.json', 'manifest.json',
  'settings.json', 'settings.local.json', 'brain.config.json', 'tauri.conf.json', 'renovate.json', 'vercel.json',
  'app.json', 'extensions.json', 'launch.json', 'tasks.json', 'mcp.json', '.mcp.json', 'config.json', 'credentials.json',
];
const CONFIG_JSON_SUFFIX = ['.config.json', '.code-workspace', 'rc.json'];

const SPECIAL: Record<string, [string, string]> = {
  'dockerfile': ['config', 'docker'], 'makefile': ['code', 'make'], 'cmakelists.txt': ['code', 'cmake'],
  'readme': ['doc', 'text'], 'license': ['doc', 'text'], 'licence': ['doc', 'text'], 'changelog': ['doc', 'text'],
  'notice': ['doc', 'text'], 'authors': ['doc', 'text'], 'procfile': ['config', 'text'], 'pipfile': ['config', 'toml'],
  'gemfile': ['config', 'ruby'], 'rakefile': ['code', 'ruby'], 'justfile': ['code', 'make'],
  '.gitignore': ['config', 'text'], '.gitattributes': ['config', 'text'], '.gitmodules': ['config', 'ini'],
  '.editorconfig': ['config', 'ini'], '.prettierrc': ['config', 'json'], '.eslintrc': ['config', 'json'],
  '.babelrc': ['config', 'json'], '.nvmrc': ['config', 'text'], '.python-version': ['config', 'text'],
  '.tool-versions': ['config', 'text'], '.dockerignore': ['config', 'text'], '.npmrc': ['secret', 'text'],
  '.localized': ['other', 'text'], '.ds_store': ['other', 'binary'],
};

export const PROJECT_MARKERS = [
  '.git', 'package.json', 'Cargo.toml', 'pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg', 'go.mod',
  'CLAUDE.md', 'AGENTS.md', 'Package.swift', 'pubspec.yaml', 'composer.json', 'Gemfile', 'build.gradle', 'pom.xml',
  'tauri.conf.json', 'Makefile', 'CMakeLists.txt', 'appsscript.json', 'manifest.json', 'Pipfile', 'environment.yml',
];

export interface FileClass {
  ext: string;
  cls: string;
  lang: string | null;
}

let secretRes: RegExp[] | null = null;

export function setSecretPatterns(globs: string[]): void {
  secretRes = globs.map(globToRegExp);
}

export function isSecretName(name: string): boolean {
  if (!secretRes) return false;
  return secretRes.some((re) => re.test(name));
}

export function classifyFile(name: string): FileClass {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  const ext = dot > 0 ? lower.slice(dot + 1) : (lower.startsWith('.') ? lower.slice(1) : '');
  if (isSecretName(name)) return { ext, cls: 'secret', lang: null };
  const special = SPECIAL[lower];
  if (special) return { ext, cls: special[0], lang: special[1] };
  if (ext === 'json') {
    const isConfig = CONFIG_JSON.includes(lower) || CONFIG_JSON_SUFFIX.some((s) => lower.endsWith(s));
    return { ext, cls: isConfig ? 'config' : 'data', lang: 'json' };
  }
  const cls = CLASS[ext];
  const lang = LANG[ext] ?? null;
  if (cls) return { ext, cls, lang };
  if (ext === '') return { ext, cls: 'other', lang: null };
  return { ext, cls: 'other', lang };
}

export interface DirStats {
  files: number;
  bytes: number;
  childCount: number;
  dataFiles: number;
  mediaFiles: number;
  codeFiles: number;
  docFiles: number;
  markers: string[];
}

export function emptyDirStats(): DirStats {
  return { files: 0, bytes: 0, childCount: 0, dataFiles: 0, mediaFiles: 0, codeFiles: 0, docFiles: 0, markers: [] };
}

/** Folder role: project, dump (data), media, vendor or plain folder. */
export function classifyDir(stats: DirStats, opts: { vendor: boolean; dumpMinFiles: number; dumpDataShare: number }): string {
  if (opts.vendor) return 'vendor';
  if (stats.markers.length > 0) return 'project';
  if (stats.files >= opts.dumpMinFiles) {
    if (stats.dataFiles / stats.files >= opts.dumpDataShare) return 'dump';
    if (stats.mediaFiles / stats.files >= 0.8) return 'media';
  } else if (stats.files >= 20 && stats.mediaFiles / stats.files >= 0.8) {
    return 'media';
  }
  return 'folder';
}
