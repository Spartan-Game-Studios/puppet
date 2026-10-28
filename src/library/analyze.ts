/**
 * Import-time analysis of a VRM: measure it (expressions, spring bones,
 * polygons) and render a bust thumbnail offscreen with three.js.
 *
 * One small offscreen WebGL renderer is created on first use and kept, so
 * importing many models does not pile up GL contexts.
 */
import {
  AmbientLight,
  Box3,
  Color,
  DirectionalLight,
  Mesh,
  PerspectiveCamera,
  Quaternion,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
  type BufferGeometry,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, type VRM, type VRMHumanBoneName } from '@pixiv/three-vrm';
import { buildPerfectSyncMap, VRM_PRESETS } from '../core/blendshapes';
import type { ModelStats } from './libraryIndex';

export const THUMB_SIZE = 512;
/** Neutral card background (a shade under the UI's paper so the frame reads). */
const THUMB_BG = 0xdcdcd6;

export interface Analysis {
  stats: ModelStats;
  thumb: Uint8Array | null;
}

async function parseVrm(buf: ArrayBuffer): Promise<VRM> {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const gltf = await loader.parseAsync(buf, '');
  const vrm = gltf.userData.vrm as VRM | undefined;
  if (!vrm) throw new Error('NOT A VRM (NO VRM EXTENSION)');
  // The spring chain count lives in the glTF JSON; three-vrm flattens it to joints.
  const ext = (gltf.parser.json.extensions ?? {}) as Record<string, any>;
  (vrm as any).__springChains = ext.VRMC_springBone?.springs?.length ?? ext.VRM?.secondaryAnimation?.boneGroups?.length ?? 0;
  return vrm;
}

function measure(vrm: VRM): ModelStats {
  const names = vrm.expressionManager?.expressions.map((e) => e.expressionName) ?? [];
  let polygons = 0;
  vrm.scene.traverse((o) => {
    const g = (o as Mesh).isMesh ? ((o as Mesh).geometry as BufferGeometry) : null;
    if (!g) return;
    const n = g.index ? g.index.count : (g.attributes.position?.count ?? 0);
    polygons += Math.floor(n / 3);
  });
  return {
    perfectSync: buildPerfectSyncMap(names).size,
    presets: VRM_PRESETS.filter((p) => names.includes(p)).length,
    expressions: names.length,
    springChains: (vrm as any).__springChains ?? 0,
    springJoints: vrm.springBoneManager?.joints.size ?? 0,
    polygons,
  };
}

let renderer: WebGLRenderer | null = null;
function thumbRenderer(): WebGLRenderer {
  if (!renderer) {
    const canvas = document.createElement('canvas');
    renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true });
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.setPixelRatio(1);
    renderer.setSize(THUMB_SIZE, THUMB_SIZE, false);
  }
  return renderer;
}

/** Arms down into a relaxed A-pose so a bust shot is not all T-pose sleeve. */
function relaxArms(vrm: VRM): void {
  const vrm0 = vrm.meta?.metaVersion === '0';
  const set = (bone: VRMHumanBoneName, z: number) => {
    const n = vrm.humanoid.getNormalizedBoneNode(bone);
    if (!n) return;
    // VRM 0.x normalized bones face -Z (rotateVRM0 only turns the scene): mirror the rotation.
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), vrm0 ? -z : z);
    n.quaternion.copy(q);
  };
  set('leftUpperArm', -1.15);
  set('rightUpperArm', 1.15);
  set('leftLowerArm', -0.15);
  set('rightLowerArm', 0.15);
  vrm.humanoid.update();
}

function renderThumb(vrm: VRM): Uint8Array {
  const r = thumbRenderer();
  const scene = new Scene();
  scene.background = new Color(THUMB_BG);
  const key = new DirectionalLight(0xffffff, Math.PI * 0.9);
  key.position.set(0.8, 1.6, 2.2);
  const fill = new DirectionalLight(0xffffff, Math.PI * 0.35);
  fill.position.set(-1.4, 1.0, 1.0);
  scene.add(key, fill, new AmbientLight(0xffffff, 0.65), vrm.scene);

  vrm.scene.updateMatrixWorld(true);
  const headNode = vrm.humanoid.getNormalizedBoneNode('head') ?? vrm.humanoid.getRawBoneNode('head');
  // Bounds of the visible meshes.
  const box = new Box3();
  vrm.scene.traverse((o) => {
    if ((o as Mesh).isMesh && o.visible) box.union(new Box3().setFromObject(o, true));
  });
  const height = Math.max(0.2, box.max.y - box.min.y);
  const s = height / 1.6; // 1.0 = an adult-sized model
  const head = headNode ? headNode.getWorldPosition(new Vector3()) : new Vector3(0, box.max.y - 0.12 * s, 0);
  // A body that wraps far around the head bone (a blob or mascot shape) would
  // put a bust camera inside the mesh: shoot the whole model instead.
  const wraps = box.max.z - head.z > 0.5 * s;
  // Bust: from just above the model's top (hair, ears, a big costume head) to mid-chest.
  const top = wraps ? box.max.y + 0.05 * s : Math.max(box.max.y + 0.03 * s, head.y + 0.15 * s);
  const bottom = wraps ? box.min.y - 0.05 * s : Math.min(head.y - 0.42 * s, top - 0.5 * s);
  const span = Math.max(0.1, top - bottom, wraps ? (box.max.x - box.min.x) * 1.1 : 0);
  const cy = (top + bottom) / 2;
  const cam = new PerspectiveCamera(22, 1, 0.01, 100);
  const dist = span / 2 / Math.tan((cam.fov * Math.PI) / 360);
  const camZ = Math.max(head.z + dist, box.max.z + 0.05 * s);
  cam.position.set(head.x, cy + 0.02 * s, camZ);
  cam.lookAt(head.x, cy, head.z);
  cam.near = Math.max(0.01, dist / 50);
  cam.far = camZ - box.min.z + dist * 20;
  cam.updateProjectionMatrix();

  r.setClearColor(THUMB_BG, 1);
  r.render(scene, cam);
  const url = r.domElement.toDataURL('image/png');
  scene.remove(vrm.scene);
  return Uint8Array.from(atob(url.slice(url.indexOf(',') + 1)), (c) => c.charCodeAt(0));
}

/** Measure a VRM and render its thumbnail. Throws "NOT A VRM" for other files. */
export async function analyzeVrm(buf: ArrayBuffer, wantThumb = true): Promise<Analysis> {
  const vrm = await parseVrm(buf);
  try {
    const stats = measure(vrm);
    VRMUtils.rotateVRM0(vrm);
    vrm.scene.traverse((o) => (o.frustumCulled = false));
    relaxArms(vrm);
    vrm.update(0);
    let thumb: Uint8Array | null = null;
    if (wantThumb) {
      try {
        thumb = renderThumb(vrm);
      } catch (e) {
        console.warn('[library] thumbnail failed', e);
      }
    }
    return { stats, thumb };
  } finally {
    VRMUtils.deepDispose(vrm.scene);
  }
}
