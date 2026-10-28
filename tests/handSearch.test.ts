import { beforeAll, describe, expect, it } from 'vitest';
import type { HandLandmarker } from '@mediapipe/tasks-vision';
import { HandCropTracker } from '../src/tracking/landmarkers';
import type { Landmark } from '../src/core/bodySolver';
import type { PoseResult } from '../src/tracking/protocol';

const W = 640;
const H = 480;

// HandCropTracker draws crops on an OffscreenCanvas; node has none.
beforeAll(() => {
  const ctx = new Proxy({}, { get: () => () => {}, set: () => true });
  (globalThis as unknown as { OffscreenCanvas: unknown }).OffscreenCanvas = class {
    getContext() {
      return ctx;
    }
  };
});

function lms(x: number, y: number, size = 60): Landmark[] {
  return Array.from({ length: 21 }, (_, i) => {
    if (i === 0) return { x, y, z: 0 };
    const f = Math.floor((i - 1) / 4);
    const j = (i - 1) % 4;
    return { x: x + ((f - 2) * size * 0.25) / W, y: y - ((1 + 0.3 * j) * size) / H, z: 0 };
  });
}

interface FakeHand {
  x: number;
  y: number;
  label: string;
  score?: number;
}

/** A HandLandmarker stand-in: returns the given hands (image-normalized) and counts calls. */
function fake(hands: () => FakeHand[]) {
  const f = {
    calls: 0,
    detectForVideo() {
      f.calls++;
      const hs = hands();
      return {
        landmarks: hs.map((h) => lms(h.x, h.y)),
        worldLandmarks: hs.map(() => lms(0, 0)),
        handedness: hs.map((h) => [{ categoryName: h.label, score: h.score ?? 0.95 }]),
      };
    },
  };
  return f;
}

function pose(left: [number, number, number] | null, right: [number, number, number] | null): PoseResult {
  const image: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0 }));
  image[0] = { x: 0.5, y: 0.3, z: 0, visibility: 1 };
  image[11] = { x: 0.65, y: 0.6, z: 0, visibility: 1 };
  image[12] = { x: 0.35, y: 0.6, z: 0, visibility: 1 };
  if (left) image[15] = { x: left[0], y: left[1], z: 0, visibility: left[2] };
  if (right) image[16] = { x: right[0], y: right[1], z: 0, visibility: right[2] };
  return { image, world: image };
}

const image = {} as ImageBitmap;
const empty = () => fake(() => []);

describe('HandCropTracker: full-frame search', () => {
  it('finds both hands where the pose has no usable wrists (low in the frame, at the face)', () => {
    const full = fake(() => [
      { x: 0.3, y: 0.85, label: 'Right' },
      { x: 0.7, y: 0.85, label: 'Left' },
    ]);
    const tr = new HandCropTracker({ left: empty() as unknown as HandLandmarker, right: empty() as unknown as HandLandmarker }, full as unknown as HandLandmarker);
    const r = tr.run(image, W, H, 1000, pose([0.7, 1.2, 0.1], [0.3, 1.2, 0.1]));
    expect(r.hands.map((h) => [h.userSide, h.landmarks[0].x])).toEqual([
      ['left', 0.7],
      ['right', 0.3],
    ]);
    expect(tr.state.left.status).toBe('found');
    expect(tr.state.right.status).toBe('found');
  });

  it('primary: when the full frame has both hands, the crops are not run', () => {
    const left = empty();
    const right = empty();
    const full = fake(() => [
      { x: 0.3, y: 0.6, label: 'Right' },
      { x: 0.7, y: 0.6, label: 'Left' },
    ]);
    const tr = new HandCropTracker({ left: left as unknown as HandLandmarker, right: right as unknown as HandLandmarker }, full as unknown as HandLandmarker);
    for (let t = 0; t < 5; t++) tr.run(image, W, H, 1000 + 33 * t, pose([0.7, 0.6, 0.95], [0.3, 0.6, 0.95]));
    expect(full.calls).toBe(5);
    expect(left.calls + right.calls).toBe(0);
    expect(tr.state.left.status).toBe('tracked');
  });

  it('a missing side falls back to its crop; nothing anywhere is a miss', () => {
    const left = empty();
    const right = empty();
    const full = fake(() => [{ x: 0.3, y: 0.6, label: 'Right' }]);
    const tr = new HandCropTracker({ left: left as unknown as HandLandmarker, right: right as unknown as HandLandmarker }, full as unknown as HandLandmarker);
    const r = tr.run(image, W, H, 1000, pose([0.7, 0.6, 0.95], [0.3, 0.6, 0.95]));
    expect(r.hands.map((h) => h.userSide)).toEqual(['right']);
    expect(left.calls).toBe(1);
    expect(tr.state.left.status).toBe('miss');
  });

  it('continuity holds hands on their sides on weak evidence, and gives way to strong evidence', () => {
    const run = (labels: [string, string], p: PoseResult | null) => {
      const full = fake(() => [
        { x: 0.3, y: 0.6, label: labels[0] },
        { x: 0.7, y: 0.6, label: labels[1] },
      ]);
      const tr = new HandCropTracker({ left: empty() as unknown as HandLandmarker, right: empty() as unknown as HandLandmarker }, full as unknown as HandLandmarker);
      // Tracked the "wrong" way round: the user's left hand on the image left (crossed arms).
      tr.state.left.last = lms(0.3, 0.6);
      tr.state.left.lastT = 990;
      tr.state.right.last = lms(0.7, 0.6);
      tr.state.right.lastT = 990;
      const r = tr.run(image, W, H, 1000, p);
      return r.hands.find((h) => h.userSide === 'left')!.landmarks[0].x;
    };
    // No pose, no labels: only position says otherwise; continuity keeps crossed hands crossed.
    expect(run(['Unknown', 'Unknown'], null)).toBe(0.3);
    // Pose wrists and labels both say otherwise: they win.
    expect(run(['Right', 'Left'], pose([0.7, 0.6, 0.95], [0.3, 0.6, 0.95]))).toBe(0.7);
  });

  it("'off' is the old crop-only search", () => {
    const full = fake(() => [{ x: 0.3, y: 0.6, label: 'Right' }]);
    const tr = new HandCropTracker({ left: empty() as unknown as HandLandmarker, right: empty() as unknown as HandLandmarker }, full as unknown as HandLandmarker);
    tr.opts.full = 'off';
    tr.run(image, W, H, 1000, pose([0.7, 0.6, 0.95], [0.3, 0.6, 0.95]));
    expect(full.calls).toBe(0);
  });
});
