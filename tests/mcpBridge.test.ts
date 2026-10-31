import { describe, expect, it, vi } from 'vitest';
import {
  createMcpTools,
  diff,
  expectedSide,
  ExpressionPins,
  isAbsolutePath,
  mcpLog,
  mcpSettings,
  nearMisses,
  perfectSyncReport,
  resolveExpression,
  runTool,
  StatusLog,
  type McpBridgeDeps,
} from '../src/app/mcpBridge';
import { buildPerfectSyncMap } from '../src/core/blendshapes';
import { defaultSettings } from '../src/app/settings';
import type { Avatar, AvatarLayer } from '../src/scene/avatar';
import TOOLS from '../src-tauri/src/mcp/tools.json';

const ID_A = 'a'.repeat(8) + '1'.repeat(56);
const ID_B = 'a'.repeat(8) + '2'.repeat(56);
const ID_C = 'c'.repeat(64);

function card(id: string, name: string, lastUsedAt: number | null) {
  return {
    id,
    size: 10 * 1048576,
    entry: { favourite: false, addedAt: 1, lastUsedAt, customName: null, noticeSeen: true },
    info: { fileName: `${name}.vrm`, spec: '1.0', meta: { name, authors: ['Someone'] }, stats: { perfectSync: 52, presets: 13, expressions: 70, springChains: 4, polygons: 1000 } },
    licence: { badge: 'CC0' },
  };
}

function setup(over: Partial<McpBridgeDeps> = {}) {
  const settings = defaultSettings();
  const cards = new Map([ID_A, ID_B, ID_C].map((id, i) => [id, card(id, ['Alice', 'Bob', 'Cat'][i], i)]));
  const set = { mode: vi.fn(), smoothing: vi.fn(), framing: vi.fn(), background: vi.fn(), physicsMode: vi.fn() };
  const loadModel = vi.fn(async () => true);
  const home = {
    visible: true,
    show: vi.fn(),
    library: {
      cards,
      readModel: vi.fn(async () => new ArrayBuffer(4)),
      import: vi.fn(async () => ({ status: 'added', id: ID_C })),
    },
  };
  const deps = {
    settings,
    persist: vi.fn(),
    viewer: {} as never,
    home: home as never,
    avatar: () => null,
    modelHash: () => null,
    motion: () => null,
    loadModel,
    demoLocked: () => false,
    tracker: { stats: { face: { fps: 30, latency: 40, infer: 8 }, body: { fps: 30, latency: 50, infer: 10, pose: 9, hands: 0 }, hands: { fps: 0, latency: 0, infer: 0 }, delegate: 'GPU', where: 'worker' } },
    handStats: {} as never,
    gestures: () => ({ left: 'none', right: 'none' }),
    trackState: () => 'TRACKING',
    sourceKind: () => 'file',
    renderFps: () => 60,
    outputs: () => ({ vmc: false, vmcTarget: '127.0.0.1:39539', vcam: false }),
    framing: () => 'bust' as const,
    set,
    ...over,
  } as McpBridgeDeps;
  return { deps, tools: createMcpTools(deps), set, home, loadModel, settings };
}

describe('mcp bridge: tool dispatch', () => {
  it('implements exactly the tools the server advertises', () => {
    const { tools } = setup();
    expect(Object.keys(tools).sort()).toEqual(TOOLS.map((t) => t.name).sort());
  });

  it('unknown tools and thrown errors come back as agent-readable errors', async () => {
    const { tools } = setup();
    expect((await runTool(tools, 'rm_rf')).error).toMatch(/unknown tool/);
    expect((await runTool(tools, 'model_inspect')).error).toMatch(/^NO MODEL ON THE STAGE/);
    expect((await runTool(tools, 'expression_set', { name: 'happy' })).error).toMatch(/^NO MODEL/);
    expect((await runTool(tools, 'stage_screenshot', { framing: 'face' })).error).toMatch(/^NO MODEL/);
  });

  it('app_status reports the stage, tracking and outputs', async () => {
    const { tools } = setup();
    const r = (await runTool(tools, 'app_status')).data as Record<string, any>;
    expect(r.screen).toBe('HOME (library)');
    expect(r.model).toBeNull();
    expect(r.tracking).toMatchObject({ mode: 'upper', state: 'TRACKING', fps: { face: 30 } });
    expect(r.library).toBe(3);
  });

  it('library_list sorts by last use and filters', async () => {
    const { tools } = setup();
    const r = (await runTool(tools, 'library_list')).data as { models: Array<{ name: string; id: string }> };
    expect(r.models.map((m) => m.name)).toEqual(['Cat', 'Bob', 'Alice']);
    const f = (await runTool(tools, 'library_list', { search: 'bo' })).data as { models: Array<{ name: string }> };
    expect(f.models.map((m) => m.name)).toEqual(['Bob']);
  });

  it('library_load resolves ids and prefixes, and loads onto the stage', async () => {
    const { tools, home, loadModel } = setup();
    expect((await runTool(tools, 'library_load', { id: 'cccccccc' })).error).toBeUndefined();
    expect(home.show).toHaveBeenCalledWith(false);
    expect(loadModel).toHaveBeenCalledWith(expect.any(ArrayBuffer), 'Cat', null);
    expect((await runTool(tools, 'library_load', { id: 'aaaaaaaa' })).error).toMatch(/matches 2 models/);
    expect((await runTool(tools, 'library_load', { id: 'abc' })).error).toMatch(/8\+ characters/);
    expect((await runTool(tools, 'library_load', {})).error).toMatch(/'id' is required/);
    expect((await runTool(tools, 'library_load', { id: ID_B })).error).toBeUndefined();
  });

  it('library_load is refused when the demo has ended', async () => {
    const { tools, loadModel } = setup({ demoLocked: () => true });
    expect((await runTool(tools, 'library_load', { id: ID_C })).error).toMatch(/demo has ended/);
    expect(loadModel).not.toHaveBeenCalled();
    // Importing still works; only the load is refused.
    const r = (await runTool(tools, 'library_import', { path: '/tmp/x.vrm' })).data as Record<string, unknown>;
    expect(r).toMatchObject({ status: 'added', loaded: 'refused: the demo has ended' });
  });

  it('library_import checks the path and reports import errors', async () => {
    const { tools, home } = setup();
    expect((await runTool(tools, 'library_import', { path: '/tmp/x.fbx' })).error).toMatch(/not a \.vrm/);
    home.library.import.mockResolvedValueOnce({ status: 'error', error: 'NOT A VRM (NO VRM EXTENSION)' } as never);
    expect((await runTool(tools, 'library_import', { path: '/tmp/x.vrm' })).error).toMatch(/import failed: NOT A VRM/);
    const r = (await runTool(tools, 'library_import', { path: '/tmp/x.vrm', load: false })).data as Record<string, unknown>;
    expect(r).toMatchObject({ status: 'added', id: ID_C });
    expect(r.loaded).toBeUndefined();
    expect(isAbsolutePath('/Users/me/a.vrm')).toBe(true);
    expect(isAbsolutePath('C:\\Users\\me\\a.vrm')).toBe(true);
    expect(isAbsolutePath('a.vrm')).toBe(false);
    expect(isAbsolutePath('../a.vrm')).toBe(false);
  });

  it('settings_set validates everything first and never touches other settings', async () => {
    const { tools, set } = setup();
    expect((await runTool(tools, 'settings_set', { mcp: { enabled: false } })).error).toMatch(/not a setting/);
    expect((await runTool(tools, 'settings_set', { mode: 'upper', vmc: {} })).error).toMatch(/not a setting/);
    expect((await runTool(tools, 'settings_set', { mode: 'upper', smoothing: 3 })).error).toMatch(/between 0 and 1/);
    expect((await runTool(tools, 'settings_set', { background: { color: 'red' } })).error).toMatch(/#00ff00/);
    expect((await runTool(tools, 'settings_set', { background: { kind: 'image' } })).error).toMatch(/must be one of/);
    expect(set.mode).not.toHaveBeenCalled();
    const r = await runTool(tools, 'settings_set', { mode: 'hands', smoothing: 0.7, framing: 'full', background: { color: '#00FF00' }, physics_mode: 'stiff' });
    expect(r.error).toBeUndefined();
    expect(set.mode).toHaveBeenCalledWith('hands');
    expect(set.smoothing).toHaveBeenCalledWith(0.7);
    expect(set.framing).toHaveBeenCalledWith('full');
    expect(set.background).toHaveBeenCalledWith('color', '#00ff00');
    expect(set.physicsMode).toHaveBeenCalledWith('stiff');
    expect((r.data as { changed: string[] }).changed).toHaveLength(5);
  });

  it('logs_recent reads the ring buffer', async () => {
    const { tools } = setup();
    mcpLog.push('MODEL LOAD FAILED: test', true);
    mcpLog.push('TRACKING');
    const r = (await runTool(tools, 'logs_recent', { limit: 5, errors_only: true })).data as { lines: Array<{ text: string; err: boolean }> };
    expect(r.lines.at(-1)).toMatchObject({ text: 'MODEL LOAD FAILED: test', err: true });
  });
});

describe('mcp bridge: helpers', () => {
  it('StatusLog drops repeats and keeps the newest', () => {
    const l = new StatusLog(3);
    for (const s of ['a', 'a', 'b', 'c', 'd']) l.push(s);
    expect(l.recent(10).map((x) => x.text)).toEqual(['b', 'c', 'd']);
  });

  it('settings.mcp defaults to off on 39540', () => {
    const s = defaultSettings();
    expect(mcpSettings(s)).toEqual({ enabled: false, port: 39540 });
    (s as unknown as { mcp: { port: number } }).mcp.port = 80;
    expect(mcpSettings(s).port).toBe(39540);
  });

  it('resolves expression names the way the app matches them', () => {
    const a = { expressionNames: ['happy', 'EyeBlinkLeft', 'jaw_open', 'Fcl_ALL_Joy'] };
    expect(resolveExpression(a, 'happy')).toBe('happy');
    expect(resolveExpression(a, 'eyeBlinkLeft')).toBe('EyeBlinkLeft');
    expect(resolveExpression(a, 'jawOpen')).toBe('jaw_open');
    expect(resolveExpression(a, 'Joy')).toBe('happy');
    expect(resolveExpression(a, 'sad')).toBeNull();
  });

  it('perfect-sync report finds shapes under other names', () => {
    const names = ['eyeBlink_L', 'eyeBlink_R', 'BlendShape.jawOpen', 'mouthSmileLeft', 'MouthSmileRight', 'jawLeft'];
    const rep = perfectSyncReport(names, buildPerfectSyncMap(names));
    expect(rep.matched).toBe(3);
    expect(rep.isPerfectSync).toBe(false);
    expect(rep.renamedButMatched).toEqual([{ arkit: 'mouthSmileRight', expression: 'MouthSmileRight' }]);
    const near = Object.fromEntries(rep.missingButFoundUnderAnotherName.map((x) => [x.arkit, x.candidates]));
    expect(near.eyeBlinkLeft).toEqual(['eyeBlink_L']);
    expect(near.eyeBlinkRight).toEqual(['eyeBlink_R']);
    expect(near.jawOpen).toEqual(['BlendShape.jawOpen']);
    expect(nearMisses('jawRight', names)).toEqual([]);
  });

  it('side checks: ARKit sides, not directions', () => {
    expect(expectedSide('eyeBlinkLeft')).toBe('left');
    expect(expectedSide('blinkRight')).toBe('right');
    expect(expectedSide('jawLeft')).toBeNull();
    expect(expectedSide('jawOpen')).toBeNull();
  });

  it('diff finds what changed and on which side of the avatar', () => {
    const W = 10;
    const img = () => ({ width: W, height: W, data: new Uint8ClampedArray(W * W * 4) }) as unknown as ImageData;
    const a = img();
    const b = img();
    // Paint the image's right edge (the avatar's left).
    for (let y = 0; y < W; y++) for (const x of [8, 9]) b.data[(y * W + x) * 4] = 255;
    expect(diff(a, b)).toMatchObject({ px: 20, side: 'left' });
    expect(diff(a, a)).toMatchObject({ px: 0, pct: 0 });
  });

  it('expression pins hold values over the avatar layer and release them', () => {
    const inner: AvatarLayer = { body: vi.fn(), head: vi.fn(), expressions: vi.fn((v: Map<string, number>) => v.set('aa', 0.4)) };
    const av = { expressionNames: ['aa', 'happy', 'sad'], layer: inner } as unknown as Avatar;
    const pins = new ExpressionPins();
    pins.set(av, 'happy', 0.8, false);
    pins.set(av, 'happy', 0.9, false); // no double wrap
    const frame = () => {
      const v = new Map<string, number>();
      av.layer!.expressions(v, av, 1 / 60);
      return Object.fromEntries(v);
    };
    expect(frame()).toEqual({ aa: 0.4, happy: 0.9 });
    expect(inner.expressions).toHaveBeenCalledTimes(1);
    pins.set(av, 'sad', 1, true);
    expect(frame()).toEqual({ aa: 0, happy: 0.9, sad: 1 });
    expect(pins.list(av).map((p) => p.name)).toEqual(['happy', 'sad']);
    pins.reset(av);
    expect(frame()).toEqual({ aa: 0, happy: 0, sad: 0 }); // released once
    expect(frame()).toEqual({ aa: 0.4 }); // then back to the layer below
    // Another model: nothing carries over.
    const av2 = { expressionNames: ['x'], layer: null } as unknown as Avatar;
    expect(pins.list(av2)).toEqual([]);
  });
});
