/**
 * Hotkey bindings: a trigger (keyboard key or combo, gamepad button, hand
 * gesture) mapped to an action (emote clip, expression, reset, picker).
 *
 * Pure: resolution, conflicts, formatting and the default set.
 */
import type { ExpressionMode } from '../anim/expressions';
import { t } from '../i18n';

/** i18n t() under another name, for functions whose trigger parameter is called `t`. */
const tr = t;

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
  | { kind: 'picker' }
  /** Turn the virtual camera output on / off (src/app/vcamControls.ts). */
  | { kind: 'camera' };

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

/** Button names as printed on the controller (the d-pad directions are words, so translated). */
export const PAD_NAMES = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'BACK', 'START', 'LS', 'RS', t('motion.pad.up'), t('motion.pad.down'), t('motion.pad.left'), t('motion.pad.right'), 'HOME'];

const GESTURE_LABEL: Record<GestureName, string> = {
  fist: t('motion.gesture.fist'),
  open_palm: t('motion.gesture.open_palm'),
  point: t('motion.gesture.point'),
  peace: t('motion.gesture.peace'),
  thumbs_up: t('motion.gesture.thumbs_up'),
  ok: t('motion.gesture.ok'),
  horns: t('motion.gesture.horns'),
};

export function formatTrigger(t: Trigger, mac = false): string {
  if (t.kind === 'key') {
    const mods = MODS.filter(([m]) => t[m]).map(([m, n]) => (mac ? { ctrl: '⌃', alt: '⌥', shift: '⇧', meta: '⌘' }[m as string] : n.toUpperCase() + '+'));
    return mods.join('') + codeLabel(t.code);
  }
  if (t.kind === 'pad') return tr('motion.trig.pad', { button: PAD_NAMES[t.button] ?? t.button });
  const name = GESTURE_LABEL[t.gesture] ?? t.gesture.replace('_', ' ').toUpperCase();
  return `${name}${t.hand === 'any' ? '' : ` ${tr(t.hand === 'left' ? 'motion.trig.left' : 'motion.trig.right')}`}`;
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
 * VPuppet's own single-key shortcuts (src/main.ts, src/app/home.ts). The app's
 * handler ignores keys with Ctrl/Alt/Meta held but not Shift, so a binding
 * collides with these when it has no modifier or only Shift.
 */
export const APP_KEYS: Record<string, string> = {
  KeyO: t('motion.app.open'), KeyE: t('motion.app.env'), KeyH: t('motion.app.capture'), Escape: t('motion.app.leave'), KeyC: t('motion.app.calibrate'),
  KeyM: t('motion.app.mirror'), KeyT: t('motion.app.preview'), KeyV: t('motion.app.vmc'), KeyW: t('motion.app.vcam'), KeyD: t('motion.app.debug'),
  KeyF: t('motion.app.faceTab'), KeyP: t('motion.app.physicsTab'), KeyR: t('motion.app.settle'), KeyL: t('motion.app.home'), KeyI: t('motion.app.modelInfo'),
  Digit1: t('motion.app.faceMode'), Digit2: t('motion.app.bodyMode'), Digit3: t('motion.app.handsMode'),
  Digit8: t('motion.app.physOff'), Digit9: t('motion.app.physStiff'), Digit0: t('motion.app.physNormal'),
  // HOME screen
  ArrowUp: t('motion.app.homeNav'), ArrowDown: t('motion.app.homeNav'), ArrowLeft: t('motion.app.homeNav'), ArrowRight: t('motion.app.homeNav'),
  Enter: t('motion.app.homeOpen'), KeyS: t('motion.app.homeSort'), F2: t('motion.app.homeRename'), Delete: t('motion.app.homeDelete'), Slash: t('motion.app.homeSearch'),
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
 * d-pad expressions, RB picker, BACK reset, START virtual camera on/off.
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
    [pad(9), { kind: 'camera' }],
  ];
  return list.map(([trigger, action], i) => ({ id: `d${i}`, trigger, action }));
}

/** An expression mode as shown (the stored value stays 'toggle' / 'on' / 'momentary'). */
export const modeLabel = (m: ExpressionMode): string => t(m === 'momentary' ? 'motion.mode.hold' : m === 'on' ? 'motion.mode.on' : 'motion.mode.toggle');

export function describeAction(a: Action, clipLabel: (id: string) => string = (s) => s): string {
  if (a.kind === 'emote') return clipLabel(a.clip);
  if (a.kind === 'expression') return `${a.name.toUpperCase()} ${modeLabel(a.mode)}`;
  if (a.kind === 'reset') return t('motion.act.reset');
  if (a.kind === 'camera') return t('motion.act.camera');
  return t('motion.act.picker');
}

/** Light validation for bindings read from settings. */
export function sanitizeBindings(v: unknown): Binding[] | null {
  if (!Array.isArray(v)) return null;
  return v.filter(
    (b): b is Binding =>
      !!b && typeof b === 'object' && typeof (b as Binding).id === 'string' && !!(b as Binding).trigger && !!(b as Binding).action &&
      ['key', 'pad', 'gesture'].includes((b as Binding).trigger.kind) && ['emote', 'expression', 'reset', 'picker', 'camera'].includes((b as Binding).action.kind),
  );
}
