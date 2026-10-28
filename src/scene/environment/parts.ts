/**
 * Procedural building blocks shared by the environment presets: value noise,
 * canvas textures, a gradient sky dome and a swept "sheet" geometry. Nothing
 * here loads a file.
 */
import {
  AdditiveBlending,
  BackSide,
  BufferGeometry,
  CanvasTexture,
  Color,
  Float32BufferAttribute,
  Mesh,
  RepeatWrapping,
  ShaderMaterial,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Vector3,
  type ColorRepresentation,
} from 'three';

// ---------------------------------------------------------------- noise

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth 2D value noise in [0, 1]. Tiles every `period` cells when given. */
export function valueNoise(x: number, y: number, seed = 0, period = 0): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const w = (i: number) => (period ? ((i % period) + period) % period : i);
  const a = hash2(w(xi), w(yi), seed);
  const b = hash2(w(xi + 1), w(yi), seed);
  const c = hash2(w(xi), w(yi + 1), seed);
  const d = hash2(w(xi + 1), w(yi + 1), seed);
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** Fractal value noise in [0, 1]. */
export function fbm(x: number, y: number, octaves = 4, seed = 0, period = 0): number {
  let s = 0;
  let amp = 0.5;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    s += amp * valueNoise(x, y, seed + o * 17, period ? period << o : 0);
    norm += amp;
    x *= 2;
    y *= 2;
    amp *= 0.5;
  }
  return s / norm;
}

// ---------------------------------------------------------------- canvas textures

/** Paint a texture pixel by pixel. `f` returns sRGB 0–255 and alpha 0–255. */
export function paintTexture(
  size: number,
  f: (u: number, v: number, x: number, y: number) => [number, number, number, number?],
  opts: { repeat?: [number, number]; srgb?: boolean } = {},
): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b, a = 255] = f(x / size, y / size, x, y);
      const i = 4 * (y * size + x);
      img.data[i] = r;
      img.data[i + 1] = g;
      img.data[i + 2] = b;
      img.data[i + 3] = a;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new CanvasTexture(c);
  if (opts.srgb !== false) t.colorSpace = SRGBColorSpace;
  if (opts.repeat) {
    t.wrapS = t.wrapT = RepeatWrapping;
    t.repeat.set(...opts.repeat);
  }
  t.anisotropy = 4;
  return t;
}

/** Soft round blob, black with radial alpha: the cheap contact shadow. */
export function blobTexture(): CanvasTexture {
  return paintTexture(128, (u, v) => {
    const d = Math.hypot(u - 0.5, v - 0.5) * 2;
    const a = Math.max(0, 1 - d) ** 1.6;
    return [0, 0, 0, Math.round(a * 255)];
  });
}

let glowTex: CanvasTexture | null = null;
/**
 * Additive halo sprite: the cheap stand-in for bloom around bright things.
 * (The shared texture survives scene disposal: it is tiny and reused.)
 */
export function glowSprite(color: ColorRepresentation, size: number, opacity = 0.6): Sprite {
  glowTex ??= paintTexture(64, (u, v) => {
    const d = Math.min(1, Math.hypot(u - 0.5, v - 0.5) * 2);
    const a = (1 - d) ** 2.2;
    return [255, 255, 255, Math.round(a * 255)];
  });
  const m = new Sprite(
    new SpriteMaterial({ map: glowTex, color, transparent: true, opacity, depthWrite: false, blending: AdditiveBlending, fog: false }),
  );
  m.scale.set(size, size, 1);
  m.userData.keepTexture = true;
  return m;
}

/** Wispy white puff for mist sprites. */
export function mistTexture(seed = 3): CanvasTexture {
  return paintTexture(256, (u, v) => {
    const dx = (u - 0.5) * 2;
    const dy = (v - 0.5) * 2;
    const r = Math.max(0, 1 - Math.hypot(dx, dy * 1.6));
    const n = fbm(u * 6, v * 6, 4, seed);
    const a = Math.max(0, r * r * (n * 1.6 - 0.35));
    return [255, 255, 255, Math.round(Math.min(1, a) * 255)];
  });
}

const c255 = (c: ColorRepresentation) => {
  const col = new Color(c);
  return [col.r * 255, col.g * 255, col.b * 255] as const;
};
/** Mix two colours by t in sRGB space, as 0–255 channels. */
export function mix255(a: ColorRepresentation, b: ColorRepresentation, t: number): [number, number, number] {
  const x = c255(a);
  const y = c255(b);
  return [x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t];
}

// ---------------------------------------------------------------- sky

export interface SkyOptions {
  top: ColorRepresentation;
  horizon: ColorRepresentation;
  bottom: ColorRepresentation;
  /** Higher = thinner horizon band. */
  exponent?: number;
  sunDir?: Vector3;
  sunColor?: ColorRepresentation;
  /** Angular size of the sun disc (cosine threshold, e.g. 0.9995). 0 = no disc, glow only. */
  sunSize?: number;
  sunGlow?: number;
  stars?: number;
  radius?: number;
}

/** A gradient sky dome with an optional sun disc, glow and star field. */
export function skyDome(o: SkyOptions): Mesh {
  const mat = new ShaderMaterial({
    side: BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      top: { value: new Color(o.top) },
      horizon: { value: new Color(o.horizon) },
      bottom: { value: new Color(o.bottom) },
      exponent: { value: o.exponent ?? 0.6 },
      sunDir: { value: (o.sunDir ?? new Vector3(0, -1, 0)).clone().normalize() },
      sunColor: { value: new Color(o.sunColor ?? 0xffffff) },
      sunSize: { value: o.sunSize ?? 0 },
      sunGlow: { value: o.sunGlow ?? 0 },
      stars: { value: o.stars ?? 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 top, horizon, bottom, sunColor, sunDir;
      uniform float exponent, sunSize, sunGlow, stars;
      varying vec3 vDir;
      float h3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
      void main() {
        vec3 d = normalize(vDir);
        float y = d.y;
        vec3 col = y > 0.0
          ? mix(horizon, top, pow(clamp(y, 0.0, 1.0), exponent))
          : mix(horizon, bottom, pow(clamp(-y * 3.0, 0.0, 1.0), 0.5));
        float s = max(dot(d, sunDir), 0.0);
        col += sunColor * sunGlow * (pow(s, 8.0) * 0.35 + pow(s, 64.0) * 0.6);
        if (sunSize > 0.0) col = mix(col, sunColor * 1.6, smoothstep(sunSize - 0.0004, sunSize, s));
        if (stars > 0.0 && y > 0.02) {
          vec3 cell = floor(d * 220.0);
          float r = h3(cell);
          col += vec3(smoothstep(1.0 - 0.004 * stars, 1.0, r)) * smoothstep(0.02, 0.3, y) * 0.9;
        }
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const m = new Mesh(new SphereGeometry(o.radius ?? 45, 32, 16), mat);
  m.renderOrder = -10;
  m.frustumCulled = false;
  m.name = 'sky';
  return m;
}

// ---------------------------------------------------------------- geometry

/**
 * A sheet swept along X through a profile of (y, z) points: cycloramas,
 * curved walls. UVs: u along X (metres), v along the profile (metres).
 */
export function profileSheet(profile: Array<[number, number]>, width: number, segsX = 1): BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const len: number[] = [0];
  for (let i = 1; i < profile.length; i++) {
    len.push(len[i - 1] + Math.hypot(profile[i][0] - profile[i - 1][0], profile[i][1] - profile[i - 1][1]));
  }
  const cols = segsX + 1;
  for (let i = 0; i < profile.length; i++) {
    for (let j = 0; j < cols; j++) {
      const x = -width / 2 + (width * j) / segsX;
      pos.push(x, profile[i][0], profile[i][1]);
      uv.push(x, len[i]);
    }
  }
  for (let i = 0; i < profile.length - 1; i++) {
    for (let j = 0; j < segsX; j++) {
      const a = i * cols + j;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Quarter-circle cove profile from floor (front) up into the back wall. */
export function coveProfile(front: number, back: number, radius: number, height: number, steps = 12): Array<[number, number]> {
  const pts: Array<[number, number]> = [[0, front]];
  const cz = back + radius;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * (Math.PI / 2);
    pts.push([radius - Math.cos(a) * radius, cz - Math.sin(a) * radius]);
  }
  pts.push([height, back]);
  return pts;
}
