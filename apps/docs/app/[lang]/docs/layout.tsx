import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { source } from '@/lib/source';
import { baseOptions } from '@/lib/layout.shared';
import type { Locale } from '@/lib/i18n';

export default async function Layout({ params, children }: LayoutProps<'/[lang]/docs'>) {
  const { lang } = await params;
  const base = baseOptions(lang as Locale);
  return (
    <DocsLayout tree={source.getPageTree(lang)} {...base} links={base.links?.filter((l) => 'external' in l && l.external)}>
      {children}
    </DocsLayout>
  );
}
