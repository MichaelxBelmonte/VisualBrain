import { api } from './api.ts';
import { t as tr, ui } from './i18n.ts';
import type { TerminalInfo } from '../shared/types.ts';
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** A visible folder and explicit repository selection before anything is written. */
export function mountGithubConnect(root: HTMLElement, cb: { login(info: TerminalInfo): void; synced(): void }): (id: number | null, show: boolean) => void {
  let node: number | null = null, generation = 0, visible = false;
  async function load(id: number) {
    const mine = ++generation;
    root.innerHTML = ui`<p class="muted">Caricamento da GitHub…</p>`;
    let page = 1, repos: Array<{ name: string; private: boolean }> = [], busy = false;
    try {
      const [account, tree, view] = await Promise.all([api.githubRepos(), api.codeTree(id), api.git(id)]);
      if (mine !== generation) return;
      root.innerHTML = ui`<div class="github-heading"><strong>GitHub</strong><button class="btn small" data-reload>Aggiorna</button></div><p class="github-folder">Cartella: <code>${esc(tree.top)}</code></p><div data-account></div><div role="status" data-status></div>`;
      root.querySelector<HTMLButtonElement>('[data-reload]')!.onclick = () => void load(id);
      const accountEl = root.querySelector<HTMLElement>('[data-account]')!, status = root.querySelector<HTMLElement>('[data-status]')!;
      if (account.state !== 'ok') {
        accountEl.innerHTML = `<p>${esc(tr(account.message))}</p>` + (account.state === 'signed-out' ? ui`<button class="btn" data-login>Connetti GitHub</button><p class="muted">Completa l’accesso nel terminale, poi torna qui e premi Aggiorna.</p>` : ui`<p class="muted"><code>brew install gh</code></p>`);
        accountEl.querySelector<HTMLButtonElement>('[data-login]')?.addEventListener('click', async e => {
          const button = e.currentTarget as HTMLButtonElement; button.disabled = true;
          try { const result = await api.githubLogin(id); cb.login(result.info); }
          catch (error) { status.textContent = String(error); button.disabled = false; }
        });
        return;
      }
      repos = account.repos;
      accountEl.innerHTML = ui`<p>Account: <strong>${esc(account.login)}</strong>${view.repo?.github ? ` · ${esc(view.repo.github.owner + '/' + view.repo.github.repo)}` : ''}</p><label class="github-field">Cerca repository<input type="search" data-query autocomplete="off"></label><label class="github-field">Repository GitHub<select data-repo aria-label="Repository GitHub"></select></label><button class="btn small" data-more>Altri repository</button><label class="github-push"><input type="checkbox" data-push> Pubblica anche i commit locali</label><p class="muted">Scarica gli aggiornamenti nella cartella. La pubblicazione invia solo commit già creati; le modifiche non salvate e le cronologie divergenti interrompono la sincronizzazione.</p><button class="btn active" data-connect>Collega e sincronizza</button>`;
      const select = accountEl.querySelector<HTMLSelectElement>('[data-repo]')!, query = accountEl.querySelector<HTMLInputElement>('[data-query]')!;
      const connect = accountEl.querySelector<HTMLButtonElement>('[data-connect]')!, more = accountEl.querySelector<HTMLButtonElement>('[data-more]')!;
      const render = () => {
        const previous = select.value;
        const list = repos.filter(r => r.name.toLowerCase().includes(query.value.trim().toLowerCase()));
        select.innerHTML = ui`<option value="">Scegli un repository…</option>` + list.map(r => `<option value="${esc(r.name)}">${esc(r.name)}${r.private ? ' · ' + tr('privato') : ''}</option>`).join('');
        if (list.some(r => r.name === previous)) select.value = previous;
        connect.disabled = busy || !select.value;
      };
      render(); more.hidden = !account.more;
      query.oninput = render; select.onchange = () => { connect.disabled = busy || !select.value; };
      more.onclick = async () => {
        more.disabled = true;
        try {
          const next = await api.githubRepos(page + 1);
          if (mine !== generation) return;
          if (next.state !== 'ok') throw new Error(tr(next.message));
          page++; repos = [...new Map([...repos, ...next.repos].map(r => [r.name, r])).values()];
          more.hidden = !next.more; render();
        } catch (error) { status.textContent = String(error); }
        finally { more.disabled = false; }
      };
      connect.onclick = async () => {
        if (busy || !select.value) return;
        busy = true; connect.disabled = true; select.disabled = true; query.disabled = true;
        root.querySelector<HTMLButtonElement>('[data-reload]')!.disabled = true;
        status.textContent = tr('Sincronizzazione…');
        try {
          const result = await api.githubConnect(id, select.value, accountEl.querySelector<HTMLInputElement>('[data-push]')!.checked);
          if (mine !== generation) return;
          status.textContent = tr(result.localChanges ? 'Cartella collegata; modifiche locali conservate.' : 'Sincronizzazione completata') + ` · ${result.branch}`;
          cb.synced();
        } catch (error) { if (mine === generation) status.textContent = String(error); }
        finally { busy = false; connect.disabled = !select.value; select.disabled = false; query.disabled = false; root.querySelector<HTMLButtonElement>('[data-reload]')?.removeAttribute('disabled'); }
      };
    } catch (error) { if (mine === generation) { root.innerHTML = `<p role="alert">${esc(String(error))}</p>` + ui`<button class="btn" data-retry>Riprova</button>`; root.querySelector('[data-retry]')!.addEventListener('click', () => void load(id)); } }
  }
  return (id, show) => {
    const changed = id !== node || show !== visible;
    node = id; visible = show; root.classList.toggle('hidden', !show);
    if (!changed) return;
    generation++;
    if (show && id !== null) void load(id);
    else root.innerHTML = id === null && show ? tr('Scegli una cartella.') : '';
  };
}
