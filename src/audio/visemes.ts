/**
 * Mic lip sync analysis: one magnitude spectrum (as from an AnalyserNode) ->
 * mouth shapes.
 *
 *  - Level: frame energy in dBFS through a noise gate, mapped to 0..1.
 *  - Vowel: the first two formants (F1, F2) picked from a smoothed spectral
 *    envelope (the voice's harmonics averaged out), matched softly against
 *    five vowel prototypes. VRM's five visemes are the Japanese vowels:
 *    aa = a, ih = i, ou = u, ee = e, oh = o.
 *  - ARKit shapes for perfect-sync models: jawOpen from the level and vowel
 *    openness, mouthFunnel / mouthPucker for rounded vowels, a little
 *    mouthStretch for i / e.
 *
 * Pure: no Web Audio here (see mic.ts), so it runs in unit tests.
 */

export const VISEMES = ['aa', 'ih', 'ou', 'ee', 'oh'] as const;
export type Viseme = (typeof VISEMES)[number];

/** Formant prototypes (Hz), roughly adult averages across speakers. */
export const VOWELS: Record<Viseme, { f1: number; f2: number; open: number; round: number; spread: number }> = {
  aa: { f1: 760, f2: 1300, open: 1.0, round: 0, spread: 0.1 },
  ih: { f1: 310, f2: 2250, open: 0.3, round: 0, spread: 0.8 },
  ou: { f1: 340, f2: 900, open: 0.3, round: 1, spread: 0 },
  ee: { f1: 520, f2: 1850, open: 0.55, round: 0, spread: 0.5 },
  oh: { f1: 520, f2: 900, open: 0.65, round: 0.6, spread: 0 },
};

export interface MouthShapes {
  /** 0..1 loudness after the gate. */
  level: number;
  visemes: Record<Viseme, number>;
  arkit: { jawOpen: number; mouthFunnel: number; mouthPucker: number; mouthStretchLeft: number; mouthStretchRight: number; mouthClose: number };
  f1: number;
  f2: number;
  db: number;
}

export interface AnalysisOptions {
  /** Below this level (dBFS) the mouth is closed. */
  gateDb: number;
  /** dB above the gate that reads as fully open. */
  rangeDb: number;
  /** Output gain on the mouth shapes. */
  gain: number;
}

export const DEFAULT_ANALYSIS: AnalysisOptions = { gateDb: -50, rangeDb: 30, gain: 1 };

export const silentShapes = (): MouthShapes => ({
  level: 0,
  visemes: { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 },
  arkit: { jawOpen: 0, mouthFunnel: 0, mouthPucker: 0, mouthStretchLeft: 0, mouthStretchRight: 0, mouthClose: 0 },
  f1: 0,
  f2: 0,
  db: -Infinity,
});

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0);

/** Weighted peak frequency of `env` within [lo, hi] Hz (top bins only). */
function peak(env: Float32Array, binHz: number, lo: number, hi: number): { f: number; e: number } {
  const a = Math.max(1, Math.floor(lo / binHz));
  const b = Math.min(env.length - 1, Math.ceil(hi / binHz));
  let max = 0;
  let at = a;
  for (let i = a; i <= b; i++)
    if (env[i] > max) {
      max = env[i];
      at = i;
    }
  if (max <= 0) return { f: 0, e: 0 };
  // Parabolic interpolation around the maximum.
  const l = env[at - 1] ?? max;
  const r = env[at + 1] ?? max;
  const den = l - 2 * max + r;
  const off = den !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / den)) : 0;
  return { f: (at + off) * binHz, e: max };
}

/**
 * Analyse one frame.
 * @param mag   linear magnitude per FFT bin (bin i = i * sampleRate / fftSize)
 * @param rmsDb frame RMS in dBFS (from the time-domain signal)
 */
export function analyzeSpectrum(mag: Float32Array, sampleRate: number, rmsDb: number, opts: AnalysisOptions = DEFAULT_ANALYSIS): MouthShapes {
  const out = silentShapes();
  out.db = rmsDb;
  const level = clamp01((rmsDb - opts.gateDb) / opts.rangeDb);
  if (level <= 0) return out;
  const binHz = sampleRate / 2 / mag.length;

  // Spectral envelope: power smoothed over ~ 250 Hz, which averages out the
  // voice's harmonics (F0 100-300 Hz) and leaves the formant peaks.
  const half = Math.max(1, Math.round(125 / binHz));
  const env = new Float32Array(mag.length);
  let acc = 0;
  // Pre-emphasis (1 - 0.97 z^-1), as in LPC formant analysis: undoes the
  // voice's spectral tilt so low harmonics don't hide F1.
  const pre = new Float32Array(mag.length);
  for (let i = 0; i < mag.length; i++) {
    const w = (Math.PI * i) / mag.length;
    pre[i] = mag[i] * Math.hypot(1 - 0.97 * Math.cos(w), 0.97 * Math.sin(w));
  }
  const pw = (i: number) => (i >= 0 && i < pre.length ? pre[i] * pre[i] : 0);
  for (let i = -half; i <= half; i++) acc += pw(i);
  for (let i = 0; i < mag.length; i++) {
    env[i] = acc;
    acc += pw(i + half + 1) - pw(i - half);
  }

  const p1 = peak(env, binHz, 250, 1000);
  // F2: above F1, away from its skirt.
  const p2 = peak(env, binHz, Math.max(700, p1.f * 1.45), 3000);
  let f1 = p1.f;
  let f2 = p2.f;
  // A single strong low peak with nothing above (a hum, a pure tone): treat as "u/o".
  if (p2.e < p1.e * 0.02) f2 = Math.max(f1 * 1.6, 800);
  if (!f1) f1 = 500;
  out.f1 = f1;
  out.f2 = f2;

  // Soft match in log-frequency space.
  const w: Record<Viseme, number> = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
  let sum = 0;
  for (const v of VISEMES) {
    const p = VOWELS[v];
    const d1 = Math.log2(f1 / p.f1) / 0.35;
    const d2 = Math.log2(Math.max(1, f2) / p.f2) / 0.3;
    w[v] = Math.exp(-(d1 * d1 + d2 * d2));
    sum += w[v];
  }
  const g = level * opts.gain;
  let open = 0, round = 0, spread = 0;
  for (const v of VISEMES) {
    const share = sum > 1e-9 ? w[v] / sum : v === 'aa' ? 1 : 0;
    out.visemes[v] = clamp01(share * g);
    open += share * VOWELS[v].open;
    round += share * VOWELS[v].round;
    spread += share * VOWELS[v].spread;
  }
  out.level = clamp01(g);
  out.arkit.jawOpen = clamp01(g * (0.25 + 0.75 * open));
  out.arkit.mouthFunnel = clamp01(g * round * 0.7);
  out.arkit.mouthPucker = clamp01(g * round * round * 0.9);
  out.arkit.mouthStretchLeft = out.arkit.mouthStretchRight = clamp01(g * spread * 0.5);
  return out;
}

/** Attack/release smoothing of mouth shapes (fast open, slower close). */
export class MouthSmoother {
  attack = 0.03;
  release = 0.09;
  readonly state = silentShapes();

  update(next: MouthShapes, dt: number): MouthShapes {
    const s = this.state;
    const k = (cur: number, to: number) => {
      const tau = to > cur ? this.attack : this.release;
      return cur + (to - cur) * (1 - Math.exp(-dt / Math.max(1e-3, tau)));
    };
    s.level = k(s.level, next.level);
    for (const v of VISEMES) s.visemes[v] = k(s.visemes[v], next.visemes[v]);
    for (const a of Object.keys(s.arkit) as Array<keyof MouthShapes['arkit']>) s.arkit[a] = k(s.arkit[a], next.arkit[a]);
    s.f1 = next.f1;
    s.f2 = next.f2;
    s.db = next.db;
    return s;
  }
}

/** RMS of a time-domain frame, in dBFS. */
export function rmsDb(frame: Float32Array): number {
  let s = 0;
  for (let i = 0; i < frame.length; i++) s += frame[i] * frame[i];
  const rms = Math.sqrt(s / Math.max(1, frame.length));
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

/** dB values from AnalyserNode.getFloatFrequencyData -> linear magnitude. */
export function dbToMag(db: Float32Array, out = new Float32Array(db.length)): Float32Array {
  for (let i = 0; i < db.length; i++) out[i] = Number.isFinite(db[i]) ? Math.pow(10, db[i] / 20) : 0;
  return out;
}

/** Magnitude spectrum of a real frame (Hann window, radix-2 FFT). For tests and offline use. */
export function magnitudeSpectrum(frame: Float32Array): Float32Array {
  const n = frame.length;
  if (n & (n - 1)) throw new Error('frame length must be a power of two');
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = frame[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
        const vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
      }
    }
  }
  const out = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) out[i] = Math.hypot(re[i], im[i]) / (n / 4);
  return out;
}

/**
 * A synthetic vowel: a glottal-like pulse train (harmonics of f0 with a
 * -12 dB/octave tilt) shaped by resonances at the given formants.
 */
export function synthVowel(f1: number, f2: number, sampleRate: number, n: number, amp = 0.3, f0 = 140, phase = 0): Float32Array {
  const out = new Float32Array(n);
  const res = (f: number, fc: number, bw: number) => 1 / Math.sqrt(1 + Math.pow((f - fc) / (bw / 2), 2));
  const harmonics: Array<[number, number]> = [];
  for (let h = 1; h * f0 < Math.min(5000, sampleRate / 2); h++) {
    const f = h * f0;
    const a = (1 / (h * h)) * (0.02 + res(f, f1, 120) + 0.8 * res(f, f2, 160) + 0.3 * res(f, 2900, 250)) * h;
    harmonics.push([f, a]);
  }
  const norm = harmonics.reduce((m, [, a]) => m + a, 0);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate + phase;
    let s = 0;
    for (const [f, a] of harmonics) s += a * Math.sin(2 * Math.PI * f * t);
    out[i] = (amp * s) / norm;
  }
  return out;
}
