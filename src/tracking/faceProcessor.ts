/**
 * Per-frame face pipeline: raw MediaPipe face result -> calibrated, smoothed,
 * shaped blendshapes + head rotation + gaze, ready for the avatar.
 *
 * Order: mirror -> neutral calibration -> one-euro smoothing -> gain/curve.
 */
import { Quaternion, Vector3 } from 'three';
import {
  ARKIT_NAMES,
  applyCalibration,
  applyGainCurve,
  gazeFromBlendshapes,
  mirrorBlendshapes,
  type Blendshapes,
  type GainCurve,
} from '../core/blendshapes';
import { OneEuroFilter, smoothingToParams } from '../core/oneEuro';
import { alignHemisphere, headPoseFromMatrix } from '../core/headPose';
import type { FaceResult } from './protocol';

export interface Calibration {
  baseline: Record<string, number>;
  /** Neutral head rotation (x, y, z, w) and position. */
  head: [number, number, number, number] | null;
  headPos: [number, number, number] | null;
  gaze: { yaw: number; pitch: number } | null;
}

export const EMPTY_CALIBRATION: Calibration = { baseline: {}, head: null, headPos: null, gaze: null };

export interface FaceState {
  /** Raw (mirrored, uncalibrated) values, for the readout. */
  raw: Blendshapes;
  /** Final values. */
  values: Blendshapes;
  head: Quaternion;
  /** Head offset from the neutral position, metres. */
  headPos: Vector3;
  gaze: { yaw: number; pitch: number };
  t: number;
}

const FAST = new Set(['eyeBlinkLeft', 'eyeBlinkRight', 'jawOpen']);

export class FaceProcessor {
  mirror = true;
  calibration: Calibration = structuredClone(EMPTY_CALIBRATION);
  gains: Record<string, GainCurve> = {};
  private filters = new Map<string, OneEuroFilter>();
  private headFilters = Array.from({ length: 4 }, () => new OneEuroFilter());
  private posFilters = Array.from({ length: 3 }, () => new OneEuroFilter());
  private gazeFilters = Array.from({ length: 2 }, () => new OneEuroFilter());
  private lastHead = new Quaternion();
  private lastRawHead: Quaternion | null = null;
  private lastRawPos: Vector3 | null = null;
  private lastRaw: Blendshapes = {};
  private smoothing = 0.5;
  state: FaceState | null = null;
  /**
   * Until the user calibrates, take the first steady second of face as
   * neutral (not saved). An uncalibrated start otherwise carries every
   * resting offset MediaPipe reads on this face (a few degrees of head pitch,
   * half-closed eyes, a "pucker" from dark lips) straight onto the avatar.
   */
  autoCalibrate = true;
  /** True once an automatic neutral is in use (cleared by a manual calibrate). */
  autoCalibrated = false;
  private steady: Array<{ t: number; q: Quaternion; pos: Vector3; bs: Blendshapes }> = [];

  constructor() {
    for (const n of ARKIT_NAMES) this.filters.set(n, new OneEuroFilter());
    this.setSmoothing(0.5);
  }

  setSmoothing(amount: number): void {
    this.smoothing = amount;
    for (const [n, f] of this.filters) f.params = smoothingToParams(amount, FAST.has(n));
    const head = smoothingToParams(amount);
    for (const f of this.headFilters) f.params = { ...head };
    for (const f of this.posFilters) f.params = { ...head };
    // Eyes dart: keep gaze responsive.
    for (const f of this.gazeFilters) f.params = smoothingToParams(amount * 0.7, true);
  }

  get smoothingAmount(): number {
    return this.smoothing;
  }

  /** Capture the current face as neutral. */
  captureNeutral(): boolean {
    this.autoCalibrated = false;
    if (!this.lastRawHead) return false;
    const baseline: Record<string, number> = {};
    for (const n of ARKIT_NAMES) {
      const v = this.lastRaw[n] ?? 0;
      // Only treat small resting offsets as neutral; a held smile shouldn't be erased.
      if (v > 0.02 && v < 0.85) baseline[n] = v;
    }
    const q = this.lastRawHead;
    const gaze = gazeFromBlendshapes(this.lastRaw);
    this.calibration = {
      baseline,
      head: [q.x, q.y, q.z, q.w],
      headPos: this.lastRawPos ? [this.lastRawPos.x, this.lastRawPos.y, this.lastRawPos.z] : null,
      gaze,
    };
    return true;
  }

  clearCalibration(): void {
    this.calibration = structuredClone(EMPTY_CALIBRATION);
    this.autoCalibrated = false;
    this.steady = [];
  }

  /** Auto neutral: average a steady, eyes-open, mouth-closed second of raw frames. */
  private autoNeutral(t: number, q: Quaternion, pos: Vector3, bs: Blendshapes): void {
    if (!this.autoCalibrate || this.autoCalibrated || this.calibration.head) return;
    this.steady.push({ t, q: q.clone(), pos: pos.clone(), bs });
    while (this.steady.length && this.steady[0].t < t - 1.0) this.steady.shift();
    const w = this.steady;
    if (w.length < 8 || t - w[0].t < 0.9) return;
    const ref = w[w.length - 1].q;
    if (w.some((f) => f.q.angleTo(ref) > 0.05)) return;
    for (const n of ARKIT_NAMES) {
      let lo = 1, hi = 0;
      for (const f of w) {
        const v = f.bs[n] ?? 0;
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
      if (hi - lo > 0.12) return;
    }
    const peak = (n: string) => Math.max(...w.map((f) => f.bs[n] ?? 0));
    if (peak('jawOpen') > 0.25 || peak('eyeBlinkLeft') > 0.6 || peak('eyeBlinkRight') > 0.6) return;
    const baseline: Record<string, number> = {};
    for (const n of ARKIT_NAMES) {
      const v = w.reduce((s, f) => s + (f.bs[n] ?? 0), 0) / w.length;
      // Wider than a manual capture: a resting value this high is a misread, not an expression.
      if (v > 0.02 && v < 0.95) baseline[n] = v;
    }
    const avgPos = w.reduce((s, f) => s.add(f.pos), new Vector3()).multiplyScalar(1 / w.length);
    const gz = w.map((f) => gazeFromBlendshapes(f.bs));
    this.calibration = {
      baseline,
      head: [ref.x, ref.y, ref.z, ref.w],
      headPos: [avgPos.x, avgPos.y, avgPos.z],
      gaze: { yaw: gz.reduce((s, g) => s + g.yaw, 0) / gz.length, pitch: gz.reduce((s, g) => s + g.pitch, 0) / gz.length },
    };
    this.autoCalibrated = true;
    this.steady = [];
  }

  /** Process one tracking result. Times in seconds. */
  process(face: FaceResult, t: number): FaceState {
    const bs = this.mirror ? mirrorBlendshapes(face.blendshapes) : { ...face.blendshapes };
    this.lastRaw = bs;
    const values: Blendshapes = {};
    for (const n of ARKIT_NAMES) {
      const cal = applyCalibration(bs[n] ?? 0, this.calibration.baseline[n] ?? 0);
      const f = this.filters.get(n)!.filter(cal, t);
      values[n] = applyGainCurve(f, this.gains[n]);
    }

    // Head.
    let head = this.lastHead.clone();
    const headPos = new Vector3();
    if (face.matrix) {
      const pose = headPoseFromMatrix(face.matrix, this.mirror);
      this.lastRawHead = pose.rotation.clone();
      this.lastRawPos = pose.position.clone();
      this.autoNeutral(t, pose.rotation, pose.position, bs);
      let q = pose.rotation;
      const c = this.calibration.head;
      if (c) q = q.multiply(new Quaternion(c[0], c[1], c[2], c[3]).invert());
      alignHemisphere(q, this.lastHead);
      const comps = [q.x, q.y, q.z, q.w].map((v, i) => this.headFilters[i].filter(v, t));
      head = new Quaternion(comps[0], comps[1], comps[2], comps[3]).normalize();
      this.lastHead.copy(head);
      const cp = this.calibration.headPos;
      const p = pose.position.clone();
      if (cp) p.sub(new Vector3(cp[0], cp[1], cp[2]));
      headPos.set(this.posFilters[0].filter(p.x, t), this.posFilters[1].filter(p.y, t), this.posFilters[2].filter(p.z, t));
    }

    // Gaze from the calibrated (pre-gain) values so gains don't skew direction.
    const gz = gazeFromBlendshapes(bs);
    const g0 = this.calibration.gaze ?? { yaw: 0, pitch: 0 };
    const gaze = {
      yaw: this.gazeFilters[0].filter(gz.yaw - g0.yaw, t),
      pitch: this.gazeFilters[1].filter(gz.pitch - g0.pitch, t),
    };

    this.state = { raw: bs, values, head, headPos, gaze, t };
    return this.state;
  }
}
