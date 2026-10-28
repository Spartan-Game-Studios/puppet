/**
 * Measures a posed humanoid in a model-independent way: world directions of
 * the arm bones and the bend angle of every finger joint. Used to compare the
 * rendered test clip's ground truth with what the tracked avatar does
 * (scripts/track-clip.mjs), so it has to work from rotations alone.
 *
 * All quantities are in the solver's avatar space (+Y up, facing +Z).
 */
import { Quaternion, Vector3 } from 'three';
import type { RestDirs, Side } from './bodySolver';

export const PROBE_ARM_BONES = ['UpperArm', 'LowerArm', 'Hand'] as const;

/** Finger joints as [name, parent segment bone, child segment bone]. */
export const PROBE_FINGER_JOINTS: Array<[string, string, string]> = [
  ['ThumbMCP', 'ThumbMetacarpal', 'ThumbProximal'],
  ['ThumbIP', 'ThumbProximal', 'ThumbDistal'],
];
for (const f of ['Index', 'Middle', 'Ring', 'Little']) {
  PROBE_FINGER_JOINTS.push([`${f}MCP`, 'Hand', `${f}Proximal`]);
  PROBE_FINGER_JOINTS.push([`${f}PIP`, `${f}Proximal`, `${f}Intermediate`]);
  PROBE_FINGER_JOINTS.push([`${f}DIP`, `${f}Intermediate`, `${f}Distal`]);
}

export interface RigProbe {
  /** `${side}${Bone}` -> unit world direction [x, y, z]. */
  dirs: Record<string, [number, number, number]>;
  /** `${side}${Joint}` -> bend angle, degrees (0 = straight). */
  joints: Record<string, number>;
  /** Elbow bend per side, degrees. */
  elbow: Record<Side, number>;
}

/**
 * `world(bone)` returns the bone's world rotation in solver space (or null if
 * the model lacks it); `rest` the bone's rest direction in that space.
 */
export function probeRig(world: (bone: string) => Quaternion | null, rest: RestDirs): RigProbe {
  const dirs: RigProbe['dirs'] = {};
  const joints: RigProbe['joints'] = {};
  const dirOf = (bone: string): Vector3 | null => {
    const q = world(bone);
    const r = rest[bone];
    if (!q || !r) return null;
    return r.clone().applyQuaternion(q).normalize();
  };
  const elbow = { left: 0, right: 0 };
  for (const side of ['left', 'right'] as Side[]) {
    for (const b of PROBE_ARM_BONES) {
      const d = dirOf(`${side}${b}`);
      if (d) dirs[`${side}${b}`] = [d.x, d.y, d.z];
    }
    const u = dirOf(`${side}UpperArm`);
    const l = dirOf(`${side}LowerArm`);
    if (u && l) elbow[side] = (u.angleTo(l) * 180) / Math.PI;
    for (const [name, a, b] of PROBE_FINGER_JOINTS) {
      const da = dirOf(`${side}${a}`);
      const db = dirOf(`${side}${b}`);
      if (da && db) joints[`${side}${name}`] = (da.angleTo(db) * 180) / Math.PI;
    }
  }
  return { dirs, joints, elbow };
}
