// Stats: what the agents are doing now and what they did in the period, in four tabs.
// - Panoramica: what waits for the person, the agents now, the period in figures, where the work went.
// - Qualità: how the squads' tasks went (time to done, rework, blocks), how long the agents waited for the person, hints.
// - Sessioni: each project with its squads (tasks by status) and its sessions.
// - Account: usage per account of Claude Code and Codex, and the providers' limits.
// - Dettagli tecnici: Visual Brain's own measures (local API traffic, hook-reported turns, latencies).
// Turns, tokens and models come from the CLIs' own records (exact, not estimated); tasks from the squads' boards.
import type { MegaStatsReport, StatsAccount, StatsLatency, StatsMeasures, StatsQuality, StatsQualityRow, StatsSession, StatsTeam, StatsTimeline, StatsUsage } from '../shared/mega-stats.ts';
import { getLanguage, t } from './i18n.ts';
import { mountQuotaPanel } from './quota-panel.ts';
import { columnChart, orderedBars, type ColumnSeries } from './stats-charts.ts';

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

function timestamp(value: number, timeOnly = false): HTMLTimeElement {
  const date = new Date(value);
  const time = el('time', date.toLocaleString(getLanguage(), timeOnly ? { timeStyle: 'short' } : { dateStyle: 'short', timeStyle: 'short' }));
  time.dateTime = date.toISOString();
  return time;
}

function button(label: string, click: () => void, className = 'btn'): HTMLButtonElement {
  const b = el('button', label, className);
  b.type = 'button';
  b.onclick = click;
  return b;
}

function section(title: string, note?: string): HTMLElement {
  const box = el('section', undefined, 'mega-stats-section');
  const head = el('header', undefined, 'mega-stats-section-head');
  head.append(el('h3', title));
  if (note) head.append(el('p', note, 'mega-stats-meta'));
  box.append(head);
  return box;
}

/** A figure card: label, big value, a short note; `tone` colours the value when it asks for attention. */
function card(label: string, value: string, note?: string, tone?: 'active' | 'attention' | 'blocked'): HTMLElement {
  const box = el('div', undefined, 'mega-stats-card');
  if (tone) box.dataset.tone = tone;
  box.append(el('span', label, 'mega-stats-card-label'), el('strong', value, 'mega-stats-card-value'));
  if (note) box.append(el('span', note, 'mega-stats-card-note'));
  return box;
}

function cards(...items: (HTMLElement | null)[]): HTMLElement {
  const grid = el('div', undefined, 'mega-stats-cards');
  grid.append(...items.filter((x): x is HTMLElement => !!x));
  return grid;
}

/** A horizontal bar of parts (each with its share); the legend repeats the values. */
function stackBar(parts: { label: string; value: number; tone: string; text?: string }[]): HTMLElement {
  const wrap = el('div', undefined, 'mega-stats-stack');
  const bar = el('div', undefined, 'mega-stats-bar');
  bar.setAttribute('role', 'img');
  const total = parts.reduce((n, p) => n + p.value, 0);
  bar.setAttribute('aria-label', parts.map(p => `${p.label} ${p.text ?? numeric(p.value, 0)}`).join(', '));
  for (const p of parts) if (p.value > 0 && total > 0) {
    const seg = el('span');
    seg.dataset.tone = p.tone;
    seg.style.flexGrow = String(p.value / total);
    bar.append(seg);
  }
  const legend = el('ul', undefined, 'mega-stats-legend');
  legend.setAttribute('aria-hidden', 'true');
  for (const p of parts) {
    const li = el('li');
    const dot = el('i');
    dot.dataset.tone = p.tone;
    li.append(dot, `${p.label} `, el('b', p.text ?? numeric(p.value, 0)));
    legend.append(li);
  }
  wrap.append(bar, legend);
  return wrap;
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

/** A table whose first column names the row; columns listed in `figures` hold numbers and are right-aligned. */
function table(headers: string[], rows: (string | HTMLElement)[][], figures: number[] = [], caption?: string): HTMLElement {
  const wrap = el('div', undefined, 'mega-stats-table-wrap');
  const tab = el('table', undefined, 'mega-stats-table');
  if (caption) tab.append(el('caption', caption));
  const head = tab.createTHead().insertRow();
  headers.forEach((title, i) => {
    const th = el('th', title);
    th.scope = 'col';
    if (figures.includes(i)) th.className = 'num';
    head.append(th);
  });
  const body = tab.createTBody();
  for (const [label, ...cells] of rows) {
    const tr = body.insertRow();
    const th = el('th');
    th.scope = 'row';
    th.append(label);
    tr.append(th);
    cells.forEach((value, i) => { const td = el('td'); if (figures.includes(i + 1)) td.className = 'num'; td.append(value); tr.append(td); });
  }
  wrap.append(tab);
  return wrap;
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
const cached = (u: StatsUsage) => u.cacheRead + u.cacheWrite;

type Tone = 'active' | 'attention' | 'blocked' | 'idle' | 'ended';
function sessionState(s: StatsSession): { text: string; tone: Tone } {
  if (!s.alive) return { text: t('Terminata'), tone: 'ended' };
  if (s.state === 'blocked') return { text: t('Bloccata'), tone: 'blocked' };
  if (s.attention) return { text: t('Aspetta te'), tone: 'attention' };
  if (s.state === 'working') return { text: t('Al lavoro'), tone: 'active' };
  if (s.state === 'idle') return { text: t('Libera'), tone: 'idle' };
  return { text: t('In esecuzione'), tone: 'idle' };
}

function pill(text: string, tone: string): HTMLElement {
  const p = el('span', undefined, 'pill mega-stats-pill');
  p.dataset.tone = tone;
  p.append(el('i'), text);
  return p;
}

const roleNames = (): Record<string, string> => ({ brain: 'Main Brain', orchestrator: t('Orchestratore'), operator: t('Operatore'), reviewer: t('Revisore') });

function boardButton(nodeId: number, teamId: string, label: string, key: string) {
  const b = button(label, () => window.dispatchEvent(new CustomEvent('vb:stats-board', { detail: { nodeId, teamId } })), 'btn small');
  b.dataset.focusKey = key;
  return b;
}

function sessionCount(n: number): string {
  return n === 1 ? t('1 sessione') : t('{n} sessioni').replace('{n}', numeric(n));
}

function periodName(hours: string): string {
  return { '1': t('Ultima ora'), '24': t('Ultime 24 ore'), '168': t('Ultimi 7 giorni') }[hours] ?? '';
}

/** «Serve te»: sessions waiting for the person and blocked boards or sessions, each with the way to it. Calm when none. */
function needsYou(r: MegaStatsReport): HTMLElement {
  const box = el('section', undefined, 'mega-stats-attention');
  const waiting = r.sessions.filter(s => s.alive && s.attention), blocked = r.sessions.filter(s => s.alive && s.state === 'blocked' && !s.attention);
  const project = (id: number) => r.projects.find(p => p.id === id)?.name;
  const items: HTMLElement[] = [];
  const item = (tone: string, title: string, detail: string, action: HTMLElement | null) => {
    const li = el('li');
    const text = el('span', undefined, 'mega-stats-attention-text');
    text.append(pill(title, tone), el('span', detail, 'mega-stats-meta'));
    li.append(text);
    if (action) li.append(action);
    items.push(li);
  };
  const boardOf = (s: StatsSession) => {
    const team = r.teams.find(g => g.key === s.teamKey);
    return team ? boardButton(s.nodeId, team.id, t('Apri bacheca'), 'you:session:' + s.id) : null;
  };
  for (const s of waiting) item('attention', s.label, [project(s.projectId), t('aspetta un permesso o una risposta nel terminale')].filter(Boolean).join(' · '), boardOf(s));
  for (const g of r.teams.filter(g => g.tasks.blocked)) {
    item('blocked', g.name, [project(g.projectId), g.tasks.blocked === 1 ? t('1 incarico bloccato') : t('{n} incarichi bloccati').replace('{n}', String(g.tasks.blocked))].filter(Boolean).join(' · '), boardButton(g.nodeId, g.id, t('Apri bacheca'), 'you:team:' + g.key));
  }
  for (const s of blocked) item('blocked', s.label, [project(s.projectId), t('sessione bloccata')].filter(Boolean).join(' · '), boardOf(s));
  box.dataset.tone = items.length ? 'attention' : 'calm';
  const head = el('header');
  head.append(el('h3', items.length ? t('Serve te') + ' · ' + items.length : t('Nessuno ti aspetta')));
  if (!items.length) head.append(el('p', t('Nessun permesso, domanda o incarico bloccato.'), 'mega-stats-meta'));
  box.append(head);
  if (items.length) { const list = el('ul'); list.append(...items); box.append(list); }
  return box;
}

/** Adesso: the agents open, working, waiting and blocked. */
function nowCards(r: MegaStatsReport): HTMLElement {
  const box = section(t('Adesso'));
  const agents = r.sessions.filter(s => s.alive && s.agent !== 'shell');
  const working = agents.filter(s => s.state === 'working').length;
  const waiting = r.sessions.filter(s => s.alive && s.attention).length, blocked = r.sessions.filter(s => s.alive && s.state === 'blocked').length;
  const blockedTasks = r.teams.reduce((n, g) => n + g.tasks.blocked, 0);
  box.append(cards(
    card(t('Agenti aperti'), numeric(agents.length, 0), agents.length ? t('{n} al lavoro').replace('{n}', numeric(working, 0)) : t('nessun agente aperto'), working ? 'active' : undefined),
    card(t('Aspettano te'), numeric(waiting, 0), t('permessi o domande'), waiting ? 'attention' : undefined),
    card(t('Sessioni bloccate'), numeric(blocked, 0), undefined, blocked ? 'blocked' : undefined),
    card(t('Incarichi bloccati'), numeric(blockedTasks, 0), t('nelle bacheche'), blockedTasks ? 'blocked' : undefined)));
  return box;
}

/** The period: requests, tokens (read, written, cache), completed tasks and the agents' time. */
function periodCards(r: MegaStatsReport, hours: string): HTMLElement {
  const box = section(periodName(hours), t('Richieste e token letti dai registri di Claude Code e Codex sul Mac: sono esatti.'));
  const time = r.sessions.filter(s => s.agent !== 'shell').reduce((n, s) => n + s.activeMs, 0);
  const tokenCard = card(t('Token elaborati'), tokens(worked(r.usage)), t('{n} riletti dalla cache').replace('{n}', tokens(cached(r.usage))));
  tokenCard.classList.add('wide');
  if (worked(r.usage)) tokenCard.append(stackBar([
    { label: t('letti'), value: r.usage.input, tone: 'input', text: tokens(r.usage.input) },
    { label: t('scritti'), value: r.usage.output, tone: 'output', text: tokens(r.usage.output) }]));
  box.append(cards(
    tokenCard,
    card(t('Richieste agli agenti'), numeric(r.usage.turns, 0), t('messaggi tuoi o di Visual Brain')),
    card(t('Incarichi completati'), numeric(r.totals.completed, 0)),
    card(t('Tempo degli agenti'), duration(time), t('somma delle sessioni aperte'))));
  if (r.usageMissing) box.append(el('p', r.usageMissing === 1 ? t('1 sessione senza registro: richieste e token non disponibili.') : t('{n} sessioni senza registro: richieste e token non disponibili.').replace('{n}', String(r.usageMissing)), 'mega-stats-meta'));
  return box;
}

/** Ranked bars: one line per item, its length relative to the largest. */
function ranking(rows: { label: string; sub?: string; value: number; text: string }[]): HTMLElement {
  const list = el('ul', undefined, 'mega-stats-ranking');
  const max = Math.max(1, ...rows.map(x => x.value));
  for (const x of rows) {
    const li = el('li');
    const name = el('span', undefined, 'mega-stats-ranking-name');
    name.append(el('b', x.label));
    if (x.sub) name.append(el('small', x.sub));
    const track = el('span', undefined, 'mega-stats-track');
    track.setAttribute('aria-hidden', 'true');
    const fill = el('i');
    fill.style.width = `${x.value ? Math.max(2, (x.value / max) * 100) : 0}%`;
    track.append(fill);
    li.append(name, track, el('span', x.text, 'mega-stats-ranking-value'));
    list.append(li);
  }
  return list;
}

/** Where the tokens went: per project, largest first. */
function byProject(r: MegaStatsReport): HTMLElement | null {
  const rows = r.projects.flatMap(p => {
    const sessions = r.sessions.filter(s => s.projectId === p.id);
    if (!sessions.length) return [];
    const used = sessions.reduce((n, s) => n + (s.usage ? worked(s.usage) : 0), 0);
    return [{ label: p.name, sub: sessionCount(sessions.length), value: used, text: tokens(used) }];
  }).sort((a, b) => b.value - a.value);
  if (!rows.length) return null;
  const box = section(t('Token per progetto'));
  box.append(ranking(rows));
  return box;
}

/** Andamento: tokens per account and requests over the period, interval by interval. */
function trend(r: MegaStatsReport): HTMLElement {
  const box = section(t('Andamento'), t('Passa sopra una colonna (o usa le frecce) per i valori di quell’intervallo.'));
  // At most four colours: past four accounts the smallest ones fold into «Altri».
  const lines = r.timeline.tokens.map(s => ({ key: s.key, label: `${agentName(s.agent)} · ${s.label ?? t('Principale')}`, values: s.values }));
  const series: ColumnSeries[] = lines.length > 4 ? [...lines.slice(0, 3), { key: 'other', label: t('Altri'), values: lines.slice(3).reduce((acc, s) => acc.map((v, i) => v + (s.values[i] ?? 0)), lines[3].values.map(() => 0)) }] : lines;
  const grid = el('div', undefined, 'mega-stats-charts');
  grid.append(
    columnChart({ title: t('Token per account'), note: t('letti e scritti, cache esclusa'), edges: r.timeline.edges, series, empty: t('Nessun token registrato nel periodo.') }),
    columnChart({ title: t('Richieste agli agenti'), note: t('messaggi tuoi o di Visual Brain'), edges: r.timeline.edges, series: [{ key: 'requests', label: t('Richieste'), values: r.timeline.requests }], format: n => numeric(n, 0), empty: t('Nessuna richiesta nel periodo.') }));
  box.append(grid);
  return box;
}

function overview(r: MegaStatsReport, hours: string): HTMLElement[] {
  return [needsYou(r), nowCards(r), periodCards(r, hours), trend(r), byProject(r)].filter((x): x is HTMLElement => !!x);
}

/** A squad: its name, tasks by status as a bar, and its board. */
function squad(g: StatsTeam): HTMLElement {
  const row = el('div', undefined, 'mega-stats-team');
  const head = el('div', undefined, 'mega-stats-team-head');
  const n = g.tasks, total = n.pending + n.working + n.blocked + n.done;
  const title = el('span');
  title.append(el('b', g.name), el('small', total ? t('{n} fatti').replace('{n}', String(n.done)) + ' / ' + total : t('Nessun incarico')));
  head.append(title, boardButton(g.nodeId, g.id, t('Apri bacheca'), 'team:' + g.key));
  row.append(head);
  if (total) row.append(stackBar([
    { label: t('Fatti'), value: n.done, tone: 'done' },
    { label: t('In corso'), value: n.working, tone: 'active' },
    { label: t('Da fare'), value: n.pending, tone: 'idle' },
    { label: t('Bloccati'), value: n.blocked, tone: 'blocked' }]));
  return row;
}

function sessionsTable(list: StatsSession[]): HTMLElement {
  const roles = roleNames();
  return table([t('Sessione'), t('Account'), t('Modello'), t('Stato'), t('Tempo'), t('Richieste'), t('Token')], list.map(s => {
    const name = el('span', undefined, 'mega-stats-two-lines');
    name.append(el('b', s.label));
    if (s.role) name.append(el('small', roles[s.role] ?? s.role));
    const shell = s.agent === 'shell';
    const who = el('span', undefined, 'mega-stats-two-lines');
    who.append(el('span', agentName(s.agent)));
    if (s.accountLabel) who.append(el('small', s.accountLabel));
    const state = sessionState(s);
    return [name, who, shell ? '—' : modelName(s.usage?.model ?? null), pill(state.text, state.tone), duration(s.activeMs),
      shell || !s.usage ? '—' : numeric(s.usage.turns, 0), shell || !s.usage ? '—' : tokens(worked(s.usage))];
  }), [4, 5, 6]);
}

/** Sessioni: each project as a panel with its squads and its sessions. */
function sessionsTab(r: MegaStatsReport): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const p of r.projects) {
    const sessions = r.sessions.filter(s => s.projectId === p.id);
    const teams = r.teams.filter(g => g.projectId === p.id);
    if (!sessions.length && !teams.length) continue;
    const used = sessions.reduce((n, s) => n + (s.usage ? worked(s.usage) : 0), 0);
    const box = el('section', undefined, 'mega-stats-panel');
    const head = el('header', undefined, 'mega-stats-panel-head');
    head.append(el('h3', p.name), el('span', [sessionCount(sessions.length), used ? tokens(used) + ' token' : ''].filter(Boolean).join(' · '), 'mega-stats-meta'));
    box.append(head);
    if (teams.length) { const squads = el('div', undefined, 'mega-stats-teams'); squads.append(...teams.map(squad)); box.append(squads); }
    if (sessions.length) box.append(sessionsTable(sessions));
    out.push(box);
  }
  if (!out.length) out.push(el('p', t('Nessuna sessione in questo periodo.'), 'mega-stats-empty'));
  return out;
}

/** One account of Claude Code or Codex, with its share of the tokens. */
function accountCard(a: StatsAccount, total: number): HTMLElement {
  const box = el('article', undefined, 'mega-stats-account');
  const head = el('header');
  const name = el('span', undefined, 'mega-stats-two-lines');
  name.append(el('small', agentName(a.agent)), el('b', a.label ?? t('Principale')));
  const share = total ? Math.round((worked(a.usage) / total) * 100) : 0;
  const shareText = el('span', share + '%', 'mega-stats-account-share');
  shareText.title = t('Parte dei token del periodo');
  head.append(name, shareText);
  const track = el('span', undefined, 'mega-stats-track');
  track.setAttribute('aria-hidden', 'true');
  const fill = el('i');
  fill.style.width = share + '%';
  track.append(fill);
  const facts = el('dl');
  const fact = (label: string, value: string) => { const g = el('div'); g.append(el('dt', label), el('dd', value)); facts.append(g); };
  fact(t('Token'), tokens(worked(a.usage)));
  fact(t('Richieste'), numeric(a.usage.turns, 0));
  fact(t('Sessioni'), numeric(a.sessions, 0));
  fact(t('Tempo'), duration(a.activeMs));
  fact(t('Cache'), tokens(cached(a.usage)));
  box.append(head, track, facts);
  return box;
}

function accountsTab(r: MegaStatsReport): HTMLElement {
  const box = section(t('Uso per account'), t('La percentuale è la parte dei token del periodo usata da ogni account. I nomi si cambiano in Impostazioni → Agenti → Account.'));
  if (!r.accounts.length) { box.append(el('p', t('Nessuna sessione di Claude Code o Codex nel periodo.'), 'mega-stats-empty')); return box; }
  const total = r.accounts.reduce((n, a) => n + worked(a.usage), 0);
  const grid = el('div', undefined, 'mega-stats-accounts');
  grid.append(...[...r.accounts].sort((a, b) => worked(b.usage) - worked(a.usage)).map(a => accountCard(a, total)));
  box.append(grid);
  return box;
}

function latencyTable(m: StatsMeasures) {
  const row = (label: string, l: StatsLatency) => [label, numeric(l.n), duration(l.p50Ms), duration(l.p95Ms)];
  return table([t('Misura'), t('Campioni'), 'P50', 'P95'], [row(t('Turni agente (hook)'), m.turnLatency), row(t('Richieste HTTP'), m.httpLatency)], [1, 2, 3], t('Tempi osservati'));
}

/** Dettagli tecnici: Visual Brain's own measures, for diagnosing the app rather than reading the work. */
function technicalTab(r: MegaStatsReport): HTMLElement[] {
  const box = section(t('Dettagli tecnici'), t('Misure di Visual Brain stesso: servono a diagnosticare l’app, non a leggere il lavoro degli agenti.'));
  box.append(cards(
    // Some failed calls are normal (a terminal already closed, something no longer there): colour only above 5%.
    card(t('Richieste HTTP dei nodi'), numeric(r.totals.http, 0), t('{n} errori').replace('{n}', numeric(r.totals.httpErrors, 0)) + (r.totals.http ? ` (${Math.round(r.totals.httpErrors / r.totals.http * 1000) / 10}%)` : ''), r.totals.http && r.totals.httpErrors / r.totals.http > .05 ? 'blocked' : undefined),
    card(t('Richieste generali dell’app'), numeric(r.unattributedHttp, 0), t('l’interfaccia che si aggiorna, senza un nodo')),
    card(t('Turni dagli hook'), numeric(r.totals.turns, 0), t('{n} interrotti o incompleti').replace('{n}', numeric(r.totals.unpairedTurns, 0))),
    card(t('App accesa'), duration(r.observedMs), t('nel periodo scelto'))));
  box.append(latencyTable(r.totals));
  if (r.quality.failures.length) box.append(table([t('Chiamata non riuscita'), t('Codice'), t('Volte')],
    r.quality.failures.map(f => [el('code', f.route), String(f.status), numeric(f.n, 0)]), [1, 2], t('Errori per funzione')));
  const windowLine = el('p', undefined, 'mega-stats-meta');
  windowLine.append(t('Finestra richiesta'), ' · ', timestamp(r.from), ' – ', timestamp(r.to), ' · ', t('Copertura del server'), ' · ', t('Dal'), ' ', timestamp(r.coverageStart));
  box.append(windowLine, el('p', t('HTTP: richieste all’API locale di Visual Brain, non al modello. Turni dagli hook e latenze: solo per le sessioni con hook attivi (membri di squadra; Codex con hook approvati in /hooks). P50 e P95 usano il rango più vicino. Conservazione locale: 7 giorni.'), 'mega-stats-meta'));
  return [box];
}

const percent = (part: number, whole: number) => whole ? Math.round(part / whole * 100) + '%' : '—';

function workerName(w: StatsQualityRow): HTMLElement {
  const name = el('span', undefined, 'mega-stats-two-lines');
  name.append(el('b', [agentName(w.agent ?? ''), w.model ? modelName(w.model) : ''].filter(Boolean).join(' · ')));
  if (w.role) name.append(el('small', roleNames()[w.role] ?? w.role));
  return name;
}

/**
 * Hints from fixed rules on the figures above (no model): where the person slows the agents, which line redoes work,
 * which one closes the same work with fewer tokens, how often tasks get stuck.
 */
export function hints(q: StatsQuality): string[] {
  const out: string[] = [];
  const p50 = q.waits.response.p50Ms;
  if (q.waits.n >= 3 && p50 !== null && p50 >= 180_000)
    out.push(t('Gli agenti ti aspettano di solito {d} prima di una risposta: in quel tempo sono fermi. Con la consegna automatica e i permessi per i comandi sicuri lavorano senza fermarsi.').replace('{d}', duration(p50)));
  if (q.waits.n >= 5 && q.waits.permission / q.waits.n >= .6)
    out.push(t('{p} delle attese sono permessi: autorizzare in anticipo i comandi che approvi sempre toglie la maggior parte delle interruzioni.').replace('{p}', percent(q.waits.permission, q.waits.n)));
  for (const w of q.workers) if (w.role !== 'reviewer' && w.completed >= 3 && w.reopened / w.completed >= .3)
    out.push(t('{w} come {r}: {p} degli incarichi chiusi sono stati riaperti. Prova un modello più forte per questo ruolo o un revisore nella squadra.')
      .replace('{w}', [agentName(w.agent ?? ''), w.model ? modelName(w.model) : ''].filter(Boolean).join(' · ')).replace('{r}', (roleNames()[w.role ?? ''] ?? w.role ?? '').toLowerCase()).replace('{p}', percent(w.reopened, w.completed)));
  const byRole = new Map<string, StatsQualityRow[]>();
  for (const w of q.workers) if (w.role && w.completed >= 3 && w.tokensPerTask) byRole.set(w.role, [...(byRole.get(w.role) ?? []), w]);
  for (const [role, list] of byRole) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => a.tokensPerTask! - b.tokensPerTask!), cheap = sorted[0], dear = sorted.at(-1)!;
    if (dear.tokensPerTask! >= 2 * cheap.tokensPerTask! && cheap.reopened / cheap.completed <= dear.reopened / dear.completed + .1)
      out.push(t('Come {r}, {a} chiude un incarico con {x} token, {b} con {y}, e la rilavorazione è simile: per questo ruolo conviene il primo.')
        .replace('{r}', (roleNames()[role] ?? role).toLowerCase())
        .replace('{a}', [agentName(cheap.agent ?? ''), modelName(cheap.model)].join(' · ')).replace('{x}', tokens(cheap.tokensPerTask!))
        .replace('{b}', [agentName(dear.agent ?? ''), modelName(dear.model)].join(' · ')).replace('{y}', tokens(dear.tokensPerTask!)));
  }
  if (q.created >= 4 && q.blocked / q.created >= .25)
    out.push(t('{p} degli incarichi si blocca: incarichi più piccoli, con i file da toccare indicati, si bloccano meno.').replace('{p}', percent(q.blocked, q.created)));
  return out;
}

/** Qualità: tasks, waits for the person, who closes the work and at what cost, squads, hints. */
function qualityTab(q: StatsQuality, timeline: StatsTimeline): HTMLElement[] {
  if (q.since === null && !q.waits.n && !q.waits.open) {
    return [el('p', t('Le misure di qualità partono da questa versione: compaiono qui appena le squadre creano e chiudono incarichi.'), 'mega-stats-empty')];
  }
  const out: HTMLElement[] = [];
  const work = section(t('Incarichi delle squadre'), q.since ? t('Registrati dal {d}.').replace('{d}', new Date(q.since).toLocaleString(getLanguage(), { dateStyle: 'short', timeStyle: 'short' })) : undefined);
  work.append(cards(
    card(t('Incarichi chiusi'), numeric(q.completed, 0), t('{n} creati nel periodo').replace('{n}', numeric(q.created, 0))),
    card(t('Tempo fino a «fatto»'), duration(q.cycle.p50Ms), q.cycle.p95Ms !== null ? t('metà entro questo tempo, il 95% entro {d}').replace('{d}', duration(q.cycle.p95Ms)) : t('dalla creazione alla chiusura')),
    card(t('Rilavorazione'), percent(q.reopened, q.completed), t('{n} riaperti dopo «fatto»').replace('{n}', numeric(q.reopened, 0)), q.completed >= 3 && q.reopened / q.completed >= .3 ? 'attention' : undefined),
    card(t('Tempo bloccato'), duration(q.blockedMs), t('{n} blocchi · {m} riassegnati').replace('{n}', numeric(q.blocked, 0)).replace('{m}', numeric(q.reassigned, 0)), q.blocked ? 'blocked' : undefined)));
  work.append(columnChart({ title: t('Incarichi chiusi e riaperti'), note: t('per intervallo del periodo'), edges: timeline.edges, format: n => numeric(n, 0), additive: false, empty: t('Nessun incarico chiuso nel periodo.'),
    series: [{ key: 'done', label: t('Chiusi'), values: timeline.completed }, { key: 'reopened', label: t('Riaperti'), values: timeline.reopened }] }));
  out.push(work);

  const you = section(t('Quanto aspettano te'), t('Permessi e domande nei terminali, da quando compaiono a quando rispondi (precisione di qualche secondo).'));
  const w = q.waits;
  you.append(cards(
    card(t('Richieste a te'), numeric(w.n, 0), t('{p} permessi · {q} domande').replace('{p}', numeric(w.permission, 0)).replace('{q}', numeric(w.input, 0))),
    card(t('Risposta tipica'), duration(w.response.p50Ms), t('metà delle volte entro questo tempo'), w.response.p50Ms !== null && w.response.p50Ms >= 180_000 ? 'attention' : undefined),
    card(t('Risposte più lente'), duration(w.response.p95Ms), t('il 5% delle volte oltre questo tempo')),
    card(t('Aspettano adesso'), numeric(w.open, 0), undefined, w.open ? 'attention' : undefined)));
  if (w.n) {
    const spread = el('div', undefined, 'mega-stats-chart-card');
    spread.append(el('h4', t('Dopo quanto rispondi')), orderedBars([t('meno di 1 min'), t('1–5 min'), t('5–15 min'), t('15–60 min'), t('oltre un’ora')].map((label, i) => ({ label, value: w.histogram[i] ?? 0 })),
      n => n === 1 ? t('1 volta') : t('{n} volte').replace('{n}', numeric(n, 0))));
    you.append(spread);
  }
  out.push(you);

  const tips = hints(q);
  const advice = section(t('Cosa migliorare'), t('Suggerimenti da regole fisse sui numeri di questa pagina, non da un modello.'));
  if (tips.length) { const list = el('ul', undefined, 'mega-stats-hints'); for (const tip of tips) list.append(el('li', tip)); advice.append(list); }
  else advice.append(el('p', q.completed >= 3 || w.n >= 3 ? t('Nessun punto debole evidente nel periodo.') : t('Servono qualche incarico chiuso e qualche risposta tua per dare suggerimenti.'), 'mega-stats-meta'));
  out.push(advice);

  if (q.workers.length) {
    const who = section(t('Chi chiude gli incarichi'), t('Per agente, modello e ruolo. Token per incarico: i token delle sue sessioni nel periodo divisi per gli incarichi che ha chiuso.'));
    who.append(table([t('Agente e ruolo'), t('Chiusi'), t('Riaperti'), t('Bloccati'), t('Tempo tipico'), t('Token per incarico')],
      q.workers.map(x => [workerName(x), numeric(x.completed, 0), x.reopened ? `${x.reopened} (${percent(x.reopened, x.completed)})` : '0', numeric(x.blocked, 0), duration(x.cycle.p50Ms), x.tokensPerTask === null ? '—' : tokens(x.tokensPerTask)]), [1, 2, 3, 4, 5]));
    out.push(who);
  }
  if (q.teams.length) {
    const squads = section(t('Per squadra'));
    squads.append(table([t('Squadra'), t('Creati'), t('Chiusi'), t('Riaperti'), t('Bloccati'), t('Tempo tipico')],
      q.teams.map(x => [x.label, numeric(x.created, 0), numeric(x.completed, 0), numeric(x.reopened, 0), numeric(x.blocked, 0), duration(x.cycle.p50Ms)]), [1, 2, 3, 4, 5]));
    out.push(squads);
  }
  return out;
}

type Tab = 'overview' | 'quality' | 'sessions' | 'accounts' | 'technical';
const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Panoramica' }, { id: 'quality', label: 'Qualità' }, { id: 'sessions', label: 'Sessioni' }, { id: 'accounts', label: 'Account' }, { id: 'technical', label: 'Dettagli tecnici' },
];
/** Per-viewer conveniences (tab, period): storage can be missing, the page works without it. */
const remember = {
  get(key: string) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key: string, value: string) { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } },
};

/** Mount the Stats workspace and stop requests, events and timers on disposal. */
export function mountMegaStats(root: HTMLElement): () => void {
  const page = el('section', undefined, 'mega-stats');
  const head = el('header', undefined, 'mega-stats-head');
  const meta = el('p', undefined, 'mega-stats-meta');
  const title = el('div');
  title.append(el('h2', t('Stats')), meta);
  const savedHours = remember.get('vb:stats:hours');
  let hours = savedHours === '1' || savedHours === '168' ? savedHours : '24';
  const periods = el('span', undefined, 'segmented');
  periods.setAttribute('role', 'group');
  periods.setAttribute('aria-label', t('Periodo'));
  const periodButtons = ([['1', t('1 ora')], ['24', t('24 ore')], ['168', t('7 giorni')]] as const).map(([value, label]) => {
    const b = button(label, () => { if (hours === value) return; hours = value; remember.set('vb:stats:hours', value); markPeriod(); void load(true); }, '');
    b.dataset.hours = value;
    return b;
  });
  const markPeriod = () => periodButtons.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.hours === hours)));
  markPeriod();
  periods.append(...periodButtons);
  const refresh = button(t('Aggiorna'), () => { routing.update(routingScope(), true); void load(); }, 'btn small');
  const actions = el('div', undefined, 'mega-stats-actions');
  actions.append(periods, refresh);
  head.append(title, actions);

  const filters = el('div', undefined, 'mega-stats-filters');
  const project = filterField(t('Progetto')), team = filterField(t('Squadra')), session = filterField(t('Sessione'));
  const allProjects = { value: '', label: t('Tutti i progetti') };
  const allTeams = { value: '', label: t('Tutte le squadre') };
  const allSessions = { value: '', label: t('Tutte le sessioni') };
  options(project.select, [allProjects], '');
  options(team.select, [allTeams], '');
  options(session.select, [allSessions], '');
  filters.append(project.label, team.label, session.label);

  // Tabs: the bar stays, the panels are filled again at every report.
  const savedTab = remember.get('vb:stats:tab');
  let tab: Tab = TABS.find(x => x.id === savedTab)?.id ?? 'overview';
  const tabBar = el('div', undefined, 'mega-stats-tabs');
  tabBar.setAttribute('role', 'tablist');
  tabBar.setAttribute('aria-label', t('Stats'));
  const panels = new Map<Tab, HTMLElement>(), tabButtons = new Map<Tab, HTMLButtonElement>();
  for (const x of TABS) {
    const b = button(t(x.label), () => select(x.id), '');
    b.setAttribute('role', 'tab');
    b.id = 'stats-tab-' + x.id;
    b.setAttribute('aria-controls', 'stats-panel-' + x.id);
    const panel = el('div', undefined, 'mega-stats-tabpanel');
    panel.id = 'stats-panel-' + x.id;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', b.id);
    tabButtons.set(x.id, b); panels.set(x.id, panel); tabBar.append(b);
  }
  tabBar.addEventListener('keydown', e => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = TABS.findIndex(x => x.id === tab), next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length].id;
    select(next); tabButtons.get(next)!.focus();
  });
  function select(next: Tab) {
    tab = next; remember.set('vb:stats:tab', next);
    for (const [id, b] of tabButtons) { b.setAttribute('aria-selected', String(id === tab)); b.tabIndex = id === tab ? 0 : -1; panels.get(id)!.hidden = id !== tab; }
  }
  select(tab);

  const status = el('p', undefined, 'mega-stats-status');
  status.setAttribute('role', 'status');
  // The providers' limits sit in the Account tab, under the account cards; the panel keeps its own state.
  const accountsBox = el('div'), quotaRoot = el('div', undefined, 'mega-stats-quota');
  panels.get('accounts')!.append(accountsBox, quotaRoot);
  const routing = mountQuotaPanel(quotaRoot);
  let listedTeams: StatsTeam[] = [];
  const routingScope = () => listedTeams.find(g => g.key === team.select.value) ?? null;
  page.append(head, filters, tabBar, status, ...panels.values());
  root.classList.add('mega-stats-view');
  root.replaceChildren(page);
  let request: AbortController | undefined;
  let disposed = false;
  let choices: StatsSession[] = [];
  let debounce = 0;
  let pendingRefresh = false;

  function render(r: MegaStatsReport, projectId: string, teamKey: string, sessionId: string) {
    const focusKey = page.contains(document.activeElement) ? (document.activeElement as HTMLElement)?.dataset.focusKey : undefined;
    const projectName = (id: number) => r.projects.find(p => p.id === id)?.name ?? String(id);
    listedTeams = r.teams;
    const teams = r.teams.filter(g => !projectId || String(g.projectId) === projectId);
    options(project.select, [allProjects, ...r.projects.map(p => ({ value: String(p.id), label: p.name }))], projectId);
    options(team.select, [allTeams, ...teams.map(g => ({ value: g.key, label: [!projectId && projectName(g.projectId), g.nodeId !== g.projectId && '#' + g.nodeId, g.name].filter(Boolean).join(' · ') }))], teamKey);
    if (!sessionId) choices = r.sessions;
    options(session.select, [allSessions, ...choices.map(s => ({ value: s.id, label: [!projectId && projectName(s.projectId), s.label].filter(Boolean).join(' · ') }))], sessionId);
    meta.replaceChildren(t('Aggiornato alle'), ' ', timestamp(r.updatedAt, true), ' · ', periodName(hours));
    // The Panoramica tab counts what waits for the person, so it shows from any tab.
    const attention = r.sessions.filter(s => s.alive && (s.attention || s.state === 'blocked')).length + r.teams.filter(g => g.tasks.blocked).length;
    const overviewButton = tabButtons.get('overview')!;
    overviewButton.replaceChildren(t('Panoramica'));
    if (attention) {
      const badge = el('span', String(attention), 'badge mega-stats-badge');
      badge.title = t('{n} richiedono attenzione').replace('{n}', String(attention));
      overviewButton.append(badge);
    }
    panels.get('overview')!.replaceChildren(...overview(r, hours));
    panels.get('quality')!.replaceChildren(...qualityTab(r.quality, r.timeline));
    panels.get('sessions')!.replaceChildren(...sessionsTab(r));
    accountsBox.replaceChildren(accountsTab(r));
    panels.get('technical')!.replaceChildren(...technicalTab(r));
    routing.update(routingScope());
    if (focusKey) [...page.querySelectorAll<HTMLElement>('[data-focus-key]')].find(x => x.dataset.focusKey === focusKey)?.focus({ preventScroll: true });
  }
  async function load(reset = false) {
    if (disposed) return;
    request?.abort();
    const now = new AbortController();
    request = now;
    if (reset) {
      for (const id of ['overview', 'quality', 'sessions', 'technical'] as Tab[]) panels.get(id)!.replaceChildren();
      accountsBox.replaceChildren();
      meta.replaceChildren();
    }
    if (!meta.childNodes.length) status.textContent = t('Caricamento statistiche…');
    page.setAttribute('aria-busy', 'true');
    const p = project.select.value, k = team.select.value, s = session.select.value;
    const params = new URLSearchParams({ hours });
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
        page.setAttribute('aria-busy', 'false');
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
