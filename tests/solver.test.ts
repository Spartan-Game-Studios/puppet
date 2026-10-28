import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { basisRotation, BodySolver, BoneLength, JOINT_LIMITS, qpow, segmentDepth, twistAbout, type Landmark, type RestDirs } from '../src/core/bodySolver';
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

  it('an arm whose wrist is not visible keeps its upper arm, not its forearm', () => {
    const p = T_POSE.map((l, i) => (i === 15 ? { ...l, visibility: 0.1 } : l));
    const sol = new BodySolver(rest, { mirror: false, hands: false }).solve({ poseWorld: p }, [['spine', 1]]);
    expect(sol.armConfidence.left).toBeLessThan(0.5);
    expect(sol.armWeight.left).toBe(1);
    // Forearm relaxes to a slight bend instead of following the lost wrist.
    const lower = sol.bones.get('leftLowerArm')!;
    expect(2 * Math.acos(Math.min(1, Math.abs(lower.w)))).toBeCloseTo(0.3, 2);
    const noElbow = T_POSE.map((l, i) => (i === 13 ? { ...l, visibility: 0.1 } : l));
    const sol2 = new BodySolver(rest, { mirror: false, hands: false }).solve({ poseWorld: noElbow }, [['spine', 1]]);
    expect(sol2.bones.has('leftUpperArm')).toBe(false);
    expect(sol2.bones.has('rightUpperArm')).toBe(true);
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

/** Image landmarks for a world pose seen by a camera 2 m away, 640x480 (x right, y down). */
function imageOf(world: Landmark[]): Landmark[] {
  return world.map((l) => ({ x: 0.5 + l.x / 1.6, y: 0.5 + (l.y + 0.5) / 1.2, z: 0, visibility: l.visibility }));
}

const angleOf = (q: Quaternion) => 2 * Math.acos(Math.min(1, Math.abs(q.w)));

describe('BodySolver: elbow hinge', () => {
  it('never bends backwards: a hyperextended reading folds the right way, not inside out', () => {
    // Forearm angled backwards (away from the camera) from an arm out to the side.
    const p = pose({
      11: [0.2, -0.5, 0], 12: [-0.2, -0.5, 0], 13: [0.45, -0.5, 0], 14: [-0.45, -0.5, 0],
      15: [0.6, -0.5, 0.2], 16: [-0.7, -0.5, 0], 23: [0.1, 0, 0], 24: [-0.1, 0, 0],
    });
    const sol = new BodySolver(rest, { mirror: false, hands: false }).solve({ poseWorld: p }, [['spine', 1]]);
    const lower = sol.bones.get('leftLowerArm')!;
    // The local rotation is a pure hinge about the elbow axis (up for this rest pose), with a positive bend.
    const axis = new Vector3(lower.x, lower.y, lower.z).normalize();
    expect(Math.abs(axis.y)).toBeGreaterThan(0.99);
    expect(angleOf(lower)).toBeLessThanOrEqual(JOINT_LIMITS.elbow + 1e-6);
    // The forearm still heads back toward the wrist, as far as the upper arm's twist limit allows.
    const fore = dirOf(sol.bones.get('leftUpperArm')!.clone().multiply(lower), rest.leftLowerArm!);
    expect(fore.z).toBeLessThan(-0.3);
  });

  it('keeps the upper-arm twist when the arm straightens (no flip through straight)', () => {
    const s = new BodySolver(rest, { mirror: false, hands: false, depthFromLengths: false });
    const arm = (bend: number) =>
      pose({
        11: [0.2, -0.5, 0], 12: [-0.2, -0.5, 0], 13: [0.45, -0.5, 0], 14: [-0.45, -0.5, 0],
        // Forearm bending up (toward -y), then straight.
        15: [0.45 + 0.25 * Math.cos(bend), -0.5 - 0.25 * Math.sin(bend), 0], 16: [-0.7, -0.5, 0],
        23: [0.1, 0, 0], 24: [-0.1, 0, 0],
      });
    const twistOf = (q: Quaternion) => {
      const tw = twistAbout(q, rest.leftUpperArm!);
      return 2 * Math.atan2(tw.x, tw.w);
    };
    let bent = s.solve({ poseWorld: arm(1.2), t: 0 }, [['spine', 1]]);
    for (let t = 1 / 30; t < 0.5; t += 1 / 30) bent = s.solve({ poseWorld: arm(1.2), t }, [['spine', 1]]);
    const t0 = twistOf(bent.bones.get('leftUpperArm')!);
    expect(Math.abs(t0)).toBeGreaterThan(1.2);
    // Nearly straight, with the bend plane flipped by noise: twist must not jump.
    const straight = s.solve({ poseWorld: arm(-0.02), t: 0.533 }, [['spine', 1]]);
    expect(Math.abs(twistOf(straight.bones.get('leftUpperArm')!) - t0)).toBeLessThan(0.2);
  });
});

describe('BodySolver: depth from bone lengths', () => {
  it('segmentDepth fills in what the projection is missing, signed by the hint', () => {
    expect(segmentDepth(0.3, 0.05, 0.3)).toBeCloseTo(0);
    expect(segmentDepth(0.18, 0.2, 0.3)).toBeCloseTo(0.24);
    expect(segmentDepth(0.18, -0.2, 0.3)).toBeCloseTo(-0.24);
    // An ambiguous sign fades the depth instead of flipping it.
    expect(Math.abs(segmentDepth(0.18, 0.01, 0.3))).toBeLessThan(0.03);
  });

  it('BoneLength is never shorter than the projections it has seen', () => {
    const b = new BoneLength(10);
    for (let i = 0; i < 10; i++) b.add(0.2, i === 3 ? 0.27 : 0.15);
    expect(b.value).toBeGreaterThanOrEqual(0.27 - 1e-9);
  });

  it('a raised arm with depth noise comes out level when the image says so', () => {
    // The image shows the left arm straight out at shoulder height; MediaPipe's z
    // pushes the forearm 0.2 m toward the camera.
    const world = pose({
      11: [0.2, -0.5, 0], 12: [-0.2, -0.5, 0], 13: [0.45, -0.5, 0], 14: [-0.45, -0.5, 0],
      15: [0.6, -0.5, -0.2], 16: [-0.7, -0.5, 0], 23: [0.1, 0, 0], 24: [-0.1, 0, 0],
    });
    const img = imageOf(
      pose({
        11: [0.2, -0.5, 0], 12: [-0.2, -0.5, 0], 13: [0.45, -0.5, 0], 14: [-0.45, -0.5, 0],
        15: [0.7, -0.5, 0], 16: [-0.7, -0.5, 0], 23: [0.1, 0, 0], 24: [-0.1, 0, 0],
      }),
    );
    const s = new BodySolver(rest, { mirror: false, hands: false });
    // Feed the clean straight arm once so the forearm length is known.
    const straight = world.map((l, i) => (i === 15 ? { ...l, x: 0.7, z: 0 } : l));
    for (let t = 0; t < 0.5; t += 1 / 30) s.solve({ poseWorld: straight, poseImage: img, aspect: 4 / 3, t }, [['spine', 1]]);
    const sol = s.solve({ poseWorld: world, poseImage: img, aspect: 4 / 3, t: 0.5 }, [['spine', 1]]);
    const fore = dirOf(sol.bones.get('leftUpperArm')!.clone().multiply(sol.bones.get('leftLowerArm')!), rest.leftLowerArm!);
    expect(fore.x).toBeGreaterThan(0.97);
    // Without the depth fix the same input points the forearm ~35 degrees at the camera.
    const raw = new BodySolver(rest, { mirror: false, hands: false, depthFromLengths: false }).solve({ poseWorld: world }, [['spine', 1]]);
    const foreRaw = dirOf(raw.bones.get('leftUpperArm')!.clone().multiply(raw.bones.get('leftLowerArm')!), rest.leftLowerArm!);
    expect(foreRaw.x).toBeLessThan(0.85);
  });
});

describe('BodySolver: occlusion and false wrists', () => {
  const down = pose({
    11: [0.2, -0.5, 0], 12: [-0.2, -0.5, 0], 13: [0.22, -0.2, 0], 14: [-0.22, -0.2, 0],
    15: [0.23, 0.05, 0], 16: [-0.23, 0.05, 0], 23: [0.1, 0, 0], 24: [-0.1, 0, 0],
  });

  it('an arm leaving the frame fades to idle instead of snapping', () => {
    const s = new BodySolver(rest, { mirror: false, hands: false });
    let t = 0;
    for (; t < 1; t += 1 / 30) s.solve({ poseWorld: down, t }, [['spine', 1]]);
    const gone = down.map((l, i) => ([13, 15, 17, 19].includes(i) ? { ...l, visibility: 0.05 } : l));
    const weights: number[] = [];
    for (let k = 0; k < 30; k++, t += 1 / 30) weights.push(s.solve({ poseWorld: gone, t }, [['spine', 1]]).armWeight.left);
    // Holds briefly (hysteresis), then ramps down; never jumps by more than 4/s * dt.
    expect(weights[0]).toBe(1);
    expect(weights.at(-1)).toBe(0);
    for (let k = 1; k < weights.length; k++) expect(weights[k - 1] - weights[k]).toBeLessThanOrEqual(4 / 30 + 1e-9);
  });

  it('a one-frame visibility blip does not switch an arm on', () => {
    const s = new BodySolver(rest, { mirror: false, hands: false });
    const hidden = down.map((l, i) => ([13, 15].includes(i) ? { ...l, visibility: 0.1 } : l));
    let t = 0;
    for (; t < 0.5; t += 1 / 30) s.solve({ poseWorld: hidden, t }, [['spine', 1]]);
    const w = s.solve({ poseWorld: down, t }, [['spine', 1]]).armWeight.left;
    expect(w).toBe(0);
  });

  it('in hands mode, a wrist at the chin with no hand there is not followed', () => {
    // The user's right arm hangs out of view; MediaPipe puts its wrist at the chin.
    const world = pose({
      0: [0, -0.7, -0.1], 11: [0.2, -0.5, 0], 12: [-0.2, -0.5, 0], 13: [0.22, -0.2, 0], 14: [-0.25, -0.25, 0],
      15: [0.23, 0.05, 0], 16: [-0.05, -0.6, -0.1], 23: [0.1, 0, 0], 24: [-0.1, 0, 0],
    });
    const img = imageOf(world);
    const s = new BodySolver(rest, { mirror: false, hands: true });
    let sol;
    for (let t = 0; t < 1; t += 1 / 30) sol = s.solve({ poseWorld: world, poseImage: img, aspect: 4 / 3, t, hands: [] }, [['spine', 1]]);
    // The upper arm is followed; the forearm is not.
    expect(sol!.armWeight.right).toBe(1);
    const lower = sol!.bones.get('rightLowerArm')!;
    expect(angleOf(lower)).toBeLessThan(0.35);
  });
});

describe('BodySolver: fingers', () => {
  const handRest: RestDirs = { ...rest };
  for (const f of ['Index', 'Middle', 'Ring', 'Little']) {
    for (const b of ['Proximal', 'Intermediate', 'Distal']) handRest[`left${f}${b}`] = new Vector3(1, 0, 0);
  }
  for (const b of ['Metacarpal', 'Proximal', 'Distal']) handRest[`leftThumb${b}`] = new Vector3(1, 0, 1).normalize();

  /** Left hand, T-pose, palm down; index finger bent `pip` at its middle joint, sideways noise `side` at the tip. */
  function leftHand(pip: number, side = 0, backwards = false) {
    // MediaPipe camera frame (x right, y down, z away). Unmirrored: avatar +X = image +x, avatar up = -y.
    const w: Array<[number, number, number]> = Array.from({ length: 21 }, () => [0.7, -0.5, 0]);
    const knuckle = (z: number) => [0.78, -0.5, z] as [number, number, number];
    const fingers = [[5, -0.03], [9, -0.01], [13, 0.01], [17, 0.03]] as const;
    for (const [b, z] of fingers) {
      w[b] = knuckle(z);
      w[b + 1] = [0.82, -0.5, z];
      w[b + 2] = [0.845, -0.5, z];
      w[b + 3] = [0.865, -0.5, z];
    }
    // Index: bend at the middle joint toward the palm (+y in the camera frame = down), or backwards.
    const sgn = backwards ? -1 : 1;
    w[7] = [0.82 + 0.025 * Math.cos(pip), -0.5 + sgn * 0.025 * Math.sin(pip), -0.03];
    w[8] = [w[7][0] + 0.02 * Math.cos(pip), w[7][1] + sgn * 0.02 * Math.sin(pip), -0.03 + side];
    w[1] = [0.72, -0.5, -0.02];
    w[2] = [0.75, -0.5, -0.04];
    w[3] = [0.77, -0.5, -0.055];
    w[4] = [0.79, -0.5, -0.065];
    return w.map(([x, y, z]) => ({ x, y, z, visibility: 1 }));
  }

  const solveHand = (pip: number, side = 0, backwards = false) => {
    const s = new BodySolver(handRest, { mirror: false, hands: true });
    const lm = leftHand(pip, side, backwards);
    return s.solve(
      { poseWorld: T_POSE, hands: [{ landmarks: lm, worldLandmarks: lm, handedness: 'Right', score: 0.9, userSide: 'left' }] },
      [['spine', 1]],
    );
  };

  it('a bent finger bends at its hinge, toward the palm', () => {
    const sol = solveHand(1.0);
    const q = sol.bones.get('leftIndexIntermediate')!;
    expect(angleOf(q)).toBeCloseTo(1.0, 1);
    // Palm-down left hand: flexing turns +X toward -Y, about -Z.
    expect(new Vector3(1, 0, 0).applyQuaternion(q).y).toBeLessThan(-0.7);
  });

  it('clamps a backwards bend to the joint limit', () => {
    const sol = solveHand(0.8, 0, true);
    expect(angleOf(sol.bones.get('leftIndexIntermediate')!)).toBeLessThanOrEqual(-JOINT_LIMITS.pip[0] + 1e-6);
  });

  it('sideways noise at a fingertip does not twist or splay the end joint', () => {
    const sol = solveHand(0.6, 0.015);
    const q = sol.bones.get('leftIndexDistal')!;
    const axis = new Vector3(q.x, q.y, q.z).normalize();
    // A pure hinge about the flex axis (Z for this rest pose).
    expect(Math.abs(axis.z)).toBeGreaterThan(0.99);
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
