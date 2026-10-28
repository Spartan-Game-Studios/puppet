import { describe, expect, it } from 'vitest';
import {
  ARKIT_NAMES,
  applyCalibration,
  applyGainCurve,
  buildPerfectSyncMap,
  derivePresets,
  gazeFromBlendshapes,
  isPerfectSync,
  mirrorBlendshapes,
  mirrorName,
  vmcSafe,
} from './helpers';

describe('ARKit names', () => {
  it('has the 52 shapes', () => {
    expect(ARKIT_NAMES.length).toBe(52);
    expect(new Set(ARKIT_NAMES).size).toBe(52);
  });
});

describe('perfect sync mapping', () => {
  it('maps exact names 1:1', () => {
    const m = buildPerfectSyncMap([...ARKIT_NAMES, 'aa', 'blink']);
    expect(m.size).toBe(52);
    expect(m.get('jawOpen')).toBe('jawOpen');
    expect(isPerfectSync(m)).toBe(true);
  });
  it('ignores case and punctuation (VRoid / VRM 0.x clip names)', () => {
    const m = buildPerfectSyncMap(['EyeBlinkLeft', 'JAW_OPEN', 'mouth-smile-left']);
    expect(m.get('eyeBlinkLeft')).toBe('EyeBlinkLeft');
    expect(m.get('jawOpen')).toBe('JAW_OPEN');
    expect(m.get('mouthSmileLeft')).toBe('mouth-smile-left');
    expect(isPerfectSync(m)).toBe(false);
  });
  it('treats preset-only models as not perfect sync', () => {
    const m = buildPerfectSyncMap(['aa', 'ih', 'ou', 'ee', 'oh', 'blink', 'happy']);
    expect(m.size).toBe(0);
    expect(isPerfectSync(m)).toBe(false);
  });
});

describe('mirroring', () => {
  it('swaps Left/Right', () => {
    expect(mirrorName('eyeBlinkLeft')).toBe('eyeBlinkRight');
    expect(mirrorName('mouthSmileRight')).toBe('mouthSmileLeft');
    expect(mirrorName('jawLeft')).toBe('jawRight');
    expect(mirrorName('jawOpen')).toBe('jawOpen');
    expect(mirrorName('browInnerUp')).toBe('browInnerUp');
  });
  it('mirrors a whole set and is an involution', () => {
    const bs = { eyeBlinkLeft: 1, eyeBlinkRight: 0, jawOpen: 0.4 };
    const m = mirrorBlendshapes(bs);
    expect(m).toEqual({ eyeBlinkRight: 1, eyeBlinkLeft: 0, jawOpen: 0.4 });
    expect(mirrorBlendshapes(m)).toEqual(bs);
  });
});

describe('calibration and shaping', () => {
  it('maps the neutral baseline to 0 and keeps 1 at 1', () => {
    expect(applyCalibration(0.2, 0.2)).toBe(0);
    expect(applyCalibration(1, 0.2)).toBe(1);
    expect(applyCalibration(0.6, 0.2)).toBeCloseTo(0.5);
    expect(applyCalibration(0.1, 0.2)).toBe(0);
    expect(applyCalibration(0.5)).toBe(0.5);
  });
  it('gain and curve lift and clamp', () => {
    expect(applyGainCurve(0.5)).toBe(0.5);
    expect(applyGainCurve(0.5, { gain: 1.5, curve: 1 })).toBeCloseTo(0.75);
    expect(applyGainCurve(0.25, { gain: 1, curve: 0.5 })).toBeCloseTo(0.5);
    expect(applyGainCurve(0.9, { gain: 2, curve: 1 })).toBe(1);
    expect(applyGainCurve(-0.2, { gain: 2, curve: 1 })).toBe(0);
    expect(applyGainCurve(NaN, { gain: 2, curve: 1 })).toBe(0);
  });
});

describe('preset fallback', () => {
  it('a full blink drives blink, not the sides', () => {
    const p = derivePresets({ eyeBlinkLeft: 1, eyeBlinkRight: 1 });
    expect(p.blink).toBe(1);
    expect(p.blinkLeft).toBe(0);
    expect(p.blinkRight).toBe(0);
  });
  it('a wink drives one side only', () => {
    const p = derivePresets({ eyeBlinkLeft: 0.9, eyeBlinkRight: 0.05 });
    expect(p.blink).toBeCloseTo(0.05);
    expect(p.blinkLeft).toBeCloseTo(0.85);
    expect(p.blinkRight).toBe(0);
  });
  it('open jaw reads as aa, pucker as ou, funnel as oh', () => {
    expect(derivePresets({ jawOpen: 0.8 }).aa).toBeGreaterThan(0.5);
    const ou = derivePresets({ mouthPucker: 0.9 });
    expect(ou.ou).toBeGreaterThan(ou.aa);
    const oh = derivePresets({ mouthFunnel: 0.8, jawOpen: 0.3 });
    expect(oh.oh).toBeGreaterThan(oh.aa);
  });
  it('wide closed mouth reads as ee', () => {
    const p = derivePresets({ mouthStretchLeft: 0.6, mouthStretchRight: 0.6 });
    expect(p.ee).toBeGreaterThan(0.5);
  });
  it('visemes never sum above 1', () => {
    const p = derivePresets({ jawOpen: 1, mouthPucker: 1, mouthFunnel: 1, mouthStretchLeft: 1, mouthStretchRight: 1, mouthSmileLeft: 1, mouthSmileRight: 1 });
    expect(p.aa + p.ih + p.ou + p.ee + p.oh).toBeLessThanOrEqual(1.0000001);
  });
  it('emotions respect the deadzone and the toggle', () => {
    expect(derivePresets({ mouthSmileLeft: 0.2, mouthSmileRight: 0.2 }).happy).toBe(0);
    expect(derivePresets({ mouthSmileLeft: 0.9, mouthSmileRight: 0.9 }).happy).toBeGreaterThan(0.8);
    expect(derivePresets({ browDownLeft: 0.9, browDownRight: 0.9 }).angry).toBeGreaterThan(0.5);
    const off = derivePresets({ mouthSmileLeft: 1, mouthSmileRight: 1 }, { emotions: false, emotionDeadzone: 0 });
    expect(off.happy).toBe(0);
  });
  it('outputs stay in 0..1', () => {
    const all: Record<string, number> = {};
    for (const n of ARKIT_NAMES) all[n] = 1;
    for (const v of Object.values(derivePresets(all))) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('gaze', () => {
  it('looking to the subject’s left gives positive yaw', () => {
    expect(gazeFromBlendshapes({ eyeLookOutLeft: 1, eyeLookInRight: 1 }).yaw).toBeCloseTo(30);
    expect(gazeFromBlendshapes({ eyeLookInLeft: 1, eyeLookOutRight: 1 }).yaw).toBeCloseTo(-30);
  });
  it('up is positive pitch', () => {
    expect(gazeFromBlendshapes({ eyeLookUpLeft: 1, eyeLookUpRight: 1 }).pitch).toBeGreaterThan(0);
    expect(gazeFromBlendshapes({ eyeLookDownLeft: 1, eyeLookDownRight: 1 }).pitch).toBeLessThan(0);
  });
  it('mirroring flips gaze yaw', () => {
    const bs = { eyeLookOutLeft: 0.6, eyeLookInRight: 0.6 };
    expect(gazeFromBlendshapes(mirrorBlendshapes(bs)).yaw).toBeCloseTo(-gazeFromBlendshapes(bs).yaw);
  });
});

describe('VMC names', () => {
  it('presets go out as VRM 0.x clip names, ARKit names pass through', () => {
    expect(vmcSafe('blink')).toBe('Blink');
    expect(vmcSafe('blinkLeft')).toBe('Blink_L');
    expect(vmcSafe('aa')).toBe('A');
    expect(vmcSafe('happy')).toBe('Joy');
    expect(vmcSafe('relaxed')).toBe('Fun');
    expect(vmcSafe('jawOpen')).toBe('jawOpen');
  });
});
