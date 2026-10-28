/**
 * Physics tab: cloth solver controls. Solver choice, generated body
 * colliders, the cloth groups found on the model (links on/off, stiffness)
 * and per-chain grouping overrides. Rendered into #cloth-ui; per-model
 * values persist through the same overrides as the chain list.
 */
import type { PhysicsSettings, PhysicsSolver, StableSprings } from '../physics/stableSprings';

export interface ClothUiHooks {
  settings: () => PhysicsSettings;
  /** Apply and persist a global physics setting. */
  setSetting: (s: Partial<PhysicsSettings>) => void;
  /** Persist the model's overrides. */
  saveOverrides: () => void;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function buildClothUI(root: HTMLElement, ph: StableSprings | null, hooks: ClothUiHooks): void {
  root.innerHTML = '';
  const st = hooks.settings();

  const solver = document.createElement('label');
  solver.className = 'row';
  solver.innerHTML = `<span class="lbl">SOLVER</span><select><option value="cloth">CLOTH (LINKED CHAINS)</option><option value="legacy">LEGACY (SPRING BONES)</option></select>`;
  const sel = solver.querySelector('select')!;
  sel.value = st.solver;
  sel.addEventListener('change', () => {
    hooks.setSetting({ solver: sel.value as PhysicsSolver });
    buildClothUI(root, ph, hooks);
  });
  root.append(solver);

  const body = document.createElement('label');
  body.className = 'check';
  body.innerHTML = `<input type="checkbox" /><span>BODY COLLIDERS (FITTED TO THE MESH)</span>`;
  const bcb = body.querySelector('input')!;
  bcb.checked = st.bodyColliders;
  bcb.disabled = st.solver !== 'cloth';
  bcb.addEventListener('change', () => hooks.setSetting({ bodyColliders: bcb.checked }));
  root.append(body);

  if (!ph || st.solver !== 'cloth') return;
  const groups = ph.groups;
  const h = document.createElement('h3');
  h.innerHTML = `CLOTH GROUPS <span>[${groups.length}]</span>`;
  root.append(h);
  const list = document.createElement('div');
  list.className = 'chain-list';
  if (!groups.length) list.innerHTML = '<span class="empty-note">NO NEIGHBOURING CHAINS: ALL SINGLE STRANDS</span>';
  for (const g of groups) {
    const o = ph.groupOverride(g.name);
    const row = document.createElement('div');
    row.className = `group-row${o.enabled ? '' : ' off'}`;
    row.innerHTML = `<input type="checkbox" title="link the chains into cloth" /><span class="name" title="${esc(g.name)}">${esc(g.name)} <small>${g.kind.toUpperCase()}${g.closed ? ' RING' : ''} ×${g.chains.length}</small></span><input type="number" step="0.1" min="0.1" max="10" title="link stiffness ×" />`;
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
  det.innerHTML = `<summary>CHAIN GROUPING</summary>`;
  // Custom groups: chains given the same letter are linked as one sheet.
  const names = ['group A', 'group B', 'group C', 'group D'];
  for (const ch of ph.chains) {
    const row = document.createElement('label');
    row.className = 'row';
    const cur = ph.chainAssign(ch.name);
    const opts = ['auto', 'none', ...names, ...(cur !== 'auto' && cur !== 'none' && !names.includes(cur) ? [cur] : [])];
    row.innerHTML = `<span class="lbl" title="${esc(ch.name)}">${esc(ch.name)}</span><select>${opts
      .map((n) => `<option value="${esc(n)}">${n === 'auto' ? 'AUTO' : n === 'none' ? 'SINGLE STRAND' : esc(n.toUpperCase())}</option>`)
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
