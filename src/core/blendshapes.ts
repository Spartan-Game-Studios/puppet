/**
 * Blendshape mapping: MediaPipe FaceLandmarker blendshapes (ARKit naming) onto
 * a VRM's expressions.
 *
 * Two routes:
 *  - Perfect sync: the model carries the ARKit-named expressions itself (as VRM
 *    1.0 custom expressions or VRM 0.x blend shape clips). Each tracked value
 *    drives the expression of the same name, 1:1.
 *  - Presets: derive the VRM presets (blink, aa/ih/ou/ee/oh, emotions) from the
 *    blendshapes for models that only have presets.
 *
 * Everything here is pure (no three.js) so it can be unit tested.
 */

/** The 52 ARKit face blendshape names, in Apple's documented order. */
export const ARKIT_NAMES = [
  'eyeBlinkLeft', 'eyeLookDownLeft', 'eyeLookInLeft', 'eyeLookOutLeft', 'eyeLookUpLeft',
  'eyeSquintLeft', 'eyeWideLeft',
  'eyeBlinkRight', 'eyeLookDownRight', 'eyeLookInRight', 'eyeLookOutRight', 'eyeLookUpRight',
  'eyeSquintRight', 'eyeWideRight',
  'jawForward', 'jawLeft', 'jawRight', 'jawOpen',
  'mouthClose', 'mouthFunnel', 'mouthPucker', 'mouthLeft', 'mouthRight',
  'mouthSmileLeft', 'mouthSmileRight', 'mouthFrownLeft', 'mouthFrownRight',
  'mouthDimpleLeft', 'mouthDimpleRight', 'mouthStretchLeft', 'mouthStretchRight',
  'mouthRollLower', 'mouthRollUpper', 'mouthShrugLower', 'mouthShrugUpper',
  'mouthPressLeft', 'mouthPressRight', 'mouthLowerDownLeft', 'mouthLowerDownRight',
  'mouthUpperUpLeft', 'mouthUpperUpRight',
  'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight',
  'cheekPuff', 'cheekSquintLeft', 'cheekSquintRight',
  'noseSneerLeft', 'noseSneerRight',
  'tongueOut',
] as const;

export type ArkitName = (typeof ARKIT_NAMES)[number];
export type Blendshapes = Record<string, number>;

export const VRM_PRESETS = [
  'blink', 'blinkLeft', 'blinkRight',
  'aa', 'ih', 'ou', 'ee', 'oh',
  'happy', 'angry', 'sad', 'surprised', 'relaxed',
] as const;
export type VrmPreset = (typeof VRM_PRESETS)[number];

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0);

/** Normalise an expression name for matching: lower case, letters and digits only. */
export const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Find the model's expression for each ARKit name. Matching ignores case and
 * punctuation, so `EyeBlinkLeft`, `eye_blink_left` and `eyeBlinkLeft` all match.
 * Returns ARKit name -> model expression name.
 */
export function buildPerfectSyncMap(expressionNames: readonly string[]): Map<ArkitName, string> {
  const byNorm = new Map<string, string>();
  for (const n of expressionNames) byNorm.set(normName(n), n);
  const map = new Map<ArkitName, string>();
  for (const a of ARKIT_NAMES) {
    const hit = byNorm.get(normName(a));
    if (hit) map.set(a, hit);
  }
  return map;
}

/** A model counts as perfect-sync when it has at least this many ARKit expressions. */
export const PERFECT_SYNC_MIN = 40;

export const isPerfectSync = (map: Map<ArkitName, string>) => map.size >= PERFECT_SYNC_MIN;

/** Swap Left/Right in a blendshape name (for mirrored tracking). */
export function mirrorName(name: string): string {
  if (name.endsWith('Left')) return name.slice(0, -4) + 'Right';
  if (name.endsWith('Right')) return name.slice(0, -5) + 'Left';
  if (name === 'jawLeft') return 'jawRight';
  if (name === 'mouthLeft') return 'mouthRight';
  return name;
}

/** Mirror a whole blendshape set. jawLeft/mouthLeft are covered by the Left/Right rule. */
export function mirrorBlendshapes(bs: Blendshapes): Blendshapes {
  const out: Blendshapes = {};
  for (const k in bs) out[mirrorName(k)] = bs[k];
  return out;
}

/** Per-blendshape response shaping. */
export interface GainCurve {
  /** Multiplier applied after the curve. */
  gain: number;
  /** Exponent: < 1 lifts small values (reads stronger), > 1 suppresses them. */
  curve: number;
}

export const IDENTITY_GC: GainCurve = { gain: 1, curve: 1 };

/**
 * Defaults tuned for webcam tracking: MediaPipe rarely reports a full blink or
 * a full smile, and mouths need to read strongly on stream.
 */
export function defaultGainCurves(): Record<string, GainCurve> {
  const g: Record<string, GainCurve> = {};
  for (const n of ARKIT_NAMES) g[n] = { ...IDENTITY_GC };
  const set = (names: string[], gc: GainCurve) => names.forEach((n) => (g[n] = { ...gc }));
  set(['eyeBlinkLeft', 'eyeBlinkRight'], { gain: 1.35, curve: 0.9 });
  set(['jawOpen'], { gain: 1.4, curve: 0.85 });
  set(['mouthSmileLeft', 'mouthSmileRight'], { gain: 1.5, curve: 0.8 });
  set(['mouthFunnel', 'mouthPucker'], { gain: 1.5, curve: 0.85 });
  set(['mouthStretchLeft', 'mouthStretchRight', 'mouthFrownLeft', 'mouthFrownRight'], { gain: 1.4, curve: 0.9 });
  set(['browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight'], { gain: 1.6, curve: 0.9 });
  set(['eyeWideLeft', 'eyeWideRight'], { gain: 1.3, curve: 1 });
  return g;
}

export const applyGainCurve = (v: number, gc: GainCurve = IDENTITY_GC) =>
  clamp01(gc.gain * Math.pow(clamp01(v), gc.curve));

/**
 * Neutral-face calibration: rescale so the captured resting value reads 0 and
 * 1 still reads 1. A baseline of 0 (or none) is the identity.
 */
export function applyCalibration(v: number, baseline = 0): number {
  if (baseline <= 0) return clamp01(v);
  if (baseline >= 0.99) return 0;
  return clamp01((v - baseline) / (1 - baseline));
}

const avg = (a: number, b: number) => (a + b) / 2;
const get = (bs: Blendshapes, k: string) => bs[k] ?? 0;

export interface PresetOptions {
  /** Include happy/angry/sad/surprised/relaxed. */
  emotions: boolean;
  /** Emotion values below this are ignored, so a resting face stays neutral. */
  emotionDeadzone: number;
}

export const DEFAULT_PRESET_OPTIONS: PresetOptions = { emotions: true, emotionDeadzone: 0.25 };

const deadzone = (v: number, dz: number) => (v <= dz ? 0 : clamp01((v - dz) / (1 - dz)));

/**
 * Derive VRM preset expression weights from (already calibrated and shaped)
 * ARKit blendshapes.
 */
export function derivePresets(bs: Blendshapes, opts: PresetOptions = DEFAULT_PRESET_OPTIONS): Record<VrmPreset, number> {
  // Blinks: a shared closure drives `blink`, the remainder drives each side,
  // so a both-eyes blink never double-applies.
  const bl = clamp01(get(bs, 'eyeBlinkLeft'));
  const br = clamp01(get(bs, 'eyeBlinkRight'));
  const blink = Math.min(bl, br);

  // Visemes from mouth shape.
  const jaw = clamp01(get(bs, 'jawOpen'));
  const pucker = clamp01(get(bs, 'mouthPucker'));
  const funnel = clamp01(get(bs, 'mouthFunnel'));
  const smile = avg(get(bs, 'mouthSmileLeft'), get(bs, 'mouthSmileRight'));
  const stretch = avg(get(bs, 'mouthStretchLeft'), get(bs, 'mouthStretchRight'));
  const wide = clamp01(stretch + 0.5 * smile);
  const round = Math.max(pucker, funnel);

  let aa = clamp01(jaw * (1 - round) * (1 - 0.5 * wide));
  let oh = clamp01(funnel * (0.4 + jaw));
  let ou = clamp01(pucker * (1 - 0.6 * jaw));
  let ee = clamp01(wide * (1 - jaw) * 1.2);
  let ih = clamp01(wide * jaw * 2);
  // Visemes are exclusive shapes; keep their sum <= 1 so meshes don't overdrive.
  const sum = aa + oh + ou + ee + ih;
  if (sum > 1) {
    aa /= sum; oh /= sum; ou /= sum; ee /= sum; ih /= sum;
  }

  const out: Record<VrmPreset, number> = {
    blink,
    blinkLeft: bl - blink,
    blinkRight: br - blink,
    aa, ih, ou, ee, oh,
    happy: 0, angry: 0, sad: 0, surprised: 0, relaxed: 0,
  };

  if (opts.emotions) {
    const dz = opts.emotionDeadzone;
    const browDown = avg(get(bs, 'browDownLeft'), get(bs, 'browDownRight'));
    const browOuterUp = avg(get(bs, 'browOuterUpLeft'), get(bs, 'browOuterUpRight'));
    const frown = avg(get(bs, 'mouthFrownLeft'), get(bs, 'mouthFrownRight'));
    const eyeWide = avg(get(bs, 'eyeWideLeft'), get(bs, 'eyeWideRight'));
    const squint = avg(get(bs, 'eyeSquintLeft'), get(bs, 'eyeSquintRight'));
    out.happy = deadzone(smile, dz);
    out.angry = deadzone(browDown * (1 - smile), dz);
    out.sad = deadzone(clamp01(0.7 * frown + 0.4 * get(bs, 'browInnerUp') * (1 - browOuterUp)), dz);
    out.surprised = deadzone(clamp01(0.5 * browOuterUp + 0.5 * eyeWide) * (1 - smile), dz);
    out.relaxed = deadzone(clamp01(smile * squint * 2), dz);
  }
  return out;
}

/**
 * Gaze from the eyeLook blendshapes, in degrees. Positive yaw = the subject
 * looks to their own left; positive pitch = up.
 */
export function gazeFromBlendshapes(bs: Blendshapes, maxYawDeg = 30, maxPitchDeg = 25): { yaw: number; pitch: number } {
  const toLeft = avg(get(bs, 'eyeLookOutLeft'), get(bs, 'eyeLookInRight'));
  const toRight = avg(get(bs, 'eyeLookInLeft'), get(bs, 'eyeLookOutRight'));
  const up = avg(get(bs, 'eyeLookUpLeft'), get(bs, 'eyeLookUpRight'));
  const down = avg(get(bs, 'eyeLookDownLeft'), get(bs, 'eyeLookDownRight'));
  return { yaw: (toLeft - toRight) * maxYawDeg, pitch: (up - down) * maxPitchDeg };
}

/** VRM 0.x blend shape clip names, used when sending presets over VMC. */
export const VRM0_PRESET_NAMES: Record<VrmPreset, string> = {
  blink: 'Blink', blinkLeft: 'Blink_L', blinkRight: 'Blink_R',
  aa: 'A', ih: 'I', ou: 'U', ee: 'E', oh: 'O',
  happy: 'Joy', angry: 'Angry', sad: 'Sorrow', surprised: 'Surprised', relaxed: 'Fun',
};
