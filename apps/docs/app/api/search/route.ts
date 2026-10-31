import { source } from '@/lib/source';
import { createFromSource } from 'fumadocs-core/search/server';

// Static export: the index is written to out/api/search at build time and
// searched in the browser (components/search.tsx uses useStaticSearch).
// No language is set, so Orama's multilingual tokenizer handles every locale,
// including Chinese.
export const revalidate = false;

export const { staticGET: GET } = createFromSource(source);
