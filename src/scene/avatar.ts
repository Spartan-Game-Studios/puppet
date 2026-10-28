/**
 * Avatar: a loaded VRM plus everything that drives it — expressions (perfect
 * sync or presets), head/gaze, upper body and hands, and stabilised physics.
 */
import { Box3, BufferAttribute, Mesh, Object3D, Quaternion, SkinnedMesh, Uint16BufferAttribute, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, type VRM, type VRMHumanBoneName } from '@pixiv/three-vrm';
import {
  buildPerfectSyncMap,
  derivePresets,
  isPerfectSync,
  VRM_PRESETS,
  type ArkitName,
  type PresetOptions,
} from '../core/blendshapes';
import {
  BodySolver,
  idleArm,
  idleFingers,
  REST_CHILD,
  qpow,
  type BodyInput,
  type BodySolution,
  type RestDirs,
} from '../core/bodySolver';
import { probeRig, type RigProbe } from '../core/rigProbe';
import { StableSprings, springNamesFromGltf, type PhysicsSettings } from '../physics/stableSprings';
import { gatherModelFacts, type GatheredFacts } from './modelFacts';
import { applyLookAtFallback } from './lookAtFallback';
import type { FaceState } from '../tracking/faceProcessor';
import type { BodyMode } from '../tracking/protocol';

export interface DriveOptions {
  mode: BodyMode;
  mirror: boolean;
  gazeGain: number;
  presetOptions: PresetOptions;
  /** Bone follow rate, 1/s (higher = snappier). */
  followRate: number;
  /**
   * Follow rate for the arms, hands and fingers, 1/s. Faster than the torso:
   * the one-euro filters before it already smooth them, and every 1/rate
   * here is added lag.
   */
  limbFollowRate: number;
  /** Max torso/hips angular speed, rad/s (keeps tracking jumps out of physics). */
  maxTorsoSpeed: number;
  /** Body/finger smoothing, 0..1 (the app's smoothing setting). */
  smoothing: number;
}

export const DEFAULT_DRIVE: DriveOptions = {
  mode: 'upper',
  mirror: true,
  gazeGain: 1,
  presetOptions: { emotions: true, emotionDeadzone: 0.25 },
  followRate: 16,
  limbFollowRate: 28,
  maxTorsoSpeed: 4,
  smoothing: 0.5,
};

const TORSO = new Set(['hips', 'spine', 'chest', 'upperChest']);

/**
 * Something blended over the tracked pose each frame (src/anim: idle and
 * emote clips, hotkey expressions, mic lip sync). Called from update().
 */
export interface AvatarLayer {
  /** After the tracked bones have moved toward their targets (head and neck not yet set). */
  body(avatar: Avatar, dt: number): void;
  /** After head and neck have been set from the face. */
  head(avatar: Avatar, dt: number): void;
  /** Adjust this frame's expression values (model expression name -> weight). */
  expressions(values: Map<string, number>, avatar: Avatar, dt: number): void;
}

export interface LoadedAvatar {
  avatar: Avatar;
  hash: string;
  /** Rest-pose checks (src/scene/modelChecks.ts): authoring problems to show in MODEL INFO. */
  facts: GatheredFacts;
}

export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Store skin indices as 16-bit before VRMUtils.combineSkeletons. It remaps
 * each mesh's joint indices into one combined skeleton but keeps the
 * attribute's array type, so with 8-bit JOINTS_0 (common) and more than 256
 * combined bones the indices wrap around and vertices end up skinned to
 * unrelated bones (on a 427-bone Daz avatar, a third of the gown followed the
 * hair spring bones: the skirt "exploded" whenever the hair moved).
 */
export function widenSkinIndices(root: Object3D): void {
  root.traverse((o) => {
    const m = o as SkinnedMesh;
    if (!m.isSkinnedMesh) return;
    const a = m.geometry.getAttribute('skinIndex') as BufferAttribute | undefined;
    if (!a || !(a.array instanceof Uint8Array || a.array instanceof Int8Array)) return;
    m.geometry.setAttribute('skinIndex', new Uint16BufferAttribute(Uint16Array.from(a.array), a.itemSize, a.normalized));
  });
}

export async function loadAvatar(
  buf: ArrayBuffer,
  physics: PhysicsSettings,
  /** Test hook: `widenSkin: false` reproduces the old loader (8-bit skin index overflow). */
  opts: { widenSkin?: boolean } = {},
): Promise<LoadedAvatar> {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const [gltf, hash] = await Promise.all([loader.parseAsync(buf, ''), sha256Hex(buf)]);
  const vrm = gltf.userData.vrm as VRM | undefined;
  if (!vrm) throw new Error('Not a VRM file (no VRM extension found).');
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  if (opts.widenSkin !== false) widenSkinIndices(gltf.scene);
  VRMUtils.combineSkeletons(gltf.scene);
  VRMUtils.rotateVRM0(vrm);
  vrm.scene.traverse((o) => (o.frustumCulled = false));
  applyLookAtFallback(vrm);
  const facts = gatherModelFacts(vrm);
  const springNames = await springNamesFromGltf(gltf as any);
  const avatar = new Avatar(vrm, physics, springNames);
  return { avatar, hash, facts };
}

/** Rest directions (solver space) of the solved bones, measured from the model's normalized rig. */
export function measureRestDirs(vrm: VRM): RestDirs {
  const rest: RestDirs = {};
  const h = vrm.humanoid;
  const vrm0 = vrm.meta?.metaVersion === '0';
  vrm.scene.updateMatrixWorld(true);
  const rootInv = vrm.scene.matrixWorld.clone().invert();
  const pos = (n: Object3D) => n.getWorldPosition(new Vector3()).applyMatrix4(rootInv);
  for (const [bone, child] of Object.entries(REST_CHILD)) {
    const a = h.getNormalizedBoneNode(bone as VRMHumanBoneName);
    const b = h.getNormalizedBoneNode(child as VRMHumanBoneName);
    if (a && b) {
      const d = pos(b).sub(pos(a));
      if (d.lengthSq() > 1e-10) {
        d.normalize();
        // VRM 0.x normalized bones face -Z: turn into the solver's +Z-facing space.
        rest[bone] = vrm0 ? d.set(-d.x, d.y, -d.z) : d;
      }
    }
  }
  // Finger tips have no child bone: reuse the previous segment's direction.
  for (const side of ['left', 'right']) {
    for (const f of ['Thumb', 'Index', 'Middle', 'Ring', 'Little']) {
      const prev = f === 'Thumb' ? `${side}ThumbProximal` : `${side}${f}Intermediate`;
      const tip = `${side}${f}Distal`;
      if (!rest[tip] && rest[prev]) rest[tip] = rest[prev]!.clone();
    }
  }
  return rest;
}

/** A normalized bone's world rotation relative to the VRM root, in solver (+Z-facing) space. */
export function solverWorldRotation(vrm: VRM, node: Object3D): Quaternion {
  const root = vrm.scene.getWorldQuaternion(new Quaternion()).invert();
  const q = root.multiply(node.getWorldQuaternion(new Quaternion()));
  return vrm.meta?.metaVersion === '0' ? q.set(-q.x, q.y, -q.z, q.w) : q;
}

export class Avatar {
  readonly vrm: VRM;
  readonly physics: StableSprings;
  readonly expressionNames: string[];
  readonly perfectSync: Map<ArkitName, string>;
  readonly usePerfectSync: boolean;
  readonly presets: Set<string>;
  readonly rest: RestDirs = {};
  readonly chestChain: Array<[string, number]>;
  readonly solver: BodySolver;
  drive: DriveOptions = { ...DEFAULT_DRIVE };
  /** Optional layer over tracking (see AvatarLayer). */
  layer: AvatarLayer | null = null;
  /** Rest-pose bounds of the skinned meshes in the avatar's space (for camera framing). */
  readonly bounds = new Box3();

  /** Latest values sent to the model (for VMC output and the readout). */
  readonly expressionValues = new Map<string, number>();
  private targets = new Map<string, Quaternion>();
  private face: FaceState | null = null;
  private faceSeenAt = -1;
  private bodySeenAt = -1;
  private time = 0;
  private bones = new Map<string, Object3D>();

  constructor(vrm: VRM, physicsSettings: PhysicsSettings, springNames?: Map<Object3D, string>) {
    this.vrm = vrm;
    const em = vrm.expressionManager;
    this.expressionNames = em ? em.expressions.map((e) => e.expressionName) : [];
    this.perfectSync = buildPerfectSyncMap(this.expressionNames);
    this.usePerfectSync = isPerfectSync(this.perfectSync);
    this.presets = new Set(VRM_PRESETS.filter((p) => this.expressionNames.includes(p)));

    const h = vrm.humanoid;
    h.resetNormalizedPose();
    vrm.scene.updateMatrixWorld(true);
    for (const name of Object.keys(h.humanBones) as VRMHumanBoneName[]) {
      const n = h.getNormalizedBoneNode(name);
      if (n) this.bones.set(name, n);
    }
    Object.assign(this.rest, measureRestDirs(vrm));

    const chain = ['spine', 'chest', 'upperChest'].filter((b) => this.bones.has(b));
    const shares = chain.length === 3 ? [0.4, 0.35, 0.25] : chain.length === 2 ? [0.55, 0.45] : [1];
    this.chestChain = chain.map((b, i) => [b, shares[i]] as [string, number]);
    this.solver = new BodySolver(this.rest);
    this.solver.available = new Set(this.bones.keys());

    this.physics = new StableSprings(vrm, physicsSettings, springNames);
    this.setIdle();
    this.applyBonesInstant();
    vrm.humanoid.update();
    this.physics.captureIdlePose();
    vrm.update(0);
    this.physics.reset();
    this.measureBounds();
  }

  get name(): string {
    const meta = this.vrm.meta as { name?: string; title?: string };
    // Some exporters write the literal string "undefined" for an empty name.
    const ok = (v?: string) => (v && v.trim() && v !== 'undefined' ? v : undefined);
    return ok(meta.name) ?? ok(meta.title) ?? 'VRM';
  }

  /** Sampled, skinning-aware bounds: a box per mesh from every few vertices. */
  private measureBounds(): void {
    const v = new Vector3();
    this.vrm.scene.updateMatrixWorld(true);
    this.vrm.scene.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh || !m.visible) return;
      const pos = m.geometry.attributes.position;
      const step = Math.max(1, Math.floor(pos.count / 4000));
      for (let i = 0; i < pos.count; i += step) {
        m.getVertexPosition(i, v);
        if ((m as SkinnedMesh).isSkinnedMesh) (m as SkinnedMesh).applyBoneTransform(i, v);
        this.bounds.expandByPoint(v.applyMatrix4(m.matrixWorld));
      }
    });
    if (this.bounds.isEmpty()) this.bounds.set(new Vector3(-0.3, 0, -0.2), new Vector3(0.3, 1.7, 0.2));
  }

  get isVrm0(): boolean {
    return this.vrm.meta?.metaVersion === '0';
  }

  /**
   * The solver works in a space where the avatar faces +Z (VRM 1.0). A VRM 0.x
   * model's normalized bones still face -Z (rotateVRM0 only turns the scene),
   * so its rotations and directions are the solver's turned 180 degrees about
   * Y: negate x and z. Self-inverse, so it converts both ways.
   */
  private toBone(q: Quaternion): Quaternion {
    return this.isVrm0 ? new Quaternion(-q.x, q.y, -q.z, q.w) : q;
  }

  /** A normalized bone's local position and rotation in the +Z-facing space (for VMC). */
  localPose(name: string): { position: Vector3; quaternion: Quaternion } | null {
    const n = this.bones.get(name);
    if (!n) return null;
    return { position: this.toSolverDir(n.position.clone()), quaternion: this.toBone(n.quaternion.clone()) };
  }

  private toSolverDir(v: Vector3): Vector3 {
    return this.isVrm0 ? v.set(-v.x, v.y, -v.z) : v;
  }

  /** World rotation of a bone in solver space (for the test probes). */
  worldRotation(name: string): Quaternion | null {
    const n = this.bones.get(name);
    if (!n) return null;
    this.vrm.scene.updateMatrixWorld(true);
    return solverWorldRotation(this.vrm, n);
  }

  /** Arm directions and finger joint angles as currently shown (test harness). */
  probe(): RigProbe {
    this.vrm.scene.updateMatrixWorld(true);
    return probeRig((b) => {
      const n = this.bones.get(b);
      return n ? solverWorldRotation(this.vrm, n) : null;
    }, this.rest);
  }

  get humanBoneNames(): string[] {
    return [...this.bones.keys()];
  }

  bone(name: string): Object3D | undefined {
    return this.bones.get(name);
  }

  /** World position of the head (for framing the camera). */
  headPosition(): Vector3 {
    this.vrm.scene.updateMatrixWorld(true);
    const head = this.vrm.humanoid.getRawBoneNode('head') ?? this.vrm.scene;
    return head.getWorldPosition(new Vector3());
  }

  private setIdle(): void {
    for (const side of ['left', 'right'] as const) {
      const m = new Map<string, Quaternion>();
      idleArm(side, this.rest, m);
      idleFingers(side, m);
      for (const [k, v] of m) this.targets.set(k, v);
    }
    for (const b of this.bones.keys()) if (!this.targets.has(b)) this.targets.set(b, new Quaternion());
  }

  private applyBonesInstant(): void {
    for (const [b, q] of this.targets) this.bones.get(b)?.quaternion.copy(this.toBone(q));
  }

  /** Face tracking is live (a face seen in the last 0.5 s). */
  get faceTracked(): boolean {
    return this.time - this.faceSeenAt <= 0.5;
  }

  /** Body tracking is live (upper/hands mode and a pose seen in the last 0.5 s). */
  get bodyTracked(): boolean {
    return this.drive.mode !== 'face' && this.time - this.bodySeenAt <= 0.5;
  }

  /** Feed a processed face frame. */
  setFace(face: FaceState): void {
    this.face = face;
    this.faceSeenAt = this.time;
  }

  /** Feed pose/hand landmarks (call only in upper/hands mode). */
  setBody(input: BodyInput): BodySolution {
    this.solver.opts.mirror = this.drive.mirror;
    this.solver.opts.hands = this.drive.mode === 'hands';
    this.solver.opts.smoothing = this.drive.smoothing;
    const sol = this.solver.solve({ ...input, t: input.t ?? this.time }, this.chestChain);
    this.bodySeenAt = this.time;
    const idle = new Map<string, Quaternion>();
    for (const side of ['left', 'right'] as const) {
      idleArm(side, this.rest, idle);
      idleFingers(side, idle);
    }
    for (const [b, q] of sol.bones) if (this.bones.has(b) && !idle.has(b)) this.targets.set(b, q);
    // Arms and hands: blend solved over idle by their weights, so a limb that
    // leaves the frame (or is only just found) eases in and out.
    const isFinger = (b: string) => /Thumb|Index|Middle|Ring|Little/.test(b);
    for (const [b, q] of idle) {
      if (!this.bones.has(b)) continue;
      const side = b.startsWith('left') ? 'left' : 'right';
      const w = isFinger(b) ? (this.drive.mode === 'hands' ? sol.handWeight[side] : 0) : sol.armWeight[side];
      const solved = sol.bones.get(b);
      this.targets.set(b, solved && w > 0 ? q.clone().slerp(solved, w) : q);
    }
    this.lastSolution = sol;
    return sol;
  }

  /** The last body solution (readout, tests). */
  lastSolution: BodySolution | null = null;

  /** Per-frame update: move bones toward targets, apply face, run physics. */
  update(dt: number): void {
    this.time += dt;
    const d = this.drive;
    // Tracking lost for a while: settle to neutral / idle.
    const faceStale = !this.faceTracked;
    const bodyStale = !this.bodyTracked;
    if (bodyStale) {
      const idle = new Map<string, Quaternion>();
      for (const side of ['left', 'right'] as const) {
        idleArm(side, this.rest, idle);
        idleFingers(side, idle);
      }
      for (const [b, q] of idle) this.targets.set(b, q);
      for (const [b] of this.chestChain) this.targets.set(b, new Quaternion());
    }

    // Head, neck and (in face mode) a little torso follow from the face.
    const face = faceStale ? null : this.face;
    const headWorld = face ? face.head.clone() : new Quaternion();
    const ang = 2 * Math.acos(Math.min(1, Math.abs(headWorld.w)));
    if (ang > 1.2) qpow(headWorld, 1.2 / ang, headWorld);
    if (bodyStale && face) {
      // Face-only: the torso follows the head a little and leans with head offset.
      const lean = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.max(-0.25, Math.min(0.25, -face.headPos.x * 1.5)));
      const follow = qpow(headWorld, 0.12).multiply(lean);
      let acc = new Quaternion();
      for (const [b, share] of this.chestChain) {
        const q = qpow(follow, share);
        this.targets.set(b, q);
        acc = acc.multiply(q);
      }
    }

    // Move bones toward targets; torso bones are also speed-limited so a
    // tracking jump becomes a bounded motion before physics sees it.
    const k = 1 - Math.exp(-d.followRate * dt);
    const kLimb = 1 - Math.exp(-d.limbFollowRate * dt);
    for (const [b, target] of this.targets) {
      if (b === 'neck' || b === 'head') continue;
      const node = this.bones.get(b);
      if (!node) continue;
      const t = this.toBone(target);
      if (TORSO.has(b)) {
        const q = node.quaternion.clone().slerp(t, k);
        node.quaternion.rotateTowards(q, d.maxTorsoSpeed * dt);
      } else {
        node.quaternion.slerp(t, kLimb);
      }
    }

    this.layer?.body(this, dt);

    // Head relative to the (now updated) chest.
    // From the hips: tracking leaves them at rest, but an animation clip may bend them.
    const hipsNode = this.bones.get('hips');
    let parentWorld = hipsNode ? this.toBone(hipsNode.quaternion.clone()) : new Quaternion();
    for (const [b] of this.chestChain) parentWorld.multiply(this.toBone(this.bones.get(b)!.quaternion));
    const headLocal = this.toBone(parentWorld.invert().multiply(headWorld));
    const neck = this.bones.get('neck');
    const head = this.bones.get('head');
    const kh = 1 - Math.exp(-d.followRate * 1.5 * dt);
    if (neck && head) {
      neck.quaternion.slerp(qpow(headLocal, 0.4), kh);
      head.quaternion.slerp(qpow(headLocal, 0.6), kh);
    } else if (head) {
      head.quaternion.slerp(headLocal, kh);
    }

    this.layer?.head(this, dt);

    this.applyExpressions(face, dt);

    // Same order as VRM.update(), with physics swapped for the stabilised step.
    const vrm = this.vrm;
    vrm.humanoid.update();
    vrm.lookAt?.update(dt);
    vrm.expressionManager?.update();
    vrm.nodeConstraintManager?.update();
    this.physics.update(dt);
    for (const m of vrm.materials ?? []) (m as { update?: (d: number) => void }).update?.(dt);
  }

  private applyExpressions(face: FaceState | null, dt: number): void {
    const em = this.vrm.expressionManager;
    if (!em) return;
    const out = new Map<string, number>();
    const set = (name: string, v: number) => out.set(name, v);
    if (!face) {
      // Relax toward neutral.
      const k = Math.exp(-6 * dt);
      for (const [n, v] of this.expressionValues) set(n, v * k);
      if (this.vrm.lookAt) {
        this.vrm.lookAt.yaw *= k;
        this.vrm.lookAt.pitch *= k;
      }
    } else {
      if (this.usePerfectSync) {
        for (const [arkit, expr] of this.perfectSync) set(expr, face.values[arkit] ?? 0);
      } else {
        const p = derivePresets(face.values, this.drive.presetOptions);
        for (const name of this.presets) set(name, p[name as keyof typeof p] ?? 0);
      }
      const la = this.vrm.lookAt;
      if (la) {
        // three-vrm: +yaw looks to the avatar's left, +pitch looks down.
        la.yaw = face.gaze.yaw * this.drive.gazeGain;
        la.pitch = -face.gaze.pitch * this.drive.gazeGain;
      }
    }
    this.layer?.expressions(out, this, dt);
    for (const [n, v] of out) {
      em.setValue(n, v);
      this.expressionValues.set(n, v);
    }
  }
}
