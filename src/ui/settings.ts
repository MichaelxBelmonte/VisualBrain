// Impostazioni: one window for everything that is not daily work. The first run keeps the short welcome form.
import { api, type AgentCli } from './api.ts';
import { getLanguage, setLanguage, t as tr, ui, type Language } from './i18n.ts';
import { glassEnabled, nativeMac, setGlass, syncWindowTheme } from './window-chrome.ts';
import type { TerminalInfo } from '../shared/types.ts';
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export type SettingsSection = 'general' | 'folders' | 'agents' | 'github' | 'updates' | 'shortcuts';
export interface SettingsHooks {
  /** Shows a terminal started from here (install, sign in) in Operativa. */
  openTerminal(info: TerminalInfo): void;
  onThemeChange(): void;
  zoom(step: 1 | -1 | 0): void;
  /** The "Aggiornamenti" row: version, state and the one action that fits it. */
  mountUpdates(root: HTMLElement): void;
  appVersion(): string;
}
let hooks: SettingsHooks | null = null;
export function setSettingsHooks(value: SettingsHooks): void {
  hooks = value;
  // The canvas and the terminals copy the colours once. With "Sistema" they change when macOS does, and the Mac window
  // takes a new appearance a moment after the choice: re-read them when the scheme really changes.
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => hooks?.onThemeChange());
}

type Theme = 'light' | 'dark' | 'system';
function currentTheme(): Theme { try { const v = localStorage.getItem('vb:theme'); return v === 'light' || v === 'dark' ? v : 'system'; } catch { return 'system'; } }
export function applyTheme(theme: Theme): void {
  if (theme === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = theme;
  try { if (theme === 'system') localStorage.removeItem('vb:theme'); else localStorage.setItem('vb:theme', theme); } catch { /* storage unavailable */ }
  syncWindowTheme();
  hooks?.onThemeChange();
}

const SECTIONS: Array<[SettingsSection, string]> = [
  ['general', 'Generale'], ['folders', 'Cartelle mappate'], ['agents', 'Agenti'], ['github', 'GitHub'], ['updates', 'Aggiornamenti'], ['shortcuts', 'Scorciatoie'],
];
let lastSection: SettingsSection = 'general';

export async function openSettings(firstRun = false, section?: SettingsSection): Promise<void> {
  if (firstRun) return openWelcome();
  const overlay = document.getElementById('overlay')!;
  overlay.dataset.mode = 'settings'; overlay.classList.remove('hidden');
  let current: SettingsSection = section ?? lastSection;
  let busy = false, timer: ReturnType<typeof setTimeout> | undefined;
  overlay.innerHTML = ui`<div class="dialog settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title"><nav class="settings-nav" aria-label="Sezioni"><h2 id="settings-title">Impostazioni</h2>${SECTIONS.map(([id, label]) => `<button type="button" data-section="${id}">${esc(tr(label))}<span class="settings-badge" data-badge="${id}" hidden></span></button>`).join('')}</nav><div class="settings-main"><div class="settings-head"><h3 data-heading></h3><button class="plain-icon" data-close aria-label="Chiudi">×</button></div><div class="settings-body" data-body></div></div></div>`;
  const body = overlay.querySelector<HTMLElement>('[data-body]')!;
  const close = () => { if (busy) return; clearTimeout(timer); overlay.classList.add('hidden'); overlay.innerHTML = ''; delete overlay.dataset.mode; document.removeEventListener('keydown', onKey, true); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && overlay.dataset.mode === 'settings') { e.preventDefault(); e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  overlay.querySelector('[data-close]')!.addEventListener('click', close);
  overlay.onmousedown = e => { if (e.target === overlay) close(); };
  const terminal = (info: TerminalInfo) => { close(); hooks?.openTerminal(info); };
  const show = (id: SettingsSection) => {
    current = lastSection = id; clearTimeout(timer);
    overlay.querySelectorAll<HTMLElement>('[data-section]').forEach(b => b.setAttribute('aria-current', String(b.dataset.section === id)));
    overlay.querySelector('[data-heading]')!.textContent = tr(SECTIONS.find(s => s[0] === id)![1]);
    body.innerHTML = '';
    const render = { general, folders, agents, github, updates, shortcuts }[id];
    void render(body, { terminal, setBusy: v => { busy = v; }, schedule: fn => { clearTimeout(timer); timer = setTimeout(fn, 1500); }, badge }).catch(e => { if (current === id) body.innerHTML = `<p role="alert">${esc(String(e))}</p>`; });
  };
  const badge = (id: SettingsSection, count: number) => { const el = overlay.querySelector<HTMLElement>(`[data-badge="${id}"]`); if (el) { el.hidden = !count; el.textContent = String(count); } };
  overlay.querySelectorAll<HTMLElement>('[data-section]').forEach(b => b.addEventListener('click', () => show(b.dataset.section as SettingsSection)));
  show(current);
  // The Agenti badge counts what needs the user (missing or signed-out CLIs) even when another section is open.
  void api.agents().then(r => badge('agents', r.clis.filter(needsUser).length)).catch(() => {});
}

interface Ctx { terminal(info: TerminalInfo): void; setBusy(v: boolean): void; schedule(fn: () => void): void; badge(id: SettingsSection, count: number): void }
const needsUser = (c: AgentCli) => c.path !== null && c.signedIn === false;

async function general(root: HTMLElement): Promise<void> {
  const theme = currentTheme(), lang = getLanguage();
  root.innerHTML = ui`<div class="settings-row"><div><b>Lingua</b><small>dell’interfaccia e delle istruzioni agli agenti</small></div><select data-language aria-label="Lingua"><option value="it">Italiano</option><option value="en">English</option></select></div>
    <div class="settings-row"><div><b>Tema</b></div><span class="segmented" role="group" aria-label="Tema"><button data-theme="light">Chiaro</button><button data-theme="dark">Scuro</button><button data-theme="system">Sistema</button></span></div>
    ${nativeMac ? ui`<label class="settings-row"><div><b>Trasparenza</b><small>vetro dietro la barra e le colonne laterali</small></div><input type="checkbox" class="switch" data-glass ${glassEnabled() ? 'checked' : ''}></label>` : ''}
    <div class="settings-row"><div><b>Testo dei terminali</b><small>anche con ⌘+ e ⌘− dentro un terminale</small></div><span class="segmented"><button data-zoom="-1" aria-label="Testo più piccolo">A−</button><button data-zoom="0">Normale</button><button data-zoom="1" aria-label="Testo più grande">A+</button></span></div>
    <p class="work-launch-error" role="alert"></p>`;
  const select = root.querySelector<HTMLSelectElement>('[data-language]')!; select.value = lang;
  const error = root.querySelector('[role=alert]')!;
  select.onchange = async () => {
    select.disabled = true;
    try { const prefs = await api.preferences(); await api.savePreferences({ roots: prefs.roots, language: select.value as Language }); setLanguage(select.value as Language); location.reload(); }
    catch (e) { error.textContent = String(e); select.disabled = false; select.value = lang; }
  };
  const mark = (value: Theme) => root.querySelectorAll<HTMLElement>('[data-theme]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.theme === value)));
  mark(theme);
  root.querySelectorAll<HTMLElement>('[data-theme]').forEach(b => b.addEventListener('click', () => { applyTheme(b.dataset.theme as Theme); mark(b.dataset.theme as Theme); }));
  root.querySelector<HTMLInputElement>('[data-glass]')?.addEventListener('change', e => { setGlass((e.target as HTMLInputElement).checked); hooks?.onThemeChange(); });
  root.querySelectorAll<HTMLElement>('[data-zoom]').forEach(b => b.addEventListener('click', () => hooks?.zoom(Number(b.dataset.zoom) as 1 | -1 | 0)));
}

async function folders(root: HTMLElement, ctx: Ctx): Promise<void> {
  const prefs = await api.preferences();
  let roots = [...prefs.roots], folder = prefs.home;
  root.innerHTML = ui`<p class="muted">L’indice rimane su questo computer. Le relazioni vengono ricavate dai file accessibili nelle cartelle scelte. L’AI si attiva solo su tua richiesta.</p><div class="setup-roots"></div><button type="button" class="btn" data-browse>+ Scegli cartella</button>${folderPicker(folder)}<p class="work-launch-error" role="alert"></p><div class="settings-actions"><button type="button" class="btn primary" data-save>Salva e aggiorna</button></div>`;
  const error = root.querySelector('[role=alert]')!, save = root.querySelector<HTMLButtonElement>('[data-save]')!;
  const renderRoots = () => {
    root.querySelector('.setup-roots')!.innerHTML = roots.map((p, i) => `<div><span title="${esc(p)}">${esc(p)}</span><button type="button" class="plain-icon" data-remove-root="${i}" aria-label="${esc(tr('Rimuovi'))} ${esc(p)}">×</button></div>`).join('');
    root.querySelectorAll<HTMLButtonElement>('[data-remove-root]').forEach(b => b.onclick = () => { roots.splice(Number(b.dataset.removeRoot), 1); renderRoots(); });
    save.disabled = !roots.length;
  };
  renderRoots();
  bindFolderPicker(root, folder, chosen => { if (!roots.includes(chosen)) roots.push(chosen); renderRoots(); }, text => { error.textContent = text; });
  save.onclick = async () => {
    save.disabled = true; ctx.setBusy(true);
    try { await api.savePreferences({ roots, language: getLanguage() }); location.reload(); }
    catch (e) { error.textContent = String(e); save.disabled = false; ctx.setBusy(false); }
  };
}

function folderPicker(folder: string): string {
  return ui`<div class="folder-picker hidden"><div class="folder-location"><button type="button" class="plain-icon" data-parent aria-label="Cartella superiore">↑</button><input name="path" aria-label="Percorso cartella" value="${esc(folder)}"><button type="button" class="btn small" data-go>Vai</button></div><div class="folder-list"></div><button type="button" class="btn" data-use>Usa questa cartella</button></div>`;
}

function bindFolderPicker(root: HTMLElement, start: string, use: (path: string) => void, fail: (text: string) => void): void {
  let folder = start;
  const picker = root.querySelector('.folder-picker')!, path = root.querySelector<HTMLInputElement>('[name=path]')!;
  const browse = async (target: string) => {
    try {
      fail('');
      const result = await api.folders(target);
      folder = result.path; path.value = folder;
      root.querySelector('.folder-list')!.innerHTML = result.folders.map(name => `<button type="button" class="work-file" data-folder="${esc(name)}">▸ ${esc(name)}</button>`).join('') || `<span class="muted">${esc(tr('Nessuna sottocartella'))}</span>`;
      root.querySelectorAll<HTMLButtonElement>('[data-folder]').forEach(b => b.onclick = () => void browse(folder.replace(/[\\/]$/, '') + '/' + b.dataset.folder!));
    } catch (e) { fail(tr('Cartella non accessibile. Verifica il percorso e i permessi di macOS.') + ' ' + String(e)); }
  };
  root.querySelector('[data-browse]')!.addEventListener('click', () => { picker.classList.toggle('hidden'); if (!picker.classList.contains('hidden')) void browse(folder); });
  root.querySelector('[data-parent]')!.addEventListener('click', () => void browse(folder.replace(/[\\/][^\\/]+[\\/]?$/, '') || '/'));
  root.querySelector('[data-go]')!.addEventListener('click', () => void browse(path.value));
  path.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); void browse(path.value); } };
  root.querySelector('[data-use]')!.addEventListener('click', () => { use(folder); picker.classList.add('hidden'); });
}

/** Status word and tone of a CLI row: what the user has to do next, if anything. */
export function cliState(c: AgentCli): { tone: 'ok' | 'warn' | 'off'; text: string } {
  if (!c.path) return { tone: 'off', text: tr('Non installato') };
  if (c.signedIn === false) return { tone: 'warn', text: tr('Accesso richiesto') };
  if (c.signedIn === true) return { tone: 'ok', text: tr('Pronto') };
  return { tone: 'ok', text: tr('Installato') };
}

async function agents(root: HTMLElement, ctx: Ctx): Promise<void> {
  root.innerHTML = ui`<p class="muted">Controllo le CLI installate…</p>`;
  let open: string | null = null;
  const draw = async (fresh: boolean) => {
    const [{ clis, sessions }, harnesses] = await Promise.all([api.agents(fresh), api.harnesses()]);
    if (!root.isConnected) return;
    ctx.badge('agents', clis.filter(needsUser).length);
    const row = (c: AgentCli) => {
      const s = cliState(c), used = sessions[c.id] ?? 0;
      const actions = !c.path ? ui`<button class="btn small primary" data-act="install" data-cli="${c.id}">Installa</button>`
        : (c.signedIn === false ? ui`<button class="btn small primary" data-act="login" data-cli="${c.id}">Accedi</button>` : '') + ui`<button class="btn small" data-act="update" data-cli="${c.id}">Aggiorna</button>`;
      const detail = ui`<dl class="cli-detail"><dt>Eseguibile</dt><dd><code>${esc(c.path ?? c.command)}</code></dd><dt>Installazione</dt><dd><code>${esc(c.installCommand)}</code></dd>${c.account ? ui`<dt>Account</dt><dd>${esc(c.account)}</dd>` : ''}<dt>Usato da</dt><dd>${used ? ui`${used} sessioni attive` : tr('nessuna sessione')}</dd></dl>
        <div class="cli-more">${c.path ? ui`<button class="btn small ghost" data-act="login" data-cli="${c.id}">${c.signedIn === true ? tr('Cambia account') : tr('Accedi')}</button>` : ''}${c.path && c.canLogout && c.signedIn !== false ? ui`<button class="btn small ghost" data-act="logout" data-cli="${c.id}">Esci</button>` : ''}<button class="btn small ghost" data-copy="${c.id}">Copia diagnostica</button></div>
        ${used && c.path ? ui`<p class="muted">Aggiornare non interrompe le ${used} sessioni aperte: continuano con la versione attuale finché non le riavvii.</p>` : ''}`;
      return `<div class="cli-row" data-row="${c.id}"><button type="button" class="cli-summary" data-toggle="${c.id}" aria-expanded="${open === c.id}"><span class="cli-dot" data-tone="${s.tone}"></span><span class="cli-name"><b>${esc(c.label)}</b><small>${esc(c.version ? `v${c.version}` : c.command)}</small></span><span class="cli-state" data-tone="${s.tone}">${esc(s.text)}</span></button><span class="cli-actions">${actions}</span>${open === c.id ? `<div class="cli-open">${detail}</div>` : ''}</div>`;
    };
    const steps: Record<string, string> = { download: tr('Scaricamento componenti'), python: tr('Preparazione Python'), packages: tr('Installazione pacchetti'), verify: tr('Verifica installazione') };
    const harnessRow = (h: Awaited<ReturnType<typeof api.harnesses>>[number]) => {
      const installing = h.install?.state === 'installing';
      const text = installing ? steps[h.install!.step] || tr('Installazione in corso…') : h.install?.state === 'error' ? tr('Errore') : h.outdated ? ui`Aggiornamento ${h.latest ?? ''}` : h.installed ? tr('Installato') : h.canInstall ? tr('Non installato') : tr('Solo nel pacchetto Mac');
      const tone = h.installed && !h.outdated ? 'ok' : installing || h.outdated ? 'warn' : 'off';
      const button = installing ? '' : !h.installed ? ui`<button class="btn small primary" data-harness="${h.id}" ${h.canInstall ? '' : 'disabled'}>Installa</button>` : h.outdated ? ui`<button class="btn small" data-harness="${h.id}">Aggiorna</button>` : '';
      return `<div class="cli-row"><div class="cli-summary static"><span class="cli-dot" data-tone="${tone}"></span><span class="cli-name"><b>${esc(h.label)}</b><small>${esc(h.version ? String(h.version).slice(0, 12) : tr('nel profilo di Visual Brain'))}</small></span><span class="cli-state" data-tone="${tone}" title="${esc(h.install?.error ? tr(h.install.error) : '')}">${esc(text)}</span></div><span class="cli-actions">${button}</span></div>`;
    };
    root.innerHTML = ui`<div class="settings-subhead"><h4>CLI degli agenti</h4><button class="btn small ghost" data-refresh>Ricontrolla</button></div>
      <p class="muted">Installazione e accesso usano i comandi ufficiali in un terminale visibile: le CLI funzionano anche fuori da Visual Brain. Le credenziali restano alla CLI.</p>
      <div class="cli-list">${clis.map(row).join('')}</div>
      <div class="settings-subhead"><h4>Harness</h4></div><p class="muted">Esecuzioni a tempo dal nodo. Si installano nel profilo di Visual Brain, senza chiamate ai modelli.</p>
      <div class="cli-list">${harnesses.map(harnessRow).join('')}</div><p class="work-launch-error" role="alert"></p>`;
    const error = root.querySelector('[role=alert]')!;
    root.querySelector('[data-refresh]')!.addEventListener('click', () => { root.innerHTML = ui`<p class="muted">Controllo le CLI installate…</p>`; void draw(true).catch(e => { error.textContent = String(e); }); });
    root.querySelectorAll<HTMLElement>('[data-toggle]').forEach(b => b.addEventListener('click', () => { open = open === b.dataset.toggle ? null : b.dataset.toggle!; void draw(false); }));
    root.querySelectorAll<HTMLButtonElement>('[data-act]').forEach(b => b.addEventListener('click', async () => {
      b.disabled = true;
      try { const r = await api.agentAction(b.dataset.cli!, b.dataset.act as 'install' | 'update' | 'login' | 'logout'); ctx.terminal(r.info); }
      catch (e) { error.textContent = String(e); b.disabled = false; }
    }));
    root.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach(b => b.addEventListener('click', async () => {
      const c = clis.find(x => x.id === b.dataset.copy)!;
      const text = [`${c.label} (${c.id})`, `command: ${c.command}`, `path: ${c.path ?? 'not found'}`, `version: ${c.version ?? '-'}`, `signed in: ${c.signedIn ?? 'unknown'}`, `install: ${c.installCommand}`, `live sessions: ${sessions[c.id] ?? 0}`, `app: ${hooks?.appVersion() || '-'}`, `platform: ${navigator.platform}`].join('\n');
      try { await navigator.clipboard.writeText(text); b.textContent = tr('Copiata'); } catch { error.textContent = text; }
    }));
    root.querySelectorAll<HTMLButtonElement>('[data-harness]').forEach(b => b.addEventListener('click', async () => {
      b.disabled = true;
      try { await api.installHarness(b.dataset.harness!); await draw(false); } catch (e) { error.textContent = String(e); b.disabled = false; }
    }));
    if (harnesses.some(h => h.install?.state === 'installing')) ctx.schedule(() => { if (root.isConnected) void draw(false).catch(() => {}); });
  };
  await draw(false);
}

async function github(root: HTMLElement, ctx: Ctx): Promise<void> {
  root.innerHTML = ui`<p class="muted">Caricamento da GitHub…</p>`;
  const account = await api.githubRepos(1);
  if (!root.isConnected) return;
  const state = account.state === 'ok'
    ? ui`<div class="cli-row"><div class="cli-summary static"><span class="cli-dot" data-tone="ok"></span><span class="cli-name"><b>${esc(account.login)}</b><small>github.com · gh</small></span><span class="cli-state" data-tone="ok">Collegato</span></div><span class="cli-actions"><button class="btn small ghost" data-gh="logout">Esci</button></span></div>`
    : ui`<div class="cli-row"><div class="cli-summary static"><span class="cli-dot" data-tone="${account.state === 'signed-out' ? 'warn' : 'off'}"></span><span class="cli-name"><b>GitHub</b><small>${esc(tr(account.message))}</small></span></div><span class="cli-actions">${account.state === 'signed-out' ? ui`<button class="btn small primary" data-gh="login">Accedi</button>` : ''}</span></div>${account.state === 'signed-out' ? '' : ui`<p class="muted">Installa la CLI di GitHub: <code>brew install gh</code></p>`}`;
  root.innerHTML = ui`${state}<p class="muted">Serve per PR e controlli CI nella scheda Codice. Il collegamento di un repository a una cartella si fa da Codice, progetto per progetto.</p><p class="work-launch-error" role="alert"></p>`;
  const error = root.querySelector('[role=alert]')!;
  root.querySelectorAll<HTMLButtonElement>('[data-gh]').forEach(b => b.addEventListener('click', async () => {
    b.disabled = true;
    try { const r = b.dataset.gh === 'login' ? await api.githubAccountLogin() : await api.githubAccountLogout(); ctx.terminal(r.info); }
    catch (e) { error.textContent = String(e); b.disabled = false; }
  }));
}

async function updates(root: HTMLElement): Promise<void> {
  // its own element: the row stops following the server when another section replaces it
  const row = root.appendChild(document.createElement('div'));
  hooks?.mountUpdates(row);
}

async function shortcuts(root: HTMLElement): Promise<void> {
  const keys: Array<[string, string]> = [
    ['⌘K', 'Cerca un file, una cartella o un progetto'], ['⌘,', 'Impostazioni'], ['T', 'Passa tra Mappa e Operativa'],
    ['⌘J', 'Nuovo agente nel nodo selezionato'], ['⌘⇧J', 'Terminale semplice'], ['⌘+ ⌘− ⌘0', 'Testo dei terminali'],
    ['⌘⇧[ ⌘⇧]', 'Terminale precedente o successivo'], ['⌃⌥1…9', 'Vai al riquadro affiancato'],
    ['F', 'Inquadra la mappa'], ['R', 'Riordina la mappa'], ['C', 'Compatta la mappa'], ['Esc', 'Chiude o deseleziona'],
  ];
  root.innerHTML = `<dl class="shortcut-list">${keys.map(([k, v]) => `<dt><kbd>${esc(k)}</kbd></dt><dd>${esc(tr(v))}</dd>`).join('')}</dl>`;
}

/** First run: language and folders, nothing else. Agents can be added later from Impostazioni → Agenti. */
async function openWelcome(): Promise<void> {
  const prefs = await api.preferences();
  const overlay = document.getElementById('overlay')!;
  let roots = [...prefs.roots], lang = getLanguage(), busy = false;
  const text = (it: string, en: string) => lang === 'it' ? it : en;
  const render = () => {
    overlay.dataset.mode = 'settings'; overlay.classList.remove('hidden');
    overlay.innerHTML = `<div class="dialog setup-dialog" role="dialog" aria-modal="true" aria-labelledby="setup-title"><div class="dhead"><span id="setup-title">${text('Benvenuto in Visual Brain', 'Welcome to Visual Brain')}</span></div><form><div class="dbody"><label class="work-field">${text('Lingua', 'Language')}<select name="language"><option value="it">Italiano</option><option value="en">English</option></select></label><h3>${text('Quali cartelle vuoi mappare?', 'Which folders would you like to map?')}</h3><p class="muted">${text('L’indice rimane su questo computer. Le relazioni vengono ricavate dai file accessibili nelle cartelle scelte. L’AI si attiva solo su tua richiesta.', 'The index stays on this computer. Connections are extracted from accessible files in your selected folders. AI runs only when you request it.')}</p><div class="setup-roots"></div><button type="button" class="btn" data-browse>${text('+ Scegli cartella', '+ Choose folder')}</button>${folderPicker(prefs.home)}<p class="muted">${text('Gli agenti AI sono facoltativi: installali e collegali dopo da Impostazioni → Agenti.', 'AI agents are optional: install and sign in later from Settings → Agents.')}</p><div class="work-launch-error" role="alert"></div></div><div class="dfoot"><button type="submit" class="btn active">${text('Crea la mia mappa', 'Create my map')}</button></div></form></div>`;
    const form = overlay.querySelector('form')!;
    const select = form.querySelector<HTMLSelectElement>('[name=language]')!; select.value = lang;
    select.onchange = () => { lang = select.value as Language; render(); };
    const error = form.querySelector('.work-launch-error')!;
    const renderRoots = () => {
      form.querySelector('.setup-roots')!.innerHTML = roots.map((p, i) => `<div><span title="${esc(p)}">${esc(p)}</span><button type="button" class="plain-icon" data-remove-root="${i}" aria-label="${text('Rimuovi', 'Remove')} ${esc(p)}">×</button></div>`).join('');
      form.querySelectorAll<HTMLButtonElement>('[data-remove-root]').forEach(b => b.onclick = () => { roots.splice(Number(b.dataset.removeRoot), 1); renderRoots(); });
      form.querySelector<HTMLButtonElement>('[type=submit]')!.disabled = !roots.length;
    };
    renderRoots();
    bindFolderPicker(form, prefs.home, chosen => { if (!roots.includes(chosen)) roots.push(chosen); renderRoots(); }, t => { error.textContent = t; });
    form.onsubmit = async e => {
      e.preventDefault(); if (busy) return; busy = true;
      const submit = form.querySelector<HTMLButtonElement>('[type=submit]')!; submit.disabled = true;
      try { await api.savePreferences({ roots, language: lang }); setLanguage(lang); location.reload(); }
      catch (err) { error.textContent = String(err); busy = false; submit.disabled = false; }
    };
  };
  render();
}
