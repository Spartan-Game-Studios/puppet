/**
 * Expression overlay: hotkey-set expressions (VRM presets or any custom
 * expression on the model) faded over the tracked face.
 *
 * - `toggle`: press turns it on (and any other latched expression off); press
 *   again turns it off.
 * - `on`: press turns it on (others off); it stays until reset or another one.
 * - `momentary`: on while the trigger is held.
 *
 * While an expression is up, the tracked emotion presets other than it are
 * scaled down by its weight, so a tracked smile doesn't fight a held ANGRY.
 * Pure: no three.js.
 */
export type ExpressionMode = 'toggle' | 'on' | 'momentary';

export const EMOTION_PRESETS = ['happy', 'angry', 'sad', 'relaxed', 'surprised'] as const;

interface Entry {
  value: number;
  target: number;
  fadeIn: number;
  fadeOut: number;
  latched: boolean;
  done?: boolean;
}

export class ExpressionOverlay {
  private entries = new Map<string, Entry>();

  /** Names currently up (target 1). */
  get active(): string[] {
    return [...this.entries].filter(([, e]) => e.target > 0).map(([n]) => n);
  }

  value(name: string): number {
    return this.entries.get(name)?.value ?? 0;
  }

  press(name: string, mode: ExpressionMode, fadeIn = 0.15, fadeOut = 0.3): void {
    const cur = this.entries.get(name);
    const wasOn = !!cur && cur.target > 0;
    if (mode !== 'momentary') {
      // Latched expressions are exclusive.
      for (const [n, e] of this.entries) if (n !== name && e.latched) e.target = 0;
    }
    const e: Entry = cur ?? { value: 0, target: 0, fadeIn, fadeOut, latched: false };
    e.fadeIn = fadeIn;
    e.fadeOut = fadeOut;
    if (mode === 'toggle') {
      e.target = wasOn && e.latched ? 0 : 1;
      e.latched = true;
    } else if (mode === 'on') {
      e.target = 1;
      e.latched = true;
    } else {
      e.target = 1;
      e.latched = false;
    }
    this.entries.set(name, e);
  }

  release(name: string, mode: ExpressionMode): void {
    if (mode !== 'momentary') return;
    const e = this.entries.get(name);
    if (e && !e.latched) e.target = 0;
  }

  /** Everything off (fades out). */
  reset(): void {
    for (const e of this.entries.values()) {
      e.target = 0;
      e.latched = false;
    }
  }

  update(dt: number): void {
    for (const e of this.entries.values()) {
      const rate = e.target > e.value ? 1 / Math.max(1e-3, e.fadeIn) : 1 / Math.max(1e-3, e.fadeOut);
      const step = rate * dt;
      e.value = e.target > e.value ? Math.min(e.target, e.value + step) : Math.max(e.target, e.value - step);
      // Faded out: apply() writes one final value, then drops the entry.
      e.done = e.value === 0 && e.target === 0;
    }
  }

  /**
   * Apply onto this frame's expression values (model expression names).
   * `has` tells which names the model has.
   */
  apply(values: Map<string, number>, has: (name: string) => boolean): void {
    let strongest = 0;
    for (const [n, e] of this.entries) {
      const v = e.value;
      if (!has(n)) continue;
      if (EMOTION_PRESETS.includes(n as (typeof EMOTION_PRESETS)[number])) strongest = Math.max(strongest, v);
    }
    if (strongest > 0) {
      for (const p of EMOTION_PRESETS) {
        const own = this.entries.get(p);
        if (own && own.value >= strongest) continue;
        const cur = values.get(p);
        if (cur !== undefined) values.set(p, cur * (1 - strongest));
      }
    }
    for (const [n, e] of [...this.entries]) {
      if (e.done) {
        if (has(n)) values.set(n, values.get(n) ?? 0);
        this.entries.delete(n);
        continue;
      }
      if (!has(n)) continue;
      values.set(n, Math.max(values.get(n) ?? 0, e.value));
    }
  }
}
