/**
 * Rolling per-side hand search statistics for the debug overlay (D) and
 * `?debuglog=1`: what the search did on each hands frame (HandStatus) and how
 * often each hand, and both at once, were found over the last few seconds.
 */
import type { HandStatus, TrackerResult } from './protocol';

type Side = 'left' | 'right';
interface Row {
  t: number;
  found: Record<Side, boolean>;
  status: Record<Side, HandStatus | null>;
}

export class HandStats {
  private rows: Row[] = [];
  constructor(public windowMs = 3000) {}

  /** One hands result (t in ms). */
  push(r: Pick<TrackerResult, 't' | 'hands' | 'handStatus'>): void {
    const found = { left: false, right: false };
    for (const h of r.hands ?? []) if (h.userSide) found[h.userSide] = true;
    this.rows.push({ t: r.t, found, status: { left: r.handStatus?.left ?? null, right: r.handStatus?.right ?? null } });
    const cut = r.t - this.windowMs;
    while (this.rows.length && this.rows[0].t < cut) this.rows.shift();
  }

  get frames(): number {
    return this.rows.length;
  }

  /** Last status per side (null before the first hands frame). */
  last(side: Side): HandStatus | null {
    return this.rows.length ? this.rows[this.rows.length - 1].status[side] : null;
  }

  /** % of frames in the window that found this side's hand (or both, for 'both'). */
  foundPct(side: Side | 'both'): number {
    if (!this.rows.length) return 0;
    const n = this.rows.filter((r) => (side === 'both' ? r.found.left && r.found.right : r.found[side])).length;
    return (100 * n) / this.rows.length;
  }

  /** Status counts in the window, per side. */
  counts(side: Side): Partial<Record<HandStatus, number>> {
    const out: Partial<Record<HandStatus, number>> = {};
    for (const r of this.rows) {
      const s = r.status[side];
      if (s) out[s] = (out[s] ?? 0) + 1;
    }
    return out;
  }

  /** One-line summary: "L TRACKED 92% R MISS 40% BOTH 38%". */
  summary(): string {
    if (!this.rows.length) return '-';
    const f = (s: Side) => `${s === 'left' ? 'L' : 'R'} ${(this.last(s) ?? '-').toUpperCase()} ${this.foundPct(s).toFixed(0)}%`;
    return `${f('left')} ${f('right')} BOTH ${this.foundPct('both').toFixed(0)}%`;
  }

  /** Counts for the log: "L tracked:52 miss:8 | R found:3 no-roi:57". */
  countsLine(): string {
    const c = (s: Side) =>
      `${s === 'left' ? 'L' : 'R'} ${Object.entries(this.counts(s)).map(([k, v]) => `${k}:${v}`).join(' ') || '-'}`;
    return `${c('left')} | ${c('right')}`;
  }
}
