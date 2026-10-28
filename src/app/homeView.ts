/** DOM builders for the home screen: model cards (from #tpl-card) and licence panels. */
import { displayAuthor, displayName, formatAgo, formatBytes, formatCount } from '../library/libraryIndex';
import type { Card } from '../library/library';
import type { LicenceSummary, VrmMeta } from '../library/vrmMeta';
import type { ModelStats } from '../library/libraryIndex';

const MARK: Record<string, string> = { yes: '✓', no: '✕', '?': '?', '': '' };

/** Plain-language licence rows into `el`. */
export function renderLicence(el: HTMLElement, s: LicenceSummary, meta: VrmMeta): void {
  el.innerHTML = '';
  const head = document.createElement('div');
  head.className = `lic-head tone-${s.tone}`;
  const badge = document.createElement('span');
  badge.className = `lic ${s.tone}`;
  badge.textContent = s.badge;
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
  foot.textContent = `VRM ${meta.spec}${meta.version ? ` · MODEL VERSION ${meta.version}` : ''} · READ FROM THE MODEL'S OWN METADATA. INFORMATION, NOT LEGAL ADVICE: PUPPET NEVER BLOCKS A MODEL.`;
  el.append(foot);
}

export function syncLabel(st: ModelStats): { text: string; title: string } {
  return st.perfectSync >= 40
    ? { text: `PERFECT SYNC ${st.perfectSync}/52`, title: 'ARKit expressions: drives the face 1:1' }
    : { text: `PRESETS ${st.presets}/13`, title: `VRM preset expressions${st.perfectSync ? ` (ARKit ${st.perfectSync}/52)` : ''}` };
}

export function buildCard(tpl: HTMLTemplateElement, c: Card, now: number, onStage: boolean): HTMLElement {
  const el = (tpl.content.firstElementChild as HTMLElement).cloneNode(true) as HTMLElement;
  el.dataset.id = c.id;
  const q = <T extends HTMLElement = HTMLElement>(s: string) => el.querySelector(s) as T;
  const name = displayName(c);
  const author = displayAuthor(c.info);
  el.setAttribute('aria-label', `${name}${author ? ` by ${author}` : ''}${c.entry.favourite ? ', favourite' : ''}, ${c.licence.badge}`);
  el.classList.toggle('fav', c.entry.favourite);
  el.classList.toggle('current', onStage);
  const img = q<HTMLImageElement>('.thumb img');
  if (c.thumbUrl) img.src = c.thumbUrl;
  else el.classList.add('no-img');
  q('.spec').textContent = `VRM ${c.info.spec}`;
  const star = q('.star');
  star.setAttribute('aria-pressed', String(c.entry.favourite));
  star.title = c.entry.favourite ? 'Unfavourite (S)' : 'Favourite (S)';
  q('.name').textContent = name;
  q('.name').title = c.entry.customName ? `${name} (model calls itself “${c.info.meta.name || c.info.fileName}”)` : name;
  q('.author').textContent = author ? `BY ${author}` : 'AUTHOR NOT STATED';
  q('.author').classList.toggle('mute', !author);
  const lic = q('.badges .lic');
  lic.textContent = c.licence.badge;
  lic.className = `lic ${c.licence.tone}`;
  lic.title = c.licence.headline;
  const st = c.info.stats;
  const sync = syncLabel(st);
  q('.b.ps').textContent = sync.text;
  q('.b.ps').title = sync.title;
  q('.b.ps').classList.toggle('hi', st.perfectSync >= 40);
  q('.b.spring').textContent = `SPRING ${st.springChains}`;
  q('.b.spring').title = `${st.springChains} spring-bone chains, ${st.springJoints} joints`;
  q('.b.spring').classList.toggle('zero', st.springChains === 0);
  q('.b.poly').textContent = `${formatCount(st.polygons)} TRIS`;
  q('.b.poly').title = `${st.polygons.toLocaleString('en')} triangles`;
  q('.b.size').textContent = formatBytes(c.size);
  q('.used').textContent = onStage ? 'ON STAGE NOW' : formatAgo(c.entry.lastUsedAt, now);
  q('.used').title = c.entry.lastUsedAt ? `Last used ${new Date(c.entry.lastUsedAt).toLocaleString()}` : `Added ${new Date(c.entry.addedAt).toLocaleString()}`;
  renderLicence(q('.lic-body'), c.licence, c.info.meta);
  return el;
}
