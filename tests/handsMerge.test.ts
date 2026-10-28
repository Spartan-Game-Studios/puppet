import { describe, expect, it } from 'vitest';
import { HandsMerge } from '../src/tracking/handsMerge';
import type { HandResult, TrackerResult } from '../src/tracking/protocol';

const timings = { face: 0, pose: 0, hands: 0, total: 0 };
const body = (t: number): TrackerResult => ({ type: 'result', pipeline: 'body', t, width: 640, height: 480, pose: { world: [], image: [] }, timings: { ...timings, pose: 10 } });
const hand = { handedness: 'Left', score: 0.9, landmarks: [], worldLandmarks: [] } as unknown as HandResult;
const hands = (t: number, found = [hand]): TrackerResult => ({ type: 'result', pipeline: 'hands', t, width: 640, height: 480, hands: found, handsRan: true, timings: { ...timings, hands: 20 } });

describe('HandsMerge', () => {
  it('re-sends the pose as soon as its hands arrive', () => {
    const m = new HandsMerge();
    expect(m.onBody(body(100)).hands).toBeUndefined();
    const r = m.onHands(hands(100));
    expect(r?.handsUpdate).toBe(true);
    expect(r?.pipeline).toBe('body');
    expect(r?.pose).toBeTruthy();
    expect(r?.hands).toEqual([hand]);
    expect(r?.timings).toEqual({ ...timings, pose: 10, hands: 20 });
  });

  it('carries the latest hands on the next pose', () => {
    const m = new HandsMerge();
    m.onBody(body(100));
    m.onHands(hands(100));
    const r = m.onBody(body(133));
    expect(r.hands).toEqual([hand]);
    expect(r.handsUpdate).toBeUndefined();
  });

  it('drops hands more than ~2 frames older than the pose', () => {
    const m = new HandsMerge();
    m.onHands(hands(100));
    expect(m.onBody(body(200)).hands).toBeUndefined();
    expect(m.onHands(hands(50))).toBeNull();
  });

  it('does not modify the results it was given', () => {
    const m = new HandsMerge();
    const b = body(100);
    m.onBody(b);
    m.onHands(hands(100));
    expect(b.hands).toBeUndefined();
    expect(b.timings.hands).toBe(0);
  });

  it('with applyOnArrival off, hands wait for the next pose', () => {
    const m = new HandsMerge();
    m.applyOnArrival = false;
    m.onBody(body(100));
    expect(m.onHands(hands(100))).toBeNull();
    expect(m.onBody(body(133)).hands).toEqual([hand]);
  });

  it('a hands update takes the later of the two timestamps', () => {
    const m = new HandsMerge();
    m.onBody(body(100));
    expect(m.onHands(hands(120))?.t).toBe(120);
  });
});
