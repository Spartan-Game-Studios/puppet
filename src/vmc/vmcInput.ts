/**
 * VMC input, the webview half (the receiver is src-tauri/src/vmc_in.rs): turn
 * a received VMC pose into bone rotations and expression values for the
 * avatar, per body region, so trackers can drive the legs and torso while the
 * webcam keeps the face and hands (or an iPhone app drives the face).
 *
 * VMC speaks Unity (left-handed, the avatar faces +Z); bone rotations are
 * normalized-rig local rotations, identity at T-pose, the same convention
 * VPuppet's own VMC output uses (./vmcFrame.ts, toUnity). Converting back
 * mirrors X again: position (x, y, z) -> (-x, y, z), rotation (x, y, z, w) ->
 * (x, -y, -z, w), into the avatar's +Z-facing solver space.
 */
import { Quaternion } from 'three';
import { normName, VRM0_PRESET_NAMES, type ArkitName } from '../core/blendshapes';

export type Transform7 = [number, number, number, number, number, number, number];

/** Mirrors `vmc_in::InFrame`. */
export interface VmcInFrame {
  seq: number;
  bones: Record<string, Transform7>;
  root: Transform7 | null;
  blends: Record<string, number>;
  t: number | null;
  loaded: number | null;
  tracking: number | null;
}

export const REGIONS = ['face', 'head', 'torso', 'arms', 'fingers', 'legs'] as const;
export type Region = (typeof REGIONS)[number];
export type RegionSource = 'webcam' | 'vmc';
export type RegionSources = Record<Region, RegionSource>;

/** Body trackers usually cover the hips, chest and legs; the webcam keeps face, arms and hands. */
export const DEFAULT_SOURCES: RegionSources = { face: 'webcam', head: 'webcam', torso: 'vmc', arms: 'webcam', fingers: 'webcam', legs: 'vmc' };

const FINGER = /(Thumb|Index|Middle|Ring|Little)(Metacarpal|Proximal|Intermediate|Distal)$/;

/** Which region a VRM 1.0 humanoid bone belongs to (null: not driven from VMC). */
export function regionOf(bone: string): Region | null {
  if (FINGER.test(bone)) return 'fingers';
  if (/^(hips|spine|chest|upperChest)$/.test(bone)) return 'torso';
  if (/^(neck|head|jaw)$/.test(bone)) return 'head';
  if (/^(left|right)(Shoulder|UpperArm|LowerArm|Hand)$/.test(bone)) return 'arms';
  if (/^(left|right)(UpperLeg|LowerLeg|Foot|Toes)$/.test(bone)) return 'legs';
  return null; // eyes: the look-at drives them
}

/** Unity HumanBodyBones name -> three-vrm (VRM 1.0) humanoid name: the inverse of unityBoneName. */
export function vrmBoneName(unity: string): string {
  const thumb = /^(Left|Right)Thumb(Proximal|Intermediate|Distal)$/.exec(unity);
  if (thumb) {
    const seg = { Proximal: 'Metacarpal', Intermediate: 'Proximal', Distal: 'Distal' }[thumb[2]]!;
    return `${thumb[1].toLowerCase()}Thumb${seg}`;
  }
  return unity.charAt(0).toLowerCase() + unity.slice(1);
}

/** A received local rotation, in the avatar's +Z-facing space. */
export function fromUnityRotation(t: Transform7): Quaternion {
  return new Quaternion(t[3], -t[4], -t[5], t[6]).normalize();
}

const PRESET_BY_VRM0 = new Map(Object.entries(VRM0_PRESET_NAMES).map(([v1, v0]) => [normName(v0), v1]));

/**
 * Received blend shape names -> the avatar's expression names. A sender may
 * use ARKit names (perfect-sync apps), VRM 0.x clip names (A, Joy, Blink_L) or
 * the model's own names; matching ignores case and punctuation.
 */
export function mapBlends(blends: Record<string, number>, expressionNames: readonly string[], perfectSync: ReadonlyMap<ArkitName, string>): Map<string, number> {
  const byNorm = new Map(expressionNames.map((n) => [normName(n), n]));
  const arkit = new Map([...perfectSync].map(([a, expr]) => [normName(a), expr]));
  const out = new Map<string, number>();
  for (const [name, v] of Object.entries(blends)) {
    const n = normName(name);
    const target = arkit.get(n) ?? byNorm.get(n) ?? byNorm.get(normName(PRESET_BY_VRM0.get(n) ?? ''));
    if (target && Number.isFinite(v)) out.set(target, Math.min(1, Math.max(0, v)));
  }
  return out;
}

/** What the avatar applies from VMC this frame (Avatar.external). */
export interface ExternalPose {
  /** VRM 1.0 bone name -> local rotation in +Z-facing space. */
  bones: Map<string, Quaternion>;
  /** Expression name -> weight, when the face region comes from VMC. */
  expressions: Map<string, number> | null;
}

/** Received data older than this no longer drives anything: the regions fall back to the webcam / idle. */
export const STALE_MS = 500;

export class VmcInput {
  frame: VmcInFrame | null = null;
  receivedAt = -Infinity;

  set(frame: VmcInFrame, now = performance.now()): void {
    this.frame = frame;
    this.receivedAt = now;
  }

  live(now = performance.now()): boolean {
    return !!this.frame && now - this.receivedAt < STALE_MS;
  }

  /** The pose for the regions set to VMC, or null when there's nothing live to apply. */
  pose(sources: RegionSources, avatar: { expressionNames: readonly string[]; perfectSync: ReadonlyMap<ArkitName, string>; hasBone(b: string): boolean }, now = performance.now()): ExternalPose | null {
    const f = this.frame;
    if (!f || !this.live(now)) return null;
    const bones = new Map<string, Quaternion>();
    for (const [unity, t] of Object.entries(f.bones)) {
      const b = vrmBoneName(unity);
      const r = regionOf(b);
      if (r && sources[r] === 'vmc' && avatar.hasBone(b)) bones.set(b, fromUnityRotation(t));
    }
    const expressions = sources.face === 'vmc' && Object.keys(f.blends).length ? mapBlends(f.blends, avatar.expressionNames, avatar.perfectSync) : null;
    return bones.size || expressions?.size ? { bones, expressions } : null;
  }
}
