/**
 * One-euro filter (Casiez, Roussel, Vogel 2012): a low-pass filter whose
 * cutoff rises with speed, so slow movement is smoothed hard and fast movement
 * (a blink, a head turn) passes with little lag.
 *
 * Implemented from the paper's description.
 */
export interface OneEuroParams {
  /** Cutoff at zero speed, Hz. Lower = smoother when still. */
  minCutoff: number;
  /** How much the cutoff rises per unit of speed. Higher = less lag when moving. */
  beta: number;
  /** Cutoff for the derivative estimate, Hz. */
  dCutoff: number;
}

export const DEFAULT_ONE_EURO: OneEuroParams = { minCutoff: 1.5, beta: 0.4, dCutoff: 1.0 };

const alpha = (cutoff: number, dt: number) => {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
};

export class OneEuroFilter {
  params: OneEuroParams;
  private x: number | null = null;
  private dx = 0;
  private lastT: number | null = null;

  constructor(params: OneEuroParams = DEFAULT_ONE_EURO) {
    this.params = { ...params };
  }

  reset(): void {
    this.x = null;
    this.dx = 0;
    this.lastT = null;
  }

  /** Filter `value` sampled at time `t` (seconds). */
  filter(value: number, t: number): number {
    if (this.x === null || this.lastT === null) {
      this.x = value;
      this.lastT = t;
      this.dx = 0;
      return value;
    }
    let dt = t - this.lastT;
    if (dt <= 0) dt = 1 / 120; // same-timestamp samples: assume a short step
    if (dt > 1) {
      // A gap longer than a second (tracking lost): restart from the new value.
      this.x = value;
      this.dx = 0;
      this.lastT = t;
      return value;
    }
    this.lastT = t;
    const { minCutoff, beta, dCutoff } = this.params;
    const rawDx = (value - this.x) / dt;
    this.dx += alpha(dCutoff, dt) * (rawDx - this.dx);
    const cutoff = minCutoff + beta * Math.abs(this.dx);
    this.x += alpha(cutoff, dt) * (value - this.x);
    return this.x;
  }
}

/** A bank of independent filters for a fixed-length vector. */
export class OneEuroVector {
  private filters: OneEuroFilter[];
  constructor(n: number, params: OneEuroParams = DEFAULT_ONE_EURO) {
    this.filters = Array.from({ length: n }, () => new OneEuroFilter(params));
  }
  setParams(p: OneEuroParams): void {
    for (const f of this.filters) f.params = { ...p };
  }
  reset(): void {
    for (const f of this.filters) f.reset();
  }
  filter(values: ArrayLike<number>, t: number, out: number[] = []): number[] {
    for (let i = 0; i < this.filters.length; i++) out[i] = this.filters[i].filter(values[i], t);
    return out;
  }
}

/**
 * Map the user-facing smoothing amount (0 = raw, 1 = very smooth) onto filter
 * parameters. `fast` channels (blinks, jaw) keep a higher beta so they still snap.
 */
export function smoothingToParams(amount: number, fast = false): OneEuroParams {
  const a = Math.min(1, Math.max(0, amount));
  // minCutoff: 12 Hz (almost raw) down to 0.4 Hz (heavy), log-spaced.
  const minCutoff = 12 * Math.pow(0.4 / 12, a);
  const beta = fast ? 4 * (1 - a) + 1.0 : 1.5 * (1 - a) + 0.05;
  return { minCutoff, beta, dCutoff: 1.0 };
}
