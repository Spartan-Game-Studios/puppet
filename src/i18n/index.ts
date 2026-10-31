/**
 * UI language. English (`en`) is the source; `ru`, `zh-CN` and `es` are
 * translations of it. Each catalog is a flat map of keys to strings, split by
 * area under ./strings/ and merged in ./catalogs.ts.
 *
 * The language is fixed for the life of the page: picking another one stores
 * it and reloads (setLocale), so module-level tables and everything already
 * on screen come out in one language without each module re-rendering.
 *
 *   t('home.import')                       -> "IMPORT .VRM"
 *   t('status.modelOk', { chains: 3 })     -> "MODEL OK: 3 CHAINS"   ({chains} in the string)
 *   applyDom(document)                     -> fills [data-i18n], [data-i18n-title],
 *                                             [data-i18n-placeholder], [data-i18n-aria]
 *
 * A key missing from a translation falls back to English, so a partial
 * catalog still works. The choice lives in localStorage (read synchronously
 * at import, before any module builds its UI); `?lang=ru` overrides it.
 */
import { catalogs, type Key } from './catalogs';

export type { Key };
export const LOCALES = ['en', 'ru', 'zh-CN', 'es'] as const;
export type Locale = (typeof LOCALES)[number];

/** Each language named in itself, for the picker. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: 'ENGLISH',
  ru: 'РУССКИЙ',
  'zh-CN': '简体中文',
  es: 'ESPAÑOL',
};

const LS_KEY = 'vpuppet.lang';

function match(tag: string | null | undefined): Locale | null {
  if (!tag) return null;
  const t = tag.toLowerCase();
  if (t === 'zh' || t.startsWith('zh-cn') || t.startsWith('zh-hans') || t === 'zh-sg') return 'zh-CN';
  return LOCALES.find((l) => l.toLowerCase() === t || t.startsWith(`${l.toLowerCase()}-`)) ?? null;
}

function detect(): Locale {
  if (typeof window === 'undefined') return 'en';
  const url = match(new URLSearchParams(location.search).get('lang'));
  if (url) return url;
  try {
    const saved = match(localStorage.getItem(LS_KEY));
    if (saved) return saved;
  } catch {
    /* storage unavailable */
  }
  for (const l of navigator.languages ?? [navigator.language]) {
    const m = match(l);
    if (m) return m;
  }
  return 'en';
}

export const locale: Locale = detect();
const dict = catalogs[locale];
const en = catalogs.en;

export function t(key: Key, vars?: Record<string, string | number>): string {
  let s: string = dict[key] ?? en[key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
  return s;
}

/** Store the choice and reload so the whole UI comes up in it. */
export function setLocale(l: Locale): void {
  if (l === locale) return;
  try {
    localStorage.setItem(LS_KEY, l);
  } catch {
    /* storage unavailable: the choice won't stick */
  }
  const u = new URL(location.href);
  u.searchParams.delete('lang');
  location.replace(u.toString());
}

/** Translate the static markup under `root` (index.html, cloned templates). */
export function applyDom(root: ParentNode): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) el.textContent = t(el.dataset.i18n as Key);
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle as Key);
  for (const el of root.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder as Key);
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria as Key));
  // Markup the catalog owns (strings with <kbd> or <br> inside).
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml as Key);
  // Any other attribute: data-i18n-attr="data-title=modal.scene,alt=card.thumb".
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-attr]')) {
    for (const pair of el.dataset.i18nAttr!.split(',')) {
      const [attr, key] = pair.split('=').map((s) => s.trim());
      if (attr && key) el.setAttribute(attr, t(key as Key));
    }
  }
  // <template> contents aren't reached by querySelectorAll on the document.
  for (const tpl of root.querySelectorAll('template')) applyDom(tpl.content);
}

if (typeof document !== 'undefined') {
  document.documentElement.lang = locale;
  document.documentElement.dataset.locale = locale;
}
