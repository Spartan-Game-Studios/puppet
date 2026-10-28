/**
 * VRM 0.x preset clips for VMC output, for every model.
 *
 * Receivers that only understand the presets (most VSeeFace-style setups)
 * see a frozen face from a perfect-sync avatar, because Puppet drives its 52
 * ARKit expressions and none of the presets. So alongside the ARKit values
 * the frame also carries the 13 preset clips (Blink, Blink_L, Blink_R, A, I,
 * U, E, O, Joy, Angry, Sorrow, Fun, Surprised):
 *   - derived from the frame's ARKit values (the same mapping preset-only
 *     models use, see derivePresets), and
 *   - combined (max) with the model's own preset values when it has and
 *     drives them (a preset model, or a hotkey expression).
 * The ARKit values are kept as they are. Pure.
 */
import { ARKIT_NAMES, derivePresets, normName, VRM0_PRESET_NAMES, VRM_PRESETS, type PresetOptions, type VrmPreset } from '../core/blendshapes';

const ARKIT_BY_NORM = new Map<string, string>(ARKIT_NAMES.map((a) => [normName(a), a]));
const PRESET_BY_VMC = new Map<string, VrmPreset>(VRM_PRESETS.map((p) => [VRM0_PRESET_NAMES[p], p]));

export const DEFAULT_VMC_PRESET_OPTIONS: PresetOptions = { emotions: true, emotionDeadzone: 0.25 };

/**
 * The 13 preset values for one frame. `blends` are the frame's blend shapes as
 * sent (VMC names: presets already under their VRM 0.x clip names, ARKit
 * names as the model spells them).
 */
export function derivePresetBlends(blends: ReadonlyArray<readonly [string, number]>, opts: PresetOptions = DEFAULT_VMC_PRESET_OPTIONS): Array<[string, number]> {
  const arkit: Record<string, number> = {};
  const own = new Map<VrmPreset, number>();
  let arkitCount = 0;
  for (const [name, v] of blends) {
    const p = PRESET_BY_VMC.get(name);
    if (p) {
      own.set(p, Math.max(own.get(p) ?? 0, v));
      continue;
    }
    const a = ARKIT_BY_NORM.get(normName(name));
    if (a) {
      arkit[a] = v;
      arkitCount++;
    }
  }
  const derived = arkitCount ? derivePresets(arkit, opts) : null;
  return VRM_PRESETS.map((p) => {
    const v = Math.max(own.get(p) ?? 0, derived ? derived[p] : 0);
    return [VRM0_PRESET_NAMES[p], v < 0 ? 0 : v > 1 ? 1 : v];
  });
}

/** The frame's blends with the 13 presets set (replacing any the frame already had). */
export function withPresetBlends(blends: Array<[string, number]>, opts?: PresetOptions): Array<[string, number]> {
  const presets = derivePresetBlends(blends, opts);
  const out = blends.filter(([n]) => !PRESET_BY_VMC.has(n));
  out.push(...presets);
  return out;
}
