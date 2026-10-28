/**
 * Hotkey runtime: keyboard (in-window and, optionally, global), gamepad and
 * hand-gesture triggers -> binding actions. Also routes input to the
 * on-screen picker while it is open, and captures the next trigger when the
 * HOTKEYS panel is rebinding.
 */
import { keyTrigger, isModifierCode, resolve, toAccelerator, triggerKey, type Action, type Binding, type Trigger } from './bindings';
import { GamepadInput, type NavDir } from './gamepad';
import { setGlobalShortcuts, type GlobalResult } from './globalKeys';
import type { GestureSource } from './gestures';

export interface HotkeyActions {
  run(action: Action, pressed: boolean): void;
}

export interface PickerControl {
  readonly open: boolean;
  nav(dir: NavDir): void;
  select(): void;
  close(): void;
}

/**
 * App UI navigation by gamepad (src/app/padNav.ts). While `active`, pad
 * buttons go to press() instead of firing bindings, and d-pad / stick
 * directions go to nav(). While inactive, only `menuButton` reaches it, and
 * only when no binding uses that button.
 */
export interface UiNavControl {
  readonly active: boolean;
  nav(dir: NavDir): void;
  press(button: number): boolean;
}

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  if (!el) return false;
  if (el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return true;
  return el.tagName === 'INPUT' && !['checkbox', 'range', 'radio', 'button'].includes((el as HTMLInputElement).type);
};

export class HotkeyManager {
  bindings: Binding[] = [];
  model: string | null = null;
  enabled = true;
  readonly gamepad = new GamepadInput();
  picker: PickerControl | null = null;
  ui: UiNavControl | null = null;
  /** Pad button that turns UI navigation on from the stage (LT). */
  uiMenuButton = 6;
  globalStatus: GlobalResult = { registered: [], failed: [] };
  gestureSource: GestureSource | null = null;
  /** Fires on every resolved trigger (UI flash). */
  onFire: (b: Binding) => void = () => {};
  private down = new Set<string>();
  private capture: ((t: Trigger) => void) | null = null;
  private unsubGestures: (() => void) | null = null;
  private globalOn = false;

  constructor(private actions: HotkeyActions) {
    window.addEventListener('keydown', (e) => this.onKey(e, true), true);
    window.addEventListener('keyup', (e) => this.onKey(e, false), true);
    window.addEventListener('blur', () => {
      // Window keys can't be released while unfocused; let go of held ones.
      for (const k of [...this.down]) if (k.startsWith('key:') && !this.globalOn) this.trigger(this.parseKey(k), false);
    });
    this.gamepad.onButton = (button, pressed) => this.trigger({ kind: 'pad', button }, pressed);
    this.gamepad.onNav = (dir) => {
      if (this.picker?.open) this.picker.nav(dir);
      else if (this.ui?.active) this.ui.nav(dir);
    };
  }

  /** Call once per frame (gamepad polling). */
  tick(): void {
    this.gamepad.poll();
  }

  /** Rebinding: the next trigger goes to cb instead of firing (Esc cancels). */
  captureNext(cb: ((t: Trigger) => void) | null): void {
    this.capture = cb;
  }
  get capturing(): boolean {
    return !!this.capture;
  }

  attachGestures(src: GestureSource | null): void {
    this.unsubGestures?.();
    this.gestureSource = src;
    this.unsubGestures = src ? src.subscribe((e) => this.trigger({ kind: 'gesture', gesture: e.gesture, hand: e.hand }, e.state === 'start')) : null;
  }

  async setGlobal(on: boolean): Promise<GlobalResult> {
    this.globalOn = on;
    const accs = on ? (this.activeKeyBindings().map((b) => toAccelerator(b.trigger)).filter(Boolean) as string[]) : [];
    this.globalStatus = await setGlobalShortcuts(accs, (acc, state) => {
      const b = this.activeKeyBindings().find((x) => toAccelerator(x.trigger) === acc);
      if (b) this.trigger(b.trigger, state === 'Pressed');
    });
    return this.globalStatus;
  }

  /** Re-register global keys after the bindings or the model changed. */
  refresh(): Promise<GlobalResult> | null {
    return this.globalOn ? this.setGlobal(true) : null;
  }

  private activeKeyBindings(): Binding[] {
    const seen = new Set<string>();
    return this.bindings.filter((b) => {
      if (b.trigger.kind !== 'key' || (b.model && b.model !== this.model)) return false;
      const k = triggerKey(b.trigger);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  private parseKey(k: string): Trigger {
    const parts = k.slice(4).split('+');
    const code = parts.pop()!;
    return { kind: 'key', code, ctrl: parts.includes('Ctrl'), alt: parts.includes('Alt'), shift: parts.includes('Shift'), meta: parts.includes('Meta') };
  }

  private onKey(e: KeyboardEvent, pressed: boolean): void {
    if (this.capture && pressed) {
      if (isModifierCode(e.code)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const cb = this.capture;
      this.capture = null;
      if (e.code !== 'Escape') cb(keyTrigger(e));
      else cb({ kind: 'key', code: '' });
      return;
    }
    if (isTyping(e.target)) return;
    if (this.picker?.open && pressed) {
      const nav: Record<string, NavDir> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
      if (nav[e.code]) this.picker.nav(nav[e.code]);
      else if (e.code === 'Enter' || e.code === 'Space') this.picker.select();
      else if (e.code === 'Escape') this.picker.close();
      else {
        // The picker key closes it again; everything else is swallowed.
        const b = resolve(this.bindings, keyTrigger(e), this.model);
        if (b?.action.kind === 'picker') this.picker.close();
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    const t = keyTrigger(e);
    if (pressed && e.repeat) {
      // Swallow auto-repeat of a bound key.
      if (resolve(this.bindings, t, this.model)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      return;
    }
    // A key-up may come with different modifiers than its key-down (Alt released first).
    const tk = pressed ? t : [...this.down].map((k) => this.parseKey(k)).find((d) => d.kind === 'key' && d.code === e.code) ?? t;
    if (this.trigger(tk, pressed)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }

  /** Fire a trigger. Returns true if a binding took it. */
  trigger(t: Trigger, pressed: boolean): boolean {
    if (this.capture && pressed) {
      const cb = this.capture;
      this.capture = null;
      cb(t);
      return true;
    }
    if (this.picker?.open && t.kind === 'pad') {
      if (!pressed) return true;
      if (t.button === 0) this.picker.select();
      else if (t.button === 1) this.picker.close();
      else {
        const b = resolve(this.bindings, t, this.model);
        if (b?.action.kind === 'picker') this.picker.close();
      }
      return true;
    }
    if (this.ui && t.kind === 'pad') {
      const held = this.down.has(triggerKey(t));
      if (this.ui.active && !(held && !pressed)) {
        // D-pad presses arrive through onNav (with the stick); the rest are UI buttons.
        if (pressed && (t.button < 12 || t.button > 15)) this.ui.press(t.button);
        return true;
      }
      if (!this.ui.active && t.button === this.uiMenuButton && !resolve(this.bindings, t, this.model)) {
        if (pressed) this.ui.press(t.button);
        return true;
      }
    }
    if (!this.enabled) return false;
    const k = triggerKey(t);
    // Dedupe: the same press can arrive twice (global shortcut + window key).
    if (pressed) {
      if (this.down.has(k)) return !!resolve(this.bindings, t, this.model);
    } else if (!this.down.has(k)) return !!resolve(this.bindings, t, this.model);
    const b = resolve(this.bindings, t, this.model);
    if (!b) return false;
    if (pressed) this.down.add(k);
    else this.down.delete(k);
    this.actions.run(b.action, pressed);
    if (pressed) this.onFire(b);
    return true;
  }
}
