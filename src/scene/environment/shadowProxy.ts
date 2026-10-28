/**
 * A cheap stand-in that casts the avatar's ground shadow: capsules between
 * the humanoid bones, invisible in the colour pass.
 *
 * Why: rendering the real avatar into a shadow map re-skins every vertex
 * (300k triangles on a typical detailed VRM). Measured on an M3 Pro, that cost
 * MediaPipe about 30% of its face+body throughput even at half rate. A dozen
 * capsules cost nothing, and a soft ground shadow does not need hair strands.
 */
import { CapsuleGeometry, Group, Mesh, MeshBasicMaterial, Quaternion, SphereGeometry, Vector3, type Object3D } from 'three';
import type { Avatar } from '../avatar';

/** [from bone, to bone, radius as a fraction of the avatar's height]. */
const SEGMENTS: Array<[string, string, number]> = [
  ['hips', 'chest', 0.085],
  ['chest', 'neck', 0.09],
  ['leftUpperArm', 'leftLowerArm', 0.03],
  ['leftLowerArm', 'leftHand', 0.025],
  ['rightUpperArm', 'rightLowerArm', 0.03],
  ['rightLowerArm', 'rightHand', 0.025],
  ['leftUpperLeg', 'leftLowerLeg', 0.045],
  ['leftLowerLeg', 'leftFoot', 0.035],
  ['rightUpperLeg', 'rightLowerLeg', 0.045],
  ['rightLowerLeg', 'rightFoot', 0.035],
];
/** [bone, radius fraction] spheres. */
const BLOBS: Array<[string, number]> = [
  ['head', 0.07],
  ['leftHand', 0.03],
  ['rightHand', 0.03],
];

const UP = new Vector3(0, 1, 0);

export class ShadowProxy {
  readonly group = new Group();
  private parts: Array<{ mesh: Mesh; a: Object3D; b: Object3D | null }> = [];
  private readonly va = new Vector3();
  private readonly vb = new Vector3();
  private readonly q = new Quaternion();

  constructor() {
    this.group.name = 'env-shadow-proxy';
  }

  /** Rebuild for a (new) avatar; null clears. */
  setAvatar(avatar: Avatar | null): void {
    for (const p of this.parts) {
      p.mesh.geometry.dispose();
      (p.mesh.material as MeshBasicMaterial).dispose();
    }
    this.group.clear();
    this.parts = [];
    if (!avatar) return;
    const height = Math.max(0.5, avatar.headPosition().y + 0.12);
    const mat = () => new MeshBasicMaterial({ colorWrite: false, depthWrite: false });
    for (const [from, to, r] of SEGMENTS) {
      const a = avatar.bone(from);
      const b = avatar.bone(to);
      if (!a || !b) continue;
      const mesh = new Mesh(new CapsuleGeometry(r * height, 1, 3, 8), mat());
      this.add(mesh, a, b);
    }
    for (const [bone, r] of BLOBS) {
      const a = avatar.bone(bone);
      if (!a) continue;
      this.add(new Mesh(new SphereGeometry(r * height, 10, 8), mat()), a, null);
    }
  }

  private add(mesh: Mesh, a: Object3D, b: Object3D | null): void {
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = -100;
    this.group.add(mesh);
    this.parts.push({ mesh, a, b });
  }

  /** Follow the bones (call once per frame, before rendering). */
  update(): void {
    for (const { mesh, a, b } of this.parts) {
      a.getWorldPosition(this.va);
      if (!b) {
        mesh.position.copy(this.va);
        continue;
      }
      b.getWorldPosition(this.vb);
      const len = this.va.distanceTo(this.vb);
      mesh.position.copy(this.va).add(this.vb).multiplyScalar(0.5);
      // CapsuleGeometry's straight part is 1 m long along Y: stretch it to the bone, keep the caps round.
      mesh.scale.set(1, Math.max(0.01, len), 1);
      this.q.setFromUnitVectors(UP, this.vb.sub(this.va).normalize());
      mesh.quaternion.copy(this.q);
    }
  }
}
