/**
 * Physics tab: cloth solver controls. Solver choice, generated body
 * colliders, the cloth groups found on the model (links on/off, stiffness)
 * and per-chain grouping overrides. Rendered into #cloth-ui; per-model
 * values persist through the same overrides as the chain list.
 */
import type { PhysicsSettings, PhysicsSolver, StableSprings } from '../physics/stableSprings';
import type { GroupKind } from '../physics/cloth/groups';
import { t } from '../i18n';

export interface ClothUiHooks {
  settings: () => PhysicsSettings;
  /** Apply and persist a global physics setting. */
  setSetting: (s: Partial<PhysicsSettings>) => void;
  /** Persist the model's overrides. */
  saveOverrides: () => void;
}

const KIND = {
  skirt: 'stage.kindSkirt',
  cape: 'stage.kindCape',
  hair: 'stage.kindHair',
  sleeve: 'stage.kindSleeve',
  other: 'stage.kindOther',
} as const satisfies Record<GroupKind, string>;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function buildClothUI(root: HTMLElement, ph: StableSprings | null, hooks: ClothUiHooks): void {
  root.innerHTML = '';
  const st = hooks.settings();

  const solver = document.createElement('label');
  solver.className = 'row';
  solver.innerHTML = `<span class="lbl">${t('stage.solver')}</span><select><option value="cloth">${t('stage.solverCloth')}</option><option value="legacy">${t('stage.solverLegacy')}</option></select>`;
  const sel = solver.querySelector('select')!;
  sel.value = st.solver;
  sel.addEventListener('change', () => {
    hooks.setSetting({ solver: sel.value as PhysicsSolver });
    buildClothUI(root, ph, hooks);
  });
  root.append(solver);

  const body = document.createElement('label');
  body.className = 'check';
  body.innerHTML = `<input type="checkbox" /><span>${t('stage.bodyColliders')}</span>`;
  const bcb = body.querySelector('input')!;
  bcb.checked = st.bodyColliders;
  bcb.disabled = st.solver !== 'cloth';
  bcb.addEventListener('change', () => hooks.setSetting({ bodyColliders: bcb.checked }));
  root.append(body);

  if (!ph || st.solver !== 'cloth') return;
  const groups = ph.groups;
  const h = document.createElement('h3');
  h.innerHTML = t('stage.clothGroups', { n: groups.length });
  root.append(h);
  const list = document.createElement('div');
  list.className = 'chain-list';
  if (!groups.length) list.innerHTML = `<span class="empty-note">${t('stage.noClothGroups')}</span>`;
  for (const g of groups) {
    const o = ph.groupOverride(g.name);
    const row = document.createElement('div');
    row.className = `group-row${o.enabled ? '' : ' off'}`;
    row.innerHTML = `<input type="checkbox" title="${t('stage.linkTitle')}" /><span class="name" title="${esc(g.name)}">${esc(g.name)} <small>${t(KIND[g.kind] ?? KIND.other)}${g.closed ? ` ${t('stage.ring')}` : ''} ×${g.chains.length}</small></span><input type="number" step="0.1" min="0.1" max="10" title="${t('stage.linkStiffTitle')}" />`;
    const [on, k] = row.querySelectorAll('input');
    on.checked = o.enabled;
    k.value = String(o.stiffness);
    on.addEventListener('change', () => {
      ph.setGroup(g.name, { enabled: on.checked });
      row.classList.toggle('off', !on.checked);
      hooks.saveOverrides();
    });
    k.addEventListener('change', () => {
      ph.setGroup(g.name, { stiffness: Math.max(0.1, Number(k.value) || 1) });
      hooks.saveOverrides();
    });
    list.append(row);
  }
  root.append(list);

  // Grouping overrides, per chain (collapsed: long on most models).
  const det = document.createElement('details');
  det.className = 'grouping';
  det.innerHTML = `<summary>${t('stage.chainGrouping')}</summary>`;
  // Custom groups: chains given the same letter are linked as one sheet.
  const names = ['group A', 'group B', 'group C', 'group D'];
  const optLabel = (n: string) =>
    n === 'auto' ? t('stage.groupAuto') : n === 'none' ? t('stage.singleStrand') : /^group [A-Z]$/.test(n) ? t('stage.groupN', { g: n.slice(6) }) : esc(n.toUpperCase());
  for (const ch of ph.chains) {
    const row = document.createElement('label');
    row.className = 'row';
    const cur = ph.chainAssign(ch.name);
    const opts = ['auto', 'none', ...names, ...(cur !== 'auto' && cur !== 'none' && !names.includes(cur) ? [cur] : [])];
    row.innerHTML = `<span class="lbl" title="${esc(ch.name)}">${esc(ch.name)}</span><select>${opts
      .map((n) => `<option value="${esc(n)}">${optLabel(n)}</option>`)
      .join('')}</select>`;
    const s = row.querySelector('select')!;
    s.value = cur;
    s.addEventListener('change', () => {
      ph.setChainAssign(ch.name, s.value);
      hooks.saveOverrides();
      buildClothUI(root, ph, hooks);
      (root.querySelector('details.grouping') as HTMLDetailsElement | null)?.setAttribute('open', '');
    });
    det.append(row);
  }
  root.append(det);
}
