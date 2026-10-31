import { describe, expect, it } from 'vitest';
import { buildPerfectSyncMap } from '../src/core/blendshapes';
import { parseVrmMeta, summarizeLicence } from '../src/library/vrmMeta';
import { applyArkit, arkitMatch, doctor, expressionNames, morphTargets, planArkit } from '../src/vrm/doctor';
import { readGlb, writeGlb, type Glb } from '../src/vrm/glb';

// Node's fs without pulling @types/node into the app's tsconfig.
const fsName = 'node:fs';
const { readFileSync } = (await import(/* @vite-ignore */ fsName)) as { readFileSync(p: URL): Uint8Array };

/** A tiny VRM: a face mesh and a teeth mesh sharing some shapes, plus one odd expression. */
function fixture(spec: '0.x' | '1.0'): Glb {
  const face = ['eyeBlink_L', 'eyeBlink_R', 'blendShape1.jawOpen', 'facs_bs_cheekPuff', 'mouthLeft', 'mouth_L', 'unrelated'];
  const teeth = ['blendShape1.jawOpen'];
  const mesh = (names: string[]) => ({ extras: { targetNames: names }, primitives: [{ attributes: {}, targets: names.map(() => ({})) }] });
  const json: Record<string, any> = {
    asset: { version: '2.0' },
    nodes: [{ mesh: 0 }, { mesh: 1 }, { name: 'root' }],
    meshes: [mesh(face), mesh(teeth)],
    buffers: [{ byteLength: 5 }],
  };
  json.extensions =
    spec === '1.0'
      ? { VRMC_vrm: { specVersion: '1.0', meta: { name: 'Test', authors: ['Someone'], licenseUrl: 'x' }, expressions: { preset: { blink: {} }, custom: { MouthSmile_L: {} } } } }
      : { VRM: { meta: { title: 'Test', author: 'Someone' }, blendShapeMaster: { blendShapeGroups: [{ name: 'Blink', presetName: 'blink', binds: [] }, { name: 'MouthSmile_L', binds: [] }] } } };
  return { json, chunks: [{ type: 0x004e4942, data: new Uint8Array([1, 2, 3, 4, 5]) }] };
}

describe('glb', () => {
  it('round-trips a real model byte-exact in its binary chunk', () => {
    const buf = readFileSync(new URL('../test-assets/cc0/devil.vrm', import.meta.url));
    const g = readGlb(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
    const again = readGlb(writeGlb(g));
    expect(again.json).toEqual(g.json);
    expect(again.chunks.length).toBe(g.chunks.length);
    expect(again.chunks[0].data).toEqual(g.chunks[0].data);
  });

  it('pads chunks to 4 bytes', () => {
    const out = writeGlb(fixture('1.0'));
    expect(out.byteLength % 4).toBe(0);
    expect(readGlb(out).chunks[0].data.slice(0, 5)).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });
});

describe('arkit matching', () => {
  it('scores spellings', () => {
    expect(arkitMatch('eyeBlinkLeft', 'EyeBlink_Left')).toBe(2);
    expect(arkitMatch('eyeBlinkLeft', 'eyeBlink_L')).toBe(1);
    expect(arkitMatch('jawOpen', 'blendShape1.jawOpen')).toBe(1);
    expect(arkitMatch('cheekPuff', 'facs_bs_cheekPuff')).toBe(1);
    // "Left" is a direction on mouthLeft: mouth_L is not it.
    expect(arkitMatch('mouthLeft', 'mouth_L')).toBe(0);
    expect(arkitMatch('eyeBlinkLeft', 'eyeBlinkRight')).toBe(0);
  });
});

describe.each(['0.x', '1.0'] as const)('doctor on VRM %s', (spec) => {
  it('plans renames and new expressions from morph targets', () => {
    const g = fixture(spec);
    expect(morphTargets(g.json).map((m) => m.name)).toContain('facs_bs_cheekPuff');
    const plan = planArkit(g.json);
    const byArkit = Object.fromEntries(plan.fixes.map((f) => [f.arkit, f]));
    expect(byArkit.mouthSmileLeft).toMatchObject({ kind: 'rename', expression: 'MouthSmile_L' });
    expect(byArkit.eyeBlinkLeft).toMatchObject({ kind: 'create', morph: 'eyeBlink_L' });
    expect(byArkit.mouthLeft).toMatchObject({ kind: 'create', morph: 'mouthLeft' });
    // jawOpen lives on two meshes: both get bound.
    const jaw = byArkit.jawOpen;
    expect(jaw.kind === 'create' && jaw.binds.map((b) => b.mesh)).toEqual([0, 1]);
    expect(plan.have).toEqual([]);
    expect(plan.missing.length).toBe(52 - plan.fixes.length);
  });

  it('applies them so perfect sync finds every fixed name', () => {
    const g = fixture(spec);
    const plan = planArkit(g.json);
    const out = doctor(g, { arkit: plan.fixes });
    const map = buildPerfectSyncMap(expressionNames(out.json));
    for (const f of plan.fixes) expect(map.get(f.arkit)).toBe(f.arkit);
    expect(expressionNames(g.json)).not.toContain('jawOpen'); // input untouched
    // Re-planning finds nothing more to do, and applying twice changes nothing.
    expect(planArkit(out.json).fixes).toEqual([]);
    const twice = structuredClone(out.json);
    applyArkit(twice, plan.fixes);
    expect(twice).toEqual(out.json);
  });

  it('binds by node on 1.0 and by mesh with 0..100 weights on 0.x', () => {
    const g = fixture(spec);
    const out = doctor(g, { arkit: planArkit(g.json).fixes });
    if (spec === '1.0') {
      expect(out.json.extensions.VRMC_vrm.expressions.custom.jawOpen.morphTargetBinds).toEqual([
        { node: 0, index: 2, weight: 1 },
        { node: 1, index: 0, weight: 1 },
      ]);
    } else {
      const g0 = out.json.extensions.VRM.blendShapeMaster.blendShapeGroups.find((x: any) => x.name === 'jawOpen');
      expect(g0.binds).toEqual([
        { mesh: 0, index: 2, weight: 100 },
        { mesh: 1, index: 0, weight: 100 },
      ]);
    }
  });

  it('writes licence terms the library reads back', () => {
    const g = fixture(spec);
    const cc0 = doctor(g, { terms: { preset: 'cc0', name: 'My Avatar', authors: ['Me'], version: '2' } });
    const m = parseVrmMeta(cc0.json);
    expect(m.name).toBe('My Avatar');
    expect(m.version).toBe('2');
    expect(summarizeLicence(m).badge).toBe('CC0');
    const own = doctor(g, { terms: { preset: 'authorOnly', name: '', authors: [], version: '' } });
    expect(summarizeLicence(parseVrmMeta(own.json)).badge).toBe('AUTHOR ONLY');
    expect(parseVrmMeta(own.json).name).toBe('Test'); // blank name keeps the old one
  });
});
