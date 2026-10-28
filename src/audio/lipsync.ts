/**
 * Mic lip sync onto the avatar's mouth.
 *
 * Modes:
 *  - off
 *  - fallback: audio drives the mouth only while face tracking is lost
 *    (eased in and out, so the hand-over doesn't pop)
 *  - blend: the larger of tracked and audio, per shape
 *  - audio: audio only (the tracked mouth shapes are replaced)
 *
 * Preset models get the visemes aa/ih/ou/ee/oh; perfect-sync models get
 * jawOpen, mouthFunnel, mouthPucker and mouthStretch through their ARKit
 * expressions.
 */
import type { Avatar } from '../scene/avatar';
import { MicInput } from './mic';
import { VISEMES, type MouthShapes } from './visemes';

export type LipSyncMode = 'off' | 'fallback' | 'blend' | 'audio';
export const LIPSYNC_MODES: LipSyncMode[] = ['off', 'fallback', 'blend', 'audio'];

export interface LipSyncSettings {
  mode: LipSyncMode;
  deviceId: string | null;
  gateDb: number;
  gain: number;
}
export const DEFAULT_LIPSYNC: LipSyncSettings = { mode: 'off', deviceId: null, gateDb: -50, gain: 1.2 };

const ARKIT_MOUTH = ['jawOpen', 'mouthFunnel', 'mouthPucker', 'mouthStretchLeft', 'mouthStretchRight'] as const;

/** Combine one tracked value with an audio value. `w` = how much audio owns it (fallback hand-over). */
export function mixMouth(mode: LipSyncMode, tracked: number, audio: number, w: number): number {
  if (mode === 'off') return tracked;
  if (mode === 'blend') return Math.max(tracked, audio);
  if (mode === 'audio') return audio;
  return tracked + (audio - tracked) * w;
}

export class LipSync {
  readonly mic = new MicInput();
  mode: LipSyncMode = 'off';
  /** Fallback hand-over weight (0 = tracked, 1 = audio). */
  private w = 0;
  shapes: MouthShapes | null = null;

  /** Call once per frame before apply(). */
  update(dt: number, faceTracked: boolean): void {
    this.shapes = this.mic.running ? this.mic.read(dt) : null;
    const want = this.mode === 'fallback' ? (faceTracked ? 0 : 1) : 1;
    const k = 1 - Math.exp(-dt / 0.15);
    this.w += (want - this.w) * k;
  }

  apply(values: Map<string, number>, avatar: Avatar): void {
    const s = this.shapes;
    if (this.mode === 'off' || !s) return;
    if (this.mode === 'fallback' && this.w < 1e-3) return;
    if (avatar.usePerfectSync) {
      for (const a of ARKIT_MOUTH) {
        const name = avatar.perfectSync.get(a);
        if (!name) continue;
        values.set(name, mixMouth(this.mode, values.get(name) ?? 0, s.arkit[a], this.w));
      }
    } else {
      for (const v of VISEMES) {
        if (!avatar.presets.has(v)) continue;
        values.set(v, mixMouth(this.mode, values.get(v) ?? 0, s.visemes[v], this.w));
      }
    }
  }
}
