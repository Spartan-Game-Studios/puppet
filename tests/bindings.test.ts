import { describe, expect, it } from 'vitest';
import {
  activeBindings,
  appKeyConflict,
  defaultBindings,
  findConflicts,
  formatTrigger,
  keyTrigger,
  resolve,
  toAccelerator,
  triggerKey,
  type Binding,
} from '../src/input/bindings';
import { ExpressionOverlay } from '../src/anim/expressions';

const b = (id: string, trigger: Binding['trigger'], action: Binding['action'] = { kind: 'reset' }, model?: string): Binding => ({ id, trigger, action, model });

describe('hotkey bindings', () => {
  it('keys match by code and exact modifiers', () => {
    const all = [b('a', { kind: 'key', code: 'Digit1', alt: true }), b('p', { kind: 'key', code: 'KeyG' })];
    expect(resolve(all, keyTrigger({ code: 'Digit1', altKey: true }), null)?.id).toBe('a');
    expect(resolve(all, keyTrigger({ code: 'Digit1' }), null)).toBeNull();
    expect(resolve(all, keyTrigger({ code: 'Digit1', altKey: true, shiftKey: true }), null)).toBeNull();
    expect(resolve(all, keyTrigger({ code: 'KeyG' }), null)?.id).toBe('p');
  });

  it('gamepad buttons and gestures resolve; hand-specific gestures win', () => {
    const all = [
      b('pad', { kind: 'pad', button: 3 }),
      b('fistAny', { kind: 'gesture', gesture: 'fist', hand: 'any' }),
      b('fistL', { kind: 'gesture', gesture: 'fist', hand: 'left' }),
    ];
    expect(resolve(all, { kind: 'pad', button: 3 }, null)?.id).toBe('pad');
    expect(resolve(all, { kind: 'pad', button: 4 }, null)).toBeNull();
    expect(resolve(all, { kind: 'gesture', gesture: 'fist', hand: 'left' }, null)?.id).toBe('fistL');
    expect(resolve(all, { kind: 'gesture', gesture: 'fist', hand: 'right' }, null)?.id).toBe('fistAny');
    expect(resolve(all, { kind: 'gesture', gesture: 'peace', hand: 'right' }, null)).toBeNull();
  });

  it("a model's own binding overrides the global one on the same trigger", () => {
    const k = { kind: 'key', code: 'Digit1', alt: true } as const;
    const all = [
      b('global', k, { kind: 'expression', name: 'happy', mode: 'toggle', fadeIn: 0.1, fadeOut: 0.1 }),
      b('mine', k, { kind: 'expression', name: 'Smirk', mode: 'toggle', fadeIn: 0.1, fadeOut: 0.1 }, 'hashA'),
    ];
    expect(resolve(all, k, 'hashA')?.id).toBe('mine');
    expect(resolve(all, k, 'hashB')?.id).toBe('global');
    expect(resolve(all, k, null)?.id).toBe('global');
    expect(activeBindings(all, 'hashA')).toHaveLength(1);
    expect(findConflicts(all, 'hashA')).toHaveLength(0);
  });

  it('flags duplicate triggers and app-shortcut clashes', () => {
    const all = [
      b('x', { kind: 'key', code: 'F3' }),
      b('y', { kind: 'key', code: 'F3' }),
      b('h', { kind: 'key', code: 'KeyH' }),
      b('h2', { kind: 'key', code: 'KeyH', shift: true }),
      b('ok', { kind: 'key', code: 'KeyH', alt: true }),
      b('m1', { kind: 'pad', button: 0 }, undefined, 'm'),
      b('m2', { kind: 'pad', button: 0 }, undefined, 'm'),
    ];
    const c = findConflicts(all, 'm');
    const by = new Map(c.map((x) => [x.trigger, x]));
    expect(by.get('key:F3')?.ids).toEqual(['x', 'y']);
    expect(by.get('key:KeyH')?.app).toBe('CAPTURE VIEW');
    expect(by.get('key:Shift+KeyH')?.app).toBe('CAPTURE VIEW');
    expect(by.has('key:Alt+KeyH')).toBe(false);
    expect(by.get('pad:0')?.ids).toEqual(['m1', 'm2']);
    expect(findConflicts(all, 'other').some((x) => x.trigger === 'pad:0')).toBe(false);
  });

  it('the default set has no conflicts and avoids every app key', () => {
    const d = defaultBindings();
    expect(findConflicts(d, null)).toEqual([]);
    for (const x of d) expect(appKeyConflict(x.trigger)).toBeNull();
    expect(new Set(d.map((x) => triggerKey(x.trigger))).size).toBe(d.length);
  });

  it('formats and converts to Tauri accelerators', () => {
    expect(formatTrigger({ kind: 'key', code: 'Digit1', alt: true })).toBe('ALT+1');
    expect(formatTrigger({ kind: 'key', code: 'Digit1', alt: true }, true)).toBe('⌥1');
    expect(formatTrigger({ kind: 'pad', button: 5 })).toBe('PAD RB');
    expect(formatTrigger({ kind: 'gesture', gesture: 'thumbs_up', hand: 'left' })).toBe('THUMBS UP L');
    expect(toAccelerator({ kind: 'key', code: 'Digit1', alt: true })).toBe('Alt+Digit1');
    expect(toAccelerator({ kind: 'key', code: 'F3', ctrl: true, shift: true })).toBe('Control+Shift+F3');
    expect(toAccelerator({ kind: 'pad', button: 1 })).toBeNull();
    expect(toAccelerator({ kind: 'key', code: 'ShiftLeft' })).toBeNull();
  });
});

describe('expression overlay', () => {
  const has = () => true;
  const run = (o: ExpressionOverlay, s: number, base: Record<string, number> = {}) => {
    for (let t = 0; t < s; t += 1 / 60) o.update(1 / 60);
    const v = new Map(Object.entries(base));
    o.apply(v, has);
    return v;
  };

  it('toggle fades on, toggles off, and is exclusive', () => {
    const o = new ExpressionOverlay();
    o.press('happy', 'toggle');
    expect(run(o, 0.5).get('happy')).toBeCloseTo(1);
    o.press('angry', 'toggle');
    const v = run(o, 0.5);
    expect(v.get('angry')).toBeCloseTo(1);
    expect(v.get('happy') ?? 0).toBeCloseTo(0);
    o.press('angry', 'toggle');
    expect(run(o, 0.6).get('angry') ?? 0).toBeCloseTo(0);
    expect(o.active).toEqual([]);
  });

  it('momentary holds only while pressed and stacks with a latched one', () => {
    const o = new ExpressionOverlay();
    o.press('Smirk', 'momentary');
    expect(run(o, 0.3).get('Smirk')).toBeCloseTo(1);
    o.release('Smirk', 'momentary');
    expect(run(o, 0.5).get('Smirk') ?? 0).toBeCloseTo(0);
  });

  it('suppresses competing tracked emotions while up', () => {
    const o = new ExpressionOverlay();
    o.press('angry', 'on');
    const v = run(o, 0.5, { happy: 0.8, aa: 0.5 });
    expect(v.get('happy')).toBeCloseTo(0);
    expect(v.get('aa')).toBe(0.5); // mouth untouched
    o.reset();
    expect(run(o, 0.6, { happy: 0.8 }).get('happy')).toBeCloseTo(0.8);
  });
});
