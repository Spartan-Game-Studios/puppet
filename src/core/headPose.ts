/**
 * Head pose from MediaPipe's facial transformation matrix.
 *
 * The matrix maps MediaPipe's canonical face model into camera space: x to the
 * image right, y up, z toward the camera, translation in centimetres. A face
 * looking straight into the camera gives (near) identity rotation. Our avatar
 * faces +Z in the same orientation, so the rotation applies directly; mirroring
 * reflects it across the YZ plane.
 */
import { Matrix4, Quaternion, Vector3 } from 'three';

const _m = new Matrix4();
const _s = new Vector3();

export interface HeadPose {
  rotation: Quaternion;
  /** Head position relative to the camera, metres. */
  position: Vector3;
}

export function headPoseFromMatrix(data: ArrayLike<number>, mirror: boolean): HeadPose {
  _m.fromArray(data as number[]);
  const position = new Vector3();
  const rotation = new Quaternion();
  _m.decompose(position, rotation, _s);
  position.multiplyScalar(0.01);
  if (mirror) {
    mirrorQuat(rotation);
    position.x = -position.x;
  }
  return { rotation, position };
}

/** Reflect a rotation across the YZ plane (x -> -x). */
export function mirrorQuat(q: Quaternion): Quaternion {
  return q.set(q.x, -q.y, -q.z, q.w);
}

/** Keep q in the same hemisphere as ref (so component-wise filtering is continuous). */
export function alignHemisphere(q: Quaternion, ref: Quaternion): Quaternion {
  if (q.dot(ref) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
  return q;
}
