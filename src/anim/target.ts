/** The avatar's side of retargeting: its humanoid bones and rest directions in solver space. */
import { Object3D, Vector3 } from 'three';
import type { Avatar } from '../scene/avatar';
import { DIR_CHILD } from './rigMap';
import { toVrmDir, type TargetRig } from './retarget';

/**
 * Rest offset of `node` below `ancestor`. Normalized bones are identity at
 * rest, so the sum of local positions is the rest offset whatever the
 * current pose.
 */
function restOffset(node: Object3D, ancestor: Object3D | null): Vector3 {
  const v = new Vector3();
  for (let n: Object3D | null = node; n && n !== ancestor; n = n.parent) {
    v.add(n.position);
    if (!n.parent) break;
  }
  return v;
}

export function targetRig(avatar: Avatar, hipsRest?: Vector3): TargetRig {
  const vrm0 = avatar.isVrm0;
  const bones = new Set(avatar.humanBoneNames);
  const restDirs = new Map<string, Vector3>();
  for (const [b, child] of Object.entries(DIR_CHILD)) {
    const a = avatar.bone(b);
    const c = avatar.bone(child);
    if (!a || !c) continue;
    // child may sit below an intermediate bone the avatar has (e.g. no upperChest).
    const d = restOffset(c, a);
    if (d.lengthSq() > 1e-10) restDirs.set(b, toVrmDir(d.normalize(), vrm0));
  }
  const hips = avatar.bone('hips');
  const root = avatar.vrm.scene;
  const height = (n: Object3D | undefined) => (n ? restOffset(n, root).y : NaN);
  let hy = height(hips);
  if (hipsRest && hips) hy += hipsRest.y - hips.position.y;
  const feet = ['leftFoot', 'rightFoot', 'leftToes', 'rightToes'].map((b) => height(avatar.bone(b))).filter(Number.isFinite);
  const floor = feet.length ? Math.min(...feet) - 0.04 : 0;
  const hipHeight = Number.isFinite(hy) ? Math.max(0.2, hy - floor) : 0.9;
  return { bones, restDirs, hipHeight };
}
