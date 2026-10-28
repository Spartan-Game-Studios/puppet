/** three.js stage: renderer, camera, lights, background. */
import {
  AmbientLight,
  Box3,
  Camera,
  Color,
  DirectionalLight,
  Group,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Texture,
  TextureLoader,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Avatar } from './avatar';

export type Framing = 'bust' | 'upper' | 'full';

/**
 * Size factor for the framing presets: 1 for anything human-sized (1.3-2.1 m
 * tall), proportional outside that, so a 30 cm mascot or a 4 m giant is
 * framed like a person rather than lost in the middle of the frame or cropped.
 */
export function framingScale(height: number): number {
  if (!(height > 0)) return 1;
  return height < 1.3 ? Math.max(0.05, height / 1.3) : height > 2.1 ? height / 2.1 : 1;
}

/** Camera target and position for a framing preset (camera on +Z looking at the avatar). */
export function framingFor(f: Framing, head: Vector3, b: Box3, fovDeg: number): { target: Vector3; position: Vector3 } {
  const s = framingScale(b.max.y - b.min.y);
  const target = new Vector3(0, f === 'full' ? (b.min.y + b.max.y) / 2 : head.y - (f === 'bust' ? 0.12 : 0.3) * s, 0);
  const human = (f === 'bust' ? 1.25 : f === 'upper' ? 2.1 : 4.2) * s;
  // Human framing distances assume a face ~0.1 m in front of the head bone.
  // If the model's front reaches within 0.3 m of that camera (a big or round
  // avatar would swallow it), keep that gap from its actual front surface
  // instead; FULL also fits the whole height.
  let dist = b.max.z + 0.3 * s > human ? b.max.z + human - 0.1 * s : human;
  const tanHalf = Math.tan(((fovDeg / 2) * Math.PI) / 180);
  if (f === 'full') {
    dist = Math.max(dist, b.max.z + (0.55 * (b.max.y - b.min.y)) / tanHalf);
  } else {
    // A head far bigger than a person's (a mascot that is all head, a 2 m
    // ball) would fill the frame with one patch of surface: keep at least
    // part of its width (45% bust, 70% upper) and half the span from the
    // target to its top in view. A human never reaches these limits.
    const width = b.max.x - b.min.x;
    const frac = f === 'bust' ? 0.45 : 0.7;
    dist = Math.max(dist, b.max.z + (frac * width) / 2 / tanHalf, b.max.z + (0.5 * (b.max.y - target.y)) / tanHalf);
  }
  return { target, position: new Vector3(0, target.y + 0.03 * s, dist) };
}

export class Viewer {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(28, 1, 0.05, 50);
  readonly controls: OrbitControls;
  avatar: Avatar | null = null;
  /** The flat-background lights; an environment hides them and brings its own. */
  readonly defaultLights = new Group();
  /** When set, called instead of renderer.render (3D environments: post-processing, camera sway). */
  renderHook: ((renderer: WebGLRenderer, scene: Scene, camera: Camera) => void) | null = null;
  private bgTexture: Texture | null = null;
  private host: HTMLElement;

  constructor(host: HTMLElement) {
    this.host = host;
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(this.renderer.domElement);
    this.renderer.domElement.className = 'stage-canvas';

    const key = new DirectionalLight(0xffffff, Math.PI * 0.9);
    key.position.set(0.6, 1.6, 2.2);
    const fill = new DirectionalLight(0xffffff, Math.PI * 0.35);
    fill.position.set(-1.2, 1.0, 1.0);
    this.defaultLights.add(key, fill, new AmbientLight(0xffffff, 0.6));
    this.scene.add(this.defaultLights);

    this.camera.position.set(0, 1.4, 1.6);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.target.set(0, 1.35, 0);
    this.controls.update();

    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
  }

  resize(): void {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setAvatar(a: Avatar | null): void {
    if (this.avatar) {
      this.scene.remove(this.avatar.vrm.scene);
      // Free GPU memory of the old model.
      this.avatar.vrm.scene.traverse((o) => {
        const m = o as { geometry?: { dispose(): void }; material?: unknown };
        m.geometry?.dispose();
        const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
        for (const mat of mats as Array<{ dispose(): void; [k: string]: unknown }>) {
          for (const v of Object.values(mat)) if (v instanceof Texture) v.dispose();
          mat.dispose();
        }
      });
    }
    this.avatar = a;
    if (a) {
      this.scene.add(a.vrm.scene);
      this.frame('bust');
    }
  }

  frame(f: Framing): void {
    if (!this.avatar) return;
    const { target, position } = framingFor(f, this.avatar.headPosition(), this.avatar.bounds, this.camera.fov);
    this.controls.target.copy(target);
    this.camera.position.copy(position);
    // A tiny avatar puts the camera close: keep the near plane well in front of it.
    const near = Math.min(0.05, Math.max(0.005, (position.z - this.avatar.bounds.max.z) * 0.25));
    if (near !== this.camera.near) {
      this.camera.near = near;
      this.camera.updateProjectionMatrix();
    }
    this.controls.update();
  }

  /** Solid colour, transparent, or an image (blob/data URL). */
  setBackground(kind: 'color' | 'transparent' | 'image', color: string, imageUrl: string | null): void {
    this.bgTexture?.dispose();
    this.bgTexture = null;
    if (kind === 'transparent') {
      this.scene.background = null;
      this.renderer.setClearColor(0x000000, 0);
    } else if (kind === 'image' && imageUrl) {
      this.renderer.setClearColor(0x000000, 1);
      new TextureLoader().load(imageUrl, (t) => {
        t.colorSpace = SRGBColorSpace;
        this.bgTexture = t;
        this.scene.background = t;
      });
    } else {
      this.scene.background = new Color(color);
      this.renderer.setClearColor(new Color(color), 1);
    }
  }

  render(): void {
    this.controls.update();
    if (this.renderHook) this.renderHook(this.renderer, this.scene, this.camera);
    else this.renderer.render(this.scene, this.camera);
  }
}
