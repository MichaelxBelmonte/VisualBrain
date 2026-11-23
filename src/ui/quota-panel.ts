// Quotas describe the current account group. The historical Stats window does not change their timestamps.
import { quotaProviders } from '../shared/quota-routing.ts';
import type { QuotaGroup, RoutingRule, RoutingView } from '../shared/quota-routing.ts';
import type { AgentName } from '../shared/types.ts';
import { getLanguage, t } from './i18n.ts';

type Scope = { nodeId: number; id: string; name: string };
const names: Record<AgentName, string> = { codex: 'Codex', claude: 'Claude', hermes: 'Hermes', agy: 'Antigravity' };
const statuses: Record<QuotaGroup['status'], string> = {
  available: 'Disponibile', limited: 'Limite raggiunto', margin: 'Al margine di riserva', unknown: 'Quota sconosciuta', stale: 'Dato scaduto',
};

function tag<K extends keyof HTMLElementTagNameMap>(name: K, value?: string, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(name);
  if (value !== undefined) e.textContent = value;
  if (cls) e.className = cls;
  return e;
}

function clock(value: number | null): HTMLElement {
  if (value === null) return tag('span', t('N/D'));
  const date = new Date(value);
  const time = tag('time', date.toLocaleString(getLanguage(), { dateStyle: 'short', timeStyle: 'short' }));
  time.dateTime = date.toISOString();
  return time;
}

function fact(list: HTMLDListElement, label: string, value: string | HTMLElement) {
  const dd = tag('dd');
  dd.append(value);
  list.append(tag('dt', label), dd);
}

function action(label: string, callback: () => void) {
  const button = tag('button', t(label), 'btn small');
  button.type = 'button';
  button.onclick = callback;
  return button;
}

const percent = (v: number) => (v / 100).toLocaleString(getLanguage(), { style: 'percent', maximumFractionDigits: 1 });
const preference = (v: RoutingRule['preference']) => v === 'balanced' ? t('Bilanciata') : names[v];

function decisionReason(reason: string) {
  const parts = reason.split(' · ');
  if (parts.length === 4 && parts[0] === 'Disponibile' && parts[3].endsWith('% residuo')) {
    return [t(parts[0]), parts[1], parts[2], parts[3].slice(0, -' residuo'.length) + ' ' + t('residuo')].join(' · ');
  }
  if (parts.length === 2 && ['Quota scaduta ammessa', 'Quota ignota ammessa'].includes(parts[0])) return t(parts[0]) + ' · ' + parts[1];
  return parts.length === 1 ? t(reason) : reason;
}
function providerRow(q: QuotaGroup) {
  const row = tag('details', undefined, 'mega-stats-provider');
  row.dataset.provider = q.provider + ':' + q.group;
  const summary = tag('summary');
  const head = tag('span', undefined, 'mega-quota-title');
  const state = tag('strong', t(statuses[q.status]));
  state.dataset.status = q.status;
  // The default group says nothing to the person: the account the quota belongs to does.
  const title = tag('span', names[q.provider] + ' · ' + (q.group === 'default' ? q.account || t('Principale') : q.group));
  head.append(title, state);
  const observed = tag('span', undefined, 'mega-stats-meta');
  observed.append(q.source ?? t('Fonte sconosciuta'), ' · ', clock(q.observedAt));
  if (q.windows.length) observed.append(' · ', t('Residuo minimo osservato'), ' ', percent(Math.min(...q.windows.map(w => w.remainingPct))));
  summary.append(head, observed);
  const facts = tag('dl');
  fact(facts, t('Account'), q.account || t('N/D'));
  fact(facts, t('Dato valido fino al'), clock(q.freshUntil));
  if (q.limited || q.blockedUntil !== null) fact(facts, t('Blocco fino al'), q.blockedUntil === null ? t('Ripristino non comunicato') : clock(q.blockedUntil));
  if (!q.windows.length) fact(facts, t('Quota residua'), t('N/D'));
  for (const win of q.windows) {
    const value = tag('div');
    const meter = tag('meter');
    meter.min = 0; meter.max = 100; meter.value = win.remainingPct;
    const period = win.name + (win.minutes === null ? '' : ' · ' + win.minutes.toLocaleString(getLanguage()) + ' min');
    meter.setAttribute('aria-label', [names[q.provider], period, t('Quota residua')].join(' · '));
    value.append(percent(win.remainingPct), meter);
    fact(facts, period, value);
    fact(facts, t('Prossimo ripristino'), win.resetsAt === null ? t('Ripristino non comunicato') : clock(win.resetsAt));
  }
  row.append(summary, facts);
  return row;
}

function ruleDescription(rule: RoutingRule) {
  const dl = tag('dl', undefined, 'mega-stats-rule');
  fact(dl, t('Instradamento della squadra'), rule.enabled ? t('Abilitato') : t('Disabilitato'));
  fact(dl, t('Margine di riserva'), percent(rule.marginPct));
  fact(dl, t('Provider ammessi'), rule.providers.map(p => names[p]).join(', ') || t('Nessuno'));
  fact(dl, t('Preferenza agente'), preference(rule.preference));
  fact(dl, t('Quota sconosciuta'), rule.allowUnknown ? t('Consentita') : t('Esclusa'));
  return dl;
}

/** Edit a local draft; only a confirmed PUT applies the complete rule to the selected team. */
function ruleEditor(root: HTMLElement, scope: Scope, rule: RoutingRule, save: (r: RoutingRule) => Promise<void>, restore: () => void) {
  const dialog = tag('dialog', undefined, 'mega-stats-dialog');
  const title = tag('h3', t('Regola di instradamento'));
  title.id = 'mega-routing-title';
  dialog.setAttribute('aria-labelledby', title.id);
  const form = tag('form');
  const field = (caption: string, control: HTMLElement) => {
    const label = tag('label', t(caption)); label.append(control); return label;
  };
  const toggle = (name: string, checked: boolean, caption: string) => {
    const label = tag('label', undefined, 'mega-routing-check'), input = tag('input');
    input.name = name; input.type = 'checkbox'; input.checked = checked;
    label.append(input, t(caption)); return { label, input };
  };
  const enabled = toggle('enabled', rule.enabled, 'Abilita instradamento nella squadra');
  const unknown = toggle('allowUnknown', rule.allowUnknown, 'Ammetti provider con quota sconosciuta');
  const margin = tag('input');
  margin.name = 'marginPct'; margin.type = 'number'; margin.min = '0'; margin.max = '100'; margin.step = 'any'; margin.required = true;
  margin.value = String(rule.marginPct);
  const preferred = tag('select');
  preferred.name = 'preference';
  for (const p of ['balanced' as const, ...quotaProviders]) preferred.add(new Option(preference(p), p));
  preferred.value = rule.preference;
  const providers = tag('fieldset');
  providers.append(tag('legend', t('Provider ammessi e gruppi di quota')));
  const fields = quotaProviders.map(provider => {
    const allowed = toggle('provider-'+provider, rule.providers.includes(provider), names[provider]);
    const group = tag('input');
    group.name = 'group-'+provider; group.type = 'text'; group.value = rule.groups[provider];
    group.required = true;
    group.maxLength = 64;
    group.pattern = '[A-Za-z0-9][A-Za-z0-9._\\-]{0,63}';
    group.title = t('Inizia con una lettera o un numero. Sono ammessi anche punto, trattino e trattino basso.');
    group.setAttribute('aria-label', t('Gruppo di quota') + ' · ' + names[provider]);
    const line = tag('div', undefined, 'mega-routing-provider');
    line.append(allowed.label, group); providers.append(line);
    return { provider, allowed: allowed.input, group };
  });
  const status = tag('p', undefined, 'mega-stats-status'); status.setAttribute('role', 'alert');
  const foot = tag('footer'), submit = tag('button', t('Applica alla squadra'), 'btn primary');
  submit.type = 'submit';
  foot.append(action('Chiudi', () => dialog.close()), submit);
  form.append(enabled.label, field('Margine di riserva (%)', margin), field('Preferenza agente', preferred), unknown.label, providers, status, foot);
  dialog.append(title, tag('p', scope.name, 'mega-stats-meta'),
    tag('p', t('La regola si applica subito a questa squadra. Usa lo stesso nome di gruppo per una quota condivisa.'), 'mega-stats-meta'), form);
  root.append(dialog);
  dialog.onclose = () => { dialog.remove(); restore(); };
  form.onsubmit = async e => {
    e.preventDefault();
    if (submit.disabled || !form.reportValidity()) return;
    const groups = { ...rule.groups };
    for (const f of fields) groups[f.provider] = f.group.value.trim();
    const update: RoutingRule = { enabled: enabled.input.checked, allowUnknown: unknown.input.checked,
      preference: preferred.value as RoutingRule['preference'], marginPct: margin.valueAsNumber,
      providers: fields.filter(f => f.allowed.checked).map(f => f.provider), groups };
    submit.disabled = true; status.textContent = '';
    try { await save(update); dialog.close(); }
    catch { status.textContent = t('Impossibile applicare la regola. Controlla i valori e riprova.'); }
    finally { submit.disabled = false; }
  };
  dialog.showModal();
}

export function mountQuotaPanel(root: HTMLElement) {
  const section = tag('section', undefined, 'mega-stats-section mega-routing');
  const head = tag('header', undefined, 'mega-routing-head');
  const refresh = action('Aggiorna quota Codex', () => { void refreshCodex(); });
  head.append(tag('h3', t('Disponibilità dei provider')), refresh);
  const context = tag('p', undefined, 'mega-stats-meta');
  const status = tag('p', undefined, 'mega-stats-status'); status.setAttribute('role', 'status');
  const body = tag('div');
  section.append(head, context, status, body);
  root.append(section);
  let selected: Scope | null = null;
  let scopeKey: string | undefined;
  let request: AbortController | undefined;
  let disposed = false, refreshing = false;
  let lastRead = 0;
  function url(scope: Scope | null) {
    const prefix = '/api/mega-stats/routing';
    return scope ? prefix + '?' + new URLSearchParams({ node: String(scope.nodeId), team: scope.id }) : prefix;
  }
  function render(view: RoutingView) {
    const expanded = new Set([...body.querySelectorAll<HTMLDetailsElement>('details[open]')].map(d=>d.dataset.provider));
    const focusKey = body.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.quotaFocus : undefined;
    const rows = tag('div', undefined, 'mega-stats-providers');
    for (const q of view.quotas) {
      const row = providerRow(q);
      row.querySelector('summary')!.dataset.quotaFocus = row.dataset.provider;
      row.open = expanded.has(row.dataset.provider);
      rows.append(row);
    }
    if (!view.quotas.length) rows.append(tag('p',t('Nessuna quota osservata.'),'mega-stats-meta'));
    const info = tag('div', undefined, 'mega-routing-rule');
    const scope = selected;
    if (scope && scope.id !== 'brain') {
      info.append(ruleDescription(view.rule));
      const edit = action('Modifica regola', () => {
        ruleEditor(section, scope, view.rule, async value => {
          const res = await fetch(url(scope), { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(value) });
          if (!res.ok) throw new Error(String(res.status));
          const applied: RoutingView = await res.json();
          if (!disposed && selected?.nodeId === scope.nodeId && selected.id === scope.id) {
            request?.abort();
            render(applied);
            lastRead = Date.now();
            status.textContent = t('Regola applicata alla squadra.');
          }
        }, () => body.querySelector<HTMLButtonElement>('[data-quota-focus="edit"]')?.focus({preventScroll:true}));
      });
      edit.dataset.quotaFocus = 'edit'; info.append(edit);
    } else info.append(tag('p',t('Scegli una squadra nei filtri per vedere e cambiare come distribuisce il lavoro tra i provider.'),'mega-stats-meta'));
    if (view.decisions.length) {
      const decisions = tag('details');
      decisions.dataset.provider = 'decisions'; decisions.open = expanded.has('decisions');
      const summary = tag('summary', t('Decisioni di instradamento') + ' · ' + view.decisions.length);
      summary.dataset.quotaFocus = 'decisions';
      const list = tag('ul');
      for (const d of view.decisions) {
        const li = tag('li');
        li.append(clock(d.at), ' · ', t('Incarico'), ' ', d.taskId, ' · ', d.assignee ?? t('Da assegnare'), ' · ', decisionReason(d.reason));
        list.append(li);
      }
      decisions.append(summary,list); info.append(decisions);
    } else if (scope && scope.id !== 'brain') info.append(tag('p', t('Nessuna decisione di instradamento registrata.'), 'mega-stats-meta'));
    body.replaceChildren(rows,info);
    if (focusKey) [...body.querySelectorAll<HTMLElement>('[data-quota-focus]')].find(e=>e.dataset.quotaFocus===focusKey)?.focus({preventScroll:true});
    context.replaceChildren(...(scope ? [scope.name, ' · '] : []), t('Ultimo aggiornamento'), ' ', clock(view.updatedAt));
  }
  async function load() {
    if (disposed) return;
    request?.abort();
    const current = new AbortController(); request = current;
    try {
      const res = await fetch(url(selected),{signal:current.signal});
      if (!res.ok) throw new Error(String(res.status));
      const data: RoutingView = await res.json();
      if (!current.signal.aborted) { render(data); status.textContent = ''; lastRead = Date.now(); }
    } catch { if (!current.signal.aborted) status.textContent = t('Disponibilità provider non disponibile.'); }
    finally { if (request===current) request=undefined; }
  }
  async function refreshCodex() {
    if (refreshing || disposed || selected?.id==='brain') return;
    refreshing = true; refresh.disabled = true;
    const started = scopeKey;
    status.textContent = t('Aggiornamento della fonte Codex…');
    try {
      const res = await fetch('/api/mega-stats/routing/refresh', {method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
      if (!res.ok) throw new Error(String(res.status));
      if (!disposed && scopeKey===started) await load();
    } catch { if (!disposed && scopeKey===started) status.textContent=t('Aggiornamento della fonte Codex non riuscito.'); }
    finally { refreshing=false; refresh.disabled=false; }
  }
  return {
    update(scope: Scope | null, force = false) {
      const key = url(scope);
      if (key!==scopeKey) {
        scopeKey=key; selected=scope; lastRead=0;
        section.querySelector('dialog')?.close();
        context.textContent=scope?.name ?? t('Profilo'); body.replaceChildren(); status.textContent=t('Caricamento quote…');
        refresh.hidden = scope?.id === 'brain';
        void load();
      } else if (!refreshing && (force || !request && Date.now()-lastRead>=30_000)) void load();
    },
    dispose() { disposed=true; request?.abort(); section.remove(); },
  };
}
