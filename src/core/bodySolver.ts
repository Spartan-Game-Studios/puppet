/**
 * Upper-body and hand solver: MediaPipe pose / hand world landmarks -> local
 * rotations for a VRM's normalized humanoid bones.
 *
 * Written from scratch (no Kalidokit): Kalidokit is unmaintained since 2022 and
 * its Euler outputs assume the VRM 0.x / three-vrm 0.x bone frames. Working
 * with direction vectors against the model's own rest directions makes the
 * solve model-independent.
 *
 * Frames. "Avatar space" is the VRM root's local space: +Y up, the avatar faces
 * +Z, avatar-left is +X. MediaPipe world landmarks are camera-aligned (x image
 * right, y down, z away from the camera); a point maps to (x, -y, -z). With
 * `mirror`, x is negated and left/right landmarks swap, so the avatar moves like
 * a mirror image of the user.
 */
import { Quaternion, Vector3 } from 'three';
import { OneEuroVector, smoothingToParams } from './oneEuro';

export interface Landmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

export interface HandInput {
  /** 21 normalized image landmarks (used to match the hand to a pose wrist). */
  landmarks: Landmark[];
  /** 21 world landmarks, metres. */
  worldLandmarks: Landmark[];
  /** MediaPipe handedness label: 'Left' | 'Right'. */
  handedness: string;
  score: number;
  /** The user's anatomical side, if already known. */
  userSide?: Side;
}

export interface BodyInput {
  poseWorld?: Landmark[];
  poseImage?: Landmark[];
  hands?: HandInput[];
  /**
   * Seconds. With a time the solver is temporal: filters, hysteresis on arms
   * and hands entering/leaving, bone-length tracking. Without one each call
   * stands alone (tests).
   */
  t?: number;
  /** Image width / height; with `poseImage`, enables depth-from-bone-length. */
  aspect?: number;
  /**
   * What the hand search did for each USER side on its latest frame
   * (TrackerResult.handStatus). With it, the false-wrist gate (a wrist at the
   * face with no hand) only fires where the search really looked and found
   * no hand of that side; without it (old recordings, tests) it fires on any
   * missing hand, as before.
   */
  handStatus?: Partial<Record<Side, string>>;
}

/** Hand search results that mean "looked there, no hand of this side". */
const SEARCHED_EMPTY = new Set(['miss', 'other-hand', 'duplicate']);

export type Side = 'left' | 'right';

/** Rest directions (avatar space, unit) for each solved bone, measured from the model. */
export type RestDirs = Partial<Record<string, Vector3>>;

export const POSE = {
  nose: 0,
  leftEar: 7, rightEar: 8,
  leftShoulder: 11, rightShoulder: 12,
  leftElbow: 13, rightElbow: 14,
  leftWrist: 15, rightWrist: 16,
  leftPinky: 17, rightPinky: 18,
  leftIndex: 19, rightIndex: 20,
  leftHip: 23, rightHip: 24,
} as const;

/** Hand landmark chains for each VRM finger bone: [from, to] landmark indices. */
export const FINGER_SEGMENTS: Array<[string, number, number]> = [
  ['ThumbMetacarpal', 1, 2], ['ThumbProximal', 2, 3], ['ThumbDistal', 3, 4],
  ['IndexProximal', 5, 6], ['IndexIntermediate', 6, 7], ['IndexDistal', 7, 8],
  ['MiddleProximal', 9, 10], ['MiddleIntermediate', 10, 11], ['MiddleDistal', 11, 12],
  ['RingProximal', 13, 14], ['RingIntermediate', 14, 15], ['RingDistal', 15, 16],
  ['LittleProximal', 17, 18], ['LittleIntermediate', 18, 19], ['LittleDistal', 19, 20],
];

/** Bone -> the bone whose head defines its rest direction. */
export const REST_CHILD: Record<string, string> = {
  leftUpperArm: 'leftLowerArm', leftLowerArm: 'leftHand', leftHand: 'leftMiddleProximal',
  rightUpperArm: 'rightLowerArm', rightLowerArm: 'rightHand', rightHand: 'rightMiddleProximal',
};
for (const side of ['left', 'right']) {
  for (const f of ['Thumb', 'Index', 'Middle', 'Ring', 'Little']) {
    const chain = f === 'Thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Intermediate', 'Distal'];
    for (let i = 0; i < chain.length - 1; i++) REST_CHILD[`${side}${f}${chain[i]}`] = `${side}${f}${chain[i + 1]}`;
  }
}

const UP = new Vector3(0, 1, 0);
const FWD = new Vector3(0, 0, 1);
const IDENT = new Quaternion();

export const toAvatar = (l: Landmark, mirror: boolean, out = new Vector3()) =>
  out.set(mirror ? -l.x : l.x, -l.y, -l.z);

/** Rotation taking basis (x0, z0) onto (x1, z1); both pairs need not be orthogonal. */
export function basisRotation(x0: Vector3, z0: Vector3, x1: Vector3, z1: Vector3, out = new Quaternion()): Quaternion {
  const m0 = frame(x0, z0);
  const m1 = frame(x1, z1);
  // R = M1 * M0^-1 ; for orthonormal M0, inverse = conjugate of its quaternion.
  return out.copy(m1).multiply(m0.invert());
}

function frame(x: Vector3, zHint: Vector3): Quaternion {
  const xa = x.clone().normalize();
  const za = zHint.clone().addScaledVector(xa, -zHint.dot(xa));
  if (za.lengthSq() < 1e-10) {
    // zHint parallel to x: pick any perpendicular.
    const axis = Math.abs(xa.y) < 0.9 ? UP : FWD;
    za.copy(axis).addScaledVector(xa, -axis.dot(xa));
  }
  za.normalize();
  const ya = new Vector3().crossVectors(za, xa);
  // Columns (xa, ya, za) form a rotation matrix (row-major below).
  return quatFromRows([xa.x, ya.x, za.x, xa.y, ya.y, za.y, xa.z, ya.z, za.z], new Quaternion());
}

function quatFromRows(e: number[], q: Quaternion): Quaternion {
  // e is row-major 3x3.
  const [m11, m12, m13, m21, m22, m23, m31, m32, m33] = e;
  const tr = m11 + m22 + m33;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    q.set((m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s);
  } else if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
    q.set(0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s);
  } else if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
    q.set((m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s);
  } else {
    const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
    q.set((m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s);
  }
  return q.normalize();
}

/** q^t (slerp from identity). */
export const qpow = (q: Quaternion, t: number, out = new Quaternion()) => {
  const src = out === q ? q.clone() : q;
  return out.copy(IDENT).slerp(src, t);
};

/** Split q into twist about `axis` and the remaining swing: q = swing * twist. */
export function twistAbout(q: Quaternion, axis: Vector3, out = new Quaternion()): Quaternion {
  const d = q.x * axis.x + q.y * axis.y + q.z * axis.z;
  out.set(axis.x * d, axis.y * d, axis.z * d, q.w);
  if (out.lengthSq() < 1e-12) return out.identity();
  return out.normalize();
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};


export interface SolveOptions {
  mirror: boolean;
  hands: boolean;
  /** Minimum landmark visibility to trust an arm (stateless solves). */
  minVisibility: number;
  /** Fraction of the forearm-to-hand twist moved into the forearm. */
  forearmTwist: number;
  /** Max torso lean (swing of the spine away from vertical), radians. */
  maxTorsoAngle: number;
  /** Max torso twist about the spine, radians. */
  maxTorsoTwist: number;
  /** Rebuild forearm and shoulder-line depth from the 2D image and tracked bone lengths. */
  depthFromLengths: boolean;
  /** Finger and hand-orientation smoothing, 0 (raw) .. 1 (heavy); same scale as the face smoothing. */
  smoothing: number;
  /** Share of the arm's elevation the clavicle takes (scapulohumeral rhythm). */
  shoulderRhythm: number;
  /** Max shrug (clavicle elevation from a raised shoulder), radians. */
  maxShrug: number;
  /**
   * Limb hysteresis: seconds its confidence must stay past a threshold to
   * switch on / off. Kept short (two frames on, three off): the separate
   * on/off thresholds already stop flicker, and every wait here shows as lag.
   */
  limbOnDelay: number;
  limbOffDelay: number;
  /** Limb weight ramp toward on / off, per second. */
  limbFadeIn: number;
  limbFadeOut: number;
}

export const DEFAULT_SOLVE: SolveOptions = {
  mirror: true,
  hands: true,
  minVisibility: 0.55,
  forearmTwist: 0.5,
  maxTorsoAngle: 0.5,
  maxTorsoTwist: 0.7,
  depthFromLengths: true,
  smoothing: 0.5,
  shoulderRhythm: 0.17,
  maxShrug: 0.3,
  limbOnDelay: 0.05,
  limbOffDelay: 0.08,
  limbFadeIn: 15,
  limbFadeOut: 8,
};

/** Local rotations per normalized bone, plus confidences and blend weights. */
export interface BodySolution {
  bones: Map<string, Quaternion>;
  /** Raw landmark confidence per side (min visibility along the arm). */
  armConfidence: { left: number; right: number };
  handConfidence: { left: number; right: number };
  /**
   * How much of the solved arm / hand to show over the idle pose, 0..1. With
   * time (BodyInput.t) these ramp in and out with hysteresis, so a limb that
   * leaves the frame settles to idle instead of snapping.
   */
  armWeight: { left: number; right: number };
  handWeight: { left: number; right: number };
  /** Torso lean and twist, radians (readout). */
  torso: { lean: number; twist: number };
}

/**
 * Idle arm pose: upper arms rotated down along the body, a slight elbow bend.
 * Returned as local rotations for the normalized rig.
 */
export function idleArm(side: Side, rest: RestDirs, out: Map<string, Quaternion>): void {
  const s = side === 'left' ? 1 : -1;
  const down = new Vector3(0.22 * s, -1, 0.05).normalize();
  const upperRest = rest[`${side}UpperArm`] ?? new Vector3(s, 0, 0);
  const qUpper = new Quaternion().setFromUnitVectors(upperRest, down);
  out.set(`${side}UpperArm`, qUpper);
  const fore = new Vector3(0.05 * s, -1, 0.3).normalize();
  const lowerRest = rest[`${side}LowerArm`] ?? new Vector3(s, 0, 0);
  const local = fore.clone().applyQuaternion(qUpper.clone().invert());
  out.set(`${side}LowerArm`, new Quaternion().setFromUnitVectors(lowerRest, local));
  out.set(`${side}Hand`, new Quaternion());
  out.set(`${side}Shoulder`, new Quaternion());
}

/** Gently curled fingers for the idle hand. */
export function idleFingers(side: Side, out: Map<string, Quaternion>): void {
  const s = side === 'left' ? 1 : -1;
  // Curl axis for a palm-down T-pose hand is +Z for the left hand (fingers +X
  // curling toward -Y) and -Z for the right.
  const curl = new Quaternion().setFromAxisAngle(new Vector3(0, 0, -s), 0.25);
  for (const [bone] of FINGER_SEGMENTS) {
    if (bone.startsWith('Thumb')) continue;
    out.set(`${side}${bone}`, curl.clone());
  }
}

/**
 * Depth of a segment from its length and its image projection: MediaPipe's
 * z is its noisiest axis, but a bone can't be longer than it is, so the
 * projected length fixes how far it points into or out of the image. The sign
 * still comes from MediaPipe (`dzHint`), faded to zero when that is too small
 * to trust, which keeps an ambiguous limb in the image plane rather than
 * flipping it.
 */
export function segmentDepth(dxy: number, dzHint: number, length: number): number {
  const mag = Math.sqrt(Math.max(0, length * length - dxy * dxy));
  const sign = Math.max(-1, Math.min(1, dzHint / Math.max(1e-6, 0.3 * length)));
  return mag * sign;
}

/**
 * Robust running length of one bone (metres): the larger of a high
 * percentile of its image-projected length (a bone is never shorter than its
 * projection) and 90% of the median 3D length MediaPipe reports.
 */
export class BoneLength {
  private proj: number[] = [];
  private full: number[] = [];
  value = 0;
  constructor(private readonly window = 240) {}
  add(full: number, proj: number): number {
    this.full.push(full);
    this.proj.push(proj);
    if (this.full.length > this.window) {
      this.full.shift();
      this.proj.shift();
    }
    const pct = (a: number[], p: number) => {
      const s = [...a].sort((x, y) => x - y);
      return s[Math.min(s.length - 1, Math.floor(p * s.length))];
    };
    this.value = Math.max(pct(this.proj, 0.95), 0.9 * pct(this.full, 0.5));
    return this.value;
  }
  reset(): void {
    this.proj.length = 0;
    this.full.length = 0;
    this.value = 0;
  }
}

/** Number of filtered finger values per hand: 4 fingers x (spread, 3 bends), thumb quaternion, 2 thumb bends. */
const FINGER_VALUES = 22;
const FINGERS = ['Index', 'Middle', 'Ring', 'Little'] as const;
const FINGER_LM: Record<(typeof FINGERS)[number], [number, number, number, number]> = {
  Index: [5, 6, 7, 8],
  Middle: [9, 10, 11, 12],
  Ring: [13, 14, 15, 16],
  Little: [17, 18, 19, 20],
};
const D2R = Math.PI / 180;
/** Anatomical limits, radians: [min, max]. Negative = bending backwards. */
export const JOINT_LIMITS = {
  spread: [-25 * D2R, 25 * D2R],
  mcp: [-25 * D2R, 95 * D2R],
  pip: [-5 * D2R, 110 * D2R],
  dip: [-5 * D2R, 90 * D2R],
  thumbSwing: 70 * D2R,
  thumbMcp: [-20 * D2R, 70 * D2R],
  thumbIp: [-25 * D2R, 85 * D2R],
  elbow: 150 * D2R,
  /** Upper-arm twist away from the minimal swing from rest. */
  humerusTwist: 115 * D2R,
} as const;
const clampTo = (x: number, [a, b]: readonly [number, number]) => Math.min(b, Math.max(a, x));
const PALM = new Vector3(0, -1, 0);

/** Hinge basis for a bone at rest: e1 its direction, e2 toward the palm, h the flex axis. */
function hingeBasis(rest: Vector3) {
  const e1 = rest.clone().normalize();
  const e2 = PALM.clone().addScaledVector(e1, -PALM.dot(e1));
  if (e2.lengthSq() < 1e-8) e2.set(0, 0, -1);
  e2.normalize();
  const h = new Vector3().crossVectors(e1, e2);
  return { e1, e2, h };
}

/** On/off with hysteresis plus a weight that ramps toward it. */
interface Gate {
  on: boolean;
  since: number;
  weight: number;
}
const newGate = (): Gate => ({ on: false, since: 0, weight: 0 });

interface SideState {
  upper: Gate;
  fore: Gate;
  armWeight: number;
  humerusTwist: number | null;
  handActive: boolean;
  handSeen: number;
  /** When the hand search last looked for this hand and found none of it. */
  searchedEmptyT: number;
  handFrames: number;
  handWeight: number;
  fingers: OneEuroVector;
  /** The hand's orientation (quaternion), smoothed like the fingers. */
  hand: OneEuroVector;
  lastHand: Quaternion | null;
  lastFingers: number[] | null;
  shrugBase: number | null;
  lengths: { fore: BoneLength };
}

const newSide = (): SideState => ({
  upper: newGate(),
  fore: newGate(),
  armWeight: 0,
  humerusTwist: null,
  handActive: false,
  handSeen: -Infinity,
  searchedEmptyT: -Infinity,
  handFrames: 0,
  handWeight: 0,
  fingers: new OneEuroVector(FINGER_VALUES),
  hand: new OneEuroVector(4),
  lastHand: null,
  lastFingers: null,
  shrugBase: null,
  lengths: { fore: new BoneLength() },
});

export class BodySolver {
  rest: RestDirs;
  opts: SolveOptions;
  /** Bones the model has (clavicles are only solved if present). Null = assume none optional. */
  available: Set<string> | null = null;
  private side: Record<Side, SideState> = { left: newSide(), right: newSide() };
  private shoulderLen = new BoneLength();
  private scale: number | null = null;
  private lastT: number | null = null;

  constructor(rest: RestDirs, opts: Partial<SolveOptions> = {}) {
    this.rest = rest;
    this.opts = { ...DEFAULT_SOLVE, ...opts };
  }

  private restDir(bone: string, fallback: Vector3): Vector3 {
    return this.rest[bone] ?? fallback;
  }

  /** Forget all temporal state (e.g. after a long tracking gap). */
  reset(): void {
    this.side = { left: newSide(), right: newSide() };
    this.shoulderLen.reset();
    this.scale = null;
    this.lastT = null;
  }

  /**
   * Solve. `chestChain` lists the torso bones the model actually has (e.g.
   * ['spine','chest','upperChest']) with the share of the torso rotation each
   * takes; the arms are solved relative to the resulting chest frame.
   */
  solve(input: BodyInput, chestChain: Array<[string, number]>): BodySolution {
    const { mirror } = this.opts;
    const temporal = input.t !== undefined;
    const t = input.t ?? 0;
    const dt = temporal && this.lastT !== null ? Math.min(0.5, Math.max(0, t - this.lastT)) : 0;
    if (temporal && this.lastT !== null && t - this.lastT > 1) this.reset();
    this.lastT = temporal ? t : null;
    this.forearmBase.clear();
    const bones = new Map<string, Quaternion>();
    const res: BodySolution = {
      bones,
      armConfidence: { left: 0, right: 0 },
      handConfidence: { left: 0, right: 0 },
      armWeight: { left: 0, right: 0 },
      handWeight: { left: 0, right: 0 },
      torso: { lean: 0, twist: 0 },
    };
    const pw = input.poseWorld;
    const assigned: Partial<Record<Side, HandInput>> = this.opts.hands && input.hands?.length ? this.assignHands(input) : {};

    let chestWorld = new Quaternion();
    if (pw && pw.length >= 25) {
      const idx = (side: Side, part: string) =>
        (POSE as Record<string, number>)[`${mirror ? (side === 'left' ? 'right' : 'left') : side}${part}`];
      const world = (side: Side, part: string) => toAvatar(pw[idx(side, part)], mirror);
      const img = input.poseImage;
      const inImage = (side: Side, part: string) => {
        if (!img) return 1;
        const l = img[idx(side, part)];
        // Points predicted outside the image are guesses.
        const m = Math.min(l.x, 1 - l.x, l.y, 1 - l.y);
        return smoothstep(-0.04, 0.03, m);
      };
      const vis = (side: Side, part: string) => (pw[idx(side, part)].visibility ?? 1) * inImage(side, part);

      // Image-plane vector a->b in avatar metres, if the image and a scale are available.
      const aspect = input.aspect ?? 0;
      const useDepth = this.opts.depthFromLengths && !!img && aspect > 0;
      const imgVec = (a: number, b: number, k: number) =>
        new Vector3((mirror ? -1 : 1) * (img![b].x - img![a].x) * k, -((img![b].y - img![a].y) * k) / aspect, 0);
      let k = 0;
      if (useDepth) {
        const ls = pw[POSE.leftShoulder];
        const rs = pw[POSE.rightShoulder];
        const worldXY = Math.hypot(ls.x - rs.x, ls.y - rs.y);
        const imgXY = Math.hypot(img![POSE.leftShoulder].x - img![POSE.rightShoulder].x, (img![POSE.leftShoulder].y - img![POSE.rightShoulder].y) / aspect);
        if (imgXY > 1e-4) {
          const kNow = worldXY / imgXY;
          this.scale = temporal && this.scale !== null ? this.scale + (1 - Math.exp(-dt / 0.5)) * (kNow - this.scale) : kNow;
          k = this.scale;
        }
      }
      /** Child point = parent + segment rebuilt from the image and the bone length. */
      const rebuild = (parent: Vector3, a: number, b: number, mpA: Vector3, mpB: Vector3, len: BoneLength): Vector3 => {
        const full = mpB.clone().sub(mpA);
        if (!useDepth || k <= 0) return parent.clone().add(full);
        const v = imgVec(a, b, k);
        const dxy = Math.hypot(v.x, v.y);
        if (!temporal) len.reset();
        const L = len.add(full.length(), dxy);
        v.z = segmentDepth(dxy, full.z, L);
        return parent.clone().add(v);
      };

      let lSh = world('left', 'Shoulder');
      let rSh = world('right', 'Shoulder');
      const shoulderOk = Math.min(vis('left', 'Shoulder'), vis('right', 'Shoulder')) > 0.5;
      if (shoulderOk) {
        if (useDepth && k > 0) {
          // Rebuild the shoulder line around its midpoint.
          const mid = lSh.clone().add(rSh).multiplyScalar(0.5);
          const across = rebuild(new Vector3(), idx('right', 'Shoulder'), idx('left', 'Shoulder'), rSh, lSh, this.shoulderLen);
          lSh = mid.clone().addScaledVector(across, 0.5);
          rSh = mid.clone().addScaledVector(across, -0.5);
        }
        const across = lSh.clone().sub(rSh);
        const hipsOk = Math.min(vis('left', 'Hip'), vis('right', 'Hip')) > 0.5;
        let up = UP.clone();
        if (hipsOk) {
          const sMid = lSh.clone().add(rSh).multiplyScalar(0.5);
          const hMid = world('left', 'Hip').add(world('right', 'Hip')).multiplyScalar(0.5);
          up = sMid.sub(hMid).normalize();
        }
        // Torso frame: y up the spine (exact), x across the shoulders. Split
        // into lean (swing of the spine) and twist (about it), each limited:
        // depth noise mostly shows up as twist.
        const torso = basisRotation(UP, new Vector3(1, 0, 0), up, across);
        const twist = twistAbout(torso, UP);
        const swing = torso.clone().multiply(twist.clone().invert());
        const lean = 2 * Math.acos(Math.min(1, Math.abs(swing.w)));
        if (lean > this.opts.maxTorsoAngle) qpow(swing, this.opts.maxTorsoAngle / lean, swing);
        let tw = 2 * Math.acos(Math.min(1, Math.abs(twist.w)));
        if (tw > this.opts.maxTorsoTwist) {
          qpow(twist, this.opts.maxTorsoTwist / tw, twist);
          tw = this.opts.maxTorsoTwist;
        }
        res.torso = { lean: Math.min(lean, this.opts.maxTorsoAngle), twist: tw * Math.sign(twist.y * twist.w || 1) };
        // Lean mostly low in the spine, twist mostly high (the chest turns more than the waist).
        const n = chestChain.length;
        const twistShares = n === 3 ? [0.2, 0.35, 0.45] : n === 2 ? [0.4, 0.6] : [1];
        let acc = new Quaternion();
        chestChain.forEach(([bone, share], i) => {
          const q = qpow(swing, share).multiply(qpow(twist, twistShares[i] ?? share));
          bones.set(bone, q);
          acc = acc.multiply(q);
        });
        chestWorld = acc;
      } else {
        for (const [bone] of chestChain) bones.set(bone, new Quaternion());
      }

      for (const side of ['left', 'right'] as Side[]) {
        const st = this.side[side];
        // The upper arm needs shoulder and elbow; the forearm also the wrist.
        // An arm reaching out of the frame keeps its upper arm.
        const upperConf = Math.min(vis(side, 'Shoulder'), vis(side, 'Elbow'));
        let foreConf = Math.min(upperConf, vis(side, 'Wrist'));
        // MediaPipe sometimes "sees" a wrist that isn't there: a hand hanging
        // out of view gets placed at the chin. In hands mode, a wrist up by the
        // face with no hand found at it for a while is not trusted enough to
        // start following (a forearm already followed keeps going through
        // short hand misses). Only where the hand search really looked and
        // came back empty: a real hand at the face that the search hasn't
        // looked for (or has found) is never suppressed.
        const status = input.handStatus?.[mirror ? (side === 'left' ? 'right' : 'left') : side];
        if (status && SEARCHED_EMPTY.has(status)) st.searchedEmptyT = t;
        // (The search looks only now and then at a weak wrist, so "recently".)
        const searchedEmpty = input.handStatus ? t - st.searchedEmptyT < 0.5 : true;
        if (temporal && this.opts.hands && searchedEmpty && t - st.handSeen > 0.4 && img && this.nearFace(img, idx(side, 'Wrist'), aspect || 4 / 3)) {
          foreConf *= 0.6;
        }
        res.armConfidence[side] = foreConf;
        const upperOn = this.gate(st.upper, upperConf, temporal, t, dt);
        this.gate(st.fore, foreConf, temporal, t, dt);
        st.armWeight = st.upper.weight;
        res.armWeight[side] = st.upper.weight;
        if (!upperOn && st.upper.weight <= 0) {
          st.humerusTwist = null;
          continue;
        }
        const sh = side === 'left' ? lSh : rSh;
        const mpSh = world(side, 'Shoulder');
        const mpEl = world(side, 'Elbow');
        const mpWr = world(side, 'Wrist');
        // The upper arm keeps MediaPipe's depth: it mostly hangs or swings near
        // the image plane, where its projection is close to its full length and
        // a slightly long length estimate turns into a false forward tilt (and
        // jitter). The forearm, which points at the camera far more, is rebuilt.
        const el = sh.clone().add(mpEl.clone().sub(mpSh));
        const wr = rebuild(el, idx(side, 'Elbow'), idx(side, 'Wrist'), mpEl, mpWr, st.lengths.fore);
        // Untrusted forearm: ease toward a relaxed, slightly bent continuation of the upper arm.
        const fw = st.fore.weight;
        this.solveClavicle(side, chestWorld, sh, el, img, idx, aspect, temporal, dt, bones);
        this.solveArm(side, chestWorld, sh, el, wr, bones, fw);
        if (fw <= 0) continue;
        // Hand orientation from the pose's own index/pinky points as a fallback.
        const ix = world(side, 'Index').sub(mpWr).add(wr);
        const pk = world(side, 'Pinky').sub(mpWr).add(wr);
        this.solveHandFromPoints(side, bones, chestWorld, wr, ix.clone().add(pk).multiplyScalar(0.5), ix, pk, 0.5 * fw);
      }
    } else {
      for (const [bone] of chestChain) bones.set(bone, new Quaternion());
    }

    // Hands.
    for (const side of ['left', 'right'] as Side[]) {
      const st = this.side[side];
      const h = assigned[side];
      const solvable = !!h && bones.has(`${side}LowerArm`) && h.worldLandmarks.length >= 21;
      if (solvable) {
        res.handConfidence[side] = h!.score;
        st.handSeen = t;
        st.handFrames++;
      } else {
        st.handFrames = 0;
      }
      if (!temporal) st.handActive = solvable;
      else if (!st.handActive && st.handFrames >= 2) st.handActive = true;
      else if (st.handActive && t - st.handSeen > 0.25) st.handActive = false;
      st.handWeight = temporal ? approach(st.handWeight, st.handActive ? 1 : 0, dt * 6) : st.handActive ? 1 : 0;
      res.handWeight[side] = st.handWeight;
      if (!st.handActive) {
        if (temporal && t - st.handSeen > 0.3) {
          st.fingers.reset();
          st.hand.reset();
          st.lastHand = null;
          st.lastFingers = null;
        }
      }
      if (solvable) {
        const w = h!.worldLandmarks.map((l) => toAvatar(l, mirror));
        this.solveHandFromPoints(side, bones, chestWorld, w[0], w[9], w[5], w[17], 1, temporal ? t : undefined);
        this.solveFingers(side, bones, chestWorld, w, temporal ? t : undefined);
      } else if (st.handWeight > 0 && st.lastFingers) {
        // Fading out: hold the last finger pose while the weight ramps down.
        this.applyFingers(side, st.lastFingers, bones);
      }
    }
    return res;
  }

  /** Whether an image point is in the face/neck region (above the shoulders, near the nose). */
  private nearFace(img: Landmark[], i: number, aspect: number): boolean {
    const p = img[i];
    const ls = img[POSE.leftShoulder];
    const rs = img[POSE.rightShoulder];
    const nose = img[POSE.nose];
    const width = Math.hypot(ls.x - rs.x, (ls.y - rs.y) / aspect);
    if (width < 1e-3) return false;
    const shoulderY = (ls.y + rs.y) / 2;
    return (p.y - shoulderY) / aspect < 0.3 * width && Math.abs(p.x - nose.x) < 0.8 * width;
  }

  /**
   * Hysteresis for a limb segment: switches on after `conf` has stayed at or
   * above 0.65 for 0.12 s, off after it has stayed below 0.4 for 0.15 s; the
   * weight ramps toward on/off at 4/s. Stateless solves use minVisibility.
   */
  private gate(g: Gate, conf: number, temporal: boolean, t: number, dt: number): boolean {
    if (!temporal) {
      g.on = conf >= this.opts.minVisibility;
      g.weight = g.on ? 1 : 0;
      return g.on;
    }
    const want = g.on ? conf >= 0.4 : conf >= 0.65;
    if (want === g.on) g.since = t;
    else if (t - g.since >= (g.on ? this.opts.limbOffDelay : this.opts.limbOnDelay)) {
      g.on = want;
      g.since = t;
    }
    g.weight = approach(g.weight, g.on ? 1 : 0, dt * (g.on ? this.opts.limbFadeIn : this.opts.limbFadeOut));
    return g.on;
  }

  /** Match detected hands to the user's left/right (pre-mirror) using pose wrists, else the label. */
  assignHands(input: BodyInput): Partial<Record<Side, HandInput>> {
    const { mirror } = this.opts;
    const out: Partial<Record<Side, HandInput>> = {};
    const pi = input.poseImage;
    for (const h of input.hands ?? []) {
      // `user` = the user's anatomical side.
      let user: Side;
      if (h.userSide) {
        user = h.userSide;
      } else if (pi && pi.length > 16) {
        const w = h.landmarks[0];
        const dl = Math.hypot(w.x - pi[POSE.leftWrist].x, w.y - pi[POSE.leftWrist].y);
        const dr = Math.hypot(w.x - pi[POSE.rightWrist].x, w.y - pi[POSE.rightWrist].y);
        user = dl <= dr ? 'left' : 'right';
      } else {
        // The label names the hand's own side on our unmirrored frames (measured; see handAssign.ts).
        user = h.handedness === 'Right' ? 'right' : 'left';
      }
      const avatarSide: Side = mirror ? (user === 'left' ? 'right' : 'left') : user;
      if (!out[avatarSide] || out[avatarSide]!.score < h.score) out[avatarSide] = h;
    }
    return out;
  }

  private worldOf(bones: Map<string, Quaternion>, chestWorld: Quaternion, chain: string[]): Quaternion {
    const q = chestWorld.clone();
    for (const b of chain) {
      const l = bones.get(b);
      if (l) q.multiply(l);
    }
    return q;
  }

  /**
   * Clavicle: follows the arm's elevation (the shoulder girdle takes part of
   * any raise above the side) plus a shrug, read as the shoulder rising toward
   * the ear against a slowly adapting resting baseline.
   */
  private solveClavicle(
    side: Side,
    chestWorld: Quaternion,
    sh: Vector3,
    el: Vector3,
    img: Landmark[] | undefined,
    idx: (side: Side, part: string) => number,
    aspect: number,
    temporal: boolean,
    dt: number,
    bones: Map<string, Quaternion>,
  ): void {
    if (!this.available?.has(`${side}Shoulder`)) return;
    const s = side === 'left' ? 1 : -1;
    const u = el.clone().sub(sh).normalize().applyQuaternion(chestWorld.clone().invert());
    // Abduction from hanging, radians; the girdle joins in past ~30 degrees.
    const abduction = Math.acos(Math.max(-1, Math.min(1, -u.y)));
    let elev = this.opts.shoulderRhythm * Math.max(0, abduction - Math.PI / 6);
    const st = this.side[side];
    if (temporal && img && aspect > 0) {
      const ear = img[idx(side, 'Ear')];
      const shI = img[idx(side, 'Shoulder')];
      const shO = img[idx(side === 'left' ? 'right' : 'left', 'Shoulder')];
      const width = Math.hypot(shI.x - shO.x, (shI.y - shO.y) / aspect);
      if ((ear.visibility ?? 1) > 0.6 && width > 1e-3) {
        const r = (shI.y - ear.y) / aspect / width;
        // Resting ear-to-shoulder height: follows increases at once, decreases slowly.
        st.shrugBase = st.shrugBase === null ? r : Math.max(r, st.shrugBase - 0.01 * dt);
        elev += this.opts.maxShrug * smoothstep(0.03, 0.15, st.shrugBase - r);
      }
    }
    elev = Math.min(elev, 0.5);
    bones.set(`${side}Shoulder`, new Quaternion().setFromAxisAngle(new Vector3(0, 0, s), elev));
  }

  /**
   * Arm as shoulder ball joint + elbow hinge. The elbow only flexes (0 to
   * 150 degrees, never backwards); the plane it bends in sets the upper arm's
   * twist, which is limited and held when the arm is too straight to show it.
   */
  solveArm(side: Side, chestWorld: Quaternion, sh: Vector3, el: Vector3, wr: Vector3, bones: Map<string, Quaternion>, foreWeight = 1): void {
    const s = side === 'left' ? 1 : -1;
    const st = this.side[side];
    const upperRest = this.restDir(`${side}UpperArm`, new Vector3(s, 0, 0)).clone().normalize();
    const lowerRest = this.restDir(`${side}LowerArm`, new Vector3(s, 0, 0)).clone().normalize();
    const shoulderLocal = bones.get(`${side}Shoulder`) ?? new Quaternion();
    const parentInv = chestWorld.clone().multiply(shoulderLocal).invert();

    const u = el.clone().sub(sh).normalize().applyQuaternion(parentInv);
    const l = wr.clone().sub(el).normalize().applyQuaternion(parentInv);
    const qMin = new Quaternion().setFromUnitVectors(upperRest, u);
    // Bend plane reference: at rest (T-pose, palms down) the forearm folds toward +Z.
    const fwdU = FWD.clone().addScaledVector(upperRest, -FWD.dot(upperRest)).normalize();
    const ref = fwdU.clone().applyQuaternion(qMin);
    const perp = l.clone().addScaledVector(u, -l.dot(u));
    const bendSin = perp.length();
    // An untrusted forearm relaxes toward a slight bend in the held plane.
    const bend = foreWeight * Math.min(JOINT_LIMITS.elbow, Math.atan2(bendSin, l.dot(u))) + (1 - foreWeight) * 0.3;
    const planeConf = foreWeight * smoothstep(0.1, 0.35, bendSin);
    let psi = st.humerusTwist ?? 0;
    if (planeConf > 0) {
      perp.normalize();
      const meas = Math.atan2(new Vector3().crossVectors(ref, perp).dot(u), ref.dot(perp));
      if (st.humerusTwist === null) psi = meas * planeConf;
      else psi += planeConf * wrapAngle(meas - psi);
    } else if (st.humerusTwist === null) psi = 0;
    psi = Math.max(-JOINT_LIMITS.humerusTwist, Math.min(JOINT_LIMITS.humerusTwist, psi));
    st.humerusTwist = this.lastT === null ? null : psi;
    const qUpper = qMin.multiply(new Quaternion().setFromAxisAngle(upperRest, psi));
    bones.set(`${side}UpperArm`, qUpper);

    const fwdL = FWD.clone().addScaledVector(lowerRest, -FWD.dot(lowerRest)).normalize();
    const hinge = new Vector3().crossVectors(lowerRest, fwdL).normalize();
    bones.set(`${side}LowerArm`, new Quaternion().setFromAxisAngle(hinge, bend));
  }

  /**
   * Hand orientation from wrist, middle-knuckle, index-knuckle and
   * pinky-knuckle points; part of the twist moves into the forearm.
   */
  solveHandFromPoints(
    side: Side,
    bones: Map<string, Quaternion>,
    chestWorld: Quaternion,
    wrist: Vector3,
    middle: Vector3,
    index: Vector3,
    pinky: Vector3,
    weight: number,
    /** With a time, the hand's orientation is smoothed (one-euro, the finger settings). */
    time?: number,
  ): void {
    const s = side === 'left' ? 1 : -1;
    const handRest = this.restDir(`${side}Hand`, new Vector3(s, 0, 0));
    const fingers = middle.clone().sub(wrist);
    const across = index.clone().sub(pinky);
    if (fingers.lengthSq() < 1e-10 || across.lengthSq() < 1e-10) return;
    const lower = bones.get(`${side}LowerArm`);
    if (!lower) return;
    // Undo a previous call's forearm twist (the pose fallback runs first).
    const baseLower = this.forearmBase.get(side);
    if (baseLower) lower.copy(baseLower);
    else this.forearmBase.set(side, lower.clone());
    // At rest the index knuckle is forward (+Z) of the pinky for either hand.
    const handWorld = basisRotation(handRest, FWD, fingers, across);
    if (time !== undefined) {
      const st = this.side[side];
      // Keep the quaternion in the same hemisphere as the last one so the filter doesn't average q and -q.
      if (st.lastHand && handWorld.dot(st.lastHand) < 0) handWorld.set(-handWorld.x, -handWorld.y, -handWorld.z, -handWorld.w);
      st.hand.setParams(smoothingToParams(this.opts.smoothing * 0.8));
      const f = st.hand.filter([handWorld.x, handWorld.y, handWorld.z, handWorld.w], time);
      handWorld.set(f[0], f[1], f[2], f[3]).normalize();
      st.lastHand = handWorld.clone();
    }
    const chain = [`${side}Shoulder`, `${side}UpperArm`, `${side}LowerArm`];
    const lowerWorld = this.worldOf(bones, chestWorld, chain);
    let local = lowerWorld.clone().invert().multiply(handWorld);
    if (weight < 1) local = qpow(local, weight);

    // Clamp absurd wrist bends (tracking glitches) to ~80 degrees.
    const ang = 2 * Math.acos(Math.min(1, Math.abs(local.w)));
    if (ang > 1.4) qpow(local, 1.4 / ang, local);

    // Move a share of the twist into the forearm (pronation/supination), limited to 90 degrees there.
    const axis = handRest.clone().normalize();
    const twist = twistAbout(local, axis);
    const t = qpow(twist, this.opts.forearmTwist);
    const ta = 2 * Math.acos(Math.min(1, Math.abs(t.w)));
    if (ta > Math.PI / 2) qpow(t, Math.PI / 2 / ta, t);
    lower.multiply(t);
    local = t.clone().invert().multiply(local);
    bones.set(`${side}Hand`, local);
  }
  private forearmBase = new Map<Side, Quaternion>();

  /**
   * Finger bones from hand world landmarks (already in avatar space): each
   * joint is measured as anatomical angles (spread and bend at the knuckle,
   * bend only at the middle and end joints), clamped to its range, smoothed
   * per joint, then rebuilt as rotations, so fingers can't bend sideways or
   * backwards and noise in one joint doesn't twist the rest.
   */
  solveFingers(side: Side, bones: Map<string, Quaternion>, chestWorld: Quaternion, w: Vector3[], t?: number): void {
    const st = this.side[side];
    const handWorld = this.worldOf(bones, chestWorld, [`${side}Shoulder`, `${side}UpperArm`, `${side}LowerArm`, `${side}Hand`]);
    const handInv = handWorld.clone().invert();
    const local = (a: number, b: number) => w[b].clone().sub(w[a]).applyQuaternion(handInv);
    const vals = new Array<number>(FINGER_VALUES).fill(0);
    FINGERS.forEach((f, i) => {
      const [a, b, c, d] = FINGER_LM[f];
      const p = hingeBasis(this.restDir(`${side}${f}Proximal`, new Vector3(side === 'left' ? 1 : -1, 0, 0)));
      const dir1 = local(a, b).normalize();
      const k = p.h.clone().negate();
      let spread = Math.atan2(dir1.dot(k), dir1.dot(p.e1));
      spread = clampTo(spread, JOINT_LIMITS.spread);
      const inPlane = dir1.dot(p.e1) * Math.cos(spread) + dir1.dot(k) * Math.sin(spread);
      const mcp = clampTo(Math.atan2(dir1.dot(p.e2), inPlane), JOINT_LIMITS.mcp);
      const q1 = this.knuckle(p, spread, mcp);
      // Middle and end joints, measured in the frame of the (constrained) parent.
      const q1Inv = q1.clone().invert();
      const bi = hingeBasis(this.restDir(`${side}${f}Intermediate`, p.e1));
      const dir2 = local(b, c).normalize().applyQuaternion(q1Inv);
      const pip = clampTo(Math.atan2(dir2.dot(bi.e2), dir2.dot(bi.e1)), JOINT_LIMITS.pip);
      const q2Inv = new Quaternion().setFromAxisAngle(bi.h, pip).invert();
      const bd = hingeBasis(this.restDir(`${side}${f}Distal`, bi.e1));
      const dir3 = local(c, d).normalize().applyQuaternion(q1Inv).applyQuaternion(q2Inv);
      let dip = clampTo(Math.atan2(dir3.dot(bd.e2), dir3.dot(bd.e1)), JOINT_LIMITS.dip);
      // The end joint is the noisiest landmark: lean on its usual coupling to the middle joint.
      dip = 0.6 * dip + 0.4 * 0.7 * pip;
      vals.splice(4 * i, 4, spread, mcp, pip, dip);
    });
    // Thumb: the metacarpal's swing comes from its direction, its twist from
    // the plane the rest of the thumb bends in (that is what opposition looks like).
    const s = side === 'left' ? 1 : -1;
    const metaRest = this.restDir(`${side}ThumbMetacarpal`, new Vector3(s, 0, 1).normalize()).clone().normalize();
    const mb = hingeBasis(metaRest);
    const d1 = local(1, 2).normalize();
    const tipV = local(2, 4);
    const bendPerp = tipV.clone().addScaledVector(d1, -tipV.dot(d1));
    const planeConf = smoothstep(0.15, 0.35, bendPerp.length() / Math.max(1e-6, tipV.length()));
    let qm = new Quaternion().setFromUnitVectors(metaRest, d1);
    if (planeConf > 0) qm = qm.slerp(basisRotation(metaRest, mb.e2, d1, bendPerp), planeConf);
    const sw = 2 * Math.acos(Math.min(1, Math.abs(qm.w)));
    if (sw > JOINT_LIMITS.thumbSwing) qpow(qm, JOINT_LIMITS.thumbSwing / sw, qm);
    const prev = st.lastFingers;
    if (prev && qm.x * prev[16] + qm.y * prev[17] + qm.z * prev[18] + qm.w * prev[19] < 0) qm.set(-qm.x, -qm.y, -qm.z, -qm.w);
    const qmInv = qm.clone().invert();
    const tp = hingeBasis(this.restDir(`${side}ThumbProximal`, metaRest));
    const dp = local(2, 3).normalize().applyQuaternion(qmInv);
    const tmcp = clampTo(Math.atan2(dp.dot(tp.e2), dp.dot(tp.e1)), JOINT_LIMITS.thumbMcp);
    const tpInv = new Quaternion().setFromAxisAngle(tp.h, tmcp).invert();
    const td = hingeBasis(this.restDir(`${side}ThumbDistal`, tp.e1));
    const dd = local(3, 4).normalize().applyQuaternion(qmInv).applyQuaternion(tpInv);
    const tip = clampTo(Math.atan2(dd.dot(td.e2), dd.dot(td.e1)), JOINT_LIMITS.thumbIp);
    vals.splice(16, 6, qm.x, qm.y, qm.z, qm.w, tmcp, tip);

    let out = vals;
    if (t !== undefined) {
      const params = smoothingToParams(this.opts.smoothing * 0.8);
      st.fingers.setParams(params);
      out = st.fingers.filter(vals, t);
    }
    st.lastFingers = out.slice();
    this.applyFingers(side, out, bones);
  }

  private knuckle(p: ReturnType<typeof hingeBasis>, spread: number, bend: number): Quaternion {
    return new Quaternion().setFromAxisAngle(p.e2, spread).multiply(new Quaternion().setFromAxisAngle(p.h, bend));
  }

  /** Finger values (see solveFingers) -> bone rotations. */
  private applyFingers(side: Side, v: number[], bones: Map<string, Quaternion>): void {
    const s = side === 'left' ? 1 : -1;
    FINGERS.forEach((f, i) => {
      const p = hingeBasis(this.restDir(`${side}${f}Proximal`, new Vector3(s, 0, 0)));
      const bi = hingeBasis(this.restDir(`${side}${f}Intermediate`, p.e1));
      const bd = hingeBasis(this.restDir(`${side}${f}Distal`, bi.e1));
      bones.set(`${side}${f}Proximal`, this.knuckle(p, v[4 * i], v[4 * i + 1]));
      bones.set(`${side}${f}Intermediate`, new Quaternion().setFromAxisAngle(bi.h, v[4 * i + 2]));
      bones.set(`${side}${f}Distal`, new Quaternion().setFromAxisAngle(bd.h, v[4 * i + 3]));
    });
    const metaRest = this.restDir(`${side}ThumbMetacarpal`, new Vector3(s, 0, 1).normalize());
    const tp = hingeBasis(this.restDir(`${side}ThumbProximal`, metaRest));
    const td = hingeBasis(this.restDir(`${side}ThumbDistal`, tp.e1));
    bones.set(`${side}ThumbMetacarpal`, new Quaternion(v[16], v[17], v[18], v[19]).normalize());
    bones.set(`${side}ThumbProximal`, new Quaternion().setFromAxisAngle(tp.h, v[20]));
    bones.set(`${side}ThumbDistal`, new Quaternion().setFromAxisAngle(td.h, v[21]));
  }
}

/** Move x toward target by at most `step`. */
function approach(x: number, target: number, step: number): number {
  return x < target ? Math.min(target, x + step) : Math.max(target, x - step);
}

/** Wrap to (-pi, pi]. */
function wrapAngle(a: number): number {
  return a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));
}
