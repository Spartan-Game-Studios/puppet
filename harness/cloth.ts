/**
 * Cloth physics benchmark: drives a VRM through scripted (or recorded)
 * motion in virtual time and measures what makes spring cloth look bad:
 *
 *  - clipping: cloth bone segments, and cloth-skinned mesh vertices, inside
 *    the body (the "core" of capsules fitted to the body mesh, see
 *    src/physics/cloth/bodyColliders.ts), beyond whatever already overlaps
 *    at rest; count and max depth;
 *  - splay / bunching: how far neighbouring cloth chains drift from their
 *    rest spacing (relative error);
 *  - tail speed relative to the hips (thrash), settle time, jitter at rest;
 *  - CPU time of the physics update per frame.
 *
 * Optionally renders frames (three-quarter view of skirt and legs) for the
 * side-by-side videos. Driven by scripts/cloth-test.mjs through
 * window.__cloth.
 */
import {
  AmbientLight,
  Color,
  DirectionalLight,
  Euler,
  Matrix4,
  Object3D,
  PerspectiveCamera,
  Quaternion,
  Scene,
  SkinnedMesh,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { VRMHumanBoneName } from '@pixiv/three-vrm';
import { loadAvatar, type Avatar } from '../src/scene/avatar';
import { DEFAULT_PHYSICS, type PhysicsSettings } from '../src/physics/stableSprings';
import { closestSegSeg } from '../src/physics/cloth/solver';
import { OneEuroFilter } from '../src/core/oneEuro';

// ---------------------------------------------------------------- conditions
export const CONDITIONS: Record<string, Partial<PhysicsSettings>> = {
  /** main as it was: legacy solver and the old loader (skin index overflow). */
  main: { solver: 'legacy' },
  /** legacy solver with the loader fix, to separate the two changes. */
  legacy: { solver: 'legacy' },
  cloth: { solver: 'cloth' },
  off: { mode: 'off' },
};

// ---------------------------------------------------------------- scenarios
interface Drive {
  /** Normalized-bone local rotations to set this frame (others stay at idle). */
  bones: Partial<Record<VRMHumanBoneName, Quaternion>>;
  /** Root (vrm.scene) offset and rotation. */
  rootPos?: Vector3;
  rootRot?: Quaternion;
}
interface Scenario {
  name: string;
  /** Seconds of motion, then stillness until `duration`. */
  motionEnd: number;
  duration: number;
  /** Frame time for the frame starting at t. */
  dt: (t: number, rand: () => number) => number;
  drive: (t: number, rand: () => number) => Drive;
}

const D2R = Math.PI / 180;
const qe = (x: number, y: number, z: number) => new Quaternion().setFromEuler(new Euler(x * D2R, y * D2R, z * D2R, 'YXZ'));
const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
/** 0 outside [a, b], 1 inside, eased over `r` seconds at each end. */
const win = (t: number, a: number, b: number, r = 0.4) => Math.min(smooth((t - a) / r), smooth((b - t) / r));

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const steadyDt = (_t: number, rand: () => number) => 1 / 60 + (rand() - 0.5) * 0.004;

/** Hips rotation with the legs kept planted (legs counter-rotate), plus spine share. */
function hipsDrive(hips: Quaternion, spine = new Quaternion()): Drive {
  const inv = hips.clone().invert();
  return { bones: { hips, spine, leftUpperLeg: inv.clone(), rightUpperLeg: inv.clone() } };
}

const idleArm = (side: 1 | -1) => new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -side * 1.25);

function makeScenarios(recorded: RecordedPose | null): Record<string, Scenario> {
  const filters = () => Array.from({ length: 6 }, () => new OneEuroFilter({ minCutoff: 1.2, beta: 0.3, dCutoff: 1 }));
  let shakeF = filters();
  let nextSpike = 0.7;
  let nextTrack = 0;
  let jp = new Vector3();
  let jr = new Vector3();
  const sc: Record<string, Scenario> = {
    // The existing physics-test motion (root sway + shake + tracking jitter + hitches), root-smoothed as the app does.
    shake: {
      name: 'shake',
      motionEnd: 6,
      duration: 12,
      dt: (t, rand) => {
        if (t === 0) {
          nextSpike = 0.7;
          nextTrack = 0;
          shakeF = filters();
        }
        if (t >= nextSpike && t < 7) {
          nextSpike = t + 0.9 + rand() * 0.8;
          return 0.06 + rand() * 0.06;
        }
        return steadyDt(t, rand);
      },
      drive: (t, rand) => {
        const pos = new Vector3();
        const eul = new Vector3();
        if (t < 6) {
          const env = Math.min(1, t / 0.5);
          pos.set(0.08 * Math.sin(2 * Math.PI * 0.6 * t) + 0.025 * Math.sin(2 * Math.PI * 3.1 * t), 0.015 * Math.sin(2 * Math.PI * 2.3 * t), 0.02 * Math.sin(2 * Math.PI * 1.7 * t)).multiplyScalar(env);
          eul.set(0.05 * Math.sin(2 * Math.PI * 1.3 * t), 0.25 * Math.sin(2 * Math.PI * 0.6 * t) + 0.08 * Math.sin(2 * Math.PI * 2.9 * t), 0.06 * Math.sin(2 * Math.PI * 1.1 * t)).multiplyScalar(env);
          if (t >= nextTrack) {
            nextTrack = t + 1 / 30;
            jp = new Vector3((rand() - 0.5) * 0.012, (rand() - 0.5) * 0.006, (rand() - 0.5) * 0.012);
            jr = new Vector3((rand() - 0.5) * 0.03, (rand() - 0.5) * 0.05, (rand() - 0.5) * 0.03);
          }
          pos.add(jp);
          eul.add(jr);
        }
        const v = [pos.x, pos.y, pos.z, eul.x, eul.y, eul.z].map((x, i) => shakeF[i].filter(x, t + 1e-6));
        return { bones: {}, rootPos: new Vector3(v[0], v[1], v[2]), rootRot: new Quaternion().setFromEuler(new Euler(v[3], v[4], v[5])) };
      },
    },
    // Hips turning, leaning and bending over planted legs.
    lean: {
      name: 'lean',
      motionEnd: 9,
      duration: 13,
      dt: steadyDt,
      drive: (t) => {
        let yaw = 0, roll = 0, pitch = 0;
        // 0.5-3.0 yaw +-25 (0.4 Hz), 3.0-5.0 roll +-15 (0.5 Hz), 5.0-6.6 bend forward 25,
        // 6.6-9.0 quick combined twist (1 Hz) dying out.
        yaw += 25 * Math.sin(2 * Math.PI * 0.4 * (t - 0.5)) * win(t, 0.5, 3.0, 0.5);
        roll += 15 * Math.sin(2 * Math.PI * 0.5 * (t - 3.0)) * win(t, 3.0, 5.0, 0.4);
        pitch += 25 * win(t, 5.0, 6.6, 0.5);
        const k = win(t, 6.6, 9.0, 0.3);
        yaw += 20 * Math.sin(2 * Math.PI * 1.0 * (t - 6.6)) * k;
        roll += 8 * Math.sin(2 * Math.PI * 1.0 * (t - 6.85)) * k;
        const hips = qe(pitch * 0.7, yaw * 0.8, roll);
        const spine = qe(pitch * 0.3, yaw * 0.2, 0);
        return hipsDrive(hips, spine);
      },
    },
    // Head turns, nods, tilts and a fast shake, with the chest following a little (hair).
    head: {
      name: 'head',
      motionEnd: 7.5,
      duration: 11.5,
      dt: steadyDt,
      drive: (t) => {
        let yaw = 50 * Math.sin(2 * Math.PI * 0.5 * (t - 0.5)) * win(t, 0.5, 3.0, 0.4);
        const pitch = 25 * Math.sin(2 * Math.PI * 1.0 * (t - 3.0)) * win(t, 3.0, 4.5, 0.25);
        const roll = 20 * Math.sin(2 * Math.PI * 0.7 * (t - 4.5)) * win(t, 4.5, 6.0, 0.3);
        yaw += 30 * Math.sin(2 * Math.PI * 2.5 * (t - 6.0)) * win(t, 6.0, 7.5, 0.2);
        const h = qe(pitch, yaw, roll);
        return {
          bones: {
            neck: new Quaternion().slerp(h, 0.35),
            head: new Quaternion().slerp(h, 0.45),
            chest: new Quaternion().slerp(h, 0.12),
            spine: new Quaternion().slerp(h, 0.08),
          },
        };
      },
    },
    // Arms up overhead, swung forward and back, then dropped to the sides fast.
    arms: {
      name: 'arms',
      motionEnd: 6.5,
      duration: 10.5,
      dt: steadyDt,
      drive: (t) => {
        const bones: Drive['bones'] = {};
        for (const [side, s] of [['left', 1], ['right', -1]] as const) {
          const up = win(t, 0.5, 3.2, 0.7);
          const raise = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), s * 1.3 * up);
          const swingA = 65 * D2R * Math.sin(2 * Math.PI * 1.0 * (t - 3.2) + (s > 0 ? 0 : Math.PI)) * win(t, 3.2, 5.6, 0.3);
          const swing = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), swingA);
          // Fast drop at 5.6-5.85: a quick raise to 70 degrees then down.
          const flick = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), s * 0.9 * win(t, 5.6, 6.1, 0.12));
          bones[`${side}UpperArm`] = swing.multiply(flick).multiply(raise).multiply(idleArm(s));
        }
        return { bones };
      },
    },
    // Tracking hitches: snaps of the torso by 15-25 degrees in one frame and 150-300 ms stalls.
    hitch: {
      name: 'hitch',
      motionEnd: 6,
      duration: 10,
      dt: (t, rand) => {
        if (t > 0.6 && t < 6 && rand() < 0.025) return 0.15 + rand() * 0.15;
        return steadyDt(t, rand);
      },
      drive: (() => {
        let snapYaw = 0, snapRoll = 0, next = 0.8;
        return (t: number, rand: () => number) => {
          if (t < 0.02) {
            snapYaw = 0; snapRoll = 0; next = 0.8;
          }
          if (t < 6 && t >= next) {
            next = t + 0.5 + rand() * 0.6;
            snapYaw = (rand() < 0.5 ? -1 : 1) * (15 + rand() * 10);
            snapRoll = (rand() < 0.5 ? -1 : 1) * (5 + rand() * 8);
          }
          if (t >= 6) {
            snapYaw = 0; snapRoll = 0;
          }
          const base = 10 * Math.sin(2 * Math.PI * 0.5 * t) * (t < 6 ? 1 : 0);
          return hipsDrive(qe(0, (base + snapYaw) * 0.8, snapRoll), qe(0, (base + snapYaw) * 0.2, 0));
        };
      })(),
    },
  };
  if (recorded) {
    const fr = recorded.frames;
    const times: number[] = [];
    let acc = 0;
    for (const f of fr) {
      acc += f.dt;
      times.push(acc);
    }
    const end = times[times.length - 1];
    let idx = 0;
    sc.recorded = {
      name: 'recorded',
      motionEnd: end,
      duration: end + 3,
      dt: (t) => {
        if (t === 0) idx = 0;
        return idx < fr.length ? Math.min(0.25, Math.max(1 / 240, fr[idx].dt)) : 1 / 60;
      },
      drive: () => {
        const f = fr[Math.min(idx, fr.length - 1)];
        idx++;
        const bones: Drive['bones'] = {};
        for (const [k, q] of Object.entries(f.bones)) bones[k as VRMHumanBoneName] = new Quaternion(q[0], q[1], q[2], q[3]);
        return { bones };
      },
    };
  }
  return sc;
}

interface RecordedPose {
  vrm0?: boolean;
  frames: Array<{ dt: number; bones: Record<string, [number, number, number, number]> }>;
}

// ---------------------------------------------------------------- metrics setup
interface Seg {
  chain: string;
  head: Object3D;
  /** Tail object, or bone + local offset for a virtual tail. */
  tail: Object3D | null;
  tailLocal: Vector3;
  cloth: boolean;
  hair: boolean;
  /** Per core capsule: excluded because it already overlaps at rest. */
  restHit: boolean[];
}
interface CoreCap {
  name: string;
  /** Arms are reported separately (cloth vs hips, legs and torso is the main metric). */
  arm: boolean;
  bone: Object3D;
  a: Vector3;
  b: Vector3;
  r: number;
}
interface MeshSample {
  mesh: SkinnedMesh;
  index: number;
  restHit: boolean[];
}

const _a = new Vector3();
const _b = new Vector3();
const _h = new Vector3();
const _t = new Vector3();
const _p = new Vector3();
const _seg = new Float64Array(2);

function segWorld(s: Seg, h: Vector3, t: Vector3): void {
  s.head.getWorldPosition(h);
  if (s.tail) s.tail.getWorldPosition(t);
  else t.copy(s.tailLocal).applyMatrix4(s.head.matrixWorld);
}

function capWorld(c: CoreCap, a: Vector3, b: Vector3): void {
  a.copy(c.a).applyMatrix4(c.bone.matrixWorld);
  b.copy(c.b).applyMatrix4(c.bone.matrixWorld);
}

/** Penetration depth of segment h-t into capsule a-b of radius r (<= 0 = outside). */
function segPen(h: Vector3, t: Vector3, a: Vector3, b: Vector3, r: number): number {
  closestSegSeg(h.x, h.y, h.z, t.x, t.y, t.z, a.x, a.y, a.z, b.x, b.y, b.z, _seg);
  const s = _seg[0], u = _seg[1];
  const px = h.x + (t.x - h.x) * s, py = h.y + (t.y - h.y) * s, pz = h.z + (t.z - h.z) * s;
  const qx = a.x + (b.x - a.x) * u, qy = a.y + (b.y - a.y) * u, qz = a.z + (b.z - a.z) * u;
  return r - Math.hypot(px - qx, py - qy, pz - qz);
}

function pointPen(p: Vector3, a: Vector3, b: Vector3, r: number): number {
  return segPen(p, p, a, b, r);
}

function quant(a: number[], q: number): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

// ---------------------------------------------------------------- one run
interface RunOptions {
  condition: string;
  scenario: string;
  seed: number;
  render?: { w: number; h: number; fps: number; label?: string };
}

let renderer: WebGLRenderer | null = null;
const label = document.createElement('canvas');

async function runOne(buf: ArrayBuffer, recorded: RecordedPose | null, o: RunOptions, onFrame?: (png: string) => Promise<void>) {
  const settings: PhysicsSettings = { ...DEFAULT_PHYSICS, ...CONDITIONS[o.condition] };
  const { avatar } = await loadAvatar(buf.slice(0), settings, { widenSkin: o.condition !== 'main' });
  const vrm = avatar.vrm;
  (window as unknown as { __clothAvatar: Avatar }).__clothAvatar = avatar;
  const sc = makeScenarios(recorded)[o.scenario];
  // Recorded poses are normalized-bone rotations of the model they were recorded on
  // (converted when that model's VRM version differs from this one's).
  const recordedRun = o.scenario === 'recorded';
  if (!sc) throw new Error(`no scenario ${o.scenario}`);
  const rand = rng(o.seed);
  const ph = avatar.physics;
  const rig = ph.rig;

  // Idle pose (as the app starts) and settle 2 s before measuring.
  const nb = (n: VRMHumanBoneName) => vrm.humanoid.getNormalizedBoneNode(n);
  const idle = new Map<VRMHumanBoneName, Quaternion>();
  for (const name of avatar.humanBoneNames as VRMHumanBoneName[]) idle.set(name, nb(name)!.quaternion.clone());
  const apply = (d: Drive | null) => {
    for (const [n, q] of idle) nb(n)!.quaternion.copy(q);
    if (d) {
      for (const [n, q0] of Object.entries(d.bones)) {
        const node = nb(n as VRMHumanBoneName);
        if (!node || !q0) continue;
        // Scenario rotations are in the avatar-facing (VRM 1.0) frame; a VRM 0.x
        // model's normalized bones face -Z (see Avatar.toBone).
        const flip = recordedRun ? avatar.isVrm0 !== !!recorded?.vrm0 : avatar.isVrm0;
        const q = flip ? new Quaternion(-q0.x, q0.y, -q0.z, q0.w) : q0;
        // Arms are given absolute; torso/leg rotations multiply onto idle.
        if (/UpperArm/.test(n)) node.quaternion.copy(q);
        else node.quaternion.copy(idle.get(n as VRMHumanBoneName) ?? new Quaternion()).premultiply(q);
      }
      vrm.scene.position.copy(d.rootPos ?? new Vector3());
      vrm.scene.quaternion.copy(d.rootRot ?? new Quaternion());
    }
    vrm.scene.updateMatrixWorld(true);
    vrm.humanoid.update();
    vrm.scene.updateMatrixWorld(true);
  };
  apply(null);
  ph.reset();
  for (let i = 0; i < 120; i++) {
    apply(null);
    ph.update(1 / 60);
  }

  // Cloth = chains in groups of kind skirt/cape/sleeve (as detected by the cloth rig; same set for both solvers).
  // Classified per joint (strands of one spring name can differ).
  const clothJoints = new Set<unknown>();
  for (const g of rig?.groups ?? []) if (g.kind === 'skirt' || g.kind === 'cape' || g.kind === 'sleeve') for (const c of g.chains) for (const j of rig!.chains[c].joints) clothJoints.add(j);
  const hairJoints = new Set<unknown>();
  rig?.chainKinds.forEach((k, i) => k === 'hair' && rig.chains[i].joints.forEach((j) => hairJoints.add(j)));
  const coreCaps: CoreCap[] = ph.colliders
    .filter((c) => c.body)
    .map((c) => ({ name: c.name, arm: /Arm/.test(c.name), bone: c.body!.bone, a: c.body!.a, b: c.body!.b, r: c.body!.core }));

  // Rest reference: T-pose with springs at rest, for exclusions (what already
  // overlaps in the model as authored) and rest spacing.
  for (const n of idle.keys()) nb(n)!.quaternion.identity();
  vrm.humanoid.update();
  vrm.scene.updateMatrixWorld(true);
  vrm.springBoneManager?.reset();
  rig?.writeRest();
  vrm.scene.updateMatrixWorld(true);
  const segs: Seg[] = [];
  for (const ch of ph.chains) {
    for (const j of ch.joints) {
      const ji = j as unknown as { _initialLocalChildPosition: Vector3 };
      const s: Seg = { chain: ch.name, head: j.bone, tail: j.child, tailLocal: ji._initialLocalChildPosition.clone(), cloth: clothJoints.has(j), hair: hairJoints.has(j), restHit: [] };
      segWorld(s, _h, _t);
      for (const c of coreCaps) {
        capWorld(c, _a, _b);
        s.restHit.push(segPen(_h, _t, _a, _b, c.r) > -0.005);
      }
      segs.push(s);
    }
  }
  // Mesh samples: vertices mostly skinned to cloth bones.
  const clothBones = new Set<Object3D>();
  for (const ch of ph.chains) for (const j of ch.joints) if (clothJoints.has(j)) clothBones.add(j.bone);
  const samples: MeshSample[] = [];
  vrm.scene.traverse((obj) => {
    const m = obj as SkinnedMesh;
    if (!m.isSkinnedMesh) return;
    const si = m.geometry.getAttribute('skinIndex');
    const sw = m.geometry.getAttribute('skinWeight');
    const n = m.geometry.getAttribute('position')?.count ?? 0;
    for (let i = 0; i < n; i++) {
      let w = 0;
      for (let k = 0; k < 4; k++) if (clothBones.has(m.skeleton.bones[si.getComponent(i, k)])) w += sw.getComponent(i, k);
      if (w >= 0.5) samples.push({ mesh: m, index: i, restHit: [] });
    }
  });
  // Subsample to at most 3000.
  const step = Math.max(1, Math.ceil(samples.length / 3000));
  const msamp = samples.filter((_, i) => i % step === 0);
  for (const s of msamp) {
    s.mesh.getVertexPosition(s.index, _p).applyMatrix4(s.mesh.matrixWorld);
    for (const c of coreCaps) {
      capWorld(c, _a, _b);
      s.restHit.push(pointPen(_p, _a, _b, c.r) > -0.005);
    }
  }
  // Neighbour spacing pairs from the rig's groups.
  const pairs: Array<{ a: Object3D; b: Object3D; rest: number }> = [];
  if (rig) {
    for (const g of rig.groups) {
      // Sheets only (3+ chains): a pair of ribbons isn't a silhouette.
      if (!(g.kind === 'skirt' || g.kind === 'cape' || g.kind === 'sleeve') || g.chains.length < 3) continue;
      const n = g.chains.length;
      for (let i = 0; i < (g.closed ? n : n - 1); i++) {
        const A = rig.chainParticles[g.chains[i]];
        const B = rig.chainParticles[g.chains[(i + 1) % n]];
        for (let k = 1; k < A.length; k++) {
          const kb = Math.min(B.length - 1, Math.round((k * (B.length - 1)) / Math.max(1, A.length - 1)));
          const oa = rig.particleNode[A[k]], ob = rig.particleNode[B[kb]];
          if (!oa || !ob || kb < 1) continue;
          pairs.push({ a: oa, b: ob, rest: oa.getWorldPosition(_a).distanceTo(ob.getWorldPosition(_b)) });
        }
      }
    }
  }
  // Settle back from the rest snap.
  ph.reset();
  for (let i = 0; i < 180; i++) {
    apply(null);
    ph.update(1 / 60);
  }

  // Render setup.
  let scene: Scene | null = null;
  let camera: PerspectiveCamera | null = null;
  if (o.render) {
    if (!renderer) {
      renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
      renderer.outputColorSpace = SRGBColorSpace;
      renderer.setPixelRatio(1);
      document.body.appendChild(renderer.domElement);
    }
    renderer.setSize(o.render.w, o.render.h);
    scene = new Scene();
    scene.background = new Color('#8a8f96');
    const key = new DirectionalLight(0xffffff, Math.PI * 0.9);
    key.position.set(1.2, 2.0, 2.0);
    const fill = new DirectionalLight(0xffffff, Math.PI * 0.45);
    fill.position.set(-1.5, 1.0, 1.0);
    scene.add(key, fill, new AmbientLight(0xffffff, 0.6));
    scene.add(vrm.scene);
    const hips = vrm.humanoid.getRawBoneNode('hips')!.getWorldPosition(new Vector3());
    const head = vrm.humanoid.getRawBoneNode('head')!.getWorldPosition(new Vector3());
    const height = head.y + 0.15;
    camera = new PerspectiveCamera(30, o.render.w / o.render.h, 0.05, 30);
    // Three-quarter view from the front-left: the whole body (skirt and legs),
    // or head to hips for the hair scenarios.
    const upper = o.scenario === 'head' || o.scenario === 'recorded';
    const dist = (upper ? 1.15 : 2.15) * height;
    const az = (upper ? 40 : 55) * D2R;
    const target = upper ? new Vector3(0, (head.y + hips.y) / 2 + 0.05 * height, 0) : new Vector3(0, hips.y * 0.62, 0);
    camera.position.set(Math.sin(az) * dist, target.y + 0.12 * height, Math.cos(az) * dist);
    camera.lookAt(target);
  }

  // Run.
  const hipsRaw = vrm.humanoid.getRawBoneNode('hips')!;
  const joints = segs;
  const prev = joints.map(() => new Vector3());
  const inv = new Matrix4();
  let first = true;
  const frames: Array<{
    t: number;
    still: boolean;
    maxSpeed: number;
    clothSpeed: number;
    clipSegs: number;
    clipDepth: number;
    clipVerts: number;
    clipVertDepth: number;
    armSegs: number;
    hairSegs: number;
    hairDepth: number;
    hairDisp: number;
    hairSpeed: number;
    armVerts: number;
    spacingErr: number;
    disp: number;
    ms: number;
  }> = [];
  let t = 0;
  let nextRender = 0;
  const pens: number[] = [];
  const offenders = new Map<string, number>();
  const hairOffenders = new Map<string, number>();
  const fastest = { speed: 0, what: '' };
  const jitterTop = { d: 0, what: '' };
  const spacingTop = { e: 0, what: '' };
  while (t < sc.duration) {
    const dt = sc.dt(t, rand);
    const d = sc.drive(t, rand);
    t += dt;
    apply(d);
    const t0 = performance.now();
    ph.update(dt);
    const ms = performance.now() - t0;
    vrm.scene.updateMatrixWorld(true);

    // Speeds (tails, hips frame).
    hipsRaw.updateWorldMatrix(true, false);
    inv.copy(hipsRaw.matrixWorld).invert();
    let maxS = 0, clothS = 0, disp = 0;
    let clipSegs = 0, clipDepth = 0, armSegs = 0;
    let hairSegs = 0, hairDepth = 0, hairDisp = 0, hairSpeed = 0;
    for (let i = 0; i < joints.length; i++) {
      const s = joints[i];
      segWorld(s, _h, _t);
      _p.copy(_t).applyMatrix4(inv);
      const dd0 = first ? 0 : _p.distanceTo(prev[i]);
      if (!first) {
        const dd = _p.distanceTo(prev[i]);
        disp = Math.max(disp, dd);
        if (t > sc.duration - 1.5 && dd > jitterTop.d) {
          jitterTop.d = dd;
          jitterTop.what = `${s.chain}/${s.head.name}`;
        }
        const sp = dd / dt;
        if (sp > maxS) maxS = sp;
        if (sp > fastest.speed) {
          fastest.speed = sp;
          fastest.what = `${s.chain}/${s.head.name} t=${t.toFixed(2)}`;
        }
        if (s.cloth && sp > clothS) clothS = sp;
      }
      prev[i].copy(_p);
      if (s.hair) {
        let worst = 0;
        for (let c = 0; c < coreCaps.length; c++) {
          if (s.restHit[c] || coreCaps[c].arm) continue;
          capWorld(coreCaps[c], _a, _b);
          const pen = segPen(_h, _t, _a, _b, coreCaps[c].r);
          if (pen > worst) worst = pen;
          if (pen > 0) {
            const k = `${s.chain}>${coreCaps[c].name}`;
            hairOffenders.set(k, (hairOffenders.get(k) ?? 0) + 1);
          }
        }
        if (worst > 0) {
          hairSegs++;
          hairDepth = Math.max(hairDepth, worst);
        }
        if (dd0 > hairDisp) hairDisp = dd0;
        if (!first && dd0 / dt > hairSpeed) hairSpeed = dd0 / dt;
      }
      if (!s.cloth) continue;
      let worst = 0, worstArm = 0;
      for (let c = 0; c < coreCaps.length; c++) {
        if (s.restHit[c]) continue;
        capWorld(coreCaps[c], _a, _b);
        const pen = segPen(_h, _t, _a, _b, coreCaps[c].r);
        if (coreCaps[c].arm) worstArm = Math.max(worstArm, pen);
        else if (pen > worst) worst = pen;
        if (pen > 0 && !coreCaps[c].arm) {
          const k = `${s.chain}>${coreCaps[c].name}`;
          offenders.set(k, (offenders.get(k) ?? 0) + 1);
        }
      }
      if (worst > 0) {
        clipSegs++;
        clipDepth = Math.max(clipDepth, worst);
      }
      if (worstArm > 0) armSegs++;
    }
    first = false;
    let clipVerts = 0, clipVertDepth = 0, armVerts = 0;
    for (const s of msamp) {
      s.mesh.getVertexPosition(s.index, _p).applyMatrix4(s.mesh.matrixWorld);
      let worst = 0, worstArm = 0;
      for (let c = 0; c < coreCaps.length; c++) {
        if (s.restHit[c]) continue;
        capWorld(coreCaps[c], _a, _b);
        const pen = pointPen(_p, _a, _b, coreCaps[c].r);
        if (coreCaps[c].arm) worstArm = Math.max(worstArm, pen);
        else if (pen > worst) worst = pen;
      }
      if (worstArm > 0) armVerts++;
      if (worst > 0) {
        clipVerts++;
        clipVertDepth = Math.max(clipVertDepth, worst);
        pens.push(worst);
      }
    }
    let spacingErr = 0;
    for (const p of pairs) {
      const e = Math.abs(p.a.getWorldPosition(_a).distanceTo(p.b.getWorldPosition(_b)) - p.rest) / Math.max(p.rest, 1e-4);
      spacingErr = Math.max(spacingErr, e);
      if (e > spacingTop.e) {
        spacingTop.e = e;
        spacingTop.what = `${p.a.name}-${p.b.name} rest ${(1000 * p.rest).toFixed(0)}mm t=${t.toFixed(1)}`;
      }
    }
    frames.push({
      t,
      still: t >= sc.motionEnd,
      maxSpeed: maxS,
      clothSpeed: clothS,
      clipSegs,
      clipDepth,
      clipVerts: msamp.length ? clipVerts / msamp.length : 0,
      clipVertDepth,
      armSegs,
      hairSegs,
      hairDepth,
      hairDisp,
      hairSpeed,
      armVerts: msamp.length ? armVerts / msamp.length : 0,
      spacingErr,
      disp,
      ms,
    });

    if (o.render && renderer && scene && camera && onFrame) {
      while (t >= nextRender) {
        renderer.render(scene, camera);
        // Label in a 2D overlay (ffmpeg builds often lack drawtext).
        label.width = o.render.w;
        label.height = o.render.h;
        const g = label.getContext('2d')!;
        g.drawImage(renderer.domElement, 0, 0);
        g.font = 'bold 22px sans-serif';
        const text = `${o.render.label ?? o.condition}   ${o.scenario}   t=${t.toFixed(1)}s`;
        g.fillStyle = 'rgba(0,0,0,0.55)';
        g.fillRect(8, 8, g.measureText(text).width + 16, 34);
        g.fillStyle = '#fff';
        g.fillText(text, 16, 32);
        await onFrame(label.toDataURL('image/jpeg', 0.92));
        nextRender += 1 / o.render.fps;
      }
    }
  }

  // Summaries.
  const moving = frames.filter((f) => !f.still);
  const still = frames.filter((f) => f.still);
  const SETTLED = 0.05;
  let lastAbove = sc.motionEnd;
  for (const f of still) if (f.maxSpeed > SETTLED) lastAbove = f.t;
  const settled = still.length && still[still.length - 1].maxSpeed <= SETTLED;
  const tail = still.filter((f) => f.t > sc.duration - 1.5);
  const all = frames;
  const max = (k: keyof (typeof frames)[number], fs = all) => Math.max(0, ...fs.map((f) => f[k] as number));
  const mean = (k: keyof (typeof frames)[number], fs = all) => (fs.length ? fs.reduce((s, f) => s + (f[k] as number), 0) / fs.length : 0);
  if (scene) scene.remove(vrm.scene);
  return {
    condition: o.condition,
    scenario: o.scenario,
    seed: o.seed,
    joints: joints.length,
    clothJoints: joints.filter((j) => j.cloth).length,
    meshSamples: msamp.length,
    groups: (rig?.groups ?? []).map((g) => `${g.name} (${g.kind}${g.closed ? ', ring' : ''}, ${g.chains.length})`),
    bodyColliders: coreCaps.map((c) => c.name),
    frames: all.length,
    // Clipping
    clipFrames: all.filter((f) => f.clipSegs > 0).length / all.length,
    clipSegsMax: max('clipSegs'),
    clipDepthMax: max('clipDepth'),
    clipVertFracMean: mean('clipVerts'),
    clipVertFracMax: max('clipVerts'),
    clipVertDepthMax: max('clipVertDepth'),
    clipVertDepthP95: quant(pens, 0.95),
    fastest: `${fastest.what} ${fastest.speed.toFixed(1)} m/s; jitter ${jitterTop.what} ${(1000 * jitterTop.d).toFixed(2)} mm; spacing ${spacingTop.what} ${(100 * spacingTop.e).toFixed(0)}%`,
    offenders: [...offenders].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k} ${n}`),
    hairJoints: joints.filter((j) => j.hair).length,
    hairClipFrames: all.filter((f) => f.hairSegs > 0).length / all.length,
    hairClipSegsMax: max('hairSegs'),
    hairDepthMax: max('hairDepth'),
    hairP99Speed: quant(moving.map((f) => f.hairSpeed), 0.99),
    hairJitterMm: tail.length ? 1000 * quant(tail.map((f) => f.hairDisp), 0.5) : null,
    hairOffenders: [...hairOffenders].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k} ${n}`),
    armClipFrames: all.filter((f) => f.armSegs > 0).length / all.length,
    armVertFracMean: mean('armVerts'),
    // Shape
    spacingErrP95: quant(moving.map((f) => f.spacingErr), 0.95),
    spacingErrMax: max('spacingErr'),
    // Speeds
    maxSpeedAll: max('maxSpeed', moving),
    p99SpeedAll: quant(moving.map((f) => f.maxSpeed), 0.99),
    maxSpeedCloth: max('clothSpeed', moving),
    p99SpeedCloth: quant(moving.map((f) => f.clothSpeed), 0.99),
    // Rest
    settleSeconds: settled ? lastAbove - sc.motionEnd : null,
    jitterMm: tail.length ? 1000 * quant(tail.map((f) => f.disp), 0.5) : null,
    jitterMaxMm: tail.length ? 1000 * max('disp', tail) : null,
    // CPU
    msMean: mean('ms'),
    msP99: quant(all.map((f) => f.ms), 0.99),
    msMax: max('ms'),
  };
}

// ---------------------------------------------------------------- entry
interface Api {
  ready: boolean;
  error?: string;
  scenarios: string[];
  run: (o: RunOptions) => Promise<unknown>;
  /** Rendered frames are pulled one at a time by the driver. */
  render: (o: RunOptions) => Promise<unknown>;
  takeFrames: () => string[];
}

async function main() {
  const p = new URLSearchParams(location.search);
  const url = p.get('model') ?? '/__local/model.vrm';
  const buf = await (await fetch(url)).arrayBuffer();
  let recorded: RecordedPose | null = null;
  if (p.get('pose')) {
    const r = await fetch('/__local/pose.json');
    if (r.ok) recorded = await r.json();
  }
  let pending: string[] = [];
  const api: Api = {
    ready: true,
    scenarios: Object.keys(makeScenarios(recorded)),
    run: (o) => runOne(buf, recorded, o),
    render: (o) =>
      runOne(buf, recorded, o, async (png) => {
        pending.push(png);
        // Let the driver drain frames so memory stays bounded.
        while (pending.length > 30) await new Promise((r) => setTimeout(r, 5));
      }),
    takeFrames: () => {
      const f = pending;
      pending = [];
      return f;
    },
  };
  (window as unknown as { __cloth: Api }).__cloth = api;
  document.body.textContent = '';
}

main().catch((e) => {
  (window as unknown as { __cloth: Partial<Api> }).__cloth = { ready: true, error: String(e?.stack ?? e) };
});
export type { Avatar };
