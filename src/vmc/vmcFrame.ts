/**
 * Build a VMC protocol frame from the avatar. Encoding to OSC and the UDP send
 * happen in Rust (src-tauri/src/vmc.rs); this side only gathers values and
 * converts coordinates.
 *
 * VMC speaks Unity: left-handed, +Y up, the avatar faces +Z. three-vrm's
 * normalized rig is right-handed with the avatar facing +Z, so a glTF -> Unity
 * conversion mirrors X: position (x, y, z) -> (-x, y, z), rotation
 * (x, y, z, w) -> (x, -y, -z, w). Bone rotations are the normalized-rig local
 * rotations (identity at T-pose), which is what VMC receivers expect from a
 * normalized VRM.
 */
import { VRM0_PRESET_NAMES, type VrmPreset } from '../core/blendshapes';

/** [px, py, pz, qx, qy, qz, qw] */
export type Transform7 = [number, number, number, number, number, number, number];

export interface VmcFrame {
  /** Seconds since start (/VMC/Ext/T). */
  t: number;
  root: Transform7;
  bones: Array<[string, ...Transform7]>;
  blends: Array<[string, number]>;
}

/** three-vrm (VRM 1.0) humanoid bone name -> Unity HumanBodyBones name. */
export function unityBoneName(vrmName: string): string {
  // VRM 1.0 renamed the thumb chain; Unity keeps the VRM 0.x names.
  const thumb = vrmName.match(/^(left|right)Thumb(Metacarpal|Proximal|Distal)$/);
  if (thumb) {
    const seg = { Metacarpal: 'Proximal', Proximal: 'Intermediate', Distal: 'Distal' }[thumb[2]]!;
    return `${thumb[1] === 'left' ? 'Left' : 'Right'}Thumb${seg}`;
  }
  return vrmName.charAt(0).toUpperCase() + vrmName.slice(1);
}

export function toUnity(p: { x: number; y: number; z: number }, q: { x: number; y: number; z: number; w: number }): Transform7 {
  return [-p.x, p.y, p.z, q.x, -q.y, -q.z, q.w];
}

/** Blend shape name for VMC: VRM presets go out under their VRM 0.x clip names; others pass through. */
export function vmcBlendName(expressionName: string): string {
  return (VRM0_PRESET_NAMES as Record<string, string>)[expressionName as VrmPreset] ?? expressionName;
}
