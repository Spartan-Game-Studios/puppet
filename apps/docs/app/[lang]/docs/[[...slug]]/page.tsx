import { DocsBody, DocsDescription, DocsPage, DocsTitle, EditOnGitHub } from 'fumadocs-ui/layouts/docs/page';
import { createRelativeLink } from 'fumadocs-ui/mdx';
import { Card } from 'fumadocs-ui/components/card';
import type { ComponentProps } from 'react';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { source } from '@/lib/source';
import { getMDXComponents } from '@/components/mdx';
import { gitConfig } from '@/lib/shared';

export default async function Page(props: PageProps<'/[lang]/docs/[[...slug]]'>) {
  const { slug, lang } = await props.params;
  const page = source.getPage(slug, lang);
  if (!page) notFound();

  const MDX = page.data.body;

  return (
    <DocsPage
      toc={page.data.toc}
      full={page.data.full}
    >
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <MDX
          components={getMDXComponents({
            // links to other .mdx files resolve to the same page in the current locale
            a: createRelativeLink(source, page),
            Card: ({ href, ...rest }: ComponentProps<typeof Card>) => (
              <Card {...rest} href={href ? source.resolveHref(href, page) : href} />
            ),
          })}
        />
      </DocsBody>
      <EditOnGitHub
        href={`https://github.com/${gitConfig.user}/${gitConfig.repo}/blob/${gitConfig.branch}/${gitConfig.contentDir}/${page.path}`}
      />
    </DocsPage>
  );
}

export function generateStaticParams() {
  return source.generateParams('slug', 'lang');
}

export const dynamicParams = false;

export async function generateMetadata(props: PageProps<'/[lang]/docs/[[...slug]]'>): Promise<Metadata> {
  const { slug, lang } = await props.params;
  const page = source.getPage(slug, lang);
  if (!page) notFound();
  return { title: page.data.title, description: page.data.description };
}
