/**
 * Hand gesture recognition from MediaPipe hand world landmarks: fist, open
 * palm, point, peace/V, thumbs up, OK and rock/horns.
 *
 * Our own classifier rather than MediaPipe's Gesture Recognizer: that model
 * has no OK or horns class, and it would run a second hand model per frame,
 * while these features come free from the landmarks we already have.
 *
 * Pipeline: landmarks -> features (per-finger curl, thumb pose; smoothed) ->
 * per-gesture scores -> a hysteresis filter, so a gesture has to be held for a
 * moment to be reported and doesn't flicker at a boundary -> change events.
 * Pure: no DOM, no three.js.
 */
import { OneEuroVector, type OneEuroParams } from './oneEuro';

export type Gesture = 'none' | 'fist' | 'open' | 'point' | 'peace' | 'thumbsUp' | 'ok' | 'rock';
export const GESTURES: Gesture[] = ['none', 'fist', 'open', 'point', 'peace', 'thumbsUp', 'ok', 'rock'];
export type HandSide = 'left' | 'right';

interface P3 {
  x: number;
  y: number;
  z: number;
}

export interface HandFeatures {
  /** Curl per finger, thumb excluded: index, middle, ring, little. 0 = straight, 1 = fully curled. */
  curl: [number, number, number, number];
  /** Thumb tip to index tip, in palm lengths (wrist to middle knuckle). */
  pinch: number;
  /** Thumb tip to the index knuckle, in palm lengths (small = thumb tucked). */
  thumbOut: number;
  /** How much the thumb points up in the camera image, -1..1. */
  thumbUp: number;
}

const sub = (a: P3, b: P3) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const len = (a: P3) => Math.hypot(a.x, a.y, a.z);
const angle = (a: P3, b: P3) => {
  const d = (a.x * b.x + a.y * b.y + a.z * b.z) / Math.max(1e-9, len(a) * len(b));
  return Math.acos(Math.max(-1, Math.min(1, d)));
};

/** Sum of a finger's three joint bends at which it counts as fully curled (radians). */
const FULL_CURL = (230 * Math.PI) / 180;

/**
 * Features from 21 hand landmarks in MediaPipe's camera-aligned frame
 * (y down). World landmarks are best (metric, so the angles are true), but
 * image landmarks work too.
 */
export function handFeatures(w: P3[]): HandFeatures {
  const fingers = [
    [5, 6, 7, 8],
    [9, 10, 11, 12],
    [13, 14, 15, 16],
    [17, 18, 19, 20],
  ];
  const curl = fingers.map(([a, b, c, d]) => {
    const palm = sub(w[a], w[0]);
    const s1 = sub(w[b], w[a]);
    const s2 = sub(w[c], w[b]);
    const s3 = sub(w[d], w[c]);
    const bend = angle(palm, s1) + angle(s1, s2) + angle(s2, s3);
    return Math.min(1, bend / FULL_CURL);
  }) as HandFeatures['curl'];
  const palmLen = Math.max(1e-6, len(sub(w[9], w[0])));
  const thumb = sub(w[4], w[2]);
  return {
    curl,
    pinch: len(sub(w[4], w[8])) / palmLen,
    thumbOut: len(sub(w[4], w[5])) / palmLen,
    thumbUp: -thumb.y / Math.max(1e-6, len(thumb)),
  };
}

const ramp = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Score (0..1) per gesture; the best one above 0.5 wins. */
export function gestureScores(f: HandFeatures): Record<Exclude<Gesture, 'none'>, number> {
  const ext = f.curl.map((c) => ramp(0.5, 0.25, c));
  const cur = f.curl.map((c) => ramp(0.4, 0.62, c));
  const [eI, eM, eR, eL] = ext;
  const [cI, cM, cR, cL] = cur;
  const pinch = ramp(0.5, 0.28, f.pinch);
  // A tucked thumb lies over the middle phalanges, under half a palm from the index knuckle.
  const thumbOut = ramp(0.5, 0.75, f.thumbOut);
  const thumbUp = ramp(0.2, 0.5, f.thumbUp);
  // OK: the three free fingers are often loosely bent.
  const loose = f.curl.map((c) => ramp(0.6, 0.35, c));
  const allCurled = cI * cM * cR * cL;
  return {
    open: eI * eM * eR * eL * (1 - pinch),
    fist: allCurled * (1 - thumbOut * thumbUp),
    point: eI * cM * cR * cL,
    peace: eI * eM * cR * cL,
    thumbsUp: allCurled * thumbOut * thumbUp,
    ok: pinch * loose[1] * loose[2] * loose[3],
    rock: eI * cM * cR * eL,
  };
}

export function classify(f: HandFeatures): { gesture: Gesture; score: number } {
  let best: Gesture = 'none';
  let score = 0;
  for (const [g, s] of Object.entries(gestureScores(f)) as Array<[Gesture, number]>) {
    if (s > score) {
      best = g;
      score = s;
    }
  }
  return score >= 0.5 ? { gesture: best, score } : { gesture: 'none', score: 1 - score };
}

export interface GestureFilterOptions {
  /** A new gesture must win this long (ms) before it is reported. */
  enterMs: number;
  /** The current gesture is dropped after scoring below `stayScore` this long (ms). */
  exitMs: number;
  /** Score the current gesture needs to stay. Lower than the 0.5 to enter: hysteresis. */
  stayScore: number;
}

export const DEFAULT_GESTURE_FILTER: GestureFilterOptions = { enterMs: 150, exitMs: 200, stayScore: 0.3 };

/** Hysteresis on a stream of per-frame classifications. */
export class GestureFilter {
  current: Gesture = 'none';
  confidence = 0;
  private candidate: Gesture = 'none';
  private candidateSince = 0;
  private weakSince: number | null = null;

  constructor(public opts: GestureFilterOptions = DEFAULT_GESTURE_FILTER) {}

  reset(): void {
    this.current = 'none';
    this.confidence = 0;
    this.candidate = 'none';
    this.weakSince = null;
  }

  /** Feed one frame's scores (t in ms); returns the (possibly unchanged) current gesture. */
  update(scores: Record<Exclude<Gesture, 'none'>, number>, t: number): Gesture {
    let top: Gesture = 'none';
    let topScore = 0;
    for (const [g, s] of Object.entries(scores) as Array<[Gesture, number]>) {
      if (s > topScore) {
        top = g;
        topScore = s;
      }
    }
    const winner: Gesture = topScore >= 0.5 ? top : 'none';
    if (winner !== this.candidate) {
      this.candidate = winner;
      this.candidateSince = t;
    }
    const curScore = this.current === 'none' ? 1 - topScore : scores[this.current as Exclude<Gesture, 'none'>];
    // Another gesture has won long enough: switch.
    if (this.candidate !== this.current && this.candidate !== 'none' && t - this.candidateSince >= this.opts.enterMs) {
      this.current = this.candidate;
      this.weakSince = null;
    } else if (this.current !== 'none') {
      // The current one has faded: drop to none after a while.
      if (curScore < this.opts.stayScore) {
        this.weakSince ??= t;
        if (t - this.weakSince >= this.opts.exitMs) {
          this.current = 'none';
          this.weakSince = null;
        }
      } else {
        this.weakSince = null;
      }
    }
    this.confidence = this.current === 'none' ? Math.max(0, 1 - topScore) : scores[this.current as Exclude<Gesture, 'none'>];
    return this.current;
  }
}

export interface GestureEvent {
  /** The user's anatomical hand. */
  hand: HandSide;
  /** The avatar hand it drives (differs from `hand` when mirrored). */
  avatarHand: HandSide;
  gesture: Gesture;
  previous: Gesture;
  /** 0..1, the recognised gesture's score when it was reported. */
  confidence: number;
  /** Tracker timestamp, ms. */
  t: number;
}

export type GestureListener = (e: GestureEvent) => void;

export interface GestureHandInput {
  /** 21 world (or image) landmarks, MediaPipe camera frame. */
  worldLandmarks: P3[];
  /** The user's anatomical side, if known. */
  userSide?: HandSide;
  /** MediaPipe handedness label (selfie convention), used when userSide is missing. */
  handedness?: string;
}

/**
 * Per-hand gesture state for the app: feed every body result's hands, read
 * `current`, or subscribe with `on()` to get an event whenever a hand's
 * recognised gesture changes (including back to 'none').
 */
export class GestureTracker {
  /** Current gesture per user hand. */
  readonly current: Record<HandSide, Gesture> = { left: 'none', right: 'none' };
  /** Features smoothing; light, the hysteresis does most of the work. */
  smoothing: OneEuroParams = { minCutoff: 3, beta: 0.5, dCutoff: 1 };
  /** Drop a hand's gesture when it has not been seen for this long (ms). */
  lostMs = 300;
  mirror = true;
  private filters: Record<HandSide, GestureFilter> = { left: new GestureFilter(), right: new GestureFilter() };
  private smooth: Record<HandSide, OneEuroVector> = { left: new OneEuroVector(7, this.smoothing), right: new OneEuroVector(7, this.smoothing) };
  private seen: Record<HandSide, number> = { left: -Infinity, right: -Infinity };
  private listeners = new Set<GestureListener>();
  /** Last features per hand (debug readout). */
  readonly features: Partial<Record<HandSide, HandFeatures>> = {};

  /** Subscribe; returns an unsubscribe function. */
  on(listener: GestureListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Feed one body result's hands (t in ms). Missing hands count as not seen. */
  update(hands: GestureHandInput[], t: number): void {
    const got = new Set<HandSide>();
    for (const h of hands) {
      if (!h.worldLandmarks || h.worldLandmarks.length < 21) continue;
      // MediaPipe labels handedness as if the image were mirrored (selfie view).
      const side: HandSide = h.userSide ?? (h.handedness === 'Left' ? 'right' : 'left');
      if (got.has(side)) continue;
      got.add(side);
      if (t - this.seen[side] > this.lostMs) this.smooth[side].reset();
      this.seen[side] = t;
      const f = handFeatures(h.worldLandmarks);
      const v = this.smooth[side].filter([...f.curl, f.pinch, f.thumbOut, f.thumbUp], t / 1000);
      const sf: HandFeatures = { curl: [v[0], v[1], v[2], v[3]], pinch: v[4], thumbOut: v[5], thumbUp: v[6] };
      this.features[side] = sf;
      this.set(side, this.filters[side].update(gestureScores(sf), t), t);
    }
    for (const side of ['left', 'right'] as HandSide[]) {
      if (!got.has(side) && t - this.seen[side] > this.lostMs && this.current[side] !== 'none') {
        this.filters[side].reset();
        delete this.features[side];
        this.set(side, 'none', t);
      }
    }
  }

  reset(): void {
    for (const side of ['left', 'right'] as HandSide[]) {
      this.filters[side].reset();
      this.smooth[side].reset();
      this.seen[side] = -Infinity;
      this.current[side] = 'none';
    }
  }

  private set(side: HandSide, g: Gesture, t: number): void {
    const prev = this.current[side];
    if (g === prev) return;
    this.current[side] = g;
    const e: GestureEvent = {
      hand: side,
      avatarHand: this.mirror ? (side === 'left' ? 'right' : 'left') : side,
      gesture: g,
      previous: prev,
      confidence: this.filters[side].confidence,
      t,
    };
    for (const l of this.listeners) l(e);
  }
}
