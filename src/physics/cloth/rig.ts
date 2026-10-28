/**
 * ClothRig: builds a ClothSolver from a VRM's spring joints, feeds it the
 * animated body every fixed step, and writes the result back to the bones.
 *
 * Replaces three-vrm's per-joint spring update (it uses the same joint data
 * and the same stiffness / drag / gravity meaning), adding:
 *  - cloth links between neighbouring chains (auto-detected groups);
 *  - segment-vs-capsule collision with swept colliders;
 *  - generated body colliders (bodyColliders.ts) next to the VRM's own;
 *  - per-step interpolation of the animated roots and colliders, so a large
 *    frame (a hitch) is spread over the steps instead of arriving at once.
 */
import { Matrix4, Object3D, Quaternion, Vector3 } from 'three';
import type { VRMSpringBoneCollider, VRMSpringBoneJoint } from '@pixiv/three-vrm';
import { ClothSolver, closestSegSeg, type EdgeDef, type LinkDef } from './solver';
import { detectGroups, kindOf, type ChainInfo, type ClothGroup, type GroupKind } from './groups';
import type { BodyCapsule } from './bodyColliders';

interface JointInternals {
  _initialLocalMatrix: Matrix4;
  _initialLocalRotation: Quaternion;
  _boneAxis: Vector3;
  _initialLocalChildPosition: Vector3;
}
const JI = (j: VRMSpringBoneJoint) => j as unknown as JointInternals;

export interface LinkPreset {
  /** XPBD compliance when a link is stretched / compressed (Infinity = free). */
  stretch: number;
  compress: number;
  /** Diagonal (shear) links; Infinity = none. */
  shear: number;
  /** Max swing of a joint away from its rest direction, degrees. */
  maxAngle: number;
}

export const LINK_PRESETS: Record<GroupKind, LinkPreset> = {
  skirt: { stretch: 2e-7, compress: 3e-5, shear: 2e-4, maxAngle: 70 },
  cape: { stretch: 2e-7, compress: 5e-5, shear: 3e-4, maxAngle: 75 },
  sleeve: { stretch: 2e-7, compress: 5e-5, shear: 3e-4, maxAngle: 70 },
  // Hair: neighbouring strands are tied against spreading apart (no splaying
  // into separate spikes) but may bunch together freely.
  hair: { stretch: 2e-6, compress: 1e-3, shear: Infinity, maxAngle: 100 },
  other: { stretch: 1e-6, compress: 1e-4, shear: Infinity, maxAngle: 100 },
};
/**
 * Which generated body colliders each kind of chain collides with. Skirts
 * ignore the arms: idle arms hang where a skirt's rest shape is, and hands
 * flaring a skirt out reads far worse than lace brushing a hand.
 */
const BODY_FOR_KIND: Record<GroupKind, RegExp> = {
  skirt: /hips|spine|UpperLeg|LowerLeg/,
  cape: /hips|spine|chest|Chest|neck|Shoulder|Arm|Leg/,
  sleeve: /hips|spine|chest|Chest|UpperLeg|LowerLeg/,
  hair: /head|neck|Shoulder|spine|chest|Chest|UpperArm/,
  other: /hips|spine|chest|Chest|neck|Shoulder|Arm|Leg/,
};
const SINGLE_MAX_ANGLE: Record<GroupKind, number> = { skirt: 75, cape: 80, sleeve: 75, hair: 110, other: 120 };

/**
 * Does the idle pose (arms down) also count as rest for this collider/edge
 * pair? Where the arms moved one relative to the other: an arm collider vs a
 * chain that does not hang off an arm (hands through a skirt). And a body
 * collider vs a chain on the arm whose animated root sits in the collider's
 * contact zone in the idle pose (a claw or tassel on the forearm that ends up
 * at the hip once the arms are down): the solver can only push the tail, the
 * root pulls it straight back in, and the chain jitters forever (found by the
 * compatibility sweep). Only that root edge is relaxed; a sleeve ribbon whose
 * root is clear of the hip is still held outside it.
 */
export function idlePoseIsRest(colliderOnArm: boolean, chainAnchor: string, rootInside = false): boolean {
  const chainOnArm = /Shoulder|UpperArm|LowerArm|Hand/.test(chainAnchor);
  return (colliderOnArm && !chainOnArm) || (rootInside && colliderOnArm !== chainOnArm);
}

export interface GroupOverride {
  /** Cloth links on (off = the chains swing as independent strands). */
  enabled: boolean;
  /** Multiplier on link stiffness. */
  stiffness: number;
}
export const DEFAULT_GROUP: GroupOverride = { enabled: true, stiffness: 1 };

export interface RigChain {
  name: string;
  joints: VRMSpringBoneJoint[];
  /** For a strand: the chain (spring name) it was split from, as listed in the UI. */
  chain?: string;
}

/**
 * Split chains into strands: one per root. A VRM may give one spring name to
 * many strands (VRoid: every hair strand is "Hair"), which the UI lists as one
 * chain but cloth needs as separate, neighbouring strands.
 */
export function splitStrands(chains: RigChain[]): RigChain[] {
  const out: RigChain[] = [];
  for (const c of chains) {
    const byBone = new Map<Object3D, VRMSpringBoneJoint>();
    for (const j of c.joints) if (j.child) byBone.set(j.child, j);
    const rootOf = (j: VRMSpringBoneJoint): Object3D => {
      let cur = j;
      for (let guard = 0; guard < 1000; guard++) {
        const p = byBone.get(cur.bone);
        if (!p) break;
        cur = p;
      }
      return cur.bone;
    };
    const strands = new Map<Object3D, VRMSpringBoneJoint[]>();
    for (const j of c.joints) {
      const r = rootOf(j);
      if (!strands.has(r)) strands.set(r, []);
      strands.get(r)!.push(j);
    }
    let k = 0;
    for (const js of strands.values()) {
      out.push({ name: strands.size > 1 ? `${c.name}#${++k}` : c.name, joints: js, chain: c.name });
    }
  }
  return out;
}

export interface RigCollider {
  name: string;
  /** 'vrm' = from the model file, 'body' = generated. */
  source: 'vrm' | 'body';
  vrm?: VRMSpringBoneCollider;
  body?: BodyCapsule;
  /** The Object3D whose matrixWorld places it. */
  host: Object3D;
}

export interface RigConfig {
  stiff: boolean;
  bodyColliders: boolean;
  chainEnabled: (chain: string) => boolean;
  colliderEnabled: (name: string) => boolean;
  group: (name: string) => GroupOverride;
  assign: Record<string, string>;
}

interface Edge {
  joint: VRMSpringBoneJoint;
  bone: Object3D;
  /** Writes the bone (false for a second joint on an already-written bone). */
  write: boolean;
  chain: number;
  initLocal: Matrix4;
  initRot: Quaternion;
  axis: Vector3;
  childLocal: Vector3;
}

const _m = new Matrix4();
const _m2 = new Matrix4();
const _v = new Vector3();
const _v2 = new Vector3();
const _q = new Quaternion();
const _s = new Vector3();

export class ClothRig {
  readonly solver: ClothSolver;
  /** Strands (chains split per root; `chain` names the UI chain). */
  readonly chains: RigChain[];
  readonly colliders: RigCollider[];
  groups: ClothGroup[] = [];
  /** Kind of each chain (its group's, or guessed from its anchor and direction). */
  chainKinds: GroupKind[] = [];
  /** Chain anchor (nearest humanoid ancestor of its root), per chain. */
  readonly anchors: string[];
  /** Particle path root -> tip per chain (for grouping and metrics). */
  readonly chainParticles: number[][];
  /** Edge indices per chain. */
  readonly chainEdges: number[][];
  readonly edges: Edge[] = [];
  /** Particle -> Object3D whose rest position it is (null = virtual tail). */
  readonly particleNode: Array<Object3D | null> = [];

  private rootEdges: number[] = [];
  private updateList: Object3D[] = [];
  /** Animated targets at the last step and now (for interpolation across steps). */
  private rootPrev: Float64Array;
  private rootNow: Float64Array;
  private framePrev: Float64Array;
  private frameNow: Float64Array;
  private capPrev: Float64Array;
  private capNow: Float64Array;
  private capR: Float64Array;
  private restRadiusCap: Float64Array[] = [];
  private kinds: GroupKind[] = [];
  private stiffMul = new Float64Array(0);
  private colliderOnArm: boolean[] = [];
  private hasPrev = false;

  constructor(uiChains: RigChain[], colliders: RigCollider[], humanoidBones: Map<Object3D, string>) {
    const chains = splitStrands(uiChains);
    this.chains = chains;
    this.colliders = colliders;

    // Particles and edges, parents first.
    const pIndex = new Map<Object3D, number>();
    const particle = (o: Object3D | null): number => {
      if (o && pIndex.has(o)) return pIndex.get(o)!;
      const i = this.particleNode.length;
      this.particleNode.push(o);
      if (o) pIndex.set(o, i);
      return i;
    };
    const chainOf = new Map<VRMSpringBoneJoint, number>();
    chains.forEach((c, i) => c.joints.forEach((j) => chainOf.set(j, i)));
    const all = chains.flatMap((c) => c.joints);
    const byBone = new Map<Object3D, VRMSpringBoneJoint[]>();
    for (const j of all) {
      if (!byBone.has(j.bone)) byBone.set(j.bone, []);
      byBone.get(j.bone)!.push(j);
    }
    const tails = new Set(all.map((j) => j.child).filter((c): c is Object3D => !!c));
    const order: VRMSpringBoneJoint[] = [];
    const visit = (j: VRMSpringBoneJoint) => {
      order.push(j);
      if (j.child) for (const k of byBone.get(j.child) ?? []) visit(k);
    };
    for (const j of all) if (!tails.has(j.bone)) visit(j);
    // Anything unreachable (cycles shouldn't happen) goes last.
    for (const j of all) if (!order.includes(j)) order.push(j);

    const edgeDefs: EdgeDef[] = [];
    const edgeOfTail = new Map<Object3D, number>();
    const written = new Set<Object3D>();
    const tmpV = new Vector3();
    for (const j of order) {
      const ji = JI(j);
      const head = particle(j.bone);
      const tail = particle(j.child ?? null);
      const parent = edgeOfTail.get(j.bone) ?? -1;
      const e = edgeDefs.length;
      // Rest length in world units.
      j.bone.updateWorldMatrix(true, false);
      const hw = new Vector3().setFromMatrixPosition(j.bone.matrixWorld);
      const tw = tmpV.copy(ji._initialLocalChildPosition).applyMatrix4(j.bone.matrixWorld);
      edgeDefs.push({
        head,
        tail,
        parent,
        restLocal: [ji._initialLocalRotation.x, ji._initialLocalRotation.y, ji._initialLocalRotation.z, ji._initialLocalRotation.w],
        axis: [ji._boneAxis.x, ji._boneAxis.y, ji._boneAxis.z],
        length: Math.max(1e-5, hw.distanceTo(tw)),
      });
      if (j.child) edgeOfTail.set(j.child, e);
      this.edges.push({
        joint: j,
        bone: j.bone,
        write: !written.has(j.bone),
        chain: chainOf.get(j) ?? 0,
        initLocal: ji._initialLocalMatrix.clone(),
        initRot: ji._initialLocalRotation.clone(),
        axis: ji._boneAxis.clone(),
        childLocal: ji._initialLocalChildPosition.clone(),
      });
      written.add(j.bone);
      if (parent < 0) this.rootEdges.push(e);
    }
    this.solver = new ClothSolver(this.particleNode.length, edgeDefs);
    for (let e = 0; e < this.edges.length; e++) this.solver.radius[edgeDefs[e].tail] = this.edges[e].joint.settings.hitRadius;

    // Chain paths (longest path through each chain's edges).
    this.chainEdges = chains.map(() => []);
    this.edges.forEach((ed, i) => this.chainEdges[ed.chain].push(i));
    this.chainParticles = this.chainEdges.map((es) => {
      if (!es.length) return [];
      const depth = new Map<number, number>();
      for (const e of es) depth.set(e, (depth.get(this.solver.eParent[e]) ?? 0) + 1);
      let tip = es[0];
      for (const e of es) if ((depth.get(e) ?? 0) > (depth.get(tip) ?? 0)) tip = e;
      const path: number[] = [];
      let e = tip;
      while (e >= 0 && es.includes(e)) {
        path.unshift(this.solver.eTail[e]);
        const p = this.solver.eParent[e];
        if (p < 0 || !es.includes(p)) {
          path.unshift(this.solver.eHead[e]);
          break;
        }
        e = p;
      }
      return path;
    });

    // Anchors: nearest humanoid ancestor of each chain's root bone.
    this.anchors = chains.map((c) => {
      let o: Object3D | null = c.joints[0]?.bone.parent ?? null;
      while (o) {
        const n = humanoidBones.get(o);
        if (n) return n;
        o = o.parent;
      }
      return 'none';
    });

    // Colliders on the arms (they move between T-pose and the idle pose).
    this.colliderOnArm = colliders.map((c) => {
      let o: Object3D | null = c.host;
      while (o && !humanoidBones.has(o)) o = o.parent;
      return !!o && /UpperArm|LowerArm|Hand/.test(humanoidBones.get(o)!);
    });

    // Matrix update list: ancestors of roots and collider hosts, root first.
    const need = new Set<Object3D>();
    const addAnc = (o: Object3D | null) => {
      const chain: Object3D[] = [];
      while (o && !need.has(o)) {
        chain.push(o);
        o = o.parent;
      }
      for (const x of chain) need.add(x);
    };
    for (const e of this.rootEdges) addAnc(this.edges[e].bone.parent);
    for (const c of colliders) addAnc(c.host);
    const depthOf = (o: Object3D) => {
      let d = 0;
      for (let p = o.parent; p; p = p.parent) d++;
      return d;
    };
    this.updateList = [...need].sort((a, b) => depthOf(a) - depthOf(b));

    const nP = this.particleNode.length;
    this.rootPrev = new Float64Array(3 * nP);
    this.rootNow = new Float64Array(3 * nP);
    this.framePrev = new Float64Array(4 * this.edges.length);
    this.frameNow = new Float64Array(4 * this.edges.length);
    this.solver.setCapsuleCount(colliders.length);
    this.capPrev = new Float64Array(6 * colliders.length);
    this.capNow = new Float64Array(6 * colliders.length);
    this.capR = new Float64Array(colliders.length);

    // Rest pose: capture, reset, and the rest-distance caps for colliders.
    this.capture();
    this.snap();
    this.computeRestCaps();
    this.restInfos = this.chainInfos();
    this.restX = Float64Array.from(this.solver.x);
    this.capNowRest = Float64Array.from(this.capNow);
    this.kinds = this.restInfos.map((c) => {
      const a = c.points[0];
      const b = c.points[c.points.length - 1];
      const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) || 1;
      return kindOf(c.anchor, [(b[0] - a[0]) / d, (b[1] - a[1]) / d, (b[2] - a[2]) / d]);
    });
  }

  /** Chain descriptions for grouping (rest positions). */
  chainInfos(): ChainInfo[] {
    const x = this.solver.x;
    return this.chains.map((c, i) => ({
      name: c.name,
      anchor: this.anchors[i],
      points: this.chainParticles[i].map((p) => [x[3 * p], x[3 * p + 1], x[3 * p + 2]] as [number, number, number]),
    }));
  }

  /**
   * Per edge, per collider: the largest contact distance (capsule radius +
   * particle radius) that the edge's segment already clears at rest. Contacts
   * are capped to it, so nothing that overlaps in the model as authored (a
   * skirt root inside a hip collider) is pushed out at load or fights the
   * collider forever. Pairs that overlap at rest get 0 (no contact).
   */
  private computeRestCaps(): void {
    const s = this.solver;
    const seg = new Float64Array(2);
    const prev = this.restRadiusCap;
    this.restRadiusCap = this.edges.map((_, e) => {
      const caps = new Float64Array(this.colliders.length);
      const h = 3 * s.eHead[e], t = 3 * s.eTail[e];
      for (let c = 0; c < this.colliders.length; c++) {
        const o = 6 * c;
        const a = this.capNow, x = s.x;
        closestSegSeg(x[h], x[h + 1], x[h + 2], x[t], x[t + 1], x[t + 2], a[o], a[o + 1], a[o + 2], a[o + 3], a[o + 4], a[o + 5], seg);
        const sp = seg[0], u = seg[1];
        const d = Math.hypot(
          x[h] + (x[t] - x[h]) * sp - (a[o] + (a[o + 3] - a[o]) * u),
          x[h + 1] + (x[t + 1] - x[h + 1]) * sp - (a[o + 1] + (a[o + 4] - a[o + 1]) * u),
          x[h + 2] + (x[t + 2] - x[h + 2]) * sp - (a[o + 2] + (a[o + 5] - a[o + 2]) * u),
        );
        const cap = d - 0.003;
        caps[c] = cap > s.radius[s.eTail[e]] + 0.005 ? cap : 0;
        if (prev[e]) {
          // A chain's animated root inside the collider's contact zone (it cannot be pushed out).
          let rootStuck = false;
          if (s.eParent[e] < 0) {
            closestSegSeg(x[h], x[h + 1], x[h + 2], x[h], x[h + 1], x[h + 2], a[o], a[o + 1], a[o + 2], a[o + 3], a[o + 4], a[o + 5], seg);
            const v = seg[1];
            const dh = Math.hypot(
              x[h] - (a[o] + (a[o + 3] - a[o]) * v),
              x[h + 1] - (a[o + 1] + (a[o + 4] - a[o + 1]) * v),
              x[h + 2] - (a[o + 2] + (a[o + 5] - a[o + 2]) * v),
            );
            rootStuck = dh < this.capR[c] + s.radius[s.eTail[e]] + 0.005;
          }
          caps[c] = idlePoseIsRest(this.colliderOnArm[c], this.anchors[this.edges[e].chain], rootStuck) ? Math.min(caps[c], prev[e][c]) : prev[e][c];
        }
      }
      return caps;
    });
  }

  /**
   * Also treat the current body pose (the app's idle: arms down at the
   * sides) as rest for the arm colliders: where a chain's rest shape overlaps
   * an idle arm (hands through a skirt, hair over the arms), it is left alone,
   * as it is in the model with physics off. Call once after the idle pose is
   * applied, then configure() again.
   */
  addRestPose(): void {
    this.capture();
    this.snap();
    this.computeRestCaps();
  }

  /** Apply settings: groups/links, enabled chains, colliders, angle limits. */
  configure(cfg: RigConfig): void {
    const s = this.solver;
    const infos = this.chainInfosRest();
    // Assignments are made per UI chain (spring name); apply them to its strands.
    const assign: Record<string, string> = {};
    for (const c of this.chains) {
      const a = cfg.assign[c.name] ?? cfg.assign[c.chain ?? c.name];
      if (a) assign[c.name] = a;
    }
    // Chains either side of the head or neck aren't one sheet (front braids).
    const seg = new Float64Array(2);
    const between = this.colliders
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.body && /head|neck/.test(c.name));
    const blocked = (a: [number, number, number], b: [number, number, number]) =>
      between.some(({ c, i }) => {
        const o = 6 * i;
        const k = this.capNowRest;
        closestSegSeg(a[0], a[1], a[2], b[0], b[1], b[2], k[o], k[o + 1], k[o + 2], k[o + 3], k[o + 4], k[o + 5], seg);
        const px = a[0] + (b[0] - a[0]) * seg[0], py = a[1] + (b[1] - a[1]) * seg[0], pz = a[2] + (b[2] - a[2]) * seg[0];
        const qx = k[o] + (k[o + 3] - k[o]) * seg[1], qy = k[o + 1] + (k[o + 4] - k[o + 1]) * seg[1], qz = k[o + 2] + (k[o + 5] - k[o + 2]) * seg[1];
        return Math.hypot(px - qx, py - qy, pz - qz) < c.body!.core;
      });
    this.groups = detectGroups(infos, { maxAngle: (60 * Math.PI) / 180, assign, blocked });
    const stiffDiv = cfg.stiff ? 10 : 1;
    const links: LinkDef[] = [];
    const chainKind = [...this.kinds];
    this.chainKinds = chainKind;
    for (const g of this.groups) {
      const o = cfg.group(g.name);
      for (const c of g.chains) chainKind[c] = g.kind;
      if (!o.enabled) continue;
      const pre = LINK_PRESETS[g.kind];
      const k = Math.max(1e-3, o.stiffness) * stiffDiv;
      const n = g.chains.length;
      const pairs = g.closed ? n : n - 1;
      for (let i = 0; i < pairs; i++) {
        const A = this.chainParticles[g.chains[i]];
        const B = this.chainParticles[g.chains[(i + 1) % n]];
        const map = (ka: number) => Math.min(B.length - 1, Math.round((ka * (B.length - 1)) / Math.max(1, A.length - 1)));
        for (let ka = 1; ka < A.length; ka++) {
          const kb = map(ka);
          if (kb < 1) continue;
          links.push(this.link(A[ka], B[kb], pre.stretch / k, pre.compress / k));
          if (isFinite(pre.shear)) {
            if (kb + 1 < B.length) links.push(this.link(A[ka], B[kb + 1], pre.shear / k, pre.shear / k));
            if (ka + 1 < A.length) links.push(this.link(A[ka + 1], B[kb], pre.shear / k, pre.shear / k));
          }
        }
      }
    }
    s.setLinks(links);

    const inGroup = new Set(this.groups.flatMap((g) => g.chains));
    // Drape: cloth hangs from its top; joint stiffness fades toward the hem so
    // the lower part falls and folds instead of the chain acting as a rigid stick.
    const drape = cfg.stiff ? 0.35 : 0.65;
    this.stiffMul = new Float64Array(this.edges.length).fill(1);
    for (let c = 0; c < this.chains.length; c++) {
      if (!(chainKind[c] === 'skirt' || chainKind[c] === 'cape')) continue;
      const path = this.chainParticles[c];
      const n = path.length - 1;
      for (const e of this.chainEdges[c]) {
        const k = path.indexOf(s.eTail[e]) - 1;
        if (k >= 0 && n > 1) this.stiffMul[e] = 1 - drape * (k / (n - 1));
      }
    }
    for (let e = 0; e < this.edges.length; e++) {
      const c = this.edges[e].chain;
      s.enabled[e] = cfg.chainEnabled(this.chains[c].chain ?? this.chains[c].name) ? 1 : 0;
      const kind = chainKind[c];
      const deg = inGroup.has(c) ? LINK_PRESETS[kind].maxAngle : SINGLE_MAX_ANGLE[kind];
      s.maxAngle[e] = ((cfg.stiff ? 0.7 : 1) * deg * Math.PI) / 180;
    }

    // Colliders per edge: the joint's own VRM collider groups, plus every generated body collider.
    const vrmIndex = new Map<VRMSpringBoneCollider, number>();
    this.colliders.forEach((c, i) => {
      if (c.vrm) vrmIndex.set(c.vrm, i);
      s.capEnabled[i] = cfg.colliderEnabled(c.name) && (c.source === 'vrm' || cfg.bodyColliders) ? 1 : 0;
    });
    const body = this.colliders.map((c, i) => (c.source === 'body' ? i : -1)).filter((i) => i >= 0);
    for (let e = 0; e < this.edges.length; e++) {
      const set = new Set<number>();
      for (const g of this.edges[e].joint.colliderGroups) for (const c of this.groupOriginal(g)) {
        const i = vrmIndex.get(c);
        if (i != null) set.add(i);
      }
      const allow = BODY_FOR_KIND[chainKind[this.edges[e].chain]];
      for (const i of body) if (allow.test(this.colliders[i].name)) set.add(i);
      const list = Int32Array.from([...set].filter((i) => this.restRadiusCap[e][i] > 0));
      s.eColliders[e] = list;
      s.eColliderR[e] = Float64Array.from(list, (i) => this.restRadiusCap[e][i]);
    }
    this.syncParams();
  }

  /** Original (untoggled) collider list of a group; StableSprings filters group.colliders for the legacy solver. */
  groupOriginal: (g: { colliders: VRMSpringBoneCollider[] }) => VRMSpringBoneCollider[] = (g) => g.colliders;

  private restInfos: ChainInfo[] = [];
  /** Particle positions at rest (as at load). */
  private restX = new Float64Array(0);
  /** Collider endpoints at rest (as at load). */
  private capNowRest = new Float64Array(0);
  /** Chain rest shapes (as at load). */
  chainInfosRest(): ChainInfo[] {
    return this.restInfos;
  }

  private link(a: number, b: number, stretch: number, compress: number): LinkDef {
    const x = this.restX;
    const rest = Math.hypot(x[3 * a] - x[3 * b], x[3 * a + 1] - x[3 * b + 1], x[3 * a + 2] - x[3 * b + 2]);
    return { a, b, rest, stretch, compress };
  }

  /** Copy per-joint stiffness / drag / gravity (already multiplied by mode and chain overrides). */
  syncParams(): void {
    const s = this.solver;
    for (let e = 0; e < this.edges.length; e++) {
      const st = this.edges[e].joint.settings;
      s.stiffness[e] = st.stiffness * (this.stiffMul[e] ?? 1);
      s.drag[e] = Math.min(1, Math.max(0, st.dragForce));
      s.gravity[3 * e] = st.gravityDir.x * st.gravityPower;
      s.gravity[3 * e + 1] = st.gravityDir.y * st.gravityPower;
      s.gravity[3 * e + 2] = st.gravityDir.z * st.gravityPower;
      s.radius[s.eTail[e]] = st.hitRadius;
    }
  }

  /** Bring the matrices we read up to date (ancestors first). */
  private updateMatrices(): void {
    for (const o of this.updateList) {
      if (o.matrixAutoUpdate) o.updateMatrix();
      if (o.parent) o.matrixWorld.multiplyMatrices(o.parent.matrixWorld, o.matrix);
      else o.matrixWorld.copy(o.matrix);
    }
  }

  /** Read the animated pose: chain roots, their parent frames, colliders. */
  capture(): void {
    this.updateMatrices();
    const s = this.solver;
    for (const e of this.rootEdges) {
      const ed = this.edges[e];
      const parent = ed.bone.parent;
      const pw = parent ? parent.matrixWorld : _m.identity();
      _v.copy(ed.bone.position).applyMatrix4(pw);
      const p = s.eHead[e];
      this.rootNow[3 * p] = _v.x;
      this.rootNow[3 * p + 1] = _v.y;
      this.rootNow[3 * p + 2] = _v.z;
      pw.decompose(_v2, _q, _s);
      this.frameNow[4 * e] = _q.x;
      this.frameNow[4 * e + 1] = _q.y;
      this.frameNow[4 * e + 2] = _q.z;
      this.frameNow[4 * e + 3] = _q.w;
    }
    this.colliders.forEach((c, i) => {
      const o = 6 * i;
      if (c.vrm) {
        const shape = c.vrm.shape as unknown as { type: string; offset: Vector3; tail?: Vector3; radius: number; inside?: boolean };
        const mw = c.vrm.matrixWorld;
        _v.copy(shape.offset).applyMatrix4(mw);
        _v2.copy(shape.tail ?? shape.offset).applyMatrix4(mw);
        // Plane and "inside" colliders (VRM extended colliders) aren't supported by the cloth solver.
        this.capR[i] = shape.type === 'plane' || shape.inside ? -1e9 : shape.radius;
      } else if (c.body) {
        _v.copy(c.body.a).applyMatrix4(c.body.bone.matrixWorld);
        _v2.copy(c.body.b).applyMatrix4(c.body.bone.matrixWorld);
        this.capR[i] = c.body.r;
      }
      this.capNow[o] = _v.x;
      this.capNow[o + 1] = _v.y;
      this.capNow[o + 2] = _v.z;
      this.capNow[o + 3] = _v2.x;
      this.capNow[o + 4] = _v2.y;
      this.capNow[o + 5] = _v2.z;
    });
  }

  /** Make the last-step pose equal the captured one (no interpolation from stale state). */
  private snapPrev(): void {
    this.rootPrev.set(this.rootNow);
    this.framePrev.set(this.frameNow);
    this.capPrev.set(this.capNow);
  }

  /** Reset to the rest shape at the current (captured) pose. */
  snap(): void {
    this.snapPrev();
    this.push(1, true);
    this.solver.resetToRest();
    this.hasPrev = true;
  }

  /** Hand the solver the targets interpolated at alpha between the last step and now. */
  private push(alpha: number, snap = false): void {
    const s = this.solver;
    const v: [number, number, number] = [0, 0, 0];
    const q: [number, number, number, number] = [0, 0, 0, 1];
    const qa = new Quaternion();
    const qb = new Quaternion();
    for (const e of this.rootEdges) {
      const p = s.eHead[e];
      for (let k = 0; k < 3; k++) v[k] = this.rootPrev[3 * p + k] + (this.rootNow[3 * p + k] - this.rootPrev[3 * p + k]) * alpha;
      s.setRoot(p, v, snap);
      qa.fromArray(this.framePrev, 4 * e);
      qb.fromArray(this.frameNow, 4 * e);
      qa.slerp(qb, alpha);
      q[0] = qa.x; q[1] = qa.y; q[2] = qa.z; q[3] = qa.w;
      s.setRootFrame(e, q, snap);
    }
    const a: [number, number, number] = [0, 0, 0];
    const b: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < this.colliders.length; i++) {
      const o = 6 * i;
      for (let k = 0; k < 3; k++) {
        a[k] = this.capPrev[o + k] + (this.capNow[o + k] - this.capPrev[o + k]) * alpha;
        b[k] = this.capPrev[o + 3 + k] + (this.capNow[o + 3 + k] - this.capPrev[o + 3 + k]) * alpha;
      }
      s.setCapsule(i, { a, b, r: this.capR[i] }, snap);
    }
  }

  /**
   * Run `steps` fixed steps of h seconds from the last stepped pose to the
   * captured one. Call capture() first.
   */
  run(steps: number, h: number): void {
    if (!this.hasPrev) {
      this.snap();
      return;
    }
    for (let i = 0; i < steps; i++) {
      this.push((i + 1) / steps);
      this.solver.step(h);
    }
    if (steps > 0) this.snapPrev();
  }

  /** Inertia: carry free particles by share k of a rigid world transform. */
  carry(m: Matrix4, k: number): void {
    const e = m.elements;
    // three.js is column-major; the solver takes a row-major 3x4.
    this.solver.carry([e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14]], k);
  }

  /** Write particle positions back to bone rotations (three-vrm's formula). */
  writeBack(): void {
    const s = this.solver;
    for (let e = 0; e < this.edges.length; e++) {
      const ed = this.edges[e];
      if (!ed.write) continue;
      const bone = ed.bone;
      const pw = bone.parent ? bone.parent.matrixWorld : _m2.identity();
      _m.multiplyMatrices(pw, ed.initLocal).invert();
      const t = 3 * s.eTail[e];
      _v.set(s.x[t], s.x[t + 1], s.x[t + 2]).applyMatrix4(_m);
      if (_v.lengthSq() < 1e-14) continue;
      _v.normalize();
      bone.quaternion.setFromUnitVectors(ed.axis, _v).premultiply(ed.initRot);
      bone.updateMatrix();
      bone.matrixWorld.multiplyMatrices(pw, bone.matrix);
    }
  }

  /** Put every bone at its rest rotation (physics off). */
  writeRest(): void {
    for (const ed of this.edges) {
      if (!ed.write) continue;
      ed.bone.quaternion.copy(ed.initRot);
      ed.bone.updateMatrix();
      const pw = ed.bone.parent ? ed.bone.parent.matrixWorld : _m2.identity();
      ed.bone.matrixWorld.multiplyMatrices(pw, ed.bone.matrix);
    }
  }

  /** Forget motion: next run() starts from rest at the then-current pose. */
  invalidate(): void {
    this.hasPrev = false;
  }
}
