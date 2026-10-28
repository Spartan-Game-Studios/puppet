/**
 * The 05 ENVIRONMENT panel: binds the static controls in index.html to the
 * EnvironmentManager and the saved settings. Looks are saved per environment
 * (per custom scene file for CUSTOM); placements per custom scene file.
 */
import type { Viewer } from '../scene/viewer';
import { EnvironmentManager } from '../scene/environment/manager';
import {
  DEFAULT_LOOK,
  envKey,
  isEnvId,
  resolveLook,
  resolvePlacement,
  type EnvId,
  type EnvLook,
  type EnvQuality,
  type Placement,
} from '../scene/environment/look';
import { extOf, loadCustomScene, loadCustomSky, SCENE_EXTS, SKY_EXTS } from '../scene/environment/custom';
import { baseName, isTauri, pickBrowserFile, pickPath, readPath } from './platform';
import type { Settings } from './settings';

export interface EnvUiDeps {
  viewer: Viewer;
  settings: Settings;
  persist(): void;
  setStatus(s: string, err?: boolean): void;
  /** Switch the background kind (03) and re-apply it. */
  setBackgroundKind(kind: Settings['background']['kind']): void;
}

export interface EnvUi {
  manager: EnvironmentManager;
  /** Called by applyBackground. */
  setActive(on: boolean): void;
  /** `E`: toggle the 3D environment on/off. */
  toggle(): void;
  /** Dropped native paths; true if one was an environment file. */
  dropPaths(paths: string[]): Promise<boolean>;
  /** Dropped browser files; true if one was an environment file. */
  dropFiles(files: File[]): Promise<boolean>;
  /** Test hook: select an environment and quality, patch the look. */
  set(id: EnvId, quality?: EnvQuality, look?: Partial<EnvLook>): void;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const isScene = (n: string) => SCENE_EXTS.includes(extOf(n));
const isSky = (n: string) => SKY_EXTS.includes(extOf(n));

export function bindEnvironmentUi(d: EnvUiDeps): EnvUi {
  const env = d.settings.environment;
  const manager = new EnvironmentManager(d.viewer);
  /** Name of the custom scene/sky loaded this session (path in the app, file name in a browser). */
  let sceneId: string | null = null;
  let skyId: string | null = null;
  let previousKind: Settings['background']['kind'] = d.settings.background.kind === 'environment' ? 'color' : d.settings.background.kind;

  const key = () => envKey(env.id, sceneId ?? env.custom.scenePath);
  const look = (): EnvLook => resolveLook(env.looks[key()]);
  const placementKey = () => sceneId ?? env.custom.scenePath ?? '';
  const placement = (): Placement => resolvePlacement(env.placements[placementKey()]);

  function push(): void {
    manager.setState({ id: env.id, quality: env.quality, look: look(), placement: placement() });
  }
  function setLook(patch: Partial<EnvLook>): void {
    env.looks[key()] = { ...look(), ...patch };
    d.persist();
    push();
  }
  function setPlacement(patch: Partial<Placement>): void {
    const k = placementKey();
    if (!k) return;
    env.placements[k] = { ...placement(), ...patch };
    d.persist();
    push();
  }

  // ---------------------------------------------------------------- controls
  const segSet = (id: string, v: string) =>
    $(id).querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.classList.toggle('on', b.dataset.value === v));
  const segOn = (id: string, f: (v: string) => void) =>
    $(id).addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (b?.dataset.value) f(b.dataset.value);
    });

  interface Range {
    el: HTMLInputElement;
    out: HTMLElement;
    get(): number;
    fmt(v: number): string;
    /** Slider position from value and back (for the log-scale SCALE slider). */
    to?(v: number): number;
    from?(x: number): number;
  }
  const ranges: Range[] = [];
  function range(id: string, get: () => number, set: (v: number) => void, fmt: (v: number) => string, to?: (v: number) => number, from?: (x: number) => number): void {
    const r: Range = { el: $<HTMLInputElement>(id), out: $(`${id}-out`), get, fmt, to, from };
    r.el.addEventListener('input', () => {
      const v = r.from ? r.from(Number(r.el.value)) : Number(r.el.value);
      r.out.textContent = fmt(v);
      set(v);
    });
    ranges.push(r);
  }
  const checks: Array<[HTMLInputElement, () => boolean]> = [];
  function check(id: string, get: () => boolean, set: (v: boolean) => void): void {
    const el = $<HTMLInputElement>(id);
    el.addEventListener('change', () => set(el.checked));
    checks.push([el, get]);
  }

  /** Push the current environment's saved values into every control. */
  function refresh(): void {
    $<HTMLSelectElement>('env-id').value = env.id;
    segSet('env-quality', env.quality);
    segSet('env-style', look().style);
    for (const r of ranges) {
      const v = r.get();
      r.el.value = String(r.to ? r.to(v) : v);
      r.out.textContent = r.fmt(v);
    }
    for (const [el, get] of checks) el.checked = get();
    const block = $('env-block');
    block.classList.toggle('custom', env.id === 'custom');
    block.classList.toggle('off', d.settings.background.kind !== 'environment');
    $('env-scene-name').textContent = sceneId ? baseName(sceneId).toUpperCase() : 'NONE (DROP A .GLB)';
    $('env-sky-name').textContent = skyId ? baseName(skyId).toUpperCase() : 'NONE (GRADIENT)';
  }

  function selectEnv(id: EnvId): void {
    env.id = id;
    d.persist();
    refresh();
    push();
    if (d.settings.background.kind !== 'environment') d.setBackgroundKind('environment');
    if (id === 'custom' && !manager.hasCustomScene && !sceneId) d.setStatus('CUSTOM: LOAD OR DROP A .GLB / .GLTF SCENE');
  }

  $<HTMLSelectElement>('env-id').addEventListener('change', (e) => {
    const v = (e.target as HTMLSelectElement).value;
    if (isEnvId(v)) selectEnv(v);
  });
  segOn('env-quality', (v) => {
    env.quality = v === 'low' ? 'low' : 'high';
    d.persist();
    segSet('env-quality', env.quality);
    push();
  });
  segOn('env-style', (v) => {
    setLook({ style: v as EnvLook['style'] });
    segSet('env-style', v);
  });
  range('env-intensity', () => look().intensity, (v) => setLook({ intensity: v }), (v) => v.toFixed(2));
  range('env-temp', () => look().temperature, (v) => setLook({ temperature: v }), (v) => `${Math.round(v)}`);
  range('env-fog', () => look().fog, (v) => setLook({ fog: v }), (v) => v.toFixed(2));
  range('env-floor', () => look().floor, (v) => setLook({ floor: v }), (v) => v.toFixed(2));
  check('env-shadow', () => look().shadow, (v) => setLook({ shadow: v }));
  check('env-sway', () => look().sway, (v) => setLook({ sway: v }));
  check('env-dof', () => look().dof, (v) => setLook({ dof: v }));
  range('env-scale', () => placement().scale, (v) => setPlacement({ scale: v }), (v) => (v < 1 ? v.toFixed(2) : v.toFixed(1)), Math.log10, (x) => 10 ** x);
  range('env-x', () => placement().x, (v) => setPlacement({ x: v }), (v) => v.toFixed(2));
  range('env-y', () => placement().y, (v) => setPlacement({ y: v }), (v) => v.toFixed(2));
  range('env-z', () => placement().z, (v) => setPlacement({ z: v }), (v) => v.toFixed(2));
  range('env-rot', () => placement().rotY, (v) => setPlacement({ rotY: v }), (v) => v.toFixed(0));
  $('btn-env-reset').addEventListener('click', () => {
    env.looks[key()] = { ...DEFAULT_LOOK };
    if (env.id === 'custom' && placementKey()) delete env.placements[placementKey()];
    d.persist();
    refresh();
    push();
  });

  // ---------------------------------------------------------------- custom files
  /** `select`: switch to CUSTOM (and the 3D background) once loaded; false when restoring at launch. */
  async function loadScene(buf: ArrayBuffer, id: string, resolve?: (uri: string) => Promise<ArrayBuffer>, select = true): Promise<void> {
    d.setStatus(`LOADING SCENE ${baseName(id)}`);
    try {
      const scene = await loadCustomScene(buf, baseName(id), resolve);
      sceneId = id;
      manager.setCustomScene(scene);
      const s = scene.size;
      d.setStatus(`SCENE OK: ${s.x.toFixed(1)} × ${s.y.toFixed(1)} × ${s.z.toFixed(1)} M`);
      if (select) selectEnv('custom');
      else refresh(), push();
    } catch (e) {
      d.setStatus(`SCENE LOAD FAILED: ${(e as Error).message}`, true);
    }
  }
  async function loadSky(buf: ArrayBuffer, id: string, select = true): Promise<void> {
    d.setStatus(`LOADING SKY ${baseName(id)}`);
    try {
      const sky = await loadCustomSky(buf, baseName(id), d.viewer.renderer);
      skyId = id;
      manager.setCustomSky(sky);
      d.setStatus('SKY OK');
      if (select) selectEnv('custom');
      else refresh(), push();
    } catch (e) {
      d.setStatus(`SKY LOAD FAILED: ${(e as Error).message}`, true);
    }
  }
  const siblingReader = (path: string) => {
    const dir = path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
    return (uri: string) => readPath(dir + uri);
  };
  async function openScenePath(p: string): Promise<void> {
    await loadScene(await readPath(p), p, siblingReader(p));
    if (sceneId === p) {
      env.custom.scenePath = p;
      d.persist();
    }
  }
  async function openSkyPath(p: string): Promise<void> {
    await loadSky(await readPath(p), p);
    if (skyId === p) {
      env.custom.skyPath = p;
      d.persist();
    }
  }

  $('btn-env-scene').addEventListener('click', async () => {
    if (isTauri) {
      const p = await pickPath('glTF scene', SCENE_EXTS);
      if (p) await openScenePath(p);
    } else {
      const f = await pickBrowserFile('.glb,.gltf');
      if (f) await loadScene(await f.arrayBuffer(), f.name);
    }
  });
  $('btn-env-sky').addEventListener('click', async () => {
    if (isTauri) {
      const p = await pickPath('HDR / EXR sky', SKY_EXTS);
      if (p) await openSkyPath(p);
    } else {
      const f = await pickBrowserFile('.hdr,.exr');
      if (f) await loadSky(await f.arrayBuffer(), f.name);
    }
  });
  $('btn-env-sky-clear').addEventListener('click', () => {
    skyId = null;
    env.custom.skyPath = null;
    d.persist();
    manager.setCustomSky(null);
    refresh();
  });

  // Re-open the saved custom files (desktop app only: a browser has no paths).
  if (isTauri) {
    const { scenePath, skyPath } = env.custom;
    Promise.all([
      scenePath ? readPath(scenePath).then((b) => loadScene(b, scenePath, siblingReader(scenePath), false)) : null,
      skyPath ? readPath(skyPath).then((b) => loadSky(b, skyPath, false)) : null,
    ]).catch(() => d.setStatus('SAVED CUSTOM ENVIRONMENT NOT FOUND', true));
  }

  refresh();
  push();

  return {
    manager,
    setActive(on) {
      if (on) manager.activate();
      else manager.deactivate();
      push();
      refresh();
    },
    toggle() {
      if (d.settings.background.kind === 'environment') d.setBackgroundKind(previousKind);
      else {
        previousKind = d.settings.background.kind;
        d.setBackgroundKind('environment');
      }
    },
    async dropPaths(paths) {
      const scene = paths.find(isScene);
      const sky = paths.find(isSky);
      if (scene) await openScenePath(scene);
      if (sky) await openSkyPath(sky);
      return !!(scene || sky);
    },
    async dropFiles(files) {
      const scene = files.find((f) => isScene(f.name));
      const sky = files.find((f) => isSky(f.name));
      if (scene) await loadScene(await scene.arrayBuffer(), scene.name);
      if (sky) await loadSky(await sky.arrayBuffer(), sky.name);
      return !!(scene || sky);
    },
    set(id, quality, patch) {
      env.id = id;
      if (quality) env.quality = quality;
      if (patch) env.looks[key()] = { ...look(), ...patch };
      d.persist();
      refresh();
      push();
      if (d.settings.background.kind !== 'environment') d.setBackgroundKind('environment');
    },
  };
}
