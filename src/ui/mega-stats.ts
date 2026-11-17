import type { CoordinationRequest, MegaStatsReport, StatsLatency, StatsMeasures, StatsSession, StatsTeam } from '../shared/mega-stats.ts';
import { getLanguage, t } from './i18n.ts';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function numeric(value: number | null, digits = 1): string {
  return value === null ? t('N/D') : value.toLocaleString(getLanguage(), { maximumFractionDigits: digits });
}

function duration(ms: number | null): string {
  if (ms === null) return t('N/D');
  if (ms < 1000) return numeric(ms) + ' ms';
  if (ms < 60_000) return numeric(ms / 1000) + ' s';
  if (ms < 3_600_000) return numeric(ms / 60_000) + ' min';
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

function metric(label: string, value: number | null, note?: string): HTMLElement {
  const group = el('div');
  const dd = el('dd', numeric(value));
  if (note) dd.append(el('small', note));
  group.append(el('dt', label), dd);
  return group;
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

function table(caption: string, headers: string[], rows: string[][]): HTMLTableElement {
  const tab = el('table', undefined, 'mega-stats-table');
  tab.append(el('caption', caption));
  const head = tab.createTHead().insertRow();
  for (const title of headers) {
    const th = el('th', title);
    th.scope = 'col';
    head.append(th);
  }
  const body = tab.createTBody();
  for (const [label, ...cells] of rows) {
    const tr = body.insertRow();
    const th = el('th', label);
    th.scope = 'row';
    tr.append(th);
    for (const value of cells) tr.append(el('td', value));
  }
  return tab;
}

function fact(list: HTMLDListElement, label: string, value: string | HTMLElement) {
  const dd = el('dd');
  dd.append(value);
  list.append(el('dt', label), dd);
}

function latencyTable(m: StatsMeasures) {
  const row = (label: string, l: StatsLatency) => [label, numeric(l.n), duration(l.p50Ms), duration(l.p95Ms)];
  return table(t('Tempi osservati'), [t('Misura'), t('Campioni'), 'P50', 'P95'], [
    row(t('Turni agente'), m.turnLatency), row(t('Richieste HTTP'), m.httpLatency),
  ]);
}

function summary(m: StatsMeasures): HTMLDListElement {
  const hourly = (n: number | null) => t('{n} / ora osservata').replace('{n}', numeric(n));
  const dl = el('dl', undefined, 'mega-stats-kpis');
  dl.append(metric(t('Turni agente'), m.turns, hourly(m.turnsPerHour)),
    metric(t('Richieste HTTP'), m.http, hourly(m.httpPerHour)),
    metric(t('Incarichi completati'), m.completed, hourly(m.completedPerHour)),
    metric(t('Sessioni in attesa'), m.waiting, t('Adesso')),
    metric(t('Sessioni bloccate'), m.blocked, t('Adesso')));
  return dl;
}

function details(title: string, key: string) {
  const d = el('details');
  const s = el('summary', title);
  d.dataset.key = key;
  s.dataset.focusKey = key;
  d.append(s);
  return d;
}

function boardButton(nodeId: number, teamId: string, label: string) {
  const b = button(label, () => window.dispatchEvent(new CustomEvent('vb:stats-board', { detail: { nodeId, teamId } })), 'btn small');
  b.dataset.focusKey = 'board:' + nodeId + ':' + teamId;
  return b;
}

function sessionCount(n: number): string {
  return n === 1 ? t('1 sessione') : t('{n} sessioni').replace('{n}', numeric(n));
}

function sessionDetail(s: StatsSession) {
  const d = details(s.label, 'session:' + s.id);
  d.addEventListener('toggle', function populate() {
    if (!d.open) return;
    d.removeEventListener('toggle', populate);
    const roles: Record<string, string> = { brain: 'Main Brain', orchestrator: t('Orchestratore'), operator: t('Operatore'), reviewer: t('Revisore') };
    const identity = [s.agent, s.role ? roles[s.role] ?? s.role : '', s.alive ? t('In esecuzione') : t('Terminata')].filter(Boolean);
    const m = s.metrics;
    d.append(el('p', identity.join(' · '), 'mega-stats-meta'), summary(m), latencyTable(m));
    const source = el('p', t('Fonte dei turni') + ' · ' + (s.turnSource || t('Nessuna fonte disponibile')), 'mega-stats-meta');
    if (s.since !== null) source.append(' · ' + t('Dal') + ' ', timestamp(s.since));
    d.append(source, el('p', t('Errori HTTP') + ' · ' + numeric(m.httpErrors) + '   ·   ' + t('Retry osservati') + ' · ' + numeric(m.retries), 'mega-stats-meta'));
  });
  return d;
}

function preferenceLabels() {
  return {
    mode: { suggest: t('Suggerisci incarichi'), assign: t('Assegna incarichi') },
    provider: { balanced: t('Bilanciata'), codex: 'Codex', claude: 'Claude' },
  };
}

function teamControls(team: StatsTeam, edit: (team: StatsTeam) => void) {
  const wrap = el('div', undefined, 'mega-stats-controls');
  const recipient = team.recipient ?? t('Nessun destinatario attivo');
  const policy = team.autoSpawn ? t('Abilitato') : t('Disabilitato');
  wrap.append(el('p', t('Destinatario') + ' · ' + recipient),
    el('p', t('Avvio automatico degli agenti nella squadra') + ' · ' + policy));
  const req = team.requested;
  if (req) {
    const labels = preferenceLabels();
    const requested = el('p', t('Richiesta in attesa') + ' · ' + numeric(req.cadenceMinutes) + ' min · ' + labels.mode[req.mode] + ' · ' + labels.provider[req.provider] + ' · ');
    requested.append(timestamp(req.updatedAt));
    wrap.append(requested);
  } else wrap.append(el('p', t('Nessuna preferenza richiesta')));
  const change = button(t('Richiedi preferenze di coordinamento'), () => edit(team), 'btn small');
  change.dataset.focusKey = 'preferences:' + team.key;
  wrap.append(change);
  return wrap;
}

function preferenceEditor(team: StatsTeam, parent: HTMLElement, onSaved: () => void) {
  const dialog = el('dialog', undefined, 'mega-stats-dialog');
  const title = el('h3', t('Preferenze di coordinamento'));
  title.id = 'mega-stats-preference-title';
  dialog.setAttribute('aria-labelledby', title.id);
  const recipient = team.recipient ?? t('Nessun destinatario attivo');
  const target = el('p', team.name + ' · ' + recipient, 'mega-stats-meta');
  const explanation = el('p', t('La richiesta resta in attesa del motore Mega Brain.'), 'mega-stats-meta');
  const form = el('form');
  const cadenceLabel = el('label', t('Cadenza dei controlli (minuti)'));
  const cadence = el('input');
  cadence.name = 'cadenceMinutes';
  cadence.type = 'number';
  cadence.required = true;
  cadence.min = '1';
  cadence.max = '1440';
  cadence.step = '1';
  cadence.placeholder = '1–1440';
  cadence.value = team.requested ? String(team.requested.cadenceMinutes) : '';
  cadenceLabel.append(cadence);
  const mode = filterField(t('Gestione incarichi')), provider = filterField(t('Preferenza agente'));
  mode.select.name = 'mode';
  provider.select.name = 'provider';
  const labels = preferenceLabels();
  options(mode.select, Object.entries(labels.mode).map(([value, label]) => ({ value, label })), team.requested?.mode ?? 'suggest');
  options(provider.select, Object.entries(labels.provider).map(([value, label]) => ({ value, label })), team.requested?.provider ?? 'balanced');
  const error = el('p', undefined, 'mega-stats-status');
  error.setAttribute('role', 'alert');
  const foot = el('footer');
  const cancel = button(t('Chiudi'), () => dialog.close());
  const save = el('button', t('Salva richiesta'), 'btn primary');
  save.type = 'submit';
  foot.append(cancel, save);
  form.append(cadenceLabel, mode.label, provider.label, error, foot);
  dialog.append(title, target, explanation, form);
  parent.append(dialog);
  dialog.addEventListener('close', () => {
    dialog.remove();
    const origin = [...parent.querySelectorAll<HTMLElement>('[data-focus-key]')].find(x => x.dataset.focusKey === 'preferences:' + team.key);
    (origin ?? parent.querySelector<HTMLButtonElement>('.mega-stats-head button'))?.focus({ preventScroll: true });
  }, { once: true });
  form.onsubmit = async e => {
    e.preventDefault();
    if (save.disabled || !form.reportValidity()) return;
    save.disabled = true;
    error.textContent = '';
    try {
      const res = await fetch('/api/mega-stats/preferences', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeId: team.nodeId, teamId: team.id, cadenceMinutes: cadence.valueAsNumber,
          mode: mode.select.value, provider: provider.select.value }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const request: CoordinationRequest = await res.json();
      if (request.status !== 'pending') throw new Error('Unexpected status');
      if (dialog.open) dialog.close();
      onSaved();
    } catch { error.textContent = t('Impossibile salvare la richiesta. Riprova.'); }
    finally { save.disabled = false; }
  };
  dialog.showModal();
  cadence.focus();
}

function breakdown(r: MegaStatsReport, projectId: string, teamKey: string, sessionId: string, edit: (team: StatsTeam) => void) {
  const section = el('section', undefined, 'mega-stats-section');
  section.append(el('h3', t('Progetti e squadre')));
  const selectedSession = r.sessions.find(s => s.id === sessionId);
  const selectedTeam = r.teams.find(team => team.key === teamKey);
  const projects = r.projects.filter(p => (!projectId || String(p.id) === projectId) &&
    (!selectedTeam || selectedTeam.projectId === p.id) && (!selectedSession || selectedSession.projectId === p.id));
  for (const p of projects) {
    const sessions = r.sessions.filter(s => s.projectId === p.id);
    const project = details(p.name, 'project:' + p.id);
    project.querySelector('summary')!.append(el('small', sessionCount(sessions.length)));
    const teams = r.teams.filter(team => team.projectId === p.id && (!teamKey || team.key === teamKey) &&
      (!selectedSession || selectedSession.teamKey === team.key));
    project.append(boardButton(p.id, 'brain', t('Apri bacheca Main Brain')));
    for (const team of teams) {
      const group = details(team.name, 'team:' + team.key);
      group.className = 'mega-stats-group';
      if (team.id === 'brain') group.append(el('p',t('Il Main Brain riceve messaggi e propone squadre. Gli incarichi si assegnano nelle bacheche delle squadre.'),'mega-stats-meta'));
      group.append(boardButton(team.nodeId, team.id, t(team.id === 'brain' ? 'Apri bacheca Main Brain' : 'Apri e assegna incarichi')), teamControls(team, edit));
      const members = sessions.filter(s => s.teamKey === team.key);
      group.querySelector('summary')!.append(el('small', sessionCount(members.length)));
      if (!members.length) group.append(el('p', t('Nessuna sessione per questi filtri.'), 'mega-stats-meta'));
      for (const s of members) group.append(sessionDetail(s));
      project.append(group);
    }
    const teamKeys = new Set(teams.map(team => team.key));
    for (const s of sessions.filter(s => !s.teamKey || !teamKeys.has(s.teamKey))) project.append(sessionDetail(s));
    section.append(project);
  }
  if (!projects.length) section.append(el('p', t('Nessun progetto collegato per questi filtri.'), 'mega-stats-meta'));
  return section;
}

function sources(r: MegaStatsReport) {
  const d = details(t('Fonti e copertura'), 'sources');
  d.className = 'mega-stats-sources';
  const windowLine = el('p');
  windowLine.append(t('Finestra richiesta'), ' · ', timestamp(r.from), ' – ', timestamp(r.to));
  const coverage = el('p');
  coverage.append(t('Copertura del server'), ' · ', duration(r.observedMs), ' · ', t('Dal'), ' ', timestamp(r.coverageStart));
  d.append(windowLine, coverage,
    el('p', t('I tassi usano le ore osservate dal server. Attese e blocchi contano le sessioni vive nello stato attuale.')),
    el('p', t('P50 e P95 usano il rango più vicino sulle coppie di eventi osservate. N/D indica che manca una misura.')),
    el('p', t('HTTP locali conclusi, attribuiti al nodo o alla sessione. Gli errori hanno stato HTTP ≥ 400. Il traffico del modello e i retry del provider non sono misurati.')),
    el('p', t('Turni: avvii rilevati dagli hook. Latenza: tempo tra invio e fine del turno, per le coppie concluse nel periodo. I turni senza coppia sono esclusi dai percentili.')),
    el('p', t('Codex richiede hook abilitati e approvati in /hooks. Le sessioni precedenti e gli altri CLI possono avere copertura parziale.')),
    el('p', t('Incarichi: prima transizione osservata a completato, attribuita all’assegnatario. Conservazione locale: 7 giorni.')),
    el('p', t('Turni senza coppia') + ' · ' + numeric(r.totals.unpairedTurns ?? null)),
    el('p', t('HTTP senza attribuzione, globale') + ' · ' + numeric(r.unattributedHttp)));
  return d;
}

function coordination() {
  const d = details(t('Coordinamento Mega Brain'), 'coordination');
  d.className = 'mega-stats-sources';
  d.append(el('p', t('Motore in attesa. La cadenza dei controlli, la modalità suggerimento o assegnazione e la preferenza Codex, Claude o bilanciata saranno applicabili solo con il motore attivo.')),
    el('p', t('Per aprire o assegnare un incarico, scegli la bacheca nel dettaglio del progetto o della squadra.')));
  return d;
}

/** Mount the Stats workspace and stop requests, events and timers on disposal. */
export function mountMegaStats(root: HTMLElement): () => void {
  const page = el('section', undefined, 'mega-stats');
  const head = el('header', undefined, 'mega-stats-head');
  const meta = el('p', undefined, 'mega-stats-meta');
  const title = el('div');
  title.append(el('h2', t('Stats del Mega Brain')), meta);
  const refresh = button(t('Aggiorna statistiche'), () => { void load(); });
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
  const report = el('div');
  page.append(head, filters, status, report);
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
    const selected = r.sessions.find(s => s.id === sessionId);
    if (!rendered) {
      const team = r.teams.find(t => t.key === teamKey);
      const project = selected?.projectId ?? team?.projectId ?? projectId;
      if (project) expanded.add('project:' + project);
      if (selected?.teamKey || teamKey) expanded.add('team:' + (selected?.teamKey || teamKey));
      if (selected) expanded.add('session:' + selected.id);
    }
    const focusKey = report.contains(document.activeElement) ? (document.activeElement as HTMLElement)?.dataset.focusKey : undefined;
    const projects = r.projects.map(p => ({ value: String(p.id), label: p.name }));
    const teams = r.teams.filter(t => !projectId || String(t.projectId) === projectId);
    options(project.select, [allProjects, ...projects], projectId);
    options(team.select, [allTeams, ...teams.map(t => ({ value: t.key, label: t.name }))], teamKey);
    if (!sessionId) choices = r.sessions;
    options(session.select, [allSessions, ...choices.map(s => ({ value: s.id, label: s.label }))], sessionId);
    meta.replaceChildren(t('Ultimo aggiornamento'), ' · ', timestamp(r.updatedAt), '   ·   ', t('Copertura del server'), ' ', duration(r.observedMs));
    const metrics = summary(r.totals);
    const observations = el('section', undefined, 'mega-stats-section');
    observations.append(latencyTable(r.totals), el('p', t('Errori HTTP') + ' · ' + numeric(r.totals.httpErrors) + '   ·   ' + t('Retry osservati') + ' · ' + numeric(r.totals.retries), 'mega-stats-meta'));
    const known = r.sessions.filter(s => s.turnSource !== null).length;
    const turnCoverage = el('p', t('Sessioni con fonte dei turni') + ' · ' + numeric(known) + '   ·   ' +
      t('Sessioni senza fonte') + ' · ' + numeric(r.sessions.length - known), 'mega-stats-meta mega-stats-turn-coverage');
    const drilldown = breakdown(r, projectId, teamKey, sessionId, team => preferenceEditor(team, page, () => { void load(); }));
    const attention = el('section', undefined, 'mega-stats-section');
    const stalledTeams = teams.filter(g => g.blockedTasks && (!teamKey || g.key === teamKey) &&
      (!selected || selected.teamKey === g.key));
    const waiting = r.sessions.filter(s => s.metrics.blocked || s.metrics.waiting);
    if (stalledTeams.length || waiting.length) {
      attention.append(el('h3',t('Dove intervenire')));
      for (const g of stalledTeams) attention.append(boardButton(g.nodeId,g.id,
        [r.projects.find(p => p.id === g.projectId)?.name,g.name,t('Incarichi bloccati') + ' · ' + g.blockedTasks].filter(Boolean).join(' / ')));
      for (const s of waiting) {
        const team = r.teams.find(g => g.key === s.teamKey);
        const target = [r.projects.find(p => p.id===s.projectId)?.name,s.label,t(s.metrics.blocked ? 'Bloccato' : 'In attesa')].filter(Boolean).join(' / ');
        attention.append(team ? boardButton(s.nodeId,team.id,target) : el('p',target));
      }
    }
    report.replaceChildren(metrics, turnCoverage, attention, observations, drilldown, sources(r), coordination());
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
      if (!now.signal.aborted) status.textContent = t('Statistiche non disponibili. Riprova con Aggiorna statistiche.');
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
  void load();
  return () => {
    disposed = true;
    request?.abort();
    window.clearInterval(interval);
    window.clearTimeout(debounce);
    window.removeEventListener('vb:stats-changed', schedule);
    document.removeEventListener('visibilitychange', schedule);
    page.remove();
    if (!root.querySelector('.mega-stats')) root.classList.remove('mega-stats-view');
  };
}
