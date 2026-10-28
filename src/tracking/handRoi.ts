/**
 * Where to look for each hand. Pure geometry (no MediaPipe), so it is unit
 * tested: square crops in image pixels, from the last hand landmarks when the
 * hand was just seen (tracking), else from the pose's wrist, elbow and hand
 * points (re-detection), plus a test that a found hand belongs to the side
 * whose crop found it.
 */
import type { Landmark, Side } from '../core/bodySolver';

export interface Roi {
  /** Top-left corner and side length, pixels. */
  x: number;
  y: number;
  size: number;
}

const POSE_IDX = {
  left: { shoulder: 11, elbow: 13, wrist: 15, pinky: 17, index: 19, thumb: 21 },
  right: { shoulder: 12, elbow: 14, wrist: 16, pinky: 18, index: 20, thumb: 22 },
} as const;

export const MIN_ROI = 96;

/** Square crop around a set of hand landmarks (normalized), `scale` x their bounding box. */
export function roiFromLandmarks(lms: Landmark[], width: number, height: number, scale = 2.0): Roi {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const l of lms) {
    const x = l.x * width;
    const y = l.y * height;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  const size = Math.max(MIN_ROI, scale * Math.max(x1 - x0, y1 - y0));
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  return { x: cx - size / 2, y: cy - size / 2, size };
}

/**
 * Crop from pose landmarks (normalized image coords) for the USER's `side`,
 * or null if that wrist isn't usable. Sized from the forearm, the shoulder
 * width and the pose's own hand points, whichever is largest, because any one
 * of them can be foreshortened; centred a little past the wrist toward the
 * knuckles. `scale` widens it for retries.
 */
export function roiFromPose(pose: Landmark[], side: Side, width: number, height: number, scale = 1): Roi | null {
  const ix = POSE_IDX[side];
  const w = pose[ix.wrist];
  if (!w || (w.visibility ?? 1) < 0.2) return null;
  // A wrist well outside the image has its hand outside too.
  if (w.x < -0.1 || w.x > 1.1 || w.y < -0.1 || w.y > 1.1) return null;
  const px = (l: Landmark) => [l.x * width, l.y * height];
  const [wx, wy] = px(w);
  const [ex, ey] = px(pose[ix.elbow]);
  const knuckles = [pose[ix.index], pose[ix.pinky]].map(px);
  const kx = (knuckles[0][0] + knuckles[1][0]) / 2;
  const ky = (knuckles[0][1] + knuckles[1][1]) / 2;
  const other = POSE_IDX[side === 'left' ? 'right' : 'left'];
  const [sx, sy] = px(pose[ix.shoulder]);
  const [ox, oy] = px(pose[other.shoulder]);
  const fore = Math.hypot(wx - ex, wy - ey);
  const hand = Math.hypot(kx - wx, ky - wy);
  const shoulders = Math.hypot(sx - ox, sy - oy);
  const size = scale * Math.max(MIN_ROI, 1.5 * fore, 1.1 * shoulders, 4 * hand);
  const cx = wx + 0.3 * (kx - wx);
  const cy = wy + 0.3 * (ky - wy);
  // Mostly outside the image: nothing to find.
  if (cx < -size / 4 || cy < -size / 4 || cx > width + size / 4 || cy > height + size / 4) return null;
  return { x: cx - size / 2, y: cy - size / 2, size };
}

/**
 * Keep the previous crop unless the new one has moved or rescaled enough:
 * a crop that holds still keeps MediaPipe's own frame-to-frame hand tracking
 * (VIDEO mode) valid inside it, and avoids feeding it sub-pixel jitter.
 */
export function stabilizeRoi(prev: Roi | null, next: Roi, moveFrac = 0.12, scaleFrac = 0.18): Roi {
  if (!prev) return next;
  const pc = [prev.x + prev.size / 2, prev.y + prev.size / 2];
  const nc = [next.x + next.size / 2, next.y + next.size / 2];
  const moved = Math.hypot(nc[0] - pc[0], nc[1] - pc[1]) / prev.size;
  const scaled = Math.abs(next.size - prev.size) / prev.size;
  return moved > moveFrac || scaled > scaleFrac ? next : prev;
}

/**
 * How well a found hand (normalized landmarks) matches the user's `side`:
 * the distance from its wrist to that side's pose wrist, in units of the
 * hand's size (smaller is better). Infinity if the pose wrist is missing.
 */
export function wristDistance(hand: Landmark[], pose: Landmark[] | undefined, side: Side, width: number, height: number): number {
  if (!pose) return Infinity;
  const pw = pose[POSE_IDX[side].wrist];
  if (!pw) return Infinity;
  const h0 = hand[0];
  const h9 = hand[9];
  const size = Math.max(1e-6, Math.hypot((h9.x - h0.x) * width, (h9.y - h0.y) * height));
  return Math.hypot((h0.x - pw.x) * width, (h0.y - pw.y) * height) / size;
}

/** Whether two hands are the same detection (moved to handAssign.ts with the rest of the side logic). */
export { sameHand } from './handAssign';
