import { describe, expect, it } from 'vitest';
import { ClothSolver, closestSegSeg, type EdgeDef } from '../src/physics/cloth/solver';
import { detectGroups, type ChainInfo } from '../src/physics/cloth/groups';

const ID: [number, number, number, number] = [0, 0, 0, 1];
/** Rotation taking +Y to -Y about Z, so a bone with axis +Y hangs down. */
const DOWN: [number, number, number, number] = [0, 0, 1, 0];

/**
 * Hanging chains (one per root), each `n` segments of `seg` metres. Root i
 * sits at roots[i]. Edges: the first hangs from the root frame (DOWN), the
 * rest continue straight.
 */
function hanging(roots: Array<[number, number, number]>, n: number, seg: number) {
  const edges: EdgeDef[] = [];
  let p = 0;
  const chains: number[][] = [];
  for (let c = 0; c < roots.length; c++) {
    const head0 = p++;
    const path = [head0];
    let head = head0;
    let parent = -1;
    for (let k = 0; k < n; k++) {
      const tail = p++;
      edges.push({ head, tail, parent, restLocal: k === 0 ? DOWN : ID, axis: [0, 1, 0], length: seg });
      parent = edges.length - 1;
      head = tail;
      path.push(tail);
    }
    chains.push(path);
  }
  const s = new ClothSolver(p, edges);
  s.setCapsuleCount(0);
  for (let e = 0; e < edges.length; e++) {
    s.stiffness[e] = 0.5;
    s.drag[e] = 0.3;
    s.gravity[3 * e + 1] = -1;
    s.radius[edges[e].tail] = 0.01;
  }
  const setRoots = (offset: [number, number, number] = [0, 0, 0], snap = false) => {
    for (let c = 0; c < roots.length; c++) {
      const r = roots[c];
      s.setRoot(chains[c][0], [r[0] + offset[0], r[1] + offset[1], r[2] + offset[2]], snap);
    }
    for (let e = 0; e < edges.length; e++) if (edges[e].parent < 0) s.setRootFrame(e, ID, snap);
  };
  setRoots([0, 0, 0], true);
  s.resetToRest();
  return { s, edges, chains, setRoots };
}

const P = (s: ClothSolver, i: number): [number, number, number] => [s.x[3 * i], s.x[3 * i + 1], s.x[3 * i + 2]];
const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('closestSegSeg', () => {
  it('finds the crossing point of two perpendicular segments', () => {
    const o = new Float64Array(2);
    closestSegSeg(-1, 0, 0, 1, 0, 0, 0, -1, 1, 0, 1, 1, o);
    expect(o[0]).toBeCloseTo(0.5);
    expect(o[1]).toBeCloseTo(0.5);
  });
  it('clamps to endpoints', () => {
    const o = new Float64Array(2);
    closestSegSeg(0, 0, 0, 1, 0, 0, 2, 1, 0, 3, 1, 0, o);
    expect(o[0]).toBeCloseTo(1);
    expect(o[1]).toBeCloseTo(0);
  });
});

describe('ClothSolver', () => {
  it('rests hanging straight down at rest length', () => {
    const { s, chains } = hanging([[0, 0, 0]], 4, 0.1);
    for (let i = 0; i < 120; i++) s.step(1 / 120);
    const tip = P(s, chains[0][4]);
    expect(tip[0]).toBeCloseTo(0, 4);
    expect(tip[1]).toBeCloseTo(-0.4, 4);
  });

  it('keeps edge lengths exact and converges cross links after a violent shake', () => {
    const roots: Array<[number, number, number]> = [
      [0, 0, 0],
      [0.1, 0, 0],
      [0.2, 0, 0],
    ];
    const { s, edges, chains, setRoots } = hanging(roots, 5, 0.08);
    const links = [];
    for (let c = 0; c + 1 < chains.length; c++) {
      for (let k = 1; k < chains[c].length; k++) links.push({ a: chains[c][k], b: chains[c + 1][k], rest: 0.1, stretch: 0, compress: 1e-5 });
    }
    s.setLinks(links);
    // Shake the roots hard for a second, then hold still.
    for (let i = 0; i < 240; i++) {
      const t = i / 120;
      setRoots(t < 1 ? [0.15 * Math.sin(2 * Math.PI * 3 * t), 0.05 * Math.sin(2 * Math.PI * 5 * t), 0.1 * Math.cos(2 * Math.PI * 2 * t)] : [0, 0, 0.1]);
      s.step(1 / 120);
      for (const e of edges) expect(dist(P(s, e.head), P(s, e.tail))).toBeCloseTo(0.08, 6);
    }
    for (let i = 0; i < 360; i++) {
      setRoots([0, 0, 0.1]);
      s.step(1 / 120);
    }
    for (const l of links) expect(Math.abs(dist(P(s, l.a), P(s, l.b)) - 0.1)).toBeLessThan(0.003);
    // Settled: no residual motion.
    let v = 0;
    for (let i = 0; i < s.nParticles; i++) v = Math.max(v, dist(P(s, i), [s.xp[3 * i], s.xp[3 * i + 1], s.xp[3 * i + 2]]));
    expect(v).toBeLessThan(1e-6);
  });

  it('pushes whole segments out of a capsule', () => {
    // A long-segment chain hanging straight through a capsule that lies across it.
    const { s, chains } = hanging([[0, 0, 0]], 2, 0.3);
    s.setCapsuleCount(1);
    for (let e = 0; e < 2; e++) {
      s.eColliders[e] = Int32Array.from([0]);
      s.eColliderR[e] = Float64Array.from([1]);
    }
    // Capsule along z at y = -0.3, x = +0.02 (slightly off the chain) radius 0.08.
    const cap = { a: [0.02, -0.3, -0.5] as [number, number, number], b: [0.02, -0.3, 0.5] as [number, number, number], r: 0.08 };
    s.setCapsule(0, cap, true);
    for (let i = 0; i < 240; i++) {
      s.setCapsule(0, cap);
      s.step(1 / 120);
    }
    const o = new Float64Array(2);
    const path = chains[0];
    for (let k = 0; k + 1 < path.length; k++) {
      const a = P(s, path[k]);
      const b = P(s, path[k + 1]);
      closestSegSeg(a[0], a[1], a[2], b[0], b[1], b[2], 0.02, -0.3, -0.5, 0.02, -0.3, 0.5, o);
      const p = [a[0] + (b[0] - a[0]) * o[0], a[1] + (b[1] - a[1]) * o[0], a[2] + (b[2] - a[2]) * o[0]];
      const q = [0.02, -0.3, -0.5 + o[1]];
      expect(dist(p, q)).toBeGreaterThan(0.08 + 0.01 - 2e-3);
    }
    // It was pushed to the side away from the capsule (-x).
    expect(P(s, path[2])[0]).toBeLessThan(-0.05);
  });

  it('does not let a fast capsule tunnel through the chain', () => {
    const { s, chains } = hanging([[0, 0, 0]], 6, 0.1);
    s.setCapsuleCount(1);
    for (let e = 0; e < 6; e++) {
      s.eColliders[e] = Int32Array.from([0]);
      s.eColliderR[e] = Float64Array.from([1]);
    }
    s.opts.maxSpeed = 50;
    // A leg-like vertical capsule beside the chain, swung through it at
    // 30 m/s (25 cm per 120 Hz step, 5x its radius), then held.
    const at = (x: number) => ({ a: [x, -0.15, 0] as [number, number, number], b: [x, -0.9, 0] as [number, number, number], r: 0.05 });
    s.setCapsule(0, at(-0.4), true);
    const xs = [-0.4, -0.15, 0.1];
    for (let i = 0; i < 120; i++) {
      const cx = xs[Math.min(xs.length - 1, i)];
      s.setCapsule(0, at(cx));
      s.step(1 / 120);
      // Tunnelling would leave particles behind the capsule.
      for (const p of chains[0]) {
        const [x, y] = P(s, p);
        if (y < -0.2) expect(x).toBeGreaterThan(cx);
      }
    }
    for (const p of chains[0]) {
      const [x, y] = P(s, p);
      if (y < -0.2) expect(x).toBeGreaterThan(0.1 + 0.05 + 0.01 - 2e-3);
    }
  });

  it('a capsule sweep without sub-positions would tunnel (the test is meaningful)', () => {
    const { s, chains } = hanging([[0, 0, 0]], 6, 0.1);
    s.setCapsuleCount(1);
    for (let e = 0; e < 6; e++) {
      s.eColliders[e] = Int32Array.from([0]);
      s.eColliderR[e] = Float64Array.from([1]);
    }
    s.opts.maxSpeed = 50;
    s.opts.iterations = 1;
    const at = (x: number) => ({ a: [x, -0.15, 0] as [number, number, number], b: [x, -0.9, 0] as [number, number, number], r: 0.05 });
    // Teleport the capsule (snap = no sweep) across the chain.
    s.setCapsule(0, at(-0.4), true);
    s.step(1 / 120);
    s.setCapsule(0, at(0.1), true);
    s.step(1 / 120);
    const behind = chains[0].some((p) => P(s, p)[1] < -0.2 && P(s, p)[0] < 0.1);
    expect(behind).toBe(true);
  });

  it('carries roots smoothly across interpolated steps (no explosion on a hitch)', () => {
    const { s, setRoots } = hanging([[0, 0, 0]], 6, 0.1);
    // A 30 cm teleport of the root, delivered as one step.
    setRoots([0.3, 0, 0]);
    s.step(1 / 120);
    let maxStep = 0;
    for (let i = 0; i < s.nParticles; i++) {
      if (s.w[i] === 0) continue;
      maxStep = Math.max(maxStep, dist(P(s, i), [s.xp[3 * i], s.xp[3 * i + 1], s.xp[3 * i + 2]]));
    }
    // Relative velocity is clamped (3 m/s default): the velocity left over is the
    // root's own motion plus at most maxSpeed * h.
    expect(maxStep).toBeLessThan(0.3 + 3 / 120 + 1e-9);
    for (let i = 0; i < 600; i++) {
      setRoots([0.3, 0, 0]);
      s.step(1 / 120);
    }
    for (let i = 0; i < s.nParticles; i++) expect(Number.isFinite(s.x[3 * i])).toBe(true);
  });
});

describe('detectGroups', () => {
  const ring = (n: number, r: number, segs: number, anchor = 'hips'): ChainInfo[] =>
    Array.from({ length: n }, (_, i) => {
      const a = (2 * Math.PI * i) / n;
      const pts: Array<[number, number, number]> = [];
      for (let k = 0; k <= segs; k++) {
        const rr = r + 0.03 * k;
        pts.push([rr * Math.cos(a), 1 - 0.08 * k, rr * Math.sin(a)]);
      }
      return { name: `skirt_${String((i * 7) % n).padStart(2, '0')}_${i}`, anchor, points: pts };
    });

  it('finds a closed skirt ring and orders it around', () => {
    const chains = ring(12, 0.15, 5);
    const g = detectGroups(chains);
    expect(g).toHaveLength(1);
    expect(g[0].closed).toBe(true);
    expect(g[0].kind).toBe('skirt');
    expect(g[0].chains).toHaveLength(12);
    // Consecutive members are angular neighbours.
    const ang = (i: number) => Math.atan2(chains[i].points[1][2], chains[i].points[1][0]);
    for (let k = 0; k < 12; k++) {
      let d = Math.abs(ang(g[0].chains[k]) - ang(g[0].chains[(k + 1) % 12]));
      d = Math.min(d, 2 * Math.PI - d);
      expect(d).toBeCloseTo((2 * Math.PI) / 12, 3);
    }
  });

  it('keeps an open cape sheet open and orders it side to side', () => {
    const chains: ChainInfo[] = [3, 0, 4, 1, 2].map((i) => ({
      name: `cape_${i}`,
      anchor: 'upperChest',
      points: [0, 1, 2, 3].map((k) => [-0.2 + 0.1 * i, 1.4 - 0.12 * k, -0.12 - 0.02 * k] as [number, number, number]),
    }));
    const g = detectGroups(chains);
    expect(g).toHaveLength(1);
    expect(g[0].closed).toBe(false);
    expect(g[0].kind).toBe('cape');
    const xs = g[0].chains.map((i) => chains[i].points[0][0]);
    const asc = [...xs].sort((a, b) => a - b);
    expect(xs.join() === asc.join() || xs.join() === [...asc].reverse().join()).toBe(true);
  });

  it('does not join chains on different body parts or pointing different ways', () => {
    const left = ring(6, 0.1, 3, 'leftUpperArm');
    const right = ring(6, 0.1, 3, 'rightUpperArm').map((c) => ({ ...c, name: `r${c.name}` }));
    const g = detectGroups([...left, ...right]);
    for (const grp of g) {
      const anchors = new Set(grp.chains.map((i) => [...left, ...right][i].anchor));
      expect(anchors.size).toBe(1);
    }
  });

  it('honours forced assignment', () => {
    const chains = ring(8, 0.15, 4);
    const g = detectGroups(chains, { maxAngle: Math.PI / 3, assign: { [chains[0].name]: 'none', [chains[1].name]: 'none' } });
    expect(g[0].chains).not.toContain(0);
    expect(g[0].chains).not.toContain(1);
    expect(g[0].closed).toBe(false);
  });
});
