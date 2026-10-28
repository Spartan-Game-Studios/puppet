/** 09 LIP SYNC panel: mode, microphone picker, gate and gain, level meter. */
import { listMics } from './mic';
import { LIPSYNC_MODES, type LipSync, type LipSyncSettings } from './lipsync';
import { VISEMES } from './visemes';

export interface LipSyncPanelContext {
  host: HTMLElement;
  lipsync: LipSync;
  settings: LipSyncSettings;
  persist: () => void;
  setStatus: (s: string, err?: boolean) => void;
}

export function mountLipSyncPanel(ctx: LipSyncPanelContext): { meter: () => void; apply: () => Promise<void> } {
  const { host, lipsync, settings } = ctx;
  host.innerHTML = `
    <h2><span class="idx">09</span>LIP SYNC</h2>
    <div class="seg" id="ls-mode" role="radiogroup">
      ${LIPSYNC_MODES.map((m) => `<button data-value="${m}" title="${{ off: 'Microphone off', fallback: 'Audio drives the mouth only while the face is not tracked', blend: 'Larger of tracked and audio mouth', audio: 'Audio only drives the mouth' }[m]}">${m === 'fallback' ? 'FALLBK' : m.toUpperCase()}</button>`).join('')}
    </div>
    <label class="row"><span class="lbl">MIC</span><select id="ls-device"><option value="">DEFAULT</option></select></label>
    <label class="slider"><span class="lbl">GATE DB</span><input type="range" id="ls-gate" min="-80" max="-20" step="1" /><output id="ls-gate-out"></output></label>
    <label class="slider"><span class="lbl">GAIN</span><input type="range" id="ls-gain" min="0.25" max="3" step="0.05" /><output id="ls-gain-out"></output></label>
    <div class="ls-meter" title="Input level (orange tick: gate)"><div class="lvl"></div><div class="gate"></div></div>
    <div class="ls-visemes">${[...VISEMES, 'jaw'].map((v) => `<span data-v="${v}"><i></i><b>${v.toUpperCase()}</b></span>`).join('')}</div>
    <div class="row"><span class="lbl">STATE</span><span class="val" id="ls-state">OFF</span></div>`;
  const $ = <T extends HTMLElement>(s: string) => host.querySelector<T>(s)!;
  const modeEl = $('#ls-mode');
  const dev = $<HTMLSelectElement>('#ls-device');
  const gate = $<HTMLInputElement>('#ls-gate');
  const gain = $<HTMLInputElement>('#ls-gain');
  const lvl = $('.ls-meter .lvl');
  const gateTick = $('.ls-meter .gate');
  const state = $('#ls-state');
  const bars = new Map([...host.querySelectorAll<HTMLElement>('.ls-visemes span')].map((s) => [s.dataset.v!, s.querySelector('i') as HTMLElement]));

  const segSet = () => modeEl.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.value === settings.mode));
  const sliders = () => {
    gate.value = String(settings.gateDb);
    gain.value = String(settings.gain);
    $('#ls-gate-out').textContent = String(settings.gateDb);
    $('#ls-gain-out').textContent = settings.gain.toFixed(2);
    gateTick.style.left = `${((settings.gateDb + 80) / 80) * 100}%`;
    lipsync.mic.opts.gateDb = settings.gateDb;
    lipsync.mic.opts.gain = settings.gain;
  };

  async function refreshDevices(): Promise<void> {
    const mics = await listMics();
    dev.innerHTML = '<option value="">DEFAULT</option>';
    for (const m of mics) dev.append(new Option(m.label, m.id));
    if (settings.deviceId && mics.some((m) => m.id === settings.deviceId)) dev.value = settings.deviceId;
  }

  /** Start / stop the mic to match the settings (asks for permission the first time). */
  async function apply(): Promise<void> {
    lipsync.mode = settings.mode;
    sliders();
    if (settings.mode === 'off') {
      lipsync.mic.stop();
      state.textContent = 'OFF';
      return;
    }
    try {
      if (!lipsync.mic.running || dev.dataset.started !== (settings.deviceId ?? '')) {
        await lipsync.mic.start(settings.deviceId);
        dev.dataset.started = settings.deviceId ?? '';
        await refreshDevices();
      }
      state.textContent = `${settings.mode.toUpperCase()}: ${(lipsync.mic.label || 'MIC').toUpperCase()}`;
    } catch (e) {
      const err = e as DOMException;
      const msg = err.name === 'NotAllowedError' ? 'MIC BLOCKED: ALLOW PUPPET IN SYSTEM SETTINGS > PRIVACY > MICROPHONE' : err.name === 'NotFoundError' ? 'NO MICROPHONE FOUND' : `MIC: ${err.message}`;
      state.textContent = msg;
      ctx.setStatus(msg, true);
    }
  }

  modeEl.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b?.dataset.value) return;
    settings.mode = b.dataset.value as LipSyncSettings['mode'];
    segSet();
    ctx.persist();
    void apply();
  });
  dev.addEventListener('change', () => {
    settings.deviceId = dev.value || null;
    ctx.persist();
    if (settings.mode !== 'off') void apply();
  });
  gate.addEventListener('input', () => {
    settings.gateDb = Number(gate.value);
    sliders();
    ctx.persist();
  });
  gain.addEventListener('input', () => {
    settings.gain = Number(gain.value);
    sliders();
    ctx.persist();
  });
  segSet();
  sliders();
  void refreshDevices();

  function meter(): void {
    const r = lipsync.mic.raw;
    const s = lipsync.shapes;
    const db = Number.isFinite(r.db) ? r.db : -80;
    lvl.style.width = `${Math.max(0, Math.min(100, ((db + 80) / 80) * 100)).toFixed(1)}%`;
    for (const v of VISEMES) bars.get(v)!.style.height = `${((s?.visemes[v] ?? 0) * 100).toFixed(0)}%`;
    bars.get('jaw')!.style.height = `${((s?.arkit.jawOpen ?? 0) * 100).toFixed(0)}%`;
  }
  return { meter, apply };
}
