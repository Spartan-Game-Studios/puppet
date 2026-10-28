import type { TrackerResult } from './protocol';

/**
 * Joins the body and hands pipelines' results. A body result carries the
 * latest hands, if they were found on a frame at most ~2 frames older than
 * its pose; a hands result that arrives after its pose re-sends that pose with
 * them (`handsUpdate`) instead of waiting for the next one.
 */
export class HandsMerge {
  private body: TrackerResult | null = null;
  private hands: TrackerResult | null = null;
  /** Off: hands only ride on the next body result (the old behaviour; tests). */
  applyOnArrival = true;

  /** A body result, with the latest hands attached. */
  onBody(m: TrackerResult): TrackerResult {
    this.body = m;
    return (this.hands && this.attach(m, this.hands)) ?? m;
  }

  /** A hands result: the last pose to send again with it, or null. */
  onHands(m: TrackerResult): TrackerResult | null {
    this.hands = m;
    const b = this.applyOnArrival && this.body ? this.attach(this.body, m) : null;
    return b && { ...b, t: Math.max(b.t, m.t), handsUpdate: true };
  }

  private attach(body: TrackerResult, h: TrackerResult): TrackerResult | null {
    if (body.t - h.t >= 80) return null;
    return { ...body, hands: h.hands, handsRan: h.handsRan, timings: { ...body.timings, hands: h.timings.hands } };
  }
}
