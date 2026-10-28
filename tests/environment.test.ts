import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOOK,
  ENV_PRESETS,
  EXPOSURE,
  defaultEnvironmentSettings,
  envKey,
  fogDensity,
  frontExposure,
  hexToLinear,
  kelvinToLinear,
  luminance,
  resolveLook,
  resolvePlacement,
  resolveRig,
  sanitizeEnvironment,
  swayOffset,
  temperatureTint,
  type EnvironmentSettings,
  type LightStyle,
} from '../src/scene/environment/look';
import { CUSTOM_RIG, PRESET_RIGS } from '../src/scene/environment/rigs';
import { coveProfile, fbm, profileSheet, valueNoise } from '../src/scene/environment/parts';
import { defaultSettings } from '../src/app/settings';

const STYLES: LightStyle[] = ['scene', 'key', 'rim', 'soft'];
const RIGS = { ...PRESET_RIGS, custom: CUSTOM_RIG };

describe('environment settings', () => {
  it('fills a partial or broken look with in-range defaults', () => {
    expect(resolveLook(undefined)).toEqual(DEFAULT_LOOK);
    const l = resolveLook({ intensity: 99, temperature: -5, fog: Number.NaN, style: 'disco' as LightStyle, floor: 0.3 });
    expect(l.intensity).toBe(2);
    expect(l.temperature).toBe(2000);
    expect(l.fog).toBe(DEFAULT_LOOK.fog);
    expect(l.style).toBe('scene');
    expect(l.floor).toBe(0.3);
    expect(l.dof).toBe(false); // depth of field is off by default
  });

  it('clamps custom placement', () => {
    expect(resolvePlacement({ scale: 0, x: 1e6, rotY: 270 })).toEqual({ scale: 0.01, x: 50, y: 0, z: 0, rotY: 180 });
  });

  it('keys looks per preset and per custom scene', () => {
    expect(envKey('moor', '/a/b.glb')).toBe('moor');
    expect(envKey('custom', '/a/b.glb')).toBe('custom:/a/b.glb');
    expect(envKey('custom', null)).toBe('custom:');
  });

  it('repairs a saved block with an unknown environment or quality', () => {
    const bad = { id: 'mars', quality: 'ultra', looks: null, placements: 3, custom: null } as unknown as EnvironmentSettings;
    expect(sanitizeEnvironment(bad)).toEqual(defaultEnvironmentSettings());
  });

  it('is part of the default settings, off by default', () => {
    const s = defaultSettings();
    expect(s.environment).toEqual(defaultEnvironmentSettings());
    expect(s.background.kind).not.toBe('environment');
  });
});

describe('colour temperature', () => {
  it('is neutral at 6500 K', () => {
    const t = temperatureTint(6500);
    for (const c of t) expect(c).toBeCloseTo(1, 5);
  });

  it('keeps luminance at 1 so temperature never changes brightness', () => {
    for (let k = 2000; k <= 12000; k += 500) expect(luminance(temperatureTint(k))).toBeCloseTo(1, 6);
  });

  it('is warm below 6500 K and cool above', () => {
    const warm = temperatureTint(3000);
    const cool = temperatureTint(10000);
    expect(warm[0]).toBeGreaterThan(warm[2]);
    expect(cool[2]).toBeGreaterThan(cool[0]);
    // Red/blue ratio falls steadily with temperature.
    let prev = Infinity;
    for (let k = 1000; k <= 12000; k += 250) {
      const c = kelvinToLinear(k);
      const r = c[0] / Math.max(1e-6, c[2]);
      expect(r).toBeLessThanOrEqual(prev + 1e-9);
      prev = r;
    }
  });

  it('decodes sRGB hex to linear', () => {
    expect(hexToLinear(0xffffff)).toEqual([1, 1, 1]);
    expect(hexToLinear(0x000000)).toEqual([0, 0, 0]);
    expect(hexToLinear(0x808080)[0]).toBeCloseTo(0.2158, 3);
  });
});

describe('light rig exposure (face neither blown out nor black)', () => {
  it('every built-in rig sits near the flat-background exposure (1.44) at default settings', () => {
    for (const [id, rig] of Object.entries(RIGS)) {
      const e = frontExposure(resolveRig(rig, DEFAULT_LOOK));
      expect(e, id).toBeGreaterThan(0.85);
      expect(e, id).toBeLessThan(1.6);
    }
  });

  it('stays inside the limits for every scene, style, intensity and temperature', () => {
    for (const [id, rig] of Object.entries(RIGS)) {
      for (const style of STYLES) {
        for (const intensity of [0.25, 0.5, 1, 1.5, 2]) {
          for (const temperature of [2000, 4000, 6500, 9000, 12000]) {
            const e = frontExposure(resolveRig(rig, { style, intensity, temperature }));
            expect(e, `${id} ${style} ${intensity} ${temperature}`).toBeGreaterThanOrEqual(EXPOSURE.min - 1e-6);
            expect(e, `${id} ${style} ${intensity} ${temperature}`).toBeLessThanOrEqual(EXPOSURE.max + 1e-6);
          }
        }
      }
    }
  });

  it('gets brighter (never darker) as INTENSITY goes up', () => {
    for (const rig of Object.values(RIGS)) {
      for (const style of STYLES) {
        let prev = 0;
        for (let i = 0.25; i <= 2.001; i += 0.05) {
          const e = frontExposure(resolveRig(rig, { style, intensity: i, temperature: 6500 }));
          expect(e).toBeGreaterThanOrEqual(prev - 1e-9);
          prev = e;
        }
      }
    }
  });

  it('does not mutate the preset rig', () => {
    const before = JSON.stringify(PRESET_RIGS.moor);
    resolveRig(PRESET_RIGS.moor, { style: 'rim', intensity: 2, temperature: 3000 });
    expect(JSON.stringify(PRESET_RIGS.moor)).toBe(before);
  });

  it('has a rig for every preset', () => {
    for (const id of ENV_PRESETS) expect(PRESET_RIGS[id]).toBeDefined();
  });
});

describe('atmosphere and camera', () => {
  it('maps the fog slider: 0 off, 0.5 scene default, 1 triple', () => {
    expect(fogDensity(0.04, 0)).toBe(0);
    expect(fogDensity(0.04, 0.5)).toBeCloseTo(0.04);
    expect(fogDensity(0.04, 1)).toBeCloseTo(0.12);
    expect(fogDensity(0.04, 0.25)).toBeCloseTo(0.02);
  });

  it('keeps the idle sway subtle (under 2 cm and half a degree)', () => {
    for (let t = 0; t < 120; t += 0.37) {
      const o = swayOffset(t);
      expect(Math.hypot(o.x, o.y)).toBeLessThan(0.02);
      expect(Math.abs(o.yaw)).toBeLessThan((0.5 * Math.PI) / 180);
    }
  });
});

describe('procedural parts', () => {
  it('value noise is in [0, 1] and tiles with its period', () => {
    for (let i = 0; i < 200; i++) {
      const x = i * 0.37;
      const y = i * 0.61;
      const n = fbm(x, y, 4, 3);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(1);
      expect(valueNoise(x, y, 5, 8)).toBeCloseTo(valueNoise(x + 8, y + 8, 5, 8), 9);
    }
  });

  it('builds a cyclorama with the floor facing up and the wall facing the camera', () => {
    const prof = coveProfile(5, -3, 2, 8);
    expect(prof[0]).toEqual([0, 5]);
    expect(prof[prof.length - 1]).toEqual([8, -3]);
    const g = profileSheet(prof, 4, 1);
    const n = g.getAttribute('normal');
    expect(n.getY(0)).toBeCloseTo(1, 3); // first row: floor
    expect(n.getZ(n.count - 1)).toBeCloseTo(1, 3); // last row: back wall
  });
});
