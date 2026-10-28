/**
 * Depth of field: the scene into a target with a depth texture,
 * a half-resolution pass that stores colour plus blur radius, then a
 * full-resolution gather from that half-resolution image to the canvas.
 *
 * three's BokehPass renders the whole scene a second time for depth, which
 * re-skins the avatar; at 1080p that dropped an M3 Pro to ~50 fps. Reading the
 * depth the colour pass already wrote costs one extra full-screen draw.
 *
 * The target is not multisampled: on ANGLE/Metal, resolving a 4× MSAA colour
 * and depth texture at 1080p cost ~6 ms (124 → 72 fps uncapped), and with the
 * background blurred the avatar's edges showed no visible difference.
 *
 * Only what lies behind the focus plane blurs (the avatar is the subject), and
 * each tap is weighted by its own blur radius so the sharp avatar doesn't
 * smear into the background around it.
 */
import {
  DepthTexture,
  HalfFloatType,
  ShaderMaterial,
  UnsignedIntType,
  Vector2,
  WebGLRenderTarget,
  type Camera,
  type PerspectiveCamera,
  type Scene,
  type WebGLRenderer,
} from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

export class DepthOfField {
  private target: WebGLRenderTarget | null = null;
  private half: WebGLRenderTarget | null = null;
  private readonly prep: FullScreenQuad;
  private readonly gather: FullScreenQuad;
  private readonly prepMat: ShaderMaterial;
  private readonly gatherMat: ShaderMaterial;
  private readonly size = new Vector2();
  /** Distance to keep sharp, metres. */
  focus = 1.3;

  constructor() {
    const common = /* glsl */ `
      #include <packing>
      uniform sampler2D tDepth;
      uniform float focus, near, far, maxBlur;
      float dist(vec2 uv) { return -perspectiveDepthToViewZ(texture2D(tDepth, uv).x, near, far); }
      // Blur radius in full-res pixels: zero in front of the focus plane, growing behind it.
      float coc(float d) { return clamp((d - focus) / max(d, 1e-3) * 1.6, 0.0, 1.0) * maxBlur; }
    `;
    const uniforms = () => ({
      tColor: { value: null },
      tDepth: { value: null },
      tHalf: { value: null },
      texel: { value: new Vector2() },
      focus: { value: 1.3 },
      near: { value: 0.05 },
      far: { value: 50 },
      maxBlur: { value: 7 },
    });
    const vertexShader = /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
    // Half resolution: colour, and the blur radius in alpha (normalised by maxBlur).
    this.prepMat = new ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      uniforms: uniforms(),
      vertexShader,
      fragmentShader: /* glsl */ `
        ${common}
        uniform sampler2D tColor;
        varying vec2 vUv;
        void main() { gl_FragColor = vec4(texture2D(tColor, vUv).rgb, coc(dist(vUv)) / maxBlur); }`,
    });
    this.gatherMat = new ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      uniforms: uniforms(),
      vertexShader,
      fragmentShader: /* glsl */ `
        ${common}
        uniform sampler2D tColor, tHalf;
        uniform vec2 texel;
        varying vec2 vUv;
        void main() {
          vec4 base = texture2D(tColor, vUv);
          float c = coc(dist(vUv));
          if (c < 0.75) { gl_FragColor = base; }
          else {
            vec3 sum = vec3(0.0);
            float wsum = 0.0;
            const float GA = 2.39996323;
            for (int i = 0; i < 16; i++) {
              float r = sqrt((float(i) + 0.5) / 16.0) * c;
              vec2 uv = vUv + vec2(cos(float(i) * GA), sin(float(i) * GA)) * r * texel;
              vec4 t = texture2D(tHalf, uv);
              // Only taps that are themselves this blurred contribute: the sharp avatar never smears outward.
              float w = smoothstep(r - 1.5, r, t.a * maxBlur);
              sum += t.rgb * w;
              wsum += w;
            }
            gl_FragColor = wsum > 0.01 ? vec4(sum / wsum, base.a) : base;
          }
          #include <colorspace_fragment>
        }`,
    });
    this.prep = new FullScreenQuad(this.prepMat);
    this.gather = new FullScreenQuad(this.gatherMat);
  }

  render(r: WebGLRenderer, scene: Scene, camera: Camera): void {
    r.getDrawingBufferSize(this.size);
    const w = Math.max(1, this.size.x);
    const h = Math.max(1, this.size.y);
    if (!this.target || this.target.width !== w || this.target.height !== h) {
      this.target?.dispose();
      this.half?.dispose();
      this.target = new WebGLRenderTarget(w, h, {
        type: HalfFloatType,
        depthTexture: new DepthTexture(w, h, UnsignedIntType),
      });
      this.half = new WebGLRenderTarget(Math.ceil(w / 2), Math.ceil(h / 2), { type: HalfFloatType, depthBuffer: false });
    }
    const cam = camera as PerspectiveCamera;
    for (const m of [this.prepMat, this.gatherMat]) {
      const u = m.uniforms;
      u.tColor.value = this.target.texture;
      u.tDepth.value = this.target.depthTexture;
      u.tHalf.value = this.half!.texture;
      u.texel.value.set(1 / w, 1 / h);
      u.focus.value = this.focus;
      u.near.value = cam.near;
      u.far.value = cam.far;
      u.maxBlur.value = 7 * (h / 1080);
    }
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.target);
    r.render(scene, camera);
    r.setRenderTarget(this.half);
    this.prep.render(r);
    r.setRenderTarget(prev);
    this.gather.render(r);
  }

  dispose(): void {
    this.target?.dispose();
    this.half?.dispose();
    this.target = null;
    this.half = null;
    this.prepMat.dispose();
    this.gatherMat.dispose();
    this.prep.dispose();
    this.gather.dispose();
  }
}
