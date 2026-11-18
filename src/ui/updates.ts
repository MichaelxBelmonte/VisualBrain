// Updates in the page: a banner when a verified update is ready, and the "Aggiornamenti" row of Impostazioni, where the
// whole path is one button that changes with the state: check, update, restart.
// The server does the work (src/server/updater.ts); this only shows its state and asks for the user's confirmation.
import { t as tr, ui } from './i18n.ts';
import { api } from './api.ts';

export interface UpdateView {
  enabled: boolean; current: string; status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'installing' | 'installed' | 'error';
  latest: string | null; notes: string; error: string; checkedAt: number | null; liveSessions: number;
  /** Absent on servers older than 0.2.12. */
  installedTo?: string | null; relocated?: boolean;
  /** Absent on servers older than 0.2.49. */
  outsideApplications?: boolean; applicationsCopy?: string | null; app?: string | null;
  /** Capability of the running backend, never inferred from the downloaded version. */
  persistentTerminals?: boolean;
  /** Absent on servers older than 0.2.52. */
  progress?: { received: number; total: number } | null; canRestart?: boolean;
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** What the banner says for a state, or null when there is nothing to show. Pure, so the wording is testable. */
export function bannerFor(s: UpdateView, dismissed: string | null, locationDismissed = false): { kind: 'ready' | 'installed' | 'error' | 'busy' | 'location'; text: string; restart?: true } | null {
  if (!s.enabled) return null;
  // the same offer as the Aggiornamenti row: one click, the terminals stay. «Chiudi» hides it for the session (the row stays).
  if (s.status === 'installed' && s.canRestart && s.persistentTerminals === true) return dismissed === restartKey(s) ? null : { kind: 'installed', restart: true, text: restartText(s) };
  if (s.status === 'ready' && s.latest && dismissed !== s.latest) return { kind: 'ready', text: ui`La versione ${s.latest} è pronta. Installarla non chiude nessun terminale.` };
  if (s.status === 'installing') return { kind: 'busy', text: tr('Installazione in corso…') };
  if (s.status === 'installed' && s.persistentTerminals === true) return { kind: 'installed', text: s.relocated
    ? ui`Versione ${s.latest ?? ''} installata in Applicazioni. Chiudi Visual Brain (⌘Q): si riaprirà da Applicazioni. I terminali restano attivi e li ritroverai alla riapertura.`
    : ui`Versione ${s.latest ?? ''} installata. Chiudi con ⌘Q e riapri per usarla. I terminali restano attivi e li ritroverai alla riapertura.` };
  if (s.status === 'installed' && s.relocated) return { kind: 'installed', text: ui`Versione ${s.latest ?? ''} installata in Applicazioni. Chiudi Visual Brain (⌘Q): si riaprirà da Applicazioni. Puoi cestinare la copia che hai aperto.` };
  if (s.status === 'installed') return { kind: 'installed', text: s.liveSessions > 0 ? ui`Versione ${s.latest ?? ''} installata. Si attiva al prossimo avvio: chiudi con ⌘Q e riapri quando hai finito (${s.liveSessions} terminali attivi si chiuderanno).` : ui`Versione ${s.latest ?? ''} installata. Chiudi con ⌘Q e riapri per usarla.` };
  if (s.status === 'error' && /EROFS|read-only file system|AppTranslocation/i.test(s.error)) return { kind: 'error', text: tr('Visual Brain è aperta da una posizione in sola lettura (Download o immagine disco). Chiudila, spostala in Applicazioni e riaprila.') };
  if (s.status === 'error' && s.error) return { kind: 'error', text: s.error };
  // A copy outside Applications (build folder, Downloads…): updates go to Applications and macOS permissions belong to each copy.
  if (s.outsideApplications && !locationDismissed) return { kind: 'location', text: s.applicationsCopy
    ? ui`Stai usando una copia di Visual Brain fuori da Applicazioni${s.app ? ` (${s.app})` : ''}. Gli aggiornamenti vanno in quella in Applicazioni: chiudi questa (⌘Q) e apri Visual Brain da Applicazioni.`
    : ui`Stai usando una copia di Visual Brain fuori da Applicazioni${s.app ? ` (${s.app})` : ''}. Chiudila (⌘Q), trascinala nella cartella Applicazioni e aprila da lì: gli aggiornamenti si installano solo lì.` };
  return null;
}

const READ_ONLY = /EROFS|read-only file system|AppTranslocation/i;
const fill = (text: string, values: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (_m, key: string) => String(values[key] ?? ''));
/** What «Chiudi» on the restart banner remembers: kept apart from «Più tardi» on a ready version. */
export const restartKey = (s: Pick<UpdateView, 'latest'>) => `restart:${s.latest ?? ''}`;
function restartText(s: UpdateView): string {
  return fill(tr(s.relocated ? 'Versione {v} installata in Applicazioni. Riavvia per usarla: i terminali restano attivi.' : 'Versione {v} installata. Riavvia per usarla: i terminali restano attivi.'), { v: s.latest ?? '' });
}
/** After this long without the window going away the restart is stuck somewhere the page cannot see: say what to do. */
export const RESTART_SLOW_MS = 20_000;

export interface UpdateRow {
  /** The sentence under the app name. It changes with the step, never with the percentage: it is a live region. */
  text: string;
  tone: 'quiet' | 'ok' | 'busy' | 'ready' | 'error';
  /** The one button of the row, or null while the app works or nothing can be done from here. */
  action: { id: 'check' | 'install' | 'restart'; label: string; primary: boolean } | null;
  /** 0–1 while the package downloads, 'unknown' for work without a measure, null when nothing is running. */
  progress: number | 'unknown' | null;
}

/**
 * The "Aggiornamenti" row for a state. `s` is null when the server did not answer; `restarting` once "Riavvia" was accepted,
 * 'slow' when the window is still here RESTART_SLOW_MS later. Pure, so every wording is testable.
 */
export function settingsRow(s: UpdateView | null, restarting: boolean | 'slow' = false): UpdateRow {
  // the server is gone on purpose: whatever happened, only ⌘Q is left, and the terminals are safe in their own host
  if (restarting === 'slow') return { text: tr('Il riavvio ci mette più del previsto. Se Visual Brain non si riapre, chiudila con ⌘Q e riaprila: i terminali restano attivi.'), tone: 'error', action: null, progress: null };
  const retry = { id: 'check' as const, label: tr('Riprova'), primary: false };
  if (!s) return { text: tr('Non riesco a leggere lo stato degli aggiornamenti.'), tone: 'error', action: retry, progress: null };
  if (!s.enabled) return { text: tr('Gli aggiornamenti automatici sono attivi solo nell’app installata.'), tone: 'quiet', action: null, progress: null };
  const v = s.latest ?? '';
  if (restarting) return { text: tr('Riavvio in corso…'), tone: 'busy', action: null, progress: 'unknown' };
  switch (s.status) {
    case 'checking': return { text: tr('Cerco aggiornamenti…'), tone: 'busy', action: null, progress: 'unknown' };
    case 'available': case 'downloading': {
      const p = s.progress && s.progress.total > 0 ? Math.max(0, Math.min(1, s.progress.received / s.progress.total)) : 'unknown';
      return { text: fill(tr('Scarico la versione {v}…'), { v }), tone: 'busy', action: null, progress: p };
    }
    case 'ready': return { text: fill(tr('La versione {v} è pronta. Installarla non chiude nessun terminale.'), { v }), tone: 'ready', action: { id: 'install', label: fill(tr('Aggiorna alla {v}'), { v }), primary: true }, progress: null };
    case 'installing': return { text: tr('Installazione in corso…'), tone: 'busy', action: null, progress: 'unknown' };
    case 'installed': {
      // A restart is offered only when it costs nothing: the terminals live in their own host and are found again.
      if (s.canRestart && s.persistentTerminals) return {
        text: restartText(s),
        tone: 'ok', action: { id: 'restart', label: tr('Riavvia ora'), primary: true }, progress: null,
      };
      const text = s.persistentTerminals || s.liveSessions === 0
        ? fill(tr('Versione {v} installata. Chiudi con ⌘Q e riapri per usarla.'), { v })
        : fill(tr('Versione {v} installata. Chiudi con ⌘Q e riapri quando hai finito: {n} terminali attivi si chiuderanno.'), { v, n: s.liveSessions });
      return { text, tone: 'ok', action: null, progress: null };
    }
    case 'error': return { text: READ_ONLY.test(s.error) ? tr('Visual Brain è aperta da una posizione in sola lettura (Download o immagine disco). Chiudila, spostala in Applicazioni e riaprila.') : s.error || tr('Aggiornamento non riuscito.'), tone: 'error', action: retry, progress: null };
    default: return {
      text: s.checkedAt ? fill(tr('Sei aggiornato: la {v} è l’ultima versione.'), { v: s.current }) : tr('Installare un aggiornamento non chiude i terminali.'),
      tone: s.checkedAt ? 'ok' : 'quiet', action: { id: 'check', label: tr('Verifica aggiornamenti'), primary: false }, progress: null,
    };
  }
}

/** Release notes are a short Markdown list: one plain line per item, without the emphasis marks. */
export function noteLines(notes: string): string[] {
  return notes.split('\n').map(line => line.replace(/^\s*[-*•]\s+/, '').replace(/\*\*/g, '').trim()).filter(Boolean);
}

const WORKING = new Set<UpdateView['status']>(['checking', 'available', 'downloading', 'installing']);
/** While the server works the row follows it closely; otherwise once a minute is enough for the banner. */
const FOLLOW_MS = 400;

export class Updates {
  private state: UpdateView | null = null;
  private dismissed: string | null = null;
  private locationDismissed = false;
  private readonly banner: HTMLElement;
  /** False after a state read that failed: the row says so instead of showing an old state. */
  private reachable = true;
  private restarting: boolean | 'slow' = false;
  /** Bumped by every action: a state read that started before it answers with an older state and is dropped. */
  private epoch = 0;
  private follow: ReturnType<typeof setTimeout> | null = null;
  private readonly rows = new Set<() => void>();

  constructor(banner: HTMLElement) {
    this.banner = banner;
    try { this.dismissed = sessionStorage.getItem('vb:update-dismissed'); this.locationDismissed = sessionStorage.getItem('vb:location-dismissed') === '1'; } catch { /* storage unavailable */ }
    void this.refresh();
    setInterval(() => void this.refresh(), 60_000);
  }

  get current(): string { return this.state?.current ?? ''; }
  get enabled(): boolean { return !!this.state?.enabled; }

  async refresh(): Promise<void> {
    const epoch = this.epoch;
    let next: UpdateView | null = null;
    try { next = await api.updateState(); } catch { /* below */ }
    // After "Riavvia" the server goes away on purpose: that is not an error to show.
    if (epoch !== this.epoch || this.restarting) return;
    if (next) { this.state = next; this.reachable = true; } else this.reachable = false;
    this.render();
  }

  /** Shows `next` at once, then asks the server; a refusal is already in the server's state, which is read again. */
  private async act(next: UpdateView['status'], call: () => Promise<UpdateView>): Promise<void> {
    this.epoch++;
    if (this.state) { this.state = { ...this.state, status: next, error: '' }; this.render(); }
    try { this.state = await call(); this.reachable = true; this.render(); } catch { await this.refresh(); }
  }

  private check(): Promise<void> { return this.act('checking', api.updateCheck); }
  private install(): Promise<void> { return this.act('installing', api.updateInstall); }

  private async restart(): Promise<void> {
    if (this.restarting) return;
    this.epoch++; this.restarting = true; this.render();
    try { await api.updateRestart(); } catch (error) {
      this.restarting = false;
      if (this.state) this.state = { ...this.state, status: 'error', error: String(error instanceof Error ? error.message : error) };
      this.render();
      return;
    }
    // On success this window is closed by the watcher; still here means it is stuck, and the page says what to do.
    setTimeout(() => { this.restarting = 'slow'; this.render(); }, RESTART_SLOW_MS);
  }

  /**
   * The "Aggiornamenti" row of Impostazioni, kept in step with the server until `root` leaves the page.
   * The frame is rebuilt only when the step changes, so its short entrance plays once; the percentage moves in place.
   */
  mountSettings(root: HTMLElement): void {
    // The status line is built once and only its text changes: a live region inserted already filled is often not read.
    root.innerHTML = `<div class="settings-row update-row"></div>`
      + `<div class="update-progress" role="progressbar" aria-label="${esc(tr('Avanzamento dell’aggiornamento'))}" aria-valuemin="0" aria-valuemax="100"><i></i></div>`
      + `<p class="update-status" role="status"><i class="update-mark" aria-hidden="true"></i><span tabindex="-1"></span></p><div data-update-notes></div>`;
    const head = root.querySelector<HTMLElement>('.update-row')!, status = root.querySelector<HTMLElement>('.update-status')!;
    const said = status.querySelector<HTMLElement>('span')!, notesBox = root.querySelector<HTMLElement>('[data-update-notes]')!;
    let shown = '';
    const paint = () => {
      if (!root.isConnected) { this.rows.delete(paint); return; }
      const s = this.reachable ? this.state : null;
      const row = settingsRow(s, this.restarting);
      const notes = s && s.latest && s.status !== 'installed' ? noteLines(s.notes) : [];
      const key = JSON.stringify([row.text, row.tone, row.action, notes, this.current]);
      if (key !== shown) {
        const hadFocus = root.contains(document.activeElement);
        shown = key;
        head.innerHTML = `<div><b>Visual Brain</b><small>${this.current ? ui`versione ${esc(this.current)}` : tr('versione di sviluppo')}</small></div>${row.action ? `<button type="button" class="btn small${row.action.primary ? ' primary' : ''}" data-update="${row.action.id}">${esc(row.action.label)}</button>` : '<span class="update-pct" aria-hidden="true"></span>'}`;
        status.dataset.tone = row.tone;
        if (said.textContent !== row.text) said.textContent = row.text;
        notesBox.innerHTML = notes.length ? `<details class="update-notes"><summary>${esc(tr('Novità della {v}').replace('{v}', s!.latest!))}</summary><ul>${notes.map(line => `<li>${esc(line)}</li>`).join('')}</ul></details>` : '';
        const button = head.querySelector<HTMLButtonElement>('[data-update]');
        if (button) button.onclick = () => void ({ check: () => this.check(), install: () => this.install(), restart: () => this.restart() })[row.action!.id]();
        // the button that was pressed is replaced by the next step: the keyboard stays in the row
        if (hadFocus && !root.contains(document.activeElement)) (button ?? said).focus({ preventScroll: true });
      }
      const bar = root.querySelector<HTMLElement>('.update-progress')!;
      const known = typeof row.progress === 'number';
      const percent = known ? Math.round((row.progress as number) * 100) : null;
      // idle, the track is only the line under the row
      if (row.progress === null) bar.setAttribute('aria-hidden', 'true'); else bar.removeAttribute('aria-hidden');
      bar.classList.toggle('unknown', row.progress === 'unknown');
      if (percent === null) bar.removeAttribute('aria-valuenow'); else bar.setAttribute('aria-valuenow', String(percent));
      bar.querySelector<HTMLElement>('i')!.style.width = percent === null ? '' : `${percent}%`;
      const pct = root.querySelector<HTMLElement>('.update-pct');
      if (pct) pct.textContent = percent === null ? '' : `${percent}%`;
    };
    this.rows.add(paint);
    paint();
    void this.refresh();
  }

  private render(): void {
    for (const paint of this.rows) paint();
    // Follow the server closely only while it works and someone is looking at the row.
    if (this.follow) { clearTimeout(this.follow); this.follow = null; }
    if (this.rows.size && this.state && WORKING.has(this.state.status) && !this.restarting) this.follow = setTimeout(() => void this.refresh(), FOLLOW_MS);
    this.renderBanner();
  }

  private renderBanner(): void {
    const view = this.restarting && this.state
      ? { kind: 'busy' as const, text: settingsRow(this.state, this.restarting).text, restart: undefined }
      : this.state ? bannerFor(this.state, this.dismissed, this.locationDismissed) : null;
    this.banner.classList.toggle('hidden', !view);
    if (!view) { this.banner.innerHTML = ''; return; }
    this.banner.dataset.kind = view.kind;
    this.banner.innerHTML = ui`<span>${esc(view.text)}</span>` + (view.kind === 'ready' ? ui`<span><button class="btn small" data-update-install>Installa</button> <button class="btn small ghost" data-update-later>Più tardi</button></span>`
      : view.restart ? `<span><button class="btn small" data-update-restart>${esc(tr('Riavvia ora'))}</button> ${ui`<button class="btn small ghost" data-update-later>Chiudi</button>`}</span>`
      : view.kind === 'busy' ? '' : ui`<button class="btn small ghost" data-update-later>Chiudi</button>`);
    this.banner.querySelector('[data-update-install]')?.addEventListener('click', () => void this.install());
    this.banner.querySelector('[data-update-restart]')?.addEventListener('click', () => void this.restart());
    this.banner.querySelector('[data-update-later]')?.addEventListener('click', () => {
      if (view.kind === 'location') {
        this.locationDismissed = true;
        try { sessionStorage.setItem('vb:location-dismissed', '1'); } catch { /* storage unavailable */ }
        this.banner.classList.add('hidden');
        return;
      }
      this.dismissed = view.restart && this.state ? restartKey(this.state) : this.state?.latest ?? 'error';
      try { sessionStorage.setItem('vb:update-dismissed', this.dismissed); } catch { /* storage unavailable */ }
      this.banner.classList.add('hidden');
    });
  }
}
