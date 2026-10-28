/**
 * Body colliders generated from the humanoid skeleton, with radii fitted to
 * the avatar's own skinned mesh, so cloth has something sensible to collide
 * with on any VRM (many models ship no leg or hip colliders at all).
 *
 *  - Limbs (upper/lower legs and arms): a capsule along the bone, joint to
 *    joint, radius = a percentile of the distance of the bone's vertices
 *    from that axis.
 *  - Neck and shoulders: capsules along the bones, as limbs.
 *  - Head: a short upright capsule through the middle of the head.
 *  - Torso (hips, spine, chest, upper chest): a capsule across the body
 *    (left-right), centred on the bone's vertices, radius from their
 *    front-back spread, length from their side-to-side spread.
 *
 * Vertices count for a bone when it carries most of their skin weight and
 * they carry (almost) no weight on spring bones, so a skirt or cape never
 * inflates the body it should collide with.
 *
 * Each capsule also gets a "core" radius (a lower percentile): the part
 * that is certainly inside the body. The test harness counts cloth inside
 * the core as clipping.
 */
import { Matrix4, Object3D, SkinnedMesh, Vector3 } from 'three';
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';

export interface BodyCapsule {
  name: string;
  bone: Object3D;
  /** Endpoints in the bone's local space. */
  a: Vector3;
  b: Vector3;
  r: number;
  /** Radius certainly inside the body (for measuring clipping). */
  core: number;
}

const LIMBS: Array<[VRMHumanBoneName, VRMHumanBoneName]> = [
  ['leftUpperLeg', 'leftLowerLeg'],
  ['rightUpperLeg', 'rightLowerLeg'],
  ['leftLowerLeg', 'leftFoot'],
  ['rightLowerLeg', 'rightFoot'],
  ['leftUpperArm', 'leftLowerArm'],
  ['rightUpperArm', 'rightLowerArm'],
  ['leftLowerArm', 'leftHand'],
  ['rightLowerArm', 'rightHand'],
  ['leftShoulder', 'leftUpperArm'],
  ['rightShoulder', 'rightUpperArm'],
  ['neck', 'head'],
];
const TORSO: VRMHumanBoneName[] = ['hips', 'spine', 'chest', 'upperChest'];

export interface FitOptions {
  /** Percentile of vertex distance used as the collision radius. */
  collide: number;
  /** Percentile used as the "inside the body" core radius. */
  core: number;
  /** Max vertices sampled across all meshes. */
  maxSamples: number;
}

export const DEFAULT_FIT: FitOptions = { collide: 0.8, core: 0.45, maxSamples: 120000 };

function quantile(a: number[], q: number): number {
  if (!a.length) return 0;
  const s = Float64Array.from(a).sort();
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];
}

/**
 * Fit body capsules to the avatar in its current (rest) pose.
 * @param springBones bones driven by spring physics (their vertices are cloth, not body)
 */
export function fitBodyColliders(vrm: VRM, springBones: Set<Object3D>, opts: FitOptions = DEFAULT_FIT): BodyCapsule[] {
  const h = vrm.humanoid;
  const raw = (n: VRMHumanBoneName) => h.getRawBoneNode(n);
  vrm.scene.updateMatrixWorld(true);
  const wpos = (o: Object3D) => o.getWorldPosition(new Vector3());

  // Which raw bones we fit, and the vertices dominated by each.
  const targets = new Map<Object3D, VRMHumanBoneName>();
  for (const [a] of LIMBS) {
    const n = raw(a);
    if (n) targets.set(n, a);
  }
  for (const t of [...TORSO, 'head'] as VRMHumanBoneName[]) {
    const n = raw(t);
    if (n) targets.set(n, t);
  }
  const verts = new Map<VRMHumanBoneName, Vector3[]>();
  // A vertex skinned to a non-humanoid helper bone (twist bones, e.g. Daz's
  // thigh_twist, or a pelvis under the hip) belongs to the nearest humanoid
  // ancestor of that bone.
  const humanoidNodes = new Set<Object3D>();
  for (const b of Object.values(h.humanBones)) if (b?.node) humanoidNodes.add(b.node);
  const owners = new Map<Object3D, VRMHumanBoneName | null>();
  const ownerOf = (b: Object3D): VRMHumanBoneName | null => {
    if (owners.has(b)) return owners.get(b)!;
    let o: Object3D | null = b;
    while (o && !humanoidNodes.has(o)) o = o.parent;
    const r = o ? (targets.get(o) ?? null) : null;
    owners.set(b, r);
    return r;
  };

  const meshes: SkinnedMesh[] = [];
  vrm.scene.traverse((o) => {
    if ((o as SkinnedMesh).isSkinnedMesh) meshes.push(o as SkinnedMesh);
  });
  let total = 0;
  for (const m of meshes) total += m.geometry.getAttribute('position')?.count ?? 0;
  const stride = Math.max(1, Math.ceil(total / opts.maxSamples));
  const v = new Vector3();
  for (const m of meshes) {
    const g = m.geometry;
    const pos = g.getAttribute('position');
    const si = g.getAttribute('skinIndex');
    const sw = g.getAttribute('skinWeight');
    if (!pos || !si || !sw) continue;
    const bones = m.skeleton.bones;
    m.skeleton.update?.();
    for (let i = 0; i < pos.count; i += stride) {
      let best = -1;
      let bw = 0;
      let springW = 0;
      for (let k = 0; k < 4; k++) {
        const wk = sw.getComponent(i, k);
        if (wk <= 0) continue;
        const b = bones[si.getComponent(i, k)];
        if (!b) continue;
        if (springBones.has(b)) springW += wk;
        if (wk > bw) {
          bw = wk;
          best = si.getComponent(i, k);
        }
      }
      if (best < 0 || springW > 0.05) continue;
      const name = ownerOf(bones[best]);
      if (!name) continue;
      m.getVertexPosition(i, v);
      v.applyMatrix4(m.matrixWorld);
      if (!verts.has(name)) verts.set(name, []);
      verts.get(name)!.push(v.clone());
    }
  }

  const out: BodyCapsule[] = [];
  const toLocal = (bone: Object3D, p: Vector3) => p.clone().applyMatrix4(new Matrix4().copy(bone.matrixWorld).invert());

  for (const [from, to] of LIMBS) {
    const bf = raw(from);
    const bt = raw(to);
    const vs = verts.get(from);
    if (!bf || !bt || !vs || vs.length < 12) continue;
    const A = wpos(bf);
    const B = wpos(bt);
    const axis = B.clone().sub(A);
    const L = axis.length();
    if (L < 1e-4) continue;
    axis.divideScalar(L);
    const dist: number[] = [];
    for (const p of vs) {
      const d = p.clone().sub(A);
      const t = d.dot(axis) / L;
      if (t < 0.08 || t > 0.92) continue;
      dist.push(d.addScaledVector(axis, -t * L).length());
    }
    if (dist.length < 8) continue;
    const r = Math.min(quantile(dist, opts.collide), 0.45 * L);
    const core = Math.min(quantile(dist, opts.core), r);
    out.push({ name: `body:${from}`, bone: bf, a: toLocal(bf, A), b: toLocal(bf, B), r, core });
  }

  // Head: a short vertical capsule through the middle of the head's vertices
  // (face and skull; hair on spring bones is excluded above). A lower
  // percentile than the body, as rigid hair or accessories may be skinned
  // to the head too.
  const headBone = raw('head');
  const hv = verts.get('head');
  if (headBone && hv && hv.length >= 12) {
    const xs = hv.map((p) => p.x), ys = hv.map((p) => p.y), zs = hv.map((p) => p.z);
    const c = new Vector3(quantile(xs, 0.5), quantile(ys, 0.5), quantile(zs, 0.5));
    const radial = hv.map((p) => Math.hypot(p.x - c.x, p.z - c.z));
    const r = quantile(radial, 0.6);
    const core = Math.min(quantile(radial, 0.35), r);
    const half = Math.max(0, quantile(hv.map((p) => Math.abs(p.y - c.y)), 0.6) - r);
    const A = c.clone().setY(c.y - half);
    const B = c.clone().setY(c.y + half);
    out.push({ name: 'body:head', bone: headBone, a: toLocal(headBone, A), b: toLocal(headBone, B), r, core });
  }

  // Torso: left-right axis from the legs (or arms), up = world up.
  const lr = new Vector3(1, 0, 0);
  const lu = raw('leftUpperLeg');
  const ru = raw('rightUpperLeg');
  if (lu && ru) lr.copy(wpos(lu)).sub(wpos(ru)).setY(0).normalize();
  const up = new Vector3(0, 1, 0);
  const fwd = new Vector3().crossVectors(lr, up).normalize();
  for (const name of TORSO) {
    const bone = raw(name);
    const vs = verts.get(name);
    if (!bone || !vs || vs.length < 12) continue;
    const o = wpos(bone);
    const xs: number[] = [], ys: number[] = [], zs: number[] = [];
    for (const p of vs) {
      const d = p.clone().sub(o);
      xs.push(d.dot(lr));
      ys.push(d.dot(up));
      zs.push(d.dot(fwd));
    }
    const cx = quantile(xs, 0.5), cy = quantile(ys, 0.5), cz = quantile(zs, 0.5);
    const dz = zs.map((z) => Math.abs(z - cz));
    const dx = xs.map((x) => Math.abs(x - cx));
    const r = quantile(dz, opts.collide);
    const core = Math.min(quantile(dz, opts.core), r);
    const half = Math.max(0, quantile(dx, 0.9) - r);
    const c = o.clone().addScaledVector(lr, cx).addScaledVector(up, cy).addScaledVector(fwd, cz);
    const A = c.clone().addScaledVector(lr, -half);
    const B = c.clone().addScaledVector(lr, half);
    out.push({ name: `body:${name}`, bone, a: toLocal(bone, A), b: toLocal(bone, B), r, core });
  }
  return out;
}

/** World endpoints of a body capsule. */
export function capsuleWorld(c: BodyCapsule, a: Vector3, b: Vector3): void {
  a.copy(c.a).applyMatrix4(c.bone.matrixWorld);
  b.copy(c.b).applyMatrix4(c.bone.matrixWorld);
}
