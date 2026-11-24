// "Codice", in the Dev tab: a repository read like an editor. Explorer (files Git knows, coloured by their state), file
// search by name (⌘P) and text search across the repository (⌘⇧F), open files in tabs with highlighted code and line
// numbers, a file's changes against HEAD, and the way out to a real editor or to the map. Nothing here writes a file.
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import scss from 'highlight.js/lib/languages/scss';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { api } from './api.ts';
import { t as tr, ui } from './i18n.ts';
import type { CodeFile, CodeSearchHit, CodeTree } from '../shared/types.ts';

for (const [name, lang] of Object.entries({ bash, c, cpp, css, diff, dockerfile, go, ini, java, javascript, json, kotlin, markdown, php, python, ruby, rust, scss, sql, swift, typescript, xml, yaml })) hljs.registerLanguage(name, lang);

const esc = (s: string) => s.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const REFRESH_MS = 15_000, MAX_TABS = 12, MAX_MATCHES = 150;
/** Larger texts are shown plain: highlighting them would hold the window for seconds. */
const MAX_HIGHLIGHT = 400_000;

const BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', gs: 'javascript',
  py: 'python', json: 'json', jsonc: 'json', css: 'css', scss: 'scss', sass: 'scss', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', plist: 'xml',
  md: 'markdown', markdown: 'markdown', sh: 'bash', bash: 'bash', zsh: 'bash', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', kts: 'kotlin',
  yml: 'yaml', yaml: 'yaml', sql: 'sql', swift: 'swift', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', m: 'cpp', mm: 'cpp',
  rb: 'ruby', php: 'php', diff: 'diff', patch: 'diff', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', env: 'ini',
};
export function languageOf(path: string): string | null {
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (/^dockerfile/i.test(name)) return 'dockerfile';
  if (name === 'Makefile' || name === '.zshrc' || name === '.bashrc') return 'bash';
  const dot = name.lastIndexOf('.');
  return dot > 0 || (dot === 0 && name.length > 1) ? BY_EXT[name.slice(dot + 1).toLowerCase()] ?? null : null;
}

/** Highlighted HTML of a whole text (spans may cross lines: the gutter is a separate column). */
export function highlight(text: string, lang: string | null): string {
  if (!lang || text.length > MAX_HIGHLIGHT) return esc(text);
  try { return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value; } catch { return esc(text); }
}

/** Files whose path contains the query's characters in order; a hit in the file name, then a shorter path, ranks first. */
export function matchFiles(files: string[], query: string, limit = MAX_MATCHES): string[] {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return [];
  const scored: [number, string][] = [];
  for (const f of files) {
    const p = f.toLowerCase();
    let at = 0, gaps = 0, last = -1;
    for (const ch of q) {
      const i = p.indexOf(ch, at);
      if (i < 0) { at = -1; break; }
      if (last >= 0 && i > last + 1) gaps++;
      last = i; at = i + 1;
    }
    if (at < 0) continue;
    const name = p.slice(p.lastIndexOf('/') + 1);
    const score = (name.includes(q) ? 0 : p.includes(q) ? 1000 : 2000) + gaps * 50 + p.length;
    scored.push([score, f]);
  }
  return scored.sort((a, b) => a[0] - b[0] || collator.compare(a[1], b[1])).slice(0, limit).map(x => x[1]);
}

interface Dir { dirs: Map<string, Dir>; files: string[] }
/** The explorer's folders from the flat list: folders first, then files, by name. */
export function buildTree(files: string[]): Dir {
  const root: Dir = { dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.split('/');
    let d = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let next = d.dirs.get(parts[i]);
      if (!next) { next = { dirs: new Map(), files: [] }; d.dirs.set(parts[i], next); }
      d = next;
    }
    d.files.push(parts[parts.length - 1]);
  }
  return root;
}

const STATE_LABEL: Record<string, string> = { M: 'modificato', A: 'aggiunto', D: 'eliminato', R: 'rinominato', U: 'nuovo, non in Git', C: 'in conflitto' };

/** `mark`: the line a search result or a link pointed at, kept highlighted; `jump`: scroll to it on the next render. */
interface Tab { path: string; file?: CodeFile; error?: string; diff?: string | null; showDiff: boolean; mark?: number; jump?: boolean; scroll?: number; reveal?: boolean }

export function mountCodeView(root: HTMLElement, cb: { reveal(path: string): void }): (node: number | null, visible: boolean) => void {
  let node: number | null = null, visible = false, version = 0, timer: number | undefined;
  let tree: CodeTree | null = null, dirs: Dir | null = null, changedDirs = new Set<string>(), error = '';
  let expanded = new Set<string>(), filter = '', mode: 'files' | 'search' = 'files';
  let query = '', hits: CodeSearchHit[] = [], hitsTruncated = false, searching = false, searchVersion = 0;
  let tabs: Tab[] = [], active: string | null = null;
  root.classList.add('code-view');
  root.innerHTML = ui`<aside class="code-side"><div class="code-side-tabs" role="tablist"><button data-mode="files" role="tab">File</button><button data-mode="search" role="tab">Cerca</button></div><div class="code-side-tools"><input class="code-filter" type="search" placeholder="Cerca file per nome (⌘P)" aria-label="Cerca file per nome"><input class="code-query hidden" type="search" placeholder="Cerca nel codice (⌘⇧F)" aria-label="Cerca nel codice"></div><div class="code-explorer" role="tree"></div></aside><section class="code-main"><div class="code-tabs" role="tablist"></div><div class="code-pathbar"></div><div class="code-body"></div></section>`;
  const explorer = root.querySelector<HTMLElement>('.code-explorer')!, filterInput = root.querySelector<HTMLInputElement>('.code-filter')!;
  const queryInput = root.querySelector<HTMLInputElement>('.code-query')!, body = root.querySelector<HTMLElement>('.code-body')!;

  const loadTree = async () => {
    if (node === null) return;
    const mine = ++version, id = node;
    try {
      const next = await api.codeTree(id);
      if (mine !== version) return;
      const same = tree && tree.files.length === next.files.length && tree.files.every((f, i) => f === next.files[i]);
      tree = next; error = '';
      if (!same) dirs = buildTree(next.files);
      changedDirs = new Set();
      for (const p of Object.keys(next.states)) for (let i = p.indexOf('/'); i >= 0; i = p.indexOf('/', i + 1)) changedDirs.add(p.slice(0, i));
    } catch (e) { if (mine === version) { error = String(e instanceof Error ? e.message : e); tree = null; dirs = null; } }
    renderExplorer(); renderTabs();
    // what an agent changes in the open file shows up without reopening it
    const tab = tabs.find(t => t.path === active);
    if (tab?.file?.text !== undefined && tab.file.size < 300_000) void openFile(tab.path, { quiet: true });
  };

  function renderExplorer(): void {
    root.querySelectorAll<HTMLElement>('[data-mode]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.mode === mode)));
    filterInput.classList.toggle('hidden', mode !== 'files'); queryInput.classList.toggle('hidden', mode !== 'search');
    if (error) { explorer.innerHTML = ui`<p class="code-note" role="alert">${esc(error)}</p>`; return; }
    if (!tree || !dirs) { explorer.innerHTML = ui`<p class="code-note">${node === null ? tr('Scegli una cartella o un progetto.') : tr('Caricamento…')}</p>`; return; }
    if (mode === 'search') { renderHits(); return; }
    const states = tree.states;
    const fileRow = (path: string, depth: number, label = path.slice(path.lastIndexOf('/') + 1), extra = '') => {
      const st = states[path];
      return `<button class="code-row file${st ? ' st-' + st : ''}${path === active ? ' active' : ''}" data-file="${esc(path)}" style="--depth:${depth}" title="${esc(path)}${st ? ' · ' + esc(tr(STATE_LABEL[st])) : ''}" role="treeitem"><span class="code-icon">${esc(iconOf(path))}</span><span class="code-name">${esc(label)}</span>${extra}${st ? `<span class="code-state">${st}</span>` : ''}</button>`;
    };
    if (filter) {
      const found = matchFiles(tree.files, filter);
      explorer.innerHTML = found.map(p => fileRow(p, 0, p.slice(p.lastIndexOf('/') + 1), `<span class="code-dir">${p.includes('/') ? '&lrm;' + esc(p.slice(0, p.lastIndexOf('/'))) : ''}</span>`)).join('') || ui`<p class="code-note">Nessun file corrisponde.</p>`;
      return;
    }
    const out: string[] = [];
    const walk = (d: Dir, prefix: string, depth: number) => {
      for (const name of [...d.dirs.keys()].sort(collator.compare)) {
        const path = prefix + name, open = expanded.has(path);
        out.push(`<button class="code-row dir${changedDirs.has(path) ? ' changed' : ''}" data-dir="${esc(path)}" style="--depth:${depth}" aria-expanded="${open}" role="treeitem"><span class="code-icon">${open ? '▾' : '▸'}</span><span class="code-name">${esc(name)}</span></button>`);
        if (open) walk(d.dirs.get(name)!, path + '/', depth + 1);
      }
      for (const name of [...d.files].sort(collator.compare)) out.push(fileRow(prefix + name, depth));
    };
    walk(dirs, '', 0);
    explorer.innerHTML = (tree.truncated ? ui`<p class="code-note">Elenco parziale: ${tree.files.length} file.</p>` : '') + (out.join('') || ui`<p class="code-note">Nessun file.</p>`);
  }

  function renderHits(): void {
    if (searching) { explorer.innerHTML = ui`<p class="code-note">Ricerca…</p>`; return; }
    if (query.trim().length < 2) { explorer.innerHTML = ui`<p class="code-note">Scrivi almeno due caratteri: cerca il testo in tutti i file della cartella, maiuscole e minuscole uguali.</p>`; return; }
    if (!hits.length) { explorer.innerHTML = ui`<p class="code-note">Nessun risultato.</p>`; return; }
    const byFile = new Map<string, CodeSearchHit[]>();
    for (const h of hits) { const l = byFile.get(h.path); if (l) l.push(h); else byFile.set(h.path, [h]); }
    const q = query.trim().toLowerCase();
    const mark = (text: string) => { const i = text.toLowerCase().indexOf(q); return i < 0 ? esc(text.trim()) : esc(text.slice(0, i).trimStart()) + `<mark>${esc(text.slice(i, i + q.length))}</mark>` + esc(text.slice(i + q.length)); };
    explorer.innerHTML = ui`<p class="code-note">${hits.length}${hitsTruncated ? '+' : ''} risultati in ${byFile.size} file</p>` + [...byFile].map(([path, list]) => `<div class="code-hit-file" title="${esc(path)}"><span class="code-icon">${esc(iconOf(path))}</span>${esc(path)}</div>` + list.map(h => `<button class="code-hit" data-file="${esc(path)}" data-line="${h.line}"><span class="code-hit-line">${h.line}</span><span class="code-hit-text">${mark(h.text)}</span></button>`).join('')).join('');
  }

  async function search(): Promise<void> {
    if (node === null) return;
    const mine = ++searchVersion, q = query.trim();
    if (q.length < 2) { hits = []; searching = false; renderHits(); return; }
    searching = true; renderHits();
    try { const r = await api.codeSearch(node, q); if (mine !== searchVersion) return; hits = r.hits; hitsTruncated = r.truncated; }
    catch (e) { if (mine !== searchVersion) return; hits = []; explorer.innerHTML = ui`<p class="code-note" role="alert">${esc(String(e instanceof Error ? e.message : e))}</p>`; searching = false; return; }
    searching = false; renderHits();
  }

  function renderTabs(): void {
    const el = root.querySelector<HTMLElement>('.code-tabs')!;
    el.innerHTML = tabs.map(t => { const st = tree?.states[t.path]; return `<div class="code-tab${t.path === active ? ' active' : ''}${st ? ' st-' + st : ''}" role="tab" aria-selected="${t.path === active}"><button class="code-tab-open" data-tab="${esc(t.path)}" title="${esc(t.path)}">${esc(t.path.slice(t.path.lastIndexOf('/') + 1))}</button><button class="code-tab-close" data-close="${esc(t.path)}" aria-label="${esc(tr('Chiudi'))}">×</button></div>`; }).join('');
  }

  function renderFile(keepScroll = false): void {
    const bar = root.querySelector<HTMLElement>('.code-pathbar')!;
    const tab = tabs.find(t => t.path === active);
    if (!tab) {
      bar.innerHTML = '';
      body.innerHTML = tree ? ui`<div class="code-welcome"><strong>${esc(tree.top.split('/').pop() || tree.top)}</strong><span>${tree.branch ? ui`⎇ ${esc(tree.branch)} · ` : ''}${tree.git === false ? tr('Cartella locale · ') : ''}${tree.files.length} file${Object.keys(tree.states).length ? ui` · ${Object.keys(tree.states).length} modificati` : ''}</span><span class="muted">Apri un file dall’elenco, ⌘P per cercarlo per nome, ⌘⇧F per cercare nel codice.</span></div>` : '';
      return;
    }
    const st = tree?.states[tab.path];
    const crumbs = tab.path.split('/').map(esc).join('<span class="code-sep">/</span>');
    bar.innerHTML = ui`<span class="code-crumbs" title="${esc(tab.path)}">${crumbs}</span>${st ? ui`<span class="tag code-badge st-${st}">${esc(tr(STATE_LABEL[st]))}</span>` : ''}<span class="code-actions">${st && st !== 'U' ? ui`<button class="btn small ${tab.showDiff ? 'active' : ''}" data-diff aria-pressed="${tab.showDiff}" title="Le modifiche rispetto all’ultimo commit">Modifiche</button>` : ''}<button class="btn small ghost" data-editor title="Apri il file nell’editor (VS Code o Cursor), alla riga scelta">Apri nell’editor</button><button class="btn small ghost" data-map title="Mostra il file nella mappa">Mappa</button><button class="btn small ghost" data-copy title="Copia il percorso">Copia percorso</button></span>`;
    const scroller = body.querySelector<HTMLElement>('.code-scroll');
    const previous = keepScroll && scroller ? scroller.scrollTop : null;
    if (tab.error) { body.innerHTML = ui`<p class="code-note" role="alert">${esc(tab.error)}</p>`; return; }
    if (!tab.file) { body.innerHTML = ui`<p class="code-note">Caricamento…</p>`; return; }
    if (tab.showDiff) {
      if (tab.diff === undefined) { body.innerHTML = ui`<p class="code-note">Caricamento…</p>`; return; }
      if (!tab.diff) { body.innerHTML = ui`<p class="code-note">Nessuna modifica rispetto all’ultimo commit.</p>`; return; }
      const lines = tab.diff.split('\n');
      body.innerHTML = `<div class="code-scroll"><pre class="code-diff">${lines.map(l => `<span class="${l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : l.startsWith('@@') ? 'hunk' : ''}">${esc(l)}</span>`).join('\n')}</pre></div>`;
      return;
    }
    const f = tab.file;
    if (f.secret) { body.innerHTML = ui`<div class="code-welcome"><strong>File riservato</strong><span class="muted">Il nome corrisponde ai file di credenziali e chiavi che l’indice non legge.</span><button class="btn small" data-reveal>Mostra comunque</button></div>`; return; }
    if (f.binary) { body.innerHTML = ui`<div class="code-welcome"><strong>File binario</strong><span class="muted">${fmtSize(f.size)} · si apre con un’altra applicazione.</span></div>`; return; }
    if (f.tooLarge) { body.innerHTML = ui`<div class="code-welcome"><strong>File troppo grande per l’anteprima</strong><span class="muted">${fmtSize(f.size)} · aprilo nell’editor.</span></div>`; return; }
    const text = f.text ?? '';
    const count = text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
    const gutter = Array.from({ length: Math.max(1, count) }, (_, i) => i + 1).join('\n');
    body.innerHTML = `<div class="code-scroll"><div class="code-lines"><pre class="code-gutter" aria-hidden="true">${gutter}</pre><pre class="code-text hljs"><code>${highlight(text, languageOf(f.path))}</code></pre><div class="code-mark hidden"></div></div></div>`;
    const s = body.querySelector<HTMLElement>('.code-scroll')!;
    if (tab.mark) markLine(tab.mark, Boolean(tab.jump));
    if (tab.jump) tab.jump = false;
    else if (previous !== null) s.scrollTop = previous;
    else if (tab.scroll) s.scrollTop = tab.scroll;
    s.addEventListener('scroll', () => { tab.scroll = s.scrollTop; }, { passive: true });
  }

  function markLine(line: number, scroll: boolean): void {
    const pre = body.querySelector<HTMLElement>('.code-text'), mark = body.querySelector<HTMLElement>('.code-mark'), s = body.querySelector<HTMLElement>('.code-scroll');
    if (!pre || !mark || !s) return;
    const style = getComputedStyle(pre), lh = parseFloat(style.lineHeight) || 19, top = pre.offsetTop + (parseFloat(style.paddingTop) || 0) + (line - 1) * lh;
    mark.style.top = `${top}px`; mark.style.height = `${lh}px`; mark.classList.remove('hidden');
    if (scroll) s.scrollTop = Math.max(0, top - s.clientHeight / 3);
  }

  async function openFile(path: string, opts: { line?: number; quiet?: boolean; reveal?: boolean } = {}): Promise<void> {
    if (node === null) return;
    let tab = tabs.find(t => t.path === path);
    if (!tab) {
      if (opts.quiet) return;
      tab = { path, showDiff: false };
      tabs.push(tab);
      if (tabs.length > MAX_TABS) tabs.splice(tabs.findIndex(t => t.path !== path), 1);
    }
    if (!opts.quiet) {
      active = path;
      if (opts.line) { tab.mark = opts.line; tab.jump = true; tab.showDiff = false; }
      for (let i = path.indexOf('/'); i >= 0; i = path.indexOf('/', i + 1)) expanded.add(path.slice(0, i));
      renderTabs(); renderExplorer(); renderFile();
      explorer.querySelector<HTMLElement>(`.code-row.active`)?.scrollIntoView({ block: 'nearest' });
    }
    const id = node;
    if (opts.reveal) tab.reveal = true;
    try {
      const file = await api.codeFile(id, path, tab.reveal);
      if (node !== id) return;
      const unchanged = opts.quiet && tab.file?.text === file.text && tab.file?.mtime === file.mtime;
      tab.file = file; tab.error = undefined;
      if (opts.quiet && tab.showDiff) tab.diff = await api.codeDiff(id, path).then(d => d.diff).catch(() => tab!.diff);
      if (!unchanged && active === path) renderFile(opts.quiet);
    } catch (e) {
      if (opts.quiet) return;   // gone meanwhile: the next refresh tells
      tab.error = String(e instanceof Error ? e.message : e);
      if (active === path) renderFile();
    }
  }

  function closeTab(path: string): void {
    const i = tabs.findIndex(t => t.path === path);
    if (i < 0) return;
    tabs.splice(i, 1);
    if (active === path) active = tabs[Math.min(i, tabs.length - 1)]?.path ?? null;
    renderTabs(); renderExplorer(); renderFile();
  }

  root.addEventListener('click', e => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-mode],[data-dir],[data-file],[data-tab],[data-close],[data-diff],[data-editor],[data-map],[data-copy],[data-reveal]');
    if (!t || node === null) return;
    const tab = tabs.find(x => x.path === active);
    if (t.dataset.mode) { mode = t.dataset.mode as typeof mode; renderExplorer(); (mode === 'files' ? filterInput : queryInput).focus(); }
    else if (t.dataset.dir !== undefined) { const p = t.dataset.dir; if (expanded.has(p)) expanded.delete(p); else expanded.add(p); renderExplorer(); }
    else if (t.dataset.file) void openFile(t.dataset.file, { line: t.dataset.line ? Number(t.dataset.line) : undefined });
    else if (t.dataset.tab) { active = t.dataset.tab; renderTabs(); renderExplorer(); renderFile(); }
    else if (t.dataset.close) closeTab(t.dataset.close);
    else if (t.hasAttribute('data-reveal') && tab) void openFile(tab.path, { reveal: true });
    else if (t.hasAttribute('data-diff') && tab) {
      tab.showDiff = !tab.showDiff; renderFile();
      if (tab.showDiff) { const id = node, path = tab.path; void api.codeDiff(id, path).then(d => d.diff + (d.truncated ? '\n…' : ''), err => { tab.error = String(err instanceof Error ? err.message : err); return null; }).then(d => { tab.diff = d; if (active === path && node === id) renderFile(); }); }
    }
    else if (t.hasAttribute('data-editor') && tab) {
      const pre = body.querySelector<HTMLElement>('.code-text'), s = body.querySelector<HTMLElement>('.code-scroll');
      // the first line in view, as the editor's starting point
      const style = pre ? getComputedStyle(pre) : null, lh = style ? parseFloat(style.lineHeight) || 19 : 19;
      const line = s && pre && style ? Math.max(1, Math.floor((s.scrollTop - pre.offsetTop - (parseFloat(style.paddingTop) || 0)) / lh) + 1) : undefined;
      void api.codeOpen(node, tab.path, line).catch(err => { tab.error = String(err instanceof Error ? err.message : err); renderFile(); });
    }
    else if (t.hasAttribute('data-map') && tab && tree) cb.reveal(`${tree.top}/${tab.path}`);
    else if (t.hasAttribute('data-copy') && tab && tree) void navigator.clipboard?.writeText(`${tree.top}/${tab.path}`).then(() => { t.textContent = tr('Copiato'); setTimeout(() => { t.textContent = tr('Copia percorso'); }, 1500); });
  });
  root.addEventListener('auxclick', e => { const t = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]'); if (t && e.button === 1) closeTab(t.dataset.tab!); });
  filterInput.addEventListener('input', () => { filter = filterInput.value.trim(); renderExplorer(); });
  filterInput.addEventListener('keydown', e => { if (e.key === 'Enter') { const first = explorer.querySelector<HTMLElement>('[data-file]'); if (first) void openFile(first.dataset.file!); } else if (e.key === 'Escape') { filterInput.value = ''; filter = ''; renderExplorer(); } });
  let searchTimer: number | undefined;
  queryInput.addEventListener('input', () => { query = queryInput.value; window.clearTimeout(searchTimer); searchTimer = window.setTimeout(() => void search(), 300); });
  queryInput.addEventListener('keydown', e => { if (e.key === 'Enter') { window.clearTimeout(searchTimer); void search(); } });
  document.addEventListener('keydown', e => {
    if (!visible || root.offsetParent === null || !(e.metaKey || e.ctrlKey) || e.altKey) return;
    if ((e.target as HTMLElement | null)?.closest('.xterm,#overlay')) return;
    const key = e.key.toLowerCase();
    if (key === 'p' && !e.shiftKey) { e.preventDefault(); mode = 'files'; renderExplorer(); filterInput.focus(); filterInput.select(); }
    else if (key === 'f' && e.shiftKey) { e.preventDefault(); mode = 'search'; renderExplorer(); queryInput.focus(); queryInput.select(); }
    else if (key === 'w' && active && !e.shiftKey) { e.preventDefault(); closeTab(active); }
  });

  return (next, show) => {
    const changed = next !== node;
    visible = show;
    if (changed) {
      node = next; version++; tree = null; dirs = null; error = ''; expanded = new Set(); filter = ''; filterInput.value = '';
      query = ''; queryInput.value = ''; hits = []; tabs = []; active = null;
      renderExplorer(); renderTabs(); renderFile();
    }
    window.clearInterval(timer); timer = undefined;
    if (!visible) return;
    if (changed || !tree) void loadTree();
    timer = window.setInterval(() => { if (visible && !document.hidden && root.offsetParent !== null) void loadTree(); }, REFRESH_MS);
  };
}

function fmtSize(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** A one-glyph hint of the file's kind for the explorer. */
function iconOf(path: string): string {
  const lang = languageOf(path);
  if (lang === 'markdown') return '¶';
  if (lang === 'json' || lang === 'yaml' || lang === 'ini') return '{}';
  if (lang === 'xml' || lang === 'css' || lang === 'scss') return '<>';
  if (lang === 'bash' || lang === 'dockerfile') return '$';
  if (lang) return '·';
  return /\.(png|jpe?g|gif|webp|ico|icns|pdf)$/i.test(path) ? '▣' : '○';
}
