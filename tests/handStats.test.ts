import { describe, expect, it } from 'vitest';
import { HandStats } from '../src/tracking/handStats';
import type { HandResult, HandStatus } from '../src/tracking/protocol';

const hand = (side: 'left' | 'right'): HandResult => ({ landmarks: [], worldLandmarks: [], handedness: 'Left', score: 1, userSide: side });
const frame = (t: number, sides: Array<'left' | 'right'>, left: HandStatus, right: HandStatus) => ({ t, hands: sides.map(hand), handStatus: { left, right } });

describe('HandStats', () => {
  it('counts found % per side and both, over a rolling window', () => {
    const s = new HandStats(1000);
    s.push(frame(0, ['left', 'right'], 'found', 'found'));
    s.push(frame(100, ['left'], 'tracked', 'miss'));
    s.push(frame(200, ['left'], 'tracked', 'no-roi'));
    s.push(frame(300, [], 'miss', 'no-roi'));
    expect(s.foundPct('left')).toBe(75);
    expect(s.foundPct('right')).toBe(25);
    expect(s.foundPct('both')).toBe(25);
    expect(s.counts('right')).toEqual({ found: 1, miss: 1, 'no-roi': 2 });
    expect(s.last('left')).toBe('miss');
    // The first three frames fall out of a 1 s window.
    s.push(frame(1250, ['right'], 'miss', 'found'));
    expect(s.frames).toBe(2);
    expect(s.foundPct('right')).toBe(50);
  });

  it('summarises for the overlay and the log', () => {
    const s = new HandStats();
    expect(s.summary()).toBe('-');
    s.push(frame(0, ['left'], 'tracked', 'skip'));
    expect(s.summary()).toBe('L TRACKED 100% R SKIP 0% BOTH 0%');
    expect(s.countsLine()).toBe('L tracked:1 | R skip:1');
  });
});
