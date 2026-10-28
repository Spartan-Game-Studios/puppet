import { describe, expect, it } from 'vitest';
import { faceCovered, hull } from '../src/tracking/faceOcclusion';
import type { Landmark } from '../src/core/bodySolver';

/** A flat open hand: wrist at (x, y), fingers up, `w` wide and `h` tall (normalized). */
function hand(x: number, y: number, w = 0.12, h = 0.2): Landmark[] {
  return Array.from({ length: 21 }, (_, i) => {
    if (i === 0) return { x, y, z: 0 };
    const f = Math.floor((i - 1) / 4);
    const j = (i - 1) % 4;
    return { x: x + (f - 2) * (w / 4), y: y - h * (0.35 + 0.17 * j), z: 0 };
  });
}
function pose(nose: [number, number], mouthL: [number, number], mouthR: [number, number]): Landmark[] {
  const out: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 1 }));
  out[0] = { x: nose[0], y: nose[1], z: 0, visibility: 1 };
  out[9] = { x: mouthL[0], y: mouthL[1], z: 0, visibility: 1 };
  out[10] = { x: mouthR[0], y: mouthR[1], z: 0, visibility: 1 };
  return out;
}
const face = pose([0.5, 0.3], [0.52, 0.36], [0.48, 0.36]);

describe('faceCovered', () => {
  it('a hand over the mouth and nose covers the face', () => {
    expect(faceCovered([hand(0.5, 0.48)], face)).toBe(true);
  });
  it('a hand on the cheek, beside the head or low does not', () => {
    expect(faceCovered([hand(0.62, 0.45, 0.08)], face)).toBe(false);
    expect(faceCovered([hand(0.8, 0.4)], face)).toBe(false);
    expect(faceCovered([hand(0.5, 0.9)], face)).toBe(false);
  });
  it('needs a pose with the face points', () => {
    expect(faceCovered([hand(0.5, 0.48)], undefined)).toBe(false);
  });
  it('hull is convex and keeps the extreme points', () => {
    const h = hull([[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0.5]]);
    expect(h).toHaveLength(4);
  });
});
