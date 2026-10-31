/**
 * Eyes for "bone" look-at models without eye bones.
 *
 * Several VRM 0.x exporters write `lookAtTypeName: Bone` by default even when
 * the model has no eye bones, while its LookUp/Down/Left/Right blend shapes
 * are bound and ready. three-vrm then drives bones that do not exist and the
 * eyes never move. When that is the case, VPuppet drives the look expressions
 * instead (the model already says how its eyes look around); it never touches
 * a model that has eye bones or whose look expressions are empty.
 */
import { VRMLookAtExpressionApplier, VRMLookAtRangeMap, type VRM } from '@pixiv/three-vrm';

/** Gaze angle (degrees) that fully applies a look expression. VPuppet's tracked gaze peaks near 30. */
export const LOOK_EXPRESSION_FULL_DEG = 25;

const LOOKS = ['lookUp', 'lookDown', 'lookLeft', 'lookRight'] as const;

export function shouldUseExpressionLookAt(o: { applier: string | null; hasEyeBones: boolean; boundLooks: number }): boolean {
  return o.applier === 'bone' && !o.hasEyeBones && o.boundLooks >= 2;
}

/** Switch to the expression applier when the bone one cannot move anything. Returns true if it did. */
export function applyLookAtFallback(vrm: VRM): boolean {
  const la = vrm.lookAt;
  const em = vrm.expressionManager;
  if (!la || !em) return false;
  const applier = (la.applier.constructor as unknown as { type?: string }).type ?? null;
  const h = vrm.humanoid;
  const hasEyeBones = !!(h.getRawBoneNode('leftEye') || h.getRawBoneNode('rightEye'));
  const boundLooks = LOOKS.filter((n) => {
    const e = em.getExpression(n);
    return !!e && ((e as unknown as { _binds?: unknown[] })._binds ?? []).length > 0;
  }).length;
  if (!shouldUseExpressionLookAt({ applier, hasEyeBones, boundLooks })) return false;
  const map = () => new VRMLookAtRangeMap(LOOK_EXPRESSION_FULL_DEG, 1);
  la.applier = new VRMLookAtExpressionApplier(em, map(), map(), map(), map());
  return true;
}
