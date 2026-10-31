/** Persisted settings: one JSON document in the app config dir (or localStorage in a browser). */
import { DEFAULT_SOURCES, type RegionSources } from '../vmc/vmcInput';
import { defaultGainCurves, type GainCurve } from '../core/blendshapes';
import { DEFAULT_PHYSICS, type PhysicsOverrides, type PhysicsSettings } from '../physics/stableSprings';
import { EMPTY_CALIBRATION, type Calibration } from '../tracking/faceProcessor';
import type { BodyMode } from '../tracking/protocol';
import type { VcamResolution } from '../vcam/frame';
import { defaultEnvironmentSettings, sanitizeEnvironment, type EnvironmentSettings } from '../scene/environment/look';
import { loadSettingsRaw, saveSettingsRaw } from './platform';
import { DEFAULT_ANIM, type AnimSettings } from '../anim/player';
import type { ClipOptions } from '../anim/catalog';
import { defaultBindings, type Binding } from '../input/bindings';
import { DEFAULT_LIPSYNC, type LipSyncSettings } from '../audio/lipsync';

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
  /** `presets`: also send the 13 VRM 0.x preset clips derived from ARKit (src/vmc/presets.ts). */
  vmc: { enabled: boolean; host: string; port: number; presets: boolean };
  /** VMC input (src/vmc/vmcInput.ts): body trackers / iPhone apps, per body region. `lan`: accept other devices. */
  vmcIn: { enabled: boolean; port: number; lan: boolean; regions: RegionSources };
  /** Virtual camera output (06 VIRTUAL CAM). `device`: Linux /dev/videoN, null = first found. */
  vcam: { enabled: boolean; resolution: VcamResolution; device: string | null };
  physics: PhysicsSettings;
  /** Per-model physics overrides, keyed by the model file's SHA-256. */
  physicsOverrides: Record<string, PhysicsOverrides>;
  /** 3D environment (background kind 'environment'): scene, quality, per-scene look. */
  environment: EnvironmentSettings;
  /**
   * `tab`: unused since the FACE / PHYSICS tabs became modals (kept so old files load).
   * `cam`: which camera-card sections are expanded. `preview` (above) = card not minimized.
   */
  ui: { tab: 'face' | 'physics'; debug: boolean; cam: { source: boolean; vcam: boolean } };
  /** 07 MOTION: idle clip and per-clip options (src/anim). */
  anim: AnimSettings & { clipOptions: Record<string, ClipOptions> };
  /** 08 HOTKEYS (src/input). Bindings with `model` set belong to that model. */
  hotkeys: { bindings: Binding[]; global: boolean };
  /** 09 LIP SYNC (src/audio). */
  lipsync: LipSyncSettings;
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
    vmc: { enabled: false, host: '127.0.0.1', port: 39539, presets: true },
    vmcIn: { enabled: false, port: 39539, lan: false, regions: { ...DEFAULT_SOURCES } },
    vcam: { enabled: false, resolution: '1280x720', device: null },
    physics: { ...DEFAULT_PHYSICS },
    physicsOverrides: {},
    environment: defaultEnvironmentSettings(),
    ui: { tab: 'face', debug: true, cam: { source: true, vcam: false } },
    anim: { ...DEFAULT_ANIM, clipOptions: {} },
    hotkeys: { bindings: defaultBindings(), global: false },
    lipsync: { ...DEFAULT_LIPSYNC },
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
