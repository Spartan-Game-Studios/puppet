/**
 * The body/hands half of the test clip (after the face section): gestures,
 * finger curls, crossed arms, hands at the face, torso lean and twist, and an
 * arm leaving the frame. Each moment is a keyframe in a model-independent
 * form (wrist targets in units of arm length, hand orientation vectors, finger
 * curls); renderClip.ts poses the model from it and measures the result.
 *
 * Vectors are given for the avatar's LEFT side in chest space (+X = her left,
 * +Y up, +Z forward, toward the camera) and mirrored for the right.
 */
export type GestureLabel = 'none' | 'open' | 'fist' | 'point' | 'peace' | 'thumbsUp' | 'ok' | 'rock';
export type V3 = [number, number, number];

export interface HandKey {
  /** Wrist target relative to the shoulder, in arm lengths. */
  wrist: V3;
  /** Where the elbow points. */
  pole: V3;
  /** Hand orientation: wrist->knuckles direction and thumb direction. */
  fingers: V3;
  thumbDir: V3;
  /** Curl per finger, 0 = straight, 1 = fist. */
  curl: [number, number, number, number];
  /** Spread of index/middle (peace), 0..1. */
  spread: number;
  /** Thumb folded over the curled fingers, 0..1. */
  fold: number;
  /** Thumb pinched to the index tip (OK sign), 0..1. */
  pinch: number;
}

export interface BodyKey {
  t: number;
  /** Degrees: roll + = lean to her left, pitch + = lean forward, yaw + = turn to her left. */
  torso: { roll: number; pitch: number; yaw: number };
  left: HandKey;
  right: HandKey;
  segment: string;
  /** Held gesture per side (only meaningful between two keys with the same label). */
  gesture: { left: GestureLabel | 'transition'; right: GestureLabel | 'transition' };
}

/** Start of the body section (the face section's arms are back down by 13.6 s). */
export const BODY_START = 14.6;
export const BODY_END = 49.0;

const hand = (o: Partial<HandKey>): HandKey => ({
  wrist: [0.12, -0.95, 0.15],
  pole: [0.3, 0, -1],
  fingers: [0.05, -1, 0.15],
  thumbDir: [0, 0, 1],
  curl: [0.3, 0.3, 0.3, 0.3],
  spread: 0,
  fold: 0,
  pinch: 0,
  ...o,
});

const REST = hand({});
// Hand raised in front of the chest, palm to the camera, fingers up.
const RAISED = { wrist: [0.02, -0.12, 0.6] as V3, pole: [0.6, -1, -0.2] as V3, fingers: [0, 1, 0.1] as V3, thumbDir: [-1, 0, 0] as V3 };
const GESTURES: Record<Exclude<GestureLabel, 'none'>, Partial<HandKey>> = {
  open: { ...RAISED, curl: [0, 0, 0, 0], spread: 0.4, fold: 0, pinch: 0 },
  fist: { ...RAISED, curl: [1, 1, 1, 1], fold: 1 },
  point: { ...RAISED, curl: [0, 1, 1, 1], fold: 1 },
  peace: { ...RAISED, curl: [0, 0, 1, 1], spread: 1, fold: 1 },
  // Fist turned sideways, thumb up.
  thumbsUp: { ...RAISED, fingers: [-1, 0, 0.35], thumbDir: [0, 1, 0], curl: [1, 1, 1, 1], fold: 0 },
  ok: { ...RAISED, curl: [0.65, 0, 0, 0], spread: 0.6, pinch: 1 },
  rock: { ...RAISED, curl: [0, 1, 1, 0], fold: 1 },
};
const SEQUENCE: Array<Exclude<GestureLabel, 'none'>> = ['open', 'fist', 'point', 'peace', 'thumbsUp', 'ok', 'rock', 'open'];

const CROSS_L = hand({ wrist: [-0.72, -0.32, 0.55], pole: [0.4, -1, -0.3], fingers: [-1, 0.35, 0], thumbDir: [0, 1, 0], curl: [0.5, 0.5, 0.5, 0.5] });
const CROSS_R = hand({ wrist: [-0.72, -0.25, 0.42], pole: [0.4, -1, -0.3], fingers: [-1, 0.35, 0], thumbDir: [0, 1, 0], curl: [0.5, 0.5, 0.5, 0.5] });
// Her right hand in front of her right cheek; her left in front of her chin.
const CHEEK = hand({ wrist: [-0.1, 0.12, 0.42], pole: [0.5, -1, 0], fingers: [-0.05, 1, 0.05], thumbDir: [1, 0, 0], curl: [0.15, 0.15, 0.15, 0.15] });
const CHIN = hand({ wrist: [-0.36, -0.06, 0.62], pole: [0.4, -1, -0.2], fingers: [-0.35, 0.6, -0.6], thumbDir: [0, 1, 0.3], curl: [0.5, 0.5, 0.5, 0.5] });
// Forearms forward, palms down (hands on a desk).
const DESK = hand({ wrist: [0.0, -0.22, 0.7], pole: [0.4, -1, -0.4], fingers: [0, -0.15, 1], thumbDir: [-1, 0, 0], curl: [0.5, 0.5, 0.5, 0.5] });
// Arm stretched up and out of the frame.
const OUT = hand({ wrist: [0.8, 0.55, 0.05], pole: [0, -1, -0.5], fingers: [0.8, 0.55, 0.05], thumbDir: [0, 0, 1], curl: [0, 0, 0, 0] });

// Known poses for exact arm checks: a T-pose, and the upper arm out level with the forearm straight up.
const TPOSE = hand({ wrist: [0.98, 0, 0], pole: [0, 0, -1], fingers: [1, 0, 0], thumbDir: [0, 0, 1], curl: [0.1, 0.1, 0.1, 0.1] });
const ABD90 = hand({ wrist: [0.53, 0.47, 0], pole: [1, -1, 0], fingers: [0, 1, 0], thumbDir: [-1, 0, 0], curl: [0.1, 0.1, 0.1, 0.1] });

const ZERO = { roll: 0, pitch: 0, yaw: 0 };

function buildKeys(): BodyKey[] {
  const keys: BodyKey[] = [];
  const k = (t: number, left: HandKey, right: HandKey, segment: string, g: BodyKey['gesture'] = { left: 'none', right: 'none' }, torso = ZERO) =>
    keys.push({ t, left, right, segment, gesture: g, torso });
  k(BODY_START, REST, REST, 'rest');
  k(15.0, REST, REST, 'rest');
  // A: gestures. Each held 0.9 s, 0.3 s transitions. The right hand runs three steps ahead.
  const SLOT = 1.2;
  const g0 = 15.6;
  for (let i = 0; i < SEQUENCE.length; i++) {
    const gl = SEQUENCE[i];
    const gr = SEQUENCE[(i + 3) % SEQUENCE.length];
    const L = hand(GESTURES[gl]);
    const R = hand(GESTURES[gr]);
    k(g0 + i * SLOT, L, R, 'gestures', { left: gl, right: gr });
    k(g0 + i * SLOT + 0.9, L, R, 'gestures', { left: gl, right: gr });
  }
  // B: slow finger curls, open <-> fist, twice.
  const c0 = g0 + SEQUENCE.length * SLOT - 0.3; // 24.9
  const openPose = hand(GESTURES.open);
  for (let i = 0; i <= 8; i++) {
    const t = c0 + 0.3 + i * 0.45;
    const c = 0.5 - 0.5 * Math.cos((Math.PI * i) / 2);
    const h = hand({ ...openPose, curl: [c, c, c, c], spread: 0.4 * (1 - c), fold: c });
    k(t, h, h, 'curls', { left: 'transition', right: 'transition' });
  }
  const b1 = c0 + 0.3 + 8 * 0.45; // 28.8
  // C: arms crossed.
  k(b1 + 0.6, CROSS_L, CROSS_R, 'cross');
  k(b1 + 2.4, CROSS_L, CROSS_R, 'cross');
  // D: hands at the face.
  const d0 = b1 + 3.0; // 31.8
  k(d0, CHIN, CHEEK, 'nearFace');
  k(d0 + 1.8, CHIN, CHEEK, 'nearFace');
  // E: lean and twist with the forearms forward.
  const e0 = d0 + 2.4; // 34.2
  k(e0, DESK, DESK, 'lean');
  const leans: Array<[number, Partial<BodyKey['torso']>]> = [
    [0.8, { roll: 14 }], [1.8, { roll: -14 }], [2.4, {}], [3.0, { pitch: 15 }], [3.6, {}],
    [4.3, { yaw: 25 }], [5.2, { yaw: -25 }], [6.0, {}],
  ];
  for (const [dt, tor] of leans) k(e0 + dt, DESK, DESK, 'lean', undefined, { ...ZERO, ...tor });
  // F: her right arm leaves the frame (up and out), then comes back.
  const f0 = e0 + 6.0; // 40.2
  k(f0 + 0.7, DESK, OUT, 'outOfFrame');
  k(f0 + 2.0, DESK, OUT, 'outOfFrame');
  k(f0 + 2.6, DESK, DESK, 'outOfFrame');
  // G: known poses.
  k(f0 + 3.4, TPOSE, TPOSE, 'tpose');
  k(f0 + 4.6, TPOSE, TPOSE, 'tpose');
  k(f0 + 5.2, ABD90, ABD90, 'abduct90');
  k(f0 + 6.4, ABD90, ABD90, 'abduct90');
  k(f0 + 7.4, REST, REST, 'rest');
  k(BODY_END, REST, REST, 'rest');
  return keys;
}

export const BODY_KEYS = buildKeys();

const smooth = (x: number) => x * x * (3 - 2 * x);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerp3 = (a: V3, b: V3, t: number): V3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

function lerpHand(a: HandKey, b: HandKey, t: number): HandKey {
  return {
    wrist: lerp3(a.wrist, b.wrist, t),
    pole: lerp3(a.pole, b.pole, t),
    fingers: lerp3(a.fingers, b.fingers, t),
    thumbDir: lerp3(a.thumbDir, b.thumbDir, t),
    curl: a.curl.map((c, i) => lerp(c, b.curl[i], t)) as HandKey['curl'],
    spread: lerp(a.spread, b.spread, t),
    fold: lerp(a.fold, b.fold, t),
    pinch: lerp(a.pinch, b.pinch, t),
  };
}

/**
 * The "webcam" script (?script=webcam): what a real desk webcam sees and the
 * rendered default clip never had. Hands at and in front of the face (the
 * user-reported failure), both hands up for a whole gesture run, hands low at
 * the bottom edge, close to the camera, in front of the torso and close
 * together. No face section: it starts on the body at WEBCAM_START. Rendered
 * with the closer desk camera (?cam=desk), where the elbows are often out of
 * frame and the pose's wrists are weak.
 */
export const WEBCAM_START = 0.6;
// Her left hand flat on her left cheek, fingers up, palm to the face.
const F_CHEEK = hand({ wrist: [-0.2, 0.1, 0.32], pole: [0.4, -1, -0.2], fingers: [-0.1, 1, 0.05], thumbDir: [0, 0, 1], curl: [0.1, 0.1, 0.15, 0.15] });
// Her left hand over her mouth and nose, back of the hand to the camera.
const F_COVER = hand({ wrist: [-0.32, 0.18, 0.5], pole: [0.4, -1, -0.2], fingers: [-0.7, 0.7, -0.05], thumbDir: [0.7, 0.7, 0], curl: [0.2, 0.2, 0.25, 0.25] });
// Chin resting on her left fist, knuckles up.
const F_CHIN = hand({ wrist: [-0.3, 0.1, 0.5], pole: [0.3, -1, 0], fingers: [-0.25, 0.75, 0.3], thumbDir: [-0.2, 0, 1], curl: [1, 1, 1, 1], fold: 1 });
// Open palm to the camera in front of her face.
const F_FRONT = hand({ wrist: [-0.22, 0.2, 0.7], pole: [0.5, -1, -0.2], fingers: [-0.05, 1, 0.1], thumbDir: [-1, 0, 0], curl: [0, 0, 0, 0], spread: 0.4 });
// Open palm beside her head, at the ear, a little out to the side (a wave).
const F_BESIDE = hand({ wrist: [0.08, 0.22, 0.3], pole: [0.6, -1, -0.2], fingers: [0.05, 1, 0.05], thumbDir: [-1, 0, 0], curl: [0, 0, 0, 0], spread: 0.4 });
// Hands low, just above the desk (near the bottom edge of a desk camera).
const W_LOW = hand({ wrist: [-0.05, 0.0, 0.5], pole: [0.4, -1, -0.4], fingers: [-0.1, -0.1, 1], thumbDir: [-1, 0.2, 0], curl: [0.4, 0.4, 0.45, 0.45] });
// Reaching toward the camera, open palm to it (a big hand).
const W_CLOSE = hand({ wrist: [-0.22, 0.12, 0.82], pole: [0.4, -1, -0.2], fingers: [0, 1, 0.25], thumbDir: [-1, 0, 0], curl: [0, 0, 0, 0], spread: 0.4 });
// In front of the torso, palms in, a hand's width apart.
const W_TORSO = hand({ wrist: [-0.18, -0.05, 0.5], pole: [0.4, -1, -0.3], fingers: [-0.45, 0.25, 0.75], thumbDir: [0, 1, 0], curl: [0.3, 0.3, 0.35, 0.35] });
// Nearly touching: fingertips together in front of the chest (wrists not crossed).
const W_TOGETHER = hand({ wrist: [-0.27, -0.1, 0.55], pole: [0.4, -1, -0.3], fingers: [-0.8, 0.5, 0.2], thumbDir: [0, 1, 0], curl: [0.1, 0.1, 0.15, 0.15] });

function buildWebcamKeys(): BodyKey[] {
  const keys: BodyKey[] = [];
  let t = WEBCAM_START;
  const k = (dt: number, left: HandKey, right: HandKey, segment: string, g: BodyKey['gesture'] = { left: 'none', right: 'none' }) => {
    t += dt;
    keys.push({ t, left, right, segment, gesture: g, torso: ZERO });
  };
  // Each pose: 0.6 s in, held 1.8 s.
  const hold = (left: HandKey, right: HandKey, segment: string, g?: BodyKey['gesture']) => {
    k(0.6, left, right, segment, g);
    k(1.8, left, right, segment, g);
  };
  k(0, REST, REST, 'rest');
  k(0.4, REST, REST, 'rest');
  // Hands at the face, one side then the other, then both.
  hold(REST, F_CHEEK, 'faceCheek');
  hold(F_CHEEK, REST, 'faceCheek');
  hold(F_CHEEK, F_CHEEK, 'faceBoth');
  hold(REST, F_COVER, 'faceCover');
  hold(F_COVER, REST, 'faceCover');
  hold(F_CHIN, REST, 'faceChin');
  hold(REST, F_CHIN, 'faceChin');
  hold(F_FRONT, REST, 'faceFront', { left: 'open', right: 'none' });
  hold(REST, F_FRONT, 'faceFront', { left: 'none', right: 'open' });
  hold(F_BESIDE, F_BESIDE, 'faceBeside', { left: 'open', right: 'open' });
  hold(F_CHIN, F_CHEEK, 'faceBoth');
  // Both hands up through a whole gesture run (each hand its own order).
  const SLOT = 1.2;
  for (let i = 0; i < SEQUENCE.length; i++) {
    const gl = SEQUENCE[i];
    const gr = SEQUENCE[(i + 3) % SEQUENCE.length];
    k(i === 0 ? 0.6 : 0.3, hand(GESTURES[gl]), hand(GESTURES[gr]), 'bothUp', { left: gl, right: gr });
    k(SLOT - 0.3, hand(GESTURES[gl]), hand(GESTURES[gr]), 'bothUp', { left: gl, right: gr });
  }
  hold(W_LOW, W_LOW, 'low');
  hold(REST, W_CLOSE, 'close', { left: 'none', right: 'open' });
  hold(W_TORSO, W_TORSO, 'torso');
  hold(W_TOGETHER, W_TOGETHER, 'together');
  k(0.8, REST, REST, 'rest');
  k(0.6, REST, REST, 'rest');
  return keys;
}

export const WEBCAM_KEYS = buildWebcamKeys();
export const WEBCAM_END = WEBCAM_KEYS[WEBCAM_KEYS.length - 1].t;

/** The interpolated body pose at time t (t >= the first key). */
export function bodyAt(t: number, ks: BodyKey[] = BODY_KEYS): BodyKey {
  if (t <= ks[0].t) return { ...ks[0], t };
  for (let i = 0; i < ks.length - 1; i++) {
    const a = ks[i];
    const b = ks[i + 1];
    if (t > b.t) continue;
    const u = smooth((t - a.t) / Math.max(1e-6, b.t - a.t));
    const held = (s: 'left' | 'right') => (a.gesture[s] === b.gesture[s] ? a.gesture[s] : 'transition');
    return {
      t,
      torso: { roll: lerp(a.torso.roll, b.torso.roll, u), pitch: lerp(a.torso.pitch, b.torso.pitch, u), yaw: lerp(a.torso.yaw, b.torso.yaw, u) },
      left: lerpHand(a.left, b.left, u),
      right: lerpHand(a.right, b.right, u),
      segment: a.segment === b.segment ? a.segment : b.segment,
      gesture: { left: held('left'), right: held('right') },
    };
  }
  return { ...ks[ks.length - 1], t };
}
