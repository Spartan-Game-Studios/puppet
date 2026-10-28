/**
 * Spring-bone physics for VRM hair, cloth and accessories.
 *
 * Two solvers behind one interface:
 *  - 'cloth' (default): src/physics/cloth/ — a PBD bone-cloth solver that
 *    links neighbouring chains into cloth, collides whole segments with
 *    swept capsules, and adds body colliders fitted to the mesh.
 *  - 'legacy': three-vrm's own VRMSpringBoneManager, stabilised as below.
 *
 * Legacy: stabilised spring-bone physics on top of three-vrm's VRMSpringBoneManager.
 *
 * three-vrm's solver is a verlet step whose stiffness and gravity terms scale
 * with the frame delta. Fed straight from requestAnimationFrame, a 100 ms
 * frame spike (or a tracking jump on the hips) injects a large impulse in one
 * step and long chains like a skirt whip and thrash. This wrapper:
 *
 *  - steps the solver at a fixed rate with substeps, decoupled from frame rate
 *    (the accumulator is clamped, so a stall never replays as a burst);
 *  - clamps each tail's per-step displacement (max speed), so no single step
 *    can carry more than a bounded amount of energy;
 *  - damps velocity on joints that hit a collider, so leg colliders pushing
 *    a skirt out don't pump energy back in every step;
 *  - optionally removes a share of the body's own translation/rotation from
 *    the tails ("inertia"), so whole-body sway moves hair and cloth with the
 *    body instead of leaving it behind;
 *  - exposes a global mode (off / stiff / normal) and per-chain overrides
 *    (on/off, stiffness/drag/gravity multipliers) plus per-collider toggles.
 *
 * Tracking-side smoothing of the root and hips (before physics sees them) is
 * done by the avatar driver; see src/scene/avatar.ts.
 */
import { Matrix4, Object3D, Vector3 } from 'three';
import type { VRM } from '@pixiv/three-vrm';
import type { VRMSpringBoneJoint, VRMSpringBoneColliderGroup, VRMSpringBoneCollider } from '@pixiv/three-vrm';
import { ClothRig, DEFAULT_GROUP, type GroupOverride, type RigCollider } from './cloth/rig';
import { fitBodyColliders, type BodyCapsule } from './cloth/bodyColliders';
import type { ClothGroup } from './cloth/groups';

export type PhysicsMode = 'off' | 'stiff' | 'normal';
export type PhysicsSolver = 'cloth' | 'legacy';

export interface PhysicsSettings {
  mode: PhysicsMode;
  /** 'cloth' = bone-cloth solver; 'legacy' = three-vrm's spring bones (stabilised). */
  solver: PhysicsSolver;
  /** Cloth solver: add colliders generated from the body (hips, legs, torso, arms). */
  bodyColliders: boolean;
  /** Fixed-step + clamps. Off = three-vrm's plain per-frame update (for comparison). */
  stabilise: boolean;
  /** Fixed steps per second (before substeps). */
  rate: number;
  substeps: number;
  /** Max tail speed, metres per second. */
  maxSpeed: number;
  /** 0..1: share of a joint's velocity removed when it hits a collider. */
  collisionDamping: number;
  /** 0..1: how much of the body's own motion the tails feel (1 = plain world space). */
  inertia: number;
  /** Longest frame delta accepted into the accumulator, seconds. */
  maxFrameDelta: number;
}

export const DEFAULT_PHYSICS: PhysicsSettings = {
  mode: 'normal',
  solver: 'cloth',
  bodyColliders: true,
  stabilise: true,
  rate: 60,
  substeps: 2,
  maxSpeed: 3,
  collisionDamping: 0.6,
  inertia: 0.6,
  maxFrameDelta: 1 / 15,
};

export interface ChainOverride {
  enabled: boolean;
  stiffness: number;
  drag: number;
  gravity: number;
}

export const DEFAULT_CHAIN: ChainOverride = { enabled: true, stiffness: 1, drag: 1, gravity: 1 };

export interface PhysicsOverrides {
  chains: Record<string, ChainOverride>;
  colliders: Record<string, boolean>;
  /** Cloth groups (by group name): links on/off and stiffness. */
  groups?: Record<string, GroupOverride>;
  /** Grouping overrides: chain name -> group name, 'none' (single strand) or 'auto'. */
  assign?: Record<string, string>;
}

interface JointBase {
  stiffness: number;
  dragForce: number;
  gravityPower: number;
}

interface Chain {
  name: string;
  joints: VRMSpringBoneJoint[];
}

interface ColliderRef {
  name: string;
  /** VRM collider (absent for generated body colliders). */
  collider?: VRMSpringBoneCollider;
  /** Generated from the body (cloth solver only). */
  body?: BodyCapsule;
}

const MODE_MUL: Record<PhysicsMode, { stiffness: number; looseness: number; gravity: number }> = {
  off: { stiffness: 1, looseness: 1, gravity: 1 },
  normal: { stiffness: 1, looseness: 1, gravity: 1 },
  // Stiff: twice the spring, 60% of the remaining velocity carry, half the gravity.
  stiff: { stiffness: 2, looseness: 0.6, gravity: 0.5 },
};

/** The parts of three-vrm's joint we reach into (verlet state is private there). */
interface JointInternals {
  _currentTail: Vector3;
  _prevTail: Vector3;
  _collision: (tail: Vector3) => void;
  center: Object3D | null;
}
const I = (j: VRMSpringBoneJoint) => j as unknown as JointInternals;

const _v = new Vector3();
const _m = new Matrix4();

export class StableSprings {
  readonly vrm: VRM;
  settings: PhysicsSettings;
  readonly chains: Chain[] = [];
  readonly colliders: ColliderRef[] = [];
  private overrides: PhysicsOverrides = { chains: {}, colliders: {}, groups: {}, assign: {} };
  /** The cloth solver rig (null if the model has no spring bones). */
  readonly rig: ClothRig | null = null;
  private base = new Map<VRMSpringBoneJoint, JointBase>();
  private groupColliders = new Map<VRMSpringBoneColliderGroup, VRMSpringBoneCollider[]>();
  private hits = new Set<VRMSpringBoneJoint>();
  private acc = 0;
  private anchor: Object3D | null;
  private prevAnchor = new Matrix4();
  private hasPrevAnchor = false;
  private disabled = new Set<VRMSpringBoneJoint>();
  private wasOff = false;
  /** Steps run during the last update() (debug readout). */
  lastSteps = 0;

  /**
   * @param springNames optional joint-bone -> spring (chain) name map, from the
   *   VRM file's spring definitions. Without it chains are grouped structurally.
   */
  constructor(vrm: VRM, settings: PhysicsSettings = DEFAULT_PHYSICS, springNames?: Map<Object3D, string>) {
    this.vrm = vrm;
    this.settings = { ...settings };
    this.anchor = vrm.humanoid?.getNormalizedBoneNode('hips') ?? vrm.scene;
    const mgr = vrm.springBoneManager;
    if (!mgr) return;

    const joints = Array.from(mgr.joints);
    for (const j of joints) {
      this.base.set(j, { stiffness: j.settings.stiffness, dragForce: j.settings.dragForce, gravityPower: j.settings.gravityPower });
      const ij = I(j);
      const orig = ij._collision.bind(j);
      const tmp = new Vector3();
      ij._collision = (tail: Vector3) => {
        tmp.copy(tail);
        orig(tail);
        if (tmp.distanceToSquared(tail) > 1e-14) this.hits.add(j);
      };
    }

    // Chains: named springs if known, otherwise each joint whose bone's parent
    // isn't itself a joint starts a chain.
    const jointBones = new Map<Object3D, VRMSpringBoneJoint>();
    for (const j of joints) jointBones.set(j.bone, j);
    const byName = new Map<string, VRMSpringBoneJoint[]>();
    if (springNames && springNames.size) {
      for (const j of joints) {
        const n = springNames.get(j.bone) ?? j.bone.name ?? 'spring';
        if (!byName.has(n)) byName.set(n, []);
        byName.get(n)!.push(j);
      }
    } else {
      const rootOf = (j: VRMSpringBoneJoint): VRMSpringBoneJoint => {
        let cur = j;
        while (cur.bone.parent && jointBones.has(cur.bone.parent)) cur = jointBones.get(cur.bone.parent)!;
        return cur;
      };
      for (const j of joints) {
        const r = rootOf(j);
        const n = r.bone.name || `chain_${byName.size}`;
        if (!byName.has(n)) byName.set(n, []);
        byName.get(n)!.push(j);
      }
    }
    for (const [name, js] of byName) this.chains.push({ name, joints: js });

    for (const g of mgr.colliderGroups) {
      this.groupColliders.set(g, [...g.colliders]);
    }
    const seen = new Set<VRMSpringBoneCollider>();
    for (const g of mgr.colliderGroups) {
      for (const c of g.colliders) {
        if (seen.has(c)) continue;
        seen.add(c);
        const host = c.parent?.name || 'collider';
        let name = host;
        let i = 2;
        while (this.colliders.some((x) => x.name === name)) name = `${host}#${i++}`;
        this.colliders.push({ name, collider: c });
      }
    }

    // Cloth solver: generated body colliders + the rig.
    const humanoid = new Map<Object3D, string>();
    for (const [name, b] of Object.entries(vrm.humanoid?.humanBones ?? {})) {
      const node = (b as { node?: Object3D } | undefined)?.node;
      if (node) humanoid.set(node, name);
    }
    let body: BodyCapsule[] = [];
    try {
      if (vrm.humanoid) body = fitBodyColliders(vrm, new Set(joints.map((j) => j.bone)));
    } catch (e) {
      console.warn('[physics] body collider fit failed', e);
    }
    for (const b of body) this.colliders.push({ name: b.name, body: b });
    const rigColliders: RigCollider[] = this.colliders.map((c) =>
      c.collider
        ? { name: c.name, source: 'vrm', vrm: c.collider, host: c.collider }
        : { name: c.name, source: 'body', body: c.body, host: c.body!.bone },
    );
    if (joints.length) {
      this.rig = new ClothRig(this.chains, rigColliders, humanoid);
      this.rig.groupOriginal = (g) => this.groupColliders.get(g as VRMSpringBoneColliderGroup) ?? g.colliders;
    }
    this.applyAll();
  }

  /**
   * Call once with the body in its idle pose: rest-shape overlaps with the
   * body in this pose are not treated as collisions (see ClothRig.addRestPose).
   */
  captureIdlePose(): void {
    if (!this.rig) return;
    this.vrm.scene.updateMatrixWorld(true);
    this.rig.addRestPose();
    this.applyAll();
  }

  /** Cloth groups detected (or assigned) for this model. */
  get groups(): ClothGroup[] {
    return this.rig?.groups ?? [];
  }

  groupOverride(name: string): GroupOverride {
    return { ...DEFAULT_GROUP, ...(this.overrides.groups?.[name] ?? {}) };
  }

  setGroup(name: string, o: Partial<GroupOverride>): void {
    this.overrides.groups = { ...(this.overrides.groups ?? {}), [name]: { ...this.groupOverride(name), ...o } };
    this.applyAll();
  }

  /** Chain grouping override: 'auto', 'none' or a group name. */
  chainAssign(name: string): string {
    return this.overrides.assign?.[name] ?? 'auto';
  }

  setChainAssign(name: string, group: string): void {
    const a = { ...(this.overrides.assign ?? {}) };
    if (group === 'auto') delete a[name];
    else a[name] = group;
    this.overrides.assign = a;
    this.applyAll();
  }

  get jointCount(): number {
    return this.base.size;
  }

  setSettings(s: Partial<PhysicsSettings>): void {
    const prev = this.settings;
    this.settings = { ...this.settings, ...s };
    if (s.mode && s.mode !== prev.mode) this.applyAll();
    if ((s.bodyColliders != null && s.bodyColliders !== prev.bodyColliders) || (s.solver && s.solver !== prev.solver)) this.applyAll();
    if (s.solver && s.solver !== prev.solver) this.reset();
  }

  getOverrides(): PhysicsOverrides {
    return JSON.parse(JSON.stringify(this.overrides));
  }

  setOverrides(o: PhysicsOverrides): void {
    this.overrides = {
      chains: { ...(o.chains ?? {}) },
      colliders: { ...(o.colliders ?? {}) },
      groups: { ...(o.groups ?? {}) },
      assign: { ...(o.assign ?? {}) },
    };
    this.applyAll();
  }

  chainOverride(name: string): ChainOverride {
    return { ...DEFAULT_CHAIN, ...(this.overrides.chains[name] ?? {}) };
  }

  setChain(name: string, o: Partial<ChainOverride>): void {
    this.overrides.chains[name] = { ...this.chainOverride(name), ...o };
    this.applyAll();
  }

  colliderEnabled(name: string): boolean {
    return this.overrides.colliders[name] ?? true;
  }

  setCollider(name: string, enabled: boolean): void {
    this.overrides.colliders[name] = enabled;
    this.applyAll();
  }

  /** Push base settings x mode x chain multipliers onto every joint, and collider toggles onto groups. */
  private applyAll(): void {
    const mgr = this.vrm.springBoneManager;
    if (!mgr) return;
    const mm = MODE_MUL[this.settings.mode];
    for (const ch of this.chains) {
      const o = this.chainOverride(ch.name);
      for (const j of ch.joints) {
        const b = this.base.get(j)!;
        j.settings.stiffness = b.stiffness * mm.stiffness * o.stiffness;
        const drag = Math.min(1, Math.max(0, b.dragForce * o.drag));
        j.settings.dragForce = 1 - (1 - drag) * mm.looseness;
        j.settings.gravityPower = b.gravityPower * mm.gravity * o.gravity;
        if (!o.enabled && !this.disabled.has(j)) {
          mgr.deleteJoint(j);
          j.reset();
          this.disabled.add(j);
        } else if (o.enabled && this.disabled.has(j)) {
          mgr.addJoint(j);
          j.reset();
          this.disabled.delete(j);
        }
      }
    }
    const off = new Set(this.colliders.filter((c) => !this.colliderEnabled(c.name)).map((c) => c.collider));
    for (const [g, orig] of this.groupColliders) g.colliders = orig.filter((c) => !off.has(c));
    this.rig?.configure({
      stiff: this.settings.mode === 'stiff',
      bodyColliders: this.settings.bodyColliders,
      chainEnabled: (n) => this.chainOverride(n).enabled,
      colliderEnabled: (n) => this.colliderEnabled(n),
      group: (n) => this.groupOverride(n),
      assign: this.overrides.assign ?? {},
    });
  }

  private get useCloth(): boolean {
    return this.settings.solver === 'cloth' && this.settings.stabilise && !!this.rig;
  }

  /** Snap every chain back to rest (e.g. after loading or teleporting). */
  reset(): void {
    this.vrm.springBoneManager?.reset();
    this.acc = 0;
    this.hasPrevAnchor = false;
    this.rig?.invalidate();
  }

  /** Advance physics by a frame delta (seconds). Call after the pose is applied. */
  update(frameDelta: number): void {
    const mgr = this.vrm.springBoneManager;
    this.lastSteps = 0;
    if (!mgr) return;
    if (this.settings.mode === 'off') {
      if (!this.wasOff) {
        mgr.reset();
        this.rig?.writeRest();
      }
      this.wasOff = true;
      return;
    }
    if (this.wasOff) {
      this.reset();
      this.wasOff = false;
    }
    if (!this.settings.stabilise) {
      mgr.update(frameDelta);
      this.lastSteps = 1;
      return;
    }
    if (this.useCloth) {
      this.updateCloth(frameDelta);
      return;
    }
    const h = 1 / (this.settings.rate * this.settings.substeps);
    this.acc += Math.min(Math.max(frameDelta, 0), this.settings.maxFrameDelta);
    const maxSteps = Math.ceil(this.settings.maxFrameDelta / h) + 1;
    let steps = 0;
    while (this.acc >= h && steps < maxSteps) {
      this.step(h, steps === 0);
      this.acc -= h;
      steps++;
    }
    if (steps >= maxSteps) this.acc = 0;
    this.lastSteps = steps;
  }

  /** Cloth solver frame: fixed steps between the last stepped pose and this frame's. */
  private updateCloth(frameDelta: number): void {
    const rig = this.rig!;
    const t0 = performance.now();
    const h = 1 / (this.settings.rate * this.settings.substeps);
    this.acc += Math.min(Math.max(frameDelta, 0), this.settings.maxFrameDelta);
    const maxSteps = Math.ceil(this.settings.maxFrameDelta / h) + 1;
    let steps = Math.floor(this.acc / h + 1e-9);
    if (steps > maxSteps) {
      steps = maxSteps;
      this.acc = 0;
    } else this.acc -= steps * h;
    this.lastSteps = steps;
    if (steps === 0) return;

    rig.syncParams();
    rig.solver.opts.maxSpeed = this.settings.maxSpeed;
    rig.solver.opts.collisionDamping = this.settings.collisionDamping;
    rig.capture();
    // Inertia: carry the cloth with part of the body's own motion since the last step.
    if (this.anchor && this.settings.inertia < 1) {
      this.anchor.updateWorldMatrix(true, false);
      const now = this.anchor.matrixWorld;
      if (this.hasPrevAnchor) {
        _m.copy(this.prevAnchor).invert().premultiply(now);
        rig.carry(_m, 1 - this.settings.inertia);
      }
      this.prevAnchor.copy(now);
      this.hasPrevAnchor = true;
    }
    rig.run(steps, h);
    rig.writeBack();
    this.lastMs = performance.now() - t0;
  }

  /** CPU time of the last cloth update, ms (debug readout). */
  lastMs = 0;

  private step(h: number, firstOfFrame: boolean): void {
    const mgr = this.vrm.springBoneManager!;
    const joints = Array.from(mgr.joints, I);
    const raw = Array.from(mgr.joints);

    // Inertia: carry the tails along with (1 - inertia) of the body's motion
    // since the last step. Only for world-space joints (no VRM `center`).
    if (firstOfFrame && this.anchor && this.settings.inertia < 1) {
      this.anchor.updateWorldMatrix(true, false);
      const now = this.anchor.matrixWorld;
      if (this.hasPrevAnchor) {
        // delta = now * prev^-1, applied partially to every tail.
        _m.copy(this.prevAnchor).invert().premultiply(now);
        const k = 1 - this.settings.inertia;
        for (const j of joints) {
          if (j.center) continue;
          _v.copy(j._currentTail).applyMatrix4(_m);
          j._currentTail.lerp(_v, k);
          _v.copy(j._prevTail).applyMatrix4(_m);
          j._prevTail.lerp(_v, k);
        }
      }
      this.prevAnchor.copy(now);
      this.hasPrevAnchor = true;
    }

    this.hits.clear();
    mgr.update(h);

    const maxStep = this.settings.maxSpeed * h;
    const damp = this.settings.collisionDamping;
    for (let i = 0; i < joints.length; i++) {
      const j = joints[i];
      _v.subVectors(j._currentTail, j._prevTail);
      const len = _v.length();
      if (len > maxStep) {
        j._prevTail.copy(j._currentTail).addScaledVector(_v, -maxStep / len);
      }
      if (damp > 0 && this.hits.has(raw[i])) j._prevTail.lerp(j._currentTail, damp);
    }
  }
}

/**
 * Map each spring joint's bone to its spring (chain) name using the file's
 * VRMC_springBone (VRM 1.0) or secondaryAnimation (VRM 0.x) definitions.
 */
export async function springNamesFromGltf(gltf: {
  parser: { json: any; getDependency: (type: string, i: number) => Promise<any> };
}): Promise<Map<Object3D, string>> {
  const map = new Map<Object3D, string>();
  const json = gltf.parser.json;
  const ext1 = json.extensions?.VRMC_springBone;
  if (ext1?.springs) {
    for (let i = 0; i < ext1.springs.length; i++) {
      const s = ext1.springs[i];
      const name = s.name || `spring_${i}`;
      for (const j of s.joints ?? []) {
        const node = await gltf.parser.getDependency('node', j.node);
        if (node) map.set(node, name);
      }
    }
    return map;
  }
  const groups = json.extensions?.VRM?.secondaryAnimation?.boneGroups;
  if (groups) {
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const name = g.comment || `group_${i}`;
      for (const b of g.bones ?? []) {
        const root = await gltf.parser.getDependency('node', b);
        root?.traverse((o: Object3D) => {
          if (!map.has(o)) map.set(o, name);
        });
      }
    }
  }
  return map;
}
