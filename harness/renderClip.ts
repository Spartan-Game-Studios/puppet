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
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';

export const FPS = 30;
export const DURATION = 14;

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
  return {
    t,
    expr,
    head: { yaw, pitch, roll: 0 },
    arms: { left: bump(t, 10.0, 13.6, 0.6), right: bump(t, 11.0, 13.6, 0.6) },
  };
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

  // Let the spring bones settle at rest before frame 0.
  for (let i = 0; i < 120; i++) vrm.update(1 / 60);
  let lastT = 0;
  (window as unknown as { __clip: unknown }).__clip = {
    fps: FPS,
    frames: Math.round(DURATION * FPS),
    truth: (i: number) => truthAt(i / FPS),
    frame: (i: number) => {
      const t = i / FPS;
      const g = truthAt(t);
      const em = vrm.expressionManager!;
      for (const e of em.expressions) em.setValue(e.expressionName, 0);
      for (const [k, v] of Object.entries(g.expr)) em.setValue(k, v);
      const d2r = Math.PI / 180;
      const hq = new Quaternion().setFromEuler(new Euler(-g.head.pitch * d2r, g.head.yaw * d2r, g.head.roll * d2r, 'YXZ'));
      nb('neck')?.quaternion.copy(new Quaternion().slerp(hq, 0.4));
      nb('head')?.quaternion.copy(new Quaternion().slerp(hq, 0.6));
      for (const [side, s] of [['left', 1], ['right', -1]] as const) {
        const a = g.arms[side];
        nb(`${side}UpperArm`)?.quaternion.copy(down(s).slerp(raised(s), a));
        nb(`${side}LowerArm`)?.quaternion.copy(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), s * 0.15).slerp(foreUp(s), a));
      }
      vrm.update(Math.max(0, t - lastT) || 1 / FPS);
      lastT = t;
      renderer.render(scene, camera);
      return renderer.domElement.toDataURL('image/png');
    },
  };
  document.title = 'ready';
}

main().catch((e) => {
  document.title = 'error';
  console.error(e);
});
