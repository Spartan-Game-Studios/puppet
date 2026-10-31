/**
 * MODEL DOCTOR window (library card menu → MODEL DOCTOR): fix a library
 * model's perfect sync and set the terms of a model you own, then save the
 * result as a new library model or export it as a .vrm. The original entry is
 * never changed. The edits themselves are src/vrm/doctor.ts.
 *
 *   const doc = mountDoctor({ library, setStatus, onSaved });
 *   doc.open(cardId);
 */
import './doctor.css';
import { t, type Key } from '../i18n';
import type { Library } from '../library/library';
import { parseVrmMeta, summarizeLicence } from '../library/vrmMeta';
import { doctor, planArkit, TERMS_PRESETS, type ArkitFix, type ArkitPlan, type DoctorEdit, type TermsPreset } from '../vrm/doctor';
import { readGlb, writeGlb, type Glb } from '../vrm/glb';
import { createModal } from './modal';
import { isTauri } from './platform';

export interface DoctorDeps {
  library: Library;
  setStatus(s: string, err?: boolean): void;
  /** A new model was added to the library from the doctor. */
  onSaved?(id: string): void;
}

export interface Doctor {
  open(id: string): Promise<void>;
}

const TERMS_KEY: Record<TermsPreset, Key> = {
  cc0: 'doctor.terms.cc0',
  ccby: 'doctor.terms.ccby',
  personal: 'doctor.terms.personal',
  authorOnly: 'doctor.terms.authorOnly',
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

export function mountDoctor(deps: DoctorDeps): Doctor {
  const body = document.createElement('div');
  body.className = 'doctor';
  body.innerHTML = `
    <section class="block">
      <h2><span class="idx">D1</span>${t('doctor.sync')}</h2>
      <div class="row"><span class="lbl">ARKIT</span><span class="val doc-sum"></span></div>
      <p class="note mute">${t('doctor.syncNote')}</p>
      <div class="doc-fixes" role="group" aria-label="${esc(t('doctor.sync'))}"></div>
      <div class="row btns doc-fix-btns">
        <button type="button" class="btn ghost doc-all">${t('doctor.all')}</button>
        <button type="button" class="btn ghost doc-none">${t('doctor.none')}</button>
      </div>
    </section>
    <section class="block">
      <h2><span class="idx">D2</span>${t('doctor.licence')}</h2>
      <div class="row"><span class="lbl">${t('doctor.now')}</span><span class="val doc-lic"></span></div>
      <label class="check"><input type="checkbox" class="doc-own" /><span>${t('doctor.own')}</span></label>
      <p class="note mute">${t('doctor.ownNote')}</p>
      <fieldset class="doc-terms" disabled>
        <label class="row"><span class="lbl">${t('doctor.name')}</span><input type="text" class="doc-name" spellcheck="false" /></label>
        <label class="row"><span class="lbl">${t('doctor.authors')}</span><input type="text" class="doc-authors" spellcheck="false" /></label>
        <label class="row"><span class="lbl">${t('doctor.version')}</span><input type="text" class="doc-version" spellcheck="false" /></label>
        <label class="row"><span class="lbl">${t('doctor.terms')}</span><select class="doc-preset">${TERMS_PRESETS.map((p) => `<option value="${p}">${t(TERMS_KEY[p])}</option>`).join('')}</select></label>
      </fieldset>
    </section>
    <div class="row btns doc-out">
      <button type="button" class="btn accent doc-save">${t('doctor.save')}</button>
      <button type="button" class="btn doc-export">${t('doctor.export')}</button>
    </div>
    <p class="note doc-result" role="status"></p>`;

  const modal = createModal({ id: 'modal-doctor', idx: 'D', title: t('doctor.title'), content: [body] });
  const q = <T extends HTMLElement>(sel: string) => body.querySelector(sel) as T;
  const sum = q<HTMLElement>('.doc-sum');
  const fixesEl = q<HTMLElement>('.doc-fixes');
  const lic = q<HTMLElement>('.doc-lic');
  const own = q<HTMLInputElement>('.doc-own');
  const terms = q<HTMLFieldSetElement>('.doc-terms');
  const name = q<HTMLInputElement>('.doc-name');
  const authors = q<HTMLInputElement>('.doc-authors');
  const version = q<HTMLInputElement>('.doc-version');
  const preset = q<HTMLSelectElement>('.doc-preset');
  const result = q<HTMLElement>('.doc-result');
  const saveBtn = q<HTMLButtonElement>('.doc-save');
  const exportBtn = q<HTMLButtonElement>('.doc-export');

  let glb: Glb | null = null;
  let plan: ArkitPlan | null = null;
  let fileBase = 'model';

  function renderPlan(p: ArkitPlan): void {
    sum.textContent = t('doctor.summary', { have: p.have.length, fix: p.fixes.length, missing: p.missing.length });
    q<HTMLElement>('.doc-fix-btns').classList.toggle('hidden', !p.fixes.length);
    fixesEl.innerHTML = p.fixes.length
      ? p.fixes
          .map(
            (f, i) => `<label class="doc-fix"><input type="checkbox" data-i="${i}" checked />
              <b>${f.arkit}</b><span class="from">← ${esc(f.kind === 'rename' ? f.expression : f.morph)}</span>
              <i class="${f.kind}">${t(f.kind === 'rename' ? 'doctor.rename' : 'doctor.create')}</i></label>`,
          )
          .join('')
      : `<p class="note">${t(p.have.length >= 51 ? 'doctor.complete' : 'doctor.nothing')}</p>`;
  }

  function chosen(): ArkitFix[] {
    if (!plan) return [];
    return [...fixesEl.querySelectorAll<HTMLInputElement>('input[data-i]:checked')].map((el) => plan!.fixes[Number(el.dataset.i)]);
  }

  function edit(): DoctorEdit | null {
    const e: DoctorEdit = { arkit: chosen() };
    if (own.checked) {
      e.terms = {
        preset: preset.value as TermsPreset,
        name: name.value.trim(),
        authors: authors.value.split(',').map((s) => s.trim()),
        version: version.value.trim(),
      };
    }
    return e.arkit!.length || e.terms ? e : null;
  }

  function build(): ArrayBuffer | null {
    const e = edit();
    if (!glb || !e) {
      result.textContent = t('doctor.noChanges');
      return null;
    }
    return writeGlb(doctor(glb, e));
  }

  own.addEventListener('change', () => (terms.disabled = !own.checked));
  q('.doc-all').addEventListener('click', () => fixesEl.querySelectorAll<HTMLInputElement>('input').forEach((el) => (el.checked = true)));
  q('.doc-none').addEventListener('click', () => fixesEl.querySelectorAll<HTMLInputElement>('input').forEach((el) => (el.checked = false)));

  saveBtn.addEventListener('click', async () => {
    const bytes = build();
    if (!bytes) return;
    saveBtn.disabled = true;
    result.textContent = t('doctor.saving');
    try {
      const r = await deps.library.import({ name: `${fileBase}-doctor.vrm`, bytes });
      if (r.status === 'error') throw new Error(r.error);
      result.textContent = t(r.status === 'added' ? 'doctor.saved' : 'doctor.savedDup');
      deps.setStatus(t('doctor.saved'));
      if (r.id) deps.onSaved?.(r.id);
    } catch (e) {
      result.textContent = t('doctor.failed', { msg: (e as Error).message });
    } finally {
      saveBtn.disabled = false;
    }
  });

  exportBtn.addEventListener('click', async () => {
    const bytes = build();
    if (!bytes) return;
    const file = `${fileBase}-doctor.vrm`;
    try {
      if (isTauri) {
        const { invoke } = await import('@tauri-apps/api/core');
        const path = await invoke<string | null>('save_vrm_as', new Uint8Array(bytes), { headers: { 'x-name': file } });
        result.textContent = path ? t('doctor.exported', { path }) : '';
      } else {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([bytes], { type: 'model/gltf-binary' }));
        a.download = file;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
        result.textContent = t('doctor.exported', { path: file });
      }
    } catch (e) {
      result.textContent = t('doctor.failed', { msg: String((e as Error).message ?? e) });
    }
  });

  return {
    async open(id) {
      const card = deps.library.cards.get(id);
      if (!card) return;
      result.textContent = '';
      fixesEl.innerHTML = '';
      sum.textContent = '…';
      modal.extra.textContent = card.entry.customName || card.info.meta.name || card.info.fileName;
      fileBase = card.info.fileName.replace(/\.vrm$/i, '').replace(/-doctor$/, '') || 'model';
      const meta = card.info.meta;
      lic.textContent = card.licence.headline;
      own.checked = false;
      terms.disabled = true;
      name.value = meta.name;
      authors.value = meta.authors.join(', ');
      version.value = meta.version;
      preset.value = 'personal';
      modal.show();
      try {
        glb = readGlb(await deps.library.readModel(id));
        plan = planArkit(glb.json);
        // The stored meta is a parse of this same file; re-read in case the index is stale.
        lic.textContent = summarizeLicence(parseVrmMeta(glb.json)).headline;
        renderPlan(plan);
      } catch (e) {
        glb = plan = null;
        sum.textContent = '-';
        result.textContent = t('doctor.failed', { msg: (e as Error).message });
      }
    },
  };
}
