import { describe, expect, it } from 'vitest';
import { FrameScheduler, STALL_MS } from '../src/app/backgroundLoop';

describe('background frame scheduler', () => {
  it('in the foreground, real rAF runs each callback and the fallback tick does nothing', () => {
    const s = new FrameScheduler();
    const ran: number[] = [];
    const id = s.add((t) => ran.push(t));
    s.native(id, 16);
    expect(ran).toEqual([16]);
    s.add((t) => ran.push(t));
    expect(s.tick(20)).toBe(0); // rAF fired 4 ms ago: not stalled
    expect(ran).toEqual([16]);
  });

  it('when rAF stops (minimized / hidden), the fallback tick runs pending callbacks once', () => {
    const s = new FrameScheduler();
    const ran: string[] = [];
    s.native(s.add(() => {}), 0);
    const a = s.add(() => ran.push('render'));
    s.add(() => ran.push('tracker'));
    expect(s.tick(STALL_MS - 1)).toBe(0);
    expect(s.tick(STALL_MS + 1)).toBe(2);
    expect(ran).toEqual(['render', 'tracker']);
    // The late real rAF for the same request must not run it again.
    s.native(a, STALL_MS + 5);
    expect(ran).toEqual(['render', 'tracker']);
    expect(s.fallbackFrames).toBe(1);
  });

  it('a loop that re-requests from inside its callback keeps going at the tick rate', () => {
    const s = new FrameScheduler();
    let frames = 0;
    const loop = () => {
      frames++;
      s.add(loop);
    };
    s.add(loop);
    s.lastNative = 0;
    for (let i = 0; i < 60; i++) s.tick(200 + (i * 1000) / 60);
    expect(frames).toBe(60); // one per tick, never several per tick
    expect(s.size).toBe(1);
  });

  it('cancelled callbacks never run; a throwing one does not stop the rest', () => {
    const s = new FrameScheduler();
    const ran: string[] = [];
    s.lastNative = 0;
    const c = s.add(() => ran.push('cancelled'));
    s.cancel(c);
    s.add(() => {
      throw new Error('boom');
    });
    s.add(() => ran.push('after'));
    const errors: unknown[] = [];
    const orig = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void) => {
      try {
        fn();
      } catch (e) {
        errors.push(e);
      }
      return 0;
    }) as typeof setTimeout;
    try {
      expect(s.tick(500)).toBe(2);
    } finally {
      globalThis.setTimeout = orig;
    }
    expect(ran).toEqual(['after']);
    expect(errors).toHaveLength(1);
  });

  it('back in the foreground, real rAF takes over again', () => {
    const s = new FrameScheduler();
    s.lastNative = 0;
    const ran: string[] = [];
    s.add(() => ran.push('bg'));
    s.tick(1000);
    const id = s.add(() => ran.push('fg'));
    s.native(id, 1010);
    s.add(() => ran.push('next'));
    expect(s.tick(1020)).toBe(0);
    expect(ran).toEqual(['bg', 'fg']);
  });
});
