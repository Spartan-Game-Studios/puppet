/**
 * Frontend half of the local MCP server (the server itself is
 * src-tauri/src/mcp): AI agents on this computer (Claude Code, Claude
 * Desktop, Cursor...) call tools; Rust forwards each call here as an
 * `mcp-call` event and this module answers with `mcp_reply`.
 *
 *   const mcp = mountMcpBridge({ settings, persist, viewer, home, avatar: () => avatar, ... })
 *
 * Self-contained: main.ts passes what the tools need as getters and
 * callbacks (see McpBridgeDeps). It also owns:
 *  - the setting `settings.mcp` ({ enabled, port }, off by default), and the
 *    small control that toggles it (mounted into `deps.mount`);
 *  - `mcpLog`, a ring buffer of recent status lines and errors for
 *    `logs_recent` (main.ts's setStatus pushes into it).
 *
 * Tool definitions (names, schemas, descriptions) live in
 * src-tauri/src/mcp/tools.json; `createMcpTools` here implements them.
 * Messages returned to the agent are English on purpose (they are read by an
 * LLM, not shown in the UI). User-visible UI strings are in MCP_STRINGS.
 */
import './mcpBridge.css';
import { Box3, Mesh, PerspectiveCamera, Texture, Vector2, Vector3, type BufferGeometry, type Material, type SkinnedMesh } from 'three';
import { VRMHumanBoneList, VRMRequiredHumanBoneName, type VRMHumanBoneName } from '@pixiv/three-vrm';
import { ARKIT_NAMES, normName, PERFECT_SYNC_MIN, VRM0_PRESET_NAMES, VRM_PRESETS, type ArkitName } from '../core/blendshapes';
import { boneCoverage } from '../scene/modelChecks';
import { gatherModelFacts, maxSkinBones } from '../scene/modelFacts';
import { framingFor, framingScale, type Framing, type Viewer } from '../scene/viewer';
import type { Avatar, AvatarLayer } from '../scene/avatar';
import type { Settings } from './settings';
import type { Home } from './home';
import type { MotionFeatures } from '../anim/features';
import type { TrackerStats } from '../tracking/tracker';
import type { HandStats } from '../tracking/handStats';
import type { BodyMode } from '../tracking/protocol';
import type { PhysicsMode } from '../physics/stableSprings';
import type { Card } from '../library/library';
import { displayAuthor, displayName } from '../library/libraryIndex';
import { baseName, isTauri } from './platform';
import { doctor, planArkit, TERMS_PRESETS, type Terms } from '../vrm/doctor';
import { readGlb, writeGlb } from '../vrm/glb';

// ---------------------------------------------------------------- UI strings (move into the i18n catalog)

/** Every user-visible string of the control, keyed like the i18n catalog ({var} placeholders). */
export const MCP_STRINGS = {
  'mcp.title': 'AI AGENTS (MCP)',
  'mcp.enable': 'ALLOW AI AGENTS (LOCAL MCP SERVER)',
  'mcp.enableTitle': 'Lets Claude Code, Claude Desktop, Cursor and other MCP clients on this computer inspect and drive VPuppet',
  'mcp.port': 'PORT',
  'mcp.state': 'STATE',
  'mcp.off': 'OFF',
  'mcp.starting': 'STARTING…',
  'mcp.running': 'ON {url}',
  'mcp.calls': '{n} CALLS · LAST {tool}',
  'mcp.error': 'ERROR: {error}',
  'mcp.desktopOnly': 'DESKTOP APP ONLY',
  'mcp.hint': 'Local only (127.0.0.1) and every request needs the token in VPuppet’s config folder. To connect your agents, run the install command in a terminal.',
  'mcp.copyInstall': 'COPY INSTALL COMMAND',
  'mcp.copyClaude': 'COPY CLAUDE CODE COMMAND',
  'mcp.copyClaudeTitle': 'claude mcp add … with the token (keep it private)',
  'mcp.reset': 'NEW TOKEN',
  'mcp.resetTitle': 'Replace the token: connected agents stop working until you run the install command again',
  'mcp.copied': 'COPIED',
} as const;
export type McpStringKey = keyof typeof MCP_STRINGS;
type T = (key: McpStringKey, vars?: Record<string, string | number>) => string;
const defaultT: T = (key, vars) => {
  let s: string = MCP_STRINGS[key];
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
  return s;
};

/** One-liners that register VPuppet with the user's MCP clients (apps/docs/public/mcp/). */
export const INSTALL_SH = 'curl -fsSL https://raw.githubusercontent.com/Spartan-Game-Studios/puppet/main/apps/docs/public/mcp/install.sh | sh';
export const INSTALL_PS1 = 'irm https://raw.githubusercontent.com/Spartan-Game-Studios/puppet/main/apps/docs/public/mcp/install.ps1 | iex';

export const DEFAULT_MCP_PORT = 39540;
export interface McpSettings {
  enabled: boolean;
  port: number;
}

// ---------------------------------------------------------------- log ring buffer

export interface LogLine {
  t: string;
  text: string;
  err: boolean;
}

export class StatusLog {
  private lines: LogLine[] = [];
  constructor(readonly max = 300) {}
  push(text: string, err = false): void {
    const last = this.lines[this.lines.length - 1];
    // The status bar repeats itself (TRACKING, TRACKING...): keep one.
    if (last && last.text === text && last.err === err) return;
    this.lines.push({ t: new Date().toISOString(), text, err });
    if (this.lines.length > this.max) this.lines.splice(0, this.lines.length - this.max);
  }
  recent(limit = 50, errorsOnly = false): LogLine[] {
    const l = errorsOnly ? this.lines.filter((x) => x.err) : this.lines;
    return l.slice(-limit);
  }
  get last(): LogLine | undefined {
    return this.lines[this.lines.length - 1];
  }
}

/** main.ts: `mcpLog.push(s, err)` in setStatus. Console errors/warnings and uncaught errors come in on mount. */
export const mcpLog = new StatusLog(300);

let consoleHooked = false;
function hookConsole(): void {
  if (consoleHooked || typeof window === 'undefined') return;
  consoleHooked = true;
  const str = (a: unknown[]) => a.map((x) => (x instanceof Error ? x.message : typeof x === 'string' ? x : safeJson(x))).join(' ').slice(0, 500);
  for (const level of ['warn', 'error'] as const) {
    const orig = console[level].bind(console);
    console[level] = (...a: unknown[]) => {
      mcpLog.push(`console.${level}: ${str(a)}`, true);
      orig(...a);
    };
  }
  window.addEventListener('error', (e) => mcpLog.push(`uncaught: ${e.message}`, true));
  window.addEventListener('unhandledrejection', (e) => mcpLog.push(`unhandled rejection: ${str([e.reason])}`, true));
}
function safeJson(x: unknown): string {
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}

// ---------------------------------------------------------------- deps

export type BackgroundChoice = 'color' | 'transparent' | 'environment';

export interface McpBridgeDeps {
  /** Reads and writes `settings.mcp` (added with defaults if missing). */
  settings: Settings;
  persist(): void;
  viewer: Viewer;
  home: Home;
  avatar(): Avatar | null;
  /** SHA-256 of the model on the stage (= its library id). */
  modelHash(): string | null;
  motion(): MotionFeatures | null;
  /** main.ts loadModel. */
  loadModel(buf: ArrayBuffer, label: string, path: string | null): Promise<boolean>;
  /** Steam demo out of hours. */
  demoLocked(): boolean;
  tracker: { stats: TrackerStats };
  handStats: HandStats;
  gestures(): { left: string; right: string };
  /** The bottom bar's tracking state (TRACKING, LOST, NO SOURCE...). */
  trackState(): string;
  /** 'camera' | 'file' | 'none'. */
  sourceKind(): string;
  renderFps(): number;
  outputs(): { vmc: boolean; vmcTarget: string; vcam: boolean };
  framing(): Framing;
  /** Setters that also update the UI and persist (as if the user changed them). */
  set: {
    mode(m: BodyMode): void;
    smoothing(v: number): void;
    framing(f: Framing): void;
    background(kind: BackgroundChoice, color?: string): void;
    physicsMode(m: PhysicsMode): void;
  };
  /** Where to put the on/off control (e.g. a div in the VMC modal). Optional. */
  mount?: HTMLElement | null;
  /** Translation (default: MCP_STRINGS). */
  t?: T;
}

export interface McpBridge {
  /** Run a tool here, as the server would (tests, harness). */
  call(tool: string, args?: Record<string, unknown>): Promise<Reply>;
  /** Apply settings.mcp to the server (after a change from elsewhere). */
  apply(): Promise<void>;
  readonly status: McpStatus | null;
}

/** Mirrors `mcp::McpStatus`. */
export interface McpStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  url: string | null;
  error: string | null;
  config_dir: string;
  has_token: boolean;
  calls: number;
  last_tool: string | null;
}

/** What a tool sends back (mirrors `handler::Reply` in Rust). */
export interface Reply {
  text?: string;
  data?: unknown;
  images?: Array<{ data: string; mimeType: string }>;
  error?: string;
}

class ToolError extends Error {}
const fail = (msg: string): never => {
  throw new ToolError(msg);
};

// ---------------------------------------------------------------- tools

type Args = Record<string, unknown>;
export type ToolFn = (args: Args) => Promise<Reply> | Reply;

const str = (v: unknown, name: string, required = false): string | undefined => {
  if (v === undefined || v === null) return required ? fail(`'${name}' is required`) : undefined;
  if (typeof v !== 'string') return fail(`'${name}' must be a string`);
  return v;
};
const num = (v: unknown, name: string, min: number, max: number): number | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) return fail(`'${name}' must be a number`);
  if (v < min || v > max) return fail(`'${name}' must be between ${min} and ${max}`);
  return v;
};
const oneOf = <V extends string>(v: unknown, name: string, allowed: readonly V[]): V | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || !allowed.includes(v as V)) return fail(`'${name}' must be one of ${allowed.join(', ')}`);
  return v as V;
};
const iso = (t: number | null | undefined) => (t ? new Date(t).toISOString() : null);
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

const NO_MODEL = 'NO MODEL ON THE STAGE: load one with library_load (id from library_list) or library_import (a .vrm path).';
const MODES: readonly BodyMode[] = ['face', 'upper', 'hands'];
const FRAMINGS: readonly Framing[] = ['bust', 'upper', 'full'];
const BACKGROUNDS: readonly BackgroundChoice[] = ['color', 'transparent', 'environment'];
const PHYSICS: readonly PhysicsMode[] = ['off', 'stiff', 'normal'];
/** ARKit names whose Left/Right is a direction, not a side of the face. */
const DIRECTIONAL = new Set(['jawLeft', 'jawRight', 'mouthLeft', 'mouthRight']);

/** Is this an absolute path on some OS (the app only reads what the agent names). */
export const isAbsolutePath = (p: string) => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');

/** The tools, by name. Pure dispatch over `deps`, so it is unit-tested without the app. */
export function createMcpTools(deps: McpBridgeDeps): Record<string, ToolFn> {
  const needAvatar = (): Avatar => deps.avatar() ?? fail(deps.demoLocked() ? `${NO_MODEL} (The Steam demo has ended, so models can't be loaded.)` : NO_MODEL);
  const card = (): Card | undefined => {
    const h = deps.modelHash();
    return h ? deps.home.library.cards.get(h) : undefined;
  };
  const pins = new ExpressionPins();

  const modelSummary = (a: Avatar) => ({
    name: a.name,
    id: deps.modelHash(),
    vrm: a.isVrm0 ? '0.x' : '1.0',
    expressions: a.expressionNames.length,
    perfectSync: `${a.perfectSync.size}/52`,
    drivenBy: a.usePerfectSync ? 'perfect sync' : 'VRM presets',
    presets: `${a.presets.size}/13`,
    springChains: a.physics.chains.length,
    warnings: card()?.info.stats.warnings?.map((w) => w.text) ?? [],
  });

  const cardRow = (c: Card) => ({
    id: c.id,
    name: displayName(c),
    author: displayAuthor(c.info) || null,
    file: c.info.fileName,
    vrm: c.info.spec,
    sizeMB: round(c.size / 1048576, 1),
    stats: { perfectSync: `${c.info.stats.perfectSync}/52`, presets: `${c.info.stats.presets}/13`, expressions: c.info.stats.expressions, springChains: c.info.stats.springChains, polygons: c.info.stats.polygons },
    warnings: c.info.stats.warnings?.map((w) => w.text) ?? [],
    licence: c.licence.badge,
    favourite: c.entry.favourite,
    lastUsed: iso(c.entry.lastUsedAt),
    onStage: c.id === deps.modelHash(),
  });

  const findCard = (id: string): Card => {
    const cards = deps.home.library.cards;
    const exact = cards.get(id.toLowerCase());
    if (exact) return exact;
    if (id.length < 8) fail(`no library model '${id}' (use the full id or a prefix of 8+ characters from library_list)`);
    const hits = [...cards.values()].filter((c) => c.id.startsWith(id.toLowerCase()));
    if (hits.length === 1) return hits[0];
    return fail(hits.length ? `'${id}' matches ${hits.length} models; use more characters` : `no library model '${id}' (see library_list)`);
  };

  const load = async (c: Card): Promise<Reply> => {
    if (deps.demoLocked()) fail('Refused: the VPuppet demo has ended, so models cannot be loaded onto the stage.');
    const buf = await deps.home.library.readModel(c.id);
    deps.home.show(false);
    const ok = await deps.loadModel(buf, displayName(c), null);
    if (!ok) fail(`loading failed: ${mcpLog.last?.text ?? 'unknown error'}`);
    const a = deps.avatar();
    return { data: { loaded: true, model: a ? modelSummary(a) : null } };
  };

  const settingsView = () => ({
    mode: deps.settings.mode,
    smoothing: deps.settings.smoothing,
    framing: deps.framing(),
    background: { kind: deps.settings.background.kind, color: deps.settings.background.color },
    physics_mode: deps.settings.physics.mode,
    allowed: { mode: MODES, smoothing: '0..1', framing: FRAMINGS, background: { kind: BACKGROUNDS, color: '#rrggbb' }, physics_mode: PHYSICS },
  });

  return {
    app_status: () => {
      const a = deps.avatar();
      const s = deps.tracker.stats;
      return {
        data: {
          screen: deps.home.visible ? 'HOME (library)' : 'stage',
          model: a ? modelSummary(a) : null,
          heldExpressions: pins.list(a),
          tracking: { mode: deps.settings.mode, state: deps.trackState(), source: deps.sourceKind(), fps: { face: s.face.fps, body: s.body.fps, hands: s.hands.fps } },
          outputs: deps.outputs(),
          renderFps: deps.renderFps(),
          demoLocked: deps.demoLocked(),
          library: deps.home.library.cards.size,
        },
      };
    },

    library_list: (args) => {
      const q = str(args.search, 'search')?.toLowerCase().trim();
      const favs = args.favourites === true;
      const cards = [...deps.home.library.cards.values()]
        .filter((c) => !favs || c.entry.favourite)
        .filter((c) => !q || `${displayName(c)} ${displayAuthor(c.info)} ${c.info.fileName}`.toLowerCase().includes(q))
        .sort((x, y) => (y.entry.lastUsedAt ?? 0) - (x.entry.lastUsedAt ?? 0) || y.entry.addedAt - x.entry.addedAt);
      return { data: { count: cards.length, models: cards.map(cardRow) } };
    },

    library_load: async (args) => load(findCard(str(args.id, 'id', true)!)),

    library_import: async (args) => {
      const path = str(args.path, 'path', true)!;
      if (isTauri && !isAbsolutePath(path)) fail(`'path' must be absolute: ${path}`);
      if (!/\.vrm$/i.test(path)) fail(`not a .vrm file: ${path}`);
      const r = await deps.home.library.import({ name: baseName(path), path });
      if (r.status === 'error') return fail(`import failed: ${r.error}`);
      const c = deps.home.library.cards.get(r.id);
      const out: Record<string, unknown> = { status: r.status, id: r.id, model: c ? cardRow(c) : null };
      if (args.load !== false && c) {
        if (deps.demoLocked()) out.loaded = 'refused: the demo has ended';
        else Object.assign(out, (await load(c)).data as object);
      }
      return { data: out };
    },

    model_inspect: (args) => {
      const a = needAvatar();
      const sections = Array.isArray(args.sections) ? new Set(args.sections.map(String)) : null;
      return { data: inspectModel(a, card(), deps.modelHash(), sections) };
    },

    model_doctor: async (args) => {
      const id = str(args.id, 'id') ?? deps.modelHash() ?? fail('no model on the stage: pass a library id (see library_list)');
      const c = findCard(id);
      const glb = readGlb(await deps.home.library.readModel(c.id));
      const plan = planArkit(glb.json);
      const planOut = {
        model: cardRow(c),
        vrm: plan.spec,
        ready: plan.have,
        fixable: plan.fixes.map((f) => (f.kind === 'rename' ? { arkit: f.arkit, action: 'rename expression', from: f.expression } : { arkit: f.arkit, action: 'new expression', morphTarget: f.morph, meshes: f.binds.length })),
        missing: plan.missing,
      };
      if (args.apply !== true) return { data: { plan: planOut, next: 'call again with apply=true to save the fixed copy as a new library model' } };
      const want = Array.isArray(args.arkit) ? new Set(args.arkit.map(String)) : null;
      const fixes = plan.fixes.filter((f) => !want || want.has(f.arkit));
      let terms: Terms | undefined;
      if (args.terms !== undefined) {
        const t = args.terms as Record<string, unknown>;
        if (t.userOwnsModel !== true) fail('terms need userOwnsModel=true: only set the licence of a model the user made or owns');
        terms = {
          preset: oneOf(t.preset, 'terms.preset', TERMS_PRESETS) ?? fail('terms.preset is required'),
          name: str(t.name, 'terms.name') ?? '',
          authors: Array.isArray(t.authors) ? t.authors.map(String) : [],
          version: str(t.version, 'terms.version') ?? '',
        };
      }
      if (!fixes.length && !terms) fail('nothing to change: no fixable ARKit shapes selected and no terms');
      const bytes = writeGlb(doctor(glb, { arkit: fixes, terms }));
      const name = `${c.info.fileName.replace(/\.vrm$/i, '').replace(/-doctor$/, '')}-doctor.vrm`;
      const r = await deps.home.library.import({ name, bytes });
      if (r.status === 'error') return fail(`saving failed: ${r.error}`);
      const saved = deps.home.library.cards.get(r.id);
      const out: Record<string, unknown> = { status: r.status, id: r.id, fixed: fixes.map((f) => f.arkit), terms: terms?.preset ?? null, model: saved ? cardRow(saved) : null };
      if (args.load !== false && saved) {
        if (deps.demoLocked()) out.loaded = 'refused: the demo has ended';
        else Object.assign(out, (await load(saved)).data as object);
      }
      return { data: out };
    },

    stage_screenshot: (args) => {
      const framing = oneOf(args.framing, 'framing', ['current', 'face', 'bust', 'upper', 'full'] as const) ?? 'current';
      const size = Math.round(num(args.size, 'size', 128, 1536) ?? 768);
      const a = framing === 'current' ? deps.avatar() : needAvatar();
      const canvas = capture(deps.viewer, a, framing, size);
      return { images: [{ data: dataOf(canvas.toDataURL('image/png')), mimeType: 'image/png' }], text: `${canvas.width}x${canvas.height} ${framing}` };
    },

    expression_set: (args) => {
      const a = needAvatar();
      if (args.reset === true) {
        pins.reset(a);
        return { data: { held: [] } };
      }
      const name = resolveExpression(a, str(args.name, 'name', true)!) ?? fail(`the model has no expression '${String(args.name)}' (see model_inspect sections=["expressions"])`);
      const w = num(args.weight, 'weight', 0, 1) ?? 1;
      pins.set(a, name, w, args.exclusive === true);
      return { data: { held: pins.list(a), exclusive: pins.exclusive } };
    },

    expression_sweep: (args) => {
      const a = needAvatar();
      return sweep(deps.viewer, a, {
        set: oneOf(args.set, 'set', ['arkit', 'presets', 'custom', 'all'] as const) ?? 'arkit',
        names: Array.isArray(args.names) ? args.names.map(String) : null,
        framing: oneOf(args.framing, 'framing', ['face', 'bust'] as const) ?? 'face',
        tile: Math.round(num(args.tile, 'tile', 96, 256) ?? 160),
        offset: Math.round(num(args.offset, 'offset', 0, 1e6) ?? 0),
        limit: Math.round(num(args.limit, 'limit', 1, 60) ?? 30),
        image: args.image !== false,
      });
    },

    clip_list: () => {
      const m = deps.motion();
      if (!m) fail('animation clips are not available');
      const playing = new Set(m!.layer?.playing ?? []);
      return {
        data: {
          idle: m!.layer?.idleId ?? deps.settings.anim.idle,
          clips: m!.library.all().map((d) => ({ id: d.id, label: d.label, kind: d.kind, mask: d.mask, loop: d.loop, imported: d.id.startsWith('user:'), playing: playing.has(d.id) })),
        },
      };
    },

    clip_play: async (args) => {
      needAvatar();
      const m = deps.motion();
      const layer = m?.layer ?? fail('animation clips are not available for this model');
      if (args.stop === true) {
        layer.reset();
        return { data: { playing: [] } };
      }
      const q = str(args.clip, 'clip', true)!;
      const all = m!.library.all();
      const low = q.toLowerCase();
      const def =
        all.find((d) => d.id === q) ??
        all.find((d) => d.label.toLowerCase() === low) ??
        (() => {
          const hits = all.filter((d) => d.label.toLowerCase().includes(low));
          return hits.length === 1 ? hits[0] : fail(hits.length ? `'${q}' matches ${hits.map((h) => h.label).join(', ')}` : `no clip '${q}' (see clip_list)`);
        })();
      const before = mcpLog.last;
      await layer.play(def.id);
      if (mcpLog.last !== before && mcpLog.last?.err) fail(mcpLog.last.text);
      return { data: { clip: def.label, id: def.id, loop: def.loop, playing: layer.playing } };
    },

    tracking_stats: () => {
      const s = deps.tracker.stats;
      const hs = deps.handStats;
      const a = deps.avatar();
      const side = (k: 'left' | 'right') => ({ last: hs.last(k), foundPct: round(hs.foundPct(k), 0), counts: hs.counts(k) });
      return {
        data: {
          mode: deps.settings.mode,
          state: deps.trackState(),
          source: deps.sourceKind(),
          where: s.where,
          delegate: s.delegate,
          face: s.face,
          body: s.body,
          hands: s.hands,
          handSearch: deps.settings.mode === 'hands' ? { windowFrames: hs.frames, left: side('left'), right: side('right'), bothPct: round(hs.foundPct('both'), 0), summary: hs.summary() } : null,
          gestures: deps.settings.mode === 'hands' ? deps.gestures() : null,
          avatar: a ? { faceTracked: a.faceTracked, bodyTracked: a.bodyTracked } : null,
          note: 'latency = frame grab to result (ms); infer = model time inside the worker (ms); body.pose/body.hands = per-model ms',
        },
      };
    },

    logs_recent: (args) => {
      const limit = Math.round(num(args.limit, 'limit', 1, 200) ?? 50);
      return { data: { lines: mcpLog.recent(limit, args.errors_only === true) } };
    },

    settings_get: () => ({ data: settingsView() }),

    settings_set: (args) => {
      const allowed = new Set(['mode', 'smoothing', 'framing', 'background', 'physics_mode']);
      const unknown = Object.keys(args).filter((k) => !allowed.has(k));
      if (unknown.length) fail(`not a setting this server may change: ${unknown.join(', ')}`);
      // Validate everything before applying anything.
      const mode = oneOf(args.mode, 'mode', MODES);
      const smoothing = num(args.smoothing, 'smoothing', 0, 1);
      const framing = oneOf(args.framing, 'framing', FRAMINGS);
      const physics = oneOf(args.physics_mode, 'physics_mode', PHYSICS);
      let bg: { kind: BackgroundChoice; color?: string } | undefined;
      if (args.background !== undefined) {
        const b = args.background as Args;
        if (!b || typeof b !== 'object') fail("'background' must be an object");
        const kind = oneOf(b.kind, 'background.kind', BACKGROUNDS);
        const color = str(b.color, 'background.color');
        if (color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(color)) fail("'background.color' must look like #00ff00");
        bg = { kind: kind ?? (color ? 'color' : (deps.settings.background.kind as BackgroundChoice)), color: color?.toLowerCase() };
        if (bg.kind !== 'color' && bg.kind !== 'transparent' && bg.kind !== 'environment') fail("'background.kind' must be color, transparent or environment");
      }
      const changed: string[] = [];
      if (mode) (deps.set.mode(mode), changed.push('mode'));
      if (smoothing !== undefined) (deps.set.smoothing(smoothing), changed.push('smoothing'));
      if (framing) (deps.set.framing(framing), changed.push('framing'));
      if (bg) (deps.set.background(bg.kind, bg.color), changed.push('background'));
      if (physics) (deps.set.physicsMode(physics), changed.push('physics_mode'));
      return { data: { changed, ...settingsView() } };
    },
  };
}

// ---------------------------------------------------------------- expressions

/** Model expression for a name: exact, then VPuppet's matching (case/punctuation), then VRM 0.x preset names. */
export function resolveExpression(a: Pick<Avatar, 'expressionNames'>, name: string): string | null {
  const names = a.expressionNames;
  if (names.includes(name)) return name;
  const n = normName(name);
  const hit = names.find((e) => normName(e) === n);
  if (hit) return hit;
  const preset = (Object.keys(VRM0_PRESET_NAMES) as Array<keyof typeof VRM0_PRESET_NAMES>).find((p) => normName(VRM0_PRESET_NAMES[p]) === n);
  return preset && names.includes(preset) ? preset : null;
}

const PIN = Symbol('mcp-pins');
type PinLayer = AvatarLayer & { [PIN]: true };

/** Expressions held over tracking: a layer wrapped around the avatar's own (the motion layer). */
export class ExpressionPins {
  private held = new Map<string, number>();
  private release = new Set<string>();
  exclusive = false;
  private owner: Avatar | null = null;

  private sync(a: Avatar): void {
    if (this.owner !== a) {
      // A new model: what was held belonged to the old one.
      this.held.clear();
      this.release.clear();
      this.exclusive = false;
      this.owner = a;
    }
    if ((a.layer as PinLayer | null)?.[PIN]) return;
    const inner = a.layer;
    const wrap: PinLayer = {
      [PIN]: true,
      body: (av, dt) => inner?.body(av, dt),
      head: (av, dt) => inner?.head(av, dt),
      expressions: (values, av, dt) => {
        inner?.expressions(values, av, dt);
        if (this.owner !== av) return;
        if (this.exclusive) for (const n of av.expressionNames) values.set(n, 0);
        for (const n of this.release) values.set(n, 0);
        this.release.clear();
        for (const [n, w] of this.held) values.set(n, w);
      },
    };
    a.layer = wrap;
  }

  set(a: Avatar, name: string, w: number, exclusive: boolean): void {
    this.sync(a);
    if (this.exclusive && !exclusive) for (const n of a.expressionNames) this.release.add(n);
    this.exclusive = exclusive;
    this.held.set(name, w);
  }

  reset(a: Avatar): void {
    this.sync(a);
    for (const n of this.held.keys()) this.release.add(n);
    if (this.exclusive) for (const n of a.expressionNames) this.release.add(n);
    this.held.clear();
    this.exclusive = false;
  }

  list(a: Avatar | null): Array<{ name: string; weight: number }> {
    if (!a || a !== this.owner) return [];
    return [...this.held].map(([name, weight]) => ({ name, weight }));
  }
}

interface SweepOptions {
  set: 'arkit' | 'presets' | 'custom' | 'all';
  names: string[] | null;
  framing: 'face' | 'bust';
  tile: number;
  offset: number;
  limit: number;
  image: boolean;
}

interface BindCounts {
  morph: number;
  material: number;
  texture: number;
  /** Morph binds with weight 0 (do nothing). */
  zeroWeight: number;
}

function bindsOf(e: unknown): BindCounts {
  const out: BindCounts = { morph: 0, material: 0, texture: 0, zeroWeight: 0 };
  for (const b of ((e as { _binds?: unknown[] })._binds ?? []) as Array<Record<string, unknown>>) {
    if ('primitives' in b) {
      out.morph++;
      if (b.weight === 0) out.zeroWeight++;
    } else if ('scale' in b && 'offset' in b) out.texture++;
    else out.material++;
  }
  return out;
}

/** Drive each expression to 1 with the pose frozen, compare with neutral, build a contact sheet. */
function sweep(viewer: Viewer, a: Avatar, o: SweepOptions): Reply {
  const em = a.vrm.expressionManager ?? fail('the model has no expressions');
  const byName = new Map(em.expressions.map((e) => [e.expressionName, e]));
  const arkitOf = new Map([...a.perfectSync].map(([k, v]) => [v, k] as [string, ArkitName]));
  let list: Array<{ name: string; arkit?: ArkitName; missing?: boolean }>;
  if (o.names) {
    list = o.names.map((n) => {
      const r = resolveExpression(a, n);
      return r ? { name: r, arkit: arkitOf.get(r) } : { name: n, missing: true };
    });
  } else if (o.set === 'arkit') {
    list = ARKIT_NAMES.filter((k) => a.perfectSync.has(k)).map((k) => ({ name: a.perfectSync.get(k)!, arkit: k }));
  } else {
    const presets = new Set<string>(VRM_PRESETS);
    list = a.expressionNames
      .filter((n) => o.set === 'all' || (o.set === 'presets' ? presets.has(n) : !presets.has(n) && !arkitOf.has(n)))
      .map((n) => ({ name: n, arkit: arkitOf.get(n) }));
  }
  const total = list.length;
  const page = list.slice(o.offset, o.offset + o.limit);
  if (!page.length) {
    return { data: { total, offset: o.offset, note: total ? 'offset is past the end' : `no expressions in set '${o.set}'`, results: [] } };
  }

  const saved = new Map(em.expressions.map((e) => [e.expressionName, e.weight]));
  const zeroAll = () => {
    for (const e of em.expressions) e.weight = 0;
  };
  const W = o.tile;
  const shots: Array<ImageData | null> = [];
  const results: Array<Record<string, unknown>> = [];
  let neutral: ImageData;
  const cap = startCapture(viewer, W, W);
  try {
    zeroAll();
    em.update();
    neutral = cap.shot(a, o.framing);
    for (const it of page) {
      const e = byName.get(it.name);
      if (it.missing || !e) {
        shots.push(null);
        results.push({ name: it.name, error: 'no such expression' });
        continue;
      }
      zeroAll();
      e.weight = 1;
      em.update();
      const img = cap.shot(a, o.framing);
      shots.push(img);
      const binds = bindsOf(e);
      const d = diff(neutral, img);
      const r: Record<string, unknown> = { name: it.name };
      if (it.arkit) r.arkit = it.arkit;
      r.binds = Object.fromEntries(Object.entries(binds).filter(([, v]) => v));
      r.changedPx = d.px;
      r.changedPct = round(d.pct, 2);
      const expect = expectedSide(it.arkit ?? it.name);
      if (d.px >= 4) r.side = d.side;
      const issues: string[] = [];
      if (binds.morph + binds.material + binds.texture === 0) issues.push('unbound (binds nothing)');
      else if (binds.morph && binds.zeroWeight === binds.morph && !binds.material && !binds.texture) issues.push('all binds have weight 0');
      if (d.px < 4 && binds.morph + binds.material + binds.texture > 0) issues.push('no visible change in this framing');
      if (expect && d.px >= 4 && d.side !== 'center' && d.side !== expect) issues.push(`moves the avatar's ${d.side} side, expected ${expect} (Left/Right swapped?)`);
      if (issues.length) r.issues = issues;
      results.push(r);
    }
  } finally {
    for (const e of em.expressions) e.weight = saved.get(e.expressionName) ?? 0;
    em.update();
    cap.end();
  }

  const flagged = results.filter((r) => r.issues || r.error).length;
  const reply: Reply = {
    data: {
      total,
      offset: o.offset,
      count: page.length,
      next: o.offset + page.length < total ? o.offset + page.length : null,
      flagged,
      framing: o.framing,
      note: "Each expression at weight 1, all others 0, pose frozen; compared with the neutral tile (first). side is the avatar's own side (its left is the image's right).",
      results,
    },
  };
  if (o.image) reply.images = [{ data: dataOf(contactSheet(neutral, shots, page.map((p, i) => ({ label: p.name, bad: !!(results[i].issues || results[i].error) })), W).toDataURL('image/jpeg', 0.85)), mimeType: 'image/jpeg' }];
  return reply;
}

/** 'left' / 'right' for names that name a side of the face (ARKit, VRM blinkLeft). */
export function expectedSide(name: string): 'left' | 'right' | null {
  if (DIRECTIONAL.has(name)) return null;
  return /Left$/.test(name) ? 'left' : /Right$/.test(name) ? 'right' : null;
}

/** Changed pixels between two renders, and which side of the avatar they are on. */
export function diff(a: ImageData, b: ImageData, threshold = 10): { px: number; pct: number; side: 'left' | 'right' | 'center' } {
  const w = a.width;
  let px = 0;
  let sx = 0;
  let sw = 0;
  for (let i = 0, p = 0; i < a.data.length; i += 4, p++) {
    const d = (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]) + Math.abs(a.data[i + 3] - b.data[i + 3])) / 3;
    if (d > threshold) {
      px++;
      sx += ((p % w) / (w - 1)) * 2 - 1;
      sw++;
    }
  }
  const cx = sw ? sx / sw : 0;
  // Image right (+x) is the avatar's left: it faces the camera.
  const side = cx > 0.12 ? 'left' : cx < -0.12 ? 'right' : 'center';
  return { px, pct: (100 * px) / (a.width * a.height), side };
}

// ---------------------------------------------------------------- rendering

const dataOf = (url: string) => url.slice(url.indexOf(',') + 1);

/** A camera framing the avatar from the front ('face' is tighter than the stage's bust). */
function frameCamera(a: Avatar, f: 'face' | Framing, fov: number, aspect: number): PerspectiveCamera {
  const cam = new PerspectiveCamera(fov, aspect, 0.01, 100);
  const head = a.headPosition();
  const b = a.bounds;
  let target: Vector3;
  let position: Vector3;
  if (f === 'face') {
    const s = framingScale(b.max.y - b.min.y);
    target = new Vector3(head.x, head.y + 0.06 * s, head.z);
    const dist = (0.2 * s) / Math.tan(((fov / 2) * Math.PI) / 180);
    position = new Vector3(target.x, target.y, Math.max(head.z + dist, b.max.z + 0.05 * s));
  } else {
    ({ target, position } = framingFor(f, head, b, fov));
  }
  cam.position.copy(position);
  cam.lookAt(target);
  cam.near = Math.max(0.005, Math.min(0.05, (position.z - b.max.z) * 0.25));
  cam.updateProjectionMatrix();
  return cam;
}

/**
 * Render at a fixed size with our own camera, read back synchronously (the
 * stage canvas has no preserved drawing buffer), then put the renderer back.
 */
function startCapture(viewer: Viewer, w: number, h: number) {
  const r = viewer.renderer;
  const pr = r.getPixelRatio();
  const size = r.getSize(new Vector2());
  r.setPixelRatio(1);
  r.setSize(w, h, false);
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d', { willReadFrequently: true })!;
  return {
    canvas: out,
    shot(a: Avatar, f: 'face' | Framing): ImageData {
      r.render(viewer.scene, frameCamera(a, f, viewer.camera.fov, w / h));
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(r.domElement, 0, 0, w, h);
      return ctx.getImageData(0, 0, w, h);
    },
    end(): void {
      r.setPixelRatio(pr);
      r.setSize(size.x, size.y, false);
    },
  };
}

function capture(viewer: Viewer, a: Avatar | null, framing: 'current' | 'face' | Framing, size: number): HTMLCanvasElement {
  if (framing === 'current' || !a) {
    // Exactly what the user sees (environment post-processing included), scaled.
    viewer.render();
    const src = viewer.renderer.domElement;
    const k = Math.min(1, size / Math.max(src.width, src.height));
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(src.width * k));
    out.height = Math.max(1, Math.round(src.height * k));
    out.getContext('2d')!.drawImage(src, 0, 0, out.width, out.height);
    return out;
  }
  const h = framing === 'full' ? size : Math.round(size * 0.75);
  const w = framing === 'full' ? Math.round(size * 0.75) : size;
  const cap = startCapture(viewer, w, h);
  try {
    cap.canvas.getContext('2d')!.putImageData(cap.shot(a, framing), 0, 0);
    return cap.canvas;
  } finally {
    cap.end();
  }
}

function contactSheet(neutral: ImageData, shots: Array<ImageData | null>, labels: Array<{ label: string; bad: boolean }>, W: number): HTMLCanvasElement {
  const n = shots.length + 1;
  const cols = Math.min(n, W <= 128 ? 8 : 6);
  const rows = Math.ceil(n / cols);
  const LH = 16;
  const c = document.createElement('canvas');
  c.width = cols * W;
  c.height = rows * (W + LH);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.font = '11px monospace';
  ctx.textBaseline = 'middle';
  const all = [{ img: neutral as ImageData | null, label: 'NEUTRAL', bad: false }, ...shots.map((img, i) => ({ img, ...labels[i] }))];
  all.forEach((t, i) => {
    const x = (i % cols) * W;
    const y = Math.floor(i / cols) * (W + LH);
    if (t.img) {
      // putImageData ignores transforms and alpha compositing: go through a canvas.
      const tc = document.createElement('canvas');
      tc.width = tc.height = W;
      tc.getContext('2d')!.putImageData(t.img, 0, 0);
      ctx.drawImage(tc, x, y);
    }
    ctx.fillStyle = t.bad ? '#ff3b00' : '#111111';
    ctx.fillRect(x, y + W, W, LH);
    ctx.fillStyle = '#ffffff';
    let s = t.label;
    while (s.length > 3 && ctx.measureText(s).width > W - 6) s = s.slice(0, -2) + '…';
    ctx.fillText(s, x + 3, y + W + LH / 2);
    if (t.bad) {
      ctx.strokeStyle = '#ff3b00';
      ctx.lineWidth = 3;
      ctx.strokeRect(x + 1.5, y + 1.5, W - 3, W + LH - 3);
    }
  });
  return c;
}

// ---------------------------------------------------------------- model_inspect

/** Other namings of a missing ARKit shape that VPuppet's matching does not pick up (eyeBlink_L, BlendShape.jawOpen). */
export function nearMisses(arkit: string, expressionNames: readonly string[]): string[] {
  const full = normName(arkit);
  const m = /^(.*)(Left|Right)$/.exec(arkit);
  const keys = [full];
  if (m && !DIRECTIONAL.has(arkit)) {
    const base = normName(m[1]);
    const s = m[2] === 'Left' ? 'l' : 'r';
    keys.push(base + s, base + (s === 'l' ? 'lt' : 'rt'), s + base);
  }
  return expressionNames.filter((e) => {
    const n = normName(e);
    return n !== full && keys.some((k) => n === k || (n.endsWith(k) && n.length > k.length && k.length > 6));
  });
}

export function perfectSyncReport(expressionNames: readonly string[], map: Map<ArkitName, string>) {
  const missing = ARKIT_NAMES.filter((k) => !map.has(k));
  const renamed = [...map].filter(([k, v]) => k !== v).map(([arkit, expression]) => ({ arkit, expression }));
  const near = missing.map((k) => ({ arkit: k, candidates: nearMisses(k, expressionNames) })).filter((x) => x.candidates.length);
  return {
    matched: map.size,
    of: 52,
    isPerfectSync: map.size >= PERFECT_SYNC_MIN,
    threshold: PERFECT_SYNC_MIN,
    matching: 'case- and punctuation-insensitive (EyeBlinkLeft, eye_blink_left and eyeBlinkLeft all match eyeBlinkLeft)',
    missing,
    renamedButMatched: renamed,
    missingButFoundUnderAnotherName: near,
    note: 'tongueOut is not tracked by MediaPipe, so 51 is the useful maximum.',
  };
}

function texturesOf(m: Material, into: Map<string, Texture>): number {
  let n = 0;
  const add = (v: unknown) => {
    if (v instanceof Texture && !into.has(v.uuid)) into.set(v.uuid, v);
    if (v instanceof Texture) n++;
  };
  for (const v of Object.values(m)) add(v);
  const u = (m as { uniforms?: Record<string, { value?: unknown }> }).uniforms;
  if (u) for (const v of Object.values(u)) add(v?.value);
  return n;
}

export function inspectModel(a: Avatar, c: Card | undefined, hash: string | null, sections: Set<string> | null): Record<string, unknown> {
  const want = (s: string) => !sections || sections.has(s);
  const vrm = a.vrm;
  const out: Record<string, unknown> = {};
  const em = vrm.expressionManager;

  if (want('file')) {
    out.file = c
      ? { libraryId: c.id, fileName: c.info.fileName, sizeMB: round(c.size / 1048576, 2), importedAt: iso(c.info.importedAt), sourcePath: c.info.sourcePath }
      : { libraryId: hash, note: 'not in the library (loaded from a URL or path)' };
  }
  if (want('meta')) {
    const m = c?.info.meta;
    out.meta = {
      vrmVersion: a.isVrm0 ? '0.x' : '1.0',
      name: a.name,
      ...(m ? { modelVersion: m.version || null, authors: m.authors, copyright: m.copyright || null, contact: m.contact || null, references: m.references } : {}),
      heightM: round(a.bounds.max.y - a.bounds.min.y, 3),
    };
  }
  if (want('licence')) {
    out.licence = c
      ? {
          badge: c.licence.badge,
          headline: c.licence.headline,
          restricted: c.licence.restricted,
          terms: c.licence.lines.map((l) => `${l.label}: ${l.value}`),
          licenseName: c.info.meta.licenseName || null,
          licenseUrl: c.info.meta.licenseUrl || null,
          otherLicenseUrl: c.info.meta.otherLicenseUrl || null,
        }
      : null;
  }
  if (want('humanoid')) {
    const h = vrm.humanoid;
    const present = (Object.keys(h.humanBones) as VRMHumanBoneName[]).filter((b) => h.getRawBoneNode(b));
    const has = new Set<string>(present);
    const cov = boneCoverage(present);
    out.humanoid = {
      mapped: present.length,
      of: VRMHumanBoneList.length,
      missingVrmRequired: Object.values(VRMRequiredHumanBoneName).filter((b) => !has.has(b)),
      missingForVPuppet: cov.missingRequired,
      missingOptionalForVPuppet: cov.missingOptional,
      fingers: cov.fingers,
      missing: VRMHumanBoneList.filter((b) => !has.has(b)),
      nodes: Object.fromEntries(present.map((b) => [b, h.getRawBoneNode(b)!.name])),
    };
  }
  if (want('expressions')) {
    const presets = new Set<string>(VRM_PRESETS);
    const arkitOf = new Map([...a.perfectSync].map(([k, v]) => [v, k]));
    out.expressions = {
      count: em?.expressions.length ?? 0,
      list: (em?.expressions ?? []).map((e) => {
        const b = bindsOf(e);
        const r: Record<string, unknown> = { name: e.expressionName };
        if (presets.has(e.expressionName)) r.preset = true;
        const k = arkitOf.get(e.expressionName);
        if (k) r.arkit = k;
        r.binds = Object.fromEntries(Object.entries(b).filter(([, v]) => v));
        if (e.isBinary) r.binary = true;
        for (const o of ['overrideBlink', 'overrideLookAt', 'overrideMouth'] as const) if (e[o] !== 'none') r[o] = e[o];
        return r;
      }),
    };
  }
  if (want('perfect_sync')) out.perfect_sync = { ...perfectSyncReport(a.expressionNames, a.perfectSync), drivenBy: a.usePerfectSync ? 'perfect sync (ARKit names 1:1)' : 'VRM presets derived from the ARKit values' };
  if (want('presets')) {
    out.presets = {
      present: VRM_PRESETS.filter((p) => a.presets.has(p)),
      missing: VRM_PRESETS.filter((p) => !a.presets.has(p)),
      ...(a.isVrm0 ? { vrm0Names: VRM0_PRESET_NAMES } : {}),
    };
  }
  if (want('look_at')) {
    const la = vrm.lookAt;
    const type = la ? ((la.applier?.constructor as { type?: string } | undefined)?.type ?? null) : null;
    out.look_at = la
      ? {
          type,
          eyeBones: { left: !!vrm.humanoid.getRawBoneNode('leftEye'), right: !!vrm.humanoid.getRawBoneNode('rightEye') },
          expressions: ['lookUp', 'lookDown', 'lookLeft', 'lookRight'].filter((n) => a.expressionNames.includes(n)),
        }
      : { type: null, note: 'no look-at: gaze is not shown' };
  }
  if (want('springs')) {
    const ph = a.physics;
    out.springs = {
      chains: ph.chains.length,
      joints: ph.jointCount,
      chainList: ph.chains.slice(0, 200).map((ch) => ({ name: ch.name, joints: ch.joints.length })),
      colliders: ph.colliders.filter((x) => x.collider).map((x) => x.name),
      generatedBodyColliders: ph.colliders.filter((x) => x.body).length,
      solver: ph.settings.solver,
      mode: ph.settings.mode,
    };
  }
  if (want('mesh')) {
    let meshes = 0;
    let skinned = 0;
    let triangles = 0;
    let vertices = 0;
    let morphTargets = 0;
    let maxMorphs = 0;
    const mats = new Map<string, { name: string; type: string; transparent: boolean; textures: number }>();
    const texs = new Map<string, Texture>();
    vrm.scene.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh) return;
      meshes++;
      if ((m as SkinnedMesh).isSkinnedMesh) skinned++;
      const g = m.geometry as BufferGeometry;
      const n = g.index ? g.index.count : (g.attributes.position?.count ?? 0);
      triangles += Math.floor(n / 3);
      vertices += g.attributes.position?.count ?? 0;
      const mt = g.morphAttributes.position?.length ?? 0;
      morphTargets += mt;
      maxMorphs = Math.max(maxMorphs, mt);
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        if (!mat || mats.has(mat.uuid)) continue;
        const kind = (mat as { isMToonMaterial?: boolean }).isMToonMaterial ? 'MToon' : mat.type;
        mats.set(mat.uuid, { name: mat.name, type: kind, transparent: mat.transparent, textures: texturesOf(mat, texs) });
      }
    });
    let texBytes = 0;
    const sizes = [...texs.values()].map((t) => {
      const im = t.image as { width?: number; height?: number } | undefined;
      const w = im?.width ?? 0;
      const h = im?.height ?? 0;
      texBytes += w * h * 4 * 1.33;
      return `${w}x${h}`;
    });
    const sizeCounts: Record<string, number> = {};
    for (const s of sizes) sizeCounts[s] = (sizeCounts[s] ?? 0) + 1;
    const box = new Box3().setFromObject(vrm.scene);
    out.mesh = {
      meshes,
      skinnedMeshes: skinned,
      triangles,
      vertices,
      morphTargets,
      maxMorphTargetsPerMesh: maxMorphs,
      maxSkeletonBones: maxSkinBones(vrm.scene),
      materials: mats.size,
      materialTypes: [...mats.values()].reduce<Record<string, number>>((acc, m) => ((acc[m.type] = (acc[m.type] ?? 0) + 1), acc), {}),
      materialList: [...mats.values()].slice(0, 100),
      textures: texs.size,
      textureSizes: sizeCounts,
      textureMemoryMB: round(texBytes / 1048576, 1),
      boundsM: { min: box.min.toArray().map((v) => round(v, 3)), max: box.max.toArray().map((v) => round(v, 3)) },
    };
  }
  if (want('checks')) {
    const f = gatherModelFacts(vrm);
    out.checks = {
      warnings: f.warnings,
      skeletonFacing: f.facing === 1 ? '+Z (toward the camera)' : f.facing === -1 ? '-Z (away from the camera)' : 'unknown',
      faceDirection: f.face ? f.face.map((v) => round(v, 2)) : null,
      faceFrom: f.faceFrom,
      restPose: f.rest,
      boundExpressions: `${f.boundExpressions}/${f.expressions}`,
    };
  }
  return out;
}

// ---------------------------------------------------------------- mount

async function invoke<R>(cmd: string, args?: Record<string, unknown>): Promise<R> {
  const { invoke: inv } = await import('@tauri-apps/api/core');
  return inv<R>(cmd, args);
}

/** Run one tool and turn exceptions into an agent-readable error. */
export async function runTool(tools: Record<string, ToolFn>, tool: string, args: Args = {}): Promise<Reply> {
  const fn = tools[tool];
  if (!fn) return { error: `unknown tool '${tool}'` };
  try {
    return await fn(args ?? {});
  } catch (e) {
    return { error: e instanceof ToolError ? e.message : `${tool} failed: ${(e as Error)?.message ?? String(e)}` };
  }
}

export function mcpSettings(s: Settings): McpSettings {
  const holder = s as Settings & { mcp?: Partial<McpSettings> };
  const m = (holder.mcp ??= {});
  if (typeof m.enabled !== 'boolean') m.enabled = false;
  if (typeof m.port !== 'number' || !(m.port >= 1024 && m.port <= 65535)) m.port = DEFAULT_MCP_PORT;
  return m as McpSettings;
}

export function mountMcpBridge(deps: McpBridgeDeps): McpBridge {
  const t = deps.t ?? defaultT;
  const tools = createMcpTools(deps);
  const cfg = mcpSettings(deps.settings);
  let status: McpStatus | null = null;
  hookConsole();

  // ---------------------------------------------------------------- control
  const root = deps.mount ?? null;
  let render = () => {};
  if (root) {
    root.classList.add('mcp-ctl');
    root.innerHTML = `
      <label class="check" title="${esc(t('mcp.enableTitle'))}"><input type="checkbox" class="mcp-on" /><span>${esc(t('mcp.enable'))}</span></label>
      <label class="row"><span class="lbl">${esc(t('mcp.port'))}</span><input class="mcp-port" type="number" min="1024" max="65535" /></label>
      <div class="row"><span class="lbl">${esc(t('mcp.state'))}</span><span class="val mcp-state"></span></div>
      <div class="row mcp-calls-row"><span class="lbl"></span><span class="val mcp-calls"></span></div>
      <p class="mcp-hint">${esc(t('mcp.hint'))}</p>
      <code class="mcp-cmd" title="${esc(t('mcp.copyInstall'))}"></code>
      <div class="row btns">
        <button type="button" class="btn mcp-copy-install">${esc(t('mcp.copyInstall'))}</button>
      </div>
      <div class="row btns">
        <button type="button" class="btn ghost mcp-copy-claude" title="${esc(t('mcp.copyClaudeTitle'))}">${esc(t('mcp.copyClaude'))}</button>
        <button type="button" class="btn ghost mcp-reset" title="${esc(t('mcp.resetTitle'))}">${esc(t('mcp.reset'))}</button>
      </div>`;
    const q = <E extends HTMLElement>(sel: string) => root.querySelector<E>(sel)!;
    const on = q<HTMLInputElement>('.mcp-on');
    const port = q<HTMLInputElement>('.mcp-port');
    const install = /win/i.test(navigator.platform) ? INSTALL_PS1 : INSTALL_SH;
    q('.mcp-cmd').textContent = install;
    on.addEventListener('change', () => {
      cfg.enabled = on.checked;
      deps.persist();
      void apply();
    });
    port.addEventListener('change', () => {
      const p = Math.round(Number(port.value));
      cfg.port = p >= 1024 && p <= 65535 ? p : DEFAULT_MCP_PORT;
      deps.persist();
      void apply();
    });
    const copy = async (btn: HTMLButtonElement, text: () => Promise<string>) => {
      const label = btn.textContent;
      try {
        await navigator.clipboard.writeText(await text());
        btn.textContent = t('mcp.copied');
        setTimeout(() => (btn.textContent = label), 900);
      } catch (e) {
        mcpLog.push(`MCP: ${e}`, true);
      }
    };
    q<HTMLButtonElement>('.mcp-copy-install').addEventListener('click', (e) => void copy(e.currentTarget as HTMLButtonElement, async () => install));
    q<HTMLButtonElement>('.mcp-copy-claude').addEventListener('click', (e) => void copy(e.currentTarget as HTMLButtonElement, () => invoke<string>('mcp_connect_command')));
    q<HTMLButtonElement>('.mcp-reset').addEventListener('click', async () => {
      if (!isTauri) return;
      status = await invoke<McpStatus>('mcp_reset_token').catch(() => status);
      render();
    });
    render = () => {
      on.checked = cfg.enabled;
      on.disabled = !isTauri;
      if (document.activeElement !== port) port.value = String(cfg.port);
      const st = q('.mcp-state');
      let text: string;
      if (!isTauri) text = t('mcp.desktopOnly');
      else if (status?.error) text = t('mcp.error', { error: status.error });
      else if (status?.running && status.url) text = t('mcp.running', { url: status.url });
      else text = cfg.enabled ? t('mcp.starting') : t('mcp.off');
      st.textContent = text;
      st.title = text;
      st.classList.toggle('status-err', !!status?.error);
      st.classList.toggle('state-run', !!status?.running);
      const calls = q('.mcp-calls-row');
      calls.classList.toggle('hidden', !status?.calls);
      if (status?.calls) q('.mcp-calls').textContent = t('mcp.calls', { n: status.calls, tool: status.last_tool ?? '-' });
      q('.mcp-copy-claude').classList.toggle('hidden', !status?.running);
      q('.mcp-reset').classList.toggle('hidden', !status?.has_token);
    };
    render();
  }

  // ---------------------------------------------------------------- transport
  async function apply(): Promise<void> {
    if (!isTauri) return render();
    try {
      status = await invoke<McpStatus>('mcp_configure', { enabled: cfg.enabled, port: cfg.port });
      if (status.error) mcpLog.push(`MCP: ${status.error}`, true);
    } catch (e) {
      status = { ...(status ?? ({} as McpStatus)), running: false, error: String(e) };
    }
    render();
  }

  if (isTauri) {
    void (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      // Listen first, then tell Rust we're here (mcp_configure marks the bridge ready).
      await listen<{ id: number; tool: string; args: Args }>('mcp-call', async (e) => {
        const { id, tool, args } = e.payload;
        const reply = await runTool(tools, tool, args);
        await invoke('mcp_reply', { id, reply }).catch((err) => console.warn('[mcp] reply failed', err));
        void invoke<McpStatus>('mcp_status').then((s) => ((status = s), render()));
      });
      await apply();
    })();
    setInterval(() => {
      if (!root || !root.isConnected || !root.offsetParent) return;
      void invoke<McpStatus>('mcp_status').then((s) => ((status = s), render())).catch(() => {});
    }, 3000);
  }

  return {
    call: (tool, args) => runTool(tools, tool, args),
    apply,
    get status() {
      return status;
    },
  };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
