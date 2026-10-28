import { describe, expect, it } from 'vitest';
import { allocFrame, compositePixel, FramePacer, HEADER_LEN, parseHeader, parseHex, setSeq } from '../src/vcam/frame';

describe('vcam frame header', () => {
  it('lays out magic, size and seq little-endian, pixels after 16 bytes', () => {
    const f = allocFrame(1280, 720);
    expect(f.bytes.length).toBe(HEADER_LEN + 1280 * 720 * 4);
    expect(f.pixels.byteOffset).toBe(HEADER_LEN);
    expect(f.pixels.length).toBe(1280 * 720 * 4);
    expect(String.fromCharCode(...f.bytes.subarray(0, 4))).toBe('PVCF');
    setSeq(f, 0x01020304);
    expect(Array.from(f.bytes.subarray(4, 16))).toEqual([0x00, 0x05, 0, 0, 0xd0, 0x02, 0, 0, 4, 3, 2, 1]);
    expect(parseHeader(f.bytes)).toEqual({ width: 1280, height: 720, seq: 0x01020304 });
  });

  it('writes into the shared buffer (no copy between readback and IPC)', () => {
    const f = allocFrame(2, 1);
    f.pixels.set([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(Array.from(f.bytes.subarray(HEADER_LEN))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('rejects bad magic and wrong length', () => {
    const f = allocFrame(4, 2);
    expect(parseHeader(f.bytes.subarray(0, f.bytes.length - 1))).toBeNull();
    const g = allocFrame(4, 2);
    g.bytes[0] = 0;
    expect(parseHeader(g.bytes)).toBeNull();
  });
});

describe('FramePacer', () => {
  const run = (fps: number, displayHz: number, seconds: number, jitter = 0) => {
    const p = new FramePacer(fps);
    let n = 0;
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
    for (let t = 0; t < seconds * 1000; t += 1000 / displayHz) if (p.due(t + rnd() * jitter)) n++;
    return n / seconds;
  };

  it('gives 30 fps from 60 Hz and 120 Hz rAF, with jitter', () => {
    expect(run(30, 60, 10)).toBeCloseTo(30, 0);
    expect(run(30, 120, 10)).toBeCloseTo(30, 0);
    expect(run(30, 60, 10, 2)).toBeCloseTo(30, 0);
    expect(run(30, 144, 10, 1)).toBeCloseTo(30, 0);
  });

  it('does not burst after a stall', () => {
    const p = new FramePacer(30);
    expect(p.due(0)).toBe(true);
    expect(p.due(1000)).toBe(true); // 1 s hitch
    expect(p.due(1001)).toBe(false);
    expect(p.due(1017)).toBe(false);
    expect(p.due(1034)).toBe(true);
  });
});

describe('output pass (CPU reference of the shader)', () => {
  it('parses colours', () => {
    expect(parseHex('#00ff00')).toEqual([0, 1, 0]);
    expect(parseHex('ff3b00')).toEqual([1, 59 / 255, 0]);
    expect(parseHex('nonsense')).toEqual([0, 1, 0]);
  });

  it('shows "clear" (alpha 0) as the chosen colour, exactly', () => {
    expect(compositePixel([0, 0, 0, 0], parseHex('#00ff00'))).toEqual([0, 255, 0, 255]);
    expect(compositePixel([0, 0, 0, 0], parseHex('#ff00ff'))).toEqual([255, 0, 255, 255]);
    expect(compositePixel([0, 0, 0, 0], parseHex('#123456'))).toEqual([0x56, 0x34, 0x12, 255]);
  });

  it('keeps opaque pixels and blends edges, in BGRA order', () => {
    // Opaque linear red -> sRGB red, B,G,R,A byte order.
    expect(compositePixel([1, 0, 0, 1], [0, 1, 0])).toEqual([0, 0, 255, 255]);
    // Linear 0.21586 = sRGB 128.
    expect(compositePixel([0.21586, 0.21586, 0.21586, 1], [0, 1, 0])).toEqual([128, 128, 128, 255]);
    // Half-covered white edge over green (premultiplied 0.5): G saturates, R/B mid.
    const [b, g, r, a] = compositePixel([0.5, 0.5, 0.5, 0.5], [0, 1, 0]);
    expect(g).toBe(255);
    expect(r).toBe(b);
    expect(r).toBeGreaterThan(180);
    expect(a).toBe(255);
  });
});
