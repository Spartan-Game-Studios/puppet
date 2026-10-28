/**
 * Replays tracker results captured from a real run of the app
 * (scripts/track-clip.mjs with PUPPET_RAW) through the app's body path:
 * hands merge, pose filter, solver, avatar follow, in virtual time at 60 fps.
 * The same input every time, so pipeline changes can be compared without the
 * run-to-run noise of playing the clip. Driven by scripts/track-replay.mjs:
 * window.__replay.run(log, options).
 */
import { limbFollowRateFor, loadAvatar } from '../src/scene/avatar';
import { DEFAULT_PHYSICS } from '../src/physics/stableSprings';
import { PoseFilter } from '../src/core/poseFilter';
import { smoothingToParams, type OneEuroParams } from '../src/core/oneEuro';
import { GestureTracker } from '../src/core/gestures';
import type { SolveOptions } from '../src/core/bodySolver';
import { HandsMerge } from '../src/tracking/handsMerge';
import type { TrackerResult } from '../src/tracking/protocol';

export interface RawEvent {
  /** performance.now() when the result reached the main thread. */
  now: number;
  pipeline: 'body' | 'hands';
  m: TrackerResult;
}

export interface ReplayOptions {
  /** App smoothing setting, 0..1. */
  smoothing?: number;
  /** Hands on arrival (default) or only with the next pose. */
  handsOnArrival?: boolean;
  /** Override the pose filter's parameters. */
  pose?: OneEuroParams;
  /** Avatar drive overrides (followRate, ...). */
  drive?: Record<string, number>;
  /** Solver option overrides (not mirror, hands or smoothing, which follow the drive). */
  solve?: Partial<SolveOptions>;
  /** Render rate, Hz. */
  fps?: number;
}

async function main() {
  const buf = await (await fetch('/__local/model.vrm')).arrayBuffer();
  (window as unknown as { __replay: unknown }).__replay = {
    async run(log: RawEvent[], o: ReplayOptions = {}) {
      const { avatar } = await loadAvatar(buf, { ...DEFAULT_PHYSICS });
      const smoothing = o.smoothing ?? 0.5;
      avatar.drive.mode = 'hands';
      avatar.drive.mirror = false;
      avatar.drive.smoothing = smoothing;
      avatar.drive.limbFollowRate = limbFollowRateFor(smoothing);
      Object.assign(avatar.drive, o.drive ?? {});
      Object.assign(avatar.solver.opts, o.solve ?? {});
      const poseFilter = new PoseFilter();
      poseFilter.setParams(o.pose ?? smoothingToParams(smoothing * 0.8));
      const merge = new HandsMerge();
      merge.applyOnArrival = o.handsOnArrival ?? true;
      const gestures = new GestureTracker();
      gestures.mirror = false;
      const rec: unknown[] = [];
      const apply = (r: TrackerResult) => {
        if (r.pose) {
          const pose = (r.handsUpdate && poseFilter.last) || poseFilter.filter(r.pose, r.t / 1000);
          avatar.setBody({ poseWorld: pose.world, poseImage: pose.image, hands: r.hands ?? [], aspect: r.width / r.height });
        }
        gestures.update(r.hands ?? [], r.t);
        if (!r.handsUpdate) {
          rec.push({ body: true, vt: r.videoTime, hands: (r.hands ?? []).map((h) => h.userSide ?? h.handedness), handsRan: !!r.handsRan, rig: avatar.probe(), gestures: { ...gestures.current } });
        }
      };
      const events = [...log].sort((a, b) => a.now - b.now);
      const step = 1000 / (o.fps ?? 60);
      let clock = events[0]?.now ?? 0;
      let i = 0;
      while (i < events.length) {
        clock += step;
        for (; i < events.length && events[i].now <= clock; i++) {
          const e = events[i];
          const m = structuredClone(e.m);
          if (e.pipeline === 'hands') {
            const b = merge.onHands(m);
            if (b) apply(b);
          } else apply(merge.onBody(m));
        }
        avatar.update(step / 1000);
      }
      avatar.vrm.scene.clear();
      return rec;
    },
  };
  document.title = 'ready';
}
main().catch((e) => {
  document.title = 'error';
  console.error(e);
});
