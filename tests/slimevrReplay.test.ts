/**
 * Replays real SlimeVR VMC output (recorded by scripts/slimevr-rig.mjs with
 * emulated trackers, scripts/fixtures/slimevr-*.jsonl) through VPuppet's VMC
 * input and checks the legs and torso end up where the motion puts them, in
 * the avatar's own +Z-facing space. This pins the Unity -> three conversion
 * against what a real sender emits (SlimeVR writes most rotations with w < 0).
 */
import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SOURCES, VmcInput, type Transform7, type VmcInFrame } from '../src/vmc/vmcInput';

// Node's fs without pulling @types/node into the app's tsconfig.
const fsName = 'node:fs';
const { readFileSync } = (await import(/* @vite-ignore */ fsName)) as { readFileSync(p: URL, enc: 'utf8'): string };

interface Line {
  t: number;
  d: number;
  address: string;
  args: (string | number)[];
}

/** The fixture as complete frames (one SlimeVR bundle each), like the Rust receiver builds them. */
function frames(motion: string): { t: number; frame: VmcInFrame }[] {
  const lines = readFileSync(new URL(`../scripts/fixtures/slimevr-${motion}.jsonl`, import.meta.url), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((l): l is Line => 'address' in l);
  const out: { t: number; frame: VmcInFrame }[] = [];
  let cur: { d: number; t: number; frame: VmcInFrame } | null = null;
  for (const l of lines) {
    if (!cur || cur.d !== l.d) {
      if (cur) out.push(cur);
      cur = { d: l.d, t: l.t, frame: { seq: out.length + 1, bones: {}, root: null, blends: {}, t: null, loaded: null, tracking: null } };
    }
    if (l.address === '/VMC/Ext/Bone/Pos') cur.frame.bones[l.args[0] as string] = l.args.slice(1, 8) as Transform7;
  }
  if (cur) out.push(cur);
  return out;
}

const avatar = { expressionNames: [], perfectSync: new Map(), hasBone: () => true };
const DOWN = new Vector3(0, -1, 0);
const UP = new Vector3(0, 1, 0);

/** World directions (avatar space, faces +Z) of the left thigh and shin, and the spine's up. */
function shape(f: VmcInFrame) {
  const v = new VmcInput();
  v.set(f, 0);
  const p = v.pose({ ...DEFAULT_SOURCES, torso: 'vmc', legs: 'vmc' }, avatar, 1)!;
  const q = (b: string) => p.bones.get(b) ?? new Quaternion();
  const hips = q('hips');
  const thigh = hips.clone().multiply(q('leftUpperLeg'));
  const shin = thigh.clone().multiply(q('leftLowerLeg'));
  const spine = hips.clone().multiply(q('spine'));
  return {
    thigh: DOWN.clone().applyQuaternion(thigh),
    shin: DOWN.clone().applyQuaternion(shin),
    spine: UP.clone().applyQuaternion(spine),
  };
}

const deg = (a: Vector3, b: Vector3) => (a.angleTo(b) * 180) / Math.PI;
const last = (m: string) => frames(m).at(-1)!.frame;

describe('SlimeVR replay', () => {
  it('has complete frames with the 20 SlimeVR bones', () => {
    const f = frames('idle');
    expect(f.length).toBeGreaterThan(100);
    expect(Object.keys(f[0].frame.bones)).toHaveLength(20);
  });

  it('idle stands: legs straight down, spine up', () => {
    const s = shape(last('idle'));
    expect(deg(s.thigh, DOWN)).toBeLessThan(10);
    expect(deg(s.shin, DOWN)).toBeLessThan(10);
    expect(deg(s.spine, UP)).toBeLessThan(10);
  });

  it('sit: thighs forward (toward the camera, +Z), shins down', () => {
    // Settled seated frame: the motion sits down over the first seconds.
    const s = shape(last('sit'));
    expect(s.thigh.z).toBeGreaterThan(0.8);
    expect(Math.abs(s.thigh.y)).toBeLessThan(0.4);
    expect(s.shin.y).toBeLessThan(-0.8);
  });

  it('squat: the deepest frame bends the knees forward and the shin back toward vertical', () => {
    // Deepest point = the thigh furthest from straight down.
    const deepest = frames('squat')
      .map((f) => shape(f.frame))
      .reduce((a, b) => (deg(b.thigh, DOWN) > deg(a.thigh, DOWN) ? b : a));
    expect(deepest.thigh.z).toBeGreaterThan(0.7); // knees forward
    expect(deepest.shin.z).toBeLessThan(deepest.thigh.z); // knee bends back
  });

  it('walk: the thighs swing forward of vertical in turn, never backward far', () => {
    const fs = frames('walk').map((f) => shape(f.frame));
    const zs = fs.map((s) => s.thigh.z);
    expect(Math.max(...zs)).toBeGreaterThan(0.4);
    expect(Math.min(...zs)).toBeGreaterThan(-0.3);
  });

  it('lean: the spine tips to both sides', () => {
    const xs = frames('lean').map((f) => shape(f.frame).spine.x);
    expect(Math.max(...xs)).toBeGreaterThan(0.1);
    expect(Math.min(...xs)).toBeLessThan(-0.1);
  });
});
