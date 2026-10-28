/**
 * Cheap, reliable checks for model-authoring problems Puppet can see but
 * should not silently "fix": a face modelled on the back of the skeleton, a
 * rig that faces away from the camera, a rest pose that is not the T-pose the
 * VRM spec asks for, humanoid bones Puppet needs that are missing.
 *
 * Pure (plain numbers in, plain data out) so they are unit-tested with
 * synthetic rigs. The three.js side that gathers the numbers is
 * gatherModelFacts() in avatar.ts.
 */

export type V3 = [number, number, number];

/** Bones the solver and framing cannot do without. */
export const PUPPET_REQUIRED_BONES = [
  'hips', 'spine', 'head',
  'leftUpperArm', 'leftLowerArm', 'leftHand',
  'rightUpperArm', 'rightLowerArm', 'rightHand',
] as const;

/** Bones Puppet uses when present (body follow, shoulders, eyes, fingers). */
export const PUPPET_OPTIONAL_BONES = [
  'chest', 'upperChest', 'neck', 'leftShoulder', 'rightShoulder', 'leftEye', 'rightEye', 'jaw',
  'leftUpperLeg', 'rightUpperLeg',
  'leftThumbProximal', 'leftIndexProximal', 'leftMiddleProximal', 'leftRingProximal', 'leftLittleProximal',
  'rightThumbProximal', 'rightIndexProximal', 'rightMiddleProximal', 'rightRingProximal', 'rightLittleProximal',
] as const;

export function boneCoverage(present: Iterable<string>): { missingRequired: string[]; missingOptional: string[]; fingers: boolean } {
  const has = new Set(present);
  const missingRequired = PUPPET_REQUIRED_BONES.filter((b) => !has.has(b));
  const missingOptional = PUPPET_OPTIONAL_BONES.filter((b) => !has.has(b));
  const fingers = ['left', 'right'].every((s) => ['Index', 'Middle'].every((f) => has.has(`${s}${f}Proximal`)));
  return { missingRequired, missingOptional, fingers };
}

export type RestPose = 'T' | 'A' | 'other';

/**
 * Classify the rest pose from the upper-arm directions (avatar space, y up).
 * T: arms within 20 degrees of horizontal. A: 20-65 degrees down. Anything
 * else (arms up, forward, straight down) is "other".
 */
export function classifyRestPose(leftUpperArm?: V3, rightUpperArm?: V3): { pose: RestPose; droopDeg: number } | null {
  const arms = [leftUpperArm, rightUpperArm].filter((a): a is V3 => !!a);
  if (!arms.length) return null;
  let droop = 0;
  let forward = 0;
  for (const a of arms) {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    droop += (Math.asin(Math.max(-1, Math.min(1, -a[1] / l))) * 180) / Math.PI;
    forward += Math.abs(a[2] / l);
  }
  droop /= arms.length;
  forward /= arms.length;
  const pose: RestPose = forward > 0.5 ? 'other' : Math.abs(droop) <= 20 ? 'T' : droop > 20 && droop <= 65 ? 'A' : 'other';
  return { pose, droopDeg: Math.round(droop) };
}

/**
 * Which way the skeleton faces along Z, from the left/right bones' X: a rig
 * facing +Z has its LEFT side at +X. Returns +1 (+Z), -1 (-Z) or 0 (unknown).
 */
export function skeletonFacing(pairs: Array<[V3 | undefined, V3 | undefined]>): 1 | -1 | 0 {
  let s = 0;
  for (const [l, r] of pairs) if (l && r) s += l[0] - r[0];
  return s > 1e-4 ? 1 : s < -1e-4 ? -1 : 0;
}

/**
 * Horizontal direction (x, z) from the head to the face: the centroid of the
 * points that make the face (vertices moved by expression morphs, or the eye
 * bones), weighted. null when there are no points or they sit on the head's
 * vertical axis.
 */
export function faceDirection(head: V3, points: V3[], weights?: number[]): [number, number] | null {
  let x = 0;
  let z = 0;
  let w = 0;
  points.forEach((p, i) => {
    const k = weights?.[i] ?? 1;
    x += (p[0] - head[0]) * k;
    z += (p[2] - head[2]) * k;
    w += k;
  });
  if (!w) return null;
  x /= w;
  z /= w;
  const l = Math.hypot(x, z);
  // Under 5 mm off the head axis: no reliable direction.
  if (l < 0.005) return null;
  return [x / l, z / l];
}

export interface ModelWarning {
  code: 'face-backwards' | 'faces-away' | 'missing-bones' | 'rest-not-t' | 'no-expressions' | 'empty-expressions';
  /** Short label for a badge or a MODEL INFO line (upper case, like the rest of the UI). */
  text: string;
  /** One sentence on what it means for the user. */
  detail: string;
}

export interface ModelFacts {
  /** Skeleton facing along Z in the stage's space (the camera looks from +Z). */
  facing: 1 | -1 | 0;
  /** Face direction (x, z) in the same space, or null if unknown. */
  face: [number, number] | null;
  missingRequired: string[];
  rest: { pose: RestPose; droopDeg: number } | null;
  expressions: number;
  /** Expressions that bind something (a morph, a material colour, a texture offset). */
  boundExpressions: number;
}

/** The problems worth telling the user about, most serious first. */
export function modelWarnings(f: ModelFacts): ModelWarning[] {
  const out: ModelWarning[] = [];
  if (f.facing === -1) {
    out.push({
      code: 'faces-away',
      text: 'MODEL FACES AWAY FROM THE CAMERA',
      detail: 'The skeleton faces the wrong way for its VRM version: you will see its back. Re-export it facing forward.',
    });
  }
  if (f.face && f.facing !== 0 && f.face[1] * f.facing < -0.5) {
    out.push({
      code: 'face-backwards',
      text: 'FACE POINTS AWAY FROM SKELETON',
      detail: 'The face is modelled on the back of the head bone: turning your head turns its face the other way. The model needs fixing in its editor.',
    });
  }
  if (f.missingRequired.length) {
    out.push({
      code: 'missing-bones',
      text: `MISSING BONES: ${f.missingRequired.join(', ').toUpperCase()}`,
      detail: 'Puppet cannot drive these parts of the body.',
    });
  }
  if (f.rest && f.rest.pose !== 'T') {
    out.push({
      code: 'rest-not-t',
      text: `REST POSE IS ${f.rest.pose === 'A' ? 'A-POSE' : 'NOT A T-POSE'} (ARMS ${f.rest.droopDeg}° DOWN)`,
      detail: 'VRM asks for a T-pose rest. Puppet copes, but clips and other apps may pose the arms oddly.',
    });
  }
  if (f.expressions === 0) {
    out.push({
      code: 'no-expressions',
      text: 'NO FACE EXPRESSIONS',
      detail: 'The model defines no expressions, so face tracking can only turn the head.',
    });
  } else if (f.boundExpressions === 0) {
    out.push({
      code: 'empty-expressions',
      text: 'FACE EXPRESSIONS ARE EMPTY',
      detail: `The model lists ${f.expressions} expressions but none of them moves anything, so face tracking can only turn the head. Bind them to the face's blend shapes in its editor.`,
    });
  }
  return out;
}
