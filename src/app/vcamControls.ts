/**
 * Virtual camera controls: the camera output ON/OFF switch and, on macOS, the
 * camera extension's status line with INSTALL / UPDATE, OPEN SETTINGS and
 * UNINSTALL (with a confirm step).
 *
 * Self-contained so it can live anywhere (today: panel 06 VIRTUAL CAM; the
 * camera preview card later):
 *
 *   mountVcamControls(container)
 *
 * builds its own markup into `container`, polls the extension status itself,
 * and needs nothing from main.ts. The switch is the `#vcam-enabled` checkbox
 * that main.ts already binds (`checkBind`, the W key, `refreshInputs`), so
 * mount it before those run. `toggleVcamOutput()` flips it from anywhere (the
 * CAMERA ON/OFF hotkey action, gamepad START by default).
 *
 * Everything is a real <button> / <input>: Tab reaches it, Enter / Space
 * press it, Escape cancels a pending UNINSTALL.
 */
import './vcamControls.css';
import {
  isTauri,
  vcamExtInstall,
  vcamExtOpenSettings,
  vcamExtStatus,
  vcamExtUninstall,
  type VcamExtStatus,
} from './platform';
import { t } from '../i18n';

const TEMPLATE = `
<label class="check vc-switch"><input type="checkbox" id="vcam-enabled" /><span>${t('stage.camOutput')}</span><b class="vc-onoff" aria-hidden="true" data-on="${t('stage.on')}" data-off="${t('stage.off')}"></b><kbd>W</kbd></label>
<div class="vc-ext hidden">
  <div class="row"><span class="lbl">${t('stage.extension')}</span><span class="val vc-ext-detail" title="">-</span></div>
  <p class="note mute vc-ext-note"></p>
  <div class="row btns">
    <button type="button" class="btn vc-install hidden">${t('stage.install')}</button>
    <button type="button" class="btn vc-settings hidden">${t('stage.openSettings')}</button>
    <button type="button" class="btn ghost vc-uninstall hidden">${t('stage.uninstall')}</button>
  </div>
</div>`;

/** Plain-language follow-up for states that need the user to do something. */
const NOTES: Partial<Record<VcamExtStatus['state'], string>> = {
  not_installed: t('stage.extNotInstalled'),
  awaiting_approval: t('stage.extAwaiting'),
  needs_update: t('stage.extNeedsUpdate'),
  needs_reboot: t('stage.extNeedsReboot'),
  active: t('stage.extActive'),
};

/** Seconds the UNINSTALL button waits for its confirming second press. */
const CONFIRM_S = 5;

export function toggleVcamOutput(): void {
  const el = document.getElementById('vcam-enabled') as HTMLInputElement | null;
  if (!el || el.disabled) return;
  el.checked = !el.checked;
  el.dispatchEvent(new Event('change'));
}

export interface VcamControls {
  /** Re-read the extension status now. */
  refresh: () => Promise<void>;
  dispose: () => void;
}

export function mountVcamControls(container: HTMLElement): VcamControls {
  container.classList.add('vcam-controls');
  container.innerHTML = TEMPLATE;
  const q = <T extends HTMLElement>(sel: string) => container.querySelector(sel) as T;
  const ext = q<HTMLElement>('.vc-ext');
  const detail = q<HTMLElement>('.vc-ext-detail');
  const note = q<HTMLElement>('.vc-ext-note');
  const install = q<HTMLButtonElement>('.vc-install');
  const settingsBtn = q<HTMLButtonElement>('.vc-settings');
  const uninstall = q<HTMLButtonElement>('.vc-uninstall');

  let last: VcamExtStatus | null = null;
  let armed: number | null = null;
  let error = '';

  const disarm = () => {
    if (armed !== null) clearTimeout(armed);
    armed = null;
    uninstall.textContent = t('stage.uninstall');
    uninstall.classList.remove('on');
  };

  function render(st: VcamExtStatus | null): void {
    // No camera extension on this OS / in the browser: only the switch shows.
    ext.classList.toggle('hidden', !st);
    if (!st) return;
    detail.textContent = error || st.detail;
    detail.title = st.installed_version || st.bundled_version ? t('stage.extVersions', { installed: st.installed_version ?? '-', bundled: st.bundled_version ?? '-' }) : '';
    detail.classList.toggle('state-run', st.state === 'active');
    detail.classList.toggle('status-err', !!error || st.state === 'failed' || st.state === 'needs_update');
    note.textContent = NOTES[st.state] ?? '';
    install.textContent = st.install ?? t('stage.install');
    install.classList.toggle('hidden', !st.install);
    install.classList.toggle('accent', st.state === 'needs_update');
    settingsBtn.classList.toggle('hidden', !st.open_settings);
    uninstall.classList.toggle('hidden', !st.can_uninstall);
    if (!st.can_uninstall) disarm();
  }

  async function refresh(): Promise<void> {
    if (!isTauri) return render(null);
    last = await vcamExtStatus().catch((e) => {
      error = String(e).toUpperCase();
      return last;
    });
    render(last);
  }

  /** Activation / deactivation finish asynchronously: poll faster for a while. */
  function burst(): void {
    for (let i = 1; i <= 20; i++) setTimeout(refresh, 1000 * i);
  }

  async function run(btn: HTMLButtonElement, f: () => Promise<void>): Promise<void> {
    btn.disabled = true;
    error = '';
    try {
      await f();
    } catch (e) {
      error = String(e).toUpperCase();
    } finally {
      btn.disabled = false;
    }
    await refresh();
    burst();
  }

  install.addEventListener('click', () => run(install, vcamExtInstall));
  settingsBtn.addEventListener('click', () => run(settingsBtn, vcamExtOpenSettings));
  uninstall.addEventListener('click', () => {
    if (armed === null) {
      uninstall.textContent = t('stage.confirmUninstall');
      uninstall.classList.add('on');
      armed = window.setTimeout(disarm, CONFIRM_S * 1000);
      return;
    }
    disarm();
    // Stop sending first so the output switch reads OFF.
    const sw = document.getElementById('vcam-enabled') as HTMLInputElement | null;
    if (sw?.checked) toggleVcamOutput();
    void run(uninstall, vcamExtUninstall);
  });
  uninstall.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && armed !== null) {
      e.stopPropagation();
      disarm();
    }
  });
  uninstall.addEventListener('blur', disarm);

  const timer = window.setInterval(() => {
    if (!document.body.classList.contains('capture')) void refresh();
  }, 3000);
  void refresh();
  return {
    refresh,
    dispose: () => {
      clearInterval(timer);
      disarm();
      container.innerHTML = '';
    },
  };
}
