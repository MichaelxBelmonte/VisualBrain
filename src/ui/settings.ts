// Impostazioni: one window for everything that is not daily work. The first run keeps the short welcome form.
import { api, type AgentCli, type CliUpdate } from './api.ts';
import { mainAccountName, refreshAccountNames } from './account-names.ts';
import { getLanguage, setLanguage, t as tr, ui, type Language } from './i18n.ts';
import { sectionViews } from './section-views.ts';
import { glassEnabled, nativeMac, setGlass, syncWindowTheme } from './window-chrome.ts';
import type { AgentAccountStatus, TerminalInfo } from '../shared/types.ts';
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
/** Takes down the window that is open now: opening Impostazioni again must not leave the old Esc handler behind. */
let dismantle: (() => void) | null = null;

export async function openSettings(firstRun = false, section?: SettingsSection): Promise<void> {
  if (firstRun) return openWelcome();
  const overlay = document.getElementById('overlay')!;
  dismantle?.();
  overlay.dataset.mode = 'settings'; overlay.classList.remove('hidden');
  let busy = false;
  overlay.innerHTML = ui`<div class="dialog settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title"><nav class="settings-nav" aria-label="Sezioni"><h2 id="settings-title">Impostazioni</h2>${SECTIONS.map(([id, label]) => `<button type="button" data-section="${id}">${esc(tr(label))}<span class="settings-badge" data-badge="${id}" hidden></span></button>`).join('')}</nav><div class="settings-main"><div class="settings-head"><h3 data-heading></h3><button class="plain-icon" data-close aria-label="Chiudi">×</button></div><div class="settings-body" data-body></div></div></div>`;
  const views = sectionViews(overlay.querySelector<HTMLElement>('[data-body]')!);
  const leave = () => { views.close(); document.removeEventListener('keydown', onKey, true); if (dismantle === leave) dismantle = null; };
  const close = () => { if (busy) return; leave(); overlay.classList.add('hidden'); overlay.innerHTML = ''; delete overlay.dataset.mode; };
  dismantle = leave;
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && overlay.dataset.mode === 'settings') { e.preventDefault(); e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  overlay.querySelector('[data-close]')!.addEventListener('click', close);
  overlay.onmousedown = e => { if (e.target === overlay) close(); };
  const terminal = (info: TerminalInfo) => { close(); hooks?.openTerminal(info); };
  const show = (id: SettingsSection) => {
    lastSection = id;
    overlay.querySelectorAll<HTMLElement>('[data-section]').forEach(b => b.setAttribute('aria-current', String(b.dataset.section === id)));
    overlay.querySelector('[data-heading]')!.textContent = tr(SECTIONS.find(s => s[0] === id)![1]);
    const render = { general, folders, agents, github, updates, shortcuts }[id];
    // each section in a root of its own: a slow answer of the section just left cannot write over this one
    views.show((root, schedule) => render(root, { terminal, setBusy: v => { busy = v; }, schedule, badge }), (root, e) => { root.innerHTML = `<p role="alert">${esc(String(e))}</p>`; });
  };
  const badge = (id: SettingsSection, count: number) => { const el = overlay.querySelector<HTMLElement>(`[data-badge="${id}"]`); if (el) { el.hidden = !count; el.textContent = String(count); } };
  overlay.querySelectorAll<HTMLElement>('[data-section]').forEach(b => b.addEventListener('click', () => show(b.dataset.section as SettingsSection)));
  show(section ?? lastSection);
  // The Agenti badge counts what needs the user (missing or signed-out CLIs) even when another section is open.
  // Updates waiting count too; the check behind them runs at most every 6 hours.
  void Promise.all([api.agents(), api.cliUpdates().catch(() => ({ updates: [] as CliUpdate[] }))])
    .then(([r, u]) => badge('agents', r.clis.filter(needsUser).length + u.updates.filter(updateWaiting).length)).catch(() => {});
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

const fill = (text: string, values: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (_, k: string) => String(values[k] ?? ''));
const MONOGRAM: Record<string, string> = { claude: 'CC', codex: 'CX', hermes: 'HE', agy: 'AG' };
/** An outcome stays on screen for half an hour; after that the line goes back to the plain state. */
const OUTCOME_FOR = 30 * 60_000;
const clock = (at: number) => new Date(at).toLocaleTimeString(getLanguage(), { hour: '2-digit', minute: '2-digit' });

/**
 * The update line of a CLI, the same in Agenti and in Aggiornamenti: the version installed, whether a newer one is out,
 * the update while it runs in the background and how it ended. `opened` keeps the logs open across redraws.
 */
function updateLine(id: string, label: string, u: CliUpdate | undefined, sessions: number, opened: ReadonlySet<string>): string {
  const line = (tone: string, title: string, note: string, actions = '', extra = '') =>
    `<div class="cli-update" data-tone="${tone}"><span class="cli-update-mark" aria-hidden="true"></span><span class="cli-update-text"><b>${title}</b>${note ? `<small>${note}</small>` : ''}</span>${actions ? `<span class="cli-update-actions">${actions}</span>` : ''}</div>${extra}`;
  if (!u) return line('wait', esc(tr('Controllo la versione più recente…')), '');
  const job = u.job, recent = !!job?.endedAt && Date.now() - job.endedAt < OUTCOME_FOR;
  const log = job?.log.trim() ? `<details class="cli-update-log" data-open-key="log:${id}" ${opened.has('log:' + id) ? 'open' : ''}><summary>${esc(tr('Mostra il registro'))}</summary><pre>${esc(job.log.trim())}</pre></details>` : '';
  const upgrade = (primary: boolean, text = tr('Aggiorna')) => `<button class="btn small${primary ? ' primary' : ''}" data-upgrade="${id}">${esc(text)}</button>`;
  if (job?.state === 'running') {
    return line('run', esc(tr('Aggiornamento in corso…')), esc(fill(tr('{cli} si aggiorna in background: puoi chiudere Impostazioni.'), { cli: label })), '', `<div class="update-progress unknown" role="progressbar" aria-label="${esc(tr('Aggiornamento in corso…'))}"><i></i></div>`);
  }
  if (recent && job!.state === 'failed') {
    return line('error', esc(tr('Aggiornamento non riuscito')), esc(tr('Il registro qui sotto dice cosa è andato storto. Dal terminale vedi anche le domande della CLI.')),
      upgrade(false, tr('Riprova')) + `<button class="btn small ghost" data-upgrade-terminal="${id}">${esc(tr('Apri nel terminale'))}</button>`, log);
  }
  if (recent && job!.state === 'done') {
    const changed = !!job!.to && job!.to !== job!.from;
    const note = !changed ? tr('La CLI non ha trovato versioni più nuove.')
      : sessions ? fill(sessions === 1 ? tr('La sessione aperta resta su v{from} finché non la riavvii.') : tr('Le {n} sessioni aperte restano su v{from} finché non le riavvii.'), { n: sessions, from: job!.from ?? '?' })
        : tr('Le nuove sessioni partono con questa versione.');
    return line('ok', esc(changed ? fill(tr('Aggiornato a v{v}'), { v: job!.to! }) : tr('Già all’ultima versione')), esc(note), '', log);
  }
  if (u.available) return line('new', esc(fill(tr('v{v} disponibile'), { v: u.latest! })), esc(fill(tr('Installata v{v}'), { v: u.current ?? '?' })), upgrade(true));
  if (u.available === false) return line('ok', esc(tr('Aggiornato')), esc(fill(tr('v{v} è la più recente · verificato alle {at}'), { v: u.current ?? u.latest ?? '?', at: clock(u.checkedAt ?? Date.now()) })));
  if (!u.canCheck) return line('idle', esc(tr('Nessuna verifica automatica')), esc(fill(tr('{cli} non pubblica la versione più recente: «Aggiorna» chiede alla CLI se ce n’è una.'), { cli: label })), upgrade(false));
  return line('idle', esc(tr('Versione più recente sconosciuta')), esc(tr('Il controllo non ha risposto, forse sei offline. Puoi aggiornare lo stesso.')), upgrade(false));
}

/** Buttons and logs of the update lines inside `root`. */
function bindUpdateLines(root: HTMLElement, opened: Set<string>, on: { upgrade(id: string, button: HTMLButtonElement): void; terminal(id: string, button: HTMLButtonElement): void }): void {
  root.querySelectorAll<HTMLButtonElement>('[data-upgrade]').forEach(b => b.addEventListener('click', () => on.upgrade(b.dataset.upgrade!, b)));
  root.querySelectorAll<HTMLButtonElement>('[data-upgrade-terminal]').forEach(b => b.addEventListener('click', () => on.terminal(b.dataset.upgradeTerminal!, b)));
  root.querySelectorAll<HTMLDetailsElement>('[data-open-key]').forEach(d => d.addEventListener('toggle', () => { if (d.open) opened.add(d.dataset.openKey!); else opened.delete(d.dataset.openKey!); }));
}
const updateWaiting = (u: CliUpdate) => !!u.available && u.job?.state !== 'running';

async function agents(root: HTMLElement, ctx: Ctx): Promise<void> {
  root.innerHTML = ui`<p class="muted">Controllo le CLI installate…</p>`;
  // renaming: the account whose name is being edited («main:claude» for a main account, otherwise the extra account's id).
  let advanced: string | null = null, renaming: string | null = null, adding: string | null = null;
  const opened = new Set<string>();
  let data: { clis: AgentCli[]; sessions: Record<string, number>; accounts: AgentAccountStatus[]; harnesses: Awaited<ReturnType<typeof api.harnesses>> } | null = null;
  // The versions arrive after the cards: the registry and `hermes update --check` can take a few seconds.
  let ups: CliUpdate[] | null = null, checking = false, upError = '';
  const load = async (fresh: boolean) => {
    const [{ clis, sessions, accounts = [] }, harnesses] = await Promise.all([api.agents(fresh), api.harnesses(), refreshAccountNames()]);
    data = { clis, sessions, accounts, harnesses };
  };
  const loadUpdates = async (fresh: boolean) => {
    checking = true; upError = '';
    if (data) paint();
    try { ups = (await api.cliUpdates(fresh)).updates; } catch (e) { upError = String(e); }
    checking = false;
    if (root.isConnected && data) paint();
  };
  const draw = async (fresh = false) => { await load(fresh); if (root.isConnected) paint(); };
  const paint = () => {
    const { clis, sessions, accounts, harnesses } = data!;
    ctx.badge('agents', clis.filter(needsUser).length + (ups ?? []).filter(updateWaiting).length);
    // The name of an account, or the field to change it while it is being renamed.
    const nameCell = (key: string, name: string) => renaming !== key ? `<b>${esc(name)}</b>`
      : ui`<form class="cli-rename" data-rename-form="${esc(key)}"><input name="name" maxlength="40" value="${esc(name)}" aria-label="Nome dell’account"><button class="btn small primary" type="submit">Salva</button><button class="btn small ghost" type="button" data-rename-cancel>Annulla</button></form>`;
    const renameButton = (key: string) => renaming === key ? '' : ui`<button class="btn small ghost" data-rename-start="${esc(key)}">Rinomina</button>`;
    const pill = (tone: string, text: string) => `<span class="provider-pill" data-tone="${tone}"><i></i>${esc(text)}</span>`;
    const accountState = (signedIn: boolean | null) => signedIn === false ? pill('warn', tr('Accesso richiesto')) : signedIn === true ? pill('ok', tr('Connesso')) : pill('off', tr('Stato sconosciuto'));
    // The account the CLI uses on its own. Claude Code and Codex let you name it: the name is the label on the sessions.
    const mainRow = (c: AgentCli) => {
      const key = 'main:' + c.id, multi = c.id === 'claude' || c.id === 'codex';
      const name = multi ? mainAccountName(c.id) : tr('Account della CLI');
      // Hermes and Antigravity do not say whether they are signed in: no state, and Hermes signs in through its setup.
      const sub = c.account ?? (c.signedIn === false ? tr('accesso da completare') : c.signedIn === null ? tr('La CLI non dice con quale account sei collegato.') : tr('account principale'));
      const login = c.signedIn === true ? tr('Cambia account') : c.id === 'hermes' ? tr('Configura') : tr('Accedi');
      const actions = (c.signedIn === false ? ui`<button class="btn small primary" data-act="login" data-cli="${c.id}">Accedi</button>`
        : `<button class="btn small ghost" data-act="login" data-cli="${c.id}">${esc(login)}</button>`)
        + (c.canLogout && c.signedIn === true ? ui`<button class="btn small ghost" data-act="logout" data-cli="${c.id}">Esci</button>` : '')
        + (multi ? renameButton(key) : '');
      return `<li class="provider-account"><div class="provider-account-main"><span class="provider-account-name">${nameCell(key, name)}${multi ? `<em>${esc(tr('principale'))}</em>` : ''}</span><small>${esc(sub)}</small></div>${c.signedIn === null ? '<span></span>' : accountState(c.signedIn)}<span class="provider-account-actions">${actions}</span></li>`;
    };
    // An extra account: the name chosen by the person, the email the CLI reports, sign-in, Avanzate and removal.
    const accountRow = (a: AgentAccountStatus) => {
      const sub = a.email ?? (a.sessions ? '' : tr('accesso da completare'));
      const used = a.sessions ? (a.sessions === 1 ? tr('1 sessione attiva') : fill(tr('{n} sessioni attive'), { n: a.sessions })) : '';
      const actions = (a.signedIn === false ? ui`<button class="btn small primary" data-account="${a.id}" data-account-act="login">Accedi</button>` : ui`<button class="btn small ghost" data-account="${a.id}" data-account-act="logout">Esci</button>`)
        + renameButton(a.id)
        + ui`<button class="btn small ghost" data-account-adv="${a.id}" aria-expanded="${advanced === a.id}">Avanzate</button>`
        + ui`<button class="btn small ghost" data-account="${a.id}" data-account-act="remove" ${a.sessions ? ui`disabled title="Chiudi prima le sessioni attive di questo account"` : ''}>Rimuovi</button>`;
      // Avanzate: off by default. Linked, never copied; settings, default model, permissions and sign-in stay separate.
      const option = (key: 'memory' | 'tools', title: string, note: string) => ui`<label class="cli-share"><input type="checkbox" data-share="${key}" data-share-account="${a.id}" ${a.share?.[key] ? 'checked' : ''}><span><b>${title}</b><small>${note}</small></span></label>`;
      const share = advanced !== a.id ? '' : `<div class="provider-advanced">${a.agent === 'claude'
        ? option('memory', tr('Memoria dell’account principale'), tr('Le sessioni leggono e scrivono la memoria automatica del progetto dell’account principale. Una memoria di squadra propria resta prioritaria.'))
          + option('tools', tr('Skill, plugin, comandi, agenti e CLAUDE.md dell’account principale'), tr('Collegati, non copiati: una modifica vale per entrambi gli account. I plugin attivi sono quelli dell’account principale.'))
        : option('tools', tr('Skill, regole, prompt e AGENTS.md dell’account principale'), tr('Collegati, non copiati: una modifica vale per entrambi gli account.'))
      }${ui`<p class="muted">Impostazioni, modello predefinito, permessi e accesso restano separati. Vale per le sessioni avviate da ora; ciò che l’account aveva di suo resta da parte e torna quando spegni l’opzione.</p>`}</div>`;
      return `<li class="provider-account" title="${esc(a.home)}"><div class="provider-account-main"><span class="provider-account-name">${nameCell(a.id, a.label)}</span><small>${esc([sub, used].filter(Boolean).join(' · '))}</small></div>${accountState(a.signedIn)}<span class="provider-account-actions">${actions}</span>${share}</li>`;
    };
    const card = (c: AgentCli) => {
      const s = cliState(c), used = sessions[c.id] ?? 0, multi = c.id === 'claude' || c.id === 'codex';
      const u = ups?.find(x => x.id === c.id);
      const version = u?.current ?? c.version;
      const meta = !c.path ? tr('non installato su questo Mac') : [version ? `v${version}` : c.command, used ? (used === 1 ? tr('1 sessione attiva') : fill(tr('{n} sessioni attive'), { n: used })) : tr('nessuna sessione aperta')].join(' · ');
      const head = `<header class="provider-head"><span class="provider-mark" aria-hidden="true">${MONOGRAM[c.id] ?? esc(c.label.slice(0, 2).toUpperCase())}</span><div class="provider-title"><h4>${esc(c.label)}</h4><small>${esc(meta)}</small></div>${pill(s.tone === 'ok' ? 'ok' : s.tone, s.text)}</header>`;
      const details = `<details class="provider-details" data-open-key="more:${c.id}" ${opened.has('more:' + c.id) ? 'open' : ''}><summary>${esc(tr('Dettagli tecnici'))}</summary>${ui`<dl class="cli-detail"><dt>Eseguibile</dt><dd><code>${esc(c.path ?? c.command)}</code></dd><dt>Installazione</dt><dd><code>${esc(c.installCommand)}</code></dd><dt>Documentazione</dt><dd><a href="${esc(c.docs)}" target="_blank" rel="noreferrer">${esc(c.docs.replace(/^https?:\/\//, ''))}</a></dd></dl>`}<div class="cli-more">${c.path ? ui`<button class="btn small ghost" data-act="update" data-cli="${c.id}">Aggiorna nel terminale</button>` : ''}<button class="btn small ghost" data-copy="${c.id}">${esc(tr('Copia diagnostica'))}</button></div></details>`;
      if (!c.path) {
        return `<section class="provider" data-installed="false">${head}<div class="provider-install"><p class="muted">${esc(tr('Si installa con il comando ufficiale in un terminale visibile: funziona anche fuori da Visual Brain.'))}</p>${ui`<button class="btn small primary" data-act="install" data-cli="${c.id}">Installa</button>`}</div>${details}</section>`;
      }
      const mine = accounts.filter(a => a.agent === c.id);
      const add = !multi ? '' : adding === c.id
        ? ui`<li class="provider-add"><form class="cli-add-account" data-add-account="${c.id}"><input name="label" maxlength="40" required placeholder="Nome del nuovo account (es. Lavoro)" aria-label="Nome del nuovo account"><button class="btn small primary" type="submit">Aggiungi e accedi</button><button class="btn small ghost" type="button" data-add-cancel>Annulla</button></form><small>Un altro abbonamento da usare insieme al principale, anche nello stesso momento. Dopo l’accesso lo scegli dal menu Agente quando avvii un agente.</small></li>`
        : ui`<li class="provider-add"><button class="btn small ghost" data-add-open="${c.id}">+ Aggiungi account</button></li>`;
      const update = `<div class="provider-update">${upError && !u ? `<p class="muted">${esc(upError)}</p>` : updateLine(c.id, c.label, u, used, opened)}</div>`;
      return `<section class="provider" data-installed="true">${head}${update}<div class="provider-accounts"><h5>${esc(mine.length ? fill(tr('Account · {n}'), { n: mine.length + 1 }) : tr('Account'))}</h5><ul>${mainRow(c)}${mine.map(accountRow).join('')}${add}</ul></div>${details}</section>`;
    };
    // Extra accounts whose CLI is gone stay visible, so they can be removed.
    const orphans = accounts.filter(a => !clis.some(c => c.id === a.agent && c.path));
    const steps: Record<string, string> = { download: tr('Scaricamento componenti'), python: tr('Preparazione Python'), packages: tr('Installazione pacchetti'), verify: tr('Verifica installazione') };
    const harnessRow = (h: Awaited<ReturnType<typeof api.harnesses>>[number]) => {
      const installing = h.install?.state === 'installing';
      const text = installing ? steps[h.install!.step] || tr('Installazione in corso…') : h.install?.state === 'error' ? tr('Errore') : h.outdated ? ui`Aggiornamento ${h.latest ?? ''}` : h.installed ? tr('Installato') : h.canInstall ? tr('Non installato') : tr('Solo nel pacchetto Mac');
      const tone = h.installed && !h.outdated ? 'ok' : installing || h.outdated ? 'warn' : 'off';
      const button = installing ? '' : !h.installed ? ui`<button class="btn small primary" data-harness="${h.id}" ${h.canInstall ? '' : 'disabled'}>Installa</button>` : h.outdated ? ui`<button class="btn small" data-harness="${h.id}">Aggiorna</button>` : '';
      return `<div class="cli-row"><div class="cli-summary static"><span class="cli-dot" data-tone="${tone}"></span><span class="cli-name"><b>${esc(h.label)}</b><small>${esc(h.version ? String(h.version).slice(0, 12) : tr('nel profilo di Visual Brain'))}</small></span><span class="cli-state" data-tone="${tone}" title="${esc(h.install?.error ? tr(h.install.error) : '')}">${esc(text)}</span></div><span class="cli-actions">${button}</span></div>`;
    };
    const waiting = (ups ?? []).filter(updateWaiting);
    const ordered = [...clis].sort((a, b) => Number(!a.path) - Number(!b.path));
    const scroll = root.closest('.settings-body')?.scrollTop ?? 0;
    root.innerHTML = ui`<div class="settings-subhead"><h4>Provider</h4><span class="provider-toolbar">${waiting.length > 1 ? `<button class="btn small" data-upgrade-all>${esc(fill(tr('Aggiorna tutti ({n})'), { n: waiting.length }))}</button>` : ''}<button class="btn small ghost" data-refresh ${checking ? 'disabled' : ''}>${checking ? tr('Verifica in corso…') : tr('Verifica aggiornamenti')}</button></span></div>
      <p class="muted">Ogni provider con la sua versione e i suoi account. Gli aggiornamenti usano il comando ufficiale della CLI, in background; accesso e installazione si aprono in un terminale visibile. Le credenziali restano alla CLI.</p>
      <div class="provider-list">${ordered.map(card).join('')}</div>
      ${orphans.length ? `<div class="settings-subhead"><h4>${esc(tr('Account senza CLI'))}</h4></div><ul class="provider-orphans">${orphans.map(accountRow).join('')}</ul>` : ''}
      <div class="settings-subhead"><h4>Harness</h4></div><p class="muted">Esecuzioni a tempo dal nodo. Si installano nel profilo di Visual Brain, senza chiamate ai modelli.</p>
      <div class="cli-list">${harnesses.map(harnessRow).join('')}</div><p class="work-launch-error" role="alert"></p>`;
    const body = root.closest('.settings-body');
    if (body) body.scrollTop = scroll;
    const error = root.querySelector('[role=alert]')!;
    const upgrade = async (id: string, b?: HTMLButtonElement) => {
      if (b) b.disabled = true;
      try {
        const { job } = await api.upgradeCli(id);
        const u = ups?.find(x => x.id === id);
        if (u) u.job = job;
        paint();
      } catch (e) { error.textContent = String(e); if (b) b.disabled = false; }
    };
    bindUpdateLines(root, opened, {
      upgrade: (id, b) => void upgrade(id, b),
      terminal: async (id, b) => { b.disabled = true; try { ctx.terminal((await api.agentAction(id, 'update')).info); } catch (e) { error.textContent = String(e); b.disabled = false; } },
    });
    root.querySelector('[data-upgrade-all]')?.addEventListener('click', () => { for (const u of waiting) void upgrade(u.id); });
    root.querySelector('[data-refresh]')!.addEventListener('click', () => { void Promise.all([draw(true), loadUpdates(true)]).catch(e => { error.textContent = String(e); }); });
    root.querySelectorAll<HTMLButtonElement>('[data-act]').forEach(b => b.addEventListener('click', async () => {
      b.disabled = true;
      try { const r = await api.agentAction(b.dataset.cli!, b.dataset.act as 'install' | 'update' | 'login' | 'logout'); ctx.terminal(r.info); }
      catch (e) { error.textContent = String(e); b.disabled = false; }
    }));
    root.querySelectorAll<HTMLButtonElement>('[data-add-open]').forEach(b => b.addEventListener('click', () => {
      adding = b.dataset.addOpen!; paint();
      root.querySelector<HTMLInputElement>('[data-add-account] input')?.focus();
    }));
    root.querySelectorAll<HTMLFormElement>('[data-add-account]').forEach(form => {
      const input = form.querySelector<HTMLInputElement>('input')!;
      const cancel = () => { adding = null; paint(); };
      form.querySelector('[data-add-cancel]')!.addEventListener('click', cancel);
      input.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); } });
      form.addEventListener('submit', async e => {
        e.preventDefault();
        const button = form.querySelector<HTMLButtonElement>('[type=submit]')!, label = input.value.trim();
        if (!label) return;
        button.disabled = true;
        try { const r = await api.addAccount(form.dataset.addAccount as 'claude' | 'codex', label); adding = null; ctx.terminal(r.info); await draw(false); }
        catch (err) { error.textContent = String(err); button.disabled = false; }
      });
    });
    root.querySelectorAll<HTMLButtonElement>('[data-rename-start]').forEach(b => b.addEventListener('click', () => {
      renaming = b.dataset.renameStart!; paint();
      const input = root.querySelector<HTMLInputElement>('[data-rename-form] input');
      input?.focus(); input?.select();
    }));
    root.querySelectorAll<HTMLFormElement>('[data-rename-form]').forEach(form => {
      const key = form.dataset.renameForm!, input = form.querySelector<HTMLInputElement>('input')!;
      const cancel = () => { renaming = null; paint(); };
      form.querySelector('[data-rename-cancel]')!.addEventListener('click', cancel);
      input.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); } });
      form.addEventListener('submit', async e => {
        e.preventDefault();
        const save = form.querySelector<HTMLButtonElement>('[type=submit]')!;
        save.disabled = true;
        try {
          // A main account with an empty name goes back to «Principale»; an extra account needs a name.
          if (key.startsWith('main:')) await api.setMainAccountName(key.slice(5) as 'claude' | 'codex', input.value.trim());
          else await api.renameAccount(key, input.value.trim());
          renaming = null;
          await draw(false);
        } catch (err) { error.textContent = String(err); save.disabled = false; }
      });
    });
    root.querySelectorAll<HTMLButtonElement>('[data-account-adv]').forEach(b => b.addEventListener('click', () => { advanced = advanced === b.dataset.accountAdv ? null : b.dataset.accountAdv!; paint(); }));
    root.querySelectorAll<HTMLInputElement>('[data-share]').forEach(box => box.addEventListener('change', async () => {
      const account = accounts.find(a => a.id === box.dataset.shareAccount);
      if (!account) return;
      box.disabled = true;
      try { await api.setAccountShare(account.id, { ...account.share, [box.dataset.share!]: box.checked }); await draw(false); }
      catch (err) { error.textContent = String(err); box.checked = !box.checked; box.disabled = false; }
    }));
    root.querySelectorAll<HTMLButtonElement>('[data-account-act]').forEach(b => b.addEventListener('click', async () => {
      const id = b.dataset.account!, act = b.dataset.accountAct!;
      const account = accounts.find(a => a.id === id);
      if (act === 'remove' && !confirm(ui`Rimuovere l’account «${account?.label ?? id}» da Visual Brain? La sua cartella resta: riaggiungendolo con lo stesso nome ritrovi accesso e conversazioni.`)) return;
      b.disabled = true;
      try {
        if (act === 'remove') { await api.removeAccount(id); await draw(true); }
        else { const r = await api.accountAction(id, act as 'login' | 'logout'); ctx.terminal(r.info); }
      } catch (err) { error.textContent = String(err); b.disabled = false; }
    }));
    root.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach(b => b.addEventListener('click', async () => {
      const c = clis.find(x => x.id === b.dataset.copy)!, u = ups?.find(x => x.id === c.id);
      const text = [`${c.label} (${c.id})`, `command: ${c.command}`, `path: ${c.path ?? 'not found'}`, `version: ${u?.current ?? c.version ?? '-'}`, `latest: ${u?.latest ?? '-'}`, `signed in: ${c.signedIn ?? 'unknown'}`, `install: ${c.installCommand}`, `live sessions: ${sessions[c.id] ?? 0}`, `app: ${hooks?.appVersion() || '-'}`, `platform: ${navigator.platform}`].join('\n');
      try { await navigator.clipboard.writeText(text); b.textContent = tr('Copiata'); } catch { error.textContent = text; }
    }));
    root.querySelectorAll<HTMLDetailsElement>('.provider-details').forEach(d => d.addEventListener('toggle', () => { if (d.open) opened.add(d.dataset.openKey!); else opened.delete(d.dataset.openKey!); }));
    root.querySelectorAll<HTMLButtonElement>('[data-harness]').forEach(b => b.addEventListener('click', async () => {
      b.disabled = true;
      try { await api.installHarness(b.dataset.harness!); await draw(false); } catch (e) { error.textContent = String(e); b.disabled = false; }
    }));
    // While something installs or updates, look again shortly; a finished update changes the version on the card.
    const running = (ups ?? []).some(u => u.job?.state === 'running');
    if (running || harnesses.some(h => h.install?.state === 'installing')) ctx.schedule(() => {
      if (!root.isConnected) return;
      void (async () => {
        if (running) {
          const next = (await api.cliUpdates()).updates;
          const ended = next.some(n => ups?.find(o => o.id === n.id)?.job?.state === 'running' && n.job?.state !== 'running');
          ups = next;
          if (ended) await load(false);
        } else await load(false);
        if (root.isConnected) paint();
      })().catch(() => {});
    });
  };
  await load(false);
  if (!root.isConnected) return;
  paint();
  void loadUpdates(false);
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

async function updates(root: HTMLElement, ctx: Ctx): Promise<void> {
  // its own element: the row stops following the server when another section replaces it
  const row = root.appendChild(document.createElement('div'));
  hooks?.mountUpdates(row);
  // The agent CLIs below the app, with the same line as in Agenti.
  const list = root.appendChild(document.createElement('div'));
  list.className = 'cli-updates';
  const opened = new Set<string>();
  let ups: CliUpdate[] | null = null, clis: AgentCli[] = [], sessions: Record<string, number> = {}, checking = false;
  const paint = () => {
    const installed = clis.filter(c => c.path);
    if (!installed.length) { list.innerHTML = ''; return; }
    const waiting = (ups ?? []).filter(updateWaiting);
    list.innerHTML = ui`<div class="settings-subhead"><h4>Agenti</h4><span class="provider-toolbar">${waiting.length > 1 ? `<button class="btn small" data-upgrade-all>${esc(fill(tr('Aggiorna tutti ({n})'), { n: waiting.length }))}</button>` : ''}<button class="btn small ghost" data-refresh ${checking ? 'disabled' : ''}>${checking ? tr('Verifica in corso…') : tr('Verifica aggiornamenti')}</button></span></div>`
      + `<ul class="cli-update-list">${installed.map(c => `<li><span class="provider-mark" aria-hidden="true">${MONOGRAM[c.id] ?? ''}</span><div><h5>${esc(c.label)}</h5>${updateLine(c.id, c.label, ups?.find(u => u.id === c.id), sessions[c.id] ?? 0, opened)}</div></li>`).join('')}</ul>`
      + ui`<p class="muted">Ogni CLI si aggiorna con il suo comando ufficiale. Le sessioni già aperte continuano con la versione con cui sono partite finché non le riavvii.</p><p class="work-launch-error" role="alert"></p>`;
    const error = list.querySelector('[role=alert]')!;
    const upgrade = async (id: string, b?: HTMLButtonElement) => {
      if (b) b.disabled = true;
      try { const { job } = await api.upgradeCli(id); const u = ups?.find(x => x.id === id); if (u) u.job = job; paint(); }
      catch (e) { error.textContent = String(e); if (b) b.disabled = false; }
    };
    bindUpdateLines(list, opened, {
      upgrade: (id, b) => void upgrade(id, b),
      terminal: async (id, b) => { b.disabled = true; try { ctx.terminal((await api.agentAction(id, 'update')).info); } catch (e) { error.textContent = String(e); b.disabled = false; } },
    });
    list.querySelector('[data-upgrade-all]')?.addEventListener('click', () => { for (const u of waiting) void upgrade(u.id); });
    list.querySelector('[data-refresh]')!.addEventListener('click', () => void check(true));
    if ((ups ?? []).some(u => u.job?.state === 'running')) ctx.schedule(() => void check(false));
  };
  const check = async (fresh: boolean) => {
    checking = fresh; if (fresh) paint();
    try { ups = (await api.cliUpdates(fresh)).updates; } catch { /* the line says it could not check */ }
    checking = false;
    if (list.isConnected) paint();
  };
  const r = await api.agents();
  clis = r.clis; sessions = r.sessions;
  paint();
  await check(false);
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
