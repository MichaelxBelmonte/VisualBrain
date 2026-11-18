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
export function bannerFor(s: UpdateView, dismissed: string | null, locationDismissed = false): { kind: 'ready' | 'installed' | 'error' | 'busy' | 'location'; text: string } | null {
  if (!s.enabled) return null;
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
 * The "Aggiornamenti" row for a state. `s` is null when the server did not answer; `restarting` once "Riavvia" was accepted.
 * Pure, so every wording is testable.
 */
export function settingsRow(s: UpdateView | null, restarting = false): UpdateRow {
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
        text: fill(tr(s.relocated ? 'Versione {v} installata in Applicazioni. Riavvia per usarla: i terminali restano attivi.' : 'Versione {v} installata. Riavvia per usarla: i terminali restano attivi.'), { v }),
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
  private restarting = false;
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
    // After "Riavvia" the server goes away on purpose: that is not an error to show.
    try { this.state = await api.updateState(); this.reachable = true; } catch { if (this.restarting) return; this.reachable = false; }
    this.render();
  }

  /** Shows `next` at once, then asks the server; a refusal is already in the server's state, which is read again. */
  private async act(next: UpdateView['status'], call: () => Promise<UpdateView>): Promise<void> {
    if (this.state) { this.state = { ...this.state, status: next, error: '' }; this.render(); }
    try { this.state = await call(); this.reachable = true; this.render(); } catch { await this.refresh(); }
  }

  private check(): Promise<void> { return this.act('checking', api.updateCheck); }
  private install(): Promise<void> { return this.act('installing', api.updateInstall); }

  private async restart(): Promise<void> {
    this.restarting = true; this.render();
    try { await api.updateRestart(); } catch (error) {
      this.restarting = false;
      if (this.state) this.state = { ...this.state, status: 'error', error: String(error instanceof Error ? error.message : error) };
      this.render();
    }
  }

  /**
   * The "Aggiornamenti" row of Impostazioni, kept in step with the server until `root` leaves the page.
   * The frame is rebuilt only when the step changes, so its short entrance plays once; the percentage moves in place.
   */
  mountSettings(root: HTMLElement): void {
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
        root.innerHTML = `<div class="settings-row update-row"><div><b>Visual Brain</b><small>${this.current ? ui`versione ${esc(this.current)}` : tr('versione di sviluppo')}</small></div>${row.action ? `<button type="button" class="btn small${row.action.primary ? ' primary' : ''}" data-update="${row.action.id}">${esc(row.action.label)}</button>` : '<span class="update-pct" aria-hidden="true"></span>'}</div>`
          + `<div class="update-progress" role="progressbar" aria-label="${esc(tr('Avanzamento dell’aggiornamento'))}" aria-valuemin="0" aria-valuemax="100"><i></i></div>`
          + `<p class="update-status" data-tone="${row.tone}" role="status"><i class="update-mark" aria-hidden="true"></i><span tabindex="-1">${esc(row.text)}</span></p>`
          + (notes.length ? `<details class="update-notes"><summary>${esc(tr('Novità della {v}').replace('{v}', s!.latest!))}</summary><ul>${notes.map(line => `<li>${esc(line)}</li>`).join('')}</ul></details>` : '');
        const button = root.querySelector<HTMLButtonElement>('[data-update]');
        if (button) button.onclick = () => void ({ check: () => this.check(), install: () => this.install(), restart: () => this.restart() })[row.action!.id]();
        // the button that was pressed is replaced by the next step: the keyboard stays in the row
        if (hadFocus) (button ?? root.querySelector<HTMLElement>('.update-status span'))?.focus({ preventScroll: true });
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
    const view = this.state ? bannerFor(this.state, this.dismissed, this.locationDismissed) : null;
    this.banner.classList.toggle('hidden', !view);
    if (!view) { this.banner.innerHTML = ''; return; }
    this.banner.dataset.kind = view.kind;
    this.banner.innerHTML = ui`<span>${esc(view.text)}</span>` + (view.kind === 'ready' ? ui`<span><button class="btn small" data-update-install>Installa</button> <button class="btn small ghost" data-update-later>Più tardi</button></span>` : view.kind === 'busy' ? '' : ui`<button class="btn small ghost" data-update-later>Chiudi</button>`);
    this.banner.querySelector('[data-update-install]')?.addEventListener('click', () => void this.install());
    this.banner.querySelector('[data-update-later]')?.addEventListener('click', () => {
      if (view.kind === 'location') {
        this.locationDismissed = true;
        try { sessionStorage.setItem('vb:location-dismissed', '1'); } catch { /* storage unavailable */ }
        this.banner.classList.add('hidden');
        return;
      }
      this.dismissed = this.state?.latest ?? 'error';
      try { sessionStorage.setItem('vb:update-dismissed', this.dismissed); } catch { /* storage unavailable */ }
      this.banner.classList.add('hidden');
    });
  }
}
