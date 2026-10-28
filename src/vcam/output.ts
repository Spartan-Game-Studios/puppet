/**
 * Virtual camera output loop: paces grabs at 30 fps off the render loop,
 * triple-buffers frames (up to three in flight between GPU readback and
 * IPC), and ships each as a raw binary body to Rust.
 *
 * If all frames are still busy when the next one is due, that frame
 * is skipped ("busy"), so a slow sink or a GPU hiccup never builds a queue.
 */
import { isTauri, vcamFrame, vcamStart, vcamStop } from '../app/platform';
import type { Viewer } from '../scene/viewer';
import { allocFrame, ema, FramePacer, setSeq, VCAM_FPS, type FrameBuffer } from './frame';
import { FrameGrabber, type GrabTimings } from './grabber';

export interface VcamOutputStats {
  grabbed: number;
  sent: number;
  /** Frames skipped because every buffer was still in flight. */
  busy: number;
  errors: number;
  lastError: string;
  /** EMA, ms: issuing the offscreen render, GPU->JS readback, IPC round trip, whole frame. */
  render: number;
  readback: number;
  ipc: number;
  total: number;
  /** Frames sent over the last second. */
  fps: number;
}

export class VirtualCamOutput {
  readonly grabber: FrameGrabber;
  private pacer = new FramePacer(VCAM_FPS);
  private free: FrameBuffer[] = [];
  private seq = 0;
  private sentTimes: number[] = [];
  running = false;
  /** Copy of the last frame (for tests / the harness); only kept when `keepLast` is set. */
  keepLast = false;
  /** Test hook (?vcamsend=0): grab but skip the IPC, to measure the two apart. */
  send = true;
  lastFrame: Uint8Array | null = null;
  stats: VcamOutputStats = { grabbed: 0, sent: 0, busy: 0, errors: 0, lastError: '', render: 0, readback: 0, ipc: 0, total: 0, fps: 0 };
  onError: ((e: string) => void) | null = null;

  constructor(viewer: Viewer) {
    this.grabber = new FrameGrabber(viewer);
  }

  async start(width: number, height: number): Promise<void> {
    await vcamStart(width, height, VCAM_FPS);
    this.grabber.setSize(width, height);
    this.free = [allocFrame(width, height), allocFrame(width, height), allocFrame(width, height)];
    this.pacer.reset();
    this.stats = { grabbed: 0, sent: 0, busy: 0, errors: 0, lastError: '', render: 0, readback: 0, ipc: 0, total: 0, fps: 0 };
    this.sentTimes = [];
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
    this.free = [];
    this.grabber.dispose();
    await vcamStop();
  }

  setBackground(hex: string): void {
    this.grabber.setBackground(hex);
  }

  /** Call once per display frame, after the stage render. */
  tick(now: number): void {
    if (!this.running || !this.pacer.due(now)) return;
    const f = this.free.pop();
    if (!f) {
      this.stats.busy++;
      return;
    }
    setSeq(f, this.seq++);
    const t: GrabTimings = { render: 0, readback: 0 };
    const t0 = performance.now();
    const s = this.stats;
    this.grabber
      .grab(f, t)
      .then(async () => {
        s.grabbed++;
        s.render = ema(s.render, t.render);
        s.readback = ema(s.readback, t.readback);
        if (this.keepLast) this.lastFrame = f.bytes.slice();
        if (!this.running || f.width !== this.grabber.width || f.height !== this.grabber.height) return; // resized / stopped meanwhile
        if (isTauri && this.send) {
          const t1 = performance.now();
          await vcamFrame(f.bytes);
          s.ipc = ema(s.ipc, performance.now() - t1);
        }
        s.sent++;
        s.total = ema(s.total, performance.now() - t0);
        const end = performance.now();
        this.sentTimes.push(end);
        while (this.sentTimes.length && this.sentTimes[0] < end - 1000) this.sentTimes.shift();
        s.fps = this.sentTimes.length;
      })
      .catch((e) => {
        s.errors++;
        s.lastError = String(e);
        this.onError?.(s.lastError);
      })
      .finally(() => {
        // Recycle unless the size changed (or we stopped) meanwhile.
        if (this.running && f.width === this.grabber.width && f.height === this.grabber.height) this.free.push(f);
      });
  }
}
