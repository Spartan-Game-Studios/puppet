/**
 * VRM compatibility harness (dev only), driven by scripts/compat-sweep.mjs.
 *
 * window.__compat.analyze(url) loads one model with the app's own loader and
 * measures what can go wrong per model: load errors, meta and licence,
 * humanoid coverage, rest pose and facing, bounds and the real Viewer framing,
 * whether expressions and gaze change the picture, spring stability under a
 * shake, skinning, materials (black / pink / missing), render speed, three
 * built-in clips, and the library's import analysis and thumbnail.
 *
 * Images come back as data URLs; the script writes them to disk.
 */
import {
  DoubleSide,
  Euler,
  Matrix4,
  Mesh,
  Quaternion,
  Raycaster,
  SRGBColorSpace,
  Vector3,
  WebGLRenderTarget,
  type Camera,
  type Material,
} from 'three';
import { loadAvatar, type Avatar } from '../src/scene/avatar';
import { Viewer, type Framing } from '../src/scene/viewer';
import { DEFAULT_PHYSICS } from '../src/physics/stableSprings';
import { analyzeVrm } from '../src/library/analyze';
import { readGlbJson, readVrmMeta, summarizeLicence } from '../src/library/vrmMeta';
import { ClipLibrary } from '../src/anim/library';
import { AnimLayer } from '../src/anim/player';
import { clipBackend } from '../src/anim/clipStore';
import { ARKIT_NAMES, VRM_PRESETS } from '../src/core/blendshapes';
import { maxSkinBones, type GatheredFacts } from '../src/scene/modelFacts';
import type { FaceState } from '../src/tracking/faceProcessor';

const W = 480;
const H = 600;
const host = document.createElement('div');
host.style.cssText = `width:${W}px;height:${H}px;position:relative`;
document.body.appendChild(host);
const viewer = new Viewer(host);
viewer.setBackground('color', '#8a8a8a', null);
const library = new ClipLibrary(clipBackend());

const consoleLog: Array<{ type: string; text: string }> = [];
for (const type of ['warn', 'error'] as const) {
  const orig = console[type].bind(console);
  console[type] = (...a: unknown[]) => {
    consoleLog.push({ type, text: a.map((x) => (x instanceof Error ? x.message : typeof x === 'string' ? x : JSON.stringify(x))).join(' ').slice(0, 400) });
    orig(...a);
  };
}

// ---------------------------------------------------------------- capture helpers
const rt = new WebGLRenderTarget(W, H, { samples: 4 });
rt.texture.colorSpace = SRGBColorSpace;

interface Shot {
  url: string;
  px: Uint8Array;
}

/** Render the viewer's scene from a camera into pixels (and a PNG data URL). */
function capture(cam: Camera = viewer.camera, transparent = false): Shot {
  const r = viewer.renderer;
  const bg = viewer.scene.background;
  if (transparent) viewer.scene.background = null;
  const clear = r.getClearAlpha();
  if (transparent) r.setClearColor(0x000000, 0);
  r.setRenderTarget(rt);
  r.clear();
  r.render(viewer.scene, cam);
  const px = new Uint8Array(W * H * 4);
  r.readRenderTargetPixels(rt, 0, 0, W, H, px);
  r.setRenderTarget(null);
  if (transparent) {
    viewer.scene.background = bg;
    r.setClearColor(0x8a8a8a, clear);
  }
  // Flip Y into a canvas.
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++) img.data.set(px.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
  ctx.putImageData(img, 0, 0);
  return { url: c.toDataURL('image/jpeg', 0.85), px };
}

/** Pixels that changed noticeably between two shots of the same view. */
function diffPixels(a: Uint8Array, b: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 36) n++;
  }
  return n;
}

/** Colour audit of the silhouette (alpha) of a transparent-background shot. */
function colourAudit(px: Uint8Array) {
  let sil = 0;
  let black = 0;
  let pink = 0;
  let white = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 128) continue;
    sil++;
    const [r, g, b] = [px[i], px[i + 1], px[i + 2]];
    if (Math.max(r, g, b) < 14) black++;
    if (r > 200 && g < 60 && b > 200) pink++;
    if (Math.min(r, g, b) > 250) white++;
  }
  return { silhouettePct: (100 * sil) / (W * H), blackPct: sil ? (100 * black) / sil : 0, pinkPct: sil ? (100 * pink) / sil : 0, whitePct: sil ? (100 * white) / sil : 0 };
}

// ---------------------------------------------------------------- face input
function neutralFace(over: Record<string, number> = {}, gaze = { yaw: 0, pitch: 0 }): FaceState {
  const values: Record<string, number> = {};
  for (const n of ARKIT_NAMES) values[n] = 0;
  Object.assign(values, over);
  return { raw: { ...values }, values, head: new Quaternion(), headPos: new Vector3(), gaze, t: 0 };
}

function settle(a: Avatar, face: FaceState | null, steps = 45, dt = 1 / 30) {
  for (let i = 0; i < steps; i++) {
    if (face) a.setFace(face);
    a.update(dt);
  }
}

// ---------------------------------------------------------------- framing check
/** Is the point in front of the camera and inside the view (NDC, with margin)? */
function inView(p: Vector3, cam: Camera, margin = 1): boolean {
  const v = p.clone().project(cam);
  return v.z > -1 && v.z < 1 && Math.abs(v.x) <= margin && Math.abs(v.y) <= margin;
}

/** Camera inside the model: rays from it hit the (skinned) mesh in at least 5 of 6 directions. */
function cameraInsideMesh(a: Avatar, camPos: Vector3): boolean {
  const meshes: Mesh[] = [];
  a.vrm.scene.traverse((o) => {
    if ((o as Mesh).isMesh && o.visible) meshes.push(o as Mesh);
  });
  // Back faces count: from inside, the surface faces away from the camera.
  const sides = new Map<Material, number>();
  for (const m of meshes) for (const mat of Array.isArray(m.material) ? m.material : [m.material]) sides.set(mat, mat.side);
  for (const mat of sides.keys()) mat.side = DoubleSide;
  const ray = new Raycaster();
  let hits = 0;
  for (const d of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    ray.set(camPos, new Vector3(d[0], d[1], d[2]));
    if (ray.intersectObjects(meshes, false).length) hits++;
  }
  for (const [mat, side] of sides) mat.side = side as typeof mat.side;
  return hits >= 5;
}

function framingCheck(a: Avatar) {
  const out: Record<string, unknown> = {};
  const head = a.headPosition();
  const b = a.bounds;
  for (const f of ['bust', 'upper', 'full'] as Framing[]) {
    viewer.frame(f);
    viewer.controls.update();
    viewer.camera.updateMatrixWorld(true);
    const cam = viewer.camera;
    const camPos = cam.position.clone();
    const inside = cameraInsideMesh(a, camPos);
    const headIn = inView(head, cam, 0.95);
    // Full: every corner of the bounds (at x=0 sides) in view; bust/upper: the top of the head in view.
    const corners = [
      new Vector3(0, b.max.y, 0),
      new Vector3(0, b.min.y, 0),
      new Vector3(b.min.x, (b.min.y + b.max.y) / 2, 0),
      new Vector3(b.max.x, (b.min.y + b.max.y) / 2, 0),
    ];
    const allIn = corners.every((c) => inView(c, cam, 1.02));
    const shot = capture(cam, true);
    const cov = colourAudit(shot.px).silhouettePct;
    out[f] = { camera: camPos.toArray().map((x) => +x.toFixed(3)), target: viewer.controls.target.toArray().map((x) => +x.toFixed(3)), inside, headInView: headIn, wholeInView: allIn, coveragePct: +cov.toFixed(1), shot: capture(cam).url };
  }
  viewer.frame('bust');
  return out;
}

// ---------------------------------------------------------------- springs
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

async function springShake(buf: ArrayBuffer) {
  const { avatar } = await loadAvatar(buf.slice(0), { ...DEFAULT_PHYSICS });
  const vrm = avatar.vrm;
  const root = vrm.scene;
  const hips = vrm.humanoid.getRawBoneNode('hips')!;
  const joints = Array.from(vrm.springBoneManager?.joints ?? []) as unknown as Array<{ _currentTail: Vector3; bone: { getWorldPosition(v: Vector3): Vector3 }; child?: { getWorldPosition(v: Vector3): Vector3 } }>;
  if (!joints.length) return { joints: 0 };
  const rand = rng(1);
  const SHAKE = 3;
  const TAIL = 5;
  const inv = new Matrix4();
  const prev = joints.map(() => new Vector3());
  let first = true;
  let t = 0;
  let nan = false;
  const samples: Array<{ t: number; s: number }> = [];
  avatar.drive.mode = 'face';
  while (t < SHAKE + TAIL) {
    let dt = 1 / 60 + (rand() - 0.5) * 0.004;
    if (t > 1 && t < 1.1) dt = 0.09; // one frame-time hitch
    t += dt;
    if (t < SHAKE) {
      const env = Math.min(1, t / 0.4);
      root.position.set(0.08 * Math.sin(2 * Math.PI * 0.7 * t) + 0.03 * Math.sin(2 * Math.PI * 3.1 * t), 0.015 * Math.sin(2 * Math.PI * 2.3 * t), 0.02 * Math.sin(2 * Math.PI * 1.7 * t)).multiplyScalar(env);
      const e = new Euler(0.05 * Math.sin(2 * Math.PI * 1.3 * t) * env, (0.3 * Math.sin(2 * Math.PI * 0.7 * t) + 0.08 * Math.sin(2 * Math.PI * 2.9 * t)) * env, 0.06 * Math.sin(2 * Math.PI * 1.1 * t) * env);
      root.quaternion.rotateTowards(new Quaternion().setFromEuler(e), 4 * dt);
    } else {
      root.position.set(0, 0, 0);
      root.quaternion.rotateTowards(new Quaternion(), 4 * dt);
    }
    root.updateMatrixWorld(true);
    avatar.update(dt);
    hips.updateWorldMatrix(true, false);
    inv.copy(hips.matrixWorld).invert();
    let m = 0;
    joints.forEach((j, i) => {
      const p = (j.child ?? j.bone).getWorldPosition(new Vector3()).applyMatrix4(inv);
      if (!Number.isFinite(p.x + p.y + p.z)) nan = true;
      if (!first) m = Math.max(m, p.distanceTo(prev[i]) / dt);
      prev[i].copy(p);
    });
    first = false;
    samples.push({ t, s: m });
  }
  const during = samples.filter((s) => s.t < SHAKE).map((s) => s.s);
  let lastAbove = SHAKE;
  for (const s of samples) if (s.t >= SHAKE && s.s > 0.05) lastAbove = s.t;
  const settled = samples[samples.length - 1].s <= 0.05;
  const res = {
    joints: joints.length,
    chains: avatar.physics.chains.length,
    groups: avatar.physics.groups.map((g) => `${g.name}:${g.kind}${g.closed ? '(closed)' : ''}x${g.chains.length}`),
    maxSpeed: +Math.max(...during).toFixed(2),
    settleSeconds: settled ? +(lastAbove - SHAKE).toFixed(2) : null,
    residual: +samples[samples.length - 1].s.toFixed(3),
    nan,
  };
  return res;
}

// ---------------------------------------------------------------- materials
function materialAudit(a: Avatar) {
  const mats = new Set<Material>();
  a.vrm.scene.traverse((o) => {
    const m = (o as Mesh).material;
    if (!m) return;
    for (const x of Array.isArray(m) ? m : [m]) mats.add(x);
  });
  const types: Record<string, number> = {};
  let transparent = 0;
  let cutout = 0;
  let outlines = 0;
  const missing: string[] = [];
  for (const m of mats) {
    const anyM = m as unknown as Record<string, any>;
    const t = anyM.isMToonMaterial ? 'MToon' : m.type;
    types[t] = (types[t] ?? 0) + 1;
    if (m.transparent) transparent++;
    if (m.alphaTest > 0) cutout++;
    if (anyM.isOutline) outlines++;
    for (const k of ['map', 'shadeMultiplyTexture', 'normalMap', 'emissiveMap', 'matcapTexture']) {
      const tex = anyM[k];
      if (tex && (!tex.image || (tex.image.width ?? 0) === 0)) missing.push(`${m.name || '?'}.${k}`);
    }
  }
  return { count: mats.size, types, transparent, cutout, outlines, missingTextures: missing };
}

/** Skin index storage per JOINTS_0 accessor, from the glTF JSON. */
function skinIndexTypes(gltf: Record<string, any>): string[] {
  const types = new Set<string>();
  for (const m of gltf.meshes ?? []) {
    for (const p of m.primitives ?? []) {
      const a = p.attributes?.JOINTS_0;
      if (a === undefined) continue;
      const ct = gltf.accessors?.[a]?.componentType;
      types.add(ct === 5121 ? 'u8' : ct === 5123 ? 'u16' : String(ct));
    }
  }
  return [...types];
}

// ---------------------------------------------------------------- clips
const DIR_BONES: Array<[string, string]> = [
  ['leftUpperArm', 'leftLowerArm'],
  ['leftLowerArm', 'leftHand'],
  ['rightUpperArm', 'rightLowerArm'],
  ['rightLowerArm', 'rightHand'],
  ['neck', 'head'],
  ['leftUpperLeg', 'leftLowerLeg'],
  ['rightUpperLeg', 'rightLowerLeg'],
];
function dirs(a: Avatar): Record<string, Vector3> {
  a.vrm.scene.updateMatrixWorld(true);
  const out: Record<string, Vector3> = {};
  const raw = (b: string) => a.vrm.humanoid.getRawBoneNode(b as never);
  for (const [b, c] of DIR_BONES) {
    const nb = raw(b);
    const nc = raw(c);
    if (nb && nc) out[b] = nc.getWorldPosition(new Vector3()).sub(nb.getWorldPosition(new Vector3())).normalize();
  }
  return out;
}

async function clips(a: Avatar) {
  const layer = new AnimLayer(a, library, { idle: null, idleInFaceMode: true, fadeIn: 0.3, fadeOut: 0.45 });
  a.layer = layer;
  const out: Record<string, unknown> = {};
  viewer.frame('full');
  for (const id of ['builtin:idle', 'builtin:wave', 'builtin:cheer']) {
    try {
      const { clip, def } = await library.bind(a, id);
      layer.setIdle(null);
      layer.reset();
      settle(a, null, 30);
      if (def.kind === 'idle') {
        layer.setIdle(id);
        await new Promise((r) => setTimeout(r, 0));
      } else await layer.play(id);
      const dt = 1 / 30;
      const len = def.loop ? Math.max(3, clip.duration) : clip.duration + 0.3;
      const steps = Math.round(len / dt);
      const shotsAt = new Set([Math.round(steps * 0.35), Math.round(steps * 0.6)]);
      const shots: string[] = [];
      let prev = dirs(a);
      let maxStep = 0;
      let at = '';
      let nan = false;
      for (let i = 0; i < steps; i++) {
        a.update(dt);
        const d = dirs(a);
        for (const [b, v] of Object.entries(d)) {
          if (!Number.isFinite(v.x + v.y + v.z)) nan = true;
          const p = prev[b];
          if (!p) continue;
          const s = (p.angleTo(v) * 180) / Math.PI;
          if (s > maxStep) {
            maxStep = s;
            at = `${b}@${(i * dt).toFixed(2)}s`;
          }
        }
        prev = d;
        if (shotsAt.has(i)) shots.push(capture().url);
      }
      out[id] = { ok: true, label: def.label, duration: +clip.duration.toFixed(2), maxStepDeg: +maxStep.toFixed(1), maxStepAt: at, nan, shots };
    } catch (e) {
      out[id] = { ok: false, error: String((e as Error)?.message ?? e) };
    }
  }
  layer.setIdle(null);
  layer.reset();
  a.layer = null;
  viewer.frame('bust');
  return out;
}

// ---------------------------------------------------------------- main
function b64(u: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

async function analyze(url: string) {
  consoleLog.length = 0;
  const t0 = performance.now();
  const buf = await (await fetch(url)).arrayBuffer();
  const res: Record<string, any> = { bytes: buf.byteLength };
  let gltf: Record<string, any> = {};
  try {
    gltf = readGlbJson(buf) as Record<string, any>;
    const meta = readVrmMeta(buf);
    const lic = summarizeLicence(meta);
    res.meta = { spec: meta.spec, name: meta.name, authors: meta.authors, licenseName: meta.licenseName, licenseUrl: meta.licenseUrl, badge: lic.badge, tone: lic.tone, headline: lic.headline };
    res.generator = gltf.asset?.generator ?? null;
    res.skinIndexTypes = skinIndexTypes(gltf);
  } catch (e) {
    res.metaError = String((e as Error).message);
  }

  let a: Avatar;
  let facts: GatheredFacts;
  try {
    ({ avatar: a, facts } = await loadAvatar(buf.slice(0), { ...DEFAULT_PHYSICS }));
  } catch (e) {
    res.load = { ok: false, error: String((e as Error)?.stack ?? e), ms: Math.round(performance.now() - t0), console: [...consoleLog] };
    return res;
  }
  res.load = { ok: true, ms: Math.round(performance.now() - t0), name: a.name };
  a.drive.mode = 'face';
  viewer.setAvatar(a);

  // Rest-pose facts and warnings, as the app computes them on load.
  res.facts = facts;
  res.bones = { count: a.humanBoneNames.length, present: a.humanBoneNames };
  res.bounds = { min: a.bounds.min.toArray().map((x) => +x.toFixed(3)), max: a.bounds.max.toArray().map((x) => +x.toFixed(3)), height: +(a.bounds.max.y - a.bounds.min.y).toFixed(3), head: a.headPosition().toArray().map((x) => +x.toFixed(3)) };
  res.skin = { maxBones: maxSkinBones(a.vrm.scene) };

  // Expressions.
  const names = a.expressionNames;
  res.expressions = {
    count: names.length,
    presets: VRM_PRESETS.filter((p) => names.includes(p)),
    perfectSync: a.perfectSync.size,
    usePerfectSync: a.usePerfectSync,
    custom: names.filter((n) => !(VRM_PRESETS as readonly string[]).includes(n)).slice(0, 80),
  };
  const lookAt = a.vrm.lookAt;
  res.lookAt = {
    type: lookAt ? ((lookAt.applier.constructor as unknown as { type?: string }).type ?? lookAt.applier.constructor.name) : null,
    declared: (gltf.extensions?.VRMC_vrm?.lookAt?.type ?? gltf.extensions?.VRM?.firstPerson?.lookAtTypeName ?? null) as string | null,
  };

  settle(a, neutralFace());
  viewer.frame('bust');
  const neutral = capture();
  // Mouth open + both eyes shut.
  settle(a, neutralFace({ jawOpen: 1, eyeBlinkLeft: 1, eyeBlinkRight: 1, mouthFunnel: 0.2 }));
  const driven = capture();
  const exprDiff = diffPixels(neutral.px, driven.px);
  const values = Object.fromEntries([...a.expressionValues].filter(([, v]) => v > 0.05).map(([k, v]) => [k, +v.toFixed(2)]));
  res.expressions.driveDiffPx = exprDiff;
  res.expressions.driven = values;
  res.shots = { neutral: neutral.url, driven: driven.url };
  // Gaze to the side.
  settle(a, neutralFace());
  const base = capture();
  const eyeNode = a.vrm.humanoid.getNormalizedBoneNode('leftEye');
  settle(a, neutralFace({}, { yaw: 20, pitch: 8 }));
  const gaze = capture();
  res.lookAt.diffPx = diffPixels(base.px, gaze.px);
  res.lookAt.yaw = +(lookAt?.yaw ?? 0).toFixed(2);
  res.lookAt.eyeBoneTurned = eyeNode ? +((2 * Math.acos(Math.min(1, Math.abs(eyeNode.quaternion.w))) * 180) / Math.PI).toFixed(1) : null;
  res.shots.gaze = gaze.url;
  settle(a, null, 60);

  // Framing.
  res.framing = framingCheck(a);

  // Materials and the colour audit (full body, transparent background).
  res.materials = materialAudit(a);
  viewer.frame('full');
  const full = capture(viewer.camera, true);
  res.materials.colour = colourAudit(full.px);
  res.shots.full = capture().url;
  // Back view (catches faces modelled on the back of the head).
  a.vrm.scene.rotation.y += Math.PI;
  a.vrm.scene.updateMatrixWorld(true);
  res.shots.back = capture().url;
  a.vrm.scene.rotation.y -= Math.PI;
  viewer.frame('bust');

  // Render speed: the app's own render path, uncapped, at 1280x720.
  host.style.width = '1280px';
  host.style.height = '720px';
  viewer.resize();
  viewer.frame('upper');
  const gl = viewer.renderer.getContext();
  const px1 = new Uint8Array(4);
  for (let i = 0; i < 10; i++) {
    a.update(1 / 60);
    viewer.render();
  }
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px1);
  const tr = performance.now();
  const N = 120;
  for (let i = 0; i < N; i++) {
    a.update(1 / 60);
    viewer.render();
  }
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px1);
  const frameMs = (performance.now() - tr) / N;
  res.render = { frameMs: +frameMs.toFixed(2), fps: Math.round(1000 / frameMs), calls: viewer.renderer.info.render.calls, triangles: viewer.renderer.info.render.triangles };
  host.style.width = `${W}px`;
  host.style.height = `${H}px`;
  viewer.resize();
  viewer.frame('bust');

  // Clips.
  res.clips = await clips(a);

  // Springs (separate instance: the shake moves the root).
  try {
    res.springs = await springShake(buf);
  } catch (e) {
    res.springs = { error: String((e as Error).message) };
  }

  // Library import analysis + thumbnail.
  try {
    const an = await analyzeVrm(buf.slice(0));
    res.library = { stats: an.stats, thumb: an.thumb ? `data:image/png;base64,${b64(an.thumb)}` : null };
  } catch (e) {
    res.library = { error: String((e as Error).message) };
  }

  viewer.setAvatar(null);
  res.console = [...consoleLog];
  res.ms = Math.round(performance.now() - t0);
  return res;
}

(window as unknown as { __compat: unknown }).__compat = { analyze, viewer };
(window as unknown as { __compatReady: boolean }).__compatReady = true;
