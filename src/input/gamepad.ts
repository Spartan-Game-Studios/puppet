/**
 * Gamepad polling (Gamepad API, standard mapping): button edges for hotkeys
 * and a direction stream (d-pad or left stick, with key-repeat) for the
 * on-screen picker. Call poll() once per frame.
 */
export type NavDir = 'up' | 'down' | 'left' | 'right';

const DPAD: Record<number, NavDir> = { 12: 'up', 13: 'down', 14: 'left', 15: 'right' };

export class GamepadInput {
  onButton: (button: number, pressed: boolean, pad: string) => void = () => {};
  onNav: (dir: NavDir) => void = () => {};
  private prev = new Map<number, boolean[]>();
  private stickDir: NavDir | null = null;
  private stickNext = 0;
  /** Names of connected pads (for the UI). */
  pads: string[] = [];

  poll(now = performance.now()): void {
    const list = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    const names: string[] = [];
    let stick: NavDir | null = null;
    for (const gp of list) {
      if (!gp || !gp.connected) continue;
      names.push(gp.id);
      const before = this.prev.get(gp.index) ?? [];
      const now_ = gp.buttons.map((b) => b.pressed || b.value > 0.5);
      now_.forEach((p, i) => {
        if (p !== !!before[i]) {
          this.onButton(i, p, gp.id);
          if (p && DPAD[i]) this.onNav(DPAD[i]);
        }
      });
      this.prev.set(gp.index, now_);
      const [x = 0, y = 0] = gp.axes;
      if (Math.hypot(x, y) > 0.6) stick = Math.abs(x) > Math.abs(y) ? (x > 0 ? 'right' : 'left') : y > 0 ? 'down' : 'up';
    }
    this.pads = names;
    // Left stick: one step on push, then repeat while held.
    if (stick !== this.stickDir) {
      this.stickDir = stick;
      if (stick) {
        this.onNav(stick);
        this.stickNext = now + 380;
      }
    } else if (stick && now >= this.stickNext) {
      this.onNav(stick);
      this.stickNext = now + 140;
    }
  }
}
