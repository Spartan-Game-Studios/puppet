/**
 * Wires animation clips, hotkeys and mic lip sync into the app: 07 MOTION,
 * 08 HOTKEYS and 09 LIP SYNC panels, the on-screen picker, and the
 * AnimLayer on the current avatar. main.ts calls mountMotion() once,
 * attach() when a model loads, and tick() every frame.
 */
import './panels.css';
import type { Settings } from '../app/settings';
import { isTauri, pickBrowserFile, pickPath, readPath, baseName } from '../app/platform';
import type { Avatar } from '../scene/avatar';
import { VRM_PRESETS } from '../core/blendshapes';
import { BONE_MASKS, type BoneMask } from './masks';
import { ClipLibrary, extOf } from './library';
import { AnimLayer } from './player';
import { HotkeyManager } from '../input/hotkeys';
import { sanitizeBindings, type Action, type Binding } from '../input/bindings';
import { Picker, type PickerItem } from '../input/picker';
import { mountHotkeyPanel } from '../input/panel';
import { trackerGestureSource, type GestureSource, type TrackerGestures } from '../input/gestures';
import { LipSync } from '../audio/lipsync';
import { mountLipSyncPanel } from '../audio/panel';
import { toggleVcamOutput } from '../app/vcamControls';

export interface MotionContext {
  settings: Settings;
  persist: () => void;
  setStatus: (s: string, err?: boolean) => void;
  /** The stage element (the picker overlays it). */
  stage: HTMLElement;
  /** The tracker's hand gestures (src/core/gestures.ts), for gesture hotkeys. */
  gestures?: TrackerGestures;
  /** Diagnostics (main.ts passes debugLog with ?debuglog=1). */
  debug?: (line: string) => void;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const MASK_LABEL: Record<BoneMask, string> = { full: 'FULL', body: 'BODY', arms: 'ARMS', head: 'HEAD' };

/** A .glb with animations is a clip; one without is a scene (3D environment). */
export function glbHasAnimations(buf: ArrayBuffer): boolean {
  try {
    const dv = new DataView(buf);
    if (dv.getUint32(0, true) !== 0x46546c67) return false;
    const len = dv.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, len)));
    return Array.isArray(json.animations) && json.animations.length > 0;
  } catch {
    return false;
  }
}

export async function mountMotion(ctx: MotionContext) {
  const { settings, persist, setStatus } = ctx;
  const library = new ClipLibrary();
  library.options = settings.anim.clipOptions;
  const lipsync = new LipSync();
  let avatar: Avatar | null = null;
  let modelHash: string | null = null;
  let layer: AnimLayer | null = null;

  settings.hotkeys.bindings = sanitizeBindings(settings.hotkeys.bindings) ?? [];

  // ---------------------------------------------------------------- actions
  function run(action: Action, pressed: boolean): void {
    if (action.kind === 'picker') {
      if (pressed) picker.toggle();
      return;
    }
    if (action.kind === 'camera') {
      if (pressed) toggleVcamOutput();
      return;
    }
    if (!layer) return;
    if (action.kind === 'emote') {
      if (pressed) void layer.play(action.clip);
    } else if (action.kind === 'expression') {
      if (pressed) layer.overlay.press(action.name, action.mode, action.fadeIn, action.fadeOut);
      else layer.overlay.release(action.name, action.mode);
    } else if (action.kind === 'reset' && pressed) layer.reset();
  }
  const hotkeys = new HotkeyManager({ run });
  hotkeys.bindings = settings.hotkeys.bindings;

  // ---------------------------------------------------------------- picker
  const expressionNames = (): string[] => {
    if (!avatar) return [...VRM_PRESETS];
    const presets = VRM_PRESETS.filter((p) => avatar!.presets.has(p));
    // Custom expressions, minus the ARKit set a perfect-sync model drives itself.
    const arkit = new Set(avatar.perfectSync.values());
    const custom = avatar.expressionNames.filter((n) => !presets.includes(n as never) && !arkit.has(n) && !/^look(Up|Down|Left|Right)$/.test(n));
    return [...presets, ...custom];
  };
  const picker = new Picker(ctx.stage, (): PickerItem[] => {
    const items: PickerItem[] = [];
    for (const d of library.all().filter((c) => c.kind === 'emote'))
      items.push({ label: d.label, group: 'EMOTE', run: () => layer && void layer.play(d.id), active: () => !!layer?.playing.includes(d.id) });
    for (const n of expressionNames().filter((n) => !['blink', 'blinkLeft', 'blinkRight', 'aa', 'ih', 'ou', 'ee', 'oh'].includes(n)))
      items.push({ label: n.toUpperCase(), group: 'EXPRESSION', run: () => layer?.overlay.press(n, 'toggle'), active: () => !!layer?.overlay.active.includes(n) });
    items.push({ label: 'RESET', group: '', run: () => layer?.reset() });
    return items;
  });
  hotkeys.picker = picker;

  // ---------------------------------------------------------------- 07 MOTION
  const motionHost = document.getElementById('motion-block')!;
  motionHost.innerHTML = `
    <h2><span class="idx">07</span>MOTION</h2>
    <label class="row"><span class="lbl">IDLE</span><select id="mo-idle"></select></label>
    <label class="check"><input type="checkbox" id="mo-idle-face" /><span>IDLE IN FACE MODE (ELSE ONLY WHEN TRACKING IS LOST)</span></label>
    <div class="clip-head"><span>EMOTE (CLICK TO PLAY)</span><span>OWNS</span><span title="Loop until triggered again">LP</span></div>
    <div class="clip-list" id="mo-list"></div>
    <div class="row btns">
      <button class="btn" id="mo-import">IMPORT CLIP</button>
      <button class="btn ghost" id="mo-stop" title="Stop emotes and clear hotkey expressions">STOP</button>
    </div>
    <p class="drop-note">OR DROP .FBX / .GLB (MIXAMO, QUATERNIUS UAL, VROID RIGS). BUILT-INS: QUATERNIUS UNIVERSAL ANIMATION LIBRARY (CC0) + PUPPET.</p>`;
  const idleSel = motionHost.querySelector<HTMLSelectElement>('#mo-idle')!;
  const idleFace = motionHost.querySelector<HTMLInputElement>('#mo-idle-face')!;
  const listEl = motionHost.querySelector<HTMLElement>('#mo-list')!;
  idleFace.checked = settings.anim.idleInFaceMode;
  idleFace.addEventListener('change', () => {
    settings.anim.idleInFaceMode = idleFace.checked;
    if (layer) layer.settings.idleInFaceMode = idleFace.checked;
    persist();
  });
  idleSel.addEventListener('change', () => {
    settings.anim.idle = idleSel.value || null;
    layer?.setIdle(settings.anim.idle);
    persist();
  });
  motionHost.querySelector('#mo-stop')!.addEventListener('click', () => layer?.reset());
  motionHost.querySelector('#mo-import')!.addEventListener('click', () => void importDialog());

  function renderMotion(): void {
    const all = library.all();
    idleSel.innerHTML = '<option value="">NONE (STATIC POSE)</option>';
    for (const d of all.filter((c) => c.kind === 'idle')) idleSel.append(new Option(d.label, d.id));
    idleSel.value = settings.anim.idle ?? '';
    listEl.innerHTML = '';
    const playing = new Set(layer?.playing ?? []);
    for (const d of all) {
      if (d.kind === 'idle' && !d.id.startsWith('user:')) continue;
      const user = d.id.startsWith('user:');
      const row = document.createElement('div');
      row.className = `clip-row${user ? ' user' : ''}`;
      row.innerHTML = `<button class="play${playing.has(d.id) ? ' on' : ''}" title="${esc(d.label)}${user ? ' (imported)' : ''}">${d.kind === 'idle' ? '◌ ' : '▶ '}${esc(d.label)}</button>
        <select title="Bones this clip owns while it plays">${BONE_MASKS.map((m) => `<option value="${m}"${m === d.mask ? ' selected' : ''}>${MASK_LABEL[m]}</option>`).join('')}</select>
        <input type="checkbox" title="Loop until triggered again"${d.loop ? ' checked' : ''} />${user ? '<button class="x" title="Remove the imported clip">×</button>' : ''}`;
      row.querySelector('.play')!.addEventListener('click', () => {
        if (!layer) return setStatus('LOAD A MODEL FIRST', true);
        void layer.play(d.id);
      });
      row.querySelector('select')!.addEventListener('change', (e) => {
        library.setOptions(d.id, { mask: (e.target as HTMLSelectElement).value as BoneMask });
        persist();
      });
      row.querySelector<HTMLInputElement>('input')!.addEventListener('change', (e) => {
        library.setOptions(d.id, { loop: (e.target as HTMLInputElement).checked });
        persist();
      });
      row.querySelector('.x')?.addEventListener('click', () => void library.remove(d.id).then(persist));
      listEl.append(row);
    }
  }
  library.onChange = () => {
    renderMotion();
    hkPanel?.render();
  };

  async function importOne(name: string, bytes: ArrayBuffer, path: string | null): Promise<void> {
    setStatus(`IMPORTING ${name}`);
    try {
      const added = await library.importFile(name, bytes, path);
      setStatus(added.length ? `IMPORTED ${added.length} CLIP${added.length > 1 ? 'S' : ''}: ${added.map((a) => a.label).join(', ')}` : `${name}: ALREADY IMPORTED`);
    } catch (e) {
      setStatus(`CLIP IMPORT FAILED: ${(e as Error).message}`, true);
    }
  }

  async function importDialog(): Promise<void> {
    if (isTauri) {
      const p = await pickPath('Animation clip', ['fbx', 'glb']);
      if (p) await importOne(baseName(p), await readPath(p), p);
    } else {
      const f = await pickBrowserFile('.fbx,.glb');
      if (f) await importOne(f.name, await f.arrayBuffer(), null);
    }
  }

  /** Drops: .fbx always, .glb when it carries animations. Returns the paths it did not take. */
  async function dropPaths(paths: string[]): Promise<string[]> {
    const rest: string[] = [];
    for (const p of paths) {
      const ext = extOf(p);
      if (!ext) {
        rest.push(p);
        continue;
      }
      const buf = await readPath(p);
      if (ext === 'glb' && !glbHasAnimations(buf)) rest.push(p);
      else await importOne(baseName(p), buf, p);
    }
    return rest;
  }
  async function dropFiles(files: File[]): Promise<File[]> {
    const rest: File[] = [];
    for (const f of files) {
      const ext = extOf(f.name);
      if (!ext) {
        rest.push(f);
        continue;
      }
      const buf = await f.arrayBuffer();
      if (ext === 'glb' && !glbHasAnimations(buf)) rest.push(f);
      else await importOne(f.name, buf, null);
    }
    return rest;
  }

  // ---------------------------------------------------------------- 08 HOTKEYS
  const hkHost = document.getElementById('hotkeys-block')!;
  const hkPanel = mountHotkeyPanel({
    host: hkHost,
    hotkeys,
    bindings: () => settings.hotkeys.bindings,
    setBindings: (b: Binding[]) => {
      settings.hotkeys.bindings = b;
      hotkeys.bindings = b;
      persist();
      void hotkeys.refresh()?.then(() => hkPanel.status());
    },
    global: () => settings.hotkeys.global,
    setGlobal: (on) => {
      settings.hotkeys.global = on;
      persist();
      void hotkeys.setGlobal(on).then((r) => {
        hkPanel.status();
        if (on && r.failed.length) setStatus(`GLOBAL HOTKEYS: ${r.failed.length} NOT REGISTERED (${r.failed[0].error})`, true);
      });
    },
    emotes: () => library.all().filter((c) => c.kind === 'emote').map((c) => [c.id, c.label] as [string, string]),
    expressions: expressionNames,
    modelHash: () => modelHash,
  });
  hotkeys.onFire = (b) => {
    hkPanel.flash(b.id);
    ctx.debug?.(`hotkey ${b.trigger.kind} ${JSON.stringify(b.trigger)} -> ${b.action.kind}${b.action.kind === 'emote' ? ` ${b.action.clip}` : ''}`);
  };
  const logGlobal = (r: { registered: string[]; failed: Array<{ accelerator: string; error: string }> }) =>
    ctx.debug?.(`hotkeys: global ${r.registered.length} registered [${r.registered.join(' ')}]${r.failed.length ? `, failed ${r.failed.map((f) => `${f.accelerator}: ${f.error}`).join('; ')}` : ''}`);
  if (settings.hotkeys.global)
    void hotkeys.setGlobal(true).then((r) => {
      hkPanel.status();
      logGlobal(r);
    });
  setInterval(() => hkPanel.status(), 2000);
  const gestures: GestureSource | null = trackerGestureSource(ctx.gestures);
  hotkeys.attachGestures(gestures);

  // ---------------------------------------------------------------- 09 LIP SYNC
  const lsPanel = mountLipSyncPanel({ host: document.getElementById('lipsync-block')!, lipsync, settings: settings.lipsync, persist, setStatus });
  if (settings.lipsync.mode !== 'off') void lsPanel.apply();

  // ---------------------------------------------------------------- lifecycle
  await library.init();
  renderMotion();

  let meterAt = 0;
  return {
    library,
    hotkeys,
    lipsync,
    picker,
    get layer() {
      return layer;
    },
    /** A model was loaded (or cleared). */
    attach(a: Avatar | null, hash: string | null): void {
      if (avatar && avatar.layer === layer) avatar.layer = null;
      avatar = a;
      modelHash = hash;
      hotkeys.model = hash;
      layer = a ? new AnimLayer(a, library, settings.anim) : null;
      if (a && layer) {
        layer.lipsync = lipsync;
        layer.onError = (m) => setStatus(m, true);
        layer.onPlaying = () => renderMotion();
        a.layer = layer;
      }
      renderMotion();
      hkPanel.render();
      void hotkeys.refresh()?.then(() => hkPanel.status());
    },
    /** Every frame. */
    tick(now: number): void {
      hotkeys.tick();
      // No model: keep the meter alive.
      if (!layer && lipsync.mode !== 'off') lipsync.update(1 / 60, false);
      if (now - meterAt > 50) {
        meterAt = now;
        if (lipsync.mode !== 'off') lsPanel.meter();
      }
    },
    importDialog,
    dropPaths,
    dropFiles,
  };
}

export type MotionFeatures = Awaited<ReturnType<typeof mountMotion>>;
