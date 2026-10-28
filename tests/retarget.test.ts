import { describe, expect, it } from 'vitest';
import { AnimationClip, Bone, Object3D, Quaternion, QuaternionKeyframeTrack, Vector3, VectorKeyframeTrack } from 'three';
import { detectRig, mapWith, normBoneName } from '../src/anim/rigMap';
import { bindClip, extractSourceClip, sampleBone, toVrmBone, toVrmDir, type TargetRig } from '../src/anim/retarget';
import { bakeAuthored, AUTHORED } from '../src/anim/authored';

// ---------------------------------------------------------------- rig naming

const MIXAMO = ['mixamorig:Hips', 'mixamorig:Spine', 'mixamorig:Spine1', 'mixamorig:Spine2', 'mixamorig:Neck', 'mixamorig:Head', 'mixamorig:LeftShoulder', 'mixamorig:LeftArm', 'mixamorig:LeftForeArm', 'mixamorig:LeftHand', 'mixamorig:LeftHandThumb1', 'mixamorig:LeftHandPinky3', 'mixamorig:RightArm', 'mixamorig:RightForeArm', 'mixamorig:LeftUpLeg', 'mixamorig:LeftLeg', 'mixamorig:LeftFoot', 'mixamorig:LeftToeBase', 'mixamorig:RightUpLeg', 'mixamorig:RightLeg', 'mixamorig:HeadTop_End'];
const UAL = ['root', 'pelvis', 'spine_01', 'spine_02', 'spine_03', 'neck_01', 'Head', 'clavicle_l', 'upperarm_l', 'lowerarm_l', 'hand_l', 'thumb_01_l', 'pinky_03_l', 'index_04_leaf_l', 'upperarm_r', 'lowerarm_r', 'thigh_l', 'calf_l', 'foot_l', 'ball_l', 'thigh_r', 'calf_r'];
const VROID = ['Root', 'J_Bip_C_Hips', 'J_Bip_C_Spine', 'J_Bip_C_Chest', 'J_Bip_C_UpperChest', 'J_Bip_C_Neck', 'J_Bip_C_Head', 'J_Bip_L_Shoulder', 'J_Bip_L_UpperArm', 'J_Bip_L_LowerArm', 'J_Bip_L_Hand', 'J_Bip_L_Thumb1', 'J_Bip_L_Little3', 'J_Bip_R_UpperArm', 'J_Bip_R_LowerArm', 'J_Bip_L_UpperLeg', 'J_Bip_L_LowerLeg', 'J_Bip_L_Foot', 'J_Bip_L_ToeBase', 'J_Bip_R_UpperLeg', 'J_Bip_R_LowerLeg', 'J_Sec_Hair1_01'];

describe('bone-name mapping', () => {
  it('normalises namespaces and three.js-sanitised names', () => {
    expect(normBoneName('mixamorig:LeftArm')).toBe('leftarm');
    expect(normBoneName('mixamorigLeftArm')).toBe('leftarm');
    expect(normBoneName('mixamorig1:LeftArm')).toBe('leftarm');
    expect(normBoneName('Armature|J_Bip_C_Hips')).toBe('jbipchips');
  });

  it('detects Mixamo (namespaced and sanitised)', () => {
    for (const names of [MIXAMO, MIXAMO.map((n) => n.replace(':', ''))]) {
      const d = detectRig(names);
      expect(d.family).toBe('mixamo');
      const m = d.map;
      expect(m.get(names[0])).toBe('hips');
      expect(m.get(names[2])).toBe('chest');
      expect(m.get(names[3])).toBe('upperChest');
      expect(m.get(names[7])).toBe('leftUpperArm');
      expect(m.get(names[8])).toBe('leftLowerArm');
      expect(m.get(names[10])).toBe('leftThumbMetacarpal');
      expect(m.get(names[11])).toBe('leftLittleDistal');
      expect(m.get(names[14])).toBe('leftUpperLeg');
      expect(m.get(names[17])).toBe('leftToes');
      expect(m.has(names[20])).toBe(false); // HeadTop_End
    }
  });

  it('detects the Universal Animation Library rig', () => {
    const d = detectRig(UAL);
    expect(d.family).toBe('ual');
    expect(d.map.get('pelvis')).toBe('hips');
    expect(d.map.get('spine_03')).toBe('upperChest');
    expect(d.map.get('clavicle_l')).toBe('leftShoulder');
    expect(d.map.get('thumb_01_l')).toBe('leftThumbMetacarpal');
    expect(d.map.get('pinky_03_l')).toBe('leftLittleDistal');
    expect(d.map.get('ball_l')).toBe('leftToes');
    expect(d.map.get('calf_r')).toBe('rightLowerLeg');
    expect(d.map.has('root')).toBe(false);
    expect(d.map.has('index_04_leaf_l')).toBe(false);
  });

  it('detects VRoid naming', () => {
    const d = detectRig(VROID);
    expect(d.family).toBe('vroid');
    expect(d.map.get('J_Bip_C_UpperChest')).toBe('upperChest');
    expect(d.map.get('J_Bip_L_Thumb1')).toBe('leftThumbMetacarpal');
    expect(d.map.get('J_Bip_L_Little3')).toBe('leftLittleDistal');
    expect(d.map.get('J_Bip_L_ToeBase')).toBe('leftToes');
    expect(d.map.has('J_Sec_Hair1_01')).toBe(false);
  });

  it('never maps a bone twice', () => {
    const m = mapWith('generic', ['Hips', 'Pelvis', 'Spine']);
    expect([...m.values()].filter((v) => v === 'hips')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- retarget maths

/**
 * A minimal Mixamo-named skeleton standing in an A-pose (arms 45 deg down),
 * all bones with identity rest rotations, wrapped in `wrap` (e.g. Z-up).
 */
function aPoseRig(wrap: Quaternion): { root: Object3D; bones: Record<string, Bone> } {
  const root = new Object3D();
  root.quaternion.copy(wrap);
  const bones: Record<string, Bone> = {};
  const add = (name: string, parent: Object3D, pos: [number, number, number]) => {
    const b = new Bone();
    b.name = `mixamorig${name}`;
    b.position.set(...pos);
    parent.add(b);
    bones[name] = b;
    return b;
  };
  const s = Math.SQRT1_2;
  const hips = add('Hips', root, [0, 1, 0]);
  const spine = add('Spine', hips, [0, 0.1, 0]);
  const chest = add('Spine1', spine, [0, 0.15, 0]);
  const neck = add('Neck', chest, [0, 0.2, 0]);
  add('Head', neck, [0, 0.1, 0]);
  for (const [side, x] of [['Left', 1], ['Right', -1]] as const) {
    const sh = add(`${side}Shoulder`, chest, [0.05 * x, 0.15, 0]);
    const arm = add(`${side}Arm`, sh, [0.1 * x, 0, 0]);
    const fore = add(`${side}ForeArm`, arm, [0.25 * s * x, -0.25 * s, 0]);
    add(`${side}Hand`, fore, [0.25 * s * x, -0.25 * s, 0]);
    const up = add(`${side}UpLeg`, hips, [0.1 * x, -0.05, 0]);
    const leg = add(`${side}Leg`, up, [0, -0.45, 0]);
    add(`${side}Foot`, leg, [0, -0.45, 0]);
  }
  root.updateMatrixWorld(true);
  return { root, bones };
}

/** A VRM-like target: T-pose rest directions in solver space. */
function tPoseTarget(): TargetRig {
  const d = new Map<string, Vector3>([
    ['hips', new Vector3(0, 1, 0)], ['spine', new Vector3(0, 1, 0)], ['chest', new Vector3(0, 1, 0)], ['neck', new Vector3(0, 1, 0)],
    ['leftShoulder', new Vector3(1, 0, 0)], ['leftUpperArm', new Vector3(1, 0, 0)], ['leftLowerArm', new Vector3(1, 0, 0)],
    ['rightShoulder', new Vector3(-1, 0, 0)], ['rightUpperArm', new Vector3(-1, 0, 0)], ['rightLowerArm', new Vector3(-1, 0, 0)],
    ['leftUpperLeg', new Vector3(0, -1, 0)], ['leftLowerLeg', new Vector3(0, -1, 0)],
    ['rightUpperLeg', new Vector3(0, -1, 0)], ['rightLowerLeg', new Vector3(0, -1, 0)],
  ]);
  const bones = new Set([...d.keys(), 'head', 'leftHand', 'rightHand', 'leftFoot', 'rightFoot']);
  return { bones, restDirs: d, hipHeight: 0.95 };
}

/** World direction of a bone after applying a bound clip's local rotations at frame f. */
function worldDir(clip: ReturnType<typeof bindClip>, _bone: string, chain: string[], rest: Vector3, t = 0): Vector3 {
  const q = new Quaternion();
  const tmp = new Quaternion();
  for (const b of chain) q.multiply(sampleBone(clip, b, t, false, tmp) ?? new Quaternion());
  return rest.clone().applyQuaternion(q);
}
const ARM_CHAIN = ['hips', 'spine', 'chest', 'leftShoulder', 'leftUpperArm'];

const WRAPS: Array<[string, Quaternion]> = [
  ['Y-up facing +Z', new Quaternion()],
  ['Z-up (Blender-style)', new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2)],
  ['turned to face -Z', new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI)],
];

describe('retargeting', () => {
  for (const [label, wrap] of WRAPS) {
    it(`keeps the source's A-pose rest on a T-pose avatar (${label})`, () => {
      const { root } = aPoseRig(wrap);
      const clip = new AnimationClip('still', 1, []);
      const src = extractSourceClip(root, clip);
      expect(src.rig).toBe('mixamo');
      const bound = bindClip(src, tPoseTarget());
      const d = worldDir(bound, 'leftUpperArm', ARM_CHAIN, new Vector3(1, 0, 0));
      expect(d.x).toBeCloseTo(Math.SQRT1_2, 3);
      expect(d.y).toBeCloseTo(-Math.SQRT1_2, 3);
      expect(d.z).toBeCloseTo(0, 3);
      // Right arm mirrors it (no flipped limb).
      const r = worldDir(bound, 'rightUpperArm', ['hips', 'spine', 'chest', 'rightShoulder', 'rightUpperArm'], new Vector3(-1, 0, 0));
      expect(r.x).toBeCloseTo(-Math.SQRT1_2, 3);
      expect(r.y).toBeCloseTo(-Math.SQRT1_2, 3);
    });

    it(`follows a source arm motion into the avatar's frame (${label})`, () => {
      const { root } = aPoseRig(wrap);
      // Left arm swings forward: from A-pose to pointing straight ahead (+Z in the source's own frame).
      const fwd = new Quaternion().setFromUnitVectors(new Vector3(1, -1, 0).normalize(), new Vector3(0, 0, 1));
      const clip = new AnimationClip('reach', 1, [
        new QuaternionKeyframeTrack('mixamorigLeftArm.quaternion', [0, 1], [0, 0, 0, 1, fwd.x, fwd.y, fwd.z, fwd.w]),
      ]);
      const bound = bindClip(extractSourceClip(root, clip), tPoseTarget());
      const d = worldDir(bound, 'leftUpperArm', ARM_CHAIN, new Vector3(1, 0, 0), 1);
      expect(d.z).toBeCloseTo(1, 3);
      expect(d.y).toBeCloseTo(0, 3);
    });
  }

  it('turns a hips bob into metres for the avatar, travel removed in place', () => {
    const { root, bones } = aPoseRig(new Quaternion());
    const clip = new AnimationClip('bob', 1, [
      new VectorKeyframeTrack('mixamorigHips.position', [0, 0.5, 1], [0, 1, 0, 0.5, 0.9, 1, 1, 1, 2]),
    ]);
    void bones;
    const src = extractSourceClip(root, clip);
    const bound = bindClip(src, { ...tPoseTarget(), hipHeight: 1.9 }); // avatar twice the hip height
    const mid = (bound.frames - 1) / 2;
    // source hip height ~0.95 (hips 1.0, feet at 0.05): -0.1 m source -> about -0.2 m avatar.
    expect(bound.hips![mid * 3 + 1]).toBeCloseTo(-0.2, 1);
    // forward travel of 2 m is removed (start-to-end drift), so z stays ~0
    expect(Math.abs(bound.hips![(bound.frames - 1) * 3 + 2])).toBeLessThan(1e-4);
    expect(bindClip(src, tPoseTarget(), { rootMotion: 'off' }).hips).toBeNull();
  });

  it('extraction leaves the source scene untouched', () => {
    const { root, bones } = aPoseRig(new Quaternion());
    const before = bones.LeftArm.quaternion.clone();
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 1);
    extractSourceClip(root, new AnimationClip('x', 1, [new QuaternionKeyframeTrack('mixamorigLeftArm.quaternion', [0, 1], [q.x, q.y, q.z, q.w, q.x, q.y, q.z, q.w])]));
    expect(bones.LeftArm.quaternion.angleTo(before)).toBeCloseTo(0);
  });
});

describe('VRM 0.x vs 1.0 axes', () => {
  it('a solver-space rotation turns a VRM 0.x (-Z facing) bone the same way in the world', () => {
    // VRM 0.x normalized space is solver space turned 180 deg about Y.
    const turn = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI);
    const q = new Quaternion().setFromAxisAngle(new Vector3(0.3, 0.5, 0.8).normalize(), 1.1);
    const v = new Vector3(1, 0, 0); // solver-space left arm
    const expected = v.clone().applyQuaternion(q); // where VRM 1.0 points it
    // VRM 0.x: bone-space direction and rotation, then the scene's 180 deg turn (rotateVRM0).
    const v0 = toVrmDir(v.clone(), true);
    const q0 = toVrmBone(q.clone(), true);
    const world0 = v0.applyQuaternion(q0).applyQuaternion(turn);
    expect(world0.distanceTo(expected)).toBeLessThan(1e-6);
    // and it is its own inverse
    expect(toVrmBone(toVrmBone(q.clone(), true), true).angleTo(q)).toBeCloseTo(0);
  });

  it('VRM 1.0 passes through unchanged', () => {
    const q = new Quaternion(0.1, 0.2, 0.3, 0.9).normalize();
    expect(toVrmBone(q.clone(), false).angleTo(q)).toBeCloseTo(0);
  });
});

describe('authored emotes', () => {
  it('bake to unit quaternions on a T-pose avatar, starting and ending at the hang pose', () => {
    const target = tPoseTarget();
    for (const a of AUTHORED) {
      const c = bakeAuthored(a, target);
      expect(c.frames).toBeGreaterThan(10);
      for (const arr of c.bones.values()) for (let i = 0; i < arr.length; i += 4) expect(Math.hypot(arr[i], arr[i + 1], arr[i + 2], arr[i + 3])).toBeCloseTo(1, 4);
      const first = worldDir(c, 'leftUpperArm', ARM_CHAIN, new Vector3(1, 0, 0), 0);
      const last = worldDir(c, 'leftUpperArm', ARM_CHAIN, new Vector3(1, 0, 0), c.duration);
      expect(first.y).toBeLessThan(-0.9);
      expect(last.distanceTo(first)).toBeLessThan(1e-3);
    }
  });
});
