import { describe, expect, it } from 'vitest';
import { ARKIT_NAMES } from '../src/core/blendshapes';
import { derivePresetBlends, withPresetBlends } from '../src/vmc/presets';

const NAMES = ['Blink', 'Blink_L', 'Blink_R', 'A', 'I', 'U', 'E', 'O', 'Joy', 'Angry', 'Sorrow', 'Surprised', 'Fun'];
const asMap = (b: Array<[string, number]>) => new Map(b);

/** A perfect-sync frame as VPuppet sends it: the 52 ARKit names, model spelling. */
function arkitFrame(over: Record<string, number>, spell = (s: string) => s): Array<[string, number]> {
  return ARKIT_NAMES.map((n) => [spell(n), over[n] ?? 0]);
}

describe('VMC preset derivation', () => {
  it('always yields the 13 VRM 0.x presets', () => {
    const p = derivePresetBlends([]);
    expect(p.map(([n]) => n)).toEqual(NAMES);
    expect(p.every(([, v]) => v === 0)).toBe(true);
  });

  it('blink from eyeBlink (shared closure + per-eye remainder)', () => {
    const m = asMap(derivePresetBlends(arkitFrame({ eyeBlinkLeft: 1, eyeBlinkRight: 0.6 })));
    expect(m.get('Blink')).toBeCloseTo(0.6);
    expect(m.get('Blink_L')).toBeCloseTo(0.4);
    expect(m.get('Blink_R')).toBeCloseTo(0);
  });

  it('vowels from jaw and mouth shapes', () => {
    const a = asMap(derivePresetBlends(arkitFrame({ jawOpen: 0.9 })));
    expect(a.get('A')).toBeGreaterThan(0.5);
    const u = asMap(derivePresetBlends(arkitFrame({ mouthPucker: 0.9 })));
    expect(u.get('U')).toBeGreaterThan(0.5);
    expect(u.get('A')).toBe(0);
    const e = asMap(derivePresetBlends(arkitFrame({ mouthStretchLeft: 0.7, mouthStretchRight: 0.7 })));
    expect(e.get('E')).toBeGreaterThan(0.5);
    const o = asMap(derivePresetBlends(arkitFrame({ mouthFunnel: 0.8, jawOpen: 0.4 })));
    expect(o.get('O')).toBeGreaterThan(0.3);
  });

  it('Joy from a smile', () => {
    const m = asMap(derivePresetBlends(arkitFrame({ mouthSmileLeft: 0.9, mouthSmileRight: 0.9 })));
    expect(m.get('Joy')).toBeGreaterThan(0.5);
  });

  it('matches ARKit names however the model spells them', () => {
    const m = asMap(derivePresetBlends(arkitFrame({ eyeBlinkLeft: 1, eyeBlinkRight: 1 }, (s) => s[0].toUpperCase() + s.slice(1))));
    expect(m.get('Blink')).toBeCloseTo(1);
  });

  it("uses the model's own preset values (max with derived)", () => {
    const own: Array<[string, number]> = [['A', 0.7], ['Joy', 1], ['Blink', 0.2]];
    const m = asMap(derivePresetBlends(own));
    expect(m.get('A')).toBe(0.7);
    expect(m.get('Joy')).toBe(1);
    // perfect sync + a hotkey ANGRY on the model's own preset
    const both = asMap(derivePresetBlends([...arkitFrame({ eyeBlinkLeft: 1, eyeBlinkRight: 1 }), ['Angry', 0.8]]));
    expect(both.get('Angry')).toBe(0.8);
    expect(both.get('Blink')).toBeCloseTo(1);
  });

  it('keeps the ARKit values and does not duplicate presets', () => {
    const frame: Array<[string, number]> = [...arkitFrame({ jawOpen: 0.5 }), ['A', 0.1], ['MyCustom', 0.4]];
    const out = withPresetBlends(frame);
    const names = out.map(([n]) => n);
    for (const n of ARKIT_NAMES) expect(names).toContain(n);
    expect(names).toContain('MyCustom');
    for (const n of NAMES) expect(names.filter((x) => x === n)).toHaveLength(1);
    expect(asMap(out).get('jawOpen')).toBe(0.5);
  });

  it('respects the emotions switch', () => {
    const m = asMap(derivePresetBlends(arkitFrame({ mouthSmileLeft: 1, mouthSmileRight: 1 }), { emotions: false, emotionDeadzone: 0.25 }));
    expect(m.get('Joy')).toBe(0);
  });
});
