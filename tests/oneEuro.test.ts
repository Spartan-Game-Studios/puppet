import { describe, expect, it } from 'vitest';
import { OneEuroFilter, smoothingToParams } from '../src/core/oneEuro';

describe('OneEuroFilter', () => {
  it('passes the first sample through', () => {
    const f = new OneEuroFilter();
    expect(f.filter(0.7, 0)).toBe(0.7);
  });

  it('converges to a constant input', () => {
    const f = new OneEuroFilter({ minCutoff: 1, beta: 0, dCutoff: 1 });
    f.filter(0, 0);
    let v = 0;
    for (let i = 1; i <= 300; i++) v = f.filter(1, i / 30);
    expect(v).toBeCloseTo(1, 3);
  });

  it('reduces jitter on a noisy constant signal', () => {
    const f = new OneEuroFilter({ minCutoff: 1, beta: 0.1, dCutoff: 1 });
    let seed = 1;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.2;
    const raw: number[] = [];
    const out: number[] = [];
    for (let i = 0; i < 300; i++) {
      const x = 0.5 + rand();
      raw.push(x);
      out.push(f.filter(x, i / 30));
    }
    const sd = (a: number[]) => {
      const s = a.slice(60);
      const m = s.reduce((p, c) => p + c, 0) / s.length;
      return Math.sqrt(s.reduce((p, c) => p + (c - m) ** 2, 0) / s.length);
    };
    expect(sd(out)).toBeLessThan(sd(raw) * 0.5);
  });

  it('follows fast motion with less lag when beta is higher', () => {
    const lagFor = (beta: number) => {
      const f = new OneEuroFilter({ minCutoff: 0.5, beta, dCutoff: 1 });
      let v = 0;
      for (let i = 0; i < 10; i++) v = f.filter(i < 2 ? 0 : 1, i / 30);
      return 1 - v;
    };
    expect(lagFor(5)).toBeLessThan(lagFor(0));
  });

  it('restarts after a long gap instead of crawling from the old value', () => {
    const f = new OneEuroFilter({ minCutoff: 0.5, beta: 0, dCutoff: 1 });
    f.filter(0, 0);
    expect(f.filter(1, 5)).toBe(1);
  });

  it('maps the smoothing amount monotonically', () => {
    expect(smoothingToParams(0).minCutoff).toBeGreaterThan(smoothingToParams(0.5).minCutoff);
    expect(smoothingToParams(0.5).minCutoff).toBeGreaterThan(smoothingToParams(1).minCutoff);
    expect(smoothingToParams(0.5, true).beta).toBeGreaterThan(smoothingToParams(0.5).beta);
  });
});
