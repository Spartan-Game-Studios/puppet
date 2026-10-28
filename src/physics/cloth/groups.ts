/**
 * Automatic cloth grouping: which spring chains are neighbouring panels of
 * one piece of cloth (a skirt ring, a cape sheet, a hair fringe), and in what
 * order they sit side by side. Works from rest positions only, so it applies
 * to any VRM.
 *
 * A pair of chains are neighbours when they hang off the same humanoid body
 * part, point the same way, have similar joint counts, and their roots are
 * close compared with the spacing of the other chains there. Connected
 * neighbours form a group; the group is ordered around its axis and is a
 * closed ring when the roots go all the way around (a skirt), else an open
 * sheet split at large gaps.
 */

export type GroupKind = 'skirt' | 'cape' | 'hair' | 'sleeve' | 'other';

export interface ChainInfo {
  name: string;
  /** Nearest humanoid ancestor of the chain root (e.g. 'hips', 'head'). */
  anchor: string;
  /** Rest positions, root head first (avatar space, y up). */
  points: Array<[number, number, number]>;
}

export interface ClothGroup {
  name: string;
  kind: GroupKind;
  closed: boolean;
  /** Chain indices in side-by-side order. */
  chains: number[];
}

type V = [number, number, number];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V) => Math.sqrt(dot(a, a));
const norm = (a: V): V => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export function kindOf(anchor: string, dir: V): GroupKind {
  const down = dir[1] < -0.3;
  if (anchor === 'head' || anchor === 'neck' || /Eye|jaw/i.test(anchor)) return 'hair';
  if (anchor === 'hips' || /UpperLeg|LowerLeg/.test(anchor)) return down ? 'skirt' : 'other';
  if (/Shoulder|UpperArm|LowerArm|Hand/.test(anchor)) return 'sleeve';
  if (/spine|chest|Chest/i.test(anchor)) return down ? 'cape' : 'other';
  return 'other';
}

function chainDir(c: ChainInfo): V {
  return norm(sub(c.points[c.points.length - 1], c.points[0]));
}

/**
 * Order chains side by side around their mean direction. Returns the order
 * and whether they close into a ring.
 */
export function orderChains(chains: ChainInfo[], idx: number[]): { order: number[]; closed: boolean; gaps: number[] } {
  if (idx.length <= 2) return { order: [...idx], closed: false, gaps: [] };
  const roots = idx.map((i) => chains[i].points[0]);
  const mid = idx.map((i) => {
    const p = chains[i].points;
    return p[Math.min(p.length - 1, 1)];
  });
  const c: V = [0, 0, 0];
  for (const r of roots) for (let k = 0; k < 3; k++) c[k] += r[k] / roots.length;
  let axis: V = [0, 0, 0];
  for (const i of idx) {
    const d = chainDir(chains[i]);
    for (let k = 0; k < 3; k++) axis[k] += d[k];
  }
  axis = norm(len(axis) > 1e-6 ? axis : [0, -1, 0]);
  // Basis of the plane across the axis.
  const ref: V = Math.abs(axis[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u = norm(cross(axis, ref));
  const v = cross(axis, u);
  const proj = (p: V): [number, number] => {
    const d = sub(p, c);
    return [dot(d, u), dot(d, v)];
  };
  // Ring test: the chains' first joints spread around the centre in every direction.
  const ang = idx.map((_, k) => {
    // Use the first free joint: roots of a skirt can sit nearly on top of each other.
    const [a, b] = proj(mid[k]);
    return Math.atan2(b, a);
  });
  const radial = idx.map((_, k) => Math.hypot(...proj(mid[k])));
  const sorted = idx.map((i, k) => ({ i, a: ang[k] })).sort((p, q) => p.a - q.a);
  const gapsA: number[] = sorted.map((s, k) => {
    const next = sorted[(k + 1) % sorted.length];
    let g = next.a - s.a;
    if (g <= 0) g += 2 * Math.PI;
    return g;
  });
  const maxGap = Math.max(...gapsA);
  const meanR = radial.reduce((s, r) => s + r, 0) / radial.length;
  const minR = Math.min(...radial);
  const ringy = idx.length >= 4 && maxGap < Math.PI / 2 && minR > 0.35 * meanR;
  if (ringy) return { order: sorted.map((s) => s.i), closed: true, gaps: gapsA };

  // Open sheet: order along the principal direction of the roots in the plane.
  const pts = idx.map((_, k) => proj(mid[k]));
  let sxx = 0, sxy = 0, syy = 0;
  for (const [a, b] of pts) {
    sxx += a * a;
    sxy += a * b;
    syy += b * b;
  }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ex = Math.cos(th), ey = Math.sin(th);
  // An arc (a cape round the shoulders) orders better by angle when it bends
  // a lot; a near-straight row (a fringe) by position along it.
  const tr = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const lmax = tr / 2 + disc, lmin = tr / 2 - disc;
  const straight = lmax <= 0 || lmin / lmax < 0.15;
  const arc = !straight && idx.length >= 4 && maxGap > Math.PI / 2 && minR > 0.35 * meanR;
  let order: number[];
  if (arc) {
    // Start just after the largest angular gap.
    const k0 = gapsA.indexOf(maxGap);
    order = sorted.map((_, k) => sorted[(k0 + 1 + k) % sorted.length].i);
  } else {
    order = idx
      .map((i, k) => ({ i, s: pts[k][0] * ex + pts[k][1] * ey }))
      .sort((p, q) => p.s - q.s)
      .map((p) => p.i);
  }
  return { order, closed: false, gaps: [] };
}

export interface GroupOptions {
  /** Max angle between neighbouring chains' directions. */
  maxAngle: number;
  /** Forced membership: chain name -> group name, or 'none' to keep it single. */
  assign?: Record<string, string>;
  /**
   * True when the straight line between two points passes through the body
   * (e.g. two braids either side of the face): such chains are never linked.
   */
  blocked?: (a: [number, number, number], b: [number, number, number]) => boolean;
}

export const DEFAULT_GROUP_OPTIONS: GroupOptions = { maxAngle: (60 * Math.PI) / 180 };

/** Detect cloth groups. Chains in no group are left out (they stay single strands). */
export function detectGroups(chains: ChainInfo[], opts: GroupOptions = DEFAULT_GROUP_OPTIONS): ClothGroup[] {
  const assign = opts.assign ?? {};
  const n = chains.length;
  const dirs = chains.map(chainDir);
  const lens = chains.map((c) => {
    let s = 0;
    for (let k = 1; k < c.points.length; k++) s += len(sub(c.points[k], c.points[k - 1]));
    return s;
  });
  // Root-to-root spacing uses the first free joint (roots can coincide).
  const key = chains.map((c) => c.points[Math.min(1, c.points.length - 1)]);

  const auto = (i: number) => !assign[chains[i].name] || assign[chains[i].name] === 'auto';
  const compatible = (a: number, b: number) =>
    chains[a].anchor === chains[b].anchor &&
    dot(dirs[a], dirs[b]) > Math.cos(opts.maxAngle) &&
    Math.min(lens[a], lens[b]) > 0.4 * Math.max(lens[a], lens[b]) &&
    chains[a].points.length >= 2 &&
    chains[b].points.length >= 2;

  // Nearest compatible neighbour distance per chain.
  const nearest = new Array(n).fill(Infinity);
  for (let a = 0; a < n; a++) {
    if (!auto(a)) continue;
    for (let b = 0; b < n; b++) {
      if (a === b || !auto(b) || !compatible(a, b)) continue;
      nearest[a] = Math.min(nearest[a], len(sub(key[a], key[b])));
    }
  }
  // Union-find over neighbour pairs.
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let a = 0; a < n; a++) {
    if (!auto(a) || !isFinite(nearest[a])) continue;
    for (let b = a + 1; b < n; b++) {
      if (!auto(b) || !compatible(a, b)) continue;
      const d = len(sub(key[a], key[b]));
      // Neighbours: close relative to both chains' own nearest spacing, and
      // not further apart than the chains are long (strands on opposite
      // sides of a head are not one sheet).
      const limit = Math.min(1.8 * Math.max(nearest[a], nearest[b]), Math.max(0.6 * Math.max(lens[a], lens[b]), 0.12));
      // Hair either side of the face (twin braids, side locks) stays separate:
      // a hair pair may only cross the body's midline (x = 0) when close.
      const hair = chains[a].anchor === 'head' || chains[a].anchor === 'neck';
      const across = key[a][0] * key[b][0] < 0 && Math.abs(key[a][0] - key[b][0]) > 0.06;
      if (d <= limit && !(hair && across) && !opts.blocked?.(key[a], key[b])) parent[find(a)] = find(b);
    }
  }
  const comps = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    if (!auto(i)) continue;
    const r = find(i);
    const k = `auto:${r}`;
    if (!comps.has(k)) comps.set(k, []);
    comps.get(k)!.push(i);
  }
  // Forced groups.
  for (let i = 0; i < n; i++) {
    const g = assign[chains[i].name];
    if (!g || g === 'auto' || g === 'none') continue;
    const k = `user:${g}`;
    if (!comps.has(k)) comps.set(k, []);
    comps.get(k)!.push(i);
  }

  const groups: ClothGroup[] = [];
  const used = new Set<string>();
  for (const [k, members] of comps) {
    if (members.length < 2) continue;
    const { order, closed } = orderChains(chains, members);
    // Split open sheets where a gap is much larger than the typical spacing.
    const parts: number[][] = [];
    if (closed) parts.push(order);
    else {
      const gaps = order.slice(1).map((c, j) => len(sub(key[c], key[order[j]])));
      const med = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] ?? 0;
      let cur = [order[0]];
      for (let j = 1; j < order.length; j++) {
        if (k.startsWith('auto:') && gaps[j - 1] > 2.5 * med && med > 0) {
          parts.push(cur);
          cur = [];
        }
        cur.push(order[j]);
      }
      parts.push(cur);
    }
    for (const part of parts) {
      if (part.length < 2) continue;
      const dir = norm(part.reduce<V>((s, i) => [s[0] + dirs[i][0], s[1] + dirs[i][1], s[2] + dirs[i][2]], [0, 0, 0]));
      const kind = kindOf(chains[part[0]].anchor, dir);
      let name = k.startsWith('user:') ? k.slice(5) : `${kind}:${commonName(part.map((i) => chains[i].name))}`;
      let j = 2;
      const base = name;
      while (used.has(name)) name = `${base}#${j++}`;
      used.add(name);
      groups.push({ name, kind, closed: closed && part.length === order.length, chains: part });
    }
  }
  return groups;
}

/** A short label from member names: their common prefix, or the first name. */
function commonName(names: string[]): string {
  let p = names[0];
  for (const n of names) while (!n.startsWith(p)) p = p.slice(0, -1);
  p = p.replace(/[_\-. #]+$/, '');
  return p.length >= 3 ? p : names[0];
}
