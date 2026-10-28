/**
 * Bone-name mapping from animation source rigs onto VRM humanoid bones.
 *
 * Each rig family has a table keyed by a normalised bone name (lower case,
 * letters and digits only, with any `mixamorig:` style namespace removed).
 * `detectRig` picks the family whose table matches the most names.
 *
 * Pure: no three.js.
 */

export type RigFamily = 'mixamo' | 'ual' | 'vroid' | 'vrm' | 'generic';

/** VRM 1.0 humanoid bone names (three-vrm naming), in parent-before-child order. */
export const VRM_BONES = [
  'hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'leftEye', 'rightEye', 'jaw',
  'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
  'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes',
  'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes',
  ...(['left', 'right'] as const).flatMap((s) => [
    `${s}ThumbMetacarpal`, `${s}ThumbProximal`, `${s}ThumbDistal`,
    ...['Index', 'Middle', 'Ring', 'Little'].flatMap((f) => [`${s}${f}Proximal`, `${s}${f}Intermediate`, `${s}${f}Distal`]),
  ]),
] as const;
export type VrmBone = (typeof VRM_BONES)[number];

/** Humanoid parent of each bone (VRM spec hierarchy). */
export const VRM_PARENT: Record<string, string | null> = {
  hips: null, spine: 'hips', chest: 'spine', upperChest: 'chest', neck: 'upperChest', head: 'neck',
  leftEye: 'head', rightEye: 'head', jaw: 'head',
  leftShoulder: 'upperChest', leftUpperArm: 'leftShoulder', leftLowerArm: 'leftUpperArm', leftHand: 'leftLowerArm',
  rightShoulder: 'upperChest', rightUpperArm: 'rightShoulder', rightLowerArm: 'rightUpperArm', rightHand: 'rightLowerArm',
  leftUpperLeg: 'hips', leftLowerLeg: 'leftUpperLeg', leftFoot: 'leftLowerLeg', leftToes: 'leftFoot',
  rightUpperLeg: 'hips', rightLowerLeg: 'rightUpperLeg', rightFoot: 'rightLowerLeg', rightToes: 'rightFoot',
};
/** The bone whose direction (bone -> child) defines each bone's rest direction. */
export const DIR_CHILD: Record<string, string> = {
  hips: 'spine', spine: 'chest', chest: 'upperChest', upperChest: 'neck', neck: 'head',
  leftShoulder: 'leftUpperArm', leftUpperArm: 'leftLowerArm', leftLowerArm: 'leftHand', leftHand: 'leftMiddleProximal',
  rightShoulder: 'rightUpperArm', rightUpperArm: 'rightLowerArm', rightLowerArm: 'rightHand', rightHand: 'rightMiddleProximal',
  leftUpperLeg: 'leftLowerLeg', leftLowerLeg: 'leftFoot', leftFoot: 'leftToes',
  rightUpperLeg: 'rightLowerLeg', rightLowerLeg: 'rightFoot', rightFoot: 'rightToes',
};
for (const s of ['left', 'right']) {
  const H = `${s}Hand`;
  VRM_PARENT[`${s}ThumbMetacarpal`] = H;
  VRM_PARENT[`${s}ThumbProximal`] = `${s}ThumbMetacarpal`;
  VRM_PARENT[`${s}ThumbDistal`] = `${s}ThumbProximal`;
  DIR_CHILD[`${s}ThumbMetacarpal`] = `${s}ThumbProximal`;
  DIR_CHILD[`${s}ThumbProximal`] = `${s}ThumbDistal`;
  for (const f of ['Index', 'Middle', 'Ring', 'Little']) {
    VRM_PARENT[`${s}${f}Proximal`] = H;
    VRM_PARENT[`${s}${f}Intermediate`] = `${s}${f}Proximal`;
    VRM_PARENT[`${s}${f}Distal`] = `${s}${f}Intermediate`;
    DIR_CHILD[`${s}${f}Proximal`] = `${s}${f}Intermediate`;
    DIR_CHILD[`${s}${f}Intermediate`] = `${s}${f}Distal`;
  }
}

/** Normalise a source bone name: drop a namespace prefix, lower case, letters and digits only. */
export function normBoneName(name: string): string {
  let n = name.replace(/^.*[:|]/, ''); // "mixamorig:Hips", "Armature|Hips"
  n = n.toLowerCase().replace(/[^a-z0-9]/g, '');
  // three's PropertyBinding.sanitizeNodeName drops the ':' ("mixamorigHips").
  n = n.replace(/^mixamorig\d*/, '');
  return n;
}

const SIDES = [
  ['left', 'Left', 'l'],
  ['right', 'Right', 'r'],
] as const;
const FINGERS = [
  ['Thumb', 'thumb'],
  ['Index', 'index'],
  ['Middle', 'middle'],
  ['Ring', 'ring'],
  ['Little', 'pinky'],
] as const;
const segs = (f: string) => (f === 'Thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Intermediate', 'Distal']);

function table(entries: Array<[string, string]>): Map<string, string> {
  return new Map(entries.map(([src, vrm]) => [normBoneName(src), vrm]));
}

/** Mixamo: mixamorig:Hips, Spine, Spine1, Spine2, LeftArm, LeftForeArm, LeftHandIndex1... */
const MIXAMO = table([
  ['Hips', 'hips'], ['Spine', 'spine'], ['Spine1', 'chest'], ['Spine2', 'upperChest'], ['Neck', 'neck'], ['Head', 'head'],
  ...SIDES.flatMap(([v, M]) => [
    [`${M}Shoulder`, `${v}Shoulder`], [`${M}Arm`, `${v}UpperArm`], [`${M}ForeArm`, `${v}LowerArm`], [`${M}Hand`, `${v}Hand`],
    [`${M}UpLeg`, `${v}UpperLeg`], [`${M}Leg`, `${v}LowerLeg`], [`${M}Foot`, `${v}Foot`], [`${M}ToeBase`, `${v}Toes`],
    ...FINGERS.flatMap(([F]) => segs(F).map((s, i) => [`${M}Hand${F === 'Little' ? 'Pinky' : F}${i + 1}`, `${v}${F}${s}`])),
  ] as Array<[string, string]>),
]);

/** Quaternius Universal Animation Library (Unreal mannequin naming): pelvis, spine_01, upperarm_l... */
const UAL = table([
  ['pelvis', 'hips'], ['spine_01', 'spine'], ['spine_02', 'chest'], ['spine_03', 'upperChest'], ['neck_01', 'neck'], ['Head', 'head'],
  ...SIDES.flatMap(([v, , s]) => [
    [`clavicle_${s}`, `${v}Shoulder`], [`upperarm_${s}`, `${v}UpperArm`], [`lowerarm_${s}`, `${v}LowerArm`], [`hand_${s}`, `${v}Hand`],
    [`thigh_${s}`, `${v}UpperLeg`], [`calf_${s}`, `${v}LowerLeg`], [`foot_${s}`, `${v}Foot`], [`ball_${s}`, `${v}Toes`],
    ...FINGERS.flatMap(([F, f]) => segs(F).map((seg, i) => [`${f}_0${i + 1}_${s}`, `${v}${F}${seg}`])),
  ] as Array<[string, string]>),
]);

/** VRoid Studio exports: J_Bip_C_Hips, J_Bip_L_UpperArm, J_Bip_L_Thumb1... */
const VROID = table([
  ['J_Bip_C_Hips', 'hips'], ['J_Bip_C_Spine', 'spine'], ['J_Bip_C_Chest', 'chest'], ['J_Bip_C_UpperChest', 'upperChest'],
  ['J_Bip_C_Neck', 'neck'], ['J_Bip_C_Head', 'head'],
  ...SIDES.flatMap(([v, M]) => {
    const p = `J_Bip_${M[0]}_`;
    return [
      [`${p}Shoulder`, `${v}Shoulder`], [`${p}UpperArm`, `${v}UpperArm`], [`${p}LowerArm`, `${v}LowerArm`], [`${p}Hand`, `${v}Hand`],
      [`${p}UpperLeg`, `${v}UpperLeg`], [`${p}LowerLeg`, `${v}LowerLeg`], [`${p}Foot`, `${v}Foot`], [`${p}ToeBase`, `${v}Toes`],
      ...FINGERS.flatMap(([F]) => segs(F).map((s, i) => [`${p}${F}${i + 1}`, `${v}${F}${s}`])),
    ] as Array<[string, string]>;
  }),
]);

/** VRM humanoid names used directly as node names (e.g. a re-export of a normalized rig). */
const VRM_DIRECT = table(VRM_BONES.map((b) => [b, b]));

/** Common names from other rigs (Blender/Unity-style "UpperArm.L", "LeftUpperArm", "Spine1"...). */
const GENERIC = table([
  ['Hips', 'hips'], ['Pelvis', 'hips'], ['Spine', 'spine'], ['Chest', 'chest'], ['UpperChest', 'upperChest'], ['Neck', 'neck'], ['Head', 'head'],
  ...SIDES.flatMap(([v, M, s]) => [
    [`${M}Shoulder`, `${v}Shoulder`], [`shoulder.${s}`, `${v}Shoulder`], [`${M}UpperArm`, `${v}UpperArm`], [`upper_arm.${s}`, `${v}UpperArm`],
    [`${M}LowerArm`, `${v}LowerArm`], [`forearm.${s}`, `${v}LowerArm`], [`${M}Hand`, `${v}Hand`], [`hand.${s}`, `${v}Hand`],
    [`${M}UpperLeg`, `${v}UpperLeg`], [`thigh.${s}`, `${v}UpperLeg`], [`${M}LowerLeg`, `${v}LowerLeg`], [`shin.${s}`, `${v}LowerLeg`],
    [`${M}Foot`, `${v}Foot`], [`foot.${s}`, `${v}Foot`], [`${M}Toes`, `${v}Toes`], [`toe.${s}`, `${v}Toes`],
  ] as Array<[string, string]>),
]);

export const RIG_TABLES: Record<RigFamily, Map<string, string>> = {
  mixamo: MIXAMO,
  ual: UAL,
  vroid: VROID,
  vrm: VRM_DIRECT,
  generic: GENERIC,
};

export interface RigDetection {
  family: RigFamily;
  /** Source node name -> VRM humanoid bone. */
  map: Map<string, string>;
  /** How many of the core bones (hips, spine, head, arms, legs) were found. */
  core: number;
}

const CORE = ['hips', 'spine', 'head', 'leftUpperArm', 'leftLowerArm', 'rightUpperArm', 'rightLowerArm', 'leftUpperLeg', 'leftLowerLeg', 'rightUpperLeg', 'rightLowerLeg'];

/** Map a set of source node names onto VRM bones using one family's table. */
export function mapWith(family: RigFamily, names: Iterable<string>): Map<string, string> {
  const t = RIG_TABLES[family];
  const map = new Map<string, string>();
  const used = new Set<string>();
  for (const n of names) {
    // Mixamo marks its rig with a namespace; don't map those names with another table.
    if (family !== 'mixamo' && /^mixamorig/i.test(n)) continue;
    const v = t.get(normBoneName(n));
    if (v && !used.has(v)) {
      map.set(n, v);
      used.add(v);
    }
  }
  return map;
}

/** Pick the rig family that maps the most core bones (ties: the more specific family wins). */
export function detectRig(names: Iterable<string>): RigDetection {
  const list = [...names];
  const isMixamo = list.some((n) => /^mixamorig/i.test(n));
  let best: RigDetection = { family: 'generic', map: new Map(), core: 0 };
  const order: RigFamily[] = isMixamo ? ['mixamo'] : ['ual', 'vroid', 'vrm', 'mixamo', 'generic'];
  for (const family of order) {
    const map = mapWith(family, list);
    const vals = new Set(map.values());
    const core = CORE.filter((c) => vals.has(c)).length;
    if (core > best.core || (core === best.core && map.size > best.map.size)) best = { family, map, core };
  }
  return best;
}
