/**
 * Animation clip harness (dev only): plays clips on a VRM in virtual time with
 * the real AnimLayer and physics, renders front and side views, and records
 * limb directions so scripts/anim-test.mjs can compare VRM 0.x and 1.0
 * avatars and look for flipped limbs and physics blow-ups.
 *
 * window.__anim.load(url), .clips(), .run(id, opts) -> frames + metrics.
 */
import { AmbientLight, Color, DirectionalLight, Matrix4, PerspectiveCamera, Quaternion, Scene, SRGBColorSpace, Vector3, WebGLRenderer } from 'three';
import { loadAvatar, type Avatar } from '../src/scene/avatar';
import { DEFAULT_PHYSICS } from '../src/physics/stableSprings';
import { ClipLibrary } from '../src/anim/library';
import { AnimLayer } from '../src/anim/player';
import { clipBackend } from '../src/anim/clipStore';

const W = 256;
const H = 320;
const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.outputColorSpace = SRGBColorSpace;
renderer.setPixelRatio(1);
renderer.setSize(W * 2, H, false);
document.body.appendChild(renderer.domElement);
const scene = new Scene();
scene.background = new Color(0x8a8a8a);
scene.add(new AmbientLight(0xffffff, 1.6));
const key = new DirectionalLight(0xffffff, 2.2);
key.position.set(1, 2, 3);
scene.add(key);
const cam = new PerspectiveCamera(30, W / H, 0.05, 50);

const library = new ClipLibrary(clipBackend());
let avatar: Avatar | null = null;
let layer: AnimLayer | null = null;

const DIR_BONES: Array<[string, string]> = [
  ['spine', 'neck'],
  ['neck', 'head'],
  ['leftUpperArm', 'leftLowerArm'],
  ['leftLowerArm', 'leftHand'],
  ['rightUpperArm', 'rightLowerArm'],
  ['rightLowerArm', 'rightHand'],
  ['leftHand', 'leftMiddleProximal'],
  ['rightHand', 'rightMiddleProximal'],
  ['leftUpperLeg', 'leftLowerLeg'],
  ['leftLowerLeg', 'leftFoot'],
  ['rightUpperLeg', 'rightLowerLeg'],
  ['rightLowerLeg', 'rightFoot'],
];

function dirs(a: Avatar): Record<string, number[]> {
  a.vrm.scene.updateMatrixWorld(true);
  const out: Record<string, number[]> = {};
  const raw = (b: string) => a.vrm.humanoid.getRawBoneNode(b as never);
  for (const [b, c] of DIR_BONES) {
    const nb = raw(b);
    const nc = raw(c);
    if (!nb || !nc) continue;
    const d = nc.getWorldPosition(new Vector3()).sub(nb.getWorldPosition(new Vector3())).normalize();
    out[b] = [d.x, d.y, d.z];
  }
  // Palm normal-ish: hand's local axes in world (catches twisted wrists).
  for (const side of ['left', 'right']) {
    const h = raw(`${side}Hand`);
    if (h) out[`${side}HandQ`] = h.getWorldQuaternion(new Quaternion()).toArray();
  }
  return out;
}

function frameCamera(a: Avatar) {
  const b = a.bounds;
  const height = Math.max(1, b.max.y - b.min.y);
  return { cy: b.min.y + height * 0.5, dist: (height * 0.62) / Math.tan((15 * Math.PI) / 180) };
}

function shoot(a: Avatar): string {
  const { cy, dist } = frameCamera(a);
  renderer.setScissorTest(true);
  for (const [i, ang] of [
    [0, 0],
    [1, Math.PI / 2],
  ] as const) {
    cam.position.set(Math.sin(ang) * dist, cy, Math.cos(ang) * dist);
    cam.lookAt(0, cy, 0);
    renderer.setViewport(i * W, 0, W, H);
    renderer.setScissor(i * W, 0, W, H);
    renderer.render(scene, cam);
  }
  renderer.setScissorTest(false);
  return renderer.domElement.toDataURL('image/jpeg', 0.85);
}

/** Max spring-tail speed relative to the hips (m/s): physics thrash / explosions. */
function springProbe(a: Avatar) {
  const joints = Array.from(a.vrm.springBoneManager?.joints ?? []) as unknown as Array<{ bone: { getWorldPosition(v: Vector3): Vector3 } }>;
  const hips = a.vrm.humanoid.getRawBoneNode('hips')!;
  const prev = new Map<number, Vector3>();
  const inv = new Matrix4();
  return (dt: number): number => {
    hips.updateWorldMatrix(true, false);
    inv.copy(hips.matrixWorld).invert();
    let max = 0;
    joints.forEach((j, i) => {
      // The rendered result: the joint's child bone (works for both physics solvers).
      const node = (j as unknown as { child?: { getWorldPosition(v: Vector3): Vector3 } }).child ?? j.bone;
      const t = node.getWorldPosition(new Vector3()).applyMatrix4(inv);
      const p = prev.get(i);
      if (p) max = Math.max(max, t.distanceTo(p) / dt);
      prev.set(i, t);
    });
    return max;
  };
}

async function load(url: string) {
  if (avatar) scene.remove(avatar.vrm.scene);
  const buf = await (await fetch(url)).arrayBuffer();
  const { avatar: a } = await loadAvatar(buf, { ...DEFAULT_PHYSICS });
  a.drive.mode = 'face';
  scene.add(a.vrm.scene);
  avatar = a;
  layer = new AnimLayer(a, library, { idle: null, idleInFaceMode: true, fadeIn: 0.3, fadeOut: 0.45 });
  a.layer = layer;
  for (let i = 0; i < 60; i++) a.update(1 / 60);
  return { name: a.name, vrm0: a.isVrm0, bones: a.humanBoneNames.length, springs: a.physics.jointCount };
}

interface RunOpts {
  /** Render every n-th step (30 fps steps). */
  every?: number;
  /** Seconds to keep stepping after the clip. */
  tail?: number;
  /** Treat the clip as the idle. */
  idle?: boolean;
  /** Fixed seconds instead of the clip length (loops). */
  seconds?: number;
  render?: boolean;
}

async function run(id: string, opts: RunOpts = {}) {
  const a = avatar!;
  const l = layer!;
  const dt = 1 / 30;
  if (id === 'none') return still(opts.seconds ?? 3);
  const { clip, def } = await library.bind(a, id);
  // Settle at the static idle pose.
  l.setIdle(null);
  l.reset();
  for (let i = 0; i < 40; i++) a.update(dt);
  const probe = springProbe(a);
  probe(dt);
  const isIdle = opts.idle ?? def.kind === 'idle';
  if (isIdle) {
    l.setIdle(id);
    await new Promise((r) => setTimeout(r, 0));
  } else await l.play(id);
  const len = opts.seconds ?? (def.loop ? Math.max(clip.duration * 2, 3) : clip.duration + (opts.tail ?? 0.6));
  const steps = Math.round(len / dt);
  const frames: string[] = [];
  const samples: Array<{ t: number; d: Record<string, number[]> }> = [];
  let maxSpring = 0;
  let maxSpringAt = 0;
  for (let i = 0; i < steps; i++) {
    a.update(dt);
    const sp = probe(dt);
    if (sp > maxSpring) {
      maxSpring = sp;
      maxSpringAt = i * dt;
    }
    samples.push({ t: i * dt, d: dirs(a) });
    if (opts.render !== false && i % (opts.every ?? 1) === 0) frames.push(shoot(a));
  }
  l.setIdle(null);
  l.reset();
  return { id, label: def.label, mask: def.mask, duration: clip.duration, frames, samples, maxSpring, maxSpringAt };
}

/** Baseline: no clip, the static idle pose (physics reference). */
async function still(seconds: number) {
  const a = avatar!;
  const dt = 1 / 30;
  layer!.setIdle(null);
  layer!.reset();
  for (let i = 0; i < 40; i++) a.update(dt);
  const probe = springProbe(a);
  probe(dt);
  let maxSpring = 0;
  const samples: Array<{ t: number; d: Record<string, number[]> }> = [];
  for (let i = 0; i < seconds / dt; i++) {
    a.update(dt);
    maxSpring = Math.max(maxSpring, probe(dt));
    samples.push({ t: i * dt, d: dirs(a) });
  }
  return { id: 'none', label: 'NO CLIP (BASELINE)', mask: '-', duration: seconds, frames: [shoot(a)], samples, maxSpring };
}

async function importClip(url: string, name: string) {
  const buf = await (await fetch(url)).arrayBuffer();
  const added = await library.importFile(name, buf, null);
  return added.map((e) => ({ id: e.id, label: e.label, rig: e.rig, duration: e.duration }));
}

(window as unknown as { __anim: unknown }).__anim = {
  load,
  run,
  importClip,
  clips: () => library.all().map((d) => ({ id: d.id, label: d.label, kind: d.kind, mask: d.mask, loop: d.loop })),
  shoot: () => shoot(avatar!),
  library,
  get avatar() {
    return avatar;
  },
};
(window as unknown as { __animReady: boolean }).__animReady = true;
