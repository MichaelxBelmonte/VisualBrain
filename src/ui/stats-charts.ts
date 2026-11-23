// Charts of the Stats, in plain HTML (no library): stacked columns over time with a tooltip on hover and keyboard,
// a legend and a table view; small bars inside the figure cards. Colours come from the --series-N tokens of
// mega-stats.css (validated for colour-blind separation in light and dark); text always uses the text colours.
import { getLanguage, t } from './i18n.ts';

export interface ColumnSeries { key: string; label: string; values: number[] }

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

/** A round top for the axis: 0 / 50K / 100K / 150K rather than 0 / 47.3K / 94.6K. */
export function niceScale(max: number, ticks = 3): { top: number; step: number } {
  if (!(max > 0)) return { top: 1, step: 1 };
  const raw = max / ticks, power = 10 ** Math.floor(Math.log10(raw)), unit = raw / power;
  const step = (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 2.5 ? 2.5 : unit <= 5 ? 5 : 10) * power;
  return { top: Math.ceil(max / step) * step, step };
}

const compact = (n: number) => n.toLocaleString(getLanguage(), { notation: 'compact', maximumFractionDigits: 1 });

/** How an interval reads: «14:00–15:00», or «lun 17, 06:00–12:00» for a week. */
function intervalName(edges: readonly number[], i: number): string {
  const lang = getLanguage(), a = new Date(edges[i]), b = new Date(edges[i + 1]);
  const time = (d: Date) => d.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
  const long = edges[edges.length - 1] - edges[0] > 2 * 86_400_000;
  return (long ? a.toLocaleDateString(lang, { weekday: 'short', day: 'numeric' }) + ', ' : '') + `${time(a)}–${time(b)}`;
}

/** Labels under the axis: a handful, on round times (midnights for a week). */
function axisLabels(edges: readonly number[]): { index: number; text: string }[] {
  const lang = getLanguage(), n = edges.length - 1, long = edges[n] - edges[0] > 2 * 86_400_000;
  if (long) {
    return edges.slice(0, n).flatMap((at, index) => {
      const d = new Date(at);
      return index > 0 && d.getHours() === 0 && d.getMinutes() === 0 ? [{ index, text: d.toLocaleDateString(lang, { weekday: 'short', day: 'numeric' }) }] : [];
    });
  }
  const every = Math.max(1, Math.ceil(n / 6));
  const out: { index: number; text: string }[] = [];
  for (let index = 1; index < n; index++) if ((n - index) % every === 0) out.push({ index, text: new Date(edges[index]).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' }) });
  return out;
}

/**
 * Stacked columns over time. One series needs no legend (the title names it); from two, a legend, and the tooltip
 * lists every series of the interval. The figures are also in «Mostra i dati». `additive: false`: the series are not
 * parts of one quantity (closed and reopened tasks), so no total is shown.
 */
export function columnChart(opts: { title: string; note?: string; edges: readonly number[]; series: ColumnSeries[]; format?: (n: number) => string; empty: string; additive?: boolean }): HTMLElement {
  const additive = opts.additive !== false;
  const format = opts.format ?? compact;
  const figure = el('figure', undefined, 'stats-chart');
  const head = el('figcaption');
  const titles = el('div');
  titles.append(el('h4', opts.title));
  if (opts.note) titles.append(el('p', opts.note, 'mega-stats-meta'));
  head.append(titles);
  const n = opts.edges.length - 1;
  const totals = Array.from({ length: n }, (_, i) => opts.series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0));
  const grand = totals.reduce((a, b) => a + b, 0);
  if (additive) head.append(el('strong', format(grand), 'stats-chart-total'));
  figure.append(head);
  if (opts.series.length > 1) {
    const legend = el('ul', undefined, 'stats-chart-legend');
    opts.series.forEach((s, i) => { const li = el('li'); const key = el('i'); key.dataset.series = String(i + 1); li.append(key, s.label); legend.append(li); });
    figure.append(legend);
  }
  if (!grand || n < 1) { figure.append(el('p', opts.empty, 'stats-chart-empty')); return figure; }

  const { top, step } = niceScale(Math.max(...totals));
  const plot = el('div', undefined, 'stats-chart-plot');
  plot.tabIndex = 0;
  plot.setAttribute('role', 'group');
  plot.setAttribute('aria-label', `${opts.title}${additive ? ': ' + format(grand) : ''}. ${t('Frecce sinistra e destra per scorrere gli intervalli.')}`);
  const grid = el('div', undefined, 'stats-chart-grid');
  grid.setAttribute('aria-hidden', 'true');
  for (let v = 0; v <= top + step / 2; v += step) {
    const line = el('span');
    line.style.bottom = `${(v / top) * 100}%`;
    line.append(el('b', v === 0 ? '0' : compact(v)));
    if (v === 0) line.className = 'base';
    grid.append(line);
  }
  const cols = el('div', undefined, 'stats-chart-cols');
  for (let i = 0; i < n; i++) {
    const slot = el('div', undefined, 'stats-chart-slot');
    slot.dataset.i = String(i);
    const col = el('div', undefined, 'stats-chart-col');
    col.style.height = `${(totals[i] / top) * 100}%`;
    opts.series.forEach((s, k) => {
      const v = s.values[i] ?? 0;
      if (!v) return;
      const seg = el('span');
      seg.dataset.series = String(k + 1);
      seg.style.flexGrow = String(v);
      col.append(seg);
    });
    slot.append(col);
    cols.append(slot);
  }
  const tip = el('div', undefined, 'stats-chart-tip');
  tip.hidden = true;
  tip.setAttribute('role', 'status');
  plot.append(grid, cols, tip);
  const axis = el('div', undefined, 'stats-chart-x');
  axis.setAttribute('aria-hidden', 'true');
  for (const label of axisLabels(opts.edges)) {
    const span = el('span', label.text);
    span.style.left = `${(label.index / n) * 100}%`;
    axis.append(span);
  }
  figure.append(plot, axis);

  // One tooltip: the interval, its total first, then every series with a line key.
  let active = -1;
  const show = (i: number) => {
    active = Math.max(0, Math.min(n - 1, i));
    cols.querySelectorAll('.on').forEach(x => x.classList.remove('on'));
    const slot = cols.children[active] as HTMLElement;
    slot.classList.add('on');
    cols.classList.add('hovering');
    tip.replaceChildren(el('span', intervalName(opts.edges, active), 'stats-chart-tip-when'));
    if (additive) tip.append(el('strong', format(totals[active])));
    if (opts.series.length > 1) for (const [k, s] of opts.series.entries()) {
      const row = el('span', undefined, 'stats-chart-tip-row');
      const key = el('i'); key.dataset.series = String(k + 1);
      row.append(key, el('b', format(s.values[active] ?? 0)), ' ', s.label);
      tip.append(row);
    }
    tip.hidden = false;
    const center = slot.offsetLeft + slot.offsetWidth / 2, half = tip.offsetWidth / 2;
    tip.style.left = `${Math.max(half, Math.min(plot.clientWidth - half, center))}px`;
  };
  const hide = () => { tip.hidden = true; active = -1; cols.classList.remove('hovering'); cols.querySelectorAll('.on').forEach(x => x.classList.remove('on')); };
  cols.addEventListener('pointermove', e => {
    const slot = (e.target as HTMLElement).closest<HTMLElement>('.stats-chart-slot');
    if (slot && Number(slot.dataset.i) !== active) show(Number(slot.dataset.i));
  });
  cols.addEventListener('pointerleave', () => { if (document.activeElement !== plot) hide(); });
  plot.addEventListener('focus', () => show(active >= 0 ? active : n - 1));
  plot.addEventListener('blur', hide);
  plot.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); show(active + (e.key === 'ArrowRight' ? 1 : -1)); }
    else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); show(e.key === 'Home' ? 0 : n - 1); }
    else if (e.key === 'Escape') hide();
  });

  // The same figures as a table, for reading without hovering and for screen readers.
  const data = el('details', undefined, 'stats-chart-data');
  data.append(el('summary', t('Mostra i dati')));
  const table = el('table', undefined, 'mega-stats-table');
  const headRow = table.createTHead().insertRow();
  const columns = opts.series.length > 1 ? opts.series.map(s => s.label) : [];
  for (const title of [t('Intervallo'), ...columns, ...(additive || !columns.length ? [t('Totale')] : [])]) { const th = el('th', title); th.scope = 'col'; headRow.append(th); }
  headRow.querySelectorAll('th:not(:first-child)').forEach(th => th.classList.add('num'));
  const body = table.createTBody();
  for (let i = 0; i < n; i++) {
    if (!totals[i]) continue;
    const tr = body.insertRow();
    const th = el('th', intervalName(opts.edges, i)); th.scope = 'row'; tr.append(th);
    for (const v of [...(columns.length ? opts.series.map(s => s.values[i] ?? 0) : []), ...(additive || !columns.length ? [totals[i]] : [])]) { const td = el('td', format(v), 'num'); tr.append(td); }
  }
  const wrap = el('div', undefined, 'mega-stats-table-wrap');
  wrap.append(table);
  data.append(wrap);
  figure.append(data);
  return figure;
}

/** Bars in a natural order (not ranked): one hue, the figure at the end of each row. */
export function orderedBars(rows: { label: string; value: number }[], format: (n: number) => string): HTMLElement {
  const list = el('ul', undefined, 'stats-ordered');
  const max = Math.max(1, ...rows.map(r => r.value));
  for (const r of rows) {
    const li = el('li');
    const track = el('span', undefined, 'stats-ordered-track');
    const fill = el('i');
    fill.style.width = r.value ? `${Math.max(2, (r.value / max) * 100)}%` : '0';
    track.append(fill);
    track.setAttribute('aria-hidden', 'true');
    li.append(el('span', r.label, 'stats-ordered-label'), track, el('b', format(r.value)));
    list.append(li);
  }
  return list;
}
