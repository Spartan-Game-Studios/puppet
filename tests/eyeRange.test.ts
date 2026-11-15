import { describe, expect, it } from 'vitest';
import { VRMLookAtRangeMap, type VRM } from '@pixiv/three-vrm';
import { prepareEyeRange, setEyeRange } from '../src/scene/eyeRange';
import { GAZE_MAX_PITCH, GAZE_MAX_YAW } from '../src/core/blendshapes';

class BoneApplier {
  static readonly type: string = 'bone';
  constructor(
    public rangeMapHorizontalInner: VRMLookAtRangeMap,
    public rangeMapHorizontalOuter: VRMLookAtRangeMap,
    public rangeMapVerticalDown: VRMLookAtRangeMap,
    public rangeMapVerticalUp: VRMLookAtRangeMap,
  ) {}
}
class ExpressionApplier extends BoneApplier {
  static readonly type: string = 'expression';
}

function fakeVrm(kind: 'bone' | 'expression', inner = 12, outer = 15, down = 10, up = 8): VRM {
  const A = kind === 'bone' ? BoneApplier : ExpressionApplier;
  const m = (s: number) => new VRMLookAtRangeMap(90, s);
  return { lookAt: { applier: new A(m(inner), m(outer), m(down), m(up)) } } as unknown as VRM;
}
const maps = (vrm: VRM) => vrm.lookAt!.applier as unknown as BoneApplier;

describe('eye range', () => {
  it("maps the tracked gaze range onto the model's own range", () => {
    const vrm = fakeVrm('bone');
    const lim = prepareEyeRange(vrm);
    expect(lim).toEqual({ kind: 'bone', h: 15, v: 10 });
    const a = maps(vrm);
    // A full glance (30 sideways, 25 up) now reaches the model's limit; before, a third of it.
    expect(a.rangeMapHorizontalOuter.map(GAZE_MAX_YAW)).toBeCloseTo(15);
    expect(a.rangeMapHorizontalInner.map(GAZE_MAX_YAW)).toBeCloseTo(12);
    expect(a.rangeMapVerticalDown.map(GAZE_MAX_PITCH)).toBeCloseTo(10);
    expect(a.rangeMapHorizontalOuter.map(15)).toBeCloseTo(7.5);
  });

  it("sets a limit per axis and keeps the model's proportions", () => {
    const vrm = fakeVrm('bone');
    prepareEyeRange(vrm);
    setEyeRange(vrm, { h: 30, v: 20 });
    const a = maps(vrm);
    expect(a.rangeMapHorizontalOuter.outputScale).toBeCloseTo(30);
    expect(a.rangeMapHorizontalInner.outputScale).toBeCloseTo(24); // 12/15 of 30
    expect(a.rangeMapVerticalDown.outputScale).toBeCloseTo(20);
    expect(a.rangeMapVerticalUp.outputScale).toBeCloseTo(16); // 8/10 of 20
    setEyeRange(vrm, { h: null, v: 5 }); // h back to the model's own
    expect(a.rangeMapHorizontalOuter.outputScale).toBeCloseTo(15);
    expect(a.rangeMapVerticalDown.outputScale).toBeCloseTo(5);
    setEyeRange(vrm, { h: null, v: null });
    expect([a.rangeMapHorizontalInner, a.rangeMapHorizontalOuter, a.rangeMapVerticalDown, a.rangeMapVerticalUp].map((r) => r.outputScale)).toEqual([12, 15, 10, 8]);
  });

  it('gives a model with no range its limit on every map', () => {
    const vrm = fakeVrm('bone', 0, 0, 0, 0);
    prepareEyeRange(vrm);
    setEyeRange(vrm, { h: 20, v: 15 });
    const a = maps(vrm);
    expect([a.rangeMapHorizontalInner, a.rangeMapHorizontalOuter, a.rangeMapVerticalDown, a.rangeMapVerticalUp].map((r) => r.outputScale)).toEqual([20, 20, 15, 15]);
  });

  it('leaves look-expression weights alone (degrees mean nothing there)', () => {
    const vrm = fakeVrm('expression', 1, 1, 1, 1);
    expect(prepareEyeRange(vrm).kind).toBe('expression');
    setEyeRange(vrm, { h: 30, v: 30 });
    expect(maps(vrm).rangeMapHorizontalOuter.outputScale).toBe(1);
    expect(maps(vrm).rangeMapHorizontalOuter.inputMaxValue).toBe(GAZE_MAX_YAW);
  });

  it('does nothing without look-at', () => {
    const vrm = { lookAt: null } as unknown as VRM;
    expect(prepareEyeRange(vrm)).toEqual({ kind: null, h: 0, v: 0 });
    expect(() => setEyeRange(vrm, { h: 10, v: 10 })).not.toThrow();
  });
});
