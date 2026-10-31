import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { buildPerfectSyncMap } from '../src/core/blendshapes';
import { DEFAULT_SOURCES, fromUnityRotation, mapBlends, regionOf, STALE_MS, VmcInput, vrmBoneName, type VmcInFrame } from '../src/vmc/vmcInput';
import { toUnity, unityBoneName } from '../src/vmc/vmcFrame';

const frame = (bones: VmcInFrame['bones'], blends: VmcInFrame['blends'] = {}): VmcInFrame => ({ seq: 1, bones, root: null, blends, t: 0, loaded: 1, tracking: 1 });
const avatar = (names: string[], bones = ['hips', 'spine', 'chest', 'head', 'neck', 'leftUpperLeg', 'leftLowerLeg', 'leftUpperArm', 'leftIndexProximal', 'leftThumbMetacarpal']) => ({
  expressionNames: names,
  perfectSync: buildPerfectSyncMap(names),
  hasBone: (b: string) => bones.includes(b),
});

describe('VMC input', () => {
  it('maps Unity bone names back, thumbs included (inverse of the output)', () => {
    for (const b of ['hips', 'leftUpperLeg', 'rightToes', 'upperChest', 'leftThumbMetacarpal', 'leftThumbProximal', 'rightThumbDistal', 'leftIndexIntermediate']) {
      expect(vrmBoneName(unityBoneName(b))).toBe(b);
    }
  });

  it('converts rotations back from Unity (round trip with the output)', () => {
    const q = new Quaternion().setFromAxisAngle(new Vector3(0.3, 0.8, -0.5).normalize(), 0.9);
    const t = toUnity(new Vector3(0.1, 1, 0), q);
    const back = fromUnityRotation(t);
    expect(back.angleTo(q)).toBeLessThan(1e-6);
  });

  it('sorts bones into regions', () => {
    expect(regionOf('leftUpperLeg')).toBe('legs');
    expect(regionOf('hips')).toBe('torso');
    expect(regionOf('neck')).toBe('head');
    expect(regionOf('rightHand')).toBe('arms');
    expect(regionOf('rightLittleDistal')).toBe('fingers');
    expect(regionOf('leftThumbMetacarpal')).toBe('fingers');
    expect(regionOf('leftEye')).toBeNull();
  });

  it('applies only the regions set to VMC, and only bones the avatar has', () => {
    const v = new VmcInput();
    v.set(frame({ Hips: [0, 1, 0, 0, 0, 0, 1], LeftUpperLeg: [0, 0, 0, 0.5, 0, 0, 0.866], LeftUpperArm: [0, 0, 0, 0, 0, 0, 1], Head: [0, 0, 0, 0, 0, 0, 1], RightFoot: [0, 0, 0, 0, 0, 0, 1] }), 0);
    const p = v.pose(DEFAULT_SOURCES, avatar([]), 10)!;
    expect([...p.bones.keys()].sort()).toEqual(['hips', 'leftUpperLeg']); // arms/head are webcam; no rightFoot on this avatar
    const all = v.pose({ face: 'vmc', head: 'vmc', torso: 'vmc', arms: 'vmc', fingers: 'vmc', legs: 'vmc' }, avatar([]), 10)!;
    expect([...all.bones.keys()].sort()).toEqual(['head', 'hips', 'leftUpperArm', 'leftUpperLeg']);
  });

  it('goes stale', () => {
    const v = new VmcInput();
    v.set(frame({ Hips: [0, 1, 0, 0, 0, 0, 1] }), 0);
    expect(v.pose(DEFAULT_SOURCES, avatar([]), STALE_MS - 1)).not.toBeNull();
    expect(v.pose(DEFAULT_SOURCES, avatar([]), STALE_MS + 1)).toBeNull();
  });

  it('maps blend names: ARKit, VRM 0.x clips and the model’s own', () => {
    const names = ['EyeBlinkLeft', 'jawOpen', 'aa', 'happy', 'Custom_Wink'];
    const m = mapBlends({ eyeBlinkLeft: 0.5, JawOpen: 2, A: 0.3, Joy: 1, custom_wink: 0.4, unknown: 1, eyeBlinkRight: 0.2 }, names, buildPerfectSyncMap(names));
    expect(Object.fromEntries(m)).toEqual({ EyeBlinkLeft: 0.5, jawOpen: 1, aa: 0.3, happy: 1, Custom_Wink: 0.4 });
  });

  it('drives the face only when the face region is VMC', () => {
    const v = new VmcInput();
    v.set(frame({}, { jawOpen: 0.7 }), 0);
    expect(v.pose(DEFAULT_SOURCES, avatar(['jawOpen']), 1)).toBeNull();
    const p = v.pose({ ...DEFAULT_SOURCES, face: 'vmc' }, avatar(['jawOpen']), 1)!;
    expect(p.expressions!.get('jawOpen')).toBe(0.7);
  });
});
