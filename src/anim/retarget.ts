/**
 * Retargeting: animation clips from another skeleton (Mixamo, the Quaternius
 * Universal Animation Library, VRoid exports...) onto any VRM's normalized
 * humanoid bones.
 *
 * Two stages:
 *
 * 1. `extractSourceClip` (per file, avatar independent). The source clip is
 *    sampled with three's AnimationMixer at a fixed rate and, per mapped bone,
 *    stored as its WORLD rotation delta from the source rest pose,
 *        D(t) = W(t) * W_rest^-1,
 *    plus the bone's rest direction (bone -> child). Both are expressed in a
 *    canonical frame detected from the rest pose: +Y up, the character faces
 *    +Z, its left hand is +X (Puppet's solver space, = VRM 1.0). Hips
 *    translation is kept relative to rest, divided by the source hip height.
 *
 * 2. `bindClip` (per avatar). A VRM's normalized bones are identity at its
 *    T-pose, so a bone's world rotation G maps the T-pose to the pose. The
 *    source rest pose may differ (an A-pose, a slightly bent T-pose), so each
 *    bone gets a fix rotation taking the avatar's rest direction onto the
 *    source's rest direction:
 *        G(t) = D(t) * arc(t_rest -> s_rest)
 *    and local rotations follow from the humanoid hierarchy the avatar
 *    actually has: L = G_parent^-1 * G. Bones without a direction (head,
 *    finger tips, toes) inherit their parent's fix; avatar bones the source
 *    lacks follow their parent (local identity).
 *
 * Everything is produced in the +Z-facing solver space; `toVrmBone` converts
 * for VRM 0.x models, whose normalized bones face -Z.
 */
import { AnimationClip, AnimationMixer, LoopOnce, Matrix4, Object3D, Quaternion, Skeleton, SkinnedMesh, Vector3 } from 'three';
import { DIR_CHILD, VRM_BONES, VRM_PARENT, detectRig, type RigFamily } from './rigMap';

export const SAMPLE_FPS = 30;

/** Avatar-independent sampled clip. */
export interface SourceClip {
  name: string;
  rig: RigFamily;
  fps: number;
  frames: number;
  /** VRM bone -> frames x (x, y, z, w): world rotation delta from rest, canonical frame. */
  deltas: Map<string, Float32Array>;
  /** VRM bone -> rest direction (bone -> child) in the canonical frame. */
  restDirs: Map<string, Vector3>;
  /** frames x (x, y, z): hips offset from rest, canonical frame, in source hip heights. */
  hips: Float32Array | null;
}

/** A clip bound to one avatar: local normalized-bone rotations in solver space. */
export interface BoundClip {
  name: string;
  fps: number;
  frames: number;
  duration: number;
  /** VRM bone -> frames x quaternion (solver space). */
  bones: Map<string, Float32Array>;
  /** frames x 3: hips offset in metres (solver space), or null. */
  hips: Float32Array | null;
}

export type RootMotion = 'inplace' | 'off';

// ---------------------------------------------------------------- canonical frame

/**
 * Rotation from the canonical frame (left = +X, up = +Y, forward = +Z) to the
 * source frame, from rest positions: left = leftArm - rightArm, up = head - hips.
 */
export function canonicalBasis(left: Vector3, up: Vector3): Quaternion {
  const u = up.clone().normalize();
  const l = left.clone().addScaledVector(u, -left.dot(u)).normalize();
  const f = new Vector3().crossVectors(l, u);
  const m = new Matrix4().makeBasis(l, u, f);
  return new Quaternion().setFromRotationMatrix(m);
}

const _b = new Quaternion();
/** Express a source-frame rotation in the canonical frame: B^-1 * q * B. */
export function toCanonical(q: Quaternion, basis: Quaternion, out = new Quaternion()): Quaternion {
  const r = _b.copy(basis).invert().multiply(q).multiply(basis);
  return out.copy(r);
}

// ---------------------------------------------------------------- extract

export interface ExtractOptions {
  fps?: number;
  /** Override the detected mapping (source node name -> VRM bone). */
  map?: Map<string, string>;
}

/** Find the source skeleton's mapped nodes. */
export function findRig(root: Object3D, map?: Map<string, string>): { family: RigFamily; nodes: Map<string, Object3D> } {
  const byName = new Map<string, Object3D>();
  root.traverse((o) => {
    if (!o.name) return;
    const prev = byName.get(o.name);
    // Prefer bones over same-named meshes/groups.
    if (!prev || (!(prev as { isBone?: boolean }).isBone && (o as { isBone?: boolean }).isBone)) byName.set(o.name, o);
  });
  let family: RigFamily = 'generic';
  let m = map;
  if (!m) {
    const det = detectRig(byName.keys());
    family = det.family;
    m = det.map;
  }
  const nodes = new Map<string, Object3D>();
  for (const [src, vrm] of m) {
    const n = byName.get(src);
    if (n) nodes.set(vrm, n);
  }
  return { family, nodes };
}

/** Put a skinned source into its bind pose (the skin's inverse bind matrices); returns false if unskinned. */
function poseToBind(root: Object3D, nodes: Map<string, Object3D>): boolean {
  const want = new Set(nodes.values());
  let skeleton: Skeleton | null = null;
  root.traverse((o) => {
    const m = o as SkinnedMesh;
    if (!skeleton && m.isSkinnedMesh && m.skeleton.bones.some((b) => want.has(b))) skeleton = m.skeleton;
  });
  if (!skeleton) return false;
  (skeleton as Skeleton).pose();
  return true;
}

/**
 * Sample one clip from a loaded source scene. The scene's transforms are
 * restored afterwards, so several clips can be extracted from one file.
 */
export function extractSourceClip(root: Object3D, clip: AnimationClip, opts: ExtractOptions = {}): SourceClip {
  const fps = opts.fps ?? SAMPLE_FPS;
  const { family, nodes } = findRig(root, opts.map);
  if (!nodes.has('hips')) throw new Error(`${clip.name}: no hips bone found (rig not recognised)`);

  // Save transforms so extraction leaves the scene untouched.
  const saved: Array<[Object3D, Vector3, Quaternion, Vector3]> = [];
  root.traverse((o) => saved.push([o, o.position.clone(), o.quaternion.clone(), o.scale.clone()]));
  const restore = () => {
    for (const [o, p, q, s] of saved) {
      o.position.copy(p);
      o.quaternion.copy(q);
      o.scale.copy(s);
    }
    root.updateMatrixWorld(true);
  };

  try {
    // Rest pose: the skin's bind pose if there is one, else the nodes as loaded.
    poseToBind(root, nodes);
    root.updateMatrixWorld(true);
    const restQ = new Map<string, Quaternion>();
    const restP = new Map<string, Vector3>();
    for (const [b, n] of nodes) {
      restQ.set(b, n.getWorldQuaternion(new Quaternion()));
      restP.set(b, n.getWorldPosition(new Vector3()));
    }
    const P = (b: string) => restP.get(b);
    const left =
      P('leftUpperArm') && P('rightUpperArm')
        ? P('leftUpperArm')!.clone().sub(P('rightUpperArm')!)
        : P('leftUpperLeg') && P('rightUpperLeg')
          ? P('leftUpperLeg')!.clone().sub(P('rightUpperLeg')!)
          : new Vector3(1, 0, 0);
    const top = P('head') ?? P('neck') ?? P('upperChest') ?? P('chest') ?? P('spine');
    const up = top ? top.clone().sub(P('hips')!) : new Vector3(0, 1, 0);
    const basis = canonicalBasis(left, up);
    const basisInv = basis.clone().invert();
    const toCan = (v: Vector3) => v.clone().applyQuaternion(basisInv);

    const restDirs = new Map<string, Vector3>();
    for (const [b, child] of Object.entries(DIR_CHILD)) {
      const a = P(b);
      const c = P(child);
      if (a && c) {
        const d = toCan(c.clone().sub(a));
        if (d.lengthSq() > 1e-12) restDirs.set(b, d.normalize());
      }
    }
    // Hip height: hips above the lowest foot/toe, in the canonical frame.
    const hipsC = toCan(P('hips')!);
    const feet = ['leftFoot', 'rightFoot', 'leftToes', 'rightToes'].map(P).filter(Boolean) as Vector3[];
    const floor = feet.length ? Math.min(...feet.map((f) => toCan(f).y)) : hipsC.y - up.length() * 1.6;
    const hipHeight = Math.max(1e-6, hipsC.y - floor);

    // Sample. The mixer is driven on the original (as loaded) transforms so
    // tracks that don't cover every bone keep the file's own values.
    restore();
    const mixer = new AnimationMixer(root);
    const action = mixer.clipAction(clip);
    action.setLoop(LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
    const frames = Math.max(1, Math.round(clip.duration * fps) + 1);
    const deltas = new Map<string, Float32Array>();
    for (const b of nodes.keys()) deltas.set(b, new Float32Array(frames * 4));
    const hips = new Float32Array(frames * 3);
    const q = new Quaternion();
    const d = new Quaternion();
    const prev = new Map<string, Quaternion>();
    const hipsNode = nodes.get('hips')!;
    const hp = new Vector3();
    for (let f = 0; f < frames; f++) {
      mixer.setTime(Math.min(clip.duration, f / fps));
      root.updateMatrixWorld(true);
      for (const [b, n] of nodes) {
        n.getWorldQuaternion(q);
        d.copy(q).multiply(restQ.get(b)!.clone().invert());
        toCanonical(d, basis, d).normalize();
        // Keep successive samples in one hemisphere (clean slerp).
        const p = prev.get(b);
        if (p && p.dot(d) < 0) d.set(-d.x, -d.y, -d.z, -d.w);
        prev.set(b, (p ?? new Quaternion()).copy(d));
        deltas.get(b)!.set([d.x, d.y, d.z, d.w], f * 4);
      }
      hipsNode.getWorldPosition(hp);
      const o = toCan(hp.sub(P('hips')!)).multiplyScalar(1 / hipHeight);
      hips.set([o.x, o.y, o.z], f * 3);
    }
    mixer.stopAllAction();
    mixer.uncacheRoot(root);
    return { name: clip.name, rig: family, fps, frames, deltas, restDirs, hips };
  } finally {
    restore();
  }
}

// ---------------------------------------------------------------- bind

/** What `bindClip` needs to know about the target avatar (all in solver space). */
export interface TargetRig {
  /** Humanoid bones the avatar has. */
  bones: Set<string>;
  /** Rest direction (bone -> child) per bone, solver space. */
  restDirs: Map<string, Vector3>;
  /** Hips height above the floor at rest, metres. */
  hipHeight: number;
}

/** Nearest ancestor of `bone` (in the VRM hierarchy) that `has` contains. */
export function availableParent(bone: string, has: (b: string) => boolean): string | null {
  let p = VRM_PARENT[bone] ?? null;
  while (p && !has(p)) p = VRM_PARENT[p] ?? null;
  return p;
}

export interface BindOptions {
  rootMotion?: RootMotion;
}

export function bindClip(src: SourceClip, target: TargetRig, opts: BindOptions = {}): BoundClip {
  const F = src.frames;
  // Per-bone fix: avatar rest direction -> source rest direction.
  const fix = new Map<string, Quaternion>();
  for (const b of VRM_BONES) {
    const t = target.restDirs.get(b);
    const s = src.restDirs.get(b);
    if (t && s) fix.set(b, new Quaternion().setFromUnitVectors(t, s));
    else {
      const p = VRM_PARENT[b];
      fix.set(b, p && fix.has(p) ? fix.get(p)!.clone() : new Quaternion());
    }
  }

  // World rotation per avatar bone per frame.
  const order = VRM_BONES.filter((b) => target.bones.has(b));
  const world = new Map<string, Float32Array>();
  const q = new Quaternion();
  // Spine bones the avatar lacks fold into the avatar bone below them (no
  // upperChest: chest takes the source's upperChest), so a clip that doesn't
  // own the neck still leaves the shoulders and neck where the source has them.
  const SPINE = ['spine', 'chest', 'upperChest'];
  const spineSource = (b: string): string => {
    let use = b;
    for (let i = SPINE.indexOf(b) + 1; i > 0 && i < SPINE.length && !target.bones.has(SPINE[i]); i++) if (src.deltas.has(SPINE[i])) use = SPINE[i];
    return use;
  };
  for (const b of order) {
    const arr = new Float32Array(F * 4);
    const delta = src.deltas.get(SPINE.includes(b) ? spineSource(b) : b);
    if (delta) {
      const fx = fix.get(b)!;
      for (let f = 0; f < F; f++) {
        q.fromArray(delta, f * 4).multiply(fx);
        q.toArray(arr, f * 4);
      }
    } else {
      // Source lacks the bone: hold the avatar's T-pose relation to its parent.
      const p = availableParent(b, (x) => world.has(x));
      if (p) arr.set(world.get(p)!);
      else for (let f = 0; f < F; f++) arr[f * 4 + 3] = 1;
    }
    world.set(b, arr);
  }

  // Local rotations.
  const bones = new Map<string, Float32Array>();
  const pq = new Quaternion();
  let prev: Quaternion | null = null;
  for (const b of order) {
    const w = world.get(b)!;
    const p = availableParent(b, (x) => target.bones.has(x));
    const pw = p ? world.get(p)! : null;
    const out = new Float32Array(F * 4);
    prev = null;
    for (let f = 0; f < F; f++) {
      q.fromArray(w, f * 4);
      if (pw) q.premultiply(pq.fromArray(pw, f * 4).invert());
      q.normalize();
      if (prev && prev.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
      prev = (prev ?? new Quaternion()).copy(q);
      q.toArray(out, f * 4);
    }
    bones.set(b, out);
  }

  // Hips translation, scaled to the avatar.
  let hips: Float32Array | null = null;
  const mode = opts.rootMotion ?? 'inplace';
  if (src.hips && mode !== 'off') {
    hips = new Float32Array(F * 3);
    const h = target.hipHeight;
    const x0 = src.hips[0], z0 = src.hips[2];
    const x1 = src.hips[(F - 1) * 3], z1 = src.hips[(F - 1) * 3 + 2];
    const lim = 0.35 * h;
    for (let f = 0; f < F; f++) {
      const t = F > 1 ? f / (F - 1) : 0;
      // In place: remove the travel (start-to-end drift) but keep sway and bob.
      const x = (src.hips[f * 3] - (x0 + (x1 - x0) * t)) * h;
      const y = src.hips[f * 3 + 1] * h;
      const z = (src.hips[f * 3 + 2] - (z0 + (z1 - z0) * t)) * h;
      hips[f * 3] = Math.max(-lim, Math.min(lim, x));
      hips[f * 3 + 1] = Math.max(-0.8 * h, Math.min(0.2 * h, y));
      hips[f * 3 + 2] = Math.max(-lim, Math.min(lim, z));
    }
  }
  return { name: src.name, fps: src.fps, frames: F, duration: (F - 1) / src.fps, bones, hips };
}

// ---------------------------------------------------------------- sampling & spaces

/** Sample a bound clip's bone at time t (seconds), slerping between frames. */
export function sampleBone(clip: BoundClip, bone: string, t: number, loop: boolean, out: Quaternion): Quaternion | null {
  const arr = clip.bones.get(bone);
  if (!arr) return null;
  const [i, j, a] = frameAt(clip, t, loop);
  out.fromArray(arr, i * 4);
  if (a > 0) out.slerp(_q.fromArray(arr, j * 4), a);
  return out;
}
const _q = new Quaternion();

export function sampleHips(clip: BoundClip, t: number, loop: boolean, out: Vector3): Vector3 | null {
  if (!clip.hips) return null;
  const [i, j, a] = frameAt(clip, t, loop);
  const h = clip.hips;
  return out.set(
    h[i * 3] + (h[j * 3] - h[i * 3]) * a,
    h[i * 3 + 1] + (h[j * 3 + 1] - h[i * 3 + 1]) * a,
    h[i * 3 + 2] + (h[j * 3 + 2] - h[i * 3 + 2]) * a,
  );
}

function frameAt(clip: BoundClip, t: number, loop: boolean): [number, number, number] {
  const F = clip.frames;
  if (F <= 1) return [0, 0, 0];
  let x = t * clip.fps;
  const last = F - 1;
  if (loop) {
    x %= last;
    if (x < 0) x += last;
  } else x = Math.max(0, Math.min(last, x));
  const i = Math.floor(x);
  const j = Math.min(last, i + 1);
  return [i, j, x - i];
}

/**
 * Solver space (+Z facing) -> a VRM's normalized-bone space. VRM 0.x
 * normalized bones face -Z: a 180 degree turn about Y, i.e. negate x and z.
 * Self-inverse. (Same convention as Avatar.toBone.)
 */
export function toVrmBone(q: Quaternion, vrm0: boolean, out = q): Quaternion {
  return vrm0 ? out.set(-q.x, q.y, -q.z, q.w) : out.copy(q);
}
export function toVrmDir(v: Vector3, vrm0: boolean, out = v): Vector3 {
  return vrm0 ? out.set(-v.x, v.y, -v.z) : out.copy(v);
}
