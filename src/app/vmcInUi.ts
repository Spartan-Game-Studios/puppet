/**
 * VMC IN section of the VMC window: receive a pose from body trackers
 * (SlimeVR, mocopi), iPhone face apps or any VMC sender, and pick per body
 * region whether it or the webcam drives the avatar. Owns the polling: call
 * `tick()` once per render frame, before `avatar.update()`.
 *
 *   const vmcIn = mountVmcIn({ settings, persist, avatar: () => avatar, mount });
 */
import { t, type Key } from '../i18n';
import { REGIONS, VmcInput, type Region, type VmcInFrame } from '../vmc/vmcInput';
import { isTauri, vmcInConfigure, vmcInPoll, vmcInStatus, type VmcInStatus } from './platform';
import type { Settings } from './settings';
import type { Avatar } from '../scene/avatar';

export interface VmcInDeps {
  settings: Settings;
  persist(): void;
  avatar(): Avatar | null;
  setStatus(s: string, err?: boolean): void;
  mount: HTMLElement | null;
}

export interface VmcIn {
  readonly input: VmcInput;
  tick(): void;
  /** Feed a frame as if it arrived (browser tests, replaying captures). */
  inject(frame: VmcInFrame): void;
  /** Re-apply settings (e.g. after the VMC output changed). */
  apply(): Promise<void>;
  /** Stop listening (the demo lock). */
  stop(): void;
}

const REGION_KEY: Record<Region, Key> = {
  face: 'vmcin.region.face',
  head: 'vmcin.region.head',
  torso: 'vmcin.region.torso',
  arms: 'vmcin.region.arms',
  fingers: 'vmcin.region.fingers',
  legs: 'vmcin.region.legs',
};

const isLocal = (h: string) => /^(127\.|localhost$|::1$|0\.0\.0\.0$)/.test(h.trim());

export function mountVmcIn(deps: VmcInDeps): VmcIn {
  const s = deps.settings;
  const input = new VmcInput();
  const root = deps.mount ?? document.createElement('div');
  root.innerHTML = `
    <label class="check"><input type="checkbox" class="vi-enabled" /><span>${t('vmcin.enable')}</span></label>
    <p class="note mute">${t('vmcin.note')}</p>
    <label class="row"><span class="lbl">${t('vmc.port')}</span><input type="number" class="vi-port" min="1" max="65535" /></label>
    <label class="check" title="${t('vmcin.lanTitle')}"><input type="checkbox" class="vi-lan" /><span>${t('vmcin.lan')}</span></label>
    <div class="row"><span class="lbl">${t('vcam.state')}</span><span class="val vi-state">-</span></div>
    <div class="row"><span class="lbl">${t('vmcin.got')}</span><span class="val vi-got">-</span></div>
    <h3>${t('vmcin.drives')}</h3>
    ${REGIONS.map(
      (r) => `<div class="row"><span class="lbl">${t(REGION_KEY[r])}</span>
        <div class="seg vi-region" data-region="${r}" role="radiogroup" aria-label="${t(REGION_KEY[r])}">
          <button type="button" data-value="webcam">${t('vmcin.webcam')}</button><button type="button" data-value="vmc">VMC</button>
        </div></div>`,
    ).join('')}`;
  const q = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;
  const enabled = q<HTMLInputElement>('.vi-enabled');
  const port = q<HTMLInputElement>('.vi-port');
  const lan = q<HTMLInputElement>('.vi-lan');
  const state = q<HTMLElement>('.vi-state');
  const got = q<HTMLElement>('.vi-got');

  let status: VmcInStatus | null = null;
  let error = '';
  let seq = 0;
  let polling = false;
  /** The demo lock: listening off for this session, the setting kept. */
  let stopped = false;

  function refresh(): void {
    enabled.checked = s.vmcIn.enabled;
    port.value = String(s.vmcIn.port);
    lan.checked = s.vmcIn.lan;
    for (const seg of root.querySelectorAll<HTMLElement>('.vi-region')) {
      const v = s.vmcIn.regions[seg.dataset.region as Region];
      for (const b of seg.querySelectorAll<HTMLElement>('button')) b.classList.toggle('on', b.dataset.value === v);
    }
  }

  function render(): void {
    const live = input.live();
    if (!s.vmcIn.enabled) state.textContent = t('vcam.off');
    else if (error) state.textContent = error;
    else if (!isTauri && !live) state.textContent = t('mcp.desktopOnly');
    else if (live) state.textContent = t('vmcin.receiving', { rate: Math.round(status?.rate ?? 0), from: status?.sender ?? '-' });
    else state.textContent = t('vmcin.listening', { addr: status?.listening ?? `:${s.vmcIn.port}` });
    state.classList.toggle('status-err', !!error);
    state.classList.toggle('state-run', live);
    const f = input.frame;
    got.textContent = f && live ? t('vmcin.counts', { bones: Object.keys(f.bones).length, blends: Object.keys(f.blends).length }) : '-';
  }

  async function apply(): Promise<void> {
    error = '';
    seq = 0;
    const v = s.vmcIn;
    // VPuppet's own VMC output aimed at this port on this computer would loop (and the port is taken).
    if (v.enabled && s.vmc.enabled && s.vmc.port === v.port && isLocal(s.vmc.host)) {
      error = t('vmcin.loop', { port: v.port });
      render();
      return;
    }
    try {
      status = await vmcInConfigure(v.enabled, v.port, v.lan);
    } catch (e) {
      error = String((e as Error).message ?? e).toUpperCase();
      deps.setStatus(`VMC IN: ${error}`, true);
    }
    render();
  }

  enabled.addEventListener('change', () => {
    s.vmcIn.enabled = enabled.checked;
    deps.persist();
    apply();
  });
  port.addEventListener('change', () => {
    const p = Math.round(Number(port.value));
    s.vmcIn.port = p > 0 && p < 65536 ? p : 39539;
    port.value = String(s.vmcIn.port);
    deps.persist();
    apply();
  });
  lan.addEventListener('change', () => {
    s.vmcIn.lan = lan.checked;
    deps.persist();
    apply();
  });
  root.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('.vi-region button');
    if (!b) return;
    const r = b.closest<HTMLElement>('.vi-region')!.dataset.region as Region;
    s.vmcIn.regions[r] = b.dataset.value as 'webcam' | 'vmc';
    deps.persist();
    refresh();
  });

  setInterval(async () => {
    if (s.vmcIn.enabled && isTauri) status = await vmcInStatus().catch(() => status);
    render();
  }, 1000);

  refresh();
  if (s.vmcIn.enabled) apply();
  else render();

  return {
    input,
    tick() {
      const a = deps.avatar();
      if (s.vmcIn.enabled && isTauri && !polling && !error && !stopped) {
        polling = true;
        vmcInPoll(seq)
          .then((f) => {
            if (f) {
              seq = f.seq;
              input.set(f);
            }
          })
          .catch(() => {})
          .finally(() => (polling = false));
      }
      if (a) a.external = s.vmcIn.enabled && !stopped ? input.pose(s.vmcIn.regions, a) : null;
    },
    inject(frame) {
      input.set(frame);
    },
    apply,
    stop() {
      stopped = true;
      input.frame = null;
      vmcInConfigure(false, s.vmcIn.port, s.vmcIn.lan).catch(() => {});
    },
  };
}
