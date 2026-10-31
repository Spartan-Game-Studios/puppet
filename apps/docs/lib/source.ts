import { loader } from 'fumadocs-core/source';
import { defineDocs } from 'fumadocs-mdx/macro';
import { metaSchema, pageSchema } from 'fumadocs-core/source/schema';
import { docsRoute } from './shared';
import { i18n } from './i18n';

const docs = defineDocs({
  dir: 'content/docs',
  docs: { schema: pageSchema },
  meta: { schema: metaSchema },
});

// See https://fumadocs.dev/docs/headless/source-api
export const source = loader({
  baseUrl: docsRoute,
  source: docs.toFumadocsSource(),
  i18n,
});
