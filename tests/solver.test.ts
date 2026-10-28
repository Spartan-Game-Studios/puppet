import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { basisRotation, BodySolver, qpow, twistAbout, type Landmark, type RestDirs } from '../src/core/bodySolver';
import { headPoseFromMatrix, mirrorQuat } from '../src/core/headPose';
import { toUnity, unityBoneName } from '../src/vmc/vmcFrame';

const rest: RestDirs = {
  leftUpperArm: new Vector3(1, 0, 0),
  leftLowerArm: new Vector3(1, 0, 0),
  leftHand: new Vector3(1, 0, 0),
  rightUpperArm: new Vector3(-1, 0, 0),
  rightLowerArm: new Vector3(-1, 0, 0),
  rightHand: new Vector3(-1, 0, 0),
};

/** A pose in MediaPipe world coords (x image-right, y down, z away from camera). */
function pose(points: Record<number, [number, number, number]>): Landmark[] {
  const out: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0 }));
  for (const [i, [x, y, z]] of Object.entries(points)) out[Number(i)] = { x, y, z, visibility: 1 };
  return out;
}

// The user's left side appears at image right (+x) in an unmirrored camera image.
const T_POSE = pose({
  11: [0.2, -0.5, 0], 12: [-0.2, -0.5, 0],
  13: [0.45, -0.5, 0], 14: [-0.45, -0.5, 0],
  15: [0.7, -0.5, 0], 16: [-0.7, -0.5, 0],
  19: [0.8, -0.5, -0.03], 20: [-0.8, -0.5, -0.03],
  17: [0.8, -0.5, 0.03], 18: [-0.8, -0.5, 0.03],
  23: [0.1, 0, 0], 24: [-0.1, 0, 0],
});

const dirOf = (q: Quaternion, v: Vector3) => v.clone().applyQuaternion(q);

describe('basisRotation', () => {
  it('maps one frame onto another', () => {
    const q = basisRotation(new Vector3(1, 0, 0), new Vector3(0, 0, 1), new Vector3(0, -1, 0), new Vector3(0, 0, 1));
    expect(dirOf(q, new Vector3(1, 0, 0)).distanceTo(new Vector3(0, -1, 0))).toBeLessThan(1e-6);
    expect(dirOf(q, new Vector3(0, 0, 1)).distanceTo(new Vector3(0, 0, 1))).toBeLessThan(1e-6);
  });
  it('qpow and twist decompose consistently', () => {
    const q = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 1);
    expect(qpow(q, 0.5).angleTo(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.5))).toBeLessThan(1e-6);
    const tw = twistAbout(q, new Vector3(1, 0, 0));
    expect(tw.angleTo(q)).toBeLessThan(1e-6);
    expect(twistAbout(q, new Vector3(0, 1, 0)).angleTo(new Quaternion())).toBeLessThan(1e-6);
  });
});

describe('BodySolver', () => {
  it('a T-pose solves to (near) identity arms', () => {
    const s = new BodySolver(rest, { mirror: false, hands: false });
    const sol = s.solve({ poseWorld: T_POSE }, [['spine', 1]]);
    for (const b of ['leftUpperArm', 'leftLowerArm', 'rightUpperArm', 'rightLowerArm']) {
      expect(sol.bones.get(b)!.angleTo(new Quaternion())).toBeLessThan(0.05);
    }
  });

  it('arms down point the upper arms down', () => {
    const p = pose({
      11: [0.2, -0.5, 0], 12: [-0.2, -0.5, 0],
      13: [0.22, -0.2, 0], 14: [-0.22, -0.2, 0],
      15: [0.23, 0.05, 0], 16: [-0.23, 0.05, 0],
      23: [0.1, 0, 0], 24: [-0.1, 0, 0],
    });
    const s = new BodySolver(rest, { mirror: false, hands: false });
    const sol = s.solve({ poseWorld: p }, [['spine', 1]]);
    const d = dirOf(sol.bones.get('leftUpperArm')!, rest.leftUpperArm!);
    expect(d.y).toBeLessThan(-0.9);
  });

  it('raising the user’s left arm raises the avatar’s left arm unmirrored, its right mirrored', () => {
    const p = pose({
      11: [0.2, -0.5, 0], 12: [-0.2, -0.5, 0],
      13: [0.22, -0.8, 0], 14: [-0.22, -0.2, 0],
      15: [0.23, -1.05, 0], 16: [-0.23, 0.05, 0],
      23: [0.1, 0, 0], 24: [-0.1, 0, 0],
    });
    const plain = new BodySolver(rest, { mirror: false, hands: false }).solve({ poseWorld: p }, [['spine', 1]]);
    expect(dirOf(plain.bones.get('leftUpperArm')!, rest.leftUpperArm!).y).toBeGreaterThan(0.9);
    expect(dirOf(plain.bones.get('rightUpperArm')!, rest.rightUpperArm!).y).toBeLessThan(-0.9);
    const mir = new BodySolver(rest, { mirror: true, hands: false }).solve({ poseWorld: p }, [['spine', 1]]);
    expect(dirOf(mir.bones.get('rightUpperArm')!, rest.rightUpperArm!).y).toBeGreaterThan(0.9);
    expect(dirOf(mir.bones.get('leftUpperArm')!, rest.leftUpperArm!).y).toBeLessThan(-0.9);
  });

  it('a bent elbow bends the forearm forward, toward the camera', () => {
    // Left arm out to the side, forearm pointing at the camera (z negative = closer).
    const p = pose({
      11: [0.2, -0.5, 0], 12: [-0.2, -0.5, 0],
      13: [0.45, -0.5, 0], 14: [-0.45, -0.5, 0],
      15: [0.45, -0.5, -0.25], 16: [-0.7, -0.5, 0],
      23: [0.1, 0, 0], 24: [-0.1, 0, 0],
    });
    const sol = new BodySolver(rest, { mirror: false, hands: false }).solve({ poseWorld: p }, [['spine', 1]]);
    const upper = sol.bones.get('leftUpperArm')!;
    const lower = sol.bones.get('leftLowerArm')!;
    const foreWorld = dirOf(upper.clone().multiply(lower), rest.leftLowerArm!);
    expect(foreWorld.z).toBeGreaterThan(0.9);
    // The hinge stays a hinge: the forearm's local rotation is about the up axis.
    const axis = new Vector3(lower.x, lower.y, lower.z).normalize();
    expect(Math.abs(axis.y)).toBeGreaterThan(0.9);
  });

  it('low-visibility arms are left unsolved', () => {
    const p = T_POSE.map((l, i) => (i === 15 ? { ...l, visibility: 0.1 } : l));
    const sol = new BodySolver(rest, { mirror: false, hands: false }).solve({ poseWorld: p }, [['spine', 1]]);
    expect(sol.armConfidence.left).toBeLessThan(0.5);
    expect(sol.bones.has('leftUpperArm')).toBe(false);
    expect(sol.bones.has('rightUpperArm')).toBe(true);
  });

  it('a leaning torso rotates the spine, clamped', () => {
    const p = pose({
      11: [0.2 + 0.3, -0.5, 0], 12: [-0.2 + 0.3, -0.5, 0],
      13: [0.45, -0.5, 0], 14: [-0.45, -0.5, 0], 15: [0.7, -0.5, 0], 16: [-0.7, -0.5, 0],
      23: [0.1, 0, 0], 24: [-0.1, 0, 0],
    });
    const s = new BodySolver(rest, { mirror: false, hands: false, maxTorsoAngle: 0.4 });
    const sol = s.solve({ poseWorld: p }, [['spine', 1]]);
    const spine = sol.bones.get('spine')!;
    const ang = 2 * Math.acos(Math.min(1, Math.abs(spine.w)));
    expect(ang).toBeGreaterThan(0.2);
    expect(ang).toBeLessThanOrEqual(0.4 + 1e-6);
  });

  it('assigns hands to sides via the nearest pose wrist', () => {
    const s = new BodySolver(rest, { mirror: false, hands: true });
    const img = T_POSE.map((l) => ({ x: 0.5 + l.x * 0.5, y: 0.5 + l.y * 0.5, z: 0, visibility: 1 }));
    const hand = (x: number) => ({
      landmarks: Array.from({ length: 21 }, () => ({ x, y: 0.25, z: 0 })),
      worldLandmarks: [],
      handedness: 'Left',
      score: 0.9,
    });
    const a = s.assignHands({ poseImage: img, hands: [hand(0.85), hand(0.15)] });
    expect(a.left!.landmarks[0].x).toBe(0.85);
    expect(a.right!.landmarks[0].x).toBe(0.15);
  });
});

describe('head pose', () => {
  it('identity matrix is a neutral head', () => {
    const m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -50, 1];
    const p = headPoseFromMatrix(m, false);
    expect(p.rotation.angleTo(new Quaternion())).toBeLessThan(1e-6);
    expect(p.position.z).toBeCloseTo(-0.5);
  });
  it('mirroring negates yaw and roll but keeps pitch', () => {
    const yaw = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.3);
    const pitch = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.3);
    expect(mirrorQuat(yaw.clone()).angleTo(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -0.3))).toBeLessThan(1e-6);
    expect(mirrorQuat(pitch.clone()).angleTo(pitch)).toBeLessThan(1e-6);
  });
});

describe('VMC coordinate conversion', () => {
  it('maps bone names to Unity HumanBodyBones', () => {
    expect(unityBoneName('hips')).toBe('Hips');
    expect(unityBoneName('leftUpperArm')).toBe('LeftUpperArm');
    expect(unityBoneName('upperChest')).toBe('UpperChest');
    expect(unityBoneName('leftThumbMetacarpal')).toBe('LeftThumbProximal');
    expect(unityBoneName('leftThumbProximal')).toBe('LeftThumbIntermediate');
    expect(unityBoneName('rightThumbDistal')).toBe('RightThumbDistal');
    expect(unityBoneName('leftLittleIntermediate')).toBe('LeftLittleIntermediate');
  });
  it('mirrors X for positions and flips y/z for rotations', () => {
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.5);
    const t = toUnity(new Vector3(0.1, 1, 0.2), q);
    expect(t.slice(0, 3)).toEqual([-0.1, 1, 0.2]);
    expect(t[4]).toBeCloseTo(-q.y);
    expect(t[6]).toBeCloseTo(q.w);
  });
  it('the conversion is a proper reflection: rotating a mirrored vector matches mirroring the rotated one', () => {
    const q = new Quaternion().setFromAxisAngle(new Vector3(0.3, 0.8, -0.5).normalize(), 1.1);
    const v = new Vector3(0.2, -0.4, 0.9);
    const u = toUnity(v, q);
    const qu = new Quaternion(u[3], u[4], u[5], u[6]);
    const mirrored = (w: Vector3) => new Vector3(-w.x, w.y, w.z);
    const a = mirrored(v.clone().applyQuaternion(q));
    const b = mirrored(v).applyQuaternion(qu);
    expect(a.distanceTo(b)).toBeLessThan(1e-6);
  });
});
