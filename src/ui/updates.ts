// Update notice: a banner when a verified update is ready, and the "Cerca aggiornamenti" action of the Altro menu.
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

export class Updates {
  private state: UpdateView | null = null;
  private dismissed: string | null = null;
  private locationDismissed = false;
  private readonly banner: HTMLElement;

  constructor(banner: HTMLElement) {
    this.banner = banner;
    try { this.dismissed = sessionStorage.getItem('vb:update-dismissed'); this.locationDismissed = sessionStorage.getItem('vb:location-dismissed') === '1'; } catch { /* storage unavailable */ }
    void this.refresh();
    setInterval(() => void this.refresh(), 60_000);
  }

  get current(): string { return this.state?.current ?? ''; }
  get enabled(): boolean { return !!this.state?.enabled; }

  async refresh(): Promise<void> {
    try { this.state = await api.updateState(); } catch { return; }
    this.render();
  }

  /** "Cerca aggiornamenti": returns a short sentence for the toast. */
  async checkNow(): Promise<string> {
    if (!this.state?.enabled) return tr('Gli aggiornamenti automatici sono attivi solo nell’app installata.');
    try { this.state = await api.updateCheck(); } catch (error) { await this.refresh(); return String(error instanceof Error ? error.message : error); }
    this.render();
    const s = this.state!;
    if (s.latest) return s.status === 'ready' ? ui`Versione ${s.latest} pronta da installare.` : ui`Versione ${s.latest} trovata: la scarico.`;
    return ui`Sei aggiornato (versione ${s.current}).`;
  }

  private async install(): Promise<void> {
    this.banner.dataset.busy = 'true';
    try { this.state = await api.updateInstall(); } catch (error) { await this.refresh(); this.banner.textContent = String(error instanceof Error ? error.message : error); }
    delete this.banner.dataset.busy;
    this.render();
  }

  private render(): void {
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
