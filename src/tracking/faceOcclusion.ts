/**
 * Whether a hand covers the face (over the mouth, over the face, chin on a
 * fist). FaceLandmarker keeps returning a face then, but its head pose and
 * mouth go wrong (a 14° head error and a mouth snapping open on the webcam
 * clip), so the app holds the last good face instead of following it.
 *
 * Pure geometry: the pose's nose and mouth corners (image landmarks 0, 9, 10)
 * against each hand's outline (the convex hull of its 21 image landmarks,
 * grown a little). Covered when two of the three points are inside a hand.
 */
import type { Landmark } from '../core/bodySolver';

const FACE_POINTS = [0, 9, 10];

/** Convex hull (monotone chain) of 2D points, counter-clockwise. */
export function hull(pts: Array<[number, number]>): Array<[number, number]> {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Array<[number, number]> = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Array<[number, number]> = [];
  for (const q of [...p].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function inside(poly: Array<[number, number]>, x: number, y: number): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** `hands`: each hand's 21 normalized image landmarks; `pose`: the pose's image landmarks. */
export function faceCovered(hands: Landmark[][], pose: Landmark[] | undefined, aspect = 4 / 3, grow = 1.1): boolean {
  if (!pose || pose.length < 11) return false;
  const pts = FACE_POINTS.map((i) => pose[i]).filter((l) => (l.visibility ?? 1) > 0.3);
  if (pts.length < 2) return false;
  for (const h of hands) {
    if (h.length < 21) continue;
    // Work in a square-pixel frame so the growth is even.
    const raw = hull(h.map((l) => [l.x * aspect, l.y] as [number, number]));
    const cx = raw.reduce((s, q) => s + q[0], 0) / raw.length;
    const cy = raw.reduce((s, q) => s + q[1], 0) / raw.length;
    const poly = raw.map(([x, y]) => [cx + (x - cx) * grow, cy + (y - cy) * grow] as [number, number]);
    const n = pts.filter((l) => inside(poly, l.x * aspect, l.y)).length;
    if (n >= 2) return true;
  }
  return false;
}
