/** three.js stage: renderer, camera, lights, background. */
import {
  AmbientLight,
  Color,
  DirectionalLight,
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

export class Viewer {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(28, 1, 0.05, 50);
  readonly controls: OrbitControls;
  avatar: Avatar | null = null;
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
    this.scene.add(key, fill, new AmbientLight(0xffffff, 0.6));

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
    const head = this.avatar.headPosition();
    const target = new Vector3(0, head.y - (f === 'bust' ? 0.12 : f === 'upper' ? 0.3 : head.y * 0.5), 0);
    const dist = f === 'bust' ? 1.25 : f === 'upper' ? 2.1 : 4.2;
    this.controls.target.copy(target);
    this.camera.position.set(0, target.y + 0.03, dist);
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
    this.renderer.render(this.scene, this.camera);
  }
}
