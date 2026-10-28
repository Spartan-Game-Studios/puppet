import { describe, expect, it } from 'vitest';
import { classify, GestureFilter, GestureTracker, gestureScores, handFeatures, type Gesture, type GestureEvent } from '../src/core/gestures';

type V = [number, number, number];
interface HandSpec {
  /** Curl per finger (index, middle, ring, little), 0..1. */
  curl: [number, number, number, number];
  thumb: 'out' | 'up' | 'fold' | 'ok';
  /** Hand frame: finger direction, index side, palm normal (fingers curl toward it). Camera frame, y down. */
  frame?: { F: V; A: V; N: V };
}

const UPRIGHT = { F: [0, -1, 0] as V, A: [-1, 0, 0] as V, N: [0, 0, -1] as V };
const SIDEWAYS = { F: [1, 0, 0] as V, A: [0, -1, 0] as V, N: [0, 0, -1] as V };

/** 21 MediaPipe-style hand landmarks (metres) for a finger/thumb configuration. */
function hand({ curl, thumb, frame = UPRIGHT }: HandSpec): Array<{ x: number; y: number; z: number }> {
  const { F, A, N } = frame;
  const at = (f: number, a: number, n: number): V => [
    f * F[0] + a * A[0] + n * N[0],
    f * F[1] + a * A[1] + n * N[1],
    f * F[2] + a * A[2] + n * N[2],
  ];
  const pts: V[] = Array.from({ length: 21 }, () => [0, 0, 0] as V);
  const mcp: Array<[number, number]> = [[0.08, 0.03], [0.085, 0.01], [0.08, -0.01], [0.072, -0.03]];
  const seg = [0.04, 0.025, 0.02];
  const flex = [80, 95, 65].map((d) => (d * Math.PI) / 180);
  mcp.forEach(([f0, a0], i) => {
    const base = 5 + 4 * i;
    let p: V = [f0, a0, 0];
    pts[base] = at(...p);
    let ang = 0;
    for (let j = 0; j < 3; j++) {
      ang += curl[i] * flex[j];
      p = [p[0] + seg[j] * Math.cos(ang), p[1], p[2] + seg[j] * Math.sin(ang)];
      pts[base + j + 1] = at(...p);
    }
  });
  // Thumb, in (F, A, N) coordinates.
  const thumbs: Record<HandSpec['thumb'], V[]> = {
    out: [[0.02, 0.025, 0], [0.035, 0.05, 0], [0.05, 0.07, 0], [0.06, 0.09, 0]],
    up: [[0.02, 0.025, 0], [0.03, 0.05, 0], [0.03, 0.08, 0], [0.03, 0.11, 0]],
    fold: [[0.02, 0.025, 0], [0.035, 0.045, -0.01], [0.055, 0.035, -0.02], [0.07, 0.01, -0.035]],
    ok: [[0.02, 0.025, 0], [0.035, 0.045, -0.01], [0, 0, 0], [0, 0, 0]],
  };
  const th = thumbs[thumb];
  for (let j = 0; j < 4; j++) pts[1 + j] = at(...th[j]);
  if (thumb === 'ok') {
    // Thumb tip on the index tip.
    pts[4] = [...pts[8]] as V;
    pts[3] = pts[2].map((v, k) => (v + pts[4][k]) / 2) as V;
  }
  return pts.map(([x, y, z]) => ({ x, y, z }));
}

const SPECS: Record<Exclude<Gesture, 'none'>, HandSpec> = {
  open: { curl: [0, 0, 0, 0], thumb: 'out' },
  fist: { curl: [1, 1, 1, 1], thumb: 'fold' },
  point: { curl: [0, 1, 1, 1], thumb: 'fold' },
  peace: { curl: [0, 0, 1, 1], thumb: 'fold' },
  thumbsUp: { curl: [1, 1, 1, 1], thumb: 'up', frame: SIDEWAYS },
  ok: { curl: [0.55, 0, 0, 0], thumb: 'ok' },
  rock: { curl: [0, 1, 1, 0], thumb: 'fold' },
};

describe('gesture classifier', () => {
  for (const [g, spec] of Object.entries(SPECS)) {
    it(`recognises ${g}`, () => {
      expect(classify(handFeatures(hand(spec))).gesture).toBe(g);
    });
  }

  it('is rotation-invariant apart from thumbs up', () => {
    // A fist turned sideways is still a fist; thumbs up needs the thumb pointing up.
    expect(classify(handFeatures(hand({ ...SPECS.fist, frame: SIDEWAYS }))).gesture).toBe('fist');
    const down = { F: [1, 0, 0] as V, A: [0, 1, 0] as V, N: [0, 0, -1] as V };
    expect(classify(handFeatures(hand({ ...SPECS.thumbsUp, frame: down }))).gesture).not.toBe('thumbsUp');
  });

  it('feature values measured on rendered footage classify as expected', () => {
    // From MediaPipe on the test clip: a sideways thumbs up, a fist, an OK with loosely bent fingers.
    expect(classify({ curl: [0.92, 0.96, 0.86, 1], pinch: 0.82, thumbOut: 0.66, thumbUp: 0.44 }).gesture).toBe('thumbsUp');
    expect(classify({ curl: [0.9, 0.95, 0.9, 0.95], pinch: 0.5, thumbOut: 0.42, thumbUp: 0.6 }).gesture).toBe('fist');
    expect(classify({ curl: [0.37, 0.32, 0.17, 0.37], pinch: 0.24, thumbOut: 0.43, thumbUp: 0.38 }).gesture).toBe('ok');
  });

  it('a half-curled hand is no gesture', () => {
    expect(classify(handFeatures(hand({ curl: [0.45, 0.45, 0.45, 0.45], thumb: 'out' }))).gesture).toBe('none');
  });

  it('curl features track finger bends', () => {
    const f0 = handFeatures(hand({ curl: [0, 0, 0, 0], thumb: 'out' }));
    const f1 = handFeatures(hand({ curl: [1, 1, 1, 1], thumb: 'out' }));
    for (let i = 0; i < 4; i++) {
      expect(f0.curl[i]).toBeLessThan(0.2);
      expect(f1.curl[i]).toBeGreaterThan(0.8);
    }
  });
});

describe('gesture hysteresis', () => {
  const scoresOf = (g: Exclude<Gesture, 'none'>) => gestureScores(handFeatures(hand(SPECS[g])));
  const blank = () => gestureScores(handFeatures(hand({ curl: [0.45, 0.45, 0.45, 0.45], thumb: 'out' })));

  it('reports a gesture only after it has been held for enterMs', () => {
    const f = new GestureFilter({ enterMs: 150, exitMs: 200, stayScore: 0.3 });
    expect(f.update(scoresOf('fist'), 0)).toBe('none');
    expect(f.update(scoresOf('fist'), 100)).toBe('none');
    expect(f.update(scoresOf('fist'), 160)).toBe('fist');
  });

  it('a one-frame blip neither enters nor leaves', () => {
    const f = new GestureFilter();
    let t = 0;
    for (; t < 500; t += 33) f.update(scoresOf('peace'), t);
    expect(f.current).toBe('peace');
    f.update(scoresOf('point'), t);
    t += 33;
    f.update(blank(), t);
    t += 33;
    expect(f.update(scoresOf('peace'), t)).toBe('peace');
  });

  it('does not flicker on a borderline hand', () => {
    const f = new GestureFilter();
    const open = scoresOf('open');
    // Alternate a clean open hand with a borderline one every frame.
    const border = gestureScores(handFeatures(hand({ curl: [0.35, 0.35, 0.35, 0.35], thumb: 'out' })));
    let changes = 0;
    let prev = f.current;
    for (let t = 0; t < 3000; t += 33) {
      const g = f.update((t / 33) % 2 ? border : open, t);
      if (g !== prev) changes++;
      prev = g;
    }
    expect(changes).toBeLessThanOrEqual(1);
  });

  it('drops to none after the gesture fades for exitMs', () => {
    const f = new GestureFilter({ enterMs: 100, exitMs: 200, stayScore: 0.3 });
    let t = 0;
    for (; t <= 300; t += 33) f.update(scoresOf('rock'), t);
    expect(f.current).toBe('rock');
    for (let k = 0; k < 4; k++, t += 33) f.update(blank(), t);
    expect(f.current).toBe('rock');
    for (let k = 0; k < 6; k++, t += 33) f.update(blank(), t);
    expect(f.current).toBe('none');
  });
});

describe('GestureTracker events', () => {
  it('emits changes with user and avatar hand, respecting mirror', () => {
    const tr = new GestureTracker();
    tr.mirror = true;
    const events: GestureEvent[] = [];
    const off = tr.on((e) => events.push(e));
    const lm = hand(SPECS.thumbsUp);
    for (let t = 0; t <= 400; t += 33) tr.update([{ worldLandmarks: lm, userSide: 'right' }], t);
    expect(tr.current.right).toBe('thumbsUp');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ hand: 'right', avatarHand: 'left', gesture: 'thumbsUp', previous: 'none' });
    // Hand lost: back to none after lostMs.
    for (let t = 433; t <= 900; t += 33) tr.update([], t);
    expect(tr.current.right).toBe('none');
    expect(events.at(-1)).toMatchObject({ gesture: 'none', previous: 'thumbsUp' });
    off();
    for (let t = 1000; t <= 1400; t += 33) tr.update([{ worldLandmarks: lm, userSide: 'right' }], t);
    expect(events).toHaveLength(2);
  });

  it('falls back to the handedness label, which names the hand\'s own side on an unmirrored frame', () => {
    const tr = new GestureTracker();
    for (let t = 0; t <= 400; t += 33) tr.update([{ worldLandmarks: hand(SPECS.fist), handedness: 'Left' }], t);
    expect(tr.current.left).toBe('fist');
    expect(tr.current.right).toBe('none');
  });
});

describe('gestures -> hotkey triggers', () => {
  it('a held thumbs up starts a THUMBS UP trigger that resolves to its binding, and ends when let go', async () => {
    const { trackerGestureSource, GESTURE_NAMES } = await import('../src/input/gestures');
    const { resolve } = await import('../src/input/bindings');
    const tr = new GestureTracker();
    const src = trackerGestureSource(tr)!;
    const got: Array<{ gesture: string; hand: string; state: string }> = [];
    src.subscribe((e) => got.push({ gesture: e.gesture, hand: e.hand, state: e.state }));
    const lm = hand(SPECS.thumbsUp);
    for (let t = 0; t <= 400; t += 33) tr.update([{ worldLandmarks: lm, userSide: 'right' }], t);
    expect(got).toEqual([{ gesture: 'thumbs_up', hand: 'right', state: 'start' }]);
    const cheer = {
      id: 'cheer',
      trigger: { kind: 'gesture' as const, gesture: 'thumbs_up' as const, hand: 'any' as const },
      action: { kind: 'emote' as const, clip: 'cheer' },
    };
    expect(resolve([cheer as never], { kind: 'gesture', gesture: 'thumbs_up', hand: 'right' }, null)?.id).toBe('cheer');
    // Switch straight to a fist: the thumbs up ends, the fist starts.
    const fist = hand(SPECS.fist);
    for (let t = 433; t <= 800; t += 33) tr.update([{ worldLandmarks: fist, userSide: 'right' }], t);
    expect(got.slice(1)).toEqual([
      { gesture: 'thumbs_up', hand: 'right', state: 'end' },
      { gesture: 'fist', hand: 'right', state: 'start' },
    ]);
    // Every tracker gesture has a binding name.
    expect(Object.keys(GESTURE_NAMES).sort()).toEqual(['fist', 'ok', 'open', 'peace', 'point', 'rock', 'thumbsUp']);
    expect(trackerGestureSource(null)).toBeNull();
  });
});
