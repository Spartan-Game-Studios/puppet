/**
 * Light rigs of the built-in environments (pure data, unit-tested for
 * exposure). Colours are sRGB hex; tone() makes a unit-luminance linear
 * colour so intensity alone sets the level.
 */
import { hexToLinear, luminance, type EnvPresetId, type RGB, type RigSpec } from './look';

const lin = (hex: number): RGB => hexToLinear(hex);
const tone = (hex: number): RGB => {
  const c = hexToLinear(hex);
  const l = luminance(c);
  return [c[0] / l, c[1] / l, c[2] / l];
};

export const PRESET_RIGS: Record<EnvPresetId, RigSpec> = {
  studio: {
    key: { color: tone(0xfff3e6), intensity: 0.75, dir: [0.55, 0.75, 1] },
    fill: { color: tone(0xe8efff), intensity: 0.3, dir: [-1, 0.3, 0.8] },
    rim: { color: tone(0xffffff), intensity: 0.35, dir: [-0.4, 0.6, -1] },
    ambient: { sky: lin(0xffffff), ground: lin(0xc9c4bb), intensity: 0.5 },
  },
  room: {
    key: { color: tone(0xffd9b0), intensity: 0.7, dir: [-0.6, 0.55, 0.9] },
    fill: { color: tone(0xc8d8ff), intensity: 0.25, dir: [0.8, 0.4, 0.6] },
    rim: { color: tone(0xffc890), intensity: 0.3, dir: [0.3, 0.7, -1] },
    ambient: { sky: lin(0xfff0e0), ground: lin(0x9a7258), intensity: 0.45 },
  },
  moor: {
    key: { color: tone(0xffc39a), intensity: 0.55, dir: [-0.7, 0.35, 0.7] },
    fill: { color: tone(0xa9b6ff), intensity: 0.3, dir: [0.8, 0.5, 0.6] },
    rim: { color: tone(0xff9a55), intensity: 0.55, dir: [-0.55, 0.12, -1] },
    ambient: { sky: lin(0x9a96d8), ground: lin(0x6e5450), intensity: 0.5 },
  },
  forest: {
    key: { color: tone(0xbcccff), intensity: 0.45, dir: [0.6, 0.7, 0.8] },
    fill: { color: tone(0xd8ff9a), intensity: 0.15, dir: [-0.8, 0.2, 0.7] },
    rim: { color: tone(0xc8d6ff), intensity: 0.45, dir: [0.45, 0.5, -1] },
    ambient: { sky: lin(0x6f86c0), ground: lin(0x2c3a26), intensity: 0.5 },
  },
  neon: {
    key: { color: tone(0xffb0dd), intensity: 0.55, dir: [0.7, 0.5, 0.8] },
    fill: { color: tone(0x7fe8ff), intensity: 0.4, dir: [-0.8, 0.3, 0.7] },
    rim: { color: tone(0xff4f9a), intensity: 0.55, dir: [0, 0.4, -1] },
    ambient: { sky: lin(0x9a7bd8), ground: lin(0x5a2a6a), intensity: 0.4 },
  },
  hall: {
    key: { color: tone(0xfff6ea), intensity: 0.7, dir: [0.6, 0.9, 0.7] },
    fill: { color: tone(0xdfe5ee), intensity: 0.3, dir: [-0.8, 0.3, 0.6] },
    rim: { color: tone(0xfff0dc), intensity: 0.4, dir: [0.3, 0.5, -1] },
    ambient: { sky: lin(0xdadcdf), ground: lin(0x828280), intensity: 0.5 },
  },
};

/** Neutral, studio-like rig for custom scenes. */
export const CUSTOM_RIG: RigSpec = {
  key: { color: tone(0xfff6ee), intensity: 0.75, dir: [0.55, 0.75, 1] },
  fill: { color: tone(0xeef3ff), intensity: 0.3, dir: [-1, 0.3, 0.8] },
  rim: { color: tone(0xffffff), intensity: 0.35, dir: [-0.4, 0.6, -1] },
  ambient: { sky: lin(0xffffff), ground: lin(0xb3b3b3), intensity: 0.5 },
};
