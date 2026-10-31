/**
 * Model doctor: fixes made to a VRM's glTF JSON (see ./glb.ts), so the mesh,
 * skin and textures stay exactly as they were.
 *
 * - Perfect sync: VPuppet drives the expressions named after the 52 ARKit
 *   blendshapes (src/core/blendshapes.ts). Models made in Blender, Daz or
 *   MetaHuman often carry the shapes as morph targets with no VRM expression,
 *   or under another naming (eyeBlink_L, blendShape1.jawOpen). planArkit finds
 *   them; applyArkit renames the expression or creates one bound to the
 *   morph targets (on every mesh that has the shape: face, teeth, lashes).
 * - Licence: applyTerms writes the meta for a model the user owns, in the
 *   model's own VRM version.
 */
import { ARKIT_NAMES, normName, type ArkitName } from '../core/blendshapes';
import type { Glb } from './glb';

export type Spec = '0.x' | '1.0';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

export function specOf(json: Json): Spec | null {
  if (json.extensions?.VRMC_vrm) return '1.0';
  if (json.extensions?.VRM) return '0.x';
  return null;
}

// ---------------------------------------------------------------- morph targets and expressions

export interface MorphTarget {
  mesh: number;
  index: number;
  name: string;
  /** Nodes that use this mesh (VRM 1.0 binds by node). */
  nodes: number[];
}

/** Every named morph target. Names come from mesh.extras.targetNames (Blender, UniVRM) or the first primitive's. */
export function morphTargets(json: Json): MorphTarget[] {
  const nodesOf = new Map<number, number[]>();
  (json.nodes ?? []).forEach((n: Json, i: number) => {
    if (typeof n.mesh === 'number') nodesOf.set(n.mesh, [...(nodesOf.get(n.mesh) ?? []), i]);
  });
  const out: MorphTarget[] = [];
  (json.meshes ?? []).forEach((m: Json, mesh: number) => {
    const names: unknown = m.extras?.targetNames ?? m.primitives?.[0]?.extras?.targetNames;
    const count = m.primitives?.[0]?.targets?.length ?? 0;
    if (!Array.isArray(names)) return;
    names.slice(0, count).forEach((name, index) => {
      if (typeof name === 'string' && name) out.push({ mesh, index, name, nodes: nodesOf.get(mesh) ?? [] });
    });
  });
  return out;
}

/** The model's expression names (VRM 1.0 preset + custom keys; VRM 0.x blend shape group names). */
export function expressionNames(json: Json): string[] {
  const v1 = json.extensions?.VRMC_vrm?.expressions;
  if (v1) return [...Object.keys(v1.preset ?? {}), ...Object.keys(v1.custom ?? {})];
  const groups = json.extensions?.VRM?.blendShapeMaster?.blendShapeGroups;
  return Array.isArray(groups) ? groups.map((g: Json) => String(g.name ?? '')).filter(Boolean) : [];
}

// ---------------------------------------------------------------- ARKit matching

/** "Left"/"Right" here is a direction, not a side: no _L/_R spellings. */
const DIRECTIONAL = new Set<string>(['jawLeft', 'jawRight', 'mouthLeft', 'mouthRight']);

/** Drop exporter prefixes: "blendShape1.jawOpen", "Face|eyeBlink_L", "head:browInnerUp". */
const stripPrefix = (s: string) => s.slice(Math.max(s.lastIndexOf('.'), s.lastIndexOf('|'), s.lastIndexOf(':')) + 1);

/** Spellings that mean `arkit`, normalised. The first is the exact name. */
function spellings(arkit: ArkitName): string[] {
  const keys = [normName(arkit)];
  const m = /^(.*)(Left|Right)$/.exec(arkit);
  if (m && !DIRECTIONAL.has(arkit)) {
    const base = normName(m[1]);
    const s = m[2] === 'Left' ? 'l' : 'r';
    keys.push(base + s, base + (s === 'l' ? 'lt' : 'rt'), s + base, (s === 'l' ? 'left' : 'right') + base);
  }
  return keys;
}

/**
 * How well `name` spells `arkit`: 2 exact (ignoring case/punctuation), 1 another
 * spelling or an exporter prefix, 0 no match. A longer name that merely ends in
 * the ARKit name (facs_bs_eyeBlinkLeft) also counts as 1.
 */
export function arkitMatch(arkit: ArkitName, name: string): 0 | 1 | 2 {
  const keys = spellings(arkit);
  const full = normName(name);
  if (full === keys[0]) return 2;
  const bare = normName(stripPrefix(name));
  if (keys.includes(bare) || keys.includes(full)) return 1;
  if (keys.some((k) => k.length > 6 && full.endsWith(k) && full.length > k.length)) return 1;
  return 0;
}

export type ArkitFix =
  | { arkit: ArkitName; kind: 'rename'; expression: string }
  | { arkit: ArkitName; kind: 'create'; morph: string; binds: MorphTarget[] };

export interface ArkitPlan {
  spec: Spec;
  /** Already driven by perfect sync. */
  have: ArkitName[];
  fixes: ArkitFix[];
  /** Neither an expression nor a morph target found. */
  missing: ArkitName[];
}

export function planArkit(json: Json): ArkitPlan {
  const spec = specOf(json);
  if (!spec) throw new Error('NOT A VRM (NO VRM EXTENSION)');
  const exprs = expressionNames(json);
  const morphs = morphTargets(json);
  const usedExpr = new Set<string>();
  const usedMorph = new Set<string>();
  const have: ArkitName[] = [];
  const fixes: ArkitFix[] = [];
  const missing: ArkitName[] = [];

  // Exact expressions first, so a near spelling never steals one.
  for (const a of ARKIT_NAMES) {
    const e = exprs.find((x) => arkitMatch(a, x) === 2);
    if (e) {
      have.push(a);
      usedExpr.add(e);
    }
  }
  for (const a of ARKIT_NAMES) {
    if (have.includes(a)) continue;
    const e = exprs.find((x) => !usedExpr.has(x) && arkitMatch(a, x) > 0);
    if (e) {
      usedExpr.add(e);
      fixes.push({ arkit: a, kind: 'rename', expression: e });
      continue;
    }
    // Best morph spelling, then every mesh that has a morph of that name.
    let best: MorphTarget | null = null;
    let score = 0;
    for (const m of morphs) {
      if (usedMorph.has(m.name)) continue;
      const s = arkitMatch(a, m.name);
      if (s > score) [best, score] = [m, s];
    }
    if (best) {
      usedMorph.add(best.name);
      fixes.push({ arkit: a, kind: 'create', morph: best.name, binds: morphs.filter((m) => m.name === best!.name) });
    } else missing.push(a);
  }
  return { spec, have, fixes, missing };
}

/** Apply the chosen fixes to the JSON in place. */
export function applyArkit(json: Json, fixes: readonly ArkitFix[]): void {
  const spec = specOf(json);
  if (spec === '1.0') {
    const ex = (json.extensions.VRMC_vrm.expressions ??= {});
    const custom: Json = (ex.custom ??= {});
    for (const f of fixes) {
      if (f.kind === 'rename') {
        if (!(f.expression in custom) || f.arkit in custom) continue; // presets keep their names
        custom[f.arkit] = custom[f.expression];
        delete custom[f.expression];
      } else {
        const binds = f.binds.flatMap((b) => b.nodes.map((node) => ({ node, index: b.index, weight: 1 })));
        if (!binds.length) continue;
        custom[f.arkit] = { morphTargetBinds: binds, isBinary: false, overrideBlink: 'none', overrideLookAt: 'none', overrideMouth: 'none' };
      }
    }
  } else if (spec === '0.x') {
    const master = (json.extensions.VRM.blendShapeMaster ??= {});
    const groups: Json[] = (master.blendShapeGroups ??= []);
    for (const f of fixes) {
      if (groups.some((g) => g.name === f.arkit)) continue;
      if (f.kind === 'rename') {
        const g = groups.find((x) => x.name === f.expression);
        if (g) g.name = f.arkit;
      } else {
        groups.push({
          name: f.arkit,
          presetName: 'unknown',
          binds: f.binds.map((b) => ({ mesh: b.mesh, index: b.index, weight: 100 })),
          materialValues: [],
          isBinary: false,
        });
      }
    }
  }
}

// ---------------------------------------------------------------- licence terms

/** Ready-made terms for a model the user owns. */
export type TermsPreset = 'cc0' | 'ccby' | 'personal' | 'authorOnly';
export const TERMS_PRESETS: readonly TermsPreset[] = ['cc0', 'ccby', 'personal', 'authorOnly'];

export interface Terms {
  preset: TermsPreset;
  name: string;
  authors: string[];
  version: string;
}

const V1_LICENCE_URL = 'https://vrm.dev/licenses/1.0/';
const CC0_URL = 'https://creativecommons.org/publicdomain/zero/1.0/';
const CCBY_URL = 'https://creativecommons.org/licenses/by/4.0/';

/** Write name, authors, version and the preset's terms into the model's meta. */
export function applyTerms(json: Json, t: Terms): void {
  const authors = t.authors.map((a) => a.trim()).filter(Boolean);
  const spec = specOf(json);
  if (spec === '1.0') {
    const meta: Json = (json.extensions.VRMC_vrm.meta ??= {});
    const open = t.preset === 'cc0' || t.preset === 'ccby';
    Object.assign(meta, {
      name: t.name || meta.name || 'Untitled',
      version: t.version,
      authors: authors.length ? authors : meta.authors?.length ? meta.authors : ['Unknown'],
      licenseUrl: V1_LICENCE_URL,
      avatarPermission: t.preset === 'authorOnly' ? 'onlyAuthor' : 'everyone',
      commercialUsage: open ? 'corporation' : 'personalNonProfit',
      creditNotation: t.preset === 'cc0' ? 'unnecessary' : 'required',
      allowRedistribution: open,
      modification: open ? 'allowModificationRedistribution' : t.preset === 'personal' ? 'allowModification' : 'prohibited',
      allowExcessivelyViolentUsage: open,
      allowExcessivelySexualUsage: open,
      allowPoliticalOrReligiousUsage: open,
      allowAntisocialOrHateUsage: false,
      otherLicenseUrl: t.preset === 'cc0' ? CC0_URL : t.preset === 'ccby' ? CCBY_URL : '',
    });
  } else if (spec === '0.x') {
    const meta: Json = (json.extensions.VRM.meta ??= {});
    const open = t.preset === 'cc0' || t.preset === 'ccby';
    Object.assign(meta, {
      title: t.name || meta.title || 'Untitled',
      version: t.version,
      author: authors.join(', ') || meta.author || 'Unknown',
      allowedUserName: t.preset === 'authorOnly' ? 'OnlyAuthor' : 'Everyone',
      violentUssageName: open ? 'Allow' : 'Disallow',
      sexualUssageName: open ? 'Allow' : 'Disallow',
      commercialUssageName: open ? 'Allow' : 'Disallow',
      licenseName: t.preset === 'cc0' ? 'CC0' : t.preset === 'ccby' ? 'CC_BY' : 'Redistribution_Prohibited',
      otherLicenseUrl: '',
    });
  }
}

// ---------------------------------------------------------------- the whole edit

export interface DoctorEdit {
  arkit?: readonly ArkitFix[];
  terms?: Terms;
}

/** A copy of the GLB with the edits applied (the input is not changed). */
export function doctor(g: Glb, edit: DoctorEdit): Glb {
  const json = structuredClone(g.json);
  if (edit.arkit?.length) applyArkit(json, edit.arkit);
  if (edit.terms) applyTerms(json, edit.terms);
  return { json, chunks: g.chunks };
}
