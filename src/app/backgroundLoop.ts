/**
 * Keep the app running while its window is hidden, minimized or fully
 * covered.
 *
 * WebKit stops requestAnimationFrame for a page it considers not visible
 * (minimized, hidden with Cmd-H, off every screen, or covered by other
 * windows), whatever the webview's background-throttling policy. Everything
 * in Puppet hangs off rAF: the render loop (src/main.ts `tick`), the tracker's
 * frame pump (src/tracking/tracker.ts) and with them the virtual camera and
 * VMC output. So the feed froze as soon as the user minimized Puppet.
 *
 * `installBackgroundLoop` wraps window.requestAnimationFrame: every callback is
 * still requested from the real rAF, and a dedicated Worker ticks at the
 * display rate; on a tick where the real rAF has not fired for a while
 * (STALL_MS), the pending callbacks run from the worker tick instead. Whichever
 * fires first wins, so in the foreground nothing changes (the worker tick sees
 * fresh rAF and does nothing), and in the background the loops keep going at
 * the fallback rate. A Worker timer is used because timers on a hidden page's
 * main thread may be clamped; worker timers and messages are not.
 *
 * No DOM dependency beyond `window`/`Worker`, so the scheduling core
 * (`FrameScheduler`) is unit tested in tests/backgroundLoop.test.ts.
 */

export type FrameCallback = (now: number) => void;

/** Run pending callbacks from the fallback tick when real rAF has been silent this long. */
export const STALL_MS = 100;

/**
 * The scheduling core: a table of pending callbacks that can be flushed by
 * either the real rAF or the fallback tick, exactly once each.
 */
export class FrameScheduler {
  private pending = new Map<number, FrameCallback>();
  private nextId = 1;
  /** performance.now() of the last real rAF delivery. */
  lastNative = -Infinity;
  /** Frames run from the fallback tick (for stats / tests). */
  fallbackFrames = 0;

  constructor(private readonly stallMs = STALL_MS) {}

  add(cb: FrameCallback): number {
    const id = this.nextId++;
    this.pending.set(id, cb);
    return id;
  }

  cancel(id: number): void {
    this.pending.delete(id);
  }

  has(id: number): boolean {
    return this.pending.has(id);
  }

  get size(): number {
    return this.pending.size;
  }

  /** Real rAF fired for request `id`. */
  native(id: number, now: number): void {
    this.lastNative = now;
    const cb = this.pending.get(id);
    if (!cb) return; // already run by a fallback tick, or cancelled
    this.pending.delete(id);
    cb(now);
  }

  /** True when rAF looks stopped (page hidden / occluded). */
  stalled(now: number): boolean {
    return now - this.lastNative > this.stallMs;
  }

  /**
   * Fallback tick: if rAF is stalled (or `force`), run everything pending now,
   * like one display frame. Callbacks requested while flushing wait for the
   * next frame, as with rAF. Returns the number of callbacks run.
   */
  tick(now: number, force = false): number {
    if (!this.pending.size || (!force && !this.stalled(now))) return 0;
    const batch = [...this.pending];
    this.pending.clear();
    for (const [, cb] of batch) {
      try {
        cb(now);
      } catch (e) {
        // One broken loop must not stop the others (rAF behaves the same).
        setTimeout(() => {
          throw e;
        });
      }
    }
    this.fallbackFrames++;
    return batch.length;
  }
}

const WORKER_SRC = `let t = null;
onmessage = (e) => {
  clearInterval(t);
  if (e.data > 0) t = setInterval(() => postMessage(0), e.data);
};`;

export interface BackgroundLoop {
  scheduler: FrameScheduler;
  /** True while frames come from the fallback tick. */
  readonly active: boolean;
}

/**
 * Patch window.requestAnimationFrame / cancelAnimationFrame. Call once,
 * before any loop starts. `fps` is the fallback rate.
 */
export function installBackgroundLoop(fps = 60): BackgroundLoop | null {
  if (typeof window === 'undefined' || typeof Worker === 'undefined') return null;
  const nativeRaf = window.requestAnimationFrame.bind(window);
  const nativeCancel = window.cancelAnimationFrame.bind(window);
  const s = new FrameScheduler();
  const native = new Map<number, number>();
  // Seed: if rAF never fires at all (app started hidden), fall back right away.
  s.lastNative = performance.now();

  window.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    const id = s.add(cb);
    native.set(
      id,
      nativeRaf((now) => {
        native.delete(id);
        s.native(id, now);
      }),
    );
    return id;
  };
  window.cancelAnimationFrame = (id: number): void => {
    s.cancel(id);
    const n = native.get(id);
    if (n !== undefined) {
      native.delete(id);
      nativeCancel(n);
    }
  };

  let worker: Worker | null = null;
  try {
    const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
    worker = new Worker(url);
    worker.onmessage = () => {
      const now = performance.now();
      if (s.tick(now)) {
        // The rAF requests made for these callbacks are stale now; drop them.
        for (const [id, n] of native) {
          if (!s.has(id)) {
            nativeCancel(n);
            native.delete(id);
          }
        }
      }
    };
    worker.postMessage(1000 / fps);
  } catch {
    worker = null; // CSP without blob: workers. The foreground still works.
  }
  return {
    scheduler: s,
    get active() {
      return s.stalled(performance.now());
    },
  };
}
