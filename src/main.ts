/**
 * VPuppet: app entry. Wires the source -> tracker -> face/body processing ->
 * avatar -> renderer / VMC, and binds the UI.
 *
 * URL parameters (dev / test harness):
 *   ?source=file&src=<video url>   feed a recorded clip instead of the camera
 *   ?model=<url>                   load a VRM from a URL at start
 *   ?tracker=main                  run MediaPipe on the main thread
 *   ?mode=face|upper|hands         override the tracking mode
 *   ?capture=1                     start in capture view
 *   ?vcam=1&vcamres=1920x1080      start the virtual camera output
 *   ?home=0|1                      skip / force the HOME library screen at start
 *                                  (default: shown unless ?model= or ?capture=1)
 */
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';
import '@fontsource/jetbrains-mono/800.css';
import './styles.css';

import { Euler, Quaternion } from 'three';
import { ARKIT_NAMES, defaultGainCurves } from './core/blendshapes';
import { smoothingToParams } from './core/oneEuro';
import { PoseFilter } from './core/poseFilter';
import { Avatar, limbFollowRateFor, loadAvatar } from './scene/avatar';
import { Viewer, type Framing } from './scene/viewer';
import { FaceProcessor } from './tracking/faceProcessor';
import { drawPreview } from './tracking/overlay';
import type { BodyMode, TrackerResult } from './tracking/protocol';
import { listCameras, VideoSource } from './tracking/source';
import { Tracker } from './tracking/tracker';
import { HandStats } from './tracking/handStats';
import { faceCovered } from './tracking/faceOcclusion';
import { GestureTracker } from './core/gestures';
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
  vcamSelectDevice,
  vcamSetup,
  vcamStats,
  vcamStatus,
  type VcamStatus,
} from './app/platform';
import { VCAM_RESOLUTIONS, type VcamResolution } from './vcam/frame';
import { VirtualCamOutput } from './vcam/output';
import { loadSettings, saveSettings, type Settings } from './app/settings';
import { bindEnvironmentUi } from './app/environmentUi';
import { mountHome } from './app/home';
import { mountDemo } from './app/demo';
import { mountDoctor, type Doctor } from './app/doctorUi';
import { mountMotion, type MotionFeatures } from './anim/features';
import { withPresetBlends } from './vmc/presets';
import type { PhysicsMode } from './physics/stableSprings';
import { buildClothUI } from './app/clothUi';
import { installBackgroundLoop } from './app/backgroundLoop';
import { mountVcamControls } from './app/vcamControls';
import { createModal, openModal, type Modal } from './app/modal';
import { mountCardSection } from './app/ui';
import { PadNav } from './app/padNav';
import { mcpLog, mountMcpBridge } from './app/mcpBridge';
import { mountVmcIn } from './app/vmcInUi';
import { applyDom, locale, t, LOCALE_NAMES, LOCALES, setLocale, type Locale } from './i18n';

// Static markup in the chosen language before anything reads it (modal titles
// come from data-title, cards and modals are cloned from templates).
applyDom(document);
{
  const lang = document.getElementById('lang') as HTMLSelectElement;
  for (const l of LOCALES) lang.add(new Option(LOCALE_NAMES[l], l, false, l === locale));
  lang.addEventListener('change', () => setLocale(lang.value as Locale));
}

const params = new URLSearchParams(location.search);
for (const [k, v] of new URLSearchParams(await devQuery())) params.set(k, v);
// Keep rendering, tracking and sending while minimized / hidden (?bgloop=0 turns it off for A/B tests).
const bgLoop = params.get('bgloop') === '0' ? null : installBackgroundLoop();
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const ACCENT = '#ff3b00';

const settings: Settings = await loadSettings();
const urlMode = params.get('mode') as BodyMode | null;
if (urlMode && ['face', 'upper', 'hands'].includes(urlMode)) settings.mode = urlMode;
if (params.has('mirror')) settings.mirror = params.get('mirror') === '1';
if (params.has('vmc')) settings.vmc.enabled = params.get('vmc') === '1';
if (params.has('vcam')) settings.vcam.enabled = params.get('vcam') === '1';
const urlVcamRes = params.get('vcamres') as VcamResolution | null;
if (urlVcamRes && urlVcamRes in VCAM_RESOLUTIONS) settings.vcam.resolution = urlVcamRes;
const persist = () => saveSettings(settings);

// ---------------------------------------------------------------- stage layout: modals + camera card
// Every settings window is the one modal component (src/app/modal.ts) holding
// a group from #modal-src; the top-bar button with the same data-modal opens it.
const modals: Record<string, Modal> = {};
for (const group of [...document.querySelectorAll<HTMLElement>('#modal-src > [data-modal]')]) {
  const id = group.dataset.modal!;
  const buttons = [...document.querySelectorAll<HTMLElement>(`#settings-nav [data-modal="${id}"]`)];
  modals[id] = createModal({ id: id === 'model-info' ? 'model-info' : `modal-${id}`, idx: group.dataset.idx ?? '', title: group.dataset.title ?? id.toUpperCase(), content: [...group.childNodes], buttons });
  modals[id].el.dataset.modal = id;
  group.remove();
}
/** Toggle a settings modal from its shortcut key (focus returns to its top-bar button). */
function toggleModal(id: string): void {
  modals[id]?.toggle(document.querySelector<HTMLElement>(`#settings-nav [data-modal="${id}"]`));
}
const camSections = Object.fromEntries(
  [...document.querySelectorAll<HTMLElement>('#cam-sections > .csec-mount')].map((m) => {
    const key = m.dataset.csec as 'source' | 'vcam';
    return [key, mountCardSection(m, settings.ui.cam[key] ?? true, (open) => {
      settings.ui.cam[key] = open;
      persist();
    })];
  }),
);

// ---------------------------------------------------------------- core objects
const viewer = new Viewer($('stage'));
const vcam = new VirtualCamOutput(viewer);
mountVcamControls($('vcam-controls')); // owns #vcam-enabled; mount before the binds below
vcam.send = params.get('vcamsend') !== '0';
const source = new VideoSource($<HTMLVideoElement>('video'));
const face = new FaceProcessor();
face.mirror = settings.mirror;
face.gains = settings.gains;
face.calibration = settings.calibration;
face.setSmoothing(settings.smoothing);
const poseFilter = new PoseFilter();
const tracker = new Tracker({
  mode: settings.mode,
  maxFps: settings.trackFps,
  poseModel: settings.poseModel,
  wantFaceLandmarks: settings.preview,
});
/** Hand gestures (hands mode): `gestures.on(e => ...)` fires on every change. */
const gestures = new GestureTracker();
/** Per-side hand search status and found % over the last 3 s (debug overlay, ?debuglog=1). */
const handStats = new HandStats(3000);
gestures.mirror = settings.mirror;
let avatar: Avatar | null = null;
/** Steam demo out of hours (src/app/demo.ts): no stage, no outputs; HOME still works. */
let demoLocked = false;
let modelHash: string | null = null;
let lastResult: TrackerResult | null = null;
let frameCount = 0;

// ---------------------------------------------------------------- status
function setStatus(s: string, err = false): void {
  const el = $('status');
  el.textContent = s.toUpperCase();
  el.classList.toggle('status-err', err);
  mcpLog.push(s, err);
  if (err) console.warn('[vpuppet]', s);
}
tracker.onStatus = (s, err) => setStatus(s, !!err);

// ---------------------------------------------------------------- tracking -> avatar
function updatePoseFilter(): void {
  poseFilter.setParams(smoothingToParams(settings.smoothing * 0.8));
  if (avatar) {
    avatar.drive.smoothing = settings.smoothing;
    avatar.drive.limbFollowRate = limbFollowRateFor(settings.smoothing);
  }
}
updatePoseFilter();

// ?record=1: keep a per-result log for the test harness (scripts/track-clip.mjs).
const record: unknown[] | null = params.get('record') === '1' ? [] : null;

let lastFace: TrackerResult | null = null;
let lastBody: TrackerResult | null = null;
let faceHeldSince: number | null = null;
let faceHeld = false;
tracker.onHands = (r) => {
  handStats.push(r);
  if (record) record.push({ handsFrame: true, vt: r.videoTime, hands: (r.hands ?? []).map((h) => h.userSide ?? h.handedness), wrists: (r.hands ?? []).map((h) => [h.landmarks[0].x, h.landmarks[0].y]), status: r.handStatus, ms: r.timings.hands });
};
tracker.onResult = (r) => {
  const t = r.t / 1000;
  if (r.pipeline === 'face') {
    lastFace = r;
    // A hand over the face: FaceLandmarker still returns a face, but its head
    // pose and mouth go wrong, so hold the last good face (for up to 3 s).
    const covered =
      settings.mode === 'hands' && !!r.face && faceCovered((lastBody?.hands ?? []).map((h) => h.landmarks), lastBody?.pose?.image, r.width / r.height);
    faceHeldSince = covered ? (faceHeldSince ?? t) : null;
    faceHeld = covered && t - faceHeldSince! < 3;
    if (r.face && !faceHeld) avatar?.setFace(face.process(r.face, t));
  } else {
    lastBody = r;
    if (avatar && settings.mode !== 'face' && r.pose) {
      // A hands update re-sends a pose that is already filtered.
      const pose = (r.handsUpdate && poseFilter.last) || poseFilter.filter(r.pose, t);
      avatar.setBody({ poseWorld: pose.world, poseImage: pose.image, hands: settings.mode === 'hands' ? (r.hands ?? []) : [], aspect: r.width / r.height, handStatus: settings.mode === 'hands' ? r.handStatus : undefined });
    }
    gestures.update(settings.mode === 'hands' ? (r.hands ?? []) : [], r.t);
    // One row per pose (a hands update shows up in the next row's rig).
    if (record && avatar && !r.handsUpdate) {
      record.push({ body: true, vt: r.videoTime, hands: (r.hands ?? []).map((h) => h.userSide ?? h.handedness), handsRan: !!r.handsRan, rig: avatar.probe(), gestures: { ...gestures.current } });
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
      faceHeld,
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
/** 07 MOTION / 08 HOTKEYS / 09 LIP SYNC (src/anim/features.ts), mounted below. */
let motion: MotionFeatures | null = null;
async function loadModel(buf: ArrayBuffer, label: string, path: string | null): Promise<boolean> {
  if (demoLocked) {
    demo.nudge();
    setStatus(t('demo.statusRefused'), true);
    return false;
  }
  setStatus(t('stage.loading', { name: label }));
  try {
    const { avatar: a, hash, facts } = await loadAvatar(buf, settings.physics);
    applyDrive(a);
    const ov = settings.physicsOverrides[hash];
    if (ov) a.physics.setOverrides(ov);
    viewer.setAvatar(a);
    viewer.frame(currentFraming);
    avatar = a;
    modelHash = hash;
    motion?.attach(a, hash);
    if (path) {
      settings.lastModelPath = path;
      persist();
    }
    $('model-name').textContent = a.name || label;
    $('model-name').title = `${a.name} [${label}]`;
    const ps = a.perfectSync.size;
    $('sync-mode').textContent = a.usePerfectSync
      ? t('stage.syncPerfect', { n: ps })
      : ps
        ? t('stage.syncPresetsArkit', { n: a.presets.size, ps })
        : t('stage.syncPresets', { n: a.presets.size });
    $('empty').classList.add('hidden');
    buildBlendshapeList();
    buildPhysicsUI();
    setStatus(t('stage.modelOk', { chains: a.physics.chains.length, joints: a.physics.jointCount }));
    home.modelLoaded(hash, buf, label, path, facts.warnings); // library: header name, licence, import if new; model checks
    return true;
  } catch (e) {
    setStatus(t('stage.modelFailed', { error: (e as Error).message }), true);
    return false;
  }
}

async function openModelDialog(): Promise<void> {
  if (isTauri) {
    const p = await pickPath(t('stage.pickVrm'), ['vrm']);
    if (p) await loadModel(await readPath(p), baseName(p), p);
  } else {
    const f = await pickBrowserFile('.vrm');
    if (f) await loadModel(await f.arrayBuffer(), f.name, null);
  }
}

function applyDrive(a: Avatar): void {
  a.drive.mode = settings.mode;
  a.drive.mirror = settings.mirror;
  a.drive.smoothing = settings.smoothing;
  a.drive.limbFollowRate = limbFollowRateFor(settings.smoothing);
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
      $('cam-pick').classList.add('hidden');
      $('cam-file').classList.remove('hidden');
      $('cam-file').textContent = t('stage.camFile', { name: baseName(src) });
      $('cam-file').title = src;
    } else {
      setStatus(t('stage.openingCamera'));
      info = await source.openCamera(settings.cameraId, settings.resolution, settings.trackFps);
      await refreshCameras();
    }
    $('cam-actual').textContent = info;
    $('preview-info').textContent = info;
    $('btn-camera').textContent = t(source.kind === 'file' ? 'stage.restartClip' : 'stage.restart');
    tracker.start(source.video);
    setStatus(t(avatar ? 'stage.tracking' : 'stage.trackingNoModel'));
  } catch (e) {
    const err = e as DOMException;
    const msg =
      err.name === 'NotAllowedError'
        ? t('stage.camBlocked')
        : err.name === 'NotFoundError'
          ? t('stage.noCameraFound')
          : t('stage.cameraError', { error: err.message });
    setStatus(msg, true);
  }
}

async function refreshCameras(): Promise<void> {
  const sel = $<HTMLSelectElement>('camera');
  const cams = await listCameras();
  sel.innerHTML = '';
  if (!cams.length) sel.append(new Option(t('stage.noCamera'), ''));
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
  if (b.kind === 'environment') envUi.setActive(true);
  else {
    envUi.setActive(false);
    viewer.setBackground(b.kind, b.color, b.kind === 'image' ? bgUrl : null);
  }
  // Cameras have no alpha: CLEAR is sent composited over the chosen colour.
  vcam.setBackground(b.color);
  segSet('bg-kind', b.kind);
  document.querySelectorAll<HTMLButtonElement>('#swatches button').forEach((s) => s.classList.toggle('on', b.kind === 'color' && s.dataset.color === b.color));
  $<HTMLInputElement>('bg-color').value = b.color;
}

async function pickBackgroundImage(): Promise<void> {
  if (isTauri) {
    const p = await pickPath(t('stage.pickImage'), ['png', 'jpg', 'jpeg', 'webp']);
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
  $('btn-preview-min').setAttribute('aria-pressed', String(!settings.preview));
  $<HTMLInputElement>('vmc-enabled').checked = settings.vmc.enabled;
  $<HTMLInputElement>('vcam-enabled').checked = settings.vcam.enabled;
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
$('btn-preview-min').addEventListener('click', () => setPreview(!settings.preview));

function setMirror(v: boolean): void {
  settings.mirror = v;
  face.mirror = v;
  gestures.mirror = v;
  if (avatar) avatar.drive.mirror = v;
  persist();
  refreshInputs();
}
function setPreview(v: boolean): void {
  settings.preview = v;
  tracker.opts.wantFaceLandmarks = v;
  // Off = the card minimized to a strip; the camera and tracking keep running.
  $('preview-box').classList.toggle('min', !v);
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
  tracker.setPoseModel(settings.poseModel);
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
    setStatus(t('stage.neutralCaptured'));
  } else setStatus(t('stage.noFaceCalib'), true);
}
function showCalib(): void {
  const c = settings.calibration;
  $('calib-state').textContent = c.head ? t('stage.calibSet', { n: Object.keys(c.baseline).length }) : t('track.calibNone');
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
// 05 ENVIRONMENT (src/app/environmentUi.ts)
const envUi = bindEnvironmentUi({
  viewer,
  settings,
  persist,
  setStatus,
  setBackgroundKind: (k) => {
    settings.background.kind = k;
    persist();
    applyBackground();
  },
});
segBind('framing', () => currentFraming, (v) => {
  currentFraming = v as Framing;
  viewer.frame(currentFraming);
});

// ---------------------------------------------------------------- VMC UI
async function applyVmc(): Promise<void> {
  if (demoLocked) return;
  try {
    await vmcConfigure(settings.vmc.enabled, settings.vmc.host, settings.vmc.port);
    if (!isTauri && settings.vmc.enabled) setStatus(t('stage.vmcDesktop'), true);
  } catch (e) {
    setStatus(t('stage.vmcError', { error: String(e) }), true);
  }
  // The receiver refuses a port VMC OUT loops back into.
  vmcIn.apply();
}
checkBind('vmc-enabled', () => settings.vmc.enabled, (v) => {
  settings.vmc.enabled = v;
  persist();
  applyVmc();
});
checkBind('vmc-presets', () => settings.vmc.presets, (v) => {
  settings.vmc.presets = v;
  persist();
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

// VMC input: body trackers / phone apps per body region (src/app/vmcInUi.ts, src/vmc/vmcInput.ts).
const vmcIn = mountVmcIn({ settings, persist, avatar: () => avatar, setStatus, mount: document.getElementById('vmcin-controls') });

let vmcBusy = false;
const t0 = performance.now();
function sendVmc(): void {
  if (!settings.vmc.enabled || !avatar || vmcBusy || !isTauri || demoLocked) return;
  const a = avatar;
  const frame: VmcFrame = {
    t: (performance.now() - t0) / 1000,
    root: [0, 0, 0, 0, 0, 0, 1],
    bones: [],
    blends: [],
  };
  for (const name of a.humanBoneNames) {
    const n = a.localPose(name)!;
    frame.bones.push([unityBoneName(name), ...toUnity(n.position, n.quaternion)]);
  }
  for (const [n, v] of a.expressionValues) frame.blends.push([vmcBlendName(n), v]);
  // Preset-only receivers: also send Blink/A/I/U/E/O/Joy/... derived from ARKit.
  if (settings.vmc.presets) frame.blends = withPresetBlends(frame.blends, a.drive.presetOptions);
  vmcBusy = true;
  vmcSend(frame)
    .catch((e) => setStatus(t('stage.vmcError', { error: String(e) }), true))
    .finally(() => (vmcBusy = false));
}

// ---------------------------------------------------------------- virtual camera UI
let vcamStatusLast: VcamStatus | null = null;
let vcamBusy = false;

async function applyVcam(): Promise<void> {
  if (vcamBusy) return;
  vcamBusy = true;
  try {
    if (settings.vcam.enabled && !demoLocked) {
      const [w, h] = VCAM_RESOLUTIONS[settings.vcam.resolution] ?? VCAM_RESOLUTIONS['1280x720'];
      vcam.setBackground(settings.background.color);
      await vcamSelectDevice(settings.vcam.device);
      await vcam.start(w, h);
    } else if (vcam.running) {
      await vcam.stop();
    }
  } catch (e) {
    // Could not open the camera: turn the toggle back off and say why.
    settings.vcam.enabled = false;
    persist();
    refreshInputs();
    if (vcam.running) await vcam.stop().catch(() => {});
    setStatus(t('stage.vcamError', { error: String(e) }), true);
  } finally {
    vcamBusy = false;
  }
  refreshVcamStatus();
}

function setVcam(on: boolean): void {
  settings.vcam.enabled = on;
  persist();
  refreshInputs();
  applyVcam();
}

async function refreshVcamStatus(): Promise<void> {
  const st = await vcamStatus().catch((e) => ({ ...(vcamStatusLast ?? ({} as VcamStatus)), state: 'error', detail: String(e) }) as VcamStatus);
  vcamStatusLast = st;
  const el = $('vcam-state');
  el.textContent = st.detail || st.state.toUpperCase();
  el.title = st.detail;
  el.classList.toggle('state-run', st.state === 'running');
  el.classList.toggle('status-err', st.state === 'error');
  $('vcam-hint').textContent = st.hint ?? '';
  const cmd = $('vcam-cmd');
  cmd.textContent = st.command ?? '';
  cmd.classList.toggle('hidden', !st.command);
  const btn = $('btn-vcam-setup');
  btn.textContent = st.action ?? '';
  btn.classList.toggle('hidden', !st.action);
  // The OBS route is the answer whenever the native camera can't be used.
  $('vcam-obs').classList.toggle('mute', st.state === 'ready' || st.state === 'running');
  const row = $('vcam-device-row');
  row.classList.toggle('hidden', st.devices.length === 0);
  const sel = $<HTMLSelectElement>('vcam-device');
  const opts = st.devices.join('|');
  if (sel.dataset.opts !== opts) {
    sel.dataset.opts = opts;
    sel.innerHTML = '';
    for (const d of st.devices) sel.append(new Option(d, d));
  }
  if (st.device) sel.value = st.device;
}

checkBind('vcam-enabled', () => settings.vcam.enabled, (v) => setVcam(v));
selectBind('vcam-res', () => settings.vcam.resolution, (v) => {
  settings.vcam.resolution = v as VcamResolution;
  persist();
  if (settings.vcam.enabled) applyVcam();
});
$<HTMLSelectElement>('vcam-device').addEventListener('change', async (e) => {
  settings.vcam.device = (e.target as HTMLSelectElement).value || null;
  persist();
  await vcamSelectDevice(settings.vcam.device);
  if (vcam.running) {
    await vcam.stop();
    await applyVcam();
  }
  refreshVcamStatus();
});
$('btn-vcam-setup').addEventListener('click', async () => {
  const btn = $<HTMLButtonElement>('btn-vcam-setup');
  btn.disabled = true;
  try {
    await vcamSetup();
  } catch (e) {
    setStatus(t('stage.vcamError', { error: String(e) }), true);
  } finally {
    btn.disabled = false;
  }
  // Activation (macOS) finishes asynchronously; poll a little faster for a while.
  for (let i = 0; i < 15; i++) setTimeout(refreshVcamStatus, 1000 * (i + 1));
  refreshVcamStatus();
});
$('btn-vcam-refresh').addEventListener('click', () => refreshVcamStatus());
$('vcam-cmd').addEventListener('click', async () => {
  const cmd = $('vcam-cmd');
  try {
    await navigator.clipboard.writeText(cmd.textContent ?? '');
    cmd.classList.add('copied');
    setTimeout(() => cmd.classList.remove('copied'), 600);
  } catch {
    /* clipboard unavailable: the text is selectable */
  }
});
vcam.onError = (e) => setStatus(t('stage.vcamError', { error: String(e) }), true);

async function pollVcam(): Promise<void> {
  const el = $('vcam-stats');
  if (!vcam.running) {
    el.textContent = t('stage.off');
    return;
  }
  const r = await vcamStats().catch(() => null);
  const j = vcam.stats;
  const [w, h] = [vcam.grabber.width, vcam.grabber.height];
  el.textContent = r
    ? `${Math.round(r.fps_out)} FPS ${w}×${h} ${r.format ?? ''}${r.dropped + j.busy ? ` ${t('stage.dropped', { n: r.dropped + j.busy })}` : ''}${r.write_errors ? ` ${t('stage.errCount', { n: r.write_errors })}` : ''}`
    : `${j.fps} FPS ${w}×${h} ${t('stage.notSent')}`;
}
setInterval(pollVcam, 1000);
setInterval(() => {
  if (!document.body.classList.contains('capture')) refreshVcamStatus();
}, 3000);

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
    row.innerHTML = `<span class="name" title="${name}">${name}</span><div class="bs-bar"><div class="fill"></div><div class="raw"></div><span class="num">0.00</span></div><input type="number" step="0.05" min="0" max="4" title="${t('stage.bsGainTitle')}" /><input type="number" step="0.05" min="0.2" max="3" title="${t('stage.bsCurveTitle')}" />`;
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
  buildClothUI($('cloth-ui'), avatar?.physics ?? null, {
    settings: () => settings.physics,
    setSetting: (p) => {
      Object.assign(settings.physics, p);
      avatar?.physics.setSettings(p);
      saveSettings(settings);
    },
    saveOverrides: savePhysicsOverrides,
  });
  const list = $('chain-list');
  const cols = $('collider-list');
  list.innerHTML = '';
  cols.innerHTML = '';
  if (!avatar) return;
  const ph = avatar.physics;
  $('chain-count').textContent = `[${ph.chains.length}]`;
  $('collider-count').textContent = `[${ph.colliders.length}]`;
  if (!ph.chains.length) list.innerHTML = `<span class="empty-note">${t('stage.noSprings')}</span>`;
  for (const ch of ph.chains) {
    const o = ph.chainOverride(ch.name);
    const row = document.createElement('div');
    row.className = `chain-row${o.enabled ? '' : ' off'}`;
    row.innerHTML = `<input type="checkbox" /><span class="name" title="${ch.name}">${ch.name} <small>${t('stage.joints', { n: ch.joints.length })}</small></span><input type="number" step="0.1" min="0" max="10" title="${t('stage.stiffTitle')}" /><input type="number" step="0.1" min="0" max="3" title="${t('stage.dragTitle')}" /><input type="number" step="0.1" min="0" max="5" title="${t('stage.gravTitle')}" />`;
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
  if (!ph.colliders.length) cols.innerHTML = `<span class="empty-note">${t('stage.noColliders')}</span>`;
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
  if (on) openModal()?.close();
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

$('btn-env-toggle').addEventListener('click', () => envUi.toggle());

motion = await mountMotion({ settings, persist, setStatus, stage: $('stage'), gestures, debug: params.get('debuglog') === '1' ? debugLog : undefined });

// ---------------------------------------------------------------- home (model library, src/app/home.ts)
let doctorUi: Doctor | null = null;
const home = await mountHome({
  loadModel,
  setStatus,
  openDoctor: (id) => doctorUi?.open(id),
  lastModelPath: settings.lastModelPath,
  onShow: (on) => {
    if (on) openModal()?.close();
    requestAnimationFrame(() => viewer.resize());
  },
});
doctorUi = mountDoctor({ library: home.library, setStatus });


// ---------------------------------------------------------------- Steam demo (src/app/demo.ts)
const demo = await mountDemo({
  stageActive: () => !!avatar && !home.visible,
  showLibrary: () => home.show(true),
  onLock: () => {
    // Outputs and the webcam off. The settings stay as they were, so the
    // full app starts the way the user left it.
    demoLocked = true;
    if (vcam.running) vcam.stop().catch(() => {});
    vmcConfigure(false, settings.vmc.host, settings.vmc.port).catch(() => {});
    vmcIn.stop();
    source.stop();
    setStatus(t('demo.statusEnded'), true);
  },
});

// ---------------------------------------------------------------- gamepad UI navigation (src/app/padNav.ts)
const padNav = new PadNav({
  homeVisible: () => home.visible,
  menuStart: () => document.querySelector<HTMLElement>('#settings-nav .btn'),
  stageRoot: () => $('app'),
});
if (motion) motion.hotkeys.ui = padNav;

// ---------------------------------------------------------------- keyboard
/** Stage shortcut key -> settings modal. */
const MODAL_KEYS: Record<string, string> = { b: 'scene', f: 'face', p: 'physics', a: 'motion', k: 'hotkeys', s: 'lipsync', n: 'vmc' };
window.addEventListener('keydown', (e) => {
  // A modal is open: Esc (or its own key) closes it; stage shortcuts wait.
  const m = openModal();
  if (m) {
    if (e.key === 'Escape') {
      e.preventDefault();
      m.close();
      return;
    }
    const t = e.target as HTMLElement;
    const typing = t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && !['checkbox', 'range'].includes((t as HTMLInputElement).type));
    const k = e.key.toLowerCase();
    if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && (MODAL_KEYS[k] === m.el.dataset.modal || (k === 'i' && m.id === 'model-info'))) {
      e.preventDefault();
      m.close();
    }
    return;
  }
  const tag = (e.target as HTMLElement).tagName;
  if (tag === 'INPUT' && (e.target as HTMLInputElement).type !== 'checkbox' && (e.target as HTMLInputElement).type !== 'range') return;
  if (tag === 'SELECT' || e.metaKey || e.ctrlKey || e.altKey) return;
  if (home.handleKey(e)) return;
  const k = e.key.toLowerCase();
  const capture = document.body.classList.contains('capture');
  if (k === 'escape' && capture) setCapture(false);
  else if (k === 'escape' || k === 'l') home.show(true);
  else if (k === 'i') home.toggleModelInfo();
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
  } else if (k === 'w') setVcam(!settings.vcam.enabled);
  else if (k === 'd') setDebug(!settings.ui.debug);
  else if (MODAL_KEYS[k]) toggleModal(MODAL_KEYS[k]);
  else if (k === 'r') avatar?.physics.reset();
  else if (k === 'e') envUi.toggle();
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
    if (home.visible) return home.importPaths(paths);
    const p = paths.find((x) => /\.vrm$/i.test(x));
    if (p) await loadModel(await readPath(p), baseName(p), p);
    else {
      const rest = (await motion?.dropPaths(paths)) ?? paths; // animation clips
      if (rest.length && !(await envUi.dropPaths(rest))) setStatus(t('stage.dropHint'), true);
    }
  },
  (on) => {
    drop.classList.toggle('on', on && !home.visible);
    home.setDropHover(on);
  },
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
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (home.visible) return home.importFiles(files);
    const f = files.find((x) => /\.vrm$/i.test(x.name));
    if (f) await loadModel(await f.arrayBuffer(), f.name, null);
    else {
      const rest = (await motion?.dropFiles(files)) ?? files; // animation clips
      if (rest.length) await envUi.dropFiles(rest);
    }
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
  if (motion) {
    motion.hotkeys.enabled = !home.visible;
    motion.tick(now);
  }
  vmcIn.tick();
  avatar?.update(dt);
  viewer.render();
  vcam.tick(now);
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
    $('d-track').textContent = `FACE ${s.face.fps} / BODY ${body ? s.body.fps : '-'}${settings.mode === 'hands' && s.hands.fps ? ` / HANDS ${s.hands.fps}` : ''} FPS`;
    $('d-latency').textContent = `${s.face.latency.toFixed(0)} / ${body ? s.body.latency.toFixed(0) : '-'} MS`;
    $('d-infer').textContent = `${s.face.infer.toFixed(1)}/${s.body.pose.toFixed(1)}/${s.body.hands.toFixed(1)} MS`;
    $('d-gesture').textContent =
      settings.mode === 'hands' ? `L ${gestures.current.left.toUpperCase()} R ${gestures.current.right.toUpperCase()}` : '-';
    $('d-hands').textContent = settings.mode === 'hands' ? handStats.summary() : '-';
    $('d-where').textContent = `${s.where.toUpperCase()} ${s.delegate}`;
    $('d-phys').textContent = avatar
      ? `${settings.physics.mode.toUpperCase()} ${avatar.physics.lastSteps} STEP/F`
      : '-';
    updateStatusBar();
  }
}

// ---------------------------------------------------------------- bottom bar: model status
function trackState(): [string, boolean] {
  const s = tracker.stats;
  if (source.kind === 'none') return [t('stage.noSource'), true];
  if (!s.face.fps && !s.body.fps) return [t('stage.waiting'), false];
  if (!lastFace?.face) return [t('stage.lost'), true];
  if (settings.mode !== 'face' && lastBody && !lastBody.pose) return [t('stage.faceOnly'), true];
  if (settings.mode === 'hands' && !(lastBody?.hands?.length)) return [t('stage.noHands'), false];
  return [t('stage.tracking'), false];
}
function setCell(id: string, text: string, hot = false): void {
  const el = $(id);
  if (el.textContent !== text) {
    el.textContent = text;
    el.title = text;
  }
  el.classList.toggle('hot', hot);
}
function updateStatusBar(): void {
  const [ts, bad] = trackState();
  setCell('track-state', ts, bad);
  const layer = motion?.layer;
  const emote = layer?.playing[0];
  const exprs = layer?.overlay.active ?? [];
  setCell('expr-state', emote ? `▶ ${motion!.library.label(emote)}` : exprs.length ? exprs.join(' + ').toUpperCase() : '-', !!(emote || exprs.length));
  const outs = [settings.vmc.enabled && 'VMC', vcam.running && 'VCAM'].filter(Boolean) as string[];
  setCell('out-state', outs.length ? outs.join(' + ') : t('stage.off'), outs.length > 0);
  camSections.vcam?.setState(vcam.running ? t('stage.on') : settings.vcam.enabled ? '…' : t('stage.off'), vcam.running);
  $('btn-env-toggle').classList.toggle('on', settings.background.kind === 'environment');
}

// ?debuglog=1: print a stats line every 2 s (stdout in the desktop app).
if (params.get('debuglog') === '1') {
  setInterval(() => {
    const s = tracker.stats;
    debugLog(
      `render ${renderTimes.length}fps frame ${frameMs.toFixed(1)}ms | ${vcamLogLine()} | face ${s.face.fps}fps lat ${s.face.latency.toFixed(0)}ms inf ${s.face.infer.toFixed(1)}ms | body ${s.body.fps}fps lat ${s.body.latency.toFixed(0)}ms pose ${s.body.pose.toFixed(1)} hands ${s.body.hands.toFixed(1)}ms | hands3s ${handStats.summary()} [${handStats.countsLine()}] | ${s.where} ${s.delegate} | ${$('status').textContent} | ${$('sync-mode').textContent} | vmc ${$('vmc-stats').textContent} | ${bgLoop?.active ? 'bg' : 'fg'} ${document.visibilityState}`,
    );
  }, 2000);
}

let vcamRust: Awaited<ReturnType<typeof vcamStats>> = null;
function vcamLogLine(): string {
  if (!vcam.running) return 'vcam off';
  vcamStats().then((r) => (vcamRust = r)).catch(() => {});
  const j = vcam.stats;
  const r = vcamRust;
  const js = `vcam ${vcam.grabber.width}x${vcam.grabber.height} sent ${j.sent} ${j.fps}fps busy ${j.busy} err ${j.errors} render ${j.render.toFixed(2)}ms readback ${j.readback.toFixed(2)}ms ipc ${j.ipc.toFixed(2)}ms total ${j.total.toFixed(2)}ms`;
  return r
    ? `${js} | rust in ${r.received} ${r.fps_in}fps out ${r.written} ${r.fps_out}fps drop ${r.dropped} rej ${r.rejected} ${r.format} copy ${r.copy_ms.toFixed(2)}ms write ${r.write_ms.toFixed(2)}ms maxgap ${r.max_gap_ms.toFixed(0)}ms${r.last_error ? ` lasterr ${r.last_error}` : ''}`
    : js;
}

async function pollVmc(): Promise<void> {
  const s = await vmcStats().catch(() => null);
  $('vmc-stats').textContent = !settings.vmc.enabled
    ? t('stage.off')
    : s
      ? `${t('stage.vmcStats', { frames: s.frames, kb: (s.bytes / 1024).toFixed(0) })}${s.errors ? ` ${t('stage.errCount', { n: s.errors })}` : ''}`
      : t('stage.desktopOnly');
}
setInterval(pollVmc, 1000);

// ---------------------------------------------------------------- boot
refreshInputs();
setDebug(settings.ui.debug);
$('preview-box').classList.toggle('min', !settings.preview);
$<HTMLSelectElement>('phys-substeps').value = String(settings.physics.substeps);
await applyBackground();
buildBlendshapeList();
if (params.get('capture') === '1') setCapture(true);
requestAnimationFrame(tick);
applyVmc();
$<HTMLSelectElement>('vcam-res').value = settings.vcam.resolution;
refreshVcamStatus().then(() => {
  if (settings.vcam.enabled) applyVcam();
});

const modelUrl = params.get('model');
if (modelUrl) {
  readPath(modelUrl)
    .then((b) => loadModel(b, baseName(modelUrl), null))
    .catch((e) => setStatus(t('stage.modelError', { error: e.message }), true));
}
// HOME is the first screen (it lists the library, last used first) unless a
// model or capture view was asked for. The old "last model" setting is offered
// for import there once.
home.show(params.has('home') ? params.get('home') === '1' : !modelUrl && params.get('capture') !== '1');

tracker
  .init()
  .then(() => (demoLocked ? undefined : startSource()))
  .catch((e) => setStatus(t('stage.trackerFailed', { error: e.message }), true));

// ---------------------------------------------------------------- AI agents: local MCP server (src/app/mcpBridge.ts, src-tauri/src/mcp)
const mcp = mountMcpBridge({
  settings,
  persist,
  viewer,
  home,
  avatar: () => avatar,
  modelHash: () => modelHash,
  motion: () => motion,
  loadModel,
  demoLocked: () => demoLocked,
  tracker,
  handStats,
  gestures: () => gestures.current,
  trackState: () => trackState()[0],
  sourceKind: () => source.kind,
  renderFps: () => renderTimes.length,
  outputs: () => ({ vmc: settings.vmc.enabled, vmcTarget: `${settings.vmc.host}:${settings.vmc.port}`, vcam: vcam.running }),
  framing: () => currentFraming,
  set: {
    mode: setMode,
    smoothing: (v) => {
      settings.smoothing = v;
      face.setSmoothing(v);
      updatePoseFilter();
      persist();
      $<HTMLInputElement>('smoothing').value = String(v);
      $('smoothing-out').textContent = v.toFixed(2);
    },
    framing: (f) => {
      currentFraming = f;
      segSet('framing', f);
      viewer.frame(f);
    },
    background: (kind, color) => {
      settings.background = { ...settings.background, kind, color: color ?? settings.background.color };
      persist();
      applyBackground();
    },
    physicsMode: setPhysicsMode,
  },
  mount: document.getElementById('mcp-controls'),
  t,
});

// Test hooks (used by the Playwright harness in scripts/).
Object.assign(window, {
  __puppet: {
    settings,
    viewer,
    tracker,
    gestures,
    handStats,
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
    home,
    motion,
    padNav,
    modals,
    vcam,
    mcp,
    vmcIn,
    env: envUi,
    frame: (f: Framing) => {
      currentFraming = f;
      segSet('framing', f);
      viewer.frame(f);
    },
  },
});
