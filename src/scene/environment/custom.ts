/**
 * User environments: a glTF scene (.glb, or .gltf with its sibling files) and
 * an equirectangular HDR/EXR sky that also lights the scene (image-based
 * lighting for PBR materials, a spherical-harmonics light probe for MToon).
 */
import {
  Box3,
  EquirectangularReflectionMapping,
  Group,
  HalfFloatType,
  LightProbe,
  LoadingManager,
  Mesh,
  PMREMGenerator,
  Vector3,
  WebGLCubeRenderTarget,
  type DataTexture,
  type Texture,
  type WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
import { LightProbeGenerator } from 'three/examples/jsm/lights/LightProbeGenerator.js';

export const SCENE_EXTS = ['glb', 'gltf'];
export const SKY_EXTS = ['hdr', 'exr'];
export const extOf = (name: string) => (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase();

export interface CustomScene {
  name: string;
  group: Group;
  /** Size of the loaded scene's bounding box, metres (before placement). The scene is centred on x/z with its lowest point on y = 0. */
  size: Vector3;
}

export interface CustomSky {
  name: string;
  /** Equirectangular texture for the background. */
  background: Texture;
  /** Prefiltered environment map for PBR materials. */
  environment: Texture;
  /** Irradiance probe for MToon and other non-IBL materials; intensity is set by the manager. */
  probe: LightProbe;
  /** Irradiance of the probe's DC term (for normalising its intensity). */
  irradiance: number;
  /** Mean luminance of the sky image (for normalising the background). */
  meanLuminance: number;
  dispose(): void;
}

/**
 * Load a glTF scene. `resolve` reads a sibling file named by a relative URI
 * (needed for .gltf with external .bin/textures); without it only .glb and
 * self-contained .gltf work.
 */
export async function loadCustomScene(
  buf: ArrayBuffer,
  name: string,
  resolve?: (uri: string) => Promise<ArrayBuffer>,
): Promise<CustomScene> {
  const manager = new LoadingManager();
  const urls: string[] = [];
  if (extOf(name) === 'gltf' && resolve) {
    const json = JSON.parse(new TextDecoder().decode(buf)) as { buffers?: Array<{ uri?: string }>; images?: Array<{ uri?: string }> };
    const uris = [...(json.buffers ?? []), ...(json.images ?? [])].map((x) => x.uri).filter((u): u is string => !!u && !/^data:/.test(u));
    const map = new Map<string, string>();
    for (const uri of uris) {
      const data = await resolve(decodeURIComponent(uri));
      const url = URL.createObjectURL(new Blob([data]));
      urls.push(url);
      map.set(uri, url);
    }
    manager.setURLModifier((u) => map.get(u) ?? u);
  }
  try {
    const loader = new GLTFLoader(manager);
    const gltf = await loader.parseAsync(buf, '');
    const group = new Group();
    group.add(gltf.scene);
    gltf.scene.traverse((o) => {
      if ((o as Mesh).isMesh) {
        o.receiveShadow = true;
        o.castShadow = false;
      }
    });
    // Centre the scene on the avatar and stand it on y = 0; PLACEMENT and FLOOR adjust from there.
    const box = new Box3().setFromObject(gltf.scene);
    const size = box.getSize(new Vector3());
    if (!box.isEmpty()) {
      const c = box.getCenter(new Vector3());
      gltf.scene.position.sub(new Vector3(c.x, box.min.y, c.z));
    }
    return { name, group, size };
  } finally {
    for (const u of urls) URL.revokeObjectURL(u);
  }
}

/** Load an equirectangular .hdr/.exr and derive the lighting from it. */
export async function loadCustomSky(buf: ArrayBuffer, name: string, renderer: WebGLRenderer): Promise<CustomSky> {
  const ext = extOf(name);
  const loader = ext === 'exr' ? new EXRLoader() : new HDRLoader();
  loader.setDataType(HalfFloatType);
  const url = URL.createObjectURL(new Blob([buf]));
  let tex: DataTexture;
  try {
    tex = (await loader.loadAsync(url)) as DataTexture;
  } finally {
    URL.revokeObjectURL(url);
  }
  tex.mapping = EquirectangularReflectionMapping;

  const pmrem = new PMREMGenerator(renderer);
  const env = pmrem.fromEquirectangular(tex).texture;
  pmrem.dispose();

  const cube = new WebGLCubeRenderTarget(64, { type: HalfFloatType }).fromEquirectangularTexture(renderer, tex);
  const probe = await LightProbeGenerator.fromCubeRenderTarget(renderer, cube);
  cube.dispose();
  const c0 = probe.sh.coefficients[0];
  // shGetIrradianceAt's DC weight is 0.886227 (π for a constant sky of radiance 1 encoded as 2√π).
  const irradiance = 0.886227 * (0.2126 * c0.x + 0.7152 * c0.y + 0.0722 * c0.z);

  return {
    name,
    background: tex,
    environment: env,
    probe,
    irradiance: Math.max(1e-4, irradiance),
    meanLuminance: Math.max(1e-4, irradiance / Math.PI),
    dispose() {
      tex.dispose();
      env.dispose();
    },
  };
}
