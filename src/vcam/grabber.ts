/**
 * Virtual camera frame source: renders the avatar exactly as the stage /
 * capture view does (same scene, camera position, FOV and lights), but into
 * an offscreen target at the camera resolution with a 16:9 aspect, then reads
 * it back asynchronously as BGRA bytes.
 *
 *   scene --render--> MSAA half-float target (linear, premultiplied alpha)
 *         --output pass--> 8-bit target: composite over the background colour,
 *                          encode sRGB, swizzle to BGRA, flip rows to top-down
 *         --readRenderTargetPixelsAsync (PBO + fence, no pipeline stall)-->
 *         frame.pixels (a view into the IPC body, so nothing is copied in JS)
 *
 * Cameras carry no alpha: with the CLEAR background the avatar is composited
 * over the chosen colour (chroma green by default).
 */
import {
  BufferGeometry,
  Float32BufferAttribute,
  HalfFloatType,
  LinearFilter,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  Vector3,
  WebGLRenderTarget,
} from 'three';
import type { Viewer } from '../scene/viewer';
import { parseHex, type FrameBuffer } from './frame';

const BLIT_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

// Keep in sync with compositePixel() in frame.ts (unit-tested reference).
const BLIT_FRAG = /* glsl */ `
uniform sampler2D src;
uniform vec3 bg;
varying vec2 vUv;
vec3 toLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c)); }
vec3 toSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c)); }
void main() {
  // Flip vertically: readPixels returns rows bottom-up; cameras want top-down.
  vec4 c = texture2D(src, vec2(vUv.x, 1.0 - vUv.y));
  vec3 lin = clamp(c.rgb + toLinear(bg) * (1.0 - c.a), 0.0, 1.0);
  vec3 s = toSrgb(lin);
  gl_FragColor = vec4(s.b, s.g, s.r, 1.0); // bytes come out B, G, R, A
}`;

export interface GrabTimings {
  /** CPU time to issue the scene render + output pass (ms). */
  render: number;
  /** From issuing the readback to the bytes being in JS memory (ms). */
  readback: number;
}

export class FrameGrabber {
  private scene3d: Target | null = null;
  private out: WebGLRenderTarget | null = null;
  private readonly blitScene = new Scene();
  private readonly blitCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly blit: ShaderMaterial;
  width = 0;
  height = 0;

  constructor(private readonly viewer: Viewer) {
    const g = new BufferGeometry();
    // One oversized triangle covers the viewport.
    g.setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.blit = new ShaderMaterial({
      vertexShader: BLIT_VERT,
      fragmentShader: BLIT_FRAG,
      uniforms: { src: { value: null }, bg: { value: new Vector3(0, 1, 0) } },
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const m = new Mesh(g, this.blit);
    m.frustumCulled = false;
    this.blitScene.add(m);
  }

  setSize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.dispose();
    this.width = width;
    this.height = height;
    const r = this.viewer.renderer;
    const samples = Math.min(4, r.capabilities.maxSamples);
    // Half-float keeps dark gradients from banding before the sRGB encode;
    // fall back to 8-bit where float colour buffers aren't renderable.
    const float = r.extensions.has('EXT_color_buffer_float') || r.extensions.has('EXT_color_buffer_half_float');
    this.scene3d = new WebGLRenderTarget(width, height, {
      type: float ? HalfFloatType : UnsignedByteType,
      format: RGBAFormat,
      samples,
      depthBuffer: true,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
    });
    this.out = new WebGLRenderTarget(width, height, {
      type: UnsignedByteType,
      format: RGBAFormat,
      depthBuffer: false,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
    });
    this.blit.uniforms.src.value = this.scene3d.texture;
  }

  /** Colour shown where the avatar render is transparent ("clear" background). */
  setBackground(hex: string): void {
    const [r, g, b] = parseHex(hex);
    (this.blit.uniforms.bg.value as Vector3).set(r, g, b);
  }

  /**
   * Render now (synchronously, so it shows the same pose as this display
   * frame) and resolve once the pixels are in `frame.pixels`.
   */
  async grab(frame: FrameBuffer, timings?: GrabTimings): Promise<void> {
    if (!this.scene3d || !this.out) throw new Error('FrameGrabber: setSize first');
    if (frame.width !== this.width || frame.height !== this.height) throw new Error('FrameGrabber: frame size mismatch');
    const r = this.viewer.renderer;
    const cam = this.viewer.camera;
    const t0 = performance.now();
    const prevTarget = r.getRenderTarget();
    const prevAspect = cam.aspect;
    cam.aspect = this.width / this.height;
    cam.updateProjectionMatrix();
    r.setRenderTarget(this.scene3d);
    r.render(this.viewer.scene, cam);
    r.setRenderTarget(this.out);
    r.render(this.blitScene, this.blitCam);
    r.setRenderTarget(prevTarget);
    cam.aspect = prevAspect;
    cam.updateProjectionMatrix();
    const t1 = performance.now();
    await r.readRenderTargetPixelsAsync(this.out, 0, 0, this.width, this.height, frame.pixels);
    if (timings) {
      timings.render = t1 - t0;
      timings.readback = performance.now() - t1;
    }
  }

  dispose(): void {
    this.scene3d?.dispose();
    this.out?.dispose();
    this.scene3d = null;
    this.out = null;
    this.width = this.height = 0;
  }
}

type Target = WebGLRenderTarget;
