import { api } from './api.ts';
import { t as tr, ui } from './i18n.ts';
import { ROLE_WORDS } from './work-roles.ts';
import { channelMessages, visibleChannels, type VisibleChannel } from './work-channel-model.ts';
import type { TeamLink, TeamMessage, TerminalInfo } from '../shared/types.ts';

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const sessionLabel = (s: TerminalInfo) => `${s.role ? ROLE_WORDS[s.role] + ' · ' : ''}${s.title}`;

/** Messages are mirrored on both ends: read the board of the end with the lower node id (its squad's board). */
const boardOf = (pair: VisibleChannel): [number, string] => {
  const end = pair.a.nodeId! <= pair.b.nodeId! ? pair.a : pair.b;
  return [end.nodeId!, end.teamId ?? '1'];
};

/** Read-only view of actual board messages. Reuses the workspace refresh; never wakes an agent or sends a prompt. */
export class WorkChannel {
  private pairs: VisibleChannel[] = [];
  private selected = '';
  private revision = 0;
  private busy = false;
  private data = new Map<string, TeamMessage[]>();
  private error = '';
  private signature = '';
  private readonly el: HTMLElement;
  constructor(el: HTMLElement) {
    this.el = el;
    el.classList.add('work-channel', 'hidden');
    el.innerHTML = ui`<details open><summary>Messaggi del canale</summary><div class="channel-controls"><label>Canale <select aria-label="Canale tra terminali"></select></label><span class="channel-status" role="status"></span></div><div class="channel-messages" role="log" aria-live="polite" aria-label="Messaggi scambiati"></div></details>`;
    el.querySelector('select')!.addEventListener('change', e => { this.selected = (e.target as HTMLSelectElement).value; this.signature = ''; this.render(); void this.refresh(); });
    el.querySelector('details')!.addEventListener('toggle', () => { if (el.querySelector('details')!.open) void this.refresh(); });
  }
  update(links: TeamLink[], sessions: TerminalInfo[], visible: string[]): void {
    const pairs = visibleChannels(links, sessions, visible);
    const key = JSON.stringify(pairs.map(p => [p.key, p.a.title, p.b.title, p.active]));
    const changed = key !== JSON.stringify(this.pairs.map(p => [p.key, p.a.title, p.b.title, p.active]));
    this.pairs = pairs;
    this.el.classList.toggle('hidden', !pairs.length);
    if (!changed) return;
    this.revision++;
    if (!pairs.some(p => p.key === this.selected)) this.selected = pairs[0]?.key || '';
    this.error = ''; this.signature = '';
    const select = this.el.querySelector('select')!;
    select.innerHTML = pairs.map(p => `<option value="${esc(p.key)}">${esc(sessionLabel(p.a))} ↔ ${esc(sessionLabel(p.b))}</option>`).join('');
    select.value = this.selected;
    this.render();
    void this.refresh();
  }
  async refresh(): Promise<void> {
    if (this.busy || !this.pairs.length || this.el.classList.contains('hidden') || !this.el.querySelector('details')!.open) return;
    this.busy = true;
    const revision = this.revision;
    const boards = [...new Map(this.pairs.map(p => { const [node, team] = boardOf(p); return [`${node}:${team}`, [node, team] as const]; })).values()];
    try {
      const data = await Promise.all(boards.map(async ([node, team]) => [`${node}:${team}`, (await api.team(node, team)).messages] as const));
      if (revision !== this.revision) return;
      this.data = new Map(data); this.error = ''; this.render();
    } catch {
      if (revision === this.revision) { this.error = tr('Messaggi non aggiornati. Nuovo tentativo al prossimo aggiornamento.'); this.render(); }
    } finally { this.busy = false; }
  }
  private render(): void {
    const pair = this.pairs.find(p => p.key === this.selected);
    if (!pair) return;
    const messages = channelMessages(pair, this.data.get(boardOf(pair).join(':')) || []);
    const status = this.error || (pair.active ? tr('Canale attivo') : tr('Sessioni non attive'));
    this.el.querySelector('.channel-status')!.textContent = status;
    const signature = JSON.stringify([pair.key, messages]);
    if (signature === this.signature) return;
    this.signature = signature;
    const list = this.el.querySelector<HTMLElement>('.channel-messages')!;
    const atBottom = list.scrollHeight - list.clientHeight - list.scrollTop < 30;
    list.innerHTML = messages.length ? messages.map(m => {
      const from = m.from === pair.a.id ? pair.a : pair.b, to = m.to === pair.a.id ? pair.a : pair.b;
      const time = new Date(m.createdAt).toLocaleTimeString(tr('it-IT'), { hour: '2-digit', minute: '2-digit' });
      return `<article class="channel-message"><header><strong>${esc(sessionLabel(from))} → ${esc(sessionLabel(to))}</strong><time>${esc(time)}</time></header><p>${esc(m.text)}</p></article>`;
    }).join('') : `<p class="channel-empty">${tr('Nessuno scambio tra queste sessioni negli ultimi 50 messaggi della bacheca. Il collegamento permette agli orchestratori di comunicare quando hanno un incarico comune.')}</p>`;
    if (atBottom) list.scrollTop = list.scrollHeight;
  }
}
