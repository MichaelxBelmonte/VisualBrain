// Permission notice: macOS lets the app read the Desktop (and Documents, Downloads) only after the user allows it.
// Without it the map stays empty in silence; this banner says which folder is blocked and opens the right System Settings
// pane. The server maps the folder again by itself as soon as it becomes readable (src/server/access.ts).
import { t as tr, ui } from './i18n.ts';
import { api } from './api.ts';

export interface BlockedFolder { path: string; reason: 'permission' | 'missing' }
export interface AccessView { blocked: BlockedFolder[]; platform: string }

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** The folder as the user knows it: "Scrivania" for ~/Desktop, else the path with ~ for the home folder. */
export function folderName(path: string, home: string): string {
  const special: Record<string, string> = { Desktop: tr('Scrivania'), Documents: tr('Documenti'), Downloads: tr('Download') };
  const inside = home && path.startsWith(home + '/') ? path.slice(home.length + 1) : null;
  if (inside && special[inside]) return special[inside];
  return inside ? `~/${inside}` : path;
}

/** What the banner says, or null. Pure, so the wording is testable. */
export function accessBanner(view: AccessView, home: string, dismissed = false): { kind: 'permission' | 'missing'; text: string } | null {
  if (dismissed) return null;
  const refused = view.blocked.filter(b => b.reason === 'permission');
  if (refused.length) {
    const names = refused.map(b => folderName(b.path, home)).join(', ');
    return { kind: 'permission', text: view.platform === 'darwin'
      ? ui`macOS non permette a Visual Brain di leggere ${names}: la mappa resta vuota. In Impostazioni di Sistema › Privacy e sicurezza › File e cartelle attiva la cartella per Visual Brain. La mappa si aggiorna da sola.`
      : ui`Visual Brain non ha il permesso di leggere ${names}: la mappa resta vuota.` };
  }
  const missing = view.blocked.filter(b => b.reason === 'missing');
  if (missing.length) return { kind: 'missing', text: ui`Cartella mappata non trovata: ${missing.map(b => folderName(b.path, home)).join(', ')}. Sceglila di nuovo in Impostazioni › Cartelle mappate.` };
  return null;
}

export class Access {
  private view: AccessView | null = null;
  private home = '';
  private dismissed = false;
  private readonly banner: HTMLElement;

  constructor(banner: HTMLElement) {
    this.banner = banner;
    void api.preferences().then(p => { this.home = p.home; this.render(); }).catch(() => {});
    void this.refresh();
    // Every 15 s while a folder is blocked, so the notice goes away right after the user allows it; else every 5 min.
    const tick = () => setTimeout(async () => { await this.refresh(); tick(); }, this.view?.blocked.length ? 15_000 : 300_000);
    tick();
  }

  async refresh(): Promise<void> {
    try { this.view = await api.access(); } catch { return; }
    this.render();
  }

  private render(): void {
    const view = this.view ? accessBanner(this.view, this.home, this.dismissed) : null;
    this.banner.classList.toggle('hidden', !view);
    if (!view) { this.banner.innerHTML = ''; return; }
    this.banner.dataset.kind = 'error';
    const settings = view.kind === 'permission' && this.view?.platform === 'darwin';
    this.banner.innerHTML = ui`<span>${esc(view.text)}</span><span>` + (settings ? ui`<button class="btn small" data-access-settings>Apri Impostazioni</button> ` : '') + ui`<button class="btn small ghost" data-access-later>Chiudi</button></span>`;
    this.banner.querySelector('[data-access-settings]')?.addEventListener('click', () => void api.accessSettings().catch(() => {}));
    this.banner.querySelector('[data-access-later]')?.addEventListener('click', () => { this.dismissed = true; this.render(); });
  }
}
