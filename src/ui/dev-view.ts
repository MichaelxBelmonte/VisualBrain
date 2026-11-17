// The "Codice" tab of Operativa: one bar (project, File | Git, link to GitHub), then a repository's files (code-view.ts)
// or its branches, PRs, CI and history (git-view.ts). It follows the selected node's repository, or the one chosen here.
import { api } from './api.ts';
import { mountCodeView } from './code-view.ts';
import { mountGitView } from './git-view.ts';
import { mountGithubConnect } from './github-connect.ts';
import { t as tr, ui } from './i18n.ts';
import type { RepoChoice } from '../shared/types.ts';

const esc = (s: string) => s.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
type Mode = 'code' | 'history';

export function mountDevView(root: HTMLElement, cb: { reveal(id: number): void; login(info: import('../shared/types.ts').TerminalInfo): void }): (node: number | null, visible: boolean) => void {
  let mode: Mode = 'code', selected: number | null = null, chosen: number | null = null, visible = false, repos: RepoChoice[] | null = null;
  try { if (localStorage.getItem('vb:dev-mode') === 'history') mode = 'history'; } catch { /* storage unavailable */ }
  root.classList.add('dev-view');
  root.innerHTML = ui`<div class="dev-bar"><label class="dev-repo"><select aria-label="Progetto"></select></label><div class="dev-modes" role="tablist" aria-label="Codice"><button data-dev-mode="code" role="tab" title="File, ricerca e modifiche">File</button><button data-dev-mode="history" role="tab" title="Rami, PR, controlli CI e commit">Git</button></div><span class="dev-gap"></span></div><div class="dev-pane dev-code"></div><div class="dev-pane dev-history"></div>`;
  const select = root.querySelector<HTMLSelectElement>('.dev-repo select')!;
  const codePane = root.querySelector<HTMLElement>('.dev-code')!, historyPane = root.querySelector<HTMLElement>('.dev-history')!;
  const updateCode = mountCodeView(codePane, { reveal: path => void api.nodeAt(path).then(n => n && cb.reveal(n.id), () => undefined) });
  const updateHistory = mountGitView(historyPane, { reveal: cb.reveal });
  let githubOpen = false;
  const githubButton = document.createElement('button'); githubButton.className = 'btn small ghost'; githubButton.textContent = tr('Collega a GitHub…'); githubButton.title = tr('Collega la cartella a un repository GitHub e sincronizza');
  root.querySelector('.dev-bar')!.append(githubButton);
  const githubPanel = document.createElement('section'); githubPanel.className = 'github-connect hidden';
  root.querySelector('.dev-bar')!.after(githubPanel);
  const updateGithub = mountGithubConnect(githubPanel, { login: cb.login, synced: () => {
    updateCode(null, false); updateHistory(null, false); repos = null; apply();
  } });
  githubButton.onclick = () => { githubOpen = !githubOpen; apply(); };

  const renderPicker = () => {
    const current = chosen === null ? '' : String(chosen);
    select.innerHTML = `<option value="">${esc(tr('Progetto del nodo selezionato'))}</option>` + (repos ?? []).map(r => `<option value="${r.nodeId}" title="${esc(r.path)}">${esc(r.name)}</option>`).join('');
    if (chosen !== null && !repos?.some(r => r.nodeId === chosen)) select.insertAdjacentHTML('beforeend', `<option value="${chosen}">#${chosen}</option>`);
    select.value = current;
  };
  const apply = () => {
    const repo = chosen ?? selected;
    root.querySelectorAll<HTMLElement>('[data-dev-mode]').forEach(b => { const on = b.dataset.devMode === mode; b.setAttribute('aria-selected', String(on)); b.classList.toggle('active', on); });
    codePane.classList.toggle('hidden', mode !== 'code'); historyPane.classList.toggle('hidden', mode !== 'history');
    updateCode(repo, visible && mode === 'code');
    updateHistory(repo, visible && mode === 'history');
    githubButton.disabled = repo === null; githubButton.setAttribute('aria-expanded', String(githubOpen));
    updateGithub(repo, visible && githubOpen);
  };
  root.addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-dev-mode]');
    if (!b) return;
    mode = b.dataset.devMode as Mode;
    try { localStorage.setItem('vb:dev-mode', mode); } catch { /* storage unavailable */ }
    apply();
  });
  select.addEventListener('change', () => { chosen = select.value ? Number(select.value) : null; apply(); });

  return (node, show) => {
    // choosing another node in the list follows it again
    if (node !== selected) { selected = node; chosen = null; }
    visible = show;
    if (show && repos === null) { repos = []; void api.repos().then(list => { repos = list; renderPicker(); }, () => { repos = null; }); }
    renderPicker(); apply();
  };
}
