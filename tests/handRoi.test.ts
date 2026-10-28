import { describe, expect, it } from 'vitest';
import { MIN_ROI, roiFromLandmarks, roiFromPose, sameHand, stabilizeRoi, wristDistance } from '../src/tracking/handRoi';
import type { Landmark } from '../src/core/bodySolver';

const W = 640;
const H = 480;

/** A hand (normalized coords) with its wrist at (x, y), fingers pointing up, `size` px tall. */
function hand(x: number, y: number, size = 100): Landmark[] {
  return Array.from({ length: 21 }, (_, i) => {
    const f = Math.floor((i - 1) / 4);
    const j = (i - 1) % 4;
    if (i === 0) return { x, y, z: 0 };
    return { x: x + ((f - 2) * size * 0.15) / W, y: y - ((0.4 + 0.15 * j) * size) / H, z: 0 };
  });
}

/** Pose image landmarks: shoulders, elbows, wrists, hand points (normalized). */
function pose(points: Record<number, [number, number, number?]>): Landmark[] {
  const out: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0 }));
  for (const [i, [x, y, v]] of Object.entries(points)) out[Number(i)] = { x, y, z: 0, visibility: v ?? 1 };
  return out;
}

const P = pose({
  11: [0.65, 0.5], 12: [0.35, 0.5],
  13: [0.75, 0.75], 14: [0.25, 0.75],
  15: [0.72, 0.45], 16: [0.28, 0.45],
  17: [0.73, 0.4], 18: [0.27, 0.4], 19: [0.71, 0.4], 20: [0.29, 0.4],
});

describe('hand crops', () => {
  it('a crop from landmarks contains the whole hand with margin', () => {
    const h = hand(0.5, 0.6);
    const r = roiFromLandmarks(h, W, H, 2);
    for (const l of h) {
      expect(l.x * W).toBeGreaterThan(r.x);
      expect(l.x * W).toBeLessThan(r.x + r.size);
      expect(l.y * H).toBeGreaterThan(r.y);
      expect(l.y * H).toBeLessThan(r.y + r.size);
    }
    expect(r.size).toBeGreaterThanOrEqual(MIN_ROI);
  });

  it('a crop from the pose covers the wrist and is at least as big as the forearm', () => {
    const r = roiFromPose(P, 'left', W, H)!;
    const wx = 0.72 * W;
    const wy = 0.45 * H;
    expect(wx).toBeGreaterThan(r.x);
    expect(wx).toBeLessThan(r.x + r.size);
    expect(wy).toBeGreaterThan(r.y);
    expect(wy).toBeLessThan(r.y + r.size);
    const fore = Math.hypot((0.75 - 0.72) * W, (0.75 - 0.45) * H);
    expect(r.size).toBeGreaterThanOrEqual(fore);
    // The wide retry is bigger.
    expect(roiFromPose(P, 'left', W, H, 1.5)!.size).toBeCloseTo(1.5 * r.size);
  });

  it('no crop for an invisible wrist or one far outside the image', () => {
    expect(roiFromPose(P.map((l, i) => (i === 15 ? { ...l, visibility: 0.05 } : l)), 'left', W, H)).toBeNull();
    expect(roiFromPose(P.map((l, i) => (i === 15 ? { ...l, x: 2.5 } : l)), 'left', W, H)).toBeNull();
  });

  it('a crop holds still for small moves and follows big ones', () => {
    const a = { x: 100, y: 100, size: 200 };
    expect(stabilizeRoi(a, { x: 110, y: 105, size: 205 })).toBe(a);
    const far = { x: 160, y: 100, size: 200 };
    expect(stabilizeRoi(a, far)).toBe(far);
    const bigger = { x: 100, y: 100, size: 260 };
    expect(stabilizeRoi(a, bigger)).toBe(bigger);
  });
});

describe('hand-to-side checks', () => {
  it('wristDistance prefers the side whose pose wrist the hand is on', () => {
    const h = hand(0.72, 0.46);
    expect(wristDistance(h, P, 'left', W, H)).toBeLessThan(0.5);
    expect(wristDistance(h, P, 'right', W, H)).toBeGreaterThan(3);
    expect(wristDistance(h, undefined, 'left', W, H)).toBe(Infinity);
  });

  it('sameHand spots one hand found by both crops', () => {
    const a = hand(0.5, 0.5);
    const b = a.map((l) => ({ ...l, x: l.x + 3 / W }));
    expect(sameHand(a, b, W, H)).toBe(true);
    expect(sameHand(a, hand(0.6, 0.5), W, H)).toBe(false);
  });
});
