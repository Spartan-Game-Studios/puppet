import { defineI18n } from 'fumadocs-core/i18n';

export const i18n = defineI18n({
  defaultLanguage: 'en',
  languages: ['en', 'ru', 'zh-CN', 'es'],
  // Static export has no middleware, so every URL keeps its /<lang>/ prefix.
  hideLocale: 'never',
  // content/docs/page.mdx (English) + page.ru.mdx, page.zh-CN.mdx, page.es.mdx
  parser: 'dot',
});

export type Locale = (typeof i18n.languages)[number];

export function isLocale(value: string): value is Locale {
  return (i18n.languages as string[]).includes(value);
}
