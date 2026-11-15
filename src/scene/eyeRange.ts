/**
 * Eye range: how far the avatar's eyes turn for the user's gaze.
 *
 * A VRM's look-at range maps follow the "look at a target" convention: the
 * eyes turn `outputScale` (degrees for eye bones, weight for look expressions)
 * when the target is `inputMaxValue` degrees away, usually 90. VPuppet feeds
 * the user's own eye angle instead, which peaks near 30 sideways and 25 up or
 * down (`gazeFromBlendshapes`), so with the convention every model used about
 * a third of its range and the eyes barely moved.
 *
 * `prepareEyeRange` sets the input side of all four maps to that tracked
 * range, so a full glance reaches the model's own limit. `setEyeRange` lets
 * the user change the limit itself (eye-bone models, in degrees; saved per
 * model): `h` is the outer horizontal limit, `v` the larger of up / down, and
 * the model's own inner / outer and up / down proportions are kept.
 */
import type { VRM, VRMLookAtRangeMap } from '@pixiv/three-vrm';
import { GAZE_MAX_PITCH, GAZE_MAX_YAW } from '../core/blendshapes';

/** null: the model's own limit. */
export interface EyeRange {
  h: number | null;
  v: number | null;
}

export interface EyeLimits {
  /** 'bone' (degrees) or 'expression' (weights); null without look-at. */
  kind: 'bone' | 'expression' | null;
  /** The model's own limits, as `EyeRange` measures them. */
  h: number;
  v: number;
}

interface Maps {
  rangeMapHorizontalInner: VRMLookAtRangeMap;
  rangeMapHorizontalOuter: VRMLookAtRangeMap;
  rangeMapVerticalDown: VRMLookAtRangeMap;
  rangeMapVerticalUp: VRMLookAtRangeMap;
}

/** The model's own output scales, kept so a limit can always go back to them. */
const BASE = new WeakMap<object, { inner: number; outer: number; down: number; up: number }>();

function maps(vrm: VRM): Maps | null {
  const a = vrm.lookAt?.applier as unknown as Partial<Maps> | undefined;
  return a?.rangeMapHorizontalInner && a.rangeMapHorizontalOuter && a.rangeMapVerticalDown && a.rangeMapVerticalUp ? (a as Maps) : null;
}

/** Call once after load (and after any applier swap): map the tracked gaze range onto the model's range. */
export function prepareEyeRange(vrm: VRM): EyeLimits {
  const m = maps(vrm);
  if (!m) return { kind: null, h: 0, v: 0 };
  const type = (vrm.lookAt!.applier.constructor as unknown as { type?: string }).type;
  const base = {
    inner: m.rangeMapHorizontalInner.outputScale,
    outer: m.rangeMapHorizontalOuter.outputScale,
    down: m.rangeMapVerticalDown.outputScale,
    up: m.rangeMapVerticalUp.outputScale,
  };
  BASE.set(m, base);
  m.rangeMapHorizontalInner.inputMaxValue = GAZE_MAX_YAW;
  m.rangeMapHorizontalOuter.inputMaxValue = GAZE_MAX_YAW;
  m.rangeMapVerticalDown.inputMaxValue = GAZE_MAX_PITCH;
  m.rangeMapVerticalUp.inputMaxValue = GAZE_MAX_PITCH;
  return { kind: type === 'expression' ? 'expression' : 'bone', h: base.outer, v: Math.max(base.up, base.down) };
}

/** Apply a user limit (eye-bone models only; look expressions keep the model's weights). */
export function setEyeRange(vrm: VRM, range: EyeRange): void {
  const m = maps(vrm);
  const base = m && BASE.get(m);
  if (!m || !base) return;
  const kind = (vrm.lookAt!.applier.constructor as unknown as { type?: string }).type;
  const h = kind === 'expression' || range.h == null ? base.outer : range.h;
  const v = kind === 'expression' || range.v == null ? Math.max(base.up, base.down) : range.v;
  // Keep the model's inner / outer and up / down proportions (both equal if it had none).
  const vmax = Math.max(base.up, base.down);
  m.rangeMapHorizontalOuter.outputScale = h;
  m.rangeMapHorizontalInner.outputScale = base.outer > 0 ? (base.inner * h) / base.outer : h;
  m.rangeMapVerticalUp.outputScale = vmax > 0 ? (base.up * v) / vmax : v;
  m.rangeMapVerticalDown.outputScale = vmax > 0 ? (base.down * v) / vmax : v;
}
