/**
 * Hotkey bindings: a trigger (keyboard key or combo, gamepad button, hand
 * gesture) mapped to an action (emote clip, expression, reset, picker).
 *
 * Pure: resolution, conflicts, formatting and the default set.
 */
import type { ExpressionMode } from '../anim/expressions';

export type Hand = 'left' | 'right' | 'any';
/** Hand gestures the tracker can report (see gestures.ts). */
export const GESTURES = ['fist', 'open_palm', 'point', 'peace', 'thumbs_up', 'ok', 'horns'] as const;
export type GestureName = (typeof GESTURES)[number];

export interface KeyTrigger {
  kind: 'key';
  /** KeyboardEvent.code, e.g. 'Digit1', 'KeyG', 'F3' (layout independent). */
  code: string;
  alt?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
}
export interface PadTrigger {
  kind: 'pad';
  /** Standard-mapping button index (0 = A / cross ... 15 = d-pad right). */
  button: number;
}
export interface GestureTrigger {
  kind: 'gesture';
  gesture: GestureName;
  hand: Hand;
}
export type Trigger = KeyTrigger | PadTrigger | GestureTrigger;

export type Action =
  | { kind: 'emote'; clip: string }
  | { kind: 'expression'; name: string; mode: ExpressionMode; fadeIn: number; fadeOut: number }
  | { kind: 'reset' }
  | { kind: 'picker' };

export interface Binding {
  id: string;
  trigger: Trigger;
  action: Action;
  /** Model file SHA-256 when this binding belongs to one model (expressions differ per model). */
  model?: string;
}

// ---------------------------------------------------------------- keys

const MODS: Array<[keyof KeyTrigger, string]> = [
  ['ctrl', 'Ctrl'],
  ['alt', 'Alt'],
  ['shift', 'Shift'],
  ['meta', 'Meta'],
];

/** Stable identity of a trigger (two bindings with the same key collide). */
export function triggerKey(t: Trigger): string {
  if (t.kind === 'key') return `key:${MODS.filter(([m]) => t[m]).map(([, n]) => n + '+').join('')}${t.code}`;
  if (t.kind === 'pad') return `pad:${t.button}`;
  return `gesture:${t.gesture}:${t.hand}`;
}

export function keyTrigger(e: { code: string; altKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; metaKey?: boolean }): KeyTrigger {
  const t: KeyTrigger = { kind: 'key', code: e.code };
  if (e.ctrlKey) t.ctrl = true;
  if (e.altKey) t.alt = true;
  if (e.shiftKey) t.shift = true;
  if (e.metaKey) t.meta = true;
  return t;
}

/** Modifier-only codes can't be a binding's key. */
export const isModifierCode = (code: string) => /^(Shift|Control|Alt|Meta|OS|CapsLock|Fn)/.test(code);

const codeLabel = (code: string) =>
  code
    .replace(/^Key/, '')
    .replace(/^Digit/, '')
    .replace(/^Numpad/, 'NUM')
    .replace(/^Arrow/, '')
    .toUpperCase();

export const PAD_NAMES = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'BACK', 'START', 'LS', 'RS', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'HOME'];

export function formatTrigger(t: Trigger, mac = false): string {
  if (t.kind === 'key') {
    const mods = MODS.filter(([m]) => t[m]).map(([m, n]) => (mac ? { ctrl: '⌃', alt: '⌥', shift: '⇧', meta: '⌘' }[m as string] : n.toUpperCase() + '+'));
    return mods.join('') + codeLabel(t.code);
  }
  if (t.kind === 'pad') return `PAD ${PAD_NAMES[t.button] ?? t.button}`;
  return `${t.gesture.replace('_', ' ').toUpperCase()}${t.hand === 'any' ? '' : t.hand === 'left' ? ' L' : ' R'}`;
}

/** Tauri global-shortcut accelerator for a key trigger ('Alt+Digit1', 'F3'). */
export function toAccelerator(t: Trigger): string | null {
  if (t.kind !== 'key' || isModifierCode(t.code)) return null;
  const mods = [t.ctrl && 'Control', t.alt && 'Alt', t.shift && 'Shift', t.meta && 'Super'].filter(Boolean) as string[];
  return [...mods, t.code].join('+');
}

// ---------------------------------------------------------------- resolution

/** Bindings in force for a model: global ones, with that model's own on top (same trigger wins). */
export function activeBindings(all: Binding[], model: string | null): Binding[] {
  const byTrig = new Map<string, Binding>();
  for (const b of all) if (!b.model) byTrig.set(triggerKey(b.trigger), b);
  if (model) for (const b of all) if (b.model === model) byTrig.set(triggerKey(b.trigger), b);
  return [...byTrig.values()];
}

function gestureMatches(bound: GestureTrigger, ev: GestureTrigger): boolean {
  return bound.gesture === ev.gesture && (bound.hand === 'any' || ev.hand === 'any' || bound.hand === ev.hand);
}

/** The binding a trigger fires, or null. Keys match exactly (modifiers included). */
export function resolve(all: Binding[], trigger: Trigger, model: string | null): Binding | null {
  const active = activeBindings(all, model);
  if (trigger.kind === 'gesture') {
    // A hand-specific binding beats an any-hand one.
    const hits = active.filter((b) => b.trigger.kind === 'gesture' && gestureMatches(b.trigger, trigger));
    return hits.find((b) => (b.trigger as GestureTrigger).hand !== 'any') ?? hits[0] ?? null;
  }
  const k = triggerKey(trigger);
  return active.find((b) => triggerKey(b.trigger) === k) ?? null;
}

/**
 * Puppet's own single-key shortcuts (src/main.ts, src/app/home.ts). The app's
 * handler ignores keys with Ctrl/Alt/Meta held but not Shift, so a binding
 * collides with these when it has no modifier or only Shift.
 */
export const APP_KEYS: Record<string, string> = {
  KeyO: 'OPEN VRM', KeyE: '3D ENVIRONMENT', KeyH: 'CAPTURE VIEW', Escape: 'LEAVE CAPTURE / HOME', KeyC: 'CALIBRATE',
  KeyM: 'MIRROR', KeyT: 'PREVIEW', KeyV: 'VMC', KeyW: 'VIRTUAL CAM', KeyD: 'DEBUG BAR', KeyF: 'FACE TAB', KeyP: 'PHYSICS TAB',
  KeyR: 'SETTLE PHYSICS', KeyL: 'HOME', KeyI: 'MODEL INFO', Digit1: 'FACE MODE', Digit2: 'BODY MODE', Digit3: 'HANDS MODE',
  Digit8: 'PHYSICS OFF', Digit9: 'PHYSICS STIFF', Digit0: 'PHYSICS NORMAL',
  // HOME screen
  ArrowUp: 'HOME NAV', ArrowDown: 'HOME NAV', ArrowLeft: 'HOME NAV', ArrowRight: 'HOME NAV', Enter: 'HOME OPEN',
  KeyS: 'HOME SORT', F2: 'HOME RENAME', Delete: 'HOME DELETE', Slash: 'HOME SEARCH',
};

export function appKeyConflict(t: Trigger): string | null {
  if (t.kind !== 'key' || t.alt || t.ctrl || t.meta) return null;
  return APP_KEYS[t.code] ?? null;
}

export interface Conflict {
  trigger: string;
  /** Bindings sharing the trigger (more than one = conflict). */
  ids: string[];
  /** The app shortcut it shadows, if any. */
  app: string | null;
}

/** Duplicate triggers among the bindings in force for a model, and clashes with app shortcuts. */
export function findConflicts(all: Binding[], model: string | null): Conflict[] {
  const scope = all.filter((b) => !b.model || b.model === model);
  const groups = new Map<string, Binding[]>();
  for (const b of scope) {
    const k = triggerKey(b.trigger);
    groups.set(k, [...(groups.get(k) ?? []), b]);
  }
  const out: Conflict[] = [];
  for (const [k, bs] of groups) {
    // A model binding overriding a global one on purpose is not a conflict.
    const sameScope = bs.filter((b) => !b.model).length > 1 || bs.filter((b) => b.model).length > 1;
    const app = appKeyConflict(bs[0].trigger);
    if (sameScope || app) out.push({ trigger: k, ids: bs.map((b) => b.id), app });
  }
  return out;
}

// ---------------------------------------------------------------- defaults

let seq = 0;
export const newBindingId = () => `b${Date.now().toString(36)}${(seq++).toString(36)}`;

const key = (code: string, mods: Partial<KeyTrigger> = {}): KeyTrigger => ({ kind: 'key', code, ...mods });
const pad = (button: number): PadTrigger => ({ kind: 'pad', button });
const expr = (name: string, mode: ExpressionMode = 'toggle'): Action => ({ kind: 'expression', name, mode, fadeIn: 0.15, fadeOut: 0.3 });
const emote = (clip: string): Action => ({ kind: 'emote', clip });

/**
 * Starter set. Keys avoid every app shortcut: expressions on Alt(⌥)+1-6
 * (plain 1/2/3 are the tracking modes), emotes on F3-F10 (F2 renames on
 * HOME), the picker on G. Gamepad (standard mapping): face buttons emote,
 * d-pad expressions, RB picker, BACK reset.
 */
export function defaultBindings(): Binding[] {
  const list: Array<[Trigger, Action]> = [
    [key('Digit1', { alt: true }), expr('happy')],
    [key('Digit2', { alt: true }), expr('angry')],
    [key('Digit3', { alt: true }), expr('sad')],
    [key('Digit4', { alt: true }), expr('relaxed')],
    [key('Digit5', { alt: true }), expr('surprised')],
    [key('Digit6', { alt: true }), { kind: 'reset' }],
    [key('F3'), emote('builtin:wave')],
    [key('F4'), emote('builtin:yes')],
    [key('F5'), emote('builtin:no')],
    [key('F6'), emote('builtin:clap')],
    [key('F7'), emote('builtin:cheer')],
    [key('F8'), emote('builtin:bow')],
    [key('F9'), emote('builtin:shrug')],
    [key('F10'), emote('builtin:think')],
    [key('KeyG'), { kind: 'picker' }],
    [pad(0), emote('builtin:wave')],
    [pad(1), emote('builtin:yes')],
    [pad(2), emote('builtin:clap')],
    [pad(3), emote('builtin:cheer')],
    [pad(12), expr('happy')],
    [pad(15), expr('surprised')],
    [pad(13), expr('sad')],
    [pad(14), expr('angry')],
    [pad(4), emote('builtin:shrug')],
    [pad(5), { kind: 'picker' }],
    [pad(8), { kind: 'reset' }],
  ];
  return list.map(([trigger, action], i) => ({ id: `d${i}`, trigger, action }));
}

export function describeAction(a: Action, clipLabel: (id: string) => string = (s) => s): string {
  if (a.kind === 'emote') return clipLabel(a.clip);
  if (a.kind === 'expression') return `${a.name.toUpperCase()} ${a.mode === 'momentary' ? 'HOLD' : a.mode === 'on' ? 'ON' : 'TOGGLE'}`;
  if (a.kind === 'reset') return 'RESET';
  return 'PICKER';
}

/** Light validation for bindings read from settings. */
export function sanitizeBindings(v: unknown): Binding[] | null {
  if (!Array.isArray(v)) return null;
  return v.filter(
    (b): b is Binding =>
      !!b && typeof b === 'object' && typeof (b as Binding).id === 'string' && !!(b as Binding).trigger && !!(b as Binding).action &&
      ['key', 'pad', 'gesture'].includes((b as Binding).trigger.kind) && ['emote', 'expression', 'reset', 'picker'].includes((b as Binding).action.kind),
  );
}
