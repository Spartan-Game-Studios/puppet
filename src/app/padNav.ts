/**
 * Gamepad UI navigation. The face buttons and d-pad are emote / expression
 * hotkeys while performing, so UI navigation only takes the pad when there is
 * UI to drive:
 *
 *   - a modal (or the HOME confirm dialog) is open,
 *   - the HOME library is showing,
 *   - or the stage MENU mode is on: LT (unless LT is bound to a hotkey) or
 *     opening something with the pad turns it on; B leaves it.
 *
 * While active: d-pad / left stick move focus (spatially, to the nearest
 * control in that direction; on HOME they are the grid's arrow keys), A
 * presses the focused control, B goes back (closes the modal, leaves HOME
 * drawers / HOME, leaves MENU mode). On a slider or a drop-down, left/right
 * change the value. The HotkeyManager routes pad input here (hotkeys.ts `ui`).
 */
import type { NavDir } from '../input/gamepad';
import type { UiNavControl } from '../input/hotkeys';
import { focusables, openModal } from './modal';

/** Standard-mapping button indexes. */
export const PAD_A = 0;
export const PAD_B = 1;
export const PAD_MENU = 6; // LT

export interface PadNavDeps {
  homeVisible(): boolean;
  /** Where MENU mode starts (the first settings button). */
  menuStart(): HTMLElement | null;
  /** Root of the stage UI that MENU mode moves through. */
  stageRoot(): HTMLElement;
}

const KEY: Record<NavDir, string> = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };

function key(target: EventTarget, k: string): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: k === ' ' ? 'Space' : k, bubbles: true, cancelable: true }));
  target.dispatchEvent(new KeyboardEvent('keyup', { key: k, code: k === ' ' ? 'Space' : k, bubbles: true, cancelable: true }));
}

/** The nearest candidate from `from` in direction `dir` (simple spatial navigation). */
export function nearest(from: DOMRect, dir: NavDir, rects: Array<{ el: HTMLElement; r: DOMRect }>): HTMLElement | null {
  const cx = from.left + from.width / 2;
  const cy = from.top + from.height / 2;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const { el, r } of rects) {
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    let main: number;
    let cross: number;
    if (dir === 'right') {
      main = r.left - from.right;
      cross = Math.abs(y - cy);
      if (x <= cx + 1 || r.left < from.right - Math.min(from.width, r.width) / 2) continue;
    } else if (dir === 'left') {
      main = from.left - r.right;
      cross = Math.abs(y - cy);
      if (x >= cx - 1 || r.right > from.left + Math.min(from.width, r.width) / 2) continue;
    } else if (dir === 'down') {
      main = r.top - from.bottom;
      cross = Math.abs(x - cx);
      if (y <= cy + 1 || r.top < from.bottom - Math.min(from.height, r.height) / 2) continue;
    } else {
      main = from.top - r.bottom;
      cross = Math.abs(x - cx);
      if (y >= cy - 1 || r.bottom > from.top + Math.min(from.height, r.height) / 2) continue;
    }
    const score = Math.max(0, main) + 2 * cross;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}

export class PadNav implements UiNavControl {
  /** Stage MENU mode (LT). */
  menu = false;
  onMenuChange: (on: boolean) => void = () => {};

  constructor(private d: PadNavDeps) {
    // Any mouse use ends the pad focus styling.
    window.addEventListener('mousedown', () => document.body.classList.remove('pad-nav'), true);
  }

  /** The open dialog (our modals or the HOME confirm), if any. */
  private dialog(): HTMLElement | null {
    return openModal()?.el ?? document.querySelector<HTMLElement>('dialog[open]');
  }

  get active(): boolean {
    return !!this.dialog() || this.d.homeVisible() || this.menu;
  }

  setMenu(on: boolean): void {
    if (this.menu === on) return;
    this.menu = on;
    document.body.classList.toggle('pad-menu', on);
    if (on) {
      const a = document.activeElement as HTMLElement | null;
      if (!a || a === document.body || !this.d.stageRoot().contains(a)) this.focus(this.d.menuStart());
    } else if (this.d.stageRoot().contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    this.onMenuChange(on);
  }

  private focus(el: HTMLElement | null | undefined): void {
    if (!el) return;
    document.body.classList.add('pad-nav');
    el.focus({ preventScroll: false });
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  private scope(): HTMLElement | null {
    const dlg = this.dialog();
    if (dlg) return dlg;
    if (this.d.homeVisible()) return null; // HOME: arrow keys
    return this.menu ? this.d.stageRoot() : null;
  }

  nav(dir: NavDir): void {
    document.body.classList.add('pad-nav');
    const scope = this.scope();
    const a = document.activeElement as HTMLElement | null;
    if (!scope) {
      // HOME grid: the d-pad is its arrow keys.
      key(a && a !== document.body ? a : document.body, KEY[dir]);
      return;
    }
    const inScope = a && scope.contains(a) && a !== scope ? a : null;
    // Value controls: left/right change the value, up/down move on.
    if (inScope && (dir === 'left' || dir === 'right')) {
      if (inScope instanceof HTMLInputElement && inScope.type === 'range') {
        dir === 'right' ? inScope.stepUp() : inScope.stepDown();
        inScope.dispatchEvent(new Event('input', { bubbles: true }));
        inScope.dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }
      if (inScope instanceof HTMLSelectElement && inScope.options.length) {
        const n = inScope.options.length;
        inScope.selectedIndex = (inScope.selectedIndex + (dir === 'right' ? 1 : -1) + n) % n;
        inScope.dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }
    }
    const list = focusables(scope).filter((el) => el !== inScope);
    if (!inScope) return this.focus(list[0]);
    const next = nearest(
      inScope.getBoundingClientRect(),
      dir,
      list.map((el) => ({ el, r: el.getBoundingClientRect() })),
    );
    this.focus(next);
  }

  press(button: number): boolean {
    document.body.classList.add('pad-nav');
    const a = document.activeElement as HTMLElement | null;
    if (button === PAD_MENU) {
      if (this.dialog() || this.d.homeVisible()) return true;
      this.setMenu(!this.menu);
      return true;
    }
    if (button === PAD_A) {
      if (!a || a === document.body) {
        const s = this.scope();
        if (s) this.focus(focusables(s)[0]);
        else key(document.body, 'Enter');
        return true;
      }
      if (a instanceof HTMLSelectElement) {
        // A on a drop-down: next option (pad cannot open the native list).
        const n = a.options.length;
        if (n) {
          a.selectedIndex = (a.selectedIndex + 1) % n;
          a.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } else if (a instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'submit', 'range'].includes(a.type)) {
        a.select?.();
      } else if (a.matches('button, input, a[href], summary, [role="button"]')) a.click();
      else key(a, 'Enter'); // HOME card: Enter loads
      return true;
    }
    if (button === PAD_B) {
      const m = openModal();
      if (m) m.close();
      else if (this.dialog() instanceof HTMLDialogElement) (this.dialog() as HTMLDialogElement).close();
      else if (this.d.homeVisible()) key(a && a !== document.body ? a : document.body, 'Escape');
      else this.setMenu(false);
      return true;
    }
    return true; // other buttons are swallowed while the UI has the pad
  }
}
