/**
 * Environment settings and lighting maths. Pure (no three.js, no DOM) so it is
 * unit-testable: the saved shape, its defaults and sanitising, colour
 * temperature, and the light rig that the look controls resolve to.
 */

export const ENV_PRESETS = ['studio', 'room', 'moor', 'forest', 'neon', 'hall'] as const;
export type EnvPresetId = (typeof ENV_PRESETS)[number];
export type EnvId = EnvPresetId | 'custom';
export type EnvQuality = 'low' | 'high';
/** SCENE = the environment's own lighting; the others restyle it. */
export type LightStyle = 'scene' | 'key' | 'rim' | 'soft';

export const ENV_LABELS: Record<EnvId, string> = {
  studio: 'STUDIO CYCLORAMA',
  room: 'COSY ROOM',
  moor: 'MOOR AT DUSK',
  forest: 'NIGHT CLEARING',
  neon: 'NEON GRID',
  hall: 'CONCRETE HALL',
  custom: 'CUSTOM (GLB + HDR)',
};

/** Look controls, saved per environment. */
export interface EnvLook {
  /** Overall light level, 0.25–2. */
  intensity: number;
  /** White balance in kelvin; 6500 leaves the scene's own colours unchanged. */
  temperature: number;
  style: LightStyle;
  /** Fog amount 0–1; 0.5 is the scene's default density. */
  fog: number;
  /** Ground shadow under the avatar. */
  shadow: boolean;
  /** Subtle idle camera sway. */
  sway: boolean;
  /** Depth of field (HIGH quality only). */
  dof: boolean;
  /** Height of the avatar's floor in the scene, metres (the scene moves, the avatar doesn't). */
  floor: number;
}

/** Placement of a custom glTF scene. */
export interface Placement {
  scale: number;
  x: number;
  y: number;
  z: number;
  /** Rotation about Y, degrees. */
  rotY: number;
}

export interface EnvironmentSettings {
  id: EnvId;
  quality: EnvQuality;
  /** Keyed by envKey(): a preset id, or `custom:<scene path or name>`. */
  looks: Record<string, Partial<EnvLook>>;
  custom: { scenePath: string | null; skyPath: string | null };
  /** Keyed by the custom scene's path (or file name in a browser). */
  placements: Record<string, Partial<Placement>>;
}

export const DEFAULT_LOOK: EnvLook = {
  intensity: 1,
  temperature: 6500,
  style: 'scene',
  fog: 0.5,
  shadow: true,
  sway: false,
  dof: false,
  floor: 0,
};

export const DEFAULT_PLACEMENT: Placement = { scale: 1, x: 0, y: 0, z: 0, rotY: 0 };

export function defaultEnvironmentSettings(): EnvironmentSettings {
  return {
    id: 'studio',
    quality: 'high',
    looks: {},
    custom: { scenePath: null, skyPath: null },
    placements: {},
  };
}

export const LIMITS = {
  intensity: [0.25, 2],
  temperature: [2000, 12000],
  fog: [0, 1],
  floor: [-2, 2],
  scale: [0.01, 100],
  pos: [-50, 50],
  rotY: [-180, 180],
} as const;

const clamp = (v: unknown, [lo, hi]: readonly [number, number], d: number) => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : d;
  return Math.min(hi, Math.max(lo, n));
};

export function envKey(id: EnvId, customScene: string | null): string {
  return id === 'custom' ? `custom:${customScene ?? ''}` : id;
}

export function isEnvId(v: unknown): v is EnvId {
  return v === 'custom' || (ENV_PRESETS as readonly unknown[]).includes(v);
}

/** A complete, in-range look from whatever was saved. */
export function resolveLook(saved: Partial<EnvLook> | undefined): EnvLook {
  const s = saved ?? {};
  return {
    intensity: clamp(s.intensity, LIMITS.intensity, DEFAULT_LOOK.intensity),
    temperature: clamp(s.temperature, LIMITS.temperature, DEFAULT_LOOK.temperature),
    style: s.style && ['scene', 'key', 'rim', 'soft'].includes(s.style) ? s.style : DEFAULT_LOOK.style,
    fog: clamp(s.fog, LIMITS.fog, DEFAULT_LOOK.fog),
    shadow: typeof s.shadow === 'boolean' ? s.shadow : DEFAULT_LOOK.shadow,
    sway: typeof s.sway === 'boolean' ? s.sway : DEFAULT_LOOK.sway,
    dof: typeof s.dof === 'boolean' ? s.dof : DEFAULT_LOOK.dof,
    floor: clamp(s.floor, LIMITS.floor, DEFAULT_LOOK.floor),
  };
}

export function resolvePlacement(saved: Partial<Placement> | undefined): Placement {
  const s = saved ?? {};
  return {
    scale: clamp(s.scale, LIMITS.scale, 1),
    x: clamp(s.x, LIMITS.pos, 0),
    y: clamp(s.y, LIMITS.pos, 0),
    z: clamp(s.z, LIMITS.pos, 0),
    rotY: clamp(s.rotY, LIMITS.rotY, 0),
  };
}

/** Repair a saved environment block (unknown ids, bad quality) in place. */
export function sanitizeEnvironment(e: EnvironmentSettings): EnvironmentSettings {
  if (!isEnvId(e.id)) e.id = 'studio';
  if (e.quality !== 'low' && e.quality !== 'high') e.quality = 'high';
  if (!e.looks || typeof e.looks !== 'object') e.looks = {};
  if (!e.placements || typeof e.placements !== 'object') e.placements = {};
  if (!e.custom || typeof e.custom !== 'object') e.custom = { scenePath: null, skyPath: null };
  return e;
}

// ---------------------------------------------------------------- colour

export type RGB = [number, number, number];

/** Blackbody colour (sRGB, 0–255) at 1000 K steps, from published blackbody tables. */
const BLACKBODY: Array<[number, RGB]> = [
  [1000, [255, 56, 0]],
  [2000, [255, 137, 18]],
  [3000, [255, 180, 107]],
  [4000, [255, 209, 163]],
  [5000, [255, 228, 206]],
  [6000, [255, 243, 239]],
  [6500, [255, 249, 253]],
  [7000, [245, 243, 255]],
  [8000, [227, 233, 255]],
  [9000, [214, 225, 255]],
  [10000, [204, 219, 255]],
  [12000, [191, 211, 255]],
];

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
export const luminance = (c: RGB) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/** 0xRRGGBB (sRGB) to linear RGB. */
export function hexToLinear(hex: number): RGB {
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255].map((v) => srgbToLinear(v / 255)) as RGB;
}

/** Linear-RGB colour of a blackbody at `k` kelvin, interpolated from the table. */
export function kelvinToLinear(k: number): RGB {
  const t = Math.min(12000, Math.max(1000, k));
  let i = 0;
  while (i < BLACKBODY.length - 2 && BLACKBODY[i + 1][0] < t) i++;
  const [k0, c0] = BLACKBODY[i];
  const [k1, c1] = BLACKBODY[i + 1];
  const f = (t - k0) / (k1 - k0);
  return [0, 1, 2].map((j) => srgbToLinear((c0[j] + (c1[j] - c0[j]) * f) / 255)) as RGB;
}

/**
 * White-balance tint for lights: the colour at `k` relative to 6500 K, with
 * its luminance normalised to 1 so changing temperature never changes
 * brightness.
 */
export function temperatureTint(k: number): RGB {
  const c = kelvinToLinear(k);
  const w = kelvinToLinear(6500);
  const rel = [c[0] / w[0], c[1] / w[1], c[2] / w[2]] as RGB;
  const l = luminance(rel);
  return rel.map((x) => x / l) as RGB;
}

// ---------------------------------------------------------------- light rig

export interface LightSpec {
  /** Linear RGB, roughly unit luminance. */
  color: RGB;
  /** Directional lights are made at intensity × π: the flat-background key is 0.9, fill 0.35. */
  intensity: number;
  /** Direction the light comes FROM (towards the light), avatar space: +z is the camera side. */
  dir: RGB;
}

export interface RigSpec {
  key: LightSpec;
  fill: LightSpec;
  rim: LightSpec;
  ambient: { sky: RGB; ground: RGB; intensity: number };
}

/** Style multipliers for key, fill, rim, ambient. */
const STYLE_GAINS: Record<LightStyle, [number, number, number, number]> = {
  scene: [1, 1, 1, 1],
  key: [1.4, 0.5, 0.5, 0.7],
  rim: [0.5, 0.5, 2.2, 0.8],
  soft: [0.4, 1.4, 0.4, 3],
};

/**
 * Face exposure limits (see frontExposure). The flat-background setup gives
 * 1.44. Below MIN the face reads black. Above KNEE the total is compressed
 * smoothly towards MAX, where pale MToon skin starts to clip.
 */
export const EXPOSURE = { min: 0.6, knee: 1.35, max: 1.8 } as const;

const norm = (v: RGB): RGB => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
/**
 * How much a light from `dir` brightens a face looking at +z. MToon wraps
 * light far round the form (measured on a VRoid-style MToon model: a light
 * from behind still gives 87% of a frontal light's face brightness), so even
 * back light counts for most of its strength.
 */
export const frontness = (dir: RGB) => 0.8 + 0.2 * Math.max(0, norm(dir)[2]);

const ambLum = (a: RigSpec['ambient']) => (luminance(a.sky) * 0.6 + luminance(a.ground) * 0.4) / Math.PI;

/**
 * Light reaching the avatar's face from the front. Directional lights are
 * created at intensity × π (so 0.9 here is the flat-background key) and the
 * ambient at intensity × 1, which three.js divides by π in the diffuse BRDF.
 */
export function frontExposure(r: RigSpec): number {
  return (
    r.key.intensity * luminance(r.key.color) * frontness(r.key.dir) +
    r.fill.intensity * luminance(r.fill.color) * frontness(r.fill.dir) +
    r.rim.intensity * luminance(r.rim.color) * frontness(r.rim.dir) +
    r.ambient.intensity * ambLum(r.ambient)
  );
}

const mul = (c: RGB, t: RGB): RGB => [c[0] * t[0], c[1] * t[1], c[2] * t[2]];

/**
 * The light rig after the look controls: style, intensity and temperature,
 * then held inside the exposure limits so the face neither blows out nor
 * goes black.
 */
export function resolveRig(base: RigSpec, look: Pick<EnvLook, 'intensity' | 'temperature' | 'style'>): RigSpec {
  const [gk, gf, gr, ga] = STYLE_GAINS[look.style];
  const tint = temperatureTint(look.temperature);
  const i = look.intensity;
  const r: RigSpec = {
    key: { ...base.key, color: mul(base.key.color, tint), intensity: base.key.intensity * gk * i },
    fill: { ...base.fill, color: mul(base.fill.color, tint), intensity: base.fill.intensity * gf * i },
    rim: { ...base.rim, color: mul(base.rim.color, tint), intensity: base.rim.intensity * gr * i },
    ambient: {
      sky: mul(base.ambient.sky, tint),
      ground: mul(base.ambient.ground, tint),
      intensity: base.ambient.intensity * ga * i,
    },
  };
  const e = frontExposure(r);
  if (e > EXPOSURE.knee) {
    // Soft knee: compress everything so the total approaches MAX but never passes it.
    const span = EXPOSURE.max - EXPOSURE.knee;
    const target = EXPOSURE.knee + span * (1 - Math.exp(-(e - EXPOSURE.knee) / span));
    const s = target / e;
    r.key.intensity *= s;
    r.fill.intensity *= s;
    r.rim.intensity *= s;
    r.ambient.intensity *= s;
  } else if (e < EXPOSURE.min) {
    // Lift the ambient so the face never goes black.
    r.ambient.intensity += (EXPOSURE.min - e) / Math.max(0.02, ambLum(r.ambient));
  }
  return r;
}

/** Fog density from the scene default and the 0–1 amount (0.5 = default, 1 = 3×). */
export function fogDensity(base: number, amount: number): number {
  if (amount <= 0) return 0;
  return amount <= 0.5 ? base * (amount / 0.5) : base * (1 + 4 * (amount - 0.5));
}

/** Idle camera sway offset (metres, radians) at time t seconds: slow, incommensurate sines. */
export function swayOffset(t: number): { x: number; y: number; yaw: number } {
  return {
    x: 0.012 * Math.sin(t * 0.31) + 0.005 * Math.sin(t * 0.83 + 1.3),
    y: 0.006 * Math.sin(t * 0.43 + 0.7),
    yaw: 0.004 * Math.sin(t * 0.27 + 2.1),
  };
}
