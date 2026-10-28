import { describe, expect, it } from 'vitest';
import {
  analyzeSpectrum,
  magnitudeSpectrum,
  MouthSmoother,
  rmsDb,
  silentShapes,
  synthVowel,
  VISEMES,
  VOWELS,
  type Viseme,
} from '../src/audio/visemes';

const SR = 48000;
const N = 2048;

function analyse(frame: Float32Array) {
  return analyzeSpectrum(magnitudeSpectrum(frame), SR, rmsDb(frame));
}
const top = (v: Record<Viseme, number>) => VISEMES.reduce((a, b) => (v[b] > v[a] ? b : a));

describe('mic lip sync analysis', () => {
  it('silence and sub-gate noise keep the mouth shut', () => {
    expect(analyse(new Float32Array(N)).level).toBe(0);
    const noise = Float32Array.from({ length: N }, (_, i) => 0.001 * Math.sin(i * 12.9898) * Math.cos(i * 78.233)); // ~ -66 dBFS
    const r = analyse(noise);
    expect(r.level).toBe(0);
    expect(r.arkit.jawOpen).toBe(0);
  });

  it('a loud sine opens the jaw, more for louder', () => {
    const sine = (amp: number) => Float32Array.from({ length: N }, (_, i) => amp * Math.sin((2 * Math.PI * 220 * i) / SR));
    const quiet = analyse(sine(0.01)); // -43 dBFS
    const loud = analyse(sine(0.3)); // -13 dBFS
    expect(quiet.level).toBeGreaterThan(0);
    expect(loud.level).toBeGreaterThan(quiet.level);
    expect(loud.arkit.jawOpen).toBeGreaterThan(quiet.arkit.jawOpen);
    expect(loud.arkit.jawOpen).toBeGreaterThan(0.3);
  });

  it('classifies formant mixes as the five vowels', () => {
    for (const v of VISEMES) {
      const p = VOWELS[v];
      for (const f0 of [110, 180, 240]) {
        const r = analyse(synthVowel(p.f1, p.f2, SR, N, 0.3, f0));
        expect(top(r.visemes), `${v} at f0 ${f0} (F1 ${r.f1.toFixed(0)} F2 ${r.f2.toFixed(0)})`).toBe(v);
      }
    }
  });

  it('formant estimates land near the synthesised formants', () => {
    const r = analyse(synthVowel(760, 1300, SR, N, 0.3, 120));
    expect(Math.abs(r.f1 - 760)).toBeLessThan(120);
    expect(Math.abs(r.f2 - 1300)).toBeLessThan(200);
  });

  it('rounded vowels pucker / funnel, open vowels open the jaw', () => {
    const u = analyse(synthVowel(VOWELS.ou.f1, VOWELS.ou.f2, SR, N));
    const a = analyse(synthVowel(VOWELS.aa.f1, VOWELS.aa.f2, SR, N));
    expect(u.arkit.mouthPucker).toBeGreaterThan(a.arkit.mouthPucker);
    expect(u.arkit.mouthFunnel).toBeGreaterThan(a.arkit.mouthFunnel);
    expect(a.arkit.jawOpen).toBeGreaterThan(u.arkit.jawOpen);
  });

  it('visemes never sum above the level', () => {
    const r = analyse(synthVowel(500, 1500, SR, N, 0.5));
    const sum = VISEMES.reduce((s, v) => s + r.visemes[v], 0);
    expect(sum).toBeLessThanOrEqual(r.level + 1e-6);
  });

  it('smoother opens fast and closes slower', () => {
    const s = new MouthSmoother();
    const open = analyse(synthVowel(760, 1300, SR, N));
    let t = 0;
    while (s.state.arkit.jawOpen < 0.9 * open.arkit.jawOpen) {
      s.update(open, 1 / 60);
      t += 1 / 60;
    }
    const attack = t;
    t = 0;
    while (s.state.arkit.jawOpen > 0.1 * open.arkit.jawOpen) {
      s.update(silentShapes(), 1 / 60);
      t += 1 / 60;
    }
    expect(attack).toBeLessThan(0.12);
    expect(t).toBeGreaterThan(attack);
    expect(t).toBeLessThan(0.4);
  });
});
