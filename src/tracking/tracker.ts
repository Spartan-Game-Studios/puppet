/**
 * Main-thread side of tracking: pulls frames from a <video> and ships them to
 * two workers, 'face' and 'body', which run in parallel. Each pipeline has at
 * most one frame in flight and is capped at `maxFps`. Results go to
 * `onResult` as they arrive (face and body independently). Falls back to
 * running MediaPipe on the main thread if workers can't start.
 */
import type { BodyMode, FromWorker, Pipeline, TrackerResult } from './protocol';
import { createLandmarkers, detect, type LandmarkerSet } from './landmarkers';

export interface PipelineStats {
  fps: number;
  /** Frame grab -> result available, ms (smoothed). */
  latency: number;
  /** Inference time inside the worker, ms (smoothed). */
  infer: number;
}

export interface TrackerStats {
  face: PipelineStats;
  body: PipelineStats & { pose: number; hands: number };
  delegate: string;
  where: 'worker' | 'main' | 'none';
}

export interface TrackerOptions {
  mode: BodyMode;
  maxFps: number;
  poseModel: 'lite' | 'full';
  wantFaceLandmarks: boolean;
}

const assetBase = () => new URL(import.meta.env.BASE_URL + 'mediapipe/', location.href).href.replace(/\/$/, '');

interface Lane {
  pipeline: Pipeline;
  worker: Worker | null;
  busy: boolean;
  sentAt: number;
  sentVideoTime: number;
  lastSend: number;
  times: number[];
}

export class Tracker {
  opts: TrackerOptions;
  stats: TrackerStats = {
    face: { fps: 0, latency: 0, infer: 0 },
    body: { fps: 0, latency: 0, infer: 0, pose: 0, hands: 0 },
    delegate: '-',
    where: 'none',
  };
  onResult: (r: TrackerResult) => void = () => {};
  onStatus: (s: string) => void = () => {};

  private lanes: Record<Pipeline, Lane> = {
    face: { pipeline: 'face', worker: null, busy: false, sentAt: 0, sentVideoTime: 0, lastSend: 0, times: [] },
    body: { pipeline: 'body', worker: null, busy: false, sentAt: 0, sentVideoTime: 0, lastSend: 0, times: [] },
  };
  private main: LandmarkerSet | null = null;
  private video: HTMLVideoElement | null = null;
  private lastT = 0;
  private raf = 0;
  private running = false;

  constructor(opts: TrackerOptions) {
    this.opts = { ...opts };
  }

  async init(): Promise<void> {
    const base = assetBase();
    const wasmBase = `${base}/wasm`;
    const modelBase = `${base}/models`;
    const forceMain = new URLSearchParams(location.search).get('tracker') === 'main';
    this.onStatus('LOADING MODELS');
    if (!forceMain) {
      try {
        const delegates = await Promise.all(
          (['face', 'body'] as Pipeline[]).map((p) => this.initWorker(p, wasmBase, modelBase)),
        );
        this.stats.delegate = delegates.join('+');
        this.stats.where = 'worker';
        return;
      } catch (e) {
        console.warn('[tracker] workers failed, using main thread:', e);
        for (const l of Object.values(this.lanes)) {
          l.worker?.terminate();
          l.worker = null;
        }
      }
    }
    try {
      this.main = await createLandmarkers(['face', 'body'], wasmBase, modelBase, 'GPU', this.opts.poseModel);
    } catch {
      this.main = await createLandmarkers(['face', 'body'], wasmBase, modelBase, 'CPU', this.opts.poseModel);
    }
    this.stats.delegate = this.main.delegate;
    this.stats.where = 'main';
  }

  private initWorker(pipeline: Pipeline, wasmBase: string, modelBase: string): Promise<string> {
    const w = new Worker(new URL('./tracker.worker.ts', import.meta.url), { type: 'module' });
    this.lanes[pipeline].worker = w;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${pipeline} worker init timeout`)), 90000);
      w.onerror = (e) => {
        clearTimeout(timer);
        reject(new Error(e.message || 'worker error'));
      };
      w.onmessage = (ev: MessageEvent<FromWorker>) => {
        const m = ev.data;
        if (m.type === 'ready') {
          clearTimeout(timer);
          w.onmessage = (e2: MessageEvent<FromWorker>) => this.handle(pipeline, e2.data);
          resolve(m.delegate);
        } else if (m.type === 'error') {
          clearTimeout(timer);
          reject(new Error(m.message));
        }
      };
      w.postMessage({ type: 'init', pipeline, wasmBase, modelBase, delegate: 'GPU', poseModel: this.opts.poseModel });
    });
  }

  private handle(pipeline: Pipeline, m: FromWorker): void {
    const lane = this.lanes[pipeline];
    if (m.type === 'result') {
      lane.busy = false;
      m.videoTime = lane.sentVideoTime;
      this.account(lane, m);
      this.onResult(m);
    } else if (m.type === 'error') {
      lane.busy = false;
      if (m.fatal) this.onStatus(`TRACKER ERROR: ${m.message}`);
    }
  }

  private account(lane: Lane, r: TrackerResult): void {
    const now = performance.now();
    const k = 0.1;
    const s = lane.pipeline === 'face' ? this.stats.face : this.stats.body;
    s.latency += k * (now - lane.sentAt - s.latency);
    s.infer += k * (r.timings.total - s.infer);
    if (lane.pipeline === 'body') {
      this.stats.body.pose += k * (r.timings.pose - this.stats.body.pose);
      this.stats.body.hands += k * (r.timings.hands - this.stats.body.hands);
    }
    lane.times.push(now);
    while (lane.times.length && lane.times[0] < now - 1000) lane.times.shift();
    s.fps = lane.times.length;
  }

  start(video: HTMLVideoElement): void {
    this.video = video;
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      this.pump();
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  private pump(): void {
    const v = this.video;
    if (!v || v.readyState < 2 || v.videoWidth === 0) return;
    const now = performance.now();
    const interval = 1000 / this.opts.maxFps - 2;
    const want = (['face', 'body'] as Pipeline[]).filter((p) => {
      const l = this.lanes[p];
      if (p === 'body' && this.opts.mode === 'face') return false;
      return !l.busy && now - l.lastSend >= interval;
    });
    if (!want.length) return;
    // MediaPipe VIDEO mode needs strictly increasing timestamps.
    const t = Math.max(this.lastT + 1, Math.round(now));
    this.lastT = t;
    for (const p of want) {
      const l = this.lanes[p];
      l.lastSend = now;
      l.sentAt = now;
      l.sentVideoTime = v.currentTime;
    }
    if (this.lanes.face.worker) {
      for (const p of want) {
        const l = this.lanes[p];
        l.busy = true;
        createImageBitmap(v)
          .then((image) =>
            l.worker!.postMessage(
              { type: 'frame', image, t, mode: this.opts.mode, wantFaceLandmarks: this.opts.wantFaceLandmarks },
              [image],
            ),
          )
          .catch(() => (l.busy = false));
      }
    } else if (this.main) {
      for (const p of want) {
        const r = detect(this.main, p, v, t, this.opts.mode, this.opts.wantFaceLandmarks);
        const res: TrackerResult = { type: 'result', ...r, videoTime: this.lanes[p].sentVideoTime };
        this.account(this.lanes[p], res);
        this.onResult(res);
      }
    }
  }
}
