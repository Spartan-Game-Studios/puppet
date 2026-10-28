/**
 * Puppet's own keyframed emotes (wave, clap, bow, point, shrug, think): the
 * gestures the bundled CC0 library doesn't have. Authored in solver space
 * (+Y up, the avatar faces +Z, its left hand is +X) against the avatar's
 * measured rest directions, so they fit any VRM.
 *
 * A pose gives, per bone, either
 *  - `aim`: the direction the bone should point in the chest's frame (arm
 *    chains), optionally with `twist` (degrees about the bone's own axis), or
 *  - `e`: a local rotation as XYZ Euler degrees.
 * Poses are authored for the avatar's right side; `both()` mirrors a right
 * spec onto the left.
 */
import { Euler, Quaternion, Vector3 } from 'three';
import type { BoundClip, TargetRig } from './retarget';

type V3 = [number, number, number];
export interface BoneSpec {
  aim?: V3;
  twist?: number;
  e?: V3;
}
export type Pose = Record<string, BoneSpec>;
export interface AuthoredKey {
  t: number;
  pose: Pose;
}
export interface AuthoredClip {
  name: string;
  duration: number;
  keys: AuthoredKey[];
}

const D = Math.PI / 180;

/** Mirror a right-side spec onto the left (reflect X). */
function mirrorSpec(s: BoneSpec): BoneSpec {
  return {
    aim: s.aim ? [-s.aim[0], s.aim[1], s.aim[2]] : undefined,
    twist: s.twist !== undefined ? -s.twist : undefined,
    e: s.e ? [s.e[0], -s.e[1], -s.e[2]] : undefined,
  };
}
const R = (bone: string) => `right${bone}`;
const L = (bone: string) => `left${bone}`;

/** Apply right-side specs to both sides (mirrored on the left). */
function both(right: Record<string, BoneSpec>): Pose {
  const out: Pose = {};
  for (const [b, s] of Object.entries(right)) {
    out[R(b)] = s;
    out[L(b)] = mirrorSpec(s);
  }
  return out;
}
function right(spec: Record<string, BoneSpec>): Pose {
  return Object.fromEntries(Object.entries(spec).map(([b, s]) => [R(b), s]));
}
function left(spec: Record<string, BoneSpec>): Pose {
  return Object.fromEntries(Object.entries(spec).map(([b, s]) => [L(b), mirrorSpec(s)]));
}

const FINGERS = ['Index', 'Middle', 'Ring', 'Little'];
const SEG = ['Proximal', 'Intermediate', 'Distal'];
/** Finger curl (radians -> degrees about the right hand's curl axis, +Z). */
function curl(amount: Record<string, number>, thumb = 0): Record<string, BoneSpec> {
  const out: Record<string, BoneSpec> = {};
  for (const f of FINGERS) for (const s of SEG) out[`${f}${s}`] = { e: [0, 0, (amount[f] ?? 0.25) / D] };
  if (thumb) for (const s of ['Proximal', 'Distal']) out[`Thumb${s}`] = { e: [0, -thumb / D, 0] };
  return out;
}

// Arms hanging (as Avatar's idle pose).
const HANG: Record<string, BoneSpec> = {
  UpperArm: { aim: [-0.22, -1, 0.05] },
  LowerArm: { aim: [-0.05, -1, 0.3] },
  ...curl({}),
};
const BASE: Pose = both(HANG);

const pose = (...parts: Pose[]): Pose => Object.assign({}, BASE, ...parts);

export const AUTHORED: AuthoredClip[] = [
  {
    name: 'wave',
    duration: 3,
    keys: [
      { t: 0, pose: BASE },
      ...[0.5, 0.8, 1.1, 1.4, 1.7, 2.0].map((t, i) => ({
        t,
        pose: pose(
          right({
            UpperArm: { aim: [-0.8, 0.45, 0.2], twist: -70 },
            LowerArm: { aim: [i % 2 ? -0.5 : 0.05, 1, 0.12], twist: -10 },
            Hand: { e: [0, 0, 0] },
            ...curl({ Index: 0.05, Middle: 0.05, Ring: 0.08, Little: 0.1 }),
          }),
        ),
      })),
      { t: 2.55, pose: BASE },
      { t: 3, pose: BASE },
    ],
  },
  {
    name: 'clap',
    duration: 2.6,
    keys: [
      { t: 0, pose: BASE },
      ...[0.45, 0.65, 0.85, 1.05, 1.25, 1.45, 1.65, 1.85].map((t, i) => ({
        t,
        pose: pose(
          both({
            UpperArm: { aim: [-0.12, -0.62, 0.78], twist: 0 },
            LowerArm: { aim: i % 2 ? [0.68, 0.25, 0.68] : [0.25, 0.3, 0.92], twist: 90 },
            ...curl({ Index: 0.05, Middle: 0.05, Ring: 0.05, Little: 0.05 }),
          }),
        ),
      })),
      { t: 2.6, pose: BASE },
    ],
  },
  {
    name: 'bow',
    duration: 2.8,
    keys: [
      { t: 0, pose: BASE },
      ...[0.8, 1.6].map((t) => ({
        t,
        pose: pose({
          spine: { e: [16, 0, 0] },
          chest: { e: [14, 0, 0] },
          upperChest: { e: [6, 0, 0] },
          neck: { e: [6, 0, 0] },
          head: { e: [10, 0, 0] },
        }),
      })),
      { t: 2.8, pose: BASE },
    ],
  },
  {
    name: 'point',
    duration: 2.4,
    keys: [
      { t: 0, pose: BASE },
      ...[0.5, 1.8].map((t) => ({
        t,
        pose: pose(
          right({
            UpperArm: { aim: [-0.3, 0.12, 1] },
            LowerArm: { aim: [-0.12, 0.15, 1], twist: -20 },
            ...curl({ Index: 0, Middle: 1.3, Ring: 1.35, Little: 1.4 }, 0.6),
          }),
        ),
      })),
      { t: 2.4, pose: BASE },
    ],
  },
  {
    name: 'shrug',
    duration: 2.2,
    keys: [
      { t: 0, pose: BASE },
      ...[0.5, 1.4].map((t) => ({
        t,
        pose: pose(
          both({
            Shoulder: { e: [0, 0, -14] },
            UpperArm: { aim: [-0.22, -0.95, 0.15] },
            LowerArm: { aim: [-0.5, 0.08, 0.85], twist: 180 },
            ...curl({ Index: 0.1, Middle: 0.1, Ring: 0.12, Little: 0.15 }),
          }),
          { head: { e: [0, 0, 9] }, neck: { e: [0, 0, 3] } },
        ),
      })),
      { t: 2.2, pose: BASE },
    ],
  },
  {
    name: 'think',
    duration: 3.6,
    keys: [
      { t: 0, pose: BASE },
      ...[0.7, 2.9].map((t) => ({
        t,
        pose: pose(
          right({
            UpperArm: { aim: [-0.25, -0.8, 0.55] },
            LowerArm: { aim: [0.45, 0.8, 0.35], twist: -60 },
            Hand: { e: [0, 0, -25] },
            ...curl({ Index: 0.6, Middle: 1.1, Ring: 1.2, Little: 1.3 }, 0.3),
          }),
          left({
            UpperArm: { aim: [-0.15, -0.9, 0.4] },
            LowerArm: { aim: [0.9, 0.05, 0.4], twist: 30 },
          }),
          { head: { e: [6, 0, -7] }, neck: { e: [2, 0, -2] } },
        ),
      })),
      { t: 3.6, pose: BASE },
    ],
  },
];

// ---------------------------------------------------------------- baking

const ARM_CHAIN = ['Shoulder', 'UpperArm', 'LowerArm', 'Hand'];
const vec = (a: V3) => new Vector3(...a).normalize();

/** Local rotations for one pose. Arm aims are resolved down each chain. */
export function solvePose(p: Pose, target: TargetRig): Map<string, Quaternion> {
  const out = new Map<string, Quaternion>();
  const local = (s: BoneSpec): Quaternion =>
    s.e ? new Quaternion().setFromEuler(new Euler(s.e[0] * D, s.e[1] * D, s.e[2] * D)) : new Quaternion();
  for (const side of ['left', 'right']) {
    let parentWorld = new Quaternion();
    for (const seg of ARM_CHAIN) {
      const b = `${side}${seg}`;
      const s = p[b];
      let q = new Quaternion();
      if (s?.aim) {
        const rest = target.restDirs.get(b) ?? new Vector3(side === 'left' ? 1 : -1, 0, 0);
        const want = vec(s.aim).applyQuaternion(parentWorld.clone().invert());
        q.setFromUnitVectors(rest, want);
        if (s.twist) q.multiply(new Quaternion().setFromAxisAngle(rest, s.twist * D));
      } else if (s) q = local(s);
      out.set(b, q);
      parentWorld = parentWorld.clone().multiply(q);
    }
  }
  for (const [b, s] of Object.entries(p)) if (!out.has(b)) out.set(b, local(s));
  return out;
}

const smooth = (x: number) => x * x * (3 - 2 * x);

/** Bake an authored clip for one avatar (30 fps, eased between keys). */
export function bakeAuthored(clip: AuthoredClip, target: TargetRig, fps = 30): BoundClip {
  const solved = clip.keys.map((k) => ({ t: k.t, q: solvePose(k.pose, target) }));
  const names = new Set<string>();
  for (const s of solved) for (const b of s.q.keys()) if (target.bones.has(b)) names.add(b);
  const frames = Math.round(clip.duration * fps) + 1;
  const bones = new Map<string, Float32Array>();
  for (const b of names) bones.set(b, new Float32Array(frames * 4));
  const q = new Quaternion();
  const I = new Quaternion();
  for (let f = 0; f < frames; f++) {
    const t = f / fps;
    let k = 0;
    while (k < solved.length - 2 && solved[k + 1].t <= t) k++;
    const a = solved[k];
    const b = solved[Math.min(k + 1, solved.length - 1)];
    const x = b.t > a.t ? smooth(Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t)))) : 0;
    for (const n of names) {
      q.copy(a.q.get(n) ?? I).slerp(b.q.get(n) ?? I, x);
      q.toArray(bones.get(n)!, f * 4);
    }
  }
  return { name: clip.name, fps, frames, duration: clip.duration, bones, hips: null };
}
