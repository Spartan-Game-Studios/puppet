import { describe, expect, it } from 'vitest';
import {
  assignSides,
  dedupeKeep,
  isOtherHand,
  LabelTrust,
  labelSide,
  labelVote,
  sameHand,
  type AssignContext,
  type HandCandidate,
} from '../src/tracking/handAssign';
import type { Landmark } from '../src/core/bodySolver';

const W = 640;
const H = 480;

/** A hand (normalized coords) with its wrist at (x, y), fingers up, `size` px from wrist to knuckles. */
function lms(x: number, y: number, size = 60): Landmark[] {
  return Array.from({ length: 21 }, (_, i) => {
    if (i === 0) return { x, y, z: 0 };
    const f = Math.floor((i - 1) / 4);
    const j = (i - 1) % 4;
    return { x: x + ((f - 2) * size * 0.25) / W, y: y - ((1 + 0.3 * j) * size) / H, z: 0 };
  });
}
const cand = (x: number, y: number, handedness = 'Unknown', score = 0.5): HandCandidate => ({ landmarks: lms(x, y), handedness, score });

/** Pose image landmarks: nose and wrists (user left = 15, right = 16), normalized; [x, y, visibility]. */
function pose(left: [number, number, number] | null, right: [number, number, number] | null, nose: [number, number] = [0.5, 0.3]): Landmark[] {
  const out: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0 }));
  out[0] = { x: nose[0], y: nose[1], z: 0, visibility: 1 };
  if (left) out[15] = { x: left[0], y: left[1], z: 0, visibility: left[2] };
  if (right) out[16] = { x: right[0], y: right[1], z: 0, visibility: right[2] };
  return out;
}
const ctx = (p: Landmark[] | undefined, extra: Partial<AssignContext> = {}): AssignContext => ({ pose: p, width: W, height: H, ...extra });

describe('handedness label', () => {
  it("names the hand's own side on an unmirrored frame (measured, not the documented selfie convention)", () => {
    expect(labelSide('Left')).toBe('left');
    expect(labelSide('Right')).toBe('right');
    expect(labelSide('Unknown')).toBeNull();
  });
  it('counts by confidence and trust, and flips when trust is negative', () => {
    expect(labelVote(cand(0, 0, 'Left', 0.95), 1)).toEqual({ side: 'left', weight: 1 });
    expect(labelVote(cand(0, 0, 'Left', 0.5), 1).weight).toBe(0);
    expect(labelVote(cand(0, 0, 'Left', 0.95), -0.5)).toEqual({ side: 'right', weight: 0.5 });
  });
});

describe('assignSides', () => {
  it('gives each hand the side of the pose wrist it sits on', () => {
    // User's left hand on the image right.
    const p = pose([0.7, 0.6, 0.95], [0.3, 0.6, 0.95]);
    const got = assignSides([cand(0.3, 0.6), cand(0.7, 0.6)], ['left', 'right'], ctx(p));
    expect(got).toEqual({ left: 1, right: 0 });
  });

  it('without a pose wrist (lost low in the frame, at the face), uses the label and the side of the nose', () => {
    const p = pose([0.7, 0.6, 0.05], [0.3, 0.6, 0.05]);
    expect(assignSides([cand(0.4, 0.5, 'Right', 0.95)], ['left', 'right'], ctx(p))).toEqual({ right: 0 });
    // No label either: image left of the nose is the user's right.
    expect(assignSides([cand(0.4, 0.5)], ['left', 'right'], ctx(p))).toEqual({ right: 0 });
    expect(assignSides([cand(0.6, 0.5)], ['left', 'right'], ctx(undefined))).toEqual({ left: 0 });
  });

  it("a misplaced pose wrist (at the chin, 0.8 visibility) doesn't override a confident label and position", () => {
    // The user's right hand is at the cheek (image left); the pose put the LEFT wrist there, the right one is lost.
    const p = pose([0.42, 0.5, 0.8], null);
    expect(assignSides([cand(0.4, 0.52, 'Right', 0.97)], ['left', 'right'], ctx(p))).toEqual({ right: 0 });
  });

  it('a believable pose wrist outside the image means that hand is out of view', () => {
    // Fist under the chin labelled (wrongly) 'Left'; the pose sees the left wrist below the frame.
    const p = pose([0.75, 1.3, 0.63], [0.46, 0.65, 0.73]);
    expect(assignSides([cand(0.47, 0.66, 'Left', 0.96)], ['left', 'right'], ctx(p))).toEqual({ right: 0 });
  });

  it('keeps a hand on the side that was tracking it there (continuity)', () => {
    const prev = { right: lms(0.5, 0.5) };
    expect(assignSides([cand(0.51, 0.5)], ['left', 'right'], ctx(undefined, { prev }))).toEqual({ right: 0 });
  });

  it('only fills free sides, and leaves a hand that fits nothing unassigned', () => {
    const p = pose([0.7, 0.6, 0.95], [0.3, 0.6, 0.95]);
    expect(assignSides([cand(0.7, 0.6)], ['right'], ctx(p, { labelTrust: 1 }), 1.0)).toEqual({});
    expect(assignSides([cand(0.3, 0.6)], ['right'], ctx(p))).toEqual({ right: 0 });
  });
});

describe('isOtherHand', () => {
  const p = pose([0.7, 0.6, 0.95], [0.3, 0.6, 0.95]);
  it('needs the pose AND the label to say it: a misplaced wrist alone keeps the hand', () => {
    // Found in the left crop, on the right pose wrist.
    expect(isOtherHand(cand(0.3, 0.6, 'Right', 0.95), 'left', ctx(p), null)).toBe(true);
    expect(isOtherHand(cand(0.3, 0.6, 'Left', 0.95), 'left', ctx(p), null)).toBe(false);
    expect(isOtherHand(cand(0.3, 0.6, 'Unknown', 0.5), 'left', ctx(p), null)).toBe(false);
  });
  it('is the other hand when the other side already holds the same detection', () => {
    expect(isOtherHand(cand(0.5, 0.5), 'left', ctx(p), lms(0.5, 0.5))).toBe(true);
  });
});

describe('sameHand / dedupeKeep', () => {
  it('two hands a hand-width apart are two hands', () => {
    expect(sameHand(lms(0.5, 0.5), lms(0.5 + 60 / W, 0.5), W, H)).toBe(false);
    expect(sameHand(lms(0.5, 0.5), lms(0.5 + 5 / W, 0.5), W, H)).toBe(true);
  });
  it('the side the hand fits better keeps it', () => {
    const p = pose([0.7, 0.6, 0.95], [0.3, 0.6, 0.95]);
    expect(dedupeKeep(cand(0.32, 0.6), ctx(p))).toBe('right');
    expect(dedupeKeep(cand(0.5, 0.6, 'Left', 0.97), ctx(pose(null, null)))).toBe('left');
  });
});

describe('LabelTrust', () => {
  it('learns that labels are inverted from hands the pose places clearly, and ignores crossed arms', () => {
    const t = new LabelTrust(0.1);
    const p = pose([0.7, 0.6, 0.95], [0.3, 0.6, 0.95]);
    // A left hand on its own wrist, on its own side of the nose, labelled 'Right': inverted.
    for (let i = 0; i < 40; i++) t.observe(cand(0.7, 0.6, 'Right', 0.95), 'left', p, W, H);
    expect(t.value).toBeLessThan(-0.5);
    // Crossed (the left hand on the image left, where the pose put the left wrist): no evidence.
    const crossed = pose([0.3, 0.6, 0.95], [0.7, 0.6, 0.95]);
    const before = t.value;
    t.observe(cand(0.3, 0.6, 'Left', 0.95), 'left', crossed, W, H);
    expect(t.value).toBe(before);
  });
});
