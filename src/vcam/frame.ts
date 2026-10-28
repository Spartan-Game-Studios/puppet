/**
 * Virtual camera frame plumbing that has no DOM / WebGL dependency (unit
 * tested in tests/vcam.test.ts).
 *
 * Wire format of one frame, sent to Rust as a raw binary IPC body
 * (src-tauri/src/vcam/mod.rs, `parse_frame`):
 *
 *   0..4    "PVCF"
 *   4..8    width  (u32 LE)
 *   8..12   height (u32 LE)
 *   12..16  seq    (u32 LE)
 *   16..    width*height*4 bytes of BGRA, top-down, alpha = 255
 */
export const FRAME_MAGIC = 'PVCF';
export const HEADER_LEN = 16;

export type VcamResolution = '1280x720' | '1920x1080';
export const VCAM_RESOLUTIONS: Record<VcamResolution, [number, number]> = {
  '1280x720': [1280, 720],
  '1920x1080': [1920, 1080],
};
export const VCAM_FPS = 30;

export interface FrameBuffer {
  /** Whole IPC body (header + pixels). */
  bytes: Uint8Array;
  /** Pixel view into `bytes` (offset HEADER_LEN), handed to the GPU readback. */
  pixels: Uint8Array;
  width: number;
  height: number;
}

export function allocFrame(width: number, height: number): FrameBuffer {
  const bytes = new Uint8Array(HEADER_LEN + width * height * 4);
  for (let i = 0; i < 4; i++) bytes[i] = FRAME_MAGIC.charCodeAt(i);
  const v = new DataView(bytes.buffer);
  v.setUint32(4, width, true);
  v.setUint32(8, height, true);
  return { bytes, pixels: bytes.subarray(HEADER_LEN), width, height };
}

export function setSeq(f: FrameBuffer, seq: number): void {
  new DataView(f.bytes.buffer, f.bytes.byteOffset, HEADER_LEN).setUint32(12, seq >>> 0, true);
}

export function parseHeader(bytes: Uint8Array): { width: number; height: number; seq: number } | null {
  if (bytes.length < HEADER_LEN) return null;
  for (let i = 0; i < 4; i++) if (bytes[i] !== FRAME_MAGIC.charCodeAt(i)) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, HEADER_LEN);
  const width = v.getUint32(4, true);
  const height = v.getUint32(8, true);
  if (bytes.length !== HEADER_LEN + width * height * 4) return null;
  return { width, height, seq: v.getUint32(12, true) };
}

/**
 * Deadline pacing for a fixed output rate driven from requestAnimationFrame
 * (60/120 Hz displays). A frame is due when `now` passes the next deadline;
 * the deadline then advances by one period, and is re-anchored if we fell
 * more than a period behind (a stall must not cause a burst).
 */
export class FramePacer {
  private next = -Infinity;
  readonly period: number;
  /** Half a display frame of slack so 60 Hz rAF hits 30 fps exactly. */
  constructor(fps: number, private slackMs = 4) {
    this.period = 1000 / fps;
  }
  due(now: number): boolean {
    if (now + this.slackMs < this.next) return false;
    this.next = now - this.next > this.period ? now + this.period : this.next + this.period;
    return true;
  }
  reset(): void {
    this.next = -Infinity;
  }
}

/** '#00ff00' -> [0, 1, 0] (sRGB, 0..1). Falls back to chroma green. */
export function parseHex(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0x00ff00;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

/**
 * CPU reference of the GPU output pass (grabber.ts BLIT_FRAG): a linear,
 * premultiplied RGBA pixel composited over the background colour, encoded to
 * sRGB and packed as BGRA bytes. Used by tests to pin down the shader's math.
 */
export function compositePixel(linearPremul: [number, number, number, number], bg: [number, number, number]): [number, number, number, number] {
  const [r, g, b, a] = linearPremul;
  const out = [r, g, b].map((c, i) => {
    const lin = Math.min(1, Math.max(0, c + srgbToLinear(bg[i]) * (1 - a)));
    return Math.round(linearToSrgb(lin) * 255);
  });
  return [out[2], out[1], out[0], 255];
}

/** Exponential moving average helper for the stats line. */
export function ema(prev: number, x: number, k = 0.1): number {
  return prev === 0 ? x : prev + k * (x - prev);
}
