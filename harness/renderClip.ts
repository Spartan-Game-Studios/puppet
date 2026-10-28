/**
 * Renders test footage from a VRM: a scripted performance (expressions, head
 * turns, arm raises) shot by a webcam-like camera, with the ground truth kept
 * alongside. Used to test tracking without a real camera. The output is
 * derived from whatever model you feed it; keep it out of the repo if the
 * model is not redistributable.
 *
 * Driven by scripts/render-clip.mjs: it calls window.__clip.frame(i), which
 * returns a PNG data URL, for each frame.
 */
import {
  AmbientLight,
  Object3D,
  Color,
  DirectionalLight,
  Euler,
  PerspectiveCamera,
  Quaternion,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, type VRM, type VRMHumanBoneName } from '@pixiv/three-vrm';
import { basisRotation, twistAbout, qpow, type RestDirs } from '../src/core/bodySolver';
import { probeRig, type RigProbe } from '../src/core/rigProbe';
import { measureRestDirs, solverWorldRotation, widenSkinIndices } from '../src/scene/avatar';
import { BODY_END, BODY_START, bodyAt, type BodyKey, type HandKey, type V3 } from './bodyScript';

export const FPS = 30;
export const DURATION = BODY_END;

/** Smooth bump: 0 outside [a, b], 1 in the middle. */
function bump(t: number, a: number, b: number, ramp = 0.25): number {
  if (t <= a || t >= b) return 0;
  const up = Math.min(1, (t - a) / ramp);
  const down = Math.min(1, (b - t) / ramp);
  const x = Math.min(up, down);
  return x * x * (3 - 2 * x);
}

export interface Truth {
  t: number;
  expr: Record<string, number>;
  /** Degrees: yaw + = turn to her own left, pitch + = look up, roll + = tilt to her left. */
  head: { yaw: number; pitch: number; roll: number };
  /** 0 = arm down, 1 = raised to horizontal-ish forward/side. */
  arms: { left: number; right: number };
  /** Which part of the clip this is ('face', 'gestures', 'curls', 'cross', 'nearFace', 'lean', 'outOfFrame', 'rest'). */
  segment: string;
  /** Body section only: scripted torso angles and held gestures. */
  torso?: BodyKey['torso'];
  gesture?: BodyKey['gesture'];
  /** Measured from the posed model (filled in by frame()). */
  rig?: RigProbe;
  /** Whether each hand (wrist and fingertips) is inside the camera image. */
  handInFrame?: { left: boolean; right: boolean };
}

/** The scripted performance. */
export function truthAt(t: number): Truth {
  const expr: Record<string, number> = {};
  const add = (k: string, v: number) => (expr[k] = Math.max(expr[k] ?? 0, v));
  // 1.0-2.6 s: jaw open (talking "aa").
  add('jawOpen', bump(t, 1.0, 2.6, 0.35));
  // 3.0-3.4, 3.7-4.1: two blinks.
  const blink = Math.max(bump(t, 3.0, 3.4, 0.12), bump(t, 3.7, 4.1, 0.12));
  add('eyeBlinkLeft', blink);
  add('eyeBlinkRight', blink);
  // 4.5-5.3: wink with HER LEFT eye only.
  add('eyeBlinkLeft', bump(t, 4.5, 5.3, 0.15));
  // 5.6-7.0: smile.
  add('mouthSmileLeft', bump(t, 5.6, 7.0, 0.3));
  add('mouthSmileRight', bump(t, 5.6, 7.0, 0.3));
  // 7.3-8.3: pucker ("ou").
  add('mouthPucker', bump(t, 7.3, 8.3, 0.25));
  // 8.5-9.3: brows up + wide eyes (surprise).
  add('browInnerUp', bump(t, 8.5, 9.3, 0.2));
  add('browOuterUpLeft', bump(t, 8.5, 9.3, 0.2));
  add('browOuterUpRight', bump(t, 8.5, 9.3, 0.2));
  add('eyeWideLeft', bump(t, 8.5, 9.3, 0.2));
  add('eyeWideRight', bump(t, 8.5, 9.3, 0.2));
  // Head: 9.5-10.7 turn to her left, 10.7-11.9 to her right, 12.0-12.8 look up.
  const yaw = 25 * bump(t, 9.5, 10.7, 0.4) - 25 * bump(t, 10.7, 11.9, 0.4);
  const pitch = 15 * bump(t, 12.0, 12.8, 0.3);
  // Arms: 10.0-13.6 raise her left arm, 11.0-13.6 her right.
  const truth: Truth = {
    t,
    expr,
    head: { yaw, pitch, roll: 0 },
    arms: { left: bump(t, 10.0, 13.6, 0.6), right: bump(t, 11.0, 13.6, 0.6) },
    segment: 'face',
  };
  if (t >= BODY_START) {
    const b = bodyAt(t);
    truth.segment = b.segment;
    truth.torso = b.torso;
    truth.gesture = b.gesture;
  }
  return truth;
}

const FWD = new Vector3(0, 0, 1);
const PALM = new Vector3(0, -1, 0);
const FINGERS = ['Index', 'Middle', 'Ring', 'Little'] as const;

/**
 * Poses the body section on a VRM's normalized rig: torso, two-bone IK arms,
 * hand orientation, finger curls and a CCD thumb (fold / pinch). Works in the
 * solver's +Z-facing space and converts for VRM 0.x.
 */
class BodyPoser {
  private rest: RestDirs;
  private restPos = new Map<string, Vector3>();
  private vrm0: boolean;
  constructor(private vrm: VRM) {
    this.vrm0 = vrm.meta?.metaVersion === '0';
    vrm.humanoid.resetNormalizedPose();
    vrm.scene.updateMatrixWorld(true);
    this.rest = measureRestDirs(vrm);
    const rootInv = vrm.scene.matrixWorld.clone().invert();
    for (const name of Object.keys(vrm.humanoid.humanBones)) {
      const n = this.node(name);
      if (n) this.restPos.set(name, this.toSolver(n.getWorldPosition(new Vector3()).applyMatrix4(rootInv)));
    }
  }
  node(name: string) {
    return this.vrm.humanoid.getNormalizedBoneNode(name as VRMHumanBoneName);
  }
  private toSolver(v: Vector3): Vector3 {
    return this.vrm0 ? v.set(-v.x, v.y, -v.z) : v;
  }
  private set(name: string, q: Quaternion): void {
    const n = this.node(name);
    if (!n) return;
    n.quaternion.copy(this.vrm0 ? new Quaternion(-q.x, q.y, -q.z, q.w) : q);
  }
  get restDirs(): RestDirs {
    return this.rest;
  }
  probe(): RigProbe {
    this.vrm.scene.updateMatrixWorld(true);
    return probeRig((b) => {
      const n = this.node(b);
      return n ? solverWorldRotation(this.vrm, n) : null;
    }, this.rest);
  }

  pose(b: BodyKey): void {
    const d2r = Math.PI / 180;
    for (const name of Object.keys(this.vrm.humanoid.humanBones)) {
      if (name === 'neck' || name === 'head' || /Eye|Jaw/.test(name)) continue;
      this.node(name)?.quaternion.identity();
    }
    // Torso spread over the spine chain.
    const torso = new Quaternion().setFromEuler(new Euler(b.torso.pitch * d2r, b.torso.yaw * d2r, -b.torso.roll * d2r, 'YXZ'));
    const chain = ['spine', 'chest', 'upperChest'].filter((n) => this.node(n));
    const shares = chain.length === 3 ? [0.4, 0.35, 0.25] : chain.length === 2 ? [0.55, 0.45] : [1];
    chain.forEach((n, i) => this.set(n, qpow(torso, shares[i])));
    for (const side of ['left', 'right'] as const) this.poseArm(side, side === 'left' ? b.left : b.right);
    this.vrm.scene.updateMatrixWorld(true);
    for (const side of ['left', 'right'] as const) this.poseThumb(side, side === 'left' ? b.left : b.right);
  }

  private poseArm(side: 'left' | 'right', h: HandKey): void {
    const m = (v: V3) => new Vector3(side === 'left' ? v[0] : -v[0], v[1], v[2]);
    const S = this.restPos.get(`${side}UpperArm`);
    const E0 = this.restPos.get(`${side}LowerArm`);
    const W0 = this.restPos.get(`${side}Hand`);
    if (!S || !E0 || !W0) return;
    const L1 = E0.distanceTo(S);
    const L2 = W0.distanceTo(E0);
    const A = L1 + L2;
    const off = m(h.wrist).multiplyScalar(A);
    if (off.length() > 0.98 * A) off.setLength(0.98 * A);
    const d = off.length();
    const u = off.clone().normalize();
    const a = (L1 * L1 - L2 * L2 + d * d) / (2 * d);
    const hh = Math.sqrt(Math.max(0, L1 * L1 - a * a));
    const pole = m(h.pole);
    pole.addScaledVector(u, -pole.dot(u)).normalize();
    const elbow = u.clone().multiplyScalar(a).addScaledVector(pole, hh);
    const upperDir = elbow.clone().normalize();
    const lowerDir = off.clone().sub(elbow).normalize();
    const upperRest = this.rest[`${side}UpperArm`]!;
    const lowerRest = this.rest[`${side}LowerArm`]!;
    const perp = lowerDir.clone().addScaledVector(upperDir, -lowerDir.dot(upperDir));
    const qU = perp.lengthSq() > 1e-6 ? basisRotation(upperRest, FWD, upperDir, perp) : new Quaternion().setFromUnitVectors(upperRest, upperDir);
    const lowerLocal = lowerDir.clone().applyQuaternion(qU.clone().invert());
    let qL = new Quaternion().setFromUnitVectors(lowerRest, lowerLocal);
    // Hand: fingers and thumb directions; half its twist goes to the forearm.
    const handRest = this.rest[`${side}Hand`]!;
    // The model's own thumb direction at rest, so "thumbDir" is where the thumb really points.
    const thumbRest = (this.rest[`${side}ThumbMetacarpal`] ?? FWD).clone().add(this.rest[`${side}ThumbProximal`] ?? FWD);
    const handWorld = basisRotation(handRest, thumbRest, m(h.fingers), m(h.thumbDir));
    let qH = qU.clone().multiply(qL).invert().multiply(handWorld);
    const tw = qpow(twistAbout(qH, handRest.clone().normalize()), 0.5);
    qL = qL.multiply(tw);
    qH = tw.clone().invert().multiply(qH);
    this.set(`${side}UpperArm`, qU);
    this.set(`${side}LowerArm`, qL);
    this.set(`${side}Hand`, qH);
    // Fingers: flex about the hinge axis (rest dir x palm side), spread about the palm normal.
    const flex = [80, 95, 65].map((x) => (x * Math.PI) / 180);
    FINGERS.forEach((f, i) => {
      const c = h.curl[i];
      const spreadSign = f === 'Index' ? 1 : f === 'Middle' ? -0.4 : f === 'Ring' ? -0.6 : -1;
      const spread = (f === 'Index' || f === 'Middle' ? h.spread : h.spread * 0.5) * 0.16 * spreadSign;
      ['Proximal', 'Intermediate', 'Distal'].forEach((seg, j) => {
        const bone = `${side}${f}${seg}`;
        const r = this.rest[bone];
        if (!r) return;
        const e2 = PALM.clone().addScaledVector(r, -PALM.dot(r)).normalize();
        const axis = new Vector3().crossVectors(r, e2).normalize();
        let q = new Quaternion().setFromAxisAngle(axis, c * flex[j]);
        if (j === 0 && spread) {
          // + spread moves toward the thumb (+Z at rest).
          const s = side === 'left' ? 1 : -1;
          q = new Quaternion().setFromAxisAngle(new Vector3(0, -s, 0), spread).multiply(q);
        }
        this.set(bone, q);
      });
    });
  }

  /** Thumb: CCD toward a fold point over the curled fingers, or the index tip (pinch). */
  private poseThumb(side: 'left' | 'right', h: HandKey): void {
    if (h.fold < 0.01 && h.pinch < 0.01) return;
    const bones = ['ThumbMetacarpal', 'ThumbProximal', 'ThumbDistal'].map((b) => this.node(`${side}${b}`));
    if (bones.some((b) => !b)) return;
    const wp = (n: Object3D) => n.getWorldPosition(new Vector3());
    const [meta, prox, dist] = bones as Object3D[];
    const proxLen = wp(dist).distanceTo(wp(prox));
    const tipOf = () => {
      // Distal head + its direction * ~0.85 of the proximal length.
      const dir = wp(dist).sub(wp(prox)).normalize();
      return wp(dist).addScaledVector(dir, 0.85 * proxLen);
    };
    const start = tipOf();
    const target = start.clone();
    const node = (b: string) => this.node(`${side}${b}`)!;
    if (h.fold > 0) {
      const p = wp(node('IndexIntermediate')).add(wp(node('MiddleIntermediate'))).multiplyScalar(0.5);
      target.lerp(p, h.fold);
    }
    if (h.pinch > 0) {
      const di = node('IndexDistal');
      const dir = wp(di).sub(wp(node('IndexIntermediate'))).normalize();
      const idxTip = wp(di).addScaledVector(dir, 0.8 * wp(di).distanceTo(wp(node('IndexIntermediate'))));
      target.lerp(idxTip, h.pinch);
    }
    for (let it = 0; it < 16; it++) {
      for (const n of [dist, prox, meta]) {
        const j = wp(n);
        const eff = tipOf().sub(j);
        const want = target.clone().sub(j);
        if (eff.lengthSq() < 1e-12 || want.lengthSq() < 1e-12) continue;
        const delta = new Quaternion().setFromUnitVectors(eff.normalize(), want.normalize());
        const step = qpow(delta, 0.5);
        const parentWorld = n.parent!.getWorldQuaternion(new Quaternion());
        const nodeWorld = n.getWorldQuaternion(new Quaternion());
        n.quaternion.copy(parentWorld.clone().invert().multiply(step).multiply(nodeWorld));
        n.updateMatrixWorld(true);
      }
    }
  }
}

/**
 * Optional (?clean=1): paint out heavy face makeup on the model's face texture
 * (black lips/eyeliner, face paint), which MediaPipe reads as a puckered mouth
 * and closed eyes. Only for generating test footage; works on the texture of
 * the material named like "FaceSkin" / "Face".
 */
function cleanFaceMakeup(vrm: VRM): void {
  vrm.scene.traverse((o) => {
    const mesh = o as unknown as { material?: unknown };
    const mats = (Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []) as Array<Record<string, any>>;
    for (const m of mats) {
      if (!/face ?skin|^face$/i.test(m.name ?? '')) continue;
      for (const key of ['map', 'shadeMultiplyTexture']) {
        const tex = m[key];
        const img = tex?.image as CanvasImageSource & { width: number; height: number } | undefined;
        if (!img) continue;
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const g = c.getContext('2d')!;
        g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, c.width, c.height);
        const px = d.data;
        const skin = [221, 206, 198];
        const lip = [176, 104, 104];
        for (let y = 0; y < c.height; y++) {
          for (let x = 0; x < c.width; x++) {
            const i = 4 * (y * c.width + x);
            const r = px[i], gg = px[i + 1], b = px[i + 2];
            const lum = (0.3 * r + 0.59 * gg + 0.11 * b) / 255;
            const red = r > 120 && r > gg * 1.6 && r > b * 1.6;
            if (lum > 0.42 && !red) continue;
            const u = x / c.width, v = y / c.height;
            const isLip = u > 0.39 && u < 0.61 && v > 0.53 && v < 0.64;
            const t = isLip ? lip : skin;
            px[i] = t[0];
            px[i + 1] = t[1];
            px[i + 2] = t[2];
          }
        }
        g.putImageData(d, 0, 0);
        const nt = tex.clone();
        nt.image = c;
        nt.needsUpdate = true;
        m[key] = nt;
        m.needsUpdate = true;
      }
    }
  });
}

async function main() {
  const p = new URLSearchParams(location.search);
  const W = Number(p.get('w') ?? 640);
  const H = Number(p.get('h') ?? 480);
  const url = p.get('model') ?? '/__local/model.vrm';

  const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.setPixelRatio(1);
  renderer.setSize(W, H);
  document.body.appendChild(renderer.domElement);
  const scene = new Scene();
  scene.background = new Color('#7d8288');
  const key = new DirectionalLight(0xffffff, Math.PI * 0.9);
  key.position.set(0.4, 1.8, 2.0);
  const fill = new DirectionalLight(0xffffff, Math.PI * 0.4);
  fill.position.set(-1.0, 1.2, 1.5);
  scene.add(key, fill, new AmbientLight(0xffffff, 0.7));

  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const gltf = await loader.loadAsync(url);
  const vrm = gltf.userData.vrm as VRM;
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  widenSkinIndices(gltf.scene);
  VRMUtils.combineSkeletons(gltf.scene);
  VRMUtils.rotateVRM0(vrm);
  vrm.scene.traverse((o) => (o.frustumCulled = false));
  scene.add(vrm.scene);
  if (p.get('clean') === '1') cleanFaceMakeup(vrm);
  vrm.update(0);

  // Webcam-like framing: ~55° vertical field of view, at eye level, 0.8 m away.
  const head = vrm.humanoid.getRawBoneNode('head')!.getWorldPosition(new Vector3());
  const camera = new PerspectiveCamera(55, W / H, 0.05, 20);
  camera.position.set(0, head.y + 0.02, 0.8);
  camera.lookAt(0, head.y - 0.16, 0);

  const nb = (n: Parameters<typeof vrm.humanoid.getNormalizedBoneNode>[0]) => vrm.humanoid.getNormalizedBoneNode(n);
  const down = (side: 1 | -1) => new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -side * 1.25);
  // Raised ("wave"): upper arm out to the side a little below horizontal, forearm up.
  const raised = (side: 1 | -1) => new Quaternion().setFromEuler(new Euler(0, -side * 0.6, -side * 0.85, 'YXZ'));
  const foreUp = (side: 1 | -1) => new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), side * 2.1);

  const poser = new BodyPoser(vrm);
  vrm.humanoid.resetNormalizedPose();
  let lastTruth: Truth | null = null;
  // A hand is "in frame" when its wrist and middle fingertip project inside the image.
  const inFrame = (side: 'left' | 'right') => {
    const pts = [`${side}Hand`, `${side}MiddleDistal`, `${side}IndexDistal`, `${side}LittleDistal`].map((b) => poser.node(b));
    return pts.every((n) => {
      if (!n) return true;
      const p = n.getWorldPosition(new Vector3()).project(camera);
      return Math.abs(p.x) < 0.98 && Math.abs(p.y) < 0.98;
    });
  };
  // Let the spring bones settle at rest before frame 0.
  for (let i = 0; i < 120; i++) vrm.update(1 / 60);
  let lastT = 0;
  (window as unknown as { __clip: unknown }).__clip = {
    fps: FPS,
    frames: Math.round(DURATION * FPS),
    // The truth of the frame last rendered (includes the measured rig).
    /** World positions of a few bones (debug: checks the rotation-based truth). */
    positions: (names: string[]) =>
      names.map((n) => poser.node(n)?.getWorldPosition(new Vector3()).toArray().map((x) => +x.toFixed(3))),
    truth: (i: number) => (lastTruth && Math.abs(lastTruth.t - i / FPS) < 1e-6 ? lastTruth : truthAt(i / FPS)),
    frame: (i: number) => {
      const t = i / FPS;
      const g = truthAt(t);
      const em = vrm.expressionManager!;
      for (const e of em.expressions) em.setValue(e.expressionName, 0);
      for (const [k, v] of Object.entries(g.expr)) em.setValue(k, v);
      const d2r = Math.PI / 180;
      const hq = new Quaternion().setFromEuler(new Euler(-g.head.pitch * d2r, g.head.yaw * d2r, g.head.roll * d2r, 'YXZ'));
      // Rotations below are in the +Z-facing (VRM 1.0) frame; a VRM 0.x rig faces -Z.
      const vrm0 = vrm.meta?.metaVersion === '0';
      const fix = (q: Quaternion) => (vrm0 ? q.set(-q.x, q.y, -q.z, q.w) : q);
      nb('neck')?.quaternion.copy(fix(new Quaternion().slerp(hq, 0.4)));
      nb('head')?.quaternion.copy(fix(new Quaternion().slerp(hq, 0.6)));
      if (t >= BODY_START) {
        poser.pose(bodyAt(t));
      } else {
        for (const [side, s] of [['left', 1], ['right', -1]] as const) {
          const a = g.arms[side];
          nb(`${side}UpperArm`)?.quaternion.copy(fix(down(s).slerp(raised(s), a)));
          nb(`${side}LowerArm`)?.quaternion.copy(fix(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), s * 0.15).slerp(foreUp(s), a)));
        }
      }
      vrm.update(Math.max(0, t - lastT) || 1 / FPS);
      lastT = t;
      renderer.render(scene, camera);
      g.rig = poser.probe();
      g.handInFrame = { left: inFrame('left'), right: inFrame('right') };
      lastTruth = g;
      return renderer.domElement.toDataURL('image/png');
    },
  };
  document.title = 'ready';
}

main().catch((e) => {
  document.title = 'error';
  console.error(e);
});
