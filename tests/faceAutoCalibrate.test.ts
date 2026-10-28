import { describe, expect, it } from 'vitest';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { FaceProcessor } from '../src/tracking/faceProcessor';
import type { FaceResult } from '../src/tracking/protocol';

/** A face result: head pitched down `pitch` radians, with a resting pucker. */
function face(pitch: number, extra: Record<string, number> = {}): FaceResult {
  const m = new Matrix4().compose(new Vector3(0, 0, -50), new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), pitch), new Vector3(1, 1, 1));
  return { blendshapes: { mouthPucker: 0.9, browDownLeft: 0.35, browDownRight: 0.35, ...extra }, matrix: Array.from(m.elements) };
}

describe('face auto-calibration', () => {
  it('takes the first steady second as neutral when uncalibrated', () => {
    const f = new FaceProcessor();
    f.mirror = false;
    let st;
    for (let t = 0; t < 1.5; t += 1 / 30) st = f.process(face(0.25), t);
    expect(f.autoCalibrated).toBe(true);
    // Resting offsets are gone: head level, pucker and brows near zero.
    for (let t = 1.5; t < 3; t += 1 / 30) st = f.process(face(0.25), t);
    expect(st!.head.angleTo(new Quaternion())).toBeLessThan(0.02);
    expect(st!.values.mouthPucker).toBeLessThan(0.05);
    expect(st!.values.browDownLeft).toBeLessThan(0.05);
  });

  it('waits while the face is moving or the mouth is open', () => {
    const f = new FaceProcessor();
    for (let t = 0; t < 1.5; t += 1 / 30) f.process(face(0.3 * Math.sin(6 * t)), t);
    expect(f.autoCalibrated).toBe(false);
    for (let t = 1.5; t < 3; t += 1 / 30) f.process(face(0, { jawOpen: 0.6 }), t);
    expect(f.autoCalibrated).toBe(false);
  });

  it('a manual calibration replaces it and is never overwritten', () => {
    const f = new FaceProcessor();
    for (let t = 0; t < 1.5; t += 1 / 30) f.process(face(0.25), t);
    f.captureNeutral();
    expect(f.autoCalibrated).toBe(false);
    const cal = f.calibration;
    for (let t = 1.5; t < 3; t += 1 / 30) f.process(face(0.1), t);
    expect(f.calibration).toBe(cal);
  });
});
