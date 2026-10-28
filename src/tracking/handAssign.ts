/**
 * Which user side a found hand belongs to. Pure functions (no MediaPipe), unit
 * tested. Frames reach the trackers unmirrored (mirror is display-only), so
 * this never depends on the app's mirror setting: the solver applies that.
 *
 * Four cues, each unreliable on its own at a real desk:
 *  - the pose wrist: MediaPipe Pose loses or misplaces wrists that are low in
 *    the frame, near the face or in front of the torso (a wrist at the chin
 *    with 0.8 visibility happens), so it is weighed by its visibility;
 *  - the hand model's handedness label. MediaPipe's docs say it assumes a
 *    mirrored (selfie) image, which would make 'Left' the user's right hand on
 *    our unmirrored frames, but measured on rendered clips (tasks-vision
 *    1.1.0) the label names the hand's own side: 97% for the hands of a
 *    realistic avatar at scores over 0.9. On stylised hands it is much worse
 *    (65%), and on one avatar it was inverted (3%: a hand whose back and palm
 *    look alike reads as the other hand). So the label is weighed by a trust
 *    the tracker learns from hands whose side the pose makes clear
 *    (LabelTrust): about +1 for real hands, negative where it is inverted;
 *  - continuity: a hand where a side's hand just was is that hand;
 *  - the hand's position across the body (the user's right hand is usually on
 *    the image's left of the nose), the weakest, a tie-break.
 */
import type { Landmark, Side } from '../core/bodySolver';

const POSE_WRIST = { left: 15, right: 16 } as const;
const POSE_NOSE = 0;
export const otherSide = (s: Side): Side => (s === 'left' ? 'right' : 'left');

export interface HandCandidate {
  /** 21 normalized image landmarks. */
  landmarks: Landmark[];
  handedness: string;
  score: number;
}

/** Context for scoring: the pose, each side's recent hand, and how far to trust labels. */
export interface AssignContext {
  pose?: Landmark[];
  width: number;
  height: number;
  /** Each side's hand from the last frames, if it was being tracked (continuity). */
  prev?: Partial<Record<Side, Landmark[] | null>>;
  /** -1..1: how far the handedness label is right (+1), noise (0) or inverted (-1). */
  labelTrust?: number;
}

/** The user side a MediaPipe handedness label names on an unmirrored frame (see above). */
export function labelSide(handedness: string): Side | null {
  return handedness === 'Left' ? 'left' : handedness === 'Right' ? 'right' : null;
}

/**
 * The side the label points to after trust (inverted when trust < 0) and how
 * much it counts, 0..1: confidence above 0.5 times |trust|.
 */
export function labelVote(c: HandCandidate, trust: number): { side: Side | null; weight: number } {
  const ls = labelSide(c.handedness);
  if (!ls || trust === 0) return { side: null, weight: 0 };
  const conf = Math.max(0, Math.min(1, (c.score - 0.5) / 0.4));
  return { side: trust > 0 ? ls : otherSide(ls), weight: conf * Math.min(1, Math.abs(trust)) };
}

/** The hand's size in pixels (wrist to middle knuckle), at least 1. */
export function handSize(h: Landmark[], width: number, height: number): number {
  return Math.max(1, Math.hypot((h[9].x - h[0].x) * width, (h[9].y - h[0].y) * height));
}

/** A pose wrist worth using: visible enough and inside (or just outside) the image. */
export function usableWrist(pose: Landmark[] | undefined, side: Side, minVis = 0.3): Landmark | null {
  const w = pose?.[POSE_WRIST[side]];
  if (!w || (w.visibility ?? 1) < minVis) return null;
  if (w.x < -0.05 || w.x > 1.05 || w.y < -0.05 || w.y > 1.05) return null;
  return w;
}

/** Distance from the hand's wrist to a pose wrist, in hand sizes (Infinity if unusable). */
export function wristGap(h: Landmark[], pose: Landmark[] | undefined, side: Side, width: number, height: number, minVis = 0.3): number {
  const w = usableWrist(pose, side, minVis);
  if (!w) return Infinity;
  return Math.hypot((h[0].x - w.x) * width, (h[0].y - w.y) * height) / handSize(h, width, height);
}

/**
 * How badly a hand fits a side (lower is better, about -1..4). Each cue adds
 * its disagreement; a missing cue adds the same to both sides, so it doesn't
 * decide.
 */
export function sideCost(c: HandCandidate, side: Side, ctx: AssignContext): number {
  const { pose, width, height, prev = {}, labelTrust = 0.8 } = ctx;
  let cost = 0;
  // Pose wrist: near (< 0.6 hand sizes) is a yes; far counts as much as that
  // wrist is believable (visibility), so a misplaced wrist can't veto alone.
  // A believable wrist outside the image says that hand is out of view.
  const w = pose?.[POSE_WRIST[side]];
  const vis = w?.visibility ?? 0;
  const own = wristGap(c.landmarks, pose, side, width, height);
  if (Number.isFinite(own)) cost += Math.min(2, Math.max(0, own - 0.6) / 1.5) * (0.5 + 0.5 * vis);
  else if (w && vis >= 0.5) cost += 2 * (0.5 + 0.5 * vis);
  else cost += 1;
  // Handedness: up to 1 against the side the (trusted) label doesn't name.
  const v = labelVote(c, labelTrust);
  if (v.side && v.side !== side) cost += v.weight;
  // Continuity.
  const size = handSize(c.landmarks, width, height);
  const near = (h: Landmark[] | null | undefined) =>
    !!h && Math.hypot((h[0].x - c.landmarks[0].x) * width, (h[0].y - c.landmarks[0].y) * height) < size;
  if (near(prev[side])) cost -= 1;
  if (near(prev[otherSide(side)])) cost += 1;
  // Image position across the nose (user right = image left), a tie-break.
  const nose = pose?.[POSE_NOSE];
  const mid = nose && (nose.visibility ?? 1) > 0.5 ? nose.x : 0.5;
  if (c.landmarks[0].x > mid !== (side === 'left')) cost += 0.3;
  return cost;
}

/**
 * Give up to two hands to the free sides with the lowest total cost. A hand
 * that doesn't fit any free side well (cost above `maxCost`) stays
 * unassigned. Returns side -> index into `cands`.
 */
export function assignSides(cands: HandCandidate[], free: Side[], ctx: AssignContext, maxCost = 2.2): Partial<Record<Side, number>> {
  const out: Partial<Record<Side, number>> = {};
  if (!cands.length || !free.length) return out;
  const n = Math.min(2, cands.length);
  const cost: number[][] = [];
  for (let i = 0; i < n; i++) cost.push(free.map((s) => sideCost(cands[i], s, ctx)));
  let best: Array<[number, number]> = [];
  let bestScore = Infinity;
  const consider = (pairs: Array<[number, number]>) => {
    const ok = pairs.filter(([i, j]) => cost[i][j] <= maxCost);
    // More hands placed wins; then the lower total.
    const score = ok.reduce((a, [i, j]) => a + cost[i][j], 0) - 10 * ok.length;
    if (score < bestScore) {
      bestScore = score;
      best = ok;
    }
  };
  if (n === 2 && free.length === 2) {
    consider([[0, 0], [1, 1]]);
    consider([[0, 1], [1, 0]]);
  }
  for (let i = 0; i < n; i++) for (let j = 0; j < free.length; j++) consider([[i, j]]);
  for (const [i, j] of best) out[free[j]] = i;
  return out;
}

/**
 * Whether a hand found in `side`'s crop is really the other hand (crossed
 * arms, hands together). Needs two cues to agree, because the pose wrist alone
 * is wrong exactly where hands meet the face or each other: the other side is
 * already holding the same hand, or the hand is far from this side's pose
 * wrist, sits on the other side's believable pose wrist AND the trusted label
 * says it is the other hand.
 */
export function isOtherHand(c: HandCandidate, side: Side, ctx: AssignContext, otherHand: Landmark[] | null): boolean {
  const { pose, width, height } = ctx;
  if (otherHand && sameHand(c.landmarks, otherHand, width, height)) return true;
  const own = wristGap(c.landmarks, pose, side, width, height, 0.2);
  const theirs = wristGap(c.landmarks, pose, otherSide(side), width, height, 0.5);
  if (!(own > 1.2 && theirs < 0.6 * own)) return false;
  const v = labelVote(c, ctx.labelTrust ?? 0.8);
  return v.side === otherSide(side) && v.weight > 0.25;
}

/** Whether two hands (normalized landmarks) are the same detection. */
export function sameHand(a: Landmark[], b: Landmark[], width: number, height: number): boolean {
  const size = handSize(a, width, height);
  let d = 0;
  for (const i of [0, 5, 9, 13, 17]) d += Math.hypot((a[i].x - b[i].x) * width, (a[i].y - b[i].y) * height);
  return d / 5 < 0.35 * size;
}

/**
 * Both sides found the same hand: which side keeps it. The side it fits
 * better (pose, trusted label, position); on a tie the side whose crop was
 * tracking it.
 */
export function dedupeKeep(c: HandCandidate, ctx: AssignContext, tracking: Partial<Record<Side, boolean>> = {}): Side {
  const plain = { ...ctx, prev: {} };
  const dl = sideCost(c, 'left', plain);
  const dr = sideCost(c, 'right', plain);
  if (Math.abs(dl - dr) < 0.05 && tracking.left !== tracking.right) return tracking.left ? 'left' : 'right';
  return dl <= dr ? 'left' : 'right';
}

/**
 * Learns how far the handedness label can be trusted, from hands whose side
 * the pose makes clear: on their own believable pose wrist, far from the
 * other one, and on their own side of the nose (crossed arms are where the
 * pose itself swaps the wrists, so they don't count). Even so, crossed arms
 * the pose reads as uncrossed look like a wrong label, so it learns slowly
 * (about 7 s of steady evidence to change its mind). Starts at +0.8: real
 * hands, measured on the realistic avatar, discounted.
 */
export class LabelTrust {
  value = 0.8;
  constructor(private readonly rate = 0.005) {}

  observe(c: HandCandidate, side: Side, pose: Landmark[] | undefined, width: number, height: number): void {
    const ls = labelSide(c.handedness);
    if (!ls || c.score < 0.7) return;
    const own = wristGap(c.landmarks, pose, side, width, height, 0.7);
    const theirs = wristGap(c.landmarks, pose, otherSide(side), width, height, 0.7);
    if (!(own < 0.8 && theirs > 2.5)) return;
    const nose = pose?.[POSE_NOSE];
    if (!nose || (nose.visibility ?? 1) < 0.5 || c.landmarks[0].x > nose.x !== (side === 'left')) return;
    this.value += this.rate * ((ls === side ? 1 : -1) - this.value);
  }
}
