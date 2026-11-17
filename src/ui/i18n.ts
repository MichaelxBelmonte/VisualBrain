import { en } from './locales/en.ts';
export type Language = 'it' | 'en';
let language: Language = (() => {
  if (typeof window === 'undefined') return 'it';
  try { const saved = localStorage.getItem('vb:language'); if (saved === 'it' || saved === 'en') return saved; } catch {}
  return navigator.language.toLowerCase().startsWith('it') ? 'it' : 'en';
})();
export const getLanguage = () => language;
export function setLanguage(value: Language): void {
  language = value;
  if (typeof document !== 'undefined') document.documentElement.lang = value;
  try { localStorage.setItem('vb:language', value); } catch {}
}
const keys = Object.keys(en).sort((a, b) => b.length - a.length);
const pattern = new RegExp(`(^|[>"\\s])(${keys.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?=$|[<"\\s])`, 'g');
/** Only source-authored literals go here. Never translate filenames, prompts, output or API data. */
export function t(source: string): string {
  if (language === 'it') return source;
  if (en[source] !== undefined) return en[source];
  return source.replace(pattern, (_match, prefix: string, key: string) => prefix + en[key]);
}
/** Translate static template segments, keeping interpolated user data byte-for-byte intact. */
export function ui(parts: TemplateStringsArray, ...values: unknown[]): string {
  return parts.map((part, i) => t(part) + (i < values.length ? String(values[i]) : '')).join('');
}
export function translateStaticUI(): void {
  // Called once, before any user or graph content is rendered.
  const walk = document.createTreeWalker(document.getElementById('app')!, NodeFilter.SHOW_TEXT);
  while (walk.nextNode()) { const n = walk.currentNode; if (n.parentElement?.closest('script,style')) continue; n.textContent = t(n.textContent || ''); }
  document.querySelectorAll<HTMLElement>('[title],[placeholder],[aria-label]').forEach(el => {
    for (const a of ['title','placeholder','aria-label']) if (el.hasAttribute(a)) el.setAttribute(a, t(el.getAttribute(a)!));
  });
  document.documentElement.lang = language;
}
