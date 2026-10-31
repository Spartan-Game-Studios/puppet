/** DOM builders for the home screen: model cards (from #tpl-card) and licence panels. */
import { locale, t } from '../i18n';
import { displayAuthor, displayName, formatAgo, formatBytes, formatCount } from '../library/libraryIndex';
import { badgeLabel } from '../library/vrmMeta';
import type { Card } from '../library/library';
import type { LicenceSummary, VrmMeta } from '../library/vrmMeta';
import type { ModelStats } from '../library/libraryIndex';
import type { ModelWarning } from '../scene/modelChecks';

const MARK: Record<string, string> = { yes: '✓', no: '✕', '?': '?', '': '' };

/** Plain-language licence rows into `el`. */
export function renderLicence(el: HTMLElement, s: LicenceSummary, meta: VrmMeta): void {
  el.innerHTML = '';
  const head = document.createElement('div');
  head.className = `lic-head tone-${s.tone}`;
  const badge = document.createElement('span');
  badge.className = `lic ${s.tone}`;
  badge.textContent = badgeLabel(s.badge);
  const p = document.createElement('p');
  p.textContent = s.headline.toUpperCase();
  head.append(badge, p);
  el.append(head);
  const dl = document.createElement('dl');
  dl.className = 'lic-rows';
  for (const l of s.lines) {
    const row = document.createElement('div');
    row.className = `lic-row mark-${l.mark === '?' ? 'q' : l.mark || 'none'}`;
    const dt = document.createElement('dt');
    dt.textContent = l.label;
    const dd = document.createElement('dd');
    if (l.mark) {
      const m = document.createElement('i');
      m.textContent = MARK[l.mark];
      dd.append(m);
    }
    dd.append(document.createTextNode(l.value));
    if (/^https?:/.test(l.value)) dd.classList.add('url');
    row.append(dt, dd);
    dl.append(row);
  }
  el.append(dl);
  const foot = document.createElement('p');
  foot.className = 'lic-foot';
  foot.textContent = t('library.lic.foot', { spec: meta.spec, version: meta.version ? t('library.lic.footVersion', { version: meta.version }) : '' });
  el.append(foot);
}

/** MODEL INFO's "MODEL CHECKS" list: authoring problems found on load (src/scene/modelChecks.ts). */
export function renderWarnings(warnings: ReadonlyArray<Pick<ModelWarning, 'text' | 'detail'>>): HTMLElement {
  const box = document.createElement('div');
  box.className = 'mi-checks';
  const h = document.createElement('h3');
  h.textContent = t('library.checks.title');
  const ul = document.createElement('ul');
  for (const w of warnings) {
    const li = document.createElement('li');
    const b = document.createElement('b');
    b.textContent = w.text;
    const p = document.createElement('span');
    p.textContent = w.detail.toUpperCase();
    li.append(b, p);
    ul.append(li);
  }
  box.append(h, ul);
  return box;
}

/** Warnings worth a line on the library card (the rest are MODEL INFO only). */
export const CARD_WARNINGS: ReadonlySet<ModelWarning['code']> = new Set(['face-backwards', 'faces-away', 'missing-bones', 'empty-expressions', 'no-expressions']);

export function syncLabel(st: ModelStats): { text: string; title: string } {
  return st.perfectSync >= 40
    ? { text: t('library.sync.perfect', { n: st.perfectSync }), title: t('library.sync.perfectTitle') }
    : {
        text: t('library.sync.presets', { n: st.presets }),
        title: st.perfectSync ? t('library.sync.presetsTitleArkit', { n: st.perfectSync }) : t('library.sync.presetsTitle'),
      };
}

export function buildCard(tpl: HTMLTemplateElement, c: Card, now: number, onStage: boolean): HTMLElement {
  const el = (tpl.content.firstElementChild as HTMLElement).cloneNode(true) as HTMLElement;
  el.dataset.id = c.id;
  const q = <T extends HTMLElement = HTMLElement>(s: string) => el.querySelector(s) as T;
  const name = displayName(c);
  const author = displayAuthor(c.info);
  const aria = [author ? `${name} ${t('library.card.ariaBy', { author })}` : name];
  if (c.entry.favourite) aria.push(t('library.card.ariaFav'));
  aria.push(badgeLabel(c.licence.badge));
  el.setAttribute('aria-label', aria.join(', '));
  el.classList.toggle('fav', c.entry.favourite);
  el.classList.toggle('current', onStage);
  const img = q<HTMLImageElement>('.thumb img');
  if (c.thumbUrl) img.src = c.thumbUrl;
  else el.classList.add('no-img');
  q('.spec').textContent = `VRM ${c.info.spec}`;
  const star = q('.star');
  star.setAttribute('aria-pressed', String(c.entry.favourite));
  star.title = c.entry.favourite ? t('library.card.unfav') : t('card.favTitle');
  q('.name').textContent = name;
  q('.name').title = c.entry.customName ? t('library.card.nameTitle', { name, orig: c.info.meta.name || c.info.fileName }) : name;
  q('.author').textContent = author ? t('library.card.by', { author }) : t('library.card.noAuthor');
  q('.author').classList.toggle('mute', !author);
  const lic = q('.badges .lic');
  lic.textContent = badgeLabel(c.licence.badge);
  lic.className = `lic ${c.licence.tone}`;
  lic.title = c.licence.headline;
  const st = c.info.stats;
  const sync = syncLabel(st);
  q('.b.ps').textContent = sync.text;
  q('.b.ps').title = sync.title;
  q('.b.ps').classList.toggle('hi', st.perfectSync >= 40);
  q('.b.spring').textContent = t('library.card.spring', { n: st.springChains });
  q('.b.spring').title = t('library.card.springTitle', { chains: st.springChains, joints: st.springJoints });
  q('.b.spring').classList.toggle('zero', st.springChains === 0);
  q('.b.poly').textContent = t('library.card.tris', { n: formatCount(st.polygons) });
  q('.b.poly').title = t('library.card.trisTitle', { n: st.polygons.toLocaleString(locale) });
  q('.b.size').textContent = formatBytes(c.size);
  q('.used').textContent = onStage ? t('library.card.onStageNow') : formatAgo(c.entry.lastUsedAt, now);
  q('.used').title = c.entry.lastUsedAt
    ? t('library.card.lastUsed', { date: new Date(c.entry.lastUsedAt).toLocaleString(locale) })
    : t('library.card.added', { date: new Date(c.entry.addedAt).toLocaleString(locale) });
  renderLicence(q('.lic-body'), c.licence, c.info.meta);
  const warn = (st.warnings ?? []).filter((w) => CARD_WARNINGS.has(w.code));
  const wEl = q('.card-warn');
  if (wEl) {
    wEl.textContent = warn.map((w) => `⚠ ${w.text}`).join(' · ');
    wEl.title = warn.map((w) => w.detail).join('\n');
    wEl.classList.toggle('hidden', !warn.length);
  }
  return el;
}
