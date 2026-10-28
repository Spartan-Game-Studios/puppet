/** Which humanoid bones a clip owns while it plays over tracking. Pure. */
import { VRM_BONES } from './rigMap';

/**
 * - full: every bone (head too); face expressions stay tracked.
 * - body: everything but neck and head (the tracked head keeps looking).
 * - arms: shoulders, arms, hands and fingers only.
 * - head: neck and head only (nods, head shakes over a tracked body).
 */
export type BoneMask = 'full' | 'body' | 'arms' | 'head';
export const BONE_MASKS: BoneMask[] = ['full', 'body', 'arms', 'head'];

const HEAD = new Set(['neck', 'head', 'leftEye', 'rightEye', 'jaw']);
const isArm = (b: string) => /^(left|right)(Shoulder|UpperArm|LowerArm|Hand|Thumb|Index|Middle|Ring|Little)/.test(b);

const SETS: Record<BoneMask, Set<string>> = {
  full: new Set(VRM_BONES),
  body: new Set(VRM_BONES.filter((b) => !HEAD.has(b))),
  arms: new Set(VRM_BONES.filter(isArm)),
  head: new Set(['neck', 'head']),
};

export function maskHas(mask: BoneMask, bone: string): boolean {
  return SETS[mask].has(bone);
}

/** Masks that move the hips (and so may translate them). */
export const maskMovesHips = (mask: BoneMask) => mask === 'full' || mask === 'body';
/** Bones a mask gives to the clip after the avatar has set the head. */
export const isHeadBone = (b: string) => HEAD.has(b);
