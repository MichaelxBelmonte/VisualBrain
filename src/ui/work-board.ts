// "Lavoro": one board per node. On top "Serve te" — what needs the person (blocked tasks, held reports, permission
// requests, proposals) or, when nothing does, one line saying what the squad is doing and the next useful move. Below,
// three plain columns: Da fare, In corso, Fatto. Squads, the Main Brain and the node's reminders are filters of the
// same board. Squad settings live behind the ··· menu, messages in a strip below.
// Cards are edited in place, dragged between columns (or Alt+arrows) and created from one line at the top of «Da fare».
// The board reads its squad again as soon as the server saves it (vb:team-changed), every 5 s while an agent works,
// every 30 s otherwise, and only while visible; nothing here calls a model or types into a terminal.
import { t as tr, ui } from './i18n.ts';
import { accountTag } from './account-names.ts';
import { api } from './api.ts';
import { roleName, sessionTone, sessionWorking, toneReason, CODE_IN_TEXT } from './work-roles.ts';
import { columnOf, fill, laneMove, nowLine, parseQuickTask, placeAt, sortCards, type Column } from './work-tasks.ts';
import { bindLaneDrag } from './board-drag.ts';
import type { AgentRole, ClaudeMemory, InboxItem, InboxKind, NodeDetail, NodeReminder, SwarmProposal, TeamLink, TeamSummary, TeamTask, TeamView, TerminalInfo } from '../shared/types.ts';

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const time = (at: number) => new Date(at).toLocaleTimeString(tr('it-IT'), { hour: '2-digit', minute: '2-digit' });
const KINDS: InboxKind[] = ['result', 'blocked', 'question', 'note'];
const kindLabel = (k: InboxKind) => ({ result: tr('✓ Risultato'), blocked: tr('■ Bloccato'), question: tr('? Domanda'), note: tr('• Nota') }[k]);
const MEMORY: Array<[ClaudeMemory, string, string]> = [
  ['leaders', tr('Solo orchestratore'), tr('L’orchestratore usa la memoria del progetto; operatori e revisori lavorano senza.')],
  ['all', tr('Tutta la squadra'), tr('Tutti gli agenti Claude della squadra leggono e scrivono la memoria del progetto.')],
  ['squad', tr('Separata'), tr('L’orchestratore usa una memoria solo di questa squadra; operatori e revisori lavorano senza.')],
  ['off', tr('Spenta'), tr('Nessun agente Claude della squadra usa la memoria automatica.')],
];
export type LaneId = 'todo' | 'doing' | 'you' | 'done';
/** The columns under "Serve te"; the 'you' lane is the strip above them. */
const LANES: Array<[Exclude<LaneId, 'you'>, string]> = [['todo', 'Da fare'], ['doing', 'In corso'], ['done', 'Fatto']];
/** Lane of a squad task: blocked work waits on the person. Pure, so the rule is testable. */
export function taskLane(t: Pick<TeamTask, 'status'>): LaneId {
  return t.status === 'pending' ? 'todo' : t.status === 'working' ? 'doing' : t.status === 'blocked' ? 'you' : 'done';
}
/** Lane of a sorting-board item: held reports wait on the person until forwarded or archived. */
export function inboxLane(i: Pick<InboxItem, 'column'>): LaneId { return i.column === 'new' || i.column === 'ready' ? 'you' : 'done'; }
export const REMINDERS = 'reminders';
/** Two quiet placeholder cards per lane until the first response for this node and filter arrives. */
const SKELETON = '<div class="lavoro-card lavoro-skeleton" aria-hidden="true"><i></i><i></i></div>'.repeat(2);

/** The grid fills the available board width, including when the node sidebar changes size. */
export function youDisclosure(total: number, columns: number, expanded: boolean): { shown: number; label: string } {
  const limit = 2 * Math.max(1, columns);
  if (total <= limit) return { shown: total, label: '' };
  if (expanded) return { shown: total, label: tr('Mostra meno') };
  return { shown: limit, label: tr('Mostra altri {n}').replace('{n}', String(total - limit)) };
}

/** One line under a task title: who has it and what happens next, in plain words. Pure, so the wording is testable. */
export function taskStatus(t: Pick<TeamTask, 'status' | 'assignedTo' | 'blockedOwnerCode'>, assignee?: { code?: string; name?: string; alive: boolean }): { text: string; tone: string } {
  const code = assignee?.code || t.blockedOwnerCode || assignee?.name || '';
  if (t.status === 'done') return { text: code ? ui`Completato · ${code}` : tr('Completato'), tone: 'done' };
  if (t.status === 'blocked') {
    if (t.assignedTo && !assignee?.alive) return { text: code ? ui`Bloccato · ultimo responsabile ${code}` : tr('Bloccato · sessione terminata'), tone: 'blocked' };
    return { text: code ? ui`Bloccato · ${code} aspetta una tua decisione` : tr('Bloccato · serve una tua decisione'), tone: 'blocked' };
  }
  // Assigned to a session that has ended or is gone: the task will not move by itself.
  const gone = !!t.assignedTo && !assignee?.alive;
  if (t.status === 'working') return gone ? { text: code ? ui`${code} si è fermato · riassegnalo` : tr('L’agente si è fermato · riassegnalo'), tone: 'stale' } : { text: code ? ui`${code} ci sta lavorando` : tr('In corso'), tone: 'active' };
  if (gone) return { text: tr('Assegnato a una sessione terminata · riassegnalo'), tone: 'stale' };
  return t.assignedTo ? { text: ui`Assegnato a ${code} · non ancora iniziato`, tone: 'idle' } : { text: tr('Da assegnare'), tone: 'idle' };
}

/** The + beside the members: the «Serve te» hint offers «+ Agente» itself when no agent runs and nothing waits
 * on the person; in every other case the chip is the visible way to add one. Pure. */
export function addAgentChip(members: Array<Pick<TerminalInfo, 'alive' | 'role'>>, waiting: number): boolean {
  return waiting > 0 || members.some(member => member.alive && !!member.role);
}

/** When nothing waits on the person: what the squad is doing and, with no agent running, the button to add one.
 * «+ Incarico» is not repeated here: it is always in the board header. Pure. */
export function boardHint(tasks: Array<Pick<TeamTask, 'status' | 'assignedTo'>>, live: number): { text: string; action?: 'agent' } {
  const count = (s: TeamTask['status']) => tasks.filter(t => t.status === s).length;
  const pending = count('pending'), working = count('working');
  const unassigned = tasks.filter(t => t.status === 'pending' && !t.assignedTo).length;
  if (!live) return { text: tr('Squadra ferma: nessun agente attivo.'), action: 'agent' };
  if (!tasks.length) return { text: tr('Nessun incarico ancora.') };
  if (working) return { text: pending ? ui`In corso: ${working} · in coda: ${pending}. Nessuna azione per te.` : ui`In corso: ${working}. Nessuna azione per te.` };
  if (unassigned) return { text: ui`Da assegnare: ${unassigned}. Apri la scheda per scegliere l’agente, o attendi l’orchestratore.` };
  if (pending) return { text: ui`In attesa di partire: ${pending}.` };
  return { text: tr('Tutti gli incarichi sono completati.') };
}

export interface BoardCallbacks {
  open(sessionId: string): void;
  launch(nodeId: number, options: { squad: boolean; teamId?: string; proposal?: SwarmProposal; role?: AgentRole }): void;
  reveal(nodeId: number): void;
  linksChanged(): void;
}
export type BoardUpdate = (nodes: NodeDetail[], nodeId: number | null, visible: boolean, team?: string) => void;

/** Keyed groups and rows rendered by the board and the terminal rail. HTML describes static content;
 * state colours, focus and relative-time titles are updated on the retained elements. */
export interface WorkListItem { key: string; html: string; children?: WorkListItem[] }
const workLists = new WeakMap<Element, Map<string, { node: Element; html: string }>>();

export function reconcileWorkList(parent: Element, items: WorkListItem[]): boolean {
  const previous = workLists.get(parent) ?? new Map<string, { node: Element; html: string }>();
  const keys = new Set(items.map(item => item.key));
  let changed = false;
  for (const [key, entry] of previous) {
    if (keys.has(key)) continue;
    entry.node.remove(); previous.delete(key); changed = true;
  }
  let cursor = parent.firstElementChild;
  for (const item of items) {
    let entry = previous.get(item.key);
    if (entry?.html !== item.html) {
      const template = document.createElement('template');
      template.innerHTML = item.html;
      const fresh = template.content.firstElementChild!;
      if (entry && item.children) {
        // A group's selection or link colour can change while its rows keep their focus and handlers.
        for (const name of entry.node.getAttributeNames()) if (!fresh.hasAttribute(name)) entry.node.removeAttribute(name);
        for (const attr of fresh.attributes) if (entry.node.getAttribute(attr.name) !== attr.value) entry.node.setAttribute(attr.name, attr.value);
      } else {
        if (entry) {
          if (entry.node === cursor) cursor = fresh;
          entry.node.replaceWith(fresh);
        }
        entry = { node: fresh, html: item.html };
      }
      entry.html = item.html; previous.set(item.key, entry); changed = true;
    }
    if (entry.node !== cursor) { parent.insertBefore(entry.node, cursor); changed = true; }
    cursor = entry.node.nextElementSibling;
    if (item.children && reconcileWorkList(entry.node, item.children)) changed = true;
  }
  workLists.set(parent, previous);
  return changed;
}

export function mountWorkBoard(el: HTMLElement, cb: BoardCallbacks): BoardUpdate {
  let nodes: NodeDetail[] = [];
  let nodeId: number | null = null;
  let team = '1';
  let visible = false;
  let view: TeamView | null = null;
  let reminders: NodeReminder[] = [];
  let folders = new Map<string, string>();
  let links: TeamLink[] = [];
  let error = '';
  let shell = '';
  let signature = '';
  let loading = false;
  let openCard: string | null = null;
  let youExpanded = false;
  let panel: 'none' | 'settings' | 'link' = 'none';
  let timer: ReturnType<typeof setInterval> | null = null;
  /** A card is in the air: nothing repaints under it. */
  let dragging = false;
  /** A task dropped on «In corso» without a live owner: its card is open on «Assegna a». */
  let assignFor: string | null = null;
  let lastRead = 0, again = false, lastTick = 0;

  const all = () => [...(view?.sessions ?? []), ...(view?.peers ?? []), ...(view?.brain ? [view.brain] : [])];
  const named = (id: string): TerminalInfo | undefined => all().find(s => s.id === id);
  const who = (id: string) => {
    if (id === 'user') return tr('Tu');
    if (id === 'visual-brain') return 'Visual Brain';
    const s = named(id);
    return s ? [s.code, s.name || (s.role ? roleName(s) : '')].filter(Boolean).join(' · ') : tr('Sessione terminata');
  };
  const codeLinks = (html: string) => html.replace(CODE_IN_TEXT, code => {
    const s = [...(view?.sessions ?? []), ...(view?.peers ?? [])].find(x => x.code === code && x.alive);
    return s ? `<button class="code-link" data-goto="${esc(s.id)}">${code}</button>` : code;
  });
  const swatch = (t: { color: number } | undefined) => t ? `<span class="team-swatch" data-team-color="${t.color}" aria-hidden="true"></span>` : '<span class="team-swatch brain" aria-hidden="true">◉</span>';
  const fail = (err: unknown) => { error = err instanceof Error ? err.message : String(err); paintError(); };
  const paintError = () => {
    const box = el.querySelector('.board-error'); if (box) box.textContent = error;
    if (error && !view) { el.querySelectorAll('.lavoro-skeleton').forEach(card => card.remove()); el.querySelector('.lavoro')?.setAttribute('aria-busy', 'false'); }
  };
  const act = async (run: () => Promise<unknown>) => { error = ''; paintError(); try { await run(); await refresh(true); } catch (err) { fail(err); } };

  async function refresh(force = false): Promise<void> {
    if (!visible || nodeId === null) return;
    if (loading) { again = true; return; }
    loading = true; lastRead = Date.now();
    const asked = `${nodeId}:${team}`;
    try {
      // The squad list and the Main Brain come with any board; reminders only when their filter is open.
      const [next, rem, board, nextLinks] = await Promise.all([
        api.team(nodeId, team === REMINDERS ? '1' : team),
        team === REMINDERS ? api.reminders() : Promise.resolve(null),
        team === REMINDERS ? api.readReminderBoard(nodeId).catch(() => null) : Promise.resolve(null),
        panel === 'link' ? api.teamLinks().catch(() => links) : Promise.resolve(links),
      ]);
      if (asked !== `${nodeId}:${team}`) return;
      if (force || error) signature = '';
      view = next; links = nextLinks; error = '';
      if (rem) reminders = rem.filter(r => r.nodeId === nodeId);
      if (board) folders = new Map(board.folders.filter(f => !f.isInbox).map(f => [f.id, f.name]));
      paint();
    } catch (err) {
      // A squad archived or gone elsewhere: back to the first squad.
      if (team !== '1' && /Squadra non trovata/.test(String(err))) { team = '1'; shell = ''; loading = false; return refresh(true); }
      fail(err);
    } finally {
      loading = false;
      if (again) { again = false; void refresh(true); }
    }
  }
  // The server says a board of this node changed (a task, a message, a setting): read it now, not at the next poll.
  window.addEventListener('vb:team-changed', e => {
    const d = (e as CustomEvent<{ nodeId: number; team: string }>).detail;
    if (visible && d?.nodeId === nodeId && team !== REMINDERS) void refresh();
  });
  window.addEventListener('vb:reminders-changed', () => { if (visible && team === REMINDERS) void refresh(); });
  /** Every second while visible: read again every 5 s while an agent works (its «now» line), 30 s otherwise. */
  function tick(): void {
    if (!visible || dragging) return;
    const working = view?.sessions.some(s => s.alive && s.role && sessionWorking(s)) ?? false;
    if (Date.now() - lastRead > (working ? 5000 : 30_000)) void refresh();
    else if (Date.now() - lastTick > 15_000) { lastTick = Date.now(); paintNow(); }
  }

  const isSquad = () => team !== 'brain' && team !== REMINDERS;

  function selectNode(id: number | null): void {
    if (nodeId === id) return;
    nodeId = id; team = '1'; view = null; panel = 'none'; youExpanded = false; assignFor = null; openCard = null;
  }

  function updateDisclosure(): void {
    const grid = el.querySelector<HTMLElement>('.lavoro-you > .lavoro-cards');
    const toggle = el.querySelector<HTMLButtonElement>('[data-you-toggle]');
    if (!visible || !grid || !toggle) return;
    const cards = grid.querySelectorAll<HTMLElement>('.lavoro-card');
    // auto-fill resolves to one pixel track per column, even if a row has empty cells.
    const columns = cards.length ? getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length : 1;
    const { shown, label } = youDisclosure(cards.length, columns, youExpanded);
    toggle.hidden = !label;
    toggle.setAttribute('aria-expanded', String(youExpanded));
    if (toggle.textContent !== label) toggle.textContent = label;
    cards.forEach((card, i) => {
      if (i >= shown && card.contains(document.activeElement)) toggle.focus({ preventScroll: true });
      card.hidden = i >= shown;
    });
  }
  bindLaneDrag(el, {
    card: target => target.closest<HTMLElement>('.lavoro-card[data-drag]'),
    onDrop: (card, lane, index) => moveCard(card, lane, index),
    onState: value => { dragging = value; if (!value) { signature = ''; paint(); } },
  });
  let boardWidth = 0;
  new ResizeObserver(([entry]) => {
    if (entry.contentRect.width !== boardWidth) {
      boardWidth = entry.contentRect.width;
      updateDisclosure();
    }
  }).observe(el);

  /** The frame changes only with the node, the filter or the open panel; the data inside on every refresh. */
  function paintShell(): void {
    const key = `${nodeId}:${team}:${panel}:${nodes.map(n => n.id).join(',')}`;
    if (shell === key && el.querySelector('.lavoro')) return;
    shell = key; signature = '';
    const nodeOptions = nodes.map(n => `<option value="${n.id}" ${n.id === nodeId ? 'selected' : ''}>${esc(n.name)}</option>`).join('');
    const addLabel = team === REMINDERS ? tr('+ Promemoria') : team === 'brain' ? '' : tr('+ Incarico');
    const quick = team === 'brain' ? '' : `<form class="lavoro-quick" data-quick><input name="title" maxlength="1000" autocomplete="off" placeholder="${esc(team === REMINDERS ? tr('Nuovo promemoria… ↵') : tr('Nuovo incarico… ↵  (!alta  #etichetta  @OP1)'))}" aria-label="${esc(team === REMINDERS ? tr('Nuovo promemoria') : tr('Nuovo incarico'))}"></form>`;
    const drops = team !== 'brain';
    el.innerHTML = ui`<div class="board lavoro" aria-busy="true"><header class="lavoro-head">${nodes.length > 1 ? ui`<select data-node class="lavoro-node" aria-label="Nodo">${nodeOptions}</select>` : `<strong class="lavoro-node">${esc(nodes[0]?.name ?? '')}</strong>`}<nav class="lavoro-filters" aria-label="Squadre e promemoria"></nav><span class="lavoro-tools">${addLabel ? `<button class="btn small primary" data-new>${esc(addLabel)}</button>` : ''}<details class="work-overflow lavoro-menu"><summary class="btn small ghost" aria-label="${esc(tr('Menu della squadra'))}">···</summary><div>${isSquad() ? ui`<button data-add-agent><span>Aggiungi agente</span><small>nella squadra, con il suo ruolo</small></button><button data-panel="settings"><span>Impostazioni della squadra</span><small>obiettivo, consegna, memoria, limiti</small></button>` : ''}${team === 'brain' ? ui`<button data-panel="settings"><span>Riepilogo del Main Brain</span><small>e consegna dei rapporti</small></button>` : ''}<button data-panel="link"><span>Collega a…</span><small>un altro nodo, per scambiare messaggi</small></button><button data-reveal><span>Mostra nella mappa</span></button>${isSquad() ? ui`<div class="sep"></div><button data-archive class="danger"><span>Archivia la squadra</span><small>il ramo Git resta</small></button>` : ''}</div></details></span></header>
      <div class="lavoro-goal" data-goal></div><div class="board-error" role="alert"></div><div class="lavoro-panel" data-panel-box></div>
      ${team === REMINDERS ? '' : ui`<section class="lavoro-you" data-lane="you" aria-live="polite"><h3>Serve te<span class="kanban-count"></span></h3><div class="lavoro-cards" id="work-needs-cards"></div><button type="button" class="btn small ghost" data-you-toggle aria-controls="work-needs-cards" aria-expanded="false" hidden></button></section>`}
      <div class="lavoro-lanes">${LANES.map(([id, label]) => ui`<section class="lavoro-lane" data-lane="${id}"${drops ? ` data-drop-lane="${id}"` : ''}><h3>${tr(label)}<span class="kanban-count"></span></h3>${id === 'todo' ? quick : ''}<div class="lavoro-cards">${SKELETON}</div></section>`).join('')}</div><p class="sr-only" aria-live="polite" data-announce></p>
      ${team === REMINDERS ? '' : ui`<details class="lavoro-messages"><summary>Messaggi <span data-message-count></span></summary><div class="board-messages" aria-live="polite"></div><form data-message class="board-row"><select name="to" aria-label="Destinatario"></select><textarea name="text" maxlength="1200" rows="1" required placeholder="Istruzione, risposta o decisione…" aria-label="Messaggio"></textarea><button class="btn small">Invia</button></form></details>`}</div>`;
    paintPanel();
    bindShell();
  }

  /** The one panel open above the lanes: new item, squad settings, or a link to another node. */
  function paintPanel(): void {
    const box = el.querySelector<HTMLElement>('[data-panel-box]')!;
    box.hidden = panel === 'none';
    if (panel === 'settings') box.innerHTML = team === 'brain'
      ? ui`<div class="board-grid"><label class="work-field">Riepilogo del Main Brain<textarea data-summary rows="3" maxlength="4000"></textarea></label></div><div class="board-row"><div class="board-delivery" role="radiogroup" aria-label="Rapporti degli orchestratori"><span>Rapporti degli orchestratori</span></div><button class="btn small" data-save-summary>Salva</button><button type="button" class="btn small ghost" data-panel="none">Chiudi</button></div>`
      : ui`<div class="board-row"><label class="work-field">Nome<input data-team-name maxlength="40"></label><small class="board-branch"></small></div><div class="board-grid"><label class="work-field">Obiettivo<textarea data-objective rows="2" maxlength="4000" placeholder="Cosa deve ottenere questa squadra"></textarea></label><label class="work-field">Riepilogo dell’orchestratore<textarea data-summary rows="2" maxlength="4000"></textarea></label></div><div class="board-row"><div class="board-delivery" role="radiogroup" aria-label="Consegna all’orchestratore"><span>Consegna all’orchestratore</span></div><button class="btn small" data-save-summary>Salva obiettivo e riepilogo</button></div><div class="board-row"><div class="board-memory" role="radiogroup" aria-label="Memoria di Claude"><span>Memoria di Claude</span></div></div><small class="muted" data-memory-hint></small><form data-settings class="board-row"><label class="work-field">Agenti simultanei<input name="limit" type="number" min="1" max="8"></label><label class="work-check"><input name="auto" type="checkbox">L’orchestratore può avviare operatori</label><label class="work-check" title="Solo per i nuovi operatori, in una cartella Git con almeno un commit."><input name="worktrees" type="checkbox">Ogni operatore in un worktree Git separato</label><button class="btn small">Salva impostazioni</button><button type="button" class="btn small ghost" data-panel="none">Chiudi</button></form>`;
    else if (panel === 'link') box.innerHTML = ui`<div class="board-row"><select data-link-target aria-label="Nodo da collegare"></select><button class="btn small primary" data-link>Collega</button><button type="button" class="btn small ghost" data-panel="none">Chiudi</button></div><p class="muted">I nodi collegati si scambiano messaggi tra orchestratori. Le squadre dello stesso nodo condividono già la bacheca.</p><ul class="lavoro-links" data-links></ul>`;
    else box.innerHTML = '';
  }

  function bindShell(): void {
    const q = <T extends Element = HTMLElement>(s: string) => el.querySelector<T>(s);
    el.querySelector('.lavoro')!.addEventListener('focusout', event => {
      // A field may have held back a lane or a select while a newer response arrived.
      if ((event.target as Element).matches('input,select,textarea')) signature = '';
    });
    const node = q<HTMLSelectElement>('select[data-node]');
    if (node) node.onchange = () => { selectNode(Number(node.value)); paint(); void refresh(true); };
    const message = q<HTMLFormElement>('[data-message]');
    if (message) {
      message.onsubmit = e => { e.preventDefault(); void act(async () => { await api.teamMessage(nodeId!, message.querySelector<HTMLSelectElement>('[name=to]')!.value || null, message.querySelector<HTMLTextAreaElement>('[name=text]')!.value, team); message.querySelector<HTMLTextAreaElement>('[name=text]')!.value = ''; }); };
      message.querySelector('textarea')!.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); message.requestSubmit(); } });
    }
    // One line creates: the title, and «!alta», «#etichetta», «@OP1» if you want them. The field stays for the next one.
    const quick = q<HTMLFormElement>('[data-quick]');
    if (quick) {
      const input = quick.querySelector<HTMLInputElement>('input')!;
      quick.onsubmit = e => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        if (team === REMINDERS) { void act(() => api.createReminder({ nodeId: nodeId!, title: text, notes: '', status: 'pending' })); return; }
        const parsed = parseQuickTask(text);
        if (!parsed) return;
        const owner = parsed.assignee ? view?.sessions.find(s => s.alive && s.role && s.code?.toUpperCase() === parsed.assignee) : undefined;
        if (parsed.assignee && !owner) fail(fill(tr('Nessun agente attivo con il codice {n}: l’incarico resta da assegnare.'), { n: parsed.assignee }));
        void act(() => api.teamTask(nodeId!, parsed.title, owner?.id ?? null, [], team, { ...(parsed.priority ? { priority: parsed.priority } : {}), ...(parsed.labels.length ? { labels: parsed.labels } : {}) }));
      };
      input.addEventListener('keydown', e => { if (e.key === 'Escape' && input.value) { e.preventDefault(); e.stopPropagation(); input.value = ''; } });
    }
    bindEditors();
    q('[data-save-summary]')?.addEventListener('click', () => void act(async () => {
      const summary = q<HTMLTextAreaElement>('[data-summary]')!.value, objective = q<HTMLTextAreaElement>('[data-objective]')?.value;
      await api.updateTeam(nodeId!, { summary, ...(objective !== undefined ? { objective } : {}) }, team);
      el.querySelectorAll<HTMLElement>('[data-dirty]').forEach(t => { delete t.dataset.dirty; });
    }));
    el.querySelectorAll<HTMLTextAreaElement>('[data-summary],[data-objective]').forEach(t => t.addEventListener('input', () => { t.dataset.dirty = '1'; }));
    const name = q<HTMLInputElement>('[data-team-name]');
    if (name) name.onchange = () => { if (name.value.trim()) void act(() => api.updateTeam(nodeId!, { name: name.value.trim() }, team)); };
    const settings = q<HTMLFormElement>('[data-settings]');
    if (settings) settings.onsubmit = e => { e.preventDefault(); void act(() => api.updateTeam(nodeId!, { maxAgents: Number(settings.querySelector<HTMLInputElement>('[name=limit]')!.value), autoSpawn: settings.querySelector<HTMLInputElement>('[name=auto]')!.checked, worktrees: settings.querySelector<HTMLInputElement>('[name=worktrees]')!.checked }, team)); };
    // Delegated clicks for everything painted with the data.
    el.querySelector('.lavoro')!.addEventListener('click', e => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('button,[data-goto],[data-card]'); if (!t) return;
      const d = t.dataset;
      if (t.closest('.lavoro-menu') && t.tagName === 'BUTTON') t.closest('details')!.open = false;
      if (d.goto) cb.open(d.goto);
      else if (d.youToggle !== undefined) { youExpanded = !youExpanded; updateDisclosure(); }
      else if (d.filter) { team = d.filter; view = null; panel = 'none'; openCard = null; paint(); void refresh(true); }
      else if (d.new !== undefined) q<HTMLInputElement>('[data-quick] input')?.focus();
      else if (d.panel) setPanel(d.panel as typeof panel);
      else if (d.newSquad !== undefined) cb.launch(nodeId!, { squad: true, teamId: 'new' });
      else if (d.startBrain !== undefined) cb.launch(nodeId!, { squad: false, role: 'brain' });
      else if (d.addAgent !== undefined) cb.launch(nodeId!, { squad: false, teamId: team });
      else if (d.reveal !== undefined) cb.reveal(nodeId!);
      else if (d.archive !== undefined) {
        if (view?.sessions.some(s => s.alive)) fail(tr('Chiudi prima le sessioni della squadra'));
        else void act(async () => { await api.updateTeam(nodeId!, { archived: true }, team); team = '1'; shell = ''; });
      }
      else if (d.link !== undefined) { const target = Number(q<HTMLSelectElement>('[data-link-target]')!.value); if (target) void act(async () => { await api.linkTeams({ srcNodeId: nodeId!, srcSessionId: null, dstNodeId: target, dstSessionId: null }); cb.linksChanged(); shell = ''; }); }
      else if (d.unlink) void act(async () => { await api.unlinkTeams(d.unlink!); cb.linksChanged(); shell = ''; });
      else if (d.delivery) void act(() => api.updateTeam(nodeId!, { delivery: d.delivery }, team));
      else if (d.memory) void act(() => api.updateTeam(nodeId!, { memory: d.memory }, team));
      else if (d.kindCycle) { const item = view?.inbox?.find(i => i.id === Number(d.kindCycle)); if (item) void act(() => api.sortItem(nodeId!, team, item.id, { kind: KINDS[(KINDS.indexOf(item.kind) + 1) % KINDS.length] })); }
      else if (d.moveTo) void act(() => api.sortItem(nodeId!, team, Number(d.item), { column: d.moveTo }));
      else if (d.forwardOne) { const note = el.querySelector<HTMLInputElement>(`[data-note="${d.forwardOne}"]`)?.value ?? ''; const to = el.querySelector<HTMLSelectElement>(`[data-forward-to="${d.forwardOne}"]`)?.value || null; void act(() => api.forward(nodeId!, team, [Number(d.forwardOne)], to, note)); }
      else if (d.taskDone) void act(() => api.patchTask(nodeId!, d.taskDone!, { status: 'done' }, team));
      else if (d.taskReopen) void act(() => api.patchTask(nodeId!, d.taskReopen!, { status: 'pending', assignedTo: null }, team));
      else if (d.taskAssign) {
        const to = el.querySelector<HTMLSelectElement>(`[data-assign-to="${d.taskAssign}"]`)?.value, id = d.taskAssign;
        // Dropped on «In corso» without an owner: once assigned, it starts.
        const start = assignFor === id;
        if (to) void act(async () => { await api.patchTask(nodeId!, id, { assignedTo: to, status: 'pending' }, team); if (start) { assignFor = null; await api.patchTask(nodeId!, id, { status: 'working' }, team); } });
      }
      else if (d.prioSet) { const [id, value] = d.prioSet.split(':'); void act(() => api.patchTask(nodeId!, id, { priority: value }, team)); }
      else if (d.labelRemove) { const [id, ...rest] = d.labelRemove.split(':'), label = rest.join(':'); const task = view?.tasks.find(x => x.id === id); if (task) void act(() => api.patchTask(nodeId!, id, { labels: (task.labels ?? []).filter(l => l !== label) }, team)); }
      else if (d.taskDuplicate) {
        const task = view?.tasks.find(x => x.id === d.taskDuplicate);
        if (task) void act(() => api.teamTask(nodeId!, `${task.title} ${tr('(copia)')}`.slice(0, 1000), null, task.scope, team, { ...(task.description ? { description: task.description } : {}), ...(task.priority ? { priority: task.priority } : {}), ...(task.labels?.length ? { labels: task.labels } : {}) }));
      }
      else if (d.taskDelete) {
        const task = view?.tasks.find(x => x.id === d.taskDelete);
        const live = task?.assignedTo && task.status !== 'done' && named(task.assignedTo)?.alive;
        if (task && confirm(live ? fill(tr('Eliminare «{t}»? {who} ci sta lavorando: riceverà l’istruzione di fermarsi.'), { t: task.title, who: who(task.assignedTo!) }) : fill(tr('Eliminare «{t}»? Non si può annullare.'), { t: task.title }))) { openCard = null; void act(() => api.deleteTask(nodeId!, task.id, team)); }
      }
      else if (d.reminderDelete) {
        const r = reminders.find(x => x.id === d.reminderDelete);
        if (r && confirm(fill(tr('Eliminare il promemoria «{t}»? Non si può annullare.'), { t: r.title }))) { openCard = null; void act(() => api.deleteReminder(r.id)); }
      }
      else if (d.assignCancel !== undefined) { assignFor = null; signature = ''; paint(); }
      else if (d.reminder) void act(() => api.updateReminder(d.reminder!, { status: d.to as NodeReminder['status'] }));
      else if (d.proposalStart) { const p = view?.proposals?.find(x => x.id === d.proposalStart); if (p) cb.launch(nodeId!, { squad: true, teamId: 'new', proposal: p }); }
      else if (d.proposalDiscard) void act(() => api.discardProposal(nodeId!, d.proposalDiscard!));
      else if (d.card && t.tagName !== 'BUTTON' && !(e.target as HTMLElement).closest('input,select,textarea,a,button')) toggleCard(d.card);
    });
    // Keyboard: Enter or Space on a focused card opens and closes it.
    el.querySelector('.lavoro')!.addEventListener('keydown', e => {
      const k = e as KeyboardEvent, card = (k.target as HTMLElement).dataset?.card;
      if (card && (k.key === 'Enter' || k.key === ' ')) { k.preventDefault(); toggleCard(card); }
      // Alt+←/→ moves the card to the next column, Alt+↑/↓ inside its column: the keyboard twin of dragging.
      else if (card && k.altKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(k.key) && (k.target as HTMLElement).dataset.drag !== undefined) {
        k.preventDefault();
        keyMove(card, k.key);
      }
    });
  }

  const announce = (text: string) => { const box = el.querySelector('[data-announce]'); if (box) box.textContent = text; };
  const laneName = (lane: Column) => tr(LANES.find(([id]) => id === lane)![1]);

  /** The fields of an open card save when they lose the focus; Enter on the title saves, Esc puts the old text back. */
  function bindEditors(): void {
    const root = el.querySelector<HTMLElement>('.lavoro')!;
    root.addEventListener('focusout', e => {
      const field = e.target as HTMLInputElement | HTMLTextAreaElement;
      if (field.dataset.editTask && field.dataset.edit) {
        const task = view?.tasks.find(t => t.id === field.dataset.editTask);
        if (!task) return;
        const key = field.dataset.edit as 'title' | 'description' | 'scope';
        const value = key === 'scope' ? field.value.split(',').map(p => p.trim()).filter(Boolean) : field.value.trim();
        const before = key === 'scope' ? task.scope : key === 'title' ? task.title : task.description ?? '';
        if (JSON.stringify(value) === JSON.stringify(before)) return;
        if (key === 'title' && !value) { field.value = task.title; return; }
        void act(() => api.patchTask(nodeId!, task.id, { [key]: value }, team));
      } else if (field.dataset.editReminder) {
        const r = reminders.find(x => x.id === field.dataset.editReminder), key = field.dataset.field as 'title' | 'notes';
        if (!r || field.value.trim() === r[key].trim()) return;
        if (key === 'title' && !field.value.trim()) { field.value = r.title; return; }
        void act(() => api.updateReminder(r.id, { [key]: key === 'title' ? field.value.trim() : field.value }));
      }
    });
    root.addEventListener('keydown', e => {
      const field = e.target as HTMLInputElement;
      if (field.matches('input.card-title') && (e.key === 'Enter' || e.key === 'Escape')) {
        e.preventDefault(); e.stopPropagation();
        if (e.key === 'Escape') {
          const task = field.dataset.editTask ? view?.tasks.find(t => t.id === field.dataset.editTask) : undefined;
          field.value = task?.title ?? reminders.find(r => r.id === field.dataset.editReminder)?.title ?? field.value;
        }
        field.closest<HTMLElement>('[data-card]')?.focus();
      } else if (field.dataset.labelAdd && e.key === 'Enter') {
        e.preventDefault();
        const task = view?.tasks.find(t => t.id === field.dataset.labelAdd), label = field.value.trim().replace(/^#/, '');
        if (!task || !label) return;
        field.value = '';
        if (!(task.labels ?? []).some(l => l.toLowerCase() === label.toLowerCase())) void act(() => api.patchTask(nodeId!, task.id, { labels: [...(task.labels ?? []), label] }, team));
      }
    });
  }

  /**
   * A card dropped in a column at `index` (among the cards shown there without it). The board moves at once and the
   * server follows; «In corso» without a live owner opens the card on «Chi lo fa?» instead.
   */
  function moveCard(cardId: string, lane: Column, index: number): void {
    if (cardId.startsWith('r:')) {
      const r = reminders.find(x => `r:${x.id}` === cardId), status = lane === 'todo' ? 'pending' : lane === 'doing' ? 'working' : 'done';
      if (!r || r.status === status) return;
      r.status = status; signature = ''; paint(); announce(fill(tr('Spostato in {n}'), { n: laneName(lane) }));
      void act(() => api.updateReminder(r.id, { status }));
      return;
    }
    const task = view?.tasks.find(t => `t:${t.id}` === cardId);
    if (!task) return;
    const owner = task.assignedTo ? named(task.assignedTo) : undefined;
    const move = laneMove(task, lane, !!owner?.alive);
    if (move && 'needsOwner' in move) {
      openCard = cardId; assignFor = task.id; signature = ''; paint();
      announce(tr('Per metterlo in corso scegli chi lo fa.'));
      el.querySelector<HTMLSelectElement>(`[data-assign-to="${task.id}"]`)?.focus();
      return;
    }
    const column = sortCards(view!.tasks.filter(t => columnOf(t) === lane && t.id !== task.id));
    const places = lane === 'done' ? [] : placeAt(column, task.id, index);
    if (!move && !places.length) return;
    if (move) task.status = move.status;
    for (const p of places) { const x = view!.tasks.find(t => t.id === p.id); if (x) x.order = p.order; }
    signature = ''; paint();
    el.querySelector<HTMLElement>(`[data-card="${CSS.escape(cardId)}"]`)?.focus({ preventScroll: true });
    announce(move ? fill(tr('Spostato in {n}'), { n: laneName(lane) }) : tr('Ordine cambiato'));
    const mine = places.find(p => p.id === task.id);
    void act(async () => {
      await api.patchTask(nodeId!, task.id, { ...(move ?? {}), ...(mine ? { order: mine.order } : {}) }, team);
      for (const p of places) if (p.id !== task.id) await api.patchTask(nodeId!, p.id, { order: p.order }, team);
    });
  }

  /** Alt+←/→: to the column beside, at the top. Alt+↑/↓: one place up or down in its column. */
  function keyMove(cardId: string, key: string): void {
    const order: Column[] = ['todo', 'doing', 'done'];
    const task = view?.tasks.find(t => `t:${t.id}` === cardId), reminder = reminders.find(r => `r:${r.id}` === cardId);
    const from: Column | 'you' = task ? columnOf(task) : reminder ? (reminder.status === 'pending' ? 'todo' : reminder.status === 'working' ? 'doing' : 'done') : 'todo';
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      const at = from === 'you' ? (key === 'ArrowLeft' ? 1 : 0) : order.indexOf(from);
      const to = order[at + (key === 'ArrowLeft' ? -1 : 1)];
      if (to) moveCard(cardId, to, 0);
      return;
    }
    if (!task || from === 'you' || from === 'done') return;
    const column = sortCards(view!.tasks.filter(t => columnOf(t) === from));
    const at = column.findIndex(t => t.id === task.id), next = at + (key === 'ArrowUp' ? -1 : 1);
    if (at < 0 || next < 0 || next >= column.length) return;
    moveCard(cardId, from, next);
  }

  function toggleCard(card: string): void { openCard = openCard === card ? null : card; if (openCard !== `t:${assignFor}`) assignFor = null; signature = ''; paint(); }

  function setPanel(next: typeof panel): void { panel = next; shell = ''; paint(); if (next === 'link') void refresh(true); el.querySelector<HTMLElement>('[data-panel-box] input, [data-panel-box] textarea')?.focus(); }

  /** Filters: squads first, then the Main Brain and the reminders of the node. */
  function paintFilters(list: TeamSummary[], brainSession: TerminalInfo | null | undefined): void {
    const nav = el.querySelector('.lavoro-filters'); if (!nav) return;
    const needs = (t: TeamSummary) => t.tasks.blocked + t.inbox;
    const chip = (id: string, body: string, title = '') => `<button class="squad-tab ${team === id ? 'selected' : ''}" data-filter="${esc(id)}" aria-pressed="${team === id}" title="${esc(title)}">${body}</button>`;
    const open = reminders.filter(r => r.status !== 'done').length;
    const html = list.filter(t => !t.archived || t.id === team).map(t => chip(t.id, ui`${swatch(t)}<span>${esc(t.name)}</span>${needs(t) ? `<b class="needs-badge">${needs(t)}</b>` : ''}`, [t.alive ? ui`${t.alive} attivi` : tr('ferma'), t.objective ?? ''].filter(Boolean).join(' · '))).join('')
      + chip('brain', ui`${swatch(undefined)}<span>Main Brain</span>`, brainSession ? brainSession.code ?? '' : tr('non attivo'))
      + chip(REMINDERS, ui`<span>Promemoria</span>${team === REMINDERS && open ? `<small>${open}</small>` : ''}`, tr('Promemoria del nodo, senza agenti'))
      + ui`<button class="squad-tab add" data-new-squad title="Avvia un’altra squadra nello stesso nodo, con la sua bacheca">＋ Squadra</button>`;
    if (nav.innerHTML !== html) nav.innerHTML = html;
  }

  function paint(): void {
    if (!visible || dragging) return;
    if (nodeId === null) { el.innerHTML = tr('<div class="board-empty muted">Aggiungi un nodo a Operativa per vederne il lavoro.</div>'); shell = ''; return; }
    paintShell();
    if (!view) return;
    // Activity and relative times belong to the member buttons. Only roster changes and attention
    // prompts affect the lanes, their editors, the message recipients or the squad filters.
    const { sessions, peers, brain, ...board } = view;
    const roster = (s: TerminalInfo) => [s.id, s.nodeId, s.role, s.code, s.name, s.alive, s.attention];
    const sig = JSON.stringify([board, sessions.map(roster), peers?.map(roster), brain && roster(brain), reminders, [...folders], links, openCard, assignFor]);
    if (sig === signature) {
      paintMemberStates();
      return;
    }
    signature = sig;
    paintFilters(view.teamList ?? [], view.brain);
    paintPanelData();
    const lanes: Record<LaneId, string[]> = { todo: [], doing: [], you: [], done: [] };
    if (team === REMINDERS) {
      for (const r of reminders) lanes[r.status === 'pending' ? 'todo' : r.status === 'working' ? 'doing' : 'done'].push(reminderCard(r));
    } else if (team === 'brain') {
      for (const t of (view.teamList ?? []).filter(t => !t.archived)) lanes[t.alive ? 'doing' : t.tasks.done && !t.tasks.pending && !t.tasks.working ? 'done' : 'todo'].push(squadCard(t));
      for (const p of (view.proposals ?? []).slice().reverse()) lanes[p.status === 'pending' ? 'you' : 'done'].push(proposalCard(p));
      if (!view.brain) lanes.you.unshift(ui`<article class="lavoro-card"><strong>Main Brain non attivo</strong><p class="muted">Coordina gli orchestratori delle squadre di questo nodo e propone nuove squadre: le avvii tu.</p><footer><button class="btn small primary" data-start-brain>Avvia Main Brain</button></footer></article>`);
    } else {
      for (const t of sortCards(view.tasks)) lanes[taskLane(t)].push(taskCard(t));
    }
    if (team !== REMINDERS) {
      // Permission prompts and questions of this board's sessions: answered in their terminal.
      for (const s of (team === 'brain' ? (view.brain ? [view.brain] : []) : view.sessions)) if (s.alive && sessionTone(s) === 'attention') lanes.you.unshift(ui`<article class="lavoro-card" data-tone="attention"><header><span class="work-code">${esc(s.code ?? '')}</span><small>${esc([s.name || roleName(s), accountTag(s)].filter(Boolean).join(' · '))}</small></header><strong>${esc(toneReason(s))}</strong><footer><button class="btn small primary" data-goto="${esc(s.id)}">Apri terminale</button></footer></article>`);
      for (const i of view.inbox ?? []) if (inboxLane(i) === 'you') lanes.you.push(inboxCard(i)); else if (lanes.done.length < 14) lanes.done.push(inboxCard(i));
    }
    const empty: Record<LaneId, string> = { todo: tr('Niente in coda'), doing: tr('Nessuno sta lavorando'), you: '', done: '—' };
    // Only a field being typed in holds a lane still; a focused card is repainted and gets its focus back.
    const active = document.activeElement as HTMLElement | null;
    const typing = active?.matches('input,select,textarea') ? active : null;
    const focusedCard = !typing ? active?.closest<HTMLElement>('[data-card]')?.dataset.card : undefined;
    for (const id of ['you', ...LANES.map(([lane]) => lane)] as LaneId[]) {
      const lane = el.querySelector(`[data-lane="${id}"]`); if (!lane) continue;
      const cards = id === 'done' ? lanes.done.slice(0, 14) : lanes[id];
      lane.querySelector('.kanban-count')!.textContent = lanes[id].length ? String(lanes[id].length) : '';
      lane.classList.toggle('alert', id === 'you' && lanes.you.length > 0);
      if (!typing || !lane.contains(typing)) lane.querySelector('.lavoro-cards')!.innerHTML = cards.join('') || (id === 'you' ? hintLine() : `<p class="kanban-empty muted">${esc(empty[id])}</p>`);
    }
    // After the lanes: whether «Serve te» shows the hint decides where «+ Agente» goes.
    paintGoal(lanes.you.length);
    el.querySelector('.lavoro')!.setAttribute('aria-busy', 'false');
    updateDisclosure();
    if (focusedCard && document.activeElement === document.body) el.querySelector<HTMLElement>(`[data-card="${CSS.escape(focusedCard)}"]:not([hidden])`)?.focus({ preventScroll: true });
    paintMessages();
    paintError();
  }

  /** "Serve te" when empty: one sentence on the squad and, if useful, the button for the next move. */
  function hintLine(): string {
    if (team === 'brain') return ui`<p class="lavoro-hint"><span>✓ Niente per te: nessuna proposta da valutare.</span></p>`;
    const hint = boardHint(view!.tasks, view!.sessions.filter(s => s.alive && s.role).length);
    const button = hint.action === 'agent' ? ui`<button class="btn small primary" data-add-agent>＋ Agente</button>` : '';
    return `<p class="lavoro-hint"><span>${hint.action === 'agent' ? '' : '✓ '}${esc(hint.text)}</span>${button}</p>`;
  }

  function paintMemberStates(): void {
    const members = new Map((team === 'brain' ? (view!.brain ? [view!.brain] : []) : view!.sessions).map(member => [member.id, member]));
    for (const chip of el.querySelectorAll<HTMLElement>('[data-goal] .member-chip[data-goto]')) {
      const member = members.get(chip.dataset.goto!);
      if (!member) continue;
      const tone = sessionTone(member) ?? '';
      const title = [member.name || roleName(member), toneReason(member), member.agent, accountTag(member), member.model, member.effort].filter(Boolean).join(' · ');
      if (chip.dataset.tone !== tone) chip.dataset.tone = tone;
      if (chip.title !== title) chip.title = title;
    }
  }

  /** One line under the filters: objective, summary, and who is on the squad. `waiting` counts the «Serve te» cards. */
  function paintGoal(waiting: number): void {
    const box = el.querySelector<HTMLElement>('[data-goal]')!;
    if (team === REMINDERS) {
      reconcileWorkList(box, [{ key: 'reminders', html: ui`<p class="muted">Promemoria del nodo: note per te, senza agenti. Si spostano con i pulsanti della scheda.</p>` }]);
      return;
    }
    const info = team === 'brain' ? null : view!.team;
    const objective = info?.objective || '', summary = view!.summary;
    const members = (team === 'brain' ? (view!.brain ? [view!.brain] : []) : view!.sessions).slice().sort((a, b) => Number(b.alive) - Number(a.alive) || Number(b.role === 'orchestrator') - Number(a.role === 'orchestrator'));
    const chips: WorkListItem[] = members.map(member => ({
      key: member.id, html: ui`<button class="member-chip" data-goto="${esc(member.id)}"><i></i>${esc(member.code ?? member.id)}</button>`,
    }));
    // «+ Agente» appears once: in the «Serve te» hint while no agent runs and nothing waits on the person, here otherwise.
    if (info && addAgentChip(members, waiting)) chips.push({ key: 'action:add', html: ui`<button class="member-chip add" data-add-agent title="Aggiungi agente" aria-label="Aggiungi agente">＋</button>` });
    reconcileWorkList(box, [
      { key: 'objective', html: `<div class="lavoro-objective">${objective ? `<p class="clamp" title="${esc(objective)}">${esc(objective)}</p>` : ''}${summary ? `<p class="muted clamp" title="${esc(summary)}">${esc(summary)}</p>` : ''}${!objective && !summary && info ? ui`<button type="button" class="btn small ghost lavoro-set-goal" data-panel="settings">Imposta obiettivo</button>` : ''}</div>` },
      { key: 'members', html: '<div class="lavoro-members"></div>', children: chips },
    ]);
    paintMemberStates();
  }

  function paintPanelData(): void {
    const focusIn = (s: string) => el.querySelector(s)?.contains(document.activeElement);
    const delivery = view!.policy.delivery ?? 'auto';
    const deliveryBox = el.querySelector('.board-delivery');
    if (deliveryBox) deliveryBox.innerHTML = deliveryBox.querySelector('span')!.outerHTML + ui`<button class="chip" role="radio" data-delivery="auto" aria-checked="${delivery === 'auto'}" title="Ogni risultato arriva subito">Automatica</button><button class="chip" role="radio" data-delivery="manual" aria-checked="${delivery === 'manual'}" title="Arriva prima in «Serve te»: decidi tu cosa inoltrare">Manuale</button>`;
    const summary = el.querySelector<HTMLTextAreaElement>('[data-summary]');
    if (summary && !summary.dataset.dirty && document.activeElement !== summary) summary.value = view!.summary;
    const info = view!.team;
    if (info && el.querySelector('[data-settings]')) {
      const memory = view!.policy.memory ?? 'leaders';
      const memoryBox = el.querySelector('.board-memory')!;
      memoryBox.innerHTML = memoryBox.querySelector('span')!.outerHTML + MEMORY.map(([mode, label, hint]) => `<button class="chip" role="radio" data-memory="${mode}" aria-checked="${memory === mode}" title="${esc(hint)}">${esc(label)}</button>`).join('');
      el.querySelector('[data-memory-hint]')!.textContent = (MEMORY.find(([mode]) => mode === memory)?.[2] ?? '') + ' ' + tr('Vale per gli agenti Claude avviati o ripresi da ora.');
      const name = el.querySelector<HTMLInputElement>('[data-team-name]')!;
      if (document.activeElement !== name) name.value = info.name;
      el.querySelector('.board-branch')!.textContent = info.worktree ? ui`ramo ${info.worktree.branch}` : '';
      const objective = el.querySelector<HTMLTextAreaElement>('[data-objective]')!;
      if (!objective.dataset.dirty && document.activeElement !== objective) objective.value = info.objective ?? '';
      const settings = el.querySelector<HTMLFormElement>('[data-settings]')!;
      if (!focusIn('[data-settings]')) {
        settings.querySelector<HTMLInputElement>('[name=limit]')!.value = String(view!.policy.maxAgents);
        settings.querySelector<HTMLInputElement>('[name=auto]')!.checked = view!.policy.autoSpawn;
        settings.querySelector<HTMLInputElement>('[name=worktrees]')!.checked = !!view!.policy.worktrees;
      }
    }
    const target = el.querySelector<HTMLSelectElement>('[data-link-target]');
    if (target && !focusIn('[data-panel-box]')) {
      const mine = links.filter(l => l.srcNodeId === nodeId || l.dstNodeId === nodeId);
      const other = (l: TeamLink) => l.srcNodeId === nodeId ? l.dstNodeId : l.srcNodeId;
      const nameOf = (id: number) => nodes.find(n => n.id === id)?.name ?? `#${id}`;
      target.innerHTML = ui`<option value="">Scegli un nodo di Operativa…</option>` + nodes.filter(n => n.id !== nodeId && !mine.some(l => other(l) === n.id && !l.srcSessionId && !l.dstSessionId)).map(n => `<option value="${n.id}">${esc(n.name)}</option>`).join('');
      el.querySelector('[data-links]')!.innerHTML = mine.map(l => ui`<li><span>↔ ${esc(nameOf(other(l)))}${l.srcSessionId || l.dstSessionId ? ` <small>${esc([l.srcSessionId, l.dstSessionId].filter(Boolean).map(id => who(id!)).join(' ↔ '))}</small>` : ''}</span><button class="btn small ghost" data-unlink="${l.id}">Scollega</button></li>`).join('') || ui`<li class="muted">Nessun collegamento.</li>`;
    }
  }

  function paintMessages(): void {
    const box = el.querySelector('.board-messages'); if (!box) return;
    const list = view!.messages;
    el.querySelector('[data-message-count]')!.textContent = list.length ? `· ${list.length}` : '';
    const html = list.slice(-20).map(m => ui`<article class="team-message"><small>${esc(who(m.from))} → ${m.to ? esc(who(m.to)) : tr('Squadra')} · ${time(m.createdAt)}</small><p>${codeLinks(esc(m.text))}</p></article>`).join('') || tr('<p class="muted">Nessun messaggio.</p>');
    if (box.innerHTML !== html) { const bottom = box.scrollHeight - box.clientHeight - box.scrollTop < 30; box.innerHTML = html; if (bottom) box.scrollTop = box.scrollHeight; }
    const to = el.querySelector<HTMLSelectElement>('[data-message] [name=to]')!;
    if (!el.querySelector('[data-message]')!.contains(document.activeElement)) {
      const prev = to.value, brain = team === 'brain';
      const targets = [...view!.sessions, ...view!.peers].filter((s, i, all) => s.alive && s.role && all.findIndex(x => x.id === s.id) === i);
      to.innerHTML = (brain ? '' : ui`<option value="">Tutta la squadra</option>`) + targets.map(s => `<option value="${esc(s.id)}">${esc(who(s.id))}${s.nodeId !== nodeId ? ' · ' + esc(nodes.find(n => n.id === s.nodeId)?.name ?? '') : ''}</option>`).join('');
      const leader = targets.find(s => s.role === (brain ? 'brain' : 'orchestrator'));
      to.value = [...to.options].some(o => o.value === prev) && prev ? prev : leader?.id ?? '';
    }
  }

  /** «What it is doing now» under a card in progress: the owner's terminal title, time at it, output coming or not. */
  function nowHtml(t: TeamTask, owner: TerminalInfo | undefined): string {
    if (t.status !== 'working' || !owner) return '';
    const line = nowLine(owner, undefined);
    if (!line) return '';
    return `<p class="lavoro-now" data-now="${esc(owner.id)}" data-live="${line.live}">${line.doing ? `<span>${esc(line.doing)}</span>` : ''}<small>${esc(line.meta)}</small></p>`;
  }
  /** The «now» lines age between reads: rewrite their text only, never the card (a field may be in use). */
  function paintNow(): void {
    for (const p of el.querySelectorAll<HTMLElement>('.lavoro-now[data-now]')) {
      const owner = named(p.dataset.now!);
      const line = owner ? nowLine(owner, undefined) : null;
      const small = p.querySelector('small');
      if (line && small && small.textContent !== line.meta) small.textContent = line.meta;
    }
  }

  function taskCard(t: TeamTask): string {
    const id = `t:${t.id}`, open = openCard === id;
    const assignee = t.assignedTo ? named(t.assignedTo) : undefined;
    const live = view!.sessions.filter(s => s.alive && s.role && s.role !== 'orchestrator');
    const status = taskStatus(t, assignee);
    const tags = (t.priority ? `<span class="prio-flag" data-prio="${t.priority}">${esc(t.priority === 'high' ? tr('Alta') : tr('Bassa'))}</span>` : '')
      + (t.labels ?? []).map(l => `<span class="task-label">${esc(l)}</span>`).join('');
    const drag = ' data-drag';
    if (!open) {
      // Closed: what to read at a glance. Done cards stay one line; the others show their latest result.
      const result = t.result && t.status !== 'done' ? `<p class="lavoro-result clamp">${codeLinks(esc(t.result))}</p>` : '';
      const description = t.description && t.status !== 'done' && !t.result ? `<p class="lavoro-desc clamp">${esc(t.description)}</p>` : '';
      return ui`<article class="lavoro-card" data-card="${id}" data-status="${t.status}"${t.priority ? ` data-priority="${t.priority}"` : ''}${drag} tabindex="0" aria-expanded="false">${tags ? `<div class="lavoro-tags">${tags}</div>` : ''}<strong>${esc(t.title)}</strong><p class="lavoro-status" data-tone="${status.tone}"><i></i>${codeLinks(esc(status.text))}${t.held ? ui` · <em class="held-flag">In smistamento</em>` : ''}</p>${nowHtml(t, assignee)}${description}${result}</article>`;
    }
    // Open: the card is its own editor. Fields save when they lose the focus (Enter on the title, Esc puts it back).
    const prio = (['high', 'normal', 'low'] as const).map(p => `<button type="button" class="chip" data-prio-set="${t.id}:${p}" aria-pressed="${(t.priority ?? 'normal') === p}">${esc(p === 'high' ? tr('Alta') : p === 'low' ? tr('Bassa') : tr('Normale'))}</button>`).join('');
    const labels = (t.labels ?? []).map(l => `<span class="task-label">${esc(l)}<button type="button" data-label-remove="${esc(t.id)}:${esc(l)}" aria-label="${esc(fill(tr('Togli l’etichetta {n}'), { n: l }))}">×</button></span>`).join('');
    const needOwner = assignFor === t.id;
    const assign = t.status !== 'done' ? (live.length
      ? ui`<div class="card-row${needOwner ? ' card-ask' : ''}"><span class="card-key">${needOwner ? tr('Chi lo fa?') : tr('Assegna a')}</span><span class="card-assign"><select data-assign-to="${t.id}" aria-label="Assegna a">${live.map(s => `<option value="${esc(s.id)}" ${s.id === t.assignedTo ? 'selected' : ''}>${esc(who(s.id))}</option>`).join('')}</select><button class="btn small${needOwner ? ' primary' : ''}" data-task-assign="${t.id}">${needOwner ? tr('Assegna e avvia') : tr('Assegna')}</button>${needOwner ? ui`<button class="btn small ghost" data-assign-cancel>Annulla</button>` : ''}</span></div>`
      : ui`<div class="card-row${needOwner ? ' card-ask' : ''}"><span class="card-key">Assegna a</span><span class="muted">Nessun operatore attivo.</span><button class="btn small" data-add-agent>＋ Agente</button></div>`) : '';
    const actions = [
      assignee?.alive ? ui`<button class="btn small" data-goto="${esc(assignee.id)}">Apri terminale</button>` : '',
      t.status === 'blocked' ? ui`<button class="btn small ghost" data-task-reopen="${t.id}">Riapri</button>` : '',
      t.status !== 'done' ? ui`<button class="btn small ghost" data-task-done="${t.id}">Segna completato</button>` : ui`<button class="btn small ghost" data-task-reopen="${t.id}">Riapri</button>`,
      ui`<button class="btn small ghost" data-task-duplicate="${t.id}">Duplica</button>`,
      ui`<button class="btn small ghost danger-text" data-task-delete="${t.id}">Elimina</button>`,
    ].join('');
    const result = t.result ? `<div class="card-row card-result"><span class="card-key">${esc(tr('Esito'))}</span><p class="lavoro-result">${codeLinks(esc(t.result))}</p></div>` : '';
    return ui`<article class="lavoro-card open" data-card="${id}" data-status="${t.status}"${t.priority ? ` data-priority="${t.priority}"` : ''}${drag} tabindex="0" aria-expanded="true">
      <input class="card-title" data-edit="title" data-edit-task="${t.id}" value="${esc(t.title)}" maxlength="1000" aria-label="Titolo dell’incarico">
      <p class="lavoro-status" data-tone="${status.tone}"><i></i>${codeLinks(esc(status.text))}${t.held ? ui` · <em class="held-flag">In smistamento</em>` : ''}</p>${nowHtml(t, assignee)}
      <textarea class="card-desc" data-edit="description" data-edit-task="${t.id}" rows="3" maxlength="4000" placeholder="Descrizione: cosa fare e quando è finito…" aria-label="Descrizione">${esc(t.description ?? '')}</textarea>
      <div class="card-row"><span class="card-key">Priorità</span><span class="card-chips" role="group" aria-label="Priorità">${prio}</span></div>
      <div class="card-row"><span class="card-key">Etichette</span><span class="card-labels">${labels}<input data-label-add="${t.id}" maxlength="24" placeholder="+ etichetta ↵" aria-label="Aggiungi etichetta"></span></div>
      <div class="card-row"><span class="card-key">File</span><input class="card-scope" data-edit="scope" data-edit-task="${t.id}" value="${esc(t.scope.join(', '))}" placeholder="percorsi, separati da virgola" aria-label="File e cartelle"></div>
      ${assign}${result}<footer>${actions}</footer></article>`;
  }

  function inboxCard(i: InboxItem): string {
    const id = `i:${i.id}`, open = openCard === id, pending = i.column === 'new' || i.column === 'ready';
    const leaders = all().filter((s, k, list) => s.alive && (s.role === 'orchestrator' || s.role === 'brain') && s.nodeId === nodeId && list.findIndex(x => x.id === s.id) === k);
    const forward = pending && open ? ui`<div class="board-row"><select data-forward-to="${i.id}" aria-label="Destinatario"><option value="">${team === 'brain' ? tr('Main Brain') : tr('Orchestratore della squadra')}</option>${leaders.map(s => `<option value="${esc(s.id)}">${esc(who(s.id))}</option>`).join('')}</select><input class="sort-note" data-note="${i.id}" maxlength="1000" placeholder="Nota per chi riceve" value="${esc(i.note ?? '')}"></div>` : '';
    return ui`<article class="lavoro-card sort-card ${open ? 'open' : ''}" data-card="${id}" data-kind="${i.kind}" tabindex="0"><header><button class="kind-chip" data-kind-cycle="${i.id}" title="Cambia categoria" ${pending ? '' : 'disabled'}>${kindLabel(i.kind)}</button><span class="work-code">${esc(named(i.from)?.code ?? who(i.from))}</span><time>${time(i.createdAt)}</time></header>${i.taskTitle ? `<strong>${esc(i.taskTitle)}</strong>` : ''}<p class="${open ? '' : 'clamp'}" title="${esc(i.text)}">${codeLinks(esc(i.text))}</p>${i.forwardedTo ? ui`<small class="forwarded">→ ${esc(who(i.forwardedTo))} · ${time(i.forwardedAt ?? i.updatedAt)}</small>` : ''}${forward}${pending ? ui`<footer><button class="btn small primary" data-forward-one="${i.id}">Inoltra</button><button class="btn small ghost" data-move-to="archived" data-item="${i.id}">Archivia</button></footer>` : i.column === 'archived' && open ? ui`<footer><button class="btn small ghost" data-move-to="new" data-item="${i.id}">Ripristina</button></footer>` : ''}</article>`;
  }

  function reminderCard(r: NodeReminder): string {
    const id = `r:${r.id}`, open = openCard === id;
    const folder = r.folderId ? folders.get(r.folderId) : undefined;
    const next: Array<[NodeReminder['status'], string]> = r.status === 'pending' ? [['working', 'Inizia'], ['done', 'Fatto']] : r.status === 'working' ? [['done', 'Fatto'], ['pending', 'Rimetti da fare']] : [['pending', 'Riapri']];
    const moves = next.map(([to, label], k) => `<button class="btn small ${k ? 'ghost' : ''}" data-reminder="${esc(r.id)}" data-to="${to}">${esc(tr(label))}</button>`).join('');
    if (!open) return `<article class="lavoro-card" data-card="${id}" data-status="${r.status}" data-drag tabindex="0" aria-expanded="false"><header>${folder ? `<span class="chip label-chip">${esc(folder)}</span>` : ''}<time>${time(r.updatedAt)}</time></header><strong>${esc(r.title)}</strong>${r.notes ? `<p class="muted clamp">${esc(r.notes)}</p>` : ''}<footer>${moves}</footer></article>`;
    return ui`<article class="lavoro-card open" data-card="${id}" data-status="${r.status}" data-drag tabindex="0" aria-expanded="true">
      <input class="card-title" data-edit-reminder="${esc(r.id)}" data-field="title" value="${esc(r.title)}" maxlength="1000" aria-label="Promemoria">
      <textarea class="card-desc" data-edit-reminder="${esc(r.id)}" data-field="notes" rows="3" maxlength="10000" placeholder="Appunti…" aria-label="Appunti">${esc(r.notes)}</textarea>
      <footer>${moves}<button class="btn small ghost danger-text" data-reminder-delete="${esc(r.id)}">Elimina</button></footer></article>`;
  }

  function squadCard(t: TeamSummary): string {
    const total = t.tasks.pending + t.tasks.working + t.tasks.blocked + t.tasks.done;
    return ui`<article class="lavoro-card swarm-card" data-team-color="${t.color}"><header>${swatch(t)}<strong>${esc(t.name)}</strong></header><small>${t.orchestrator ? esc(t.orchestrator) : tr('nessun orchestratore')} · ${t.alive} attivi · ${t.tasks.done}/${total} incarichi${t.tasks.blocked ? ui` · <b>${t.tasks.blocked} bloccati</b>` : ''}${t.inbox ? ui` · <b>${t.inbox} da smistare</b>` : ''}</small>${t.objective ? `<p class="clamp">${esc(t.objective)}</p>` : ''}<div class="swarm-progress"><span style="width:${total ? Math.round(t.tasks.done / total * 100) : 0}%"></span></div><footer><button class="btn small ghost" data-filter="${t.id}">Apri</button></footer></article>`;
  }

  function proposalCard(p: SwarmProposal): string {
    return ui`<article class="lavoro-card proposal-card" data-status="${p.status}"><header><small>Proposta · ${time(p.createdAt)} · ${p.status === 'pending' ? tr('in attesa') : p.status === 'launched' ? tr('avviata') : tr('scartata')}</small></header><strong>${esc(p.name)}</strong><p class="clamp">${esc(p.objective)}</p><div class="proposal-members">${p.members.map(m => `<span class="chip">${esc(m.role === 'orchestrator' ? '◆ ' : '● ')}${esc(m.agent)}${m.model ? ' · ' + esc(m.model) : ''}</span>`).join('')}</div>${p.status === 'pending' ? ui`<footer><button class="btn small primary" data-proposal-start="${p.id}">Avvia…</button><button class="btn small ghost" data-proposal-discard="${p.id}">Scarta</button></footer>` : ''}</article>`;
  }

  return (nextNodes, selected, show, nextTeam) => {
    nodes = nextNodes;
    const node = selected !== null && nodes.some(n => n.id === selected) ? selected : nodeId !== null && nodes.some(n => n.id === nodeId) ? nodeId : nodes[0]?.id ?? null;
    selectNode(node);
    if (nextTeam && nextTeam !== team) { team = nextTeam; view = null; panel = 'none'; }
    visible = show;
    if (!visible) { if (timer) { clearInterval(timer); timer = null; } return; }
    timer ??= setInterval(tick, 1000);
    paint(); void refresh();
  };
}
