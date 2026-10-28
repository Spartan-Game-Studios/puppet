// Regression tests for problems the VRM compatibility sweep found
// (scripts/compat-sweep.mjs). Synthetic data only: no model files.
import { describe, expect, it } from 'vitest';
import { Box3, Vector3 } from 'three';
import { boneCoverage, classifyRestPose, faceDirection, modelWarnings, skeletonFacing, type ModelFacts } from '../src/scene/modelChecks';
import { framingFor, framingScale } from '../src/scene/viewer';
import { idlePoseIsRest } from '../src/physics/cloth/rig';
import { shouldUseExpressionLookAt } from '../src/scene/lookAtFallback';

const human = (): ModelFacts => ({ facing: 1, face: [0, 1], missingRequired: [], rest: { pose: 'T', droopDeg: 0 }, expressions: 17, boundExpressions: 17 });

describe('model checks', () => {
  it('rest pose: T, A and other from the upper-arm directions', () => {
    expect(classifyRestPose([1, 0, 0], [-1, 0, 0])?.pose).toBe('T');
    const a = Math.sin((40 * Math.PI) / 180);
    expect(classifyRestPose([Math.cos((40 * Math.PI) / 180), -a, 0], [-Math.cos((40 * Math.PI) / 180), -a, 0])).toEqual({ pose: 'A', droopDeg: 40 });
    expect(classifyRestPose([0.1, -1, 0], [-0.1, -1, 0])?.pose).toBe('other'); // arms straight down
    expect(classifyRestPose([0.3, 0, 1], [-0.3, 0, 1])?.pose).toBe('other'); // arms forward
    expect(classifyRestPose(undefined, undefined)).toBeNull();
  });

  it('skeleton facing from left/right bones', () => {
    // Facing +Z: the avatar's left side is at +X.
    expect(skeletonFacing([[[0.1, 1, 0], [-0.1, 1, 0]]])).toBe(1);
    expect(skeletonFacing([[[-0.1, 1, 0], [0.1, 1, 0]]])).toBe(-1);
    expect(skeletonFacing([[undefined, [0.1, 1, 0]]])).toBe(0);
  });

  it('face direction from face points around the head', () => {
    const head: [number, number, number] = [0, 1.5, 0];
    expect(faceDirection(head, [[0.02, 1.55, 0.09], [-0.02, 1.55, 0.09], [0, 1.5, 0.1]])).toEqual([expect.closeTo(0, 5), expect.closeTo(1, 5)]);
    expect(faceDirection(head, [[0, 1.55, -0.09]])![1]).toBeLessThan(-0.99);
    expect(faceDirection(head, [[0.001, 1.6, 0.001]])).toBeNull(); // on the head axis
    expect(faceDirection(head, [])).toBeNull();
  });

  it('warns when the face is on the back of the skeleton', () => {
    expect(modelWarnings(human())).toEqual([]);
    const w = modelWarnings({ ...human(), face: [0.05, -0.99] });
    expect(w.map((x) => x.text)).toEqual(['FACE POINTS AWAY FROM SKELETON']);
    // Unknown facing: no claim about the face.
    expect(modelWarnings({ ...human(), facing: 0, face: [0, -1] })).toEqual([]);
  });

  it('warns when the whole rig faces away, missing bones, A-pose rest, no expressions', () => {
    const codes = modelWarnings({ facing: -1, face: [0, -1], missingRequired: ['leftHand'], rest: { pose: 'A', droopDeg: 45 }, expressions: 0, boundExpressions: 0 }).map((w) => w.code);
    // Face and skeleton agree (both -Z): only "faces away", not "face backwards".
    expect(codes).toEqual(['faces-away', 'missing-bones', 'rest-not-t', 'no-expressions']);
  });

  it('warns when every expression is empty (listed but bound to nothing)', () => {
    expect(modelWarnings({ ...human(), boundExpressions: 0 }).map((w) => w.code)).toEqual(['empty-expressions']);
    expect(modelWarnings({ ...human(), boundExpressions: 3 })).toEqual([]);
  });

  it('bone coverage', () => {
    const c = boneCoverage(['hips', 'spine', 'head', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm']);
    expect(c.missingRequired).toEqual(['rightHand']);
    expect(c.fingers).toBe(false);
  });
});

describe('framing scales with the avatar', () => {
  // Idle-pose bounds (arms down): about a quarter of the height wide.
  const box = (h: number, front = 0.12) => new Box3(new Vector3(-0.2 * h, 0, -0.1 * h), new Vector3(0.2 * h, h, front * h));

  it('a human-sized avatar is framed exactly as before', () => {
    expect(framingScale(1.6)).toBe(1);
    expect(framingScale(1.3)).toBe(1);
    expect(framingScale(2.1)).toBe(1);
    const head = new Vector3(0, 1.45, 0);
    const bust = framingFor('bust', head, box(1.6), 28);
    expect(bust.target.y).toBeCloseTo(1.33);
    expect(bust.position.z).toBeCloseTo(1.25);
    const upper = framingFor('upper', head, box(1.6), 28);
    expect(upper.position.z).toBeCloseTo(2.1);
  });

  it('a 30 cm mascot fills the bust shot like a person does (was 1.25 m away: a speck)', () => {
    const h = 0.3;
    const head = new Vector3(0, 0.25, 0);
    const bust = framingFor('bust', head, box(h), 28);
    const s = h / 1.3;
    expect(bust.position.z).toBeCloseTo(1.25 * s);
    expect(bust.target.y).toBeCloseTo(0.25 - 0.12 * s);
    // The camera stays in front of the model.
    expect(bust.position.z).toBeGreaterThan(box(h).max.z);
  });

  it('a 2 m ball or an all-head mascot is not one patch of surface in BUST / UPPER', () => {
    const ball = new Box3(new Vector3(-1, 0, -1), new Vector3(1, 2, 1));
    const head = new Vector3(0, 1.6, 0);
    const tanHalf = Math.tan((14 * Math.PI) / 180);
    for (const f of ['bust', 'upper'] as const) {
      const { position } = framingFor(f, head, ball, 28);
      // At least 45% of its width fits vertically (the narrow way) from the camera's distance to its front.
      expect(((position.z - ball.max.z) * tanHalf * 2) / 2).toBeGreaterThanOrEqual(0.45 - 1e-9);
    }
    // A human in a wide gown is unaffected: 0.85 m wide (as measured on a VRM with a floor-length skirt).
    expect(framingFor('bust', new Vector3(0, 1.53, 0), new Box3(new Vector3(-0.39, 0, -0.31), new Vector3(0.45, 1.73, 0.23)), 28).position.z).toBeCloseTo(1.25);
  });

  it('a 4 m giant moves the camera back', () => {
    const head = new Vector3(0, 3.6, 0);
    const bust = framingFor('bust', head, box(4), 28);
    expect(bust.position.z).toBeCloseTo((1.25 * 4) / 2.1);
    expect(framingFor('full', head, box(4), 28).position.z).toBeGreaterThan(4.2);
  });
});

describe('cloth: idle pose counts as rest where the arms moved', () => {
  it('arm colliders vs a skirt or hair (as before)', () => {
    expect(idlePoseIsRest(true, 'hips')).toBe(true);
    expect(idlePoseIsRest(true, 'head')).toBe(true);
  });
  it('a body collider vs a forearm chain whose root ends up inside it (was: jittered forever at the hip)', () => {
    expect(idlePoseIsRest(false, 'leftLowerArm', true)).toBe(true);
    expect(idlePoseIsRest(false, 'rightHand', true)).toBe(true);
  });
  it('keeps contacts when the root is clear (a sleeve ribbon stays outside the hip)', () => {
    expect(idlePoseIsRest(false, 'leftLowerArm', false)).toBe(false);
  });
  it('pairs that move together keep the load-time rest only', () => {
    expect(idlePoseIsRest(true, 'leftLowerArm', true)).toBe(false);
    expect(idlePoseIsRest(false, 'hips', true)).toBe(false);
  });
});

describe('look-at fallback', () => {
  it('drives look expressions when a "bone" model has no eye bones (was: eyes never moved)', () => {
    expect(shouldUseExpressionLookAt({ applier: 'bone', hasEyeBones: false, boundLooks: 4 })).toBe(true);
  });
  it('leaves models with eye bones, expression look-at, or empty look expressions alone', () => {
    expect(shouldUseExpressionLookAt({ applier: 'bone', hasEyeBones: true, boundLooks: 4 })).toBe(false);
    expect(shouldUseExpressionLookAt({ applier: 'expression', hasEyeBones: false, boundLooks: 4 })).toBe(false);
    expect(shouldUseExpressionLookAt({ applier: 'bone', hasEyeBones: false, boundLooks: 0 })).toBe(false);
  });
});
