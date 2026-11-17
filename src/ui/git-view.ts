// The "Git" tab of Workspace: the selected node's repository, read-only. Branches, worktrees (with the agents working
// on them), the commit graph and one commit's files; GitHub pull requests and workflow runs through the gh CLI.
import { api } from './api.ts';
import { t as tr, ui } from './i18n.ts';
import { graphRows, refBadges, rowSegments } from './git-graph.ts';
import type { GitCommit, GitCommitDetail, GitCommitFile, GitRepoView, GithubRun, GithubState } from '../shared/types.ts';

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const LANE = 11, ROW = 26, MAX_LANES = 14, REFRESH_MS = 15_000;

/** "5 min fa", "3 h fa", "2 g fa", then the date. */
export function when(ms: number, now = Date.now()): string {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return tr('adesso');
  if (s < 3600) return ui`${Math.floor(s / 60)} min fa`;
  if (s < 86400) return ui`${Math.floor(s / 3600)} h fa`;
  if (s < 30 * 86400) return ui`${Math.floor(s / 86400)} g fa`;
  return new Date(ms).toLocaleDateString();
}

function graphSvg(commit: GitCommit, row: ReturnType<typeof graphRows>[number]): string {
  const lanes = Math.min(MAX_LANES, Math.max(row.top.length, row.bottom.length, row.col + 1));
  const x = (lane: number) => lane * LANE + LANE / 2 + 2;
  const y = (v: number) => v * ROW;
  const lines = rowSegments(row, commit.parents, commit.hash).filter(s => s.x1 < MAX_LANES && s.x2 < MAX_LANES).map(s => {
    const [x1, y1, x2, y2] = [x(s.x1), y(s.y1), x(s.x2), y(s.y2)];
    const d = x1 === x2 ? `M${x1} ${y1}V${y2}` : `M${x1} ${y1}C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`;
    return `<path class="lane-${s.lane % 6}" d="${d}"/>`;
  }).join('');
  const dot = row.col < MAX_LANES ? `<circle class="lane-${row.col % 6}${commit.parents.length > 1 ? ' merge' : ''}" cx="${x(row.col)}" cy="${ROW / 2}" r="3.5"/>` : '';
  return `<svg class="git-lanes" width="${lanes * LANE + 4}" height="${ROW}" aria-hidden="true">${lines}${dot}</svg>`;
}

/** At most three badges per commit; the rest (often a run of release tags) collapse into "+N" with the names in its tooltip. */
function badges(refs: string[], remotes: string[]): string {
  const all = refBadges(refs, remotes);
  const shown = all.slice(0, 3).map(r => `<span class="git-ref ${r.kind}">${esc(r.text)}</span>`).join('');
  return all.length > 3 ? `${shown}<span class="git-ref more" title="${esc(all.slice(3).map(r => r.text).join(', '))}">+${all.length - 3}</span>` : shown;
}

export function mountGitView(root: HTMLElement, cb: { reveal(id: number): void }): (node: number | null, visible: boolean) => void {
  let node: number | null = null, visible = false, view: GitRepoView | null = null, github: GithubState | null = null;
  let selected: string | null = null, detail: (Omit<GitCommitDetail, 'files'> & { files: GitCommitFile[] }) | null = null;
  let logSignature = '', error = '', fetching = false, version = 0, timer: number | undefined;
  root.classList.add('git-view');

  const load = async (fresh = false) => {
    if (node === null) { view = null; render(); return; }
    const mine = ++version, id = node;
    try {
      const next = fresh ? await api.gitFetch(id) : await api.git(id);
      if (mine !== version) return;
      view = next; error = '';
    } catch (e) { if (mine === version) error = String(e instanceof Error ? e.message : e); }
    render();
    if (view?.repo?.github && (fresh || github === null)) {
      const gh = await api.github(id, fresh).catch(e => ({ state: 'error' as const, message: String(e instanceof Error ? e.message : e) }));
      if (mine === version || node === id) { github = gh; renderSide(); }
    }
  };

  const select = async (hash: string, scroll = false) => {
    selected = hash; detail = null;
    root.querySelectorAll('.git-row.selected').forEach(el => el.classList.remove('selected'));
    const row = root.querySelector<HTMLElement>(`.git-row[data-commit="${hash}"]`);
    row?.classList.add('selected');
    if (scroll) row?.scrollIntoView({ block: 'center' });
    renderDetail();
    if (node === null) return;
    try { const d = await api.gitCommit(node, hash); if (selected === hash) { detail = d; renderDetail(); } }
    catch (e) { if (selected === hash) { error = String(e instanceof Error ? e.message : e); renderDetail(); } }
  };

  function render(): void {
    const repo = view?.repo;
    if (node === null || !repo) {
      root.innerHTML = ui`<div class="git-empty">${node === null ? tr('Scegli un nodo nella lista per vedere il suo repository.') : view ? tr('Questo nodo non è in un repository Git.') : tr('Caricamento…')}</div>${error ? ui`<p class="git-error" role="alert">${esc(error)}</p>` : ''}`;
      logSignature = '';
      return;
    }
    if (!root.querySelector('.git-layout')) {
      root.innerHTML = ui`<header class="git-head"></header><div class="git-layout"><aside class="git-side"></aside><section class="git-log" aria-label="Commit"></section><aside class="git-detail"></aside></div>`;
      logSignature = '';
    }
    renderHead(); renderSide(); renderLog(); renderDetail();
  }

  function renderHead(): void {
    const repo = view!.repo!, head = root.querySelector('.git-head')!;
    const ch = repo.changes;
    const changes = [ch.staged && ui`${ch.staged} in stage`, ch.unstaged && ui`${ch.unstaged} modificati`, ch.untracked && ui`${ch.untracked} nuovi`, ch.conflicts && ui`${ch.conflicts} conflitti`].filter(Boolean).join(' · ') || tr('Nessuna modifica');
    const sync = repo.upstream ? (repo.ahead || repo.behind ? ui`↑${repo.ahead} ↓${repo.behind} rispetto a ${esc(repo.upstream)}` : ui`Allineato a ${esc(repo.upstream)}`) : tr('Nessun ramo remoto collegato');
    head.innerHTML = ui`<div class="git-title"><strong>${esc(repo.top.split('/').pop() || repo.top)}</strong><span class="git-chip" title="Ramo corrente">⎇ ${esc(repo.branch ?? tr('HEAD staccato'))}</span><span class="git-meta">${sync}</span><span class="git-meta ${ch.conflicts ? 'warn' : ''}">${changes}</span></div><div class="git-actions">${error ? ui`<span class="git-error" role="alert">${esc(error)}</span>` : ''}<button class="btn small" data-fetch ${fetching || !repo.remotes.length ? 'disabled' : ''} title="git fetch: scarica rami e commit remoti, senza toccare i tuoi file">${fetching ? tr('Aggiornamento…') : repo.github ? tr('Aggiorna da GitHub') : tr('Aggiorna dai remoti')}</button>${repo.github ? ui`<button class="btn small" data-url="${esc(repo.github.web)}">Apri su GitHub</button>` : ''}</div>`;
  }

  function agentBadge(branch?: string): string {
    const a = branch ? view?.agents?.[branch] : undefined;
    return a ? ui`<span class="git-agent ${a.alive ? '' : 'ended'}" title="Sessione che lavora su questo ramo">${esc(a.code ?? a.name ?? a.id)}</span>` : '';
  }

  function renderSide(): void {
    const side = root.querySelector('.git-side'); const repo = view?.repo;
    if (!side || !repo) return;
    const branch = (b: typeof repo.local[number], remote = false) => ui`<button class="git-item ${b.current ? 'current' : ''}" data-hash="${b.hash}" title="${esc(b.subject)}"><span class="git-item-name">${b.current ? '● ' : ''}${esc(b.name)}</span>${remote ? '' : agentBadge(b.name)}<span class="git-item-meta">${b.gone ? tr('remoto eliminato') : b.ahead || b.behind ? `↑${b.ahead ?? 0} ↓${b.behind ?? 0}` : ''} ${when(b.date)}</span></button>`;
    const worktrees = repo.worktrees.map(w => ui`<div class="git-item static" title="${esc(w.path)}"><span class="git-item-name">${w.main ? tr('principale') : esc(w.path.split('/').slice(-2).join('/'))}</span>${agentBadge(w.branch)}<span class="git-item-meta">${esc(w.branch ?? tr('staccato'))}${w.locked ? tr(' · bloccato') : ''}${w.prunable ? tr(' · da ripulire') : ''}</span></div>`).join('');
    let gh = '';
    if (repo.github) {
      if (!github) gh = ui`<p class="git-note">Caricamento da GitHub…</p>`;
      else if (github.state !== 'ok') gh = ui`<p class="git-note">${esc(github.message)}${github.state === 'signed-out' ? ui`<br>Accedi da Impostazioni → GitHub (⌘,).` : github.state === 'missing' ? ui`<br>Installala con <code>brew install gh</code>, poi accedi da Impostazioni → GitHub.` : ''}</p>`;
      else {
        const checks = { success: ['✓', tr('controlli riusciti')], failure: ['✗', tr('controlli falliti')], pending: ['…', tr('controlli in corso')], none: ['', ''] } as const;
        const pulls = github.pulls.map(p => ui`<button class="git-item" data-url="${esc(p.url)}" title="${esc(p.title)}"><span class="git-item-name">#${p.number} ${esc(p.title)}</span><span class="git-item-meta">${esc(p.branch)} → ${esc(p.base)}${p.draft ? tr(' · bozza') : ''}${p.review === 'APPROVED' ? tr(' · approvata') : p.review === 'CHANGES_REQUESTED' ? tr(' · modifiche richieste') : ''} <span class="git-check ${p.checks}" title="${checks[p.checks][1]}">${checks[p.checks][0]}</span></span></button>`).join('') || ui`<p class="git-note">Nessuna pull request aperta.</p>`;
        const state = (r: GithubRun) => r.status !== 'completed' ? ['pending', tr('in corso')] : r.conclusion === 'success' ? ['success', tr('riuscito')] : r.conclusion === 'skipped' || r.conclusion === 'neutral' ? ['none', tr('saltato')] : ['failure', tr('fallito')];
        const runs = github.runs.map(r => { const [cls, label] = state(r); return ui`<button class="git-item" data-url="${esc(r.url)}" title="${esc(r.title)}"><span class="git-item-name"><span class="git-check ${cls}">${cls === 'success' ? '✓' : cls === 'failure' ? '✗' : cls === 'pending' ? '…' : '–'}</span> ${esc(r.workflow)}</span><span class="git-item-meta">${esc(r.branch)} · ${label} · ${when(Date.parse(r.createdAt))}</span></button>`; }).join('') || ui`<p class="git-note">Nessuna esecuzione recente.</p>`;
        gh = ui`<h3>Pull request (${github.pulls.length})</h3>${pulls}<h3>Controlli CI</h3>${runs}`;
      }
      gh = ui`<section class="git-section">${gh}</section>`;
    }
    side.innerHTML = ui`<section class="git-section"><h3>Rami locali (${repo.local.length})</h3>${repo.local.slice(0, 60).map(b => branch(b)).join('') || ui`<p class="git-note">Nessun ramo.</p>`}</section>${repo.remote.length ? ui`<details class="git-section"><summary>Rami remoti (${repo.remote.length})</summary>${repo.remote.slice(0, 80).map(b => branch(b, true)).join('')}</details>` : ''}${repo.worktrees.length > 1 ? ui`<section class="git-section"><h3>Worktree (${repo.worktrees.length})</h3>${worktrees}</section>` : ''}${gh}`;
  }

  function renderLog(): void {
    const log = root.querySelector<HTMLElement>('.git-log'); const repo = view?.repo;
    if (!log || !repo) return;
    const signature = repo.commits.map(c => c.hash + c.refs.join()).join('|');
    if (signature === logSignature) return;
    logSignature = signature;
    if (!repo.commits.length) { log.innerHTML = ui`<p class="git-note">Nessun commit.</p>`; return; }
    const rows = graphRows(repo.commits), remotes = repo.remotes.map(r => r.name);
    log.innerHTML = repo.commits.map((c, i) => ui`<button class="git-row ${c.hash === selected ? 'selected' : ''}" data-commit="${c.hash}">${graphSvg(c, rows[i])}<span class="git-subject">${badges(c.refs, remotes)}${esc(c.subject)}</span><span class="git-author">${esc(c.author)}</span><span class="git-date">${when(c.date)}</span><span class="git-hash">${c.hash.slice(0, 7)}</span></button>`).join('');
  }

  function renderDetail(): void {
    const el = root.querySelector<HTMLElement>('.git-detail'); const repo = view?.repo;
    if (!el || !repo) return;
    el.classList.toggle('hidden', !selected);
    if (!selected) return;
    if (!detail) { el.innerHTML = ui`<p class="git-note">Caricamento…</p>`; return; }
    const rel = (p: string) => (p.startsWith(repo.top + '/') ? p.slice(repo.top.length + 1) : p);
    const commitUrl = repo.github ? `${repo.github.web}/commit/${detail.hash}` : '';
    el.innerHTML = ui`<div class="git-detail-head"><span class="git-hash">${detail.hash.slice(0, 10)}</span><button class="btn ghost small" data-close-detail aria-label="Chiudi dettaglio">×</button></div><pre class="git-message">${esc(detail.message)}</pre><p class="git-meta">${esc(detail.author)} · ${new Date(detail.date).toLocaleString()}</p>${detail.parents.length ? ui`<p class="git-meta">Genitori: ${detail.parents.map(p => `<button class="git-link" data-select="${p}">${p.slice(0, 7)}</button>`).join(' ')}</p>` : ''}${commitUrl ? ui`<p><button class="btn small" data-url="${esc(commitUrl)}">Apri su GitHub</button></p>` : ''}<h3>File (${detail.files.length + detail.moreFiles})</h3><div class="git-files">${detail.files.map(f => ui`<div class="git-file"><span class="git-file-path" title="${esc(f.path)}">${esc(rel(f.path))}</span><span class="git-file-stat">${f.added === null ? tr('binario') : `<span class="add">+${f.added}</span> <span class="del">−${f.deleted}</span>`}</span>${f.nodeId !== undefined ? ui`<button class="git-link" data-reveal="${f.nodeId}" title="Mostra nella mappa">Mappa</button>` : ''}</div>`).join('')}${detail.moreFiles ? `<p class="git-note">${tr('File non mostrati:')} ${detail.moreFiles}</p>` : ''}</div>`;
  }

  root.addEventListener('click', e => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-commit],[data-hash],[data-select],[data-url],[data-fetch],[data-reveal],[data-close-detail]');
    if (!t || node === null) return;
    if (t.dataset.commit) void select(t.dataset.commit);
    else if (t.dataset.hash) void select(t.dataset.hash, true);
    else if (t.dataset.select) void select(t.dataset.select, true);
    else if (t.dataset.url) void api.gitOpen(node, t.dataset.url).catch(err => { error = String(err instanceof Error ? err.message : err); renderHead(); });
    else if (t.dataset.reveal) cb.reveal(Number(t.dataset.reveal));
    else if (t.hasAttribute('data-close-detail')) { selected = null; detail = null; root.querySelectorAll('.git-row.selected').forEach(el => el.classList.remove('selected')); renderDetail(); }
    else if (t.hasAttribute('data-fetch') && !fetching) {
      fetching = true; renderHead();
      void load(true).finally(() => { fetching = false; renderHead(); });
    }
  });

  return (next, show) => {
    const changed = next !== node;
    visible = show;
    if (changed) { node = next; view = null; github = null; selected = null; detail = null; error = ''; logSignature = ''; root.innerHTML = ''; }
    window.clearInterval(timer); timer = undefined;
    if (!visible) return;
    if (changed || !view) { render(); void load(); }
    // While the tab is open the state follows commits made by agents or in a terminal.
    timer = window.setInterval(() => { if (visible && !document.hidden && !fetching && root.offsetParent !== null) void load(); }, REFRESH_MS);
  };
}
