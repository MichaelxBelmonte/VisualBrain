// Stats: what the agents are doing now and what they did in the period. Turns, tokens and models come from the CLIs'
// own records (exact, not estimated); tasks from the squads' boards. Visual Brain's own measures (local API traffic,
// hook-reported turns, latencies) sit in «Dettagli tecnici», closed by default.
import type { MegaStatsReport, StatsLatency, StatsMeasures, StatsSession, StatsTeam, StatsUsage } from '../shared/mega-stats.ts';
import { getLanguage, t } from './i18n.ts';
import { mountQuotaPanel } from './quota-panel.ts';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function numeric(value: number | null, digits = 1): string {
  return value === null ? t('N/D') : value.toLocaleString(getLanguage(), { maximumFractionDigits: digits });
}

/** 1234567 → «1,2 Mln» / «1.2M»: token counts read at a glance. */
function tokens(value: number): string {
  return value.toLocaleString(getLanguage(), { notation: 'compact', maximumFractionDigits: 1 });
}

function duration(ms: number | null): string {
  if (ms === null) return t('N/D');
  if (ms < 1000) return numeric(ms) + ' ms';
  if (ms < 60_000) return numeric(ms / 1000) + ' s';
  if (ms < 3_600_000) return numeric(ms / 60_000, 0) + ' min';
  return numeric(ms / 3_600_000) + ' h';
}

function timestamp(value: number): HTMLTimeElement {
  const date = new Date(value);
  const time = el('time', date.toLocaleString(getLanguage(), { dateStyle: 'short', timeStyle: 'short' }));
  time.dateTime = date.toISOString();
  return time;
}

function button(label: string, click: () => void, className = 'btn'): HTMLButtonElement {
  const b = el('button', label, className);
  b.type = 'button';
  b.onclick = click;
  return b;
}

/** One number of a row of figures, with a short note under it. */
function figure(label: string, value: string, note?: string): HTMLElement {
  const group = el('div');
  const dd = el('dd', value);
  if (note) dd.append(el('small', note));
  group.append(el('dt', label), dd);
  return group;
}

function figures(...items: HTMLElement[]): HTMLDListElement {
  const dl = el('dl', undefined, 'mega-stats-kpis');
  dl.append(...items);
  return dl;
}

function filterField(title: string) {
  const label = el('label');
  const select = el('select');
  label.append(el('span', title), select);
  return { label, select };
}

function options(select: HTMLSelectElement, choices: { value: string; label: string }[], selected: string) {
  const next = choices.map(choice => new Option(choice.label, choice.value));
  if (selected && !choices.some(choice => choice.value === selected)) {
    const previous = [...select.options].find(option => option.value === selected);
    next.push(new Option(previous?.text ?? selected, selected));
  }
  select.replaceChildren(...next);
  select.value = selected;
}

/** A table whose first column names the row; `numericFrom`: the columns from there on are figures, right-aligned. */
function table(headers: string[], rows: (string | HTMLElement)[][], caption?: string): HTMLTableElement {
  const tab = el('table', undefined, 'mega-stats-table');
  if (caption) tab.append(el('caption', caption));
  const head = tab.createTHead().insertRow();
  for (const title of headers) {
    const th = el('th', title);
    th.scope = 'col';
    head.append(th);
  }
  const body = tab.createTBody();
  for (const [label, ...cells] of rows) {
    const tr = body.insertRow();
    const th = el('th');
    th.scope = 'row';
    th.append(label);
    tr.append(th);
    for (const value of cells) { const td = el('td'); td.append(value); tr.append(td); }
  }
  return tab;
}

const AGENTS: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', hermes: 'Hermes', agy: 'Antigravity', shell: 'Terminale' };
const agentName = (agent: string) => agent === 'shell' ? t('Terminale') : AGENTS[agent] ?? agent;

/** «claude-opus-5-5» → «Opus 5.5»; other models as the CLI names them. */
export function modelName(model: string | null): string {
  if (!model) return '—';
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?![\d])/.exec(model);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? '.' + m[3] : ''}` : model;
}

/** Tokens of the answers: what the model read new plus what it wrote; the cache is shown apart (it costs much less). */
export const worked = (u: StatsUsage) => u.input + u.output;

function usageCells(u: StatsUsage | null): string[] {
  if (!u) return [t('N/D'), t('N/D')];
  return [numeric(u.turns, 0), tokens(worked(u))];
}

function sessionState(s: StatsSession): string {
  if (!s.alive) return t('Terminata');
  if (s.state === 'blocked') return t('Bloccata');
  if (s.attention) return t('Aspetta te');
  if (s.state === 'working') return t('Al lavoro');
  if (s.state === 'idle') return t('Libera');
  return t('In esecuzione');
}

const roleNames = (): Record<string, string> => ({ brain: 'Main Brain', orchestrator: t('Orchestratore'), operator: t('Operatore'), reviewer: t('Revisore') });

function boardButton(nodeId: number, teamId: string, label: string) {
  const b = button(label, () => window.dispatchEvent(new CustomEvent('vb:stats-board', { detail: { nodeId, teamId } })), 'btn small');
  b.dataset.focusKey = 'board:' + nodeId + ':' + teamId;
  return b;
}

function details(title: string, key: string, note?: string) {
  const d = el('details');
  const s = el('summary', title);
  if (note) s.append(el('small', note));
  d.dataset.key = key;
  s.dataset.focusKey = key;
  d.append(s);
  return d;
}

function sessionCount(n: number): string {
  return n === 1 ? t('1 sessione') : t('{n} sessioni').replace('{n}', numeric(n));
}

/** Adesso: live sessions, those waiting for the person, those blocked; and where to step in. */
function now(r: MegaStatsReport): HTMLElement {
  const section = el('section', undefined, 'mega-stats-section');
  section.append(el('h3', t('Adesso')));
  const agents = r.sessions.filter(s => s.alive && s.agent !== 'shell');
  const waiting = r.sessions.filter(s => s.alive && s.attention), blocked = r.sessions.filter(s => s.alive && s.state === 'blocked');
  const blockedTasks = r.teams.reduce((n, g) => n + g.tasks.blocked, 0);
  section.append(figures(
    figure(t('Agenti attivi'), numeric(agents.length, 0), agents.length ? t('{n} al lavoro').replace('{n}', numeric(agents.filter(s => s.state === 'working').length, 0)) : undefined),
    figure(t('Aspettano te'), numeric(waiting.length, 0), t('permessi o domande nel terminale')),
    figure(t('Sessioni bloccate'), numeric(blocked.length, 0)),
    figure(t('Incarichi bloccati'), numeric(blockedTasks, 0), t('nelle bacheche'))));
  const targets = el('div', undefined, 'mega-stats-targets');
  for (const g of r.teams.filter(g => g.tasks.blocked)) {
    targets.append(boardButton(g.nodeId, g.id, [r.projects.find(p => p.id === g.projectId)?.name, g.name, t('{n} incarichi bloccati').replace('{n}', String(g.tasks.blocked))].filter(Boolean).join(' · ')));
  }
  for (const s of [...waiting, ...blocked.filter(s => !s.attention)]) {
    const team = r.teams.find(g => g.key === s.teamKey);
    const label = [r.projects.find(p => p.id === s.projectId)?.name, s.label, s.attention ? t('aspetta te') : t('bloccata')].filter(Boolean).join(' · ');
    targets.append(team ? boardButton(s.nodeId, team.id, label) : el('span', label, 'mega-stats-meta'));
  }
  if (targets.childElementCount) section.append(el('p', t('Dove intervenire'), 'mega-stats-label'), targets);
  return section;
}

/** Nel periodo: requests to the agents, tokens, completed tasks and the agents' time. */
function period(r: MegaStatsReport, hours: string): HTMLElement {
  const section = el('section', undefined, 'mega-stats-section');
  const span = { '1': t('nell’ultima ora'), '24': t('nelle ultime 24 ore'), '168': t('negli ultimi 7 giorni') }[hours] ?? '';
  section.append(el('h3', t('Nel periodo') + ' · ' + span));
  const time = r.sessions.filter(s => s.agent !== 'shell').reduce((n, s) => n + s.activeMs, 0);
  section.append(figures(
    figure(t('Richieste agli agenti'), numeric(r.usage.turns, 0), t('messaggi tuoi o di Visual Brain')),
    figure(t('Token elaborati'), tokens(worked(r.usage)), t('{n} riletti dalla cache').replace('{n}', tokens(r.usage.cacheRead + r.usage.cacheWrite))),
    figure(t('Incarichi completati'), numeric(r.totals.completed, 0)),
    figure(t('Tempo degli agenti'), duration(time), t('somma delle sessioni aperte'))));
  const notes = [t('Richieste e token letti dai registri di Claude Code e Codex sul Mac: sono esatti.')];
  if (r.usageMissing) notes.push(r.usageMissing === 1 ? t('1 sessione senza registro: richieste e token non disponibili.') : t('{n} sessioni senza registro: richieste e token non disponibili.').replace('{n}', String(r.usageMissing)));
  section.append(el('p', notes.join(' '), 'mega-stats-meta'));
  return section;
}

/** Per account: the main account of each CLI and every extra account. */
function byAccount(r: MegaStatsReport): HTMLElement | null {
  if (!r.accounts.length) return null;
  const section = el('section', undefined, 'mega-stats-section');
  section.append(el('h3', t('Per account')));
  section.append(table([t('Account'), t('Sessioni'), t('Tempo'), t('Richieste'), t('Token'), t('Cache')],
    r.accounts.map(a => [`${agentName(a.agent)} · ${a.label ?? t('principale')}`, numeric(a.sessions, 0), duration(a.activeMs), numeric(a.usage.turns, 0), tokens(worked(a.usage)), tokens(a.usage.cacheRead + a.usage.cacheWrite)])));
  return section;
}

function tasksLine(g: StatsTeam): string {
  const n = g.tasks;
  return [t('{n} da fare').replace('{n}', String(n.pending)), t('{n} in corso').replace('{n}', String(n.working)), t('{n} bloccati').replace('{n}', String(n.blocked)), t('{n} fatti').replace('{n}', String(n.done))].join(' · ');
}

function sessionsTable(list: StatsSession[]): HTMLTableElement {
  const roles = roleNames();
  return table([t('Sessione'), t('Agente'), t('Modello'), t('Stato'), t('Tempo'), t('Richieste'), t('Token')], list.map(s => {
    const name = el('span', s.label);
    if (s.role) name.append(el('small', roles[s.role] ?? s.role));
    const shell = s.agent === 'shell';
    return [name, s.accountLabel ? `${agentName(s.agent)} · ${s.accountLabel}` : agentName(s.agent), shell ? '—' : modelName(s.usage?.model ?? null),
      sessionState(s), duration(s.activeMs), ...(shell ? ['—', '—'] : usageCells(s.usage))];
  }));
}

/** Progetti e squadre: each project with its squads (tasks by status) and its sessions. */
function breakdown(r: MegaStatsReport): HTMLElement {
  const section = el('section', undefined, 'mega-stats-section');
  section.append(el('h3', t('Progetti e squadre')));
  for (const p of r.projects) {
    const sessions = r.sessions.filter(s => s.projectId === p.id);
    const teams = r.teams.filter(g => g.projectId === p.id);
    if (!sessions.length && !teams.length) continue;
    const used = sessions.reduce((n, s) => n + (s.usage ? worked(s.usage) : 0), 0);
    const project = details(p.name, 'project:' + p.id, [sessionCount(sessions.length), used ? tokens(used) + ' token' : ''].filter(Boolean).join(' · '));
    for (const g of teams) {
      const row = el('div', undefined, 'mega-stats-team');
      const text = el('p');
      text.append(el('b', g.name), el('span', ' · ' + tasksLine(g), 'mega-stats-meta'));
      row.append(text, boardButton(g.nodeId, g.id, t('Apri bacheca')));
      project.append(row);
    }
    if (sessions.length) project.append(sessionsTable(sessions));
    section.append(project);
  }
  if (section.childElementCount === 1) section.append(el('p', t('Nessuna sessione in questo periodo.'), 'mega-stats-meta'));
  return section;
}

function mainBrain(): HTMLElement {
  const section = el('section', undefined, 'mega-stats-section mega-stats-sources');
  section.append(el('h3', t('Main Brain')),
    el('p', t('Il Main Brain è una sessione per nodo che coordina le squadre: legge i loro riepiloghi, scrive agli orchestratori e propone nuove squadre. Lo avvii dal launcher del nodo scegliendo il ruolo Main Brain; le sue proposte arrivano in «Serve te» nella bacheca Lavoro.')));
  return section;
}

function latencyTable(m: StatsMeasures) {
  const row = (label: string, l: StatsLatency) => [label, numeric(l.n), duration(l.p50Ms), duration(l.p95Ms)];
  return table([t('Misura'), t('Campioni'), 'P50', 'P95'], [row(t('Turni agente (hook)'), m.turnLatency), row(t('Richieste HTTP'), m.httpLatency)], t('Tempi osservati'));
}

/** Dettagli tecnici: Visual Brain's own measures, for diagnosing the app rather than reading the work. */
function technical(r: MegaStatsReport): HTMLElement {
  const d = details(t('Dettagli tecnici'), 'technical');
  d.className = 'mega-stats-sources';
  const windowLine = el('p');
  windowLine.append(t('Finestra richiesta'), ' · ', timestamp(r.from), ' – ', timestamp(r.to));
  const coverage = el('p');
  coverage.append(t('Copertura del server'), ' · ', duration(r.observedMs), ' · ', t('Dal'), ' ', timestamp(r.coverageStart));
  d.append(latencyTable(r.totals),
    el('p', [t('Richieste HTTP') + ' · ' + numeric(r.totals.http, 0), t('Errori HTTP') + ' · ' + numeric(r.totals.httpErrors, 0), t('Turni dagli hook') + ' · ' + numeric(r.totals.turns, 0), t('Turni senza coppia') + ' · ' + numeric(r.totals.unpairedTurns, 0), t('HTTP senza attribuzione') + ' · ' + numeric(r.unattributedHttp, 0)].join('   ·   ')),
    windowLine, coverage,
    el('p', t('HTTP: richieste all’API locale di Visual Brain, non al modello. Turni dagli hook e latenze: solo per le sessioni con hook attivi (membri di squadra; Codex con hook approvati in /hooks). P50 e P95 usano il rango più vicino. Conservazione locale: 7 giorni.')));
  return d;
}

/** Mount the Stats workspace and stop requests, events and timers on disposal. */
export function mountMegaStats(root: HTMLElement): () => void {
  const page = el('section', undefined, 'mega-stats');
  const head = el('header', undefined, 'mega-stats-head');
  const meta = el('p', undefined, 'mega-stats-meta');
  const title = el('div');
  title.append(el('h2', t('Stats')), meta);
  const refresh = button(t('Aggiorna'), () => { routing.update(routingScope(), true); void load(); });
  head.append(title, refresh);
  const filters = el('div', undefined, 'mega-stats-filters');
  const hours = filterField(t('Periodo')), project = filterField(t('Progetto')), team = filterField(t('Squadra')), session = filterField(t('Sessione'));
  options(hours.select, [{ value: '1', label: t('Ultima ora') }, { value: '24', label: t('Ultime 24 ore') }, { value: '168', label: t('Ultimi 7 giorni') }], '24');
  const allProjects = { value: '', label: t('Tutti i progetti') };
  const allTeams = { value: '', label: t('Tutte le squadre') };
  const allSessions = { value: '', label: t('Tutte le sessioni') };
  options(project.select, [allProjects], '');
  options(team.select, [allTeams], '');
  options(session.select, [allSessions], '');
  filters.append(hours.label, project.label, team.label, session.label);
  const status = el('p', undefined, 'mega-stats-status');
  status.setAttribute('role', 'status');
  const top = el('div'), quotaRoot = el('div'), report = el('div');
  const routing = mountQuotaPanel(quotaRoot);
  let listedTeams: StatsTeam[] = [];
  const routingScope = () => listedTeams.find(g => g.key === team.select.value) ?? null;
  page.append(head, filters, status, top, quotaRoot, report);
  root.classList.add('mega-stats-view');
  root.replaceChildren(page);
  let request: AbortController | undefined;
  let disposed = false;
  let choices: StatsSession[] = [];
  let debounce = 0;
  let pendingRefresh = false;
  let rendered = false;

  function render(r: MegaStatsReport, projectId: string, teamKey: string, sessionId: string) {
    const expanded = new Set([...report.querySelectorAll<HTMLDetailsElement>('details[open]')].map(d => d.dataset.key));
    if (!rendered) {
      // First view: the projects open when there are few of them, or the one chosen in the filters.
      const selected = r.sessions.find(s => s.id === sessionId), chosen = r.teams.find(g => g.key === teamKey);
      const open = selected?.projectId ?? chosen?.projectId ?? (projectId ? Number(projectId) : null);
      for (const p of r.projects) if (open === p.id || (open === null && r.projects.length <= 3)) expanded.add('project:' + p.id);
    }
    const focusKey = report.contains(document.activeElement) ? (document.activeElement as HTMLElement)?.dataset.focusKey : undefined;
    const projectName = (id: number) => r.projects.find(p => p.id === id)?.name ?? String(id);
    listedTeams = r.teams;
    const teams = r.teams.filter(g => !projectId || String(g.projectId) === projectId);
    options(project.select, [allProjects, ...r.projects.map(p => ({ value: String(p.id), label: p.name }))], projectId);
    options(team.select, [allTeams, ...teams.map(g => ({ value: g.key, label: [!projectId && projectName(g.projectId), g.nodeId !== g.projectId && '#' + g.nodeId, g.name].filter(Boolean).join(' · ') }))], teamKey);
    if (!sessionId) choices = r.sessions;
    options(session.select, [allSessions, ...choices.map(s => ({ value: s.id, label: [!projectId && projectName(s.projectId), s.label].filter(Boolean).join(' · ') }))], sessionId);
    meta.replaceChildren(t('Aggiornato'), ' · ', timestamp(r.updatedAt));
    top.replaceChildren(now(r), period(r, hours.select.value));
    routing.update(routingScope());
    report.replaceChildren(...[byAccount(r), breakdown(r), mainBrain(), technical(r)].filter((x): x is HTMLElement => !!x));
    for (const d of report.querySelectorAll<HTMLDetailsElement>('details')) d.open = expanded.has(d.dataset.key);
    if (focusKey) [...report.querySelectorAll<HTMLElement>('[data-focus-key]')].find(x => x.dataset.focusKey === focusKey)?.focus({ preventScroll: true });
    rendered = true;
  }
  async function load(reset = false) {
    if (disposed) return;
    request?.abort();
    const now = new AbortController();
    request = now;
    if (reset) {
      top.replaceChildren();
      report.replaceChildren();
      meta.replaceChildren();
      rendered = false;
    }
    if (!rendered) status.textContent = t('Caricamento statistiche…');
    report.setAttribute('aria-busy', 'true');
    const p = project.select.value, k = team.select.value, s = session.select.value;
    const params = new URLSearchParams({ hours: hours.select.value });
    if (p) params.set('project', p);
    if (k) params.set('team', k);
    if (s) params.set('session', s);
    try {
      const response = await fetch('/api/mega-stats?' + params, { signal: now.signal });
      if (!response.ok) throw new Error(String(response.status));
      const data: MegaStatsReport = await response.json();
      if (now.signal.aborted) return;
      render(data, p, k, s);
      status.textContent = '';
    } catch {
      if (!now.signal.aborted) status.textContent = t('Statistiche non disponibili. Riprova con Aggiorna.');
    } finally {
      if (request === now) {
        request = undefined;
        report.setAttribute('aria-busy', 'false');
        if (pendingRefresh) { pendingRefresh = false; schedule(); }
      }
    }
  }
  filters.addEventListener('change', e => {
    if (e.target === project.select) options(team.select, [allTeams], '');
    if (e.target === project.select || e.target === team.select) { options(session.select, [allSessions], ''); choices = []; }
    routing.update(routingScope());
    void load(true);
  });
  function schedule() {
    if (disposed || debounce || document.hidden) return;
    debounce = window.setTimeout(() => {
      debounce = 0;
      if (request) pendingRefresh = true;
      else void load();
    }, 400);
  }
  document.addEventListener('visibilitychange', schedule);
  window.addEventListener('vb:stats-changed', schedule);
  const interval = window.setInterval(schedule, 30_000);
  routing.update(null);
  void load();
  return () => {
    disposed = true;
    request?.abort();
    routing.dispose();
    window.clearInterval(interval);
    window.clearTimeout(debounce);
    window.removeEventListener('vb:stats-changed', schedule);
    document.removeEventListener('visibilitychange', schedule);
    page.remove();
    if (!root.querySelector('.mega-stats')) root.classList.remove('mega-stats-view');
  };
}
