/**
 * Bone-cloth solver: a position-based (PBD/XPBD, "small steps") solver for
 * spring-bone chains, with cross-chain links that turn neighbouring chains
 * into a cloth lattice, and capsule collision of the chain segments.
 *
 * Plain math on typed arrays, no three.js, so it can be unit-tested and stays
 * cheap. The host (rig.ts) owns the scene graph: it feeds in the animated
 * root positions/rotations and the colliders once per fixed step, and turns
 * the particle positions back into bone rotations afterwards.
 *
 * Model
 *  - Particles are bone heads/tails. A chain root's head is pinned to its
 *    animated bone. Every other particle is free (inverse mass 1).
 *  - An edge is one spring joint (bone -> child). Edges are given in
 *    topological order (parents first). Each edge keeps the bone's rest
 *    local rotation and rest axis, so its rest direction can be rebuilt from
 *    the parent edge's current (simulated) frame, as VRM spring bones do.
 *  - Per step, per edge (VRM semantics, so authored stiffness/drag/gravity
 *    keep their meaning): verlet with (1 - drag) velocity carry, plus a pull
 *    toward the rest direction (stiffness x h) and gravity (power x h).
 *  - Cross links (XPBD distance constraints with separate stretch and
 *    compression compliance) between neighbouring chains.
 *  - Then a root-to-tip pass that makes every edge exactly its rest length,
 *    clamps its angle away from the rest direction, and resolves capsule
 *    contacts of the whole segment (segment vs capsule, not just the tail
 *    point) by swinging the segment about its head, which is already
 *    resolved, so a contact can't push a segment through to the far side.
 *  - Colliders move along a swept path within each step: a fast-moving
 *    capsule is resolved at several interpolated positions, so it can't jump
 *    over a particle in one step (no tunnelling).
 */

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export interface EdgeDef {
  head: number;
  tail: number;
  /** Index of the edge whose tail is this edge's head, or -1 (root edge). */
  parent: number;
  /** Rest local rotation of the bone (relative to its parent bone). */
  restLocal: Quat;
  /** Unit direction head -> tail in the bone's rest local frame. */
  axis: Vec3;
  length: number;
}

export interface LinkDef {
  a: number;
  b: number;
  rest: number;
  /** XPBD compliance (m/N-ish; 0 = rigid) when stretched / compressed. */
  stretch: number;
  compress: number;
}

export interface CapsuleState {
  a: Vec3;
  b: Vec3;
  r: number;
}

export interface SolverOptions {
  /** Max particle speed relative to its chain root, m/s. */
  maxSpeed: number;
  /** 0..1 share of velocity removed on contact. */
  collisionDamping: number;
  /** Constraint iterations per step. */
  iterations: number;
  /** Relative speed under which a particle is considered at rest (m/s). */
  sleepSpeed: number;
  /** Relative speed under which a particle in contact stops sliding (m/s). */
  frictionSpeed: number;
}

export const DEFAULT_SOLVER: SolverOptions = {
  maxSpeed: 3,
  collisionDamping: 0.6,
  iterations: 2,
  sleepSpeed: 0.004,
  frictionSpeed: 0.25,
};

const EPS = 1e-9;

// ---------------------------------------------------------------- small math
function qmul(a: ArrayLike<number>, ao: number, b: ArrayLike<number>, bo: number, out: Float64Array, oo: number): void {
  const ax = a[ao], ay = a[ao + 1], az = a[ao + 2], aw = a[ao + 3];
  const bx = b[bo], by = b[bo + 1], bz = b[bo + 2], bw = b[bo + 3];
  out[oo] = aw * bx + ax * bw + ay * bz - az * by;
  out[oo + 1] = aw * by - ax * bz + ay * bw + az * bx;
  out[oo + 2] = aw * bz + ax * by - ay * bx + az * bw;
  out[oo + 3] = aw * bw - ax * bx - ay * by - az * bz;
}

/** Rotate v by unit quaternion q (at offset), result to out[oo..]. */
function qrot(q: ArrayLike<number>, qo: number, vx: number, vy: number, vz: number, out: Float64Array, oo: number): void {
  const x = q[qo], y = q[qo + 1], z = q[qo + 2], w = q[qo + 3];
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  out[oo] = vx + w * tx + (y * tz - z * ty);
  out[oo + 1] = vy + w * ty + (z * tx - x * tz);
  out[oo + 2] = vz + w * tz + (x * ty - y * tx);
}

/** Shortest-arc rotation taking unit a to unit b, into out[oo..]. */
function qFromUnit(ax: number, ay: number, az: number, bx: number, by: number, bz: number, out: Float64Array, oo: number): void {
  let r = ax * bx + ay * by + az * bz + 1;
  let x: number, y: number, z: number;
  if (r < 1e-8) {
    r = 0;
    if (Math.abs(ax) > Math.abs(az)) {
      x = -ay; y = ax; z = 0;
    } else {
      x = 0; y = -az; z = ay;
    }
  } else {
    x = ay * bz - az * by;
    y = az * bx - ax * bz;
    z = ax * by - ay * bx;
  }
  const n = Math.hypot(x, y, z, r) || 1;
  out[oo] = x / n;
  out[oo + 1] = y / n;
  out[oo + 2] = z / n;
  out[oo + 3] = r / n;
}

function qslerp(a: ArrayLike<number>, ao: number, b: ArrayLike<number>, bo: number, t: number, out: Float64Array, oo: number): void {
  let bx = b[bo], by = b[bo + 1], bz = b[bo + 2], bw = b[bo + 3];
  const ax = a[ao], ay = a[ao + 1], az = a[ao + 2], aw = a[ao + 3];
  let c = ax * bx + ay * by + az * bz + aw * bw;
  if (c < 0) {
    c = -c; bx = -bx; by = -by; bz = -bz; bw = -bw;
  }
  let s0: number, s1: number;
  if (c > 0.9995) {
    s0 = 1 - t;
    s1 = t;
  } else {
    const th = Math.acos(c);
    const s = Math.sin(th);
    s0 = Math.sin((1 - t) * th) / s;
    s1 = Math.sin(t * th) / s;
  }
  const x = ax * s0 + bx * s1, y = ay * s0 + by * s1, z = az * s0 + bz * s1, w = aw * s0 + bw * s1;
  const n = Math.hypot(x, y, z, w) || 1;
  out[oo] = x / n; out[oo + 1] = y / n; out[oo + 2] = z / n; out[oo + 3] = w / n;
}

/**
 * Closest points between segments p0-p1 and q0-q1. Returns [s, t] params.
 * (Standard clamped solution; Ericson, Real-Time Collision Detection 5.1.9.)
 */
export function closestSegSeg(
  p0x: number, p0y: number, p0z: number, p1x: number, p1y: number, p1z: number,
  q0x: number, q0y: number, q0z: number, q1x: number, q1y: number, q1z: number,
  out: Float64Array,
): void {
  const d1x = p1x - p0x, d1y = p1y - p0y, d1z = p1z - p0z;
  const d2x = q1x - q0x, d2y = q1y - q0y, d2z = q1z - q0z;
  const rx = p0x - q0x, ry = p0y - q0y, rz = p0z - q0z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  let s: number, t: number;
  if (a <= EPS && e <= EPS) {
    s = 0; t = 0;
  } else if (a <= EPS) {
    s = 0;
    t = Math.min(1, Math.max(0, f / e));
  } else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= EPS) {
      t = 0;
      s = Math.min(1, Math.max(0, -c / a));
    } else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const den = a * e - b * b;
      s = den > EPS ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = Math.min(1, Math.max(0, -c / a));
      } else if (t > 1) {
        t = 1;
        s = Math.min(1, Math.max(0, (b - c) / a));
      }
    }
  }
  out[0] = s;
  out[1] = t;
}

// ---------------------------------------------------------------- solver
export class ClothSolver {
  readonly nParticles: number;
  readonly nEdges: number;
  opts: SolverOptions;

  /** Positions, previous positions (verlet), xyz interleaved. */
  readonly x: Float64Array;
  readonly xp: Float64Array;
  /** Inverse mass: 0 = pinned (chain root, or disabled edge). */
  readonly w: Float64Array;
  /** Collision radius per particle. */
  readonly radius: Float64Array;
  /** Chain root particle of each particle (for relative-speed clamping). */
  readonly rootOf: Int32Array;

  // Edges
  readonly eHead: Int32Array;
  readonly eTail: Int32Array;
  readonly eParent: Int32Array;
  readonly eRestLocal: Float64Array;
  readonly eAxis: Float64Array;
  readonly eLength: Float64Array;
  /** Per-edge parameters (VRM semantics), set by the host. */
  readonly stiffness: Float64Array;
  readonly drag: Float64Array;
  readonly gravity: Float64Array; // xyz = dir * power
  /** Max angle (rad) between an edge and its rest direction. */
  readonly maxAngle: Float64Array;
  readonly enabled: Uint8Array;
  /** Capsule indices each edge collides with, and the per-pair cap on the contact distance (capsule + particle radius). */
  eColliders: Int32Array[];
  eColliderR: Float64Array[];

  /** Root frames: world rotation of each root edge's parent bone. */
  readonly rootFrame: Float64Array; // per edge (only root edges used), current target
  private rootFramePrev: Float64Array;
  private rootPosPrev: Float64Array; // per particle (only pinned roots used)
  private rootPosNext: Float64Array;
  private pinnedRoots: Int32Array;

  // Links
  lA = new Int32Array(0);
  lB = new Int32Array(0);
  lRest = new Float64Array(0);
  lStretch = new Float64Array(0);
  lCompress = new Float64Array(0);

  // Capsules: previous and next endpoints (per step), radius.
  nCapsules = 0;
  private capPrev = new Float64Array(0);
  private capNext = new Float64Array(0);
  private capR = new Float64Array(0);
  private cap = new Float64Array(0); // interpolated, for the current sub-position
  capEnabled = new Uint8Array(0);

  // Scratch
  private restQ: Float64Array; // per edge rest world rotation (current step)
  private simQ: Float64Array; // per edge simulated world rotation
  private restDir: Float64Array;
  private frameQ: Float64Array; // interpolated root frames
  private hit: Uint8Array;
  private tmp = new Float64Array(8);
  private seg = new Float64Array(2);

  /** Contacts resolved during the last step (debug). */
  contacts = 0;

  constructor(nParticles: number, edges: EdgeDef[], opts: SolverOptions = DEFAULT_SOLVER) {
    this.nParticles = nParticles;
    this.nEdges = edges.length;
    this.opts = { ...opts };
    const n = nParticles;
    const m = edges.length;
    this.x = new Float64Array(3 * n);
    this.xp = new Float64Array(3 * n);
    this.w = new Float64Array(n).fill(1);
    this.radius = new Float64Array(n);
    this.rootOf = new Int32Array(n).fill(-1);
    this.eHead = new Int32Array(m);
    this.eTail = new Int32Array(m);
    this.eParent = new Int32Array(m);
    this.eRestLocal = new Float64Array(4 * m);
    this.eAxis = new Float64Array(3 * m);
    this.eLength = new Float64Array(m);
    this.stiffness = new Float64Array(m).fill(1);
    this.drag = new Float64Array(m).fill(0.4);
    this.gravity = new Float64Array(3 * m);
    this.maxAngle = new Float64Array(m).fill(Math.PI);
    this.enabled = new Uint8Array(m).fill(1);
    this.eColliders = edges.map(() => new Int32Array(0));
    this.eColliderR = edges.map(() => new Float64Array(0));
    this.rootFrame = new Float64Array(4 * m);
    this.rootFramePrev = new Float64Array(4 * m);
    this.frameQ = new Float64Array(4 * m);
    this.restQ = new Float64Array(4 * m);
    this.simQ = new Float64Array(4 * m);
    this.restDir = new Float64Array(3 * m);
    this.rootPosPrev = new Float64Array(3 * n);
    this.rootPosNext = new Float64Array(3 * n);
    this.hit = new Uint8Array(n);

    const pinned: number[] = [];
    edges.forEach((e, i) => {
      if (e.parent >= i) throw new Error('edges must be in topological order');
      this.eHead[i] = e.head;
      this.eTail[i] = e.tail;
      this.eParent[i] = e.parent;
      this.eRestLocal.set(e.restLocal, 4 * i);
      this.eAxis.set(e.axis, 3 * i);
      this.eLength[i] = e.length;
      this.rootFrame[4 * i + 3] = 1;
      this.rootFramePrev[4 * i + 3] = 1;
      if (e.parent < 0) {
        this.w[e.head] = 0;
        pinned.push(e.head);
        this.rootOf[e.head] = e.head;
      }
      this.rootOf[e.tail] = e.parent < 0 ? e.head : this.rootOf[edges[e.parent].tail];
    });
    this.pinnedRoots = Int32Array.from(new Set(pinned));
    for (let p = 0; p < n; p++) if (this.rootOf[p] < 0) this.rootOf[p] = p;
  }

  setLinks(links: LinkDef[]): void {
    const k = links.length;
    this.lA = new Int32Array(k);
    this.lB = new Int32Array(k);
    this.lRest = new Float64Array(k);
    this.lStretch = new Float64Array(k);
    this.lCompress = new Float64Array(k);
    links.forEach((l, i) => {
      this.lA[i] = l.a;
      this.lB[i] = l.b;
      this.lRest[i] = l.rest;
      this.lStretch[i] = l.stretch;
      this.lCompress[i] = l.compress;
    });
  }

  setCapsuleCount(n: number): void {
    this.nCapsules = n;
    this.capPrev = new Float64Array(6 * n);
    this.capNext = new Float64Array(6 * n);
    this.cap = new Float64Array(6 * n);
    this.capR = new Float64Array(n);
    this.capEnabled = new Uint8Array(n).fill(1);
  }

  /** Set a capsule's target for the coming step. `snap` also sets its start. */
  setCapsule(i: number, c: CapsuleState, snap = false): void {
    const o = 6 * i;
    const nx = this.capNext;
    if (snap) {
      this.capPrev[o] = c.a[0]; this.capPrev[o + 1] = c.a[1]; this.capPrev[o + 2] = c.a[2];
      this.capPrev[o + 3] = c.b[0]; this.capPrev[o + 4] = c.b[1]; this.capPrev[o + 5] = c.b[2];
    } else {
      for (let k = 0; k < 6; k++) this.capPrev[o + k] = nx[o + k];
    }
    nx[o] = c.a[0]; nx[o + 1] = c.a[1]; nx[o + 2] = c.a[2];
    nx[o + 3] = c.b[0]; nx[o + 4] = c.b[1]; nx[o + 5] = c.b[2];
    this.capR[i] = c.r;
  }

  /** Set a pinned root particle's target position for the coming step. */
  setRoot(p: number, pos: Vec3, snap = false): void {
    const o = 3 * p;
    if (snap) {
      this.rootPosPrev[o] = pos[0]; this.rootPosPrev[o + 1] = pos[1]; this.rootPosPrev[o + 2] = pos[2];
    } else {
      this.rootPosPrev[o] = this.rootPosNext[o];
      this.rootPosPrev[o + 1] = this.rootPosNext[o + 1];
      this.rootPosPrev[o + 2] = this.rootPosNext[o + 2];
    }
    this.rootPosNext[o] = pos[0]; this.rootPosNext[o + 1] = pos[1]; this.rootPosNext[o + 2] = pos[2];
  }

  /** Set a root edge's parent-bone world rotation for the coming step. */
  setRootFrame(e: number, q: Quat, snap = false): void {
    const o = 4 * e;
    for (let k = 0; k < 4; k++) {
      this.rootFramePrev[o + k] = snap ? q[k] : this.rootFrame[o + k];
      this.rootFrame[o + k] = q[k];
    }
  }

  /** Place every particle at its rest pose for the current root targets (no velocity). */
  resetToRest(): void {
    this.interpolateRoots(1);
    for (const p of this.pinnedRoots) {
      this.xp[3 * p] = this.x[3 * p];
      this.xp[3 * p + 1] = this.x[3 * p + 1];
      this.xp[3 * p + 2] = this.x[3 * p + 2];
    }
    for (let e = 0; e < this.nEdges; e++) {
      this.restFrame(e, false);
      const h = 3 * this.eHead[e], t = 3 * this.eTail[e], L = this.eLength[e];
      for (let k = 0; k < 3; k++) {
        this.x[t + k] = this.x[h + k] + this.restDir[3 * e + k] * L;
        this.xp[t + k] = this.x[t + k];
      }
      for (let k = 0; k < 4; k++) this.simQ[4 * e + k] = this.restQ[4 * e + k];
    }
    for (let i = 0; i < 6 * this.nCapsules; i++) this.capPrev[i] = this.capNext[i];
  }

  /** Rest world rotation and direction of edge e, from its parent's simulated (or rest) frame. */
  private restFrame(e: number, useSim: boolean): void {
    const par = this.eParent[e];
    const rq = this.restQ;
    if (par < 0) qmul(this.frameQ, 4 * e, this.eRestLocal, 4 * e, rq, 4 * e);
    else qmul(useSim && this.enabled[par] ? this.simQ : rq, 4 * par, this.eRestLocal, 4 * e, rq, 4 * e);
    qrot(rq, 4 * e, this.eAxis[3 * e], this.eAxis[3 * e + 1], this.eAxis[3 * e + 2], this.restDir, 3 * e);
  }

  /** Simulated frame of edge e from its current direction (swing from rest). */
  private simFrame(e: number, dx: number, dy: number, dz: number): void {
    const t = this.tmp;
    qFromUnit(this.restDir[3 * e], this.restDir[3 * e + 1], this.restDir[3 * e + 2], dx, dy, dz, t, 0);
    qmul(t, 0, this.restQ, 4 * e, this.simQ, 4 * e);
  }

  private interpolateRoots(alpha: number): void {
    for (const p of this.pinnedRoots) {
      const o = 3 * p;
      for (let k = 0; k < 3; k++) this.x[o + k] = this.rootPosPrev[o + k] + (this.rootPosNext[o + k] - this.rootPosPrev[o + k]) * alpha;
    }
    for (let e = 0; e < this.nEdges; e++) {
      if (this.eParent[e] >= 0) continue;
      qslerp(this.rootFramePrev, 4 * e, this.rootFrame, 4 * e, alpha, this.frameQ, 4 * e);
    }
  }

  private interpolateCapsules(alpha: number): void {
    const a = this.capPrev, b = this.capNext, c = this.cap;
    for (let i = 0; i < c.length; i++) c[i] = a[i] + (b[i] - a[i]) * alpha;
  }

  /** Largest capsule displacement over the coming step, in units of its radius. */
  private capsuleTravel(): number {
    let worst = 0;
    for (let i = 0; i < this.nCapsules; i++) {
      if (!this.capEnabled[i]) continue;
      const o = 6 * i;
      const da = Math.hypot(this.capNext[o] - this.capPrev[o], this.capNext[o + 1] - this.capPrev[o + 1], this.capNext[o + 2] - this.capPrev[o + 2]);
      const db = Math.hypot(this.capNext[o + 3] - this.capPrev[o + 3], this.capNext[o + 4] - this.capPrev[o + 4], this.capNext[o + 5] - this.capPrev[o + 5]);
      worst = Math.max(worst, Math.max(da, db) / Math.max(this.capR[i], 0.01));
    }
    return worst;
  }

  /**
   * Advance one step of h seconds. Roots, root frames and capsules move from
   * their previous targets to the ones set since the last step.
   */
  step(h: number): void {
    if (h <= 0) return;
    const { x, xp, w } = this;
    const nE = this.nEdges;

    // Roots jump to this step's targets; their previous position stays in xp
    // (for the relative-speed clamp below).
    this.interpolateRoots(1);
    this.interpolateCapsules(0);

    // 1. Frames from the current state, then integrate.
    for (let e = 0; e < nE; e++) {
      this.restFrame(e, true);
      const hd = 3 * this.eHead[e], tl = 3 * this.eTail[e];
      const dx = x[tl] - x[hd], dy = x[tl + 1] - x[hd + 1], dz = x[tl + 2] - x[hd + 2];
      const d = Math.hypot(dx, dy, dz) || 1;
      this.simFrame(e, dx / d, dy / d, dz / d);
    }
    for (let e = 0; e < nE; e++) {
      const p = this.eTail[e];
      if (!this.enabled[e] || w[p] === 0) continue;
      const o = 3 * p;
      const carry = 1 - this.drag[e];
      const s = this.stiffness[e] * h;
      for (let k = 0; k < 3; k++) {
        const v = (x[o + k] - xp[o + k]) * carry;
        xp[o + k] = x[o + k];
        x[o + k] += v + this.restDir[3 * e + k] * s + this.gravity[3 * e + k] * h;
      }
    }

    // 2. Constraints. Colliders sweep from their previous to their new pose
    // across the iterations; a capsule that travels far in one step is
    // resolved at extra intermediate positions.
    const travel = this.capsuleTravel();
    const sweeps = Math.min(8, Math.max(1, Math.ceil(travel / 0.4)));
    const iters = Math.max(this.opts.iterations, sweeps);
    this.hit.fill(0);
    this.contacts = 0;
    for (let it = 0; it < iters; it++) {
      this.interpolateCapsules(Math.min(1, (it + 1) / Math.min(iters, sweeps)));
      this.solveLinks(h);
      this.solveChains();
    }

    // 3. Velocity limits: relative speed clamp, contact damping, sleep.
    const maxStep = this.opts.maxSpeed * h;
    const sleep = this.opts.sleepSpeed * h;
    const fric = this.opts.frictionSpeed * h;
    const damp = this.opts.collisionDamping;
    for (let p = 0; p < this.nParticles; p++) {
      if (w[p] === 0) continue;
      const o = 3 * p;
      const r = 3 * this.rootOf[p];
      // Root motion over this step (roots were set to their new targets above;
      // their previous position is kept in xp).
      const rx = x[r] - xp[r], ry = x[r + 1] - xp[r + 1], rz = x[r + 2] - xp[r + 2];
      let vx = x[o] - xp[o] - rx, vy = x[o + 1] - xp[o + 1] - ry, vz = x[o + 2] - xp[o + 2] - rz;
      let len = Math.hypot(vx, vy, vz);
      if (len > maxStep) {
        const k = maxStep / len;
        vx *= k; vy *= k; vz *= k;
        len = maxStep;
      }
      if (this.hit[p]) {
        // Contact: damping, and static friction (slow sliding stops), so cloth
        // resting on a leg settles instead of cycling against the collider.
        if (len * (1 - damp) < fric) {
          vx = 0; vy = 0; vz = 0;
        } else {
          vx *= 1 - damp; vy *= 1 - damp; vz *= 1 - damp;
        }
      } else if (len < sleep) {
        vx = 0; vy = 0; vz = 0;
      }
      xp[o] = x[o] - rx - vx;
      xp[o + 1] = x[o + 1] - ry - vy;
      xp[o + 2] = x[o + 2] - rz - vz;
    }
    // Roots: remember this step's position as "previous" for the next one.
    for (const p of this.pinnedRoots) {
      const o = 3 * p;
      xp[o] = x[o]; xp[o + 1] = x[o + 1]; xp[o + 2] = x[o + 2];
    }
  }

  private solveLinks(h: number): void {
    const { x, w } = this;
    const ih2 = 1 / (h * h);
    for (let i = 0; i < this.lA.length; i++) {
      const a = this.lA[i], b = this.lB[i];
      const wa = w[a], wb = w[b];
      if (wa + wb === 0) continue;
      const oa = 3 * a, ob = 3 * b;
      const dx = x[ob] - x[oa], dy = x[ob + 1] - x[oa + 1], dz = x[ob + 2] - x[oa + 2];
      const d = Math.hypot(dx, dy, dz);
      if (d < EPS) continue;
      const c = d - this.lRest[i];
      const alpha = (c > 0 ? this.lStretch[i] : this.lCompress[i]) * ih2;
      if (!isFinite(alpha)) continue;
      const dl = c / (wa + wb + alpha);
      const kx = (dx / d) * dl, ky = (dy / d) * dl, kz = (dz / d) * dl;
      x[oa] += kx * wa; x[oa + 1] += ky * wa; x[oa + 2] += kz * wa;
      x[ob] -= kx * wb; x[ob + 1] -= ky * wb; x[ob + 2] -= kz * wb;
    }
  }

  /** Root-to-tip: angle limit, exact length, segment-vs-capsule contacts. */
  private solveChains(): void {
    const { x } = this;
    for (let e = 0; e < this.nEdges; e++) {
      this.restFrame(e, true);
      const hd = 3 * this.eHead[e], tl = 3 * this.eTail[e];
      const L = this.eLength[e];
      const rd = 3 * e;
      const rdx = this.restDir[rd], rdy = this.restDir[rd + 1], rdz = this.restDir[rd + 2];
      if (!this.enabled[e]) {
        // Kinematic: follow the rest pose.
        for (let k = 0; k < 3; k++) {
          x[tl + k] = x[hd + k] + this.restDir[rd + k] * L;
          this.xp[tl + k] = x[tl + k];
        }
        for (let k = 0; k < 4; k++) this.simQ[4 * e + k] = this.restQ[4 * e + k];
        continue;
      }
      let dx = x[tl] - x[hd], dy = x[tl + 1] - x[hd + 1], dz = x[tl + 2] - x[hd + 2];
      let d = Math.hypot(dx, dy, dz);
      if (d < EPS) {
        dx = rdx; dy = rdy; dz = rdz; d = 1;
      }
      dx /= d; dy /= d; dz /= d;

      // Angle limit around the rest direction.
      const maxA = this.maxAngle[e];
      if (maxA < Math.PI) {
        const c = dx * rdx + dy * rdy + dz * rdz;
        if (c < Math.cos(maxA)) {
          let px = dx - rdx * c, py = dy - rdy * c, pz = dz - rdz * c;
          let pl = Math.hypot(px, py, pz);
          if (pl < 1e-6) {
            // Opposite to rest: pick any perpendicular.
            px = Math.abs(rdx) < 0.9 ? 0 : 1; py = Math.abs(rdx) < 0.9 ? -rdz : 0; pz = Math.abs(rdx) < 0.9 ? rdy : -rdx;
            pl = Math.hypot(px, py, pz) || 1;
          }
          const cs = Math.cos(maxA), sn = Math.sin(maxA);
          dx = rdx * cs + (px / pl) * sn;
          dy = rdy * cs + (py / pl) * sn;
          dz = rdz * cs + (pz / pl) * sn;
        }
      }
      x[tl] = x[hd] + dx * L;
      x[tl + 1] = x[hd + 1] + dy * L;
      x[tl + 2] = x[hd + 2] + dz * L;

      // Contacts: swing the segment about its head out of each capsule.
      const cols = this.eColliders[e];
      if (cols.length) this.collideSegment(e, hd, tl, L, cols, this.eColliderR[e]);

      dx = x[tl] - x[hd]; dy = x[tl + 1] - x[hd + 1]; dz = x[tl + 2] - x[hd + 2];
      d = Math.hypot(dx, dy, dz) || 1;
      this.simFrame(e, dx / d, dy / d, dz / d);
    }
  }

  private collideSegment(e: number, hd: number, tl: number, L: number, cols: Int32Array, caps: Float64Array): void {
    const { x, xp } = this;
    const pr = this.radius[this.eTail[e]];
    const seg = this.seg;
    const cap = this.cap;
    for (let pass = 0; pass < 2; pass++) {
      let moved = false;
      for (let ci = 0; ci < cols.length; ci++) {
        const c = cols[ci];
        if (!this.capEnabled[c]) continue;
        // Contact distance: capsule + particle radius, capped to what the segment clears at rest.
        const R = Math.min(this.capR[c] + pr, caps[ci]);
        if (R <= 0) continue;
        const o = 6 * c;
        const ax = cap[o], ay = cap[o + 1], az = cap[o + 2], bx = cap[o + 3], by = cap[o + 4], bz = cap[o + 5];
        // Cheap reject: tail and head both far from the capsule's bounding sphere.
        const mx = (ax + bx) * 0.5, my = (ay + by) * 0.5, mz = (az + bz) * 0.5;
        const half = 0.5 * Math.hypot(bx - ax, by - ay, bz - az) + R;
        const sx = (x[hd] + x[tl]) * 0.5 - mx, sy = (x[hd + 1] + x[tl + 1]) * 0.5 - my, sz = (x[hd + 2] + x[tl + 2]) * 0.5 - mz;
        if (sx * sx + sy * sy + sz * sz > (half + 0.5 * L) * (half + 0.5 * L)) continue;

        // If the head itself is inside (a pinned root dragged into a collider
        // by the body, or a parent that couldn't be resolved), swinging this
        // segment can only flip it to the far side: leave this pair alone.
        {
          const abx = bx - ax, aby = by - ay, abz = bz - az;
          const l2 = abx * abx + aby * aby + abz * abz;
          let th = l2 > EPS ? ((x[hd] - ax) * abx + (x[hd + 1] - ay) * aby + (x[hd + 2] - az) * abz) / l2 : 0;
          th = th < 0 ? 0 : th > 1 ? 1 : th;
          const hx = x[hd] - ax - abx * th, hy = x[hd + 1] - ay - aby * th, hz = x[hd + 2] - az - abz * th;
          if (hx * hx + hy * hy + hz * hz < 0.81 * R * R) continue;
        }
        // Two checks: the tail point itself (robust when the segment runs
        // parallel to the capsule, where the closest-point parameter of the
        // segment is ill-defined), then the whole segment (a segment crossing a
        // capsule with both ends outside), swung about its head.
        let pushed = false;
        for (let mode = 0; mode < 2; mode++) {
          let s: number, t: number;
          if (mode === 0) {
            const abx = bx - ax, aby = by - ay, abz = bz - az;
            const l2 = abx * abx + aby * aby + abz * abz;
            t = l2 > EPS ? ((x[tl] - ax) * abx + (x[tl + 1] - ay) * aby + (x[tl + 2] - az) * abz) / l2 : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            s = 1;
          } else {
            closestSegSeg(x[hd], x[hd + 1], x[hd + 2], x[tl], x[tl + 1], x[tl + 2], ax, ay, az, bx, by, bz, seg);
            s = seg[0];
            t = seg[1];
            if (s < 0.05) continue; // at the (already resolved) head: nothing a swing can do
          }
          const px = x[hd] + (x[tl] - x[hd]) * s, py = x[hd + 1] + (x[tl + 1] - x[hd + 1]) * s, pz = x[hd + 2] + (x[tl + 2] - x[hd + 2]) * s;
          const qx = ax + (bx - ax) * t, qy = ay + (by - ay) * t, qz = az + (bz - az) * t;
          let nx = px - qx, ny = py - qy, nz = pz - qz;
          let dist = Math.hypot(nx, ny, nz);
          if (dist >= R) continue;
          if (dist < 1e-6) {
            // On the axis: push back toward where the tail came from.
            nx = xp[tl] - qx; ny = xp[tl + 1] - qy; nz = xp[tl + 2] - qz;
            dist = Math.hypot(nx, ny, nz);
            if (dist < 1e-6) {
              nx = 0; ny = 1; nz = 0; dist = 1;
            }
            nx /= dist; ny /= dist; nz /= dist;
            dist = 0;
          } else {
            nx /= dist; ny /= dist; nz /= dist;
          }
          // Move the tail so the contact point clears the capsule (lever s).
          const k = (R - dist) / Math.max(s, 0.3);
          x[tl] += nx * k; x[tl + 1] += ny * k; x[tl + 2] += nz * k;
          // Back to the edge's length.
          const dx = x[tl] - x[hd], dy = x[tl + 1] - x[hd + 1], dz = x[tl + 2] - x[hd + 2];
          const d = Math.hypot(dx, dy, dz) || 1;
          x[tl] = x[hd] + (dx / d) * L; x[tl + 1] = x[hd + 1] + (dy / d) * L; x[tl + 2] = x[hd + 2] + (dz / d) * L;
          pushed = true;
        }
        if (!pushed) continue;
        this.hit[this.eTail[e]] = 1;
        this.contacts++;
        moved = true;
      }
      if (!moved) break;
    }
  }

  /** Simulated world rotation of edge e's bone (after the last step). */
  edgeRotation(e: number, out: Quat): Quat {
    out[0] = this.simQ[4 * e]; out[1] = this.simQ[4 * e + 1]; out[2] = this.simQ[4 * e + 2]; out[3] = this.simQ[4 * e + 3];
    return out;
  }

  /** Inertia: carry free particles by a rigid transform blend (row-major 3x4 matrix m, share k). */
  carry(m: ArrayLike<number>, k: number): void {
    const { x, xp, w } = this;
    const move = (arr: Float64Array, o: number) => {
      const px = arr[o], py = arr[o + 1], pz = arr[o + 2];
      const tx = m[0] * px + m[1] * py + m[2] * pz + m[3];
      const ty = m[4] * px + m[5] * py + m[6] * pz + m[7];
      const tz = m[8] * px + m[9] * py + m[10] * pz + m[11];
      arr[o] = px + (tx - px) * k;
      arr[o + 1] = py + (ty - py) * k;
      arr[o + 2] = pz + (tz - pz) * k;
    };
    for (let p = 0; p < this.nParticles; p++) {
      if (w[p] === 0) continue;
      move(x, 3 * p);
      move(xp, 3 * p);
    }
  }
}
