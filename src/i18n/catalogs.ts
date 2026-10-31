/**
 * All UI strings, merged from the per-area files in ./strings/. Each area
 * exports `en` (the source; its keys define the Key type) and `ru`, `zhCN`,
 * `es` translations of it. Keys are prefixed by area so they can't collide.
 */
import * as library from './strings/library';
import * as mcp from './strings/mcp';
import * as motion from './strings/motion';
import * as shell from './strings/shell';
import * as stage from './strings/stage';

const areas = [shell, stage, library, motion, mcp] as const;

type Merge<A extends readonly { en: object }[]> = A extends readonly [infer H extends { en: object }, ...infer R extends { en: object }[]]
  ? H['en'] & Merge<R>
  : unknown;
type En = Merge<typeof areas>;
export type Key = keyof En;

const merge = (pick: (a: (typeof areas)[number]) => object) => Object.assign({}, ...areas.map(pick)) as Partial<Record<Key, string>>;

export const catalogs = {
  en: merge((a) => a.en) as Record<Key, string>,
  ru: merge((a) => a.ru),
  'zh-CN': merge((a) => a.zhCN),
  es: merge((a) => a.es),
};
