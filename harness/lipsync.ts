/**
 * Lip sync harness (dev only): a VRM with the AnimLayer and LipSync on the
 * microphone. Run Chrome with a fake capture device fed from a WAV file
 * (scripts/lipsync-test.mjs) and this page records, per frame, the analysis
 * and the expression values the model actually received.
 */
import { loadAvatar, type Avatar } from '../src/scene/avatar';
import { DEFAULT_PHYSICS } from '../src/physics/stableSprings';
import { ClipLibrary } from '../src/anim/library';
import { AnimLayer } from '../src/anim/player';
import { LipSync, type LipSyncMode } from '../src/audio/lipsync';

let avatar: Avatar | null = null;
const lipsync = new LipSync();

async function start(url: string, mode: LipSyncMode) {
  const buf = await (await fetch(url)).arrayBuffer();
  const { avatar: a } = await loadAvatar(buf, { ...DEFAULT_PHYSICS, mode: 'off' });
  a.drive.mode = 'face';
  const layer = new AnimLayer(a, new ClipLibrary(), { idle: null, idleInFaceMode: false, fadeIn: 0.3, fadeOut: 0.45 });
  layer.lipsync = lipsync;
  a.layer = layer;
  avatar = a;
  lipsync.mode = mode;
  await lipsync.mic.start(null);
  return { perfectSync: a.usePerfectSync, presets: [...a.presets], label: lipsync.mic.label };
}

/** Record `seconds` of real time, one sample per animation frame. */
async function record(seconds: number) {
  const a = avatar!;
  const out: Array<{ t: number; db: number; f1: number; f2: number; vis: Record<string, number>; expr: Record<string, number> }> = [];
  const t0 = performance.now();
  let last = t0;
  await new Promise<void>((resolve) => {
    const step = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      a.update(dt);
      const s = lipsync.shapes;
      const expr: Record<string, number> = {};
      for (const [k, v] of a.expressionValues) if (v > 0.005) expr[k] = +v.toFixed(3);
      out.push({ t: (now - t0) / 1000, db: lipsync.mic.raw.db, f1: lipsync.mic.raw.f1, f2: lipsync.mic.raw.f2, vis: { ...(s?.visemes ?? {}) }, expr });
      if (now - t0 < seconds * 1000) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
  return out;
}

(window as unknown as Record<string, unknown>).__lipsync = { start, record };
(window as unknown as Record<string, unknown>).__lipsyncReady = true;
