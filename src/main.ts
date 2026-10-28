/**
 * Puppet: app entry. Wires the source -> tracker -> face/body processing ->
 * avatar -> renderer / VMC, and binds the UI.
 *
 * URL parameters (dev / test harness):
 *   ?source=file&src=<video url>   feed a recorded clip instead of the camera
 *   ?model=<url>                   load a VRM from a URL at start
 *   ?tracker=main                  run MediaPipe on the main thread
 *   ?mode=face|upper|hands         override the tracking mode
 *   ?capture=1                     start in capture view
 */
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';
import '@fontsource/jetbrains-mono/800.css';
import './styles.css';

import { Euler, Quaternion } from 'three';
import { ARKIT_NAMES, defaultGainCurves } from './core/blendshapes';
import { OneEuroVector, smoothingToParams } from './core/oneEuro';
import { Avatar, loadAvatar } from './scene/avatar';
import { Viewer, type Framing } from './scene/viewer';
import { FaceProcessor } from './tracking/faceProcessor';
import { drawPreview } from './tracking/overlay';
import type { BodyMode, TrackerResult } from './tracking/protocol';
import { listCameras, VideoSource } from './tracking/source';
import { Tracker } from './tracking/tracker';
import { toUnity, unityBoneName, vmcBlendName, type VmcFrame } from './vmc/vmcFrame';
import {
  baseName,
  debugLog,
  devQuery,
  isTauri,
  mediaUrl,
  onNativeDrop,
  pickBrowserFile,
  pickPath,
  readPath,
  vmcConfigure,
  vmcSend,
  vmcStats,
} from './app/platform';
import { loadSettings, saveSettings, type Settings } from './app/settings';
import type { PhysicsMode } from './physics/stableSprings';

const params = new URLSearchParams(location.search);
for (const [k, v] of new URLSearchParams(await devQuery())) params.set(k, v);
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const ACCENT = '#ff3b00';

const settings: Settings = await loadSettings();
const urlMode = params.get('mode') as BodyMode | null;
if (urlMode && ['face', 'upper', 'hands'].includes(urlMode)) settings.mode = urlMode;
if (params.has('mirror')) settings.mirror = params.get('mirror') === '1';
if (params.has('vmc')) settings.vmc.enabled = params.get('vmc') === '1';
const persist = () => saveSettings(settings);

// ---------------------------------------------------------------- core objects
const viewer = new Viewer($('stage'));
const source = new VideoSource($<HTMLVideoElement>('video'));
const face = new FaceProcessor();
face.mirror = settings.mirror;
face.gains = settings.gains;
face.calibration = settings.calibration;
face.setSmoothing(settings.smoothing);
const poseFilter = new OneEuroVector(33 * 3);
const tracker = new Tracker({
  mode: settings.mode,
  maxFps: settings.trackFps,
  poseModel: settings.poseModel,
  wantFaceLandmarks: settings.preview,
});
let avatar: Avatar | null = null;
let modelHash: string | null = null;
let lastResult: TrackerResult | null = null;
let frameCount = 0;

// ---------------------------------------------------------------- status
function setStatus(s: string, err = false): void {
  const el = $('status');
  el.textContent = s.toUpperCase();
  el.classList.toggle('status-err', err);
  if (err) console.warn('[puppet]', s);
}
tracker.onStatus = (s) => setStatus(s, s.includes('ERROR'));

// ---------------------------------------------------------------- tracking -> avatar
function updatePoseFilter(): void {
  const p = smoothingToParams(settings.smoothing * 0.8);
  poseFilter.setParams(p);
}
updatePoseFilter();

// ?record=1: keep a per-result log for the test harness (scripts/track-clip.mjs).
const record: unknown[] | null = params.get('record') === '1' ? [] : null;

let lastFace: TrackerResult | null = null;
let lastBody: TrackerResult | null = null;
tracker.onResult = (r) => {
  const t = r.t / 1000;
  if (r.pipeline === 'face') {
    lastFace = r;
    if (r.face) avatar?.setFace(face.process(r.face, t));
  } else {
    lastBody = r;
    if (avatar && settings.mode !== 'face' && r.pose) {
      const flat = r.pose.world.flatMap((l) => [l.x, l.y, l.z]);
      const f = poseFilter.filter(flat, t);
      const world = r.pose.world.map((l, i) => ({ x: f[3 * i], y: f[3 * i + 1], z: f[3 * i + 2], visibility: l.visibility }));
      avatar.setBody({ poseWorld: world, poseImage: r.pose.image, hands: settings.mode === 'hands' ? (r.hands ?? []) : [] });
    }
  }
  lastResult = {
    ...(lastFace ?? r),
    face: lastFace?.face ?? null,
    pose: settings.mode === 'face' ? null : (lastBody?.pose ?? null),
    hands: settings.mode === 'hands' ? (lastBody?.hands ?? []) : [],
  };
  if (record && face.state && r.pipeline === 'face') {
    const e = new Euler().setFromQuaternion(face.state.head, 'YXZ');
    // World direction of each forearm (avatar space), for checking arm tracking.
    const fore = (side: 'left' | 'right') => {
      const n = avatar?.bone(`${side}LowerArm`);
      const rest = avatar?.rest[`${side}LowerArm`];
      if (!n || !rest) return null;
      const d = rest.clone().applyQuaternion(n.getWorldQuaternion(new Quaternion()));
      return [d.x, d.y, d.z];
    };
    record.push({
      vt: r.videoTime,
      face: !!r.face,
      pose: !!lastBody?.pose,
      hands: lastBody?.hands?.length ?? 0,
      handsRan: !!lastBody?.handsRan,
      values: face.state.values,
      raw: face.state.raw,
      head: [e.y, e.x, e.z],
      gaze: face.state.gaze,
      foreLeft: fore('left'),
      foreRight: fore('right'),
    });
  }
};

// ---------------------------------------------------------------- model loading
async function loadModel(buf: ArrayBuffer, label: string, path: string | null): Promise<void> {
  setStatus(`LOADING ${label}`);
  try {
    const { avatar: a, hash } = await loadAvatar(buf, settings.physics);
    applyDrive(a);
    const ov = settings.physicsOverrides[hash];
    if (ov) a.physics.setOverrides(ov);
    viewer.setAvatar(a);
    viewer.frame(currentFraming);
    avatar = a;
    modelHash = hash;
    if (path) {
      settings.lastModelPath = path;
      persist();
    }
    $('model-name').textContent = `${a.name} [${label}]`;
    const ps = a.perfectSync.size;
    $('sync-mode').textContent = a.usePerfectSync
      ? `PERFECT SYNC ${ps}/52`
      : `PRESETS ${a.presets.size}/13${ps ? ` (ARKIT ${ps}/52)` : ''}`;
    $('empty').classList.add('hidden');
    buildBlendshapeList();
    buildPhysicsUI();
    setStatus(`MODEL OK: ${a.physics.chains.length} CHAINS, ${a.physics.jointCount} JOINTS`);
  } catch (e) {
    setStatus(`MODEL LOAD FAILED: ${(e as Error).message}`, true);
  }
}

async function openModelDialog(): Promise<void> {
  if (isTauri) {
    const p = await pickPath('VRM avatar', ['vrm']);
    if (p) await loadModel(await readPath(p), baseName(p), p);
  } else {
    const f = await pickBrowserFile('.vrm');
    if (f) await loadModel(await f.arrayBuffer(), f.name, null);
  }
}

function applyDrive(a: Avatar): void {
  a.drive.mode = settings.mode;
  a.drive.mirror = settings.mirror;
  a.drive.gazeGain = settings.gazeGain;
  a.drive.presetOptions.emotions = settings.emotions;
}

// ---------------------------------------------------------------- source
async function startSource(): Promise<void> {
  try {
    let info: string;
    if (params.get('source') === 'file') {
      const src = params.get('src') ?? '/test-assets/clip.webm';
      info = await source.openFile(await mediaUrl(src), params.get('loop') !== '0');
    } else {
      setStatus('OPENING CAMERA');
      info = await source.openCamera(settings.cameraId, settings.resolution, settings.trackFps);
      await refreshCameras();
    }
    $('cam-actual').textContent = info;
    $('preview-info').textContent = info;
    $('btn-camera').textContent = 'RESTART CAMERA';
    tracker.start(source.video);
    setStatus(avatar ? 'TRACKING' : 'TRACKING (NO MODEL)');
  } catch (e) {
    const err = e as DOMException;
    const msg =
      err.name === 'NotAllowedError'
        ? 'CAMERA BLOCKED: ALLOW PUPPET IN SYSTEM SETTINGS > PRIVACY > CAMERA'
        : err.name === 'NotFoundError'
          ? 'NO CAMERA FOUND'
          : `CAMERA ERROR: ${err.message}`;
    setStatus(msg, true);
  }
}

async function refreshCameras(): Promise<void> {
  const sel = $<HTMLSelectElement>('camera');
  const cams = await listCameras();
  sel.innerHTML = '';
  if (!cams.length) sel.append(new Option('NO CAMERA', ''));
  for (const c of cams) sel.append(new Option(c.label, c.id));
  if (settings.cameraId && cams.some((c) => c.id === settings.cameraId)) sel.value = settings.cameraId;
}

// ---------------------------------------------------------------- background / framing
let bgUrl: string | null = null;
let currentFraming: Framing = 'bust';

async function applyBackground(): Promise<void> {
  const b = settings.background;
  document.body.classList.toggle('transparent', b.kind === 'transparent');
  if (b.kind === 'image' && b.imagePath && !bgUrl) {
    try {
      const buf = await readPath(b.imagePath);
      bgUrl = URL.createObjectURL(new Blob([buf]));
    } catch {
      bgUrl = null;
    }
  }
  viewer.setBackground(b.kind, b.color, b.kind === 'image' ? bgUrl : null);
  segSet('bg-kind', b.kind);
  document.querySelectorAll<HTMLButtonElement>('#swatches button').forEach((s) => s.classList.toggle('on', b.kind === 'color' && s.dataset.color === b.color));
  $<HTMLInputElement>('bg-color').value = b.color;
}

async function pickBackgroundImage(): Promise<void> {
  if (isTauri) {
    const p = await pickPath('Image', ['png', 'jpg', 'jpeg', 'webp']);
    if (!p) return;
    settings.background.imagePath = p;
    if (bgUrl) URL.revokeObjectURL(bgUrl);
    bgUrl = null;
  } else {
    const f = await pickBrowserFile('image/*');
    if (!f) return;
    if (bgUrl) URL.revokeObjectURL(bgUrl);
    bgUrl = URL.createObjectURL(f);
    settings.background.imagePath = null;
  }
  settings.background.kind = 'image';
  persist();
  await applyBackground();
}

// ---------------------------------------------------------------- UI helpers
function segSet(id: string, value: string): void {
  $(id)
    .querySelectorAll<HTMLButtonElement>('button')
    .forEach((b) => b.classList.toggle('on', b.dataset.value === value));
}
function segBind(id: string, get: () => string, set: (v: string) => void): void {
  $(id).addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
    if (b?.dataset.value) {
      set(b.dataset.value);
      segSet(id, get());
    }
  });
  segSet(id, get());
}
function checkBind(id: string, get: () => boolean, set: (v: boolean) => void): void {
  const el = $<HTMLInputElement>(id);
  el.checked = get();
  el.addEventListener('change', () => set(el.checked));
}
function rangeBind(id: string, get: () => number, set: (v: number) => void, digits = 2): void {
  const el = $<HTMLInputElement>(id);
  const out = $(`${id}-out`);
  el.value = String(get());
  out.textContent = get().toFixed(digits);
  el.addEventListener('input', () => {
    set(Number(el.value));
    out.textContent = Number(el.value).toFixed(digits);
  });
}
function selectBind(id: string, get: () => string, set: (v: string) => void): void {
  const el = $<HTMLSelectElement>(id);
  el.value = get();
  el.addEventListener('change', () => set(el.value));
}
function refreshInputs(): void {
  $<HTMLInputElement>('mirror').checked = settings.mirror;
  $<HTMLInputElement>('preview').checked = settings.preview;
  $<HTMLInputElement>('vmc-enabled').checked = settings.vmc.enabled;
  segSet('mode', settings.mode);
  segSet('phys-mode', settings.physics.mode);
}

// ---------------------------------------------------------------- source / tracking UI
selectBind('resolution', () => settings.resolution, (v) => {
  settings.resolution = v as Settings['resolution'];
  persist();
  if (source.kind === 'camera') startSource();
});
selectBind('track-fps', () => String(settings.trackFps), (v) => {
  settings.trackFps = Number(v);
  tracker.opts.maxFps = settings.trackFps;
  persist();
});
$<HTMLSelectElement>('camera').addEventListener('change', (e) => {
  settings.cameraId = (e.target as HTMLSelectElement).value || null;
  persist();
  startSource();
});
$('btn-camera').addEventListener('click', () => startSource());
checkBind('mirror', () => settings.mirror, (v) => setMirror(v));
checkBind('preview', () => settings.preview, (v) => setPreview(v));

function setMirror(v: boolean): void {
  settings.mirror = v;
  face.mirror = v;
  if (avatar) avatar.drive.mirror = v;
  persist();
  refreshInputs();
}
function setPreview(v: boolean): void {
  settings.preview = v;
  tracker.opts.wantFaceLandmarks = v;
  $('preview-box').classList.toggle('hidden', !v);
  persist();
  refreshInputs();
}
function setMode(m: BodyMode): void {
  settings.mode = m;
  tracker.opts.mode = m;
  if (avatar) avatar.drive.mode = m;
  persist();
  segSet('mode', m);
}
segBind('mode', () => settings.mode, (v) => setMode(v as BodyMode));
selectBind('pose-model', () => settings.poseModel, (v) => {
  settings.poseModel = v as 'lite' | 'full';
  persist();
  setStatus('POSE MODEL CHANGE APPLIES ON NEXT LAUNCH');
});
rangeBind('smoothing', () => settings.smoothing, (v) => {
  settings.smoothing = v;
  face.setSmoothing(v);
  updatePoseFilter();
  persist();
});
rangeBind('gaze-gain', () => settings.gazeGain, (v) => {
  settings.gazeGain = v;
  if (avatar) avatar.drive.gazeGain = v;
  persist();
});
checkBind('emotions', () => settings.emotions, (v) => {
  settings.emotions = v;
  if (avatar) avatar.drive.presetOptions.emotions = v;
  persist();
});

function calibrate(): void {
  if (face.captureNeutral()) {
    settings.calibration = face.calibration;
    persist();
    showCalib();
    setStatus('NEUTRAL CAPTURED');
  } else setStatus('NO FACE TO CALIBRATE', true);
}
function showCalib(): void {
  const c = settings.calibration;
  $('calib-state').textContent = c.head ? `SET (${Object.keys(c.baseline).length} BASELINES)` : 'NONE';
}
$('btn-calibrate').addEventListener('click', calibrate);
$('btn-calib-clear').addEventListener('click', () => {
  face.clearCalibration();
  settings.calibration = face.calibration;
  persist();
  showCalib();
});
showCalib();

// ---------------------------------------------------------------- background UI
segBind('bg-kind', () => settings.background.kind, (v) => {
  if (v === 'image' && !bgUrl && !settings.background.imagePath) {
    pickBackgroundImage();
    return;
  }
  settings.background.kind = v as Settings['background']['kind'];
  persist();
  applyBackground();
});
$('swatches').addEventListener('click', (e) => {
  const c = (e.target as HTMLElement).dataset.color;
  if (!c) return;
  settings.background = { ...settings.background, kind: 'color', color: c };
  persist();
  applyBackground();
});
$<HTMLInputElement>('bg-color').addEventListener('input', (e) => {
  settings.background = { ...settings.background, kind: 'color', color: (e.target as HTMLInputElement).value };
  persist();
  applyBackground();
});
$('btn-bg-image').addEventListener('click', () => pickBackgroundImage());
segBind('framing', () => currentFraming, (v) => {
  currentFraming = v as Framing;
  viewer.frame(currentFraming);
});

// ---------------------------------------------------------------- VMC UI
async function applyVmc(): Promise<void> {
  try {
    await vmcConfigure(settings.vmc.enabled, settings.vmc.host, settings.vmc.port);
    if (!isTauri && settings.vmc.enabled) setStatus('VMC NEEDS THE DESKTOP APP (BROWSER CANNOT SEND UDP)', true);
  } catch (e) {
    setStatus(`VMC: ${e}`, true);
  }
}
checkBind('vmc-enabled', () => settings.vmc.enabled, (v) => {
  settings.vmc.enabled = v;
  persist();
  applyVmc();
});
const hostEl = $<HTMLInputElement>('vmc-host');
const portEl = $<HTMLInputElement>('vmc-port');
hostEl.value = settings.vmc.host;
portEl.value = String(settings.vmc.port);
hostEl.addEventListener('change', () => {
  settings.vmc.host = hostEl.value.trim() || '127.0.0.1';
  persist();
  applyVmc();
});
portEl.addEventListener('change', () => {
  const p = Math.round(Number(portEl.value));
  settings.vmc.port = p > 0 && p < 65536 ? p : 39539;
  portEl.value = String(settings.vmc.port);
  persist();
  applyVmc();
});

let vmcBusy = false;
const t0 = performance.now();
function sendVmc(): void {
  if (!settings.vmc.enabled || !avatar || vmcBusy || !isTauri) return;
  const a = avatar;
  const frame: VmcFrame = {
    t: (performance.now() - t0) / 1000,
    root: [0, 0, 0, 0, 0, 0, 1],
    bones: [],
    blends: [],
  };
  for (const name of a.humanBoneNames) {
    const n = a.bone(name)!;
    frame.bones.push([unityBoneName(name), ...toUnity(n.position, n.quaternion)]);
  }
  for (const [n, v] of a.expressionValues) frame.blends.push([vmcBlendName(n), v]);
  vmcBusy = true;
  vmcSend(frame)
    .catch((e) => setStatus(`VMC: ${e}`, true))
    .finally(() => (vmcBusy = false));
}

// ---------------------------------------------------------------- tabs
function setTab(t: 'face' | 'physics'): void {
  settings.ui.tab = t;
  persist();
  document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
  $('tab-face').classList.toggle('on', t === 'face');
  $('tab-physics').classList.toggle('on', t === 'physics');
}
document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((b) =>
  b.addEventListener('click', () => setTab(b.dataset.tab as 'face' | 'physics')),
);

// ---------------------------------------------------------------- blendshape list
interface BsRow {
  name: string;
  fill: HTMLElement;
  raw: HTMLElement;
  num: HTMLElement;
}
let bsRows: BsRow[] = [];
function buildBlendshapeList(): void {
  const list = $('bs-list');
  list.innerHTML = '';
  bsRows = [];
  const gains = settings.gains;
  const defaults = defaultGainCurves();
  for (const name of ARKIT_NAMES) {
    if (name === 'tongueOut') continue; // MediaPipe does not track it
    gains[name] ??= { ...defaults[name] };
    const row = document.createElement('div');
    const mapped = !avatar || !avatar.usePerfectSync || avatar.perfectSync.has(name);
    row.className = `bs-row${mapped ? '' : ' unmapped'}`;
    row.innerHTML = `<span class="name" title="${name}">${name}</span><div class="bs-bar"><div class="fill"></div><div class="raw"></div><span class="num">0.00</span></div><input type="number" step="0.05" min="0" max="4" title="gain" /><input type="number" step="0.05" min="0.2" max="3" title="curve exponent (<1 lifts small values)" />`;
    const [gIn, cIn] = row.querySelectorAll('input');
    gIn.value = String(gains[name].gain);
    cIn.value = String(gains[name].curve);
    gIn.addEventListener('change', () => {
      gains[name].gain = Math.max(0, Number(gIn.value) || 0);
      persist();
    });
    cIn.addEventListener('change', () => {
      gains[name].curve = Math.min(3, Math.max(0.2, Number(cIn.value) || 1));
      persist();
    });
    list.append(row);
    bsRows.push({
      name,
      fill: row.querySelector('.fill')!,
      raw: row.querySelector('.raw')!,
      num: row.querySelector('.num')!,
    });
  }
}

const eul = new Euler();
function updateFaceReadout(): void {
  const st = face.state;
  if (!st) return;
  for (const r of bsRows) {
    const v = st.values[r.name] ?? 0;
    const raw = st.raw[r.name] ?? 0;
    r.fill.style.width = `${(v * 100).toFixed(1)}%`;
    r.raw.style.left = `calc(${(raw * 100).toFixed(1)}% - 1px)`;
    r.num.textContent = v.toFixed(2);
  }
  eul.setFromQuaternion(st.head, 'YXZ');
  const d = (x: number) => ((x * 180) / Math.PI).toFixed(0).padStart(4, ' ');
  $('head-readout').textContent = `${d(eul.y)}° ${d(eul.x)}° ${d(eul.z)}°`;
  $('gaze-readout').textContent = `${st.gaze.yaw.toFixed(0).padStart(4)}° ${st.gaze.pitch.toFixed(0).padStart(4)}°`;
}

// ---------------------------------------------------------------- physics UI
function savePhysicsOverrides(): void {
  if (!avatar || !modelHash) return;
  settings.physicsOverrides[modelHash] = avatar.physics.getOverrides();
  persist();
}
function setPhysicsMode(m: PhysicsMode): void {
  settings.physics.mode = m;
  avatar?.physics.setSettings({ mode: m });
  persist();
  segSet('phys-mode', m);
}
segBind('phys-mode', () => settings.physics.mode, (v) => setPhysicsMode(v as PhysicsMode));
checkBind('phys-stabilise', () => settings.physics.stabilise, (v) => {
  settings.physics.stabilise = v;
  avatar?.physics.setSettings({ stabilise: v });
  persist();
});
rangeBind('phys-maxspeed', () => settings.physics.maxSpeed, (v) => {
  settings.physics.maxSpeed = v;
  avatar?.physics.setSettings({ maxSpeed: v });
  persist();
}, 1);
rangeBind('phys-inertia', () => settings.physics.inertia, (v) => {
  settings.physics.inertia = v;
  avatar?.physics.setSettings({ inertia: v });
  persist();
});
rangeBind('phys-coldamp', () => settings.physics.collisionDamping, (v) => {
  settings.physics.collisionDamping = v;
  avatar?.physics.setSettings({ collisionDamping: v });
  persist();
});
selectBind('phys-substeps', () => String(settings.physics.substeps), (v) => {
  settings.physics.substeps = Number(v);
  avatar?.physics.setSettings({ substeps: Number(v) });
  persist();
});
$('btn-phys-reset').addEventListener('click', () => avatar?.physics.reset());
$('btn-phys-clear').addEventListener('click', () => {
  if (!avatar) return;
  avatar.physics.setOverrides({ chains: {}, colliders: {} });
  savePhysicsOverrides();
  buildPhysicsUI();
});

function buildPhysicsUI(): void {
  const list = $('chain-list');
  const cols = $('collider-list');
  list.innerHTML = '';
  cols.innerHTML = '';
  if (!avatar) return;
  const ph = avatar.physics;
  $('chain-count').textContent = `[${ph.chains.length}]`;
  $('collider-count').textContent = `[${ph.colliders.length}]`;
  if (!ph.chains.length) list.innerHTML = '<span class="empty-note">THIS MODEL HAS NO SPRING BONES</span>';
  for (const ch of ph.chains) {
    const o = ph.chainOverride(ch.name);
    const row = document.createElement('div');
    row.className = `chain-row${o.enabled ? '' : ' off'}`;
    row.innerHTML = `<input type="checkbox" /><span class="name" title="${ch.name}">${ch.name} <small>${ch.joints.length}J</small></span><input type="number" step="0.1" min="0" max="10" title="stiffness ×" /><input type="number" step="0.1" min="0" max="3" title="drag ×" /><input type="number" step="0.1" min="0" max="5" title="gravity ×" />`;
    const [on, s, d, g] = row.querySelectorAll('input');
    on.checked = o.enabled;
    s.value = String(o.stiffness);
    d.value = String(o.drag);
    g.value = String(o.gravity);
    on.addEventListener('change', () => {
      ph.setChain(ch.name, { enabled: on.checked });
      row.classList.toggle('off', !on.checked);
      savePhysicsOverrides();
    });
    const num = (el: HTMLInputElement, key: 'stiffness' | 'drag' | 'gravity') =>
      el.addEventListener('change', () => {
        ph.setChain(ch.name, { [key]: Math.max(0, Number(el.value) || 0) });
        savePhysicsOverrides();
      });
    num(s, 'stiffness');
    num(d, 'drag');
    num(g, 'gravity');
    list.append(row);
  }
  if (!ph.colliders.length) cols.innerHTML = '<span class="empty-note">NO COLLIDERS</span>';
  for (const c of ph.colliders) {
    const lab = document.createElement('label');
    lab.className = 'check';
    lab.innerHTML = `<input type="checkbox" /><span>${c.name}</span>`;
    const cb = lab.querySelector('input')!;
    cb.checked = ph.colliderEnabled(c.name);
    cb.addEventListener('change', () => {
      ph.setCollider(c.name, cb.checked);
      savePhysicsOverrides();
    });
    cols.append(lab);
  }
}

// ---------------------------------------------------------------- capture view
function setCapture(on: boolean): void {
  document.body.classList.toggle('capture', on);
  const hint = $('capture-hint');
  if (on) {
    hint.classList.add('show');
    setTimeout(() => hint.classList.remove('show'), 1800);
  } else hint.classList.remove('show');
  requestAnimationFrame(() => viewer.resize());
}
$('btn-capture').addEventListener('click', () => setCapture(true));
$('btn-open').addEventListener('click', () => openModelDialog());

function setDebug(on: boolean): void {
  settings.ui.debug = on;
  document.body.classList.toggle('no-debug', !on);
  persist();
}

// ---------------------------------------------------------------- keyboard
window.addEventListener('keydown', (e) => {
  const tag = (e.target as HTMLElement).tagName;
  if (tag === 'INPUT' && (e.target as HTMLInputElement).type !== 'checkbox' && (e.target as HTMLInputElement).type !== 'range') return;
  if (tag === 'SELECT' || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  const capture = document.body.classList.contains('capture');
  if (k === 'escape' && capture) setCapture(false);
  else if (k === 'h') setCapture(!capture);
  else if (k === 'o') openModelDialog();
  else if (k === 'c') calibrate();
  else if (k === 'm') setMirror(!settings.mirror);
  else if (k === 't') setPreview(!settings.preview);
  else if (k === 'v') {
    settings.vmc.enabled = !settings.vmc.enabled;
    refreshInputs();
    persist();
    applyVmc();
  } else if (k === 'd') setDebug(!settings.ui.debug);
  else if (k === 'f') setTab('face');
  else if (k === 'p') setTab('physics');
  else if (k === 'r') avatar?.physics.reset();
  else if (k === '1') setMode('face');
  else if (k === '2') setMode('upper');
  else if (k === '3') setMode('hands');
  else if (k === '8') setPhysicsMode('off');
  else if (k === '9') setPhysicsMode('stiff');
  else if (k === '0') setPhysicsMode('normal');
  else return;
  e.preventDefault();
});

// ---------------------------------------------------------------- drag & drop
const drop = $('drop');
await onNativeDrop(
  async (paths) => {
    const p = paths.find((x) => /\.vrm$/i.test(x));
    if (p) await loadModel(await readPath(p), baseName(p), p);
    else setStatus('DROP A .VRM FILE', true);
  },
  (on) => drop.classList.toggle('on', on),
);
if (!isTauri) {
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('on');
  });
  window.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) drop.classList.remove('on');
  });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    drop.classList.remove('on');
    const f = Array.from(e.dataTransfer?.files ?? []).find((x) => /\.vrm$/i.test(x.name));
    if (f) await loadModel(await f.arrayBuffer(), f.name, null);
  });
}

// ---------------------------------------------------------------- render loop + stats
const previewCanvas = $<HTMLCanvasElement>('preview-canvas');
const previewCtx = previewCanvas.getContext('2d')!;
const renderTimes: number[] = [];
let last = performance.now();
let lastStats = 0;
let frameMs = 0;

function tick(now: number): void {
  requestAnimationFrame(tick);
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  const t0f = performance.now();
  avatar?.update(dt);
  viewer.render();
  frameMs += 0.1 * (performance.now() - t0f - frameMs);
  frameCount++;

  if (settings.preview && !document.body.classList.contains('capture')) {
    const v = source.video;
    if (v.videoWidth && previewCanvas.height !== Math.round((320 * v.videoHeight) / v.videoWidth)) {
      previewCanvas.width = 320;
      previewCanvas.height = Math.round((320 * v.videoHeight) / v.videoWidth);
    }
    drawPreview(previewCtx, v, lastResult, settings.mirror, ACCENT);
  }
  sendVmc();

  renderTimes.push(now);
  while (renderTimes.length && renderTimes[0] < now - 1000) renderTimes.shift();
  if (now - lastStats > 250) {
    lastStats = now;
    updateFaceReadout();
    const s = tracker.stats;
    const body = settings.mode !== 'face';
    $('d-render').textContent = `${renderTimes.length} FPS ${frameMs.toFixed(1)}MS`;
    $('d-track').textContent = `FACE ${s.face.fps} / BODY ${body ? s.body.fps : '-'} FPS`;
    $('d-latency').textContent = `${s.face.latency.toFixed(0)} / ${body ? s.body.latency.toFixed(0) : '-'} MS`;
    $('d-infer').textContent = `${s.face.infer.toFixed(1)}/${s.body.pose.toFixed(1)}/${s.body.hands.toFixed(1)} MS`;
    $('d-where').textContent = `${s.where.toUpperCase()} ${s.delegate}`;
    $('d-phys').textContent = avatar
      ? `${settings.physics.mode.toUpperCase()} ${avatar.physics.lastSteps} STEP/F`
      : '-';
  }
}

// ?debuglog=1: print a stats line every 2 s (stdout in the desktop app).
if (params.get('debuglog') === '1') {
  setInterval(() => {
    const s = tracker.stats;
    debugLog(
      `render ${renderTimes.length}fps frame ${frameMs.toFixed(1)}ms | face ${s.face.fps}fps lat ${s.face.latency.toFixed(0)}ms inf ${s.face.infer.toFixed(1)}ms | body ${s.body.fps}fps lat ${s.body.latency.toFixed(0)}ms pose ${s.body.pose.toFixed(1)} hands ${s.body.hands.toFixed(1)}ms | ${s.where} ${s.delegate} | ${$('status').textContent} | ${$('sync-mode').textContent} | vmc ${$('vmc-stats').textContent}`,
    );
  }, 2000);
}

async function pollVmc(): Promise<void> {
  const s = await vmcStats().catch(() => null);
  $('vmc-stats').textContent = !settings.vmc.enabled
    ? 'OFF'
    : s
      ? `${s.frames} FR ${(s.bytes / 1024).toFixed(0)} KB${s.errors ? ` ${s.errors} ERR` : ''}`
      : 'DESKTOP APP ONLY';
}
setInterval(pollVmc, 1000);

// ---------------------------------------------------------------- boot
refreshInputs();
setTab(settings.ui.tab);
setDebug(settings.ui.debug);
$('preview-box').classList.toggle('hidden', !settings.preview);
$<HTMLSelectElement>('phys-substeps').value = String(settings.physics.substeps);
await applyBackground();
buildBlendshapeList();
if (params.get('capture') === '1') setCapture(true);
requestAnimationFrame(tick);
applyVmc();

const modelUrl = params.get('model');
if (modelUrl) {
  readPath(modelUrl)
    .then((b) => loadModel(b, baseName(modelUrl), null))
    .catch((e) => setStatus(`MODEL: ${e.message}`, true));
} else if (isTauri && settings.lastModelPath) {
  const p = settings.lastModelPath;
  readPath(p)
    .then((b) => loadModel(b, baseName(p), p))
    .catch(() => setStatus('LAST MODEL NOT FOUND, OPEN ONE', true));
}

tracker
  .init()
  .then(() => startSource())
  .catch((e) => setStatus(`TRACKER FAILED: ${e.message}`, true));

// Test hooks (used by the Playwright harness in scripts/).
Object.assign(window, {
  __puppet: {
    settings,
    viewer,
    tracker,
    face,
    source,
    get avatar() {
      return avatar;
    },
    get lastResult() {
      return lastResult;
    },
    get frames() {
      return frameCount;
    },
    record,
    calibrate,
    frame: (f: Framing) => {
      currentFraming = f;
      segSet('framing', f);
      viewer.frame(f);
    },
  },
});
