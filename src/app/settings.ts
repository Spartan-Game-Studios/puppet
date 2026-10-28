/** Persisted settings: one JSON document in the app config dir (or localStorage in a browser). */
import { defaultGainCurves, type GainCurve } from '../core/blendshapes';
import { DEFAULT_PHYSICS, type PhysicsOverrides, type PhysicsSettings } from '../physics/stableSprings';
import { EMPTY_CALIBRATION, type Calibration } from '../tracking/faceProcessor';
import type { BodyMode } from '../tracking/protocol';
import type { VcamResolution } from '../vcam/frame';
import { defaultEnvironmentSettings, sanitizeEnvironment, type EnvironmentSettings } from '../scene/environment/look';
import { loadSettingsRaw, saveSettingsRaw } from './platform';

export type Resolution = '640x480' | '1280x720' | '1920x1080';
export type BackgroundKind = 'color' | 'transparent' | 'image' | 'environment';

export interface Settings {
  version: 1;
  lastModelPath: string | null;
  cameraId: string | null;
  resolution: Resolution;
  trackFps: number;
  mode: BodyMode;
  poseModel: 'lite' | 'full';
  mirror: boolean;
  preview: boolean;
  smoothing: number;
  gazeGain: number;
  emotions: boolean;
  gains: Record<string, GainCurve>;
  calibration: Calibration;
  background: { kind: BackgroundKind; color: string; imagePath: string | null };
  vmc: { enabled: boolean; host: string; port: number };
  /** Virtual camera output (06 VIRTUAL CAM). `device`: Linux /dev/videoN, null = first found. */
  vcam: { enabled: boolean; resolution: VcamResolution; device: string | null };
  physics: PhysicsSettings;
  /** Per-model physics overrides, keyed by the model file's SHA-256. */
  physicsOverrides: Record<string, PhysicsOverrides>;
  /** 3D environment (background kind 'environment'): scene, quality, per-scene look. */
  environment: EnvironmentSettings;
  ui: { tab: 'face' | 'physics'; debug: boolean };
}

export function defaultSettings(): Settings {
  return {
    version: 1,
    lastModelPath: null,
    cameraId: null,
    resolution: '1280x720',
    trackFps: 30,
    mode: 'upper',
    poseModel: 'lite',
    mirror: true,
    preview: true,
    smoothing: 0.5,
    gazeGain: 1,
    emotions: true,
    gains: defaultGainCurves(),
    calibration: structuredClone(EMPTY_CALIBRATION),
    background: { kind: 'color', color: '#00ff00', imagePath: null },
    vmc: { enabled: false, host: '127.0.0.1', port: 39539 },
    vcam: { enabled: false, resolution: '1280x720', device: null },
    physics: { ...DEFAULT_PHYSICS },
    physicsOverrides: {},
    environment: defaultEnvironmentSettings(),
    ui: { tab: 'face', debug: true },
  };
}

/** Deep-merge saved values over defaults so new fields always exist. */
function merge<T>(base: T, over: unknown): T {
  if (over === null || typeof over !== 'object' || Array.isArray(over) || base === null || typeof base !== 'object') {
    return (over === undefined ? base : (over as T));
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    const b = (base as Record<string, unknown>)[k];
    out[k] = b !== undefined && b !== null && typeof b === 'object' && !Array.isArray(b) ? merge(b, v) : v;
  }
  return out as T;
}

export async function loadSettings(): Promise<Settings> {
  const d = defaultSettings();
  try {
    const raw = await loadSettingsRaw();
    if (!raw) return d;
    const s = merge(d, JSON.parse(raw));
    sanitizeEnvironment(s.environment);
    return s;
  } catch (e) {
    console.warn('[settings] unreadable, using defaults', e);
    return d;
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;

/** Debounced save. */
export function saveSettings(s: Settings): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    saveSettingsRaw(JSON.stringify(s)).catch((e) => console.warn('[settings] save failed', e));
  }, 300);
}
