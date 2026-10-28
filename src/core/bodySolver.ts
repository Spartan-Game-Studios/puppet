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
}

export type Side = 'left' | 'right';

/** Rest directions (avatar space, unit) for each solved bone, measured from the model. */
export type RestDirs = Partial<Record<string, Vector3>>;

export const POSE = {
  nose: 0,
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
  /** Minimum landmark visibility to trust an arm. */
  minVisibility: number;
  /** Fraction of the forearm-to-hand twist moved into the forearm. */
  forearmTwist: number;
  /** Max torso lean from the shoulder line, radians. */
  maxTorsoAngle: number;
}

export const DEFAULT_SOLVE: SolveOptions = {
  mirror: true,
  hands: true,
  minVisibility: 0.55,
  forearmTwist: 0.5,
  maxTorsoAngle: 0.6,
};

/** Local rotations per normalized bone, plus a confidence per side. */
export interface BodySolution {
  bones: Map<string, Quaternion>;
  armConfidence: { left: number; right: number };
  handConfidence: { left: number; right: number };
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

export class BodySolver {
  rest: RestDirs;
  opts: SolveOptions;

  constructor(rest: RestDirs, opts: Partial<SolveOptions> = {}) {
    this.rest = rest;
    this.opts = { ...DEFAULT_SOLVE, ...opts };
  }

  private restDir(bone: string, fallback: Vector3): Vector3 {
    return this.rest[bone] ?? fallback;
  }

  /**
   * Solve. `chestChain` lists the torso bones the model actually has (e.g.
   * ['spine','chest','upperChest']) with the share of the torso rotation each
   * takes; the arms are solved relative to the resulting chest frame.
   */
  solve(input: BodyInput, chestChain: Array<[string, number]>): BodySolution {
    const { mirror } = this.opts;
    const bones = new Map<string, Quaternion>();
    const res: BodySolution = { bones, armConfidence: { left: 0, right: 0 }, handConfidence: { left: 0, right: 0 } };
    const pw = input.poseWorld;

    // Torso.
    let chestWorld = new Quaternion();
    if (pw && pw.length >= 25) {
      const idx = (side: Side, part: string) =>
        (POSE as Record<string, number>)[`${mirror ? (side === 'left' ? 'right' : 'left') : side}${part}`];
      const p = (side: Side, part: string) => toAvatar(pw[idx(side, part)], mirror);
      const vis = (side: Side, part: string) => pw[idx(side, part)].visibility ?? 1;

      const lSh = p('left', 'Shoulder');
      const rSh = p('right', 'Shoulder');
      const shoulderOk = Math.min(vis('left', 'Shoulder'), vis('right', 'Shoulder')) > 0.5;
      if (shoulderOk) {
        const across = lSh.clone().sub(rSh);
        const hipsOk = Math.min(vis('left', 'Hip'), vis('right', 'Hip')) > 0.5;
        let up = UP.clone();
        if (hipsOk) {
          const sMid = lSh.clone().add(rSh).multiplyScalar(0.5);
          const hMid = p('left', 'Hip').add(p('right', 'Hip')).multiplyScalar(0.5);
          up = sMid.sub(hMid).normalize();
        }
        // Torso frame: y up the spine (exact), x across the shoulders.
        const torso = basisRotation(UP, new Vector3(1, 0, 0), up, across);
        // Limit the lean so noisy depth can't fold the avatar.
        const angle = 2 * Math.acos(Math.min(1, Math.abs(torso.w)));
        if (angle > this.opts.maxTorsoAngle) qpow(torso, this.opts.maxTorsoAngle / angle, torso);
        chestWorld = torso;
      }

      // Distribute the torso rotation over the chain.
      let acc = new Quaternion();
      for (const [bone, share] of chestChain) {
        const q = qpow(chestWorld, share);
        bones.set(bone, q);
        acc = acc.multiply(q);
      }
      chestWorld = acc;

      for (const side of ['left', 'right'] as Side[]) {
        const conf = Math.min(vis(side, 'Shoulder'), vis(side, 'Elbow'), vis(side, 'Wrist'));
        res.armConfidence[side] = conf;
        if (conf < this.opts.minVisibility) continue;
        const sh = p(side, 'Shoulder');
        const el = p(side, 'Elbow');
        const wr = p(side, 'Wrist');
        this.solveArm(side, chestWorld, sh, el, wr, bones);
        // Hand orientation from the pose's own index/pinky points as a fallback.
        if (!bones.has(`${side}Hand`)) {
          const ix = p(side, 'Index');
          const pk = p(side, 'Pinky');
          this.solveHandFromPoints(side, bones, chestWorld, wr, ix.clone().add(pk).multiplyScalar(0.5), ix, pk, 0.5);
        }
      }
    } else {
      for (const [bone] of chestChain) bones.set(bone, new Quaternion());
    }

    // Hands.
    if (this.opts.hands && input.hands?.length) {
      const assigned = this.assignHands(input);
      for (const side of ['left', 'right'] as Side[]) {
        const h = assigned[side];
        if (!h || !bones.has(`${side}LowerArm`)) continue;
        res.handConfidence[side] = h.score;
        const w = h.worldLandmarks.map((l) => toAvatar(l, mirror));
        const mid = w[9];
        this.solveHandFromPoints(side, bones, chestWorld, w[0], mid, w[5], w[17], 1);
        this.solveFingers(side, bones, chestWorld, w);
      }
    }
    return res;
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
        // MediaPipe labels handedness as if the image were mirrored (selfie view).
        user = h.handedness === 'Left' ? 'right' : 'left';
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

  solveArm(side: Side, chestWorld: Quaternion, sh: Vector3, el: Vector3, wr: Vector3, bones: Map<string, Quaternion>): void {
    const s = side === 'left' ? 1 : -1;
    const upperRest = this.restDir(`${side}UpperArm`, new Vector3(s, 0, 0));
    const lowerRest = this.restDir(`${side}LowerArm`, new Vector3(s, 0, 0));
    const shoulderLocal = bones.get(`${side}Shoulder`) ?? new Quaternion();
    const parentWorld = chestWorld.clone().multiply(shoulderLocal);
    const parentInv = parentWorld.clone().invert();

    const dUpper = el.clone().sub(sh).normalize();
    const dLower = wr.clone().sub(el).normalize();
    const upperLocalDir = dUpper.clone().applyQuaternion(parentInv);
    const lowerInParent = dLower.clone().applyQuaternion(parentInv);

    // Minimal rotation, then a version that also puts the elbow hinge in the
    // right plane; blend by how bent the arm is (a straight arm has no plane).
    const qMin = new Quaternion().setFromUnitVectors(upperRest, upperLocalDir);
    const perp = lowerInParent.clone().addScaledVector(upperLocalDir, -lowerInParent.dot(upperLocalDir));
    const bend = smoothstep(0.08, 0.3, perp.length());
    let qUpper = qMin;
    if (bend > 0) {
      // At rest (T-pose, palms down) the forearm folds toward +Z.
      const qBend = basisRotation(upperRest, FWD, upperLocalDir, perp);
      qUpper = qMin.clone().slerp(qBend, bend);
    }
    bones.set(`${side}UpperArm`, qUpper);

    const upperWorldInv = parentWorld.clone().multiply(qUpper).invert();
    const lowerLocalDir = dLower.clone().applyQuaternion(upperWorldInv);
    bones.set(`${side}LowerArm`, new Quaternion().setFromUnitVectors(lowerRest, lowerLocalDir));
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
  ): void {
    const s = side === 'left' ? 1 : -1;
    const handRest = this.restDir(`${side}Hand`, new Vector3(s, 0, 0));
    const fingers = middle.clone().sub(wrist);
    const across = index.clone().sub(pinky);
    if (fingers.lengthSq() < 1e-10 || across.lengthSq() < 1e-10) return;
    // At rest the index knuckle is forward (+Z) of the pinky for either hand.
    const handWorld = basisRotation(handRest, FWD, fingers, across);
    const chain = [`${side}Shoulder`, `${side}UpperArm`, `${side}LowerArm`];
    const lowerWorld = this.worldOf(bones, chestWorld, chain);
    let local = lowerWorld.clone().invert().multiply(handWorld);
    if (weight < 1) local = qpow(local, weight);

    // Clamp absurd wrist bends (tracking glitches) to ~80 degrees.
    const ang = 2 * Math.acos(Math.min(1, Math.abs(local.w)));
    if (ang > 1.4) qpow(local, 1.4 / ang, local);

    // Move a share of the twist into the forearm.
    const axis = handRest.clone().normalize();
    const twist = twistAbout(local, axis);
    const t = qpow(twist, this.opts.forearmTwist);
    const lower = bones.get(`${side}LowerArm`);
    if (lower) {
      lower.multiply(t);
      local = t.clone().invert().multiply(local);
    }
    bones.set(`${side}Hand`, local);
  }

  /** Finger bones from hand world landmarks (already in avatar space). */
  solveFingers(side: Side, bones: Map<string, Quaternion>, chestWorld: Quaternion, w: Vector3[]): void {
    const s = side === 'left' ? 1 : -1;
    const handWorld = this.worldOf(bones, chestWorld, [`${side}Shoulder`, `${side}UpperArm`, `${side}LowerArm`, `${side}Hand`]);
    let parentWorld = handWorld.clone();
    let prevRest = this.restDir(`${side}Hand`, new Vector3(s, 0, 0));
    for (const [name, a, b] of FINGER_SEGMENTS) {
      const bone = `${side}${name}`;
      const first = name.endsWith('Proximal') && !name.startsWith('Thumb') || name === 'ThumbMetacarpal';
      if (first) {
        parentWorld = handWorld.clone();
        prevRest = this.restDir(`${side}Hand`, new Vector3(s, 0, 0));
      }
      const rest = this.restDir(bone, prevRest);
      const dir = w[b].clone().sub(w[a]);
      if (dir.lengthSq() < 1e-12) continue;
      const local = dir.normalize().applyQuaternion(parentWorld.clone().invert());
      if (!name.startsWith('Thumb') && !name.endsWith('Proximal')) {
        // Middle and end joints are hinges: drop the sideways component and
        // stop them bending backwards.
        local.z = 0;
        if (local.y * 1 > 0.15) local.y = 0.15;
        if (local.lengthSq() < 1e-8) continue;
        local.normalize();
      }
      const q = new Quaternion().setFromUnitVectors(rest, local);
      bones.set(bone, q);
      parentWorld = parentWorld.clone().multiply(q);
      prevRest = rest;
    }
  }
}
