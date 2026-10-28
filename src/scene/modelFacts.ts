/**
 * Gather the numbers src/scene/modelChecks.ts judges, from a loaded VRM in the
 * stage's space (after VRMUtils.rotateVRM0: the camera looks from +Z).
 */
import { Mesh, SkinnedMesh, Vector3, type BufferAttribute, type Object3D } from 'three';
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';
import { boneCoverage, classifyRestPose, faceDirection, modelWarnings, skeletonFacing, type ModelFacts, type ModelWarning, type V3 } from './modelChecks';

const arr = (v: Vector3): V3 => [v.x, v.y, v.z];

/** Points on the face: vertices that expression morphs move, weighted by how far. */
function expressionMorphPoints(vrm: VRM, maxPoints = 6000): { points: V3[]; weights: number[] } {
  const points: V3[] = [];
  const weights: number[] = [];
  // mesh -> morph indices bound by any expression
  const bound = new Map<Mesh, Set<number>>();
  for (const e of vrm.expressionManager?.expressions ?? []) {
    for (const b of ((e as unknown as { _binds?: unknown[] })._binds ?? []) as Array<{ primitives?: Mesh[]; index?: number }>) {
      if (!b.primitives || typeof b.index !== 'number') continue;
      for (const p of b.primitives) {
        if (!bound.has(p)) bound.set(p, new Set());
        bound.get(p)!.add(b.index);
      }
    }
  }
  const v = new Vector3();
  const d = new Vector3();
  let total = 0;
  for (const [m, idx] of bound) total += m.geometry.attributes.position.count * idx.size;
  const step = Math.max(1, Math.floor(total / maxPoints));
  for (const [m, idx] of bound) {
    const morphs = m.geometry.morphAttributes.position as BufferAttribute[] | undefined;
    if (!morphs) continue;
    const relative = m.geometry.morphTargetsRelative;
    const base = m.geometry.attributes.position as BufferAttribute;
    m.updateWorldMatrix(true, false);
    for (const k of idx) {
      const t = morphs[k];
      if (!t) continue;
      for (let i = 0; i < t.count; i += step) {
        d.fromBufferAttribute(t, i);
        if (!relative) d.sub(v.fromBufferAttribute(base, i));
        const w = d.length();
        if (w < 1e-5 || !Number.isFinite(w)) continue;
        v.fromBufferAttribute(base, i);
        if ((m as SkinnedMesh).isSkinnedMesh) (m as SkinnedMesh).applyBoneTransform(i, v);
        v.applyMatrix4(m.matrixWorld);
        points.push(arr(v));
        weights.push(w);
      }
    }
  }
  return { points, weights };
}

export interface GatheredFacts extends ModelFacts {
  /** Where the face direction came from. */
  faceFrom: 'morphs' | 'eyes' | null;
  missingOptional: string[];
  fingers: boolean;
  warnings: ModelWarning[];
}

/**
 * Measure the model at its rest pose (after VRMUtils.rotateVRM0). The current
 * normalized pose is restored afterwards.
 */
export function gatherModelFacts(vrm: VRM): GatheredFacts {
  const h = vrm.humanoid;
  // Measure the rest pose; put back whatever pose the model was in.
  const saved = h.getNormalizedPose();
  h.resetNormalizedPose();
  h.update();
  vrm.scene.updateMatrixWorld(true);
  try {
    return measure(vrm);
  } finally {
    h.setNormalizedPose(saved);
    h.update();
    vrm.scene.updateMatrixWorld(true);
  }
}

function measure(vrm: VRM): GatheredFacts {
  const h = vrm.humanoid;
  const node = (b: string): Object3D | null => h.getNormalizedBoneNode(b as VRMHumanBoneName) ?? null;
  const pos = (b: string): V3 | undefined => {
    const n = node(b);
    return n ? arr(n.getWorldPosition(new Vector3())) : undefined;
  };
  // Positions and directions in the stage's space (what the camera sees).
  const dir = (a: string, b: string): V3 | undefined => {
    const pa = pos(a);
    const pb = pos(b);
    if (!pa || !pb) return undefined;
    const v = new Vector3(pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]);
    return v.lengthSq() > 1e-10 ? arr(v.normalize()) : undefined;
  };
  const facing = skeletonFacing([
    [pos('leftUpperLeg'), pos('rightUpperLeg')],
    [pos('leftUpperArm'), pos('rightUpperArm')],
    [pos('leftShoulder'), pos('rightShoulder')],
  ]);
  // Arm droop only uses y and |z|, so the facing does not matter here.
  const rest = classifyRestPose(dir('leftUpperArm', 'leftLowerArm'), dir('rightUpperArm', 'rightLowerArm'));

  const head = pos('head');
  let face: [number, number] | null = null;
  let faceFrom: GatheredFacts['faceFrom'] = null;
  if (head) {
    const { points, weights } = expressionMorphPoints(vrm);
    if (points.length >= 8) {
      face = faceDirection(head, points, weights);
      if (face) faceFrom = 'morphs';
    }
    if (!face) {
      const eyes = [pos('leftEye'), pos('rightEye')].filter((p): p is V3 => !!p);
      if (eyes.length) {
        face = faceDirection(head, eyes);
        if (face) faceFrom = 'eyes';
      }
    }
  }
  const present = Object.keys(h.humanBones).filter((b) => node(b));
  const cov = boneCoverage(present);
  const facts: ModelFacts = {
    facing,
    face,
    missingRequired: cov.missingRequired,
    rest,
    expressions: vrm.expressionManager?.expressions.length ?? 0,
    boundExpressions: (vrm.expressionManager?.expressions ?? []).filter((e) => ((e as unknown as { _binds?: unknown[] })._binds ?? []).length > 0).length,
  };
  return { ...facts, faceFrom, missingOptional: cov.missingOptional, fingers: cov.fingers, warnings: modelWarnings(facts) };
}

/** Largest skeleton after VRMUtils.combineSkeletons (over 256 needs 16-bit skin indices). */
export function maxSkinBones(root: Object3D): number {
  let n = 0;
  root.traverse((o) => {
    const m = o as SkinnedMesh;
    if (m.isSkinnedMesh) n = Math.max(n, m.skeleton.bones.length);
  });
  return n;
}
