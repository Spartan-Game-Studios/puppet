import { describe, expect, it } from 'vitest';
import { catalogs, type Key } from '../src/i18n/catalogs';
import html from '../index.html?raw';
import * as library from '../src/i18n/strings/library';
import * as mcp from '../src/i18n/strings/mcp';
import * as motion from '../src/i18n/strings/motion';
import * as shell from '../src/i18n/strings/shell';
import * as stage from '../src/i18n/strings/stage';

const en = catalogs.en;
const keys = Object.keys(en) as Key[];
const others = (['ru', 'zh-CN', 'es'] as const).map((l) => [l, catalogs[l]] as const);
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const tags = (s: string) => [...s.matchAll(/<\/?(\w+)/g)].map((m) => m[1]).sort();

describe('i18n catalogs', () => {
  it('no key is defined by two areas (the merge would hide one)', () => {
    const seen = new Map<string, string>();
    const dups: string[] = [];
    for (const [name, area] of Object.entries({ shell, stage, library, motion, mcp })) {
      for (const k of Object.keys(area.en)) {
        if (seen.has(k)) dups.push(`${k}: ${seen.get(k)} + ${name}`);
        seen.set(k, name);
      }
    }
    expect(dups).toEqual([]);
  });

  it('every key index.html uses exists in English', () => {
    const used = new Set<string>();
    for (const m of html.matchAll(/data-i18n(?:-title|-placeholder|-aria|-html)?="([^"]+)"/g)) used.add(m[1]);
    for (const m of html.matchAll(/data-i18n-attr="([^"]+)"/g)) for (const p of m[1].split(',')) used.add(p.split('=')[1].trim());
    const missing = [...used].filter((k) => !(k in en));
    expect(missing).toEqual([]);
  });

  for (const [locale, cat] of others) {
    it(`${locale} translates every key`, () => {
      expect(keys.filter((k) => !cat[k])).toEqual([]);
    });
    it(`${locale} keeps placeholders and markup`, () => {
      const bad = keys.filter((k) => cat[k] && (placeholders(cat[k]!).join() !== placeholders(en[k]).join() || tags(cat[k]!).join() !== tags(en[k]).join()));
      expect(bad).toEqual([]);
    });
  }
});
