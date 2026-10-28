/**
 * Physics stability test. Loads a VRM, shakes and sways its root with a
 * scripted motion that includes tracking-style jitter and frame-time spikes,
 * and measures spring-joint tail speed (relative to the hips, i.e. the motion
 * that reads as cloth/hair thrash) and settle time after the motion stops.
 *
 * Runs in virtual time (no real-time rendering), deterministic per seed.
 * Results go to window.__physicsResult for scripts/physics-test.mjs.
 */
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { loadAvatar } from '../src/scene/avatar';
import { DEFAULT_PHYSICS, type PhysicsSettings } from '../src/physics/stableSprings';
import { OneEuroFilter } from '../src/core/oneEuro';

interface Condition {
  name: string;
  physics: Partial<PhysicsSettings>;
  /** One-euro + speed limit on the root before physics sees it (what the tracking path does for hips). */
  smoothRoot: boolean;
}

const CONDITIONS: Condition[] = [
  { name: 'off: raw three-vrm update(frameDelta), raw root', physics: { stabilise: false }, smoothRoot: false },
  { name: 'fixed step + substeps only', physics: { solver: 'legacy', stabilise: true, maxSpeed: 1e9, collisionDamping: 0, inertia: 1 }, smoothRoot: false },
  { name: 'fixed step + clamps + collision damping', physics: { solver: 'legacy', stabilise: true, inertia: 1 }, smoothRoot: false },
  { name: 'all stabilisers (+ root smoothing + inertia 0.6)', physics: { solver: 'legacy', stabilise: true }, smoothRoot: true },
  { name: 'cloth solver (+ root smoothing + inertia 0.6)', physics: { solver: 'cloth', stabilise: true }, smoothRoot: true },
];

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

interface Sample {
  t: number;
  maxSpeed: number;
  skirtMaxSpeed: number;
}

async function run(buf: ArrayBuffer, cond: Condition, seed: number) {
  const { avatar } = await loadAvatar(buf.slice(0), { ...DEFAULT_PHYSICS, ...cond.physics });
  const vrm = avatar.vrm;
  const root = vrm.scene;
  const hips = vrm.humanoid.getRawBoneNode('hips')!;
  const joints = Array.from(vrm.springBoneManager!.joints);
  const isSkirt = joints.map((j) => avatar.physics.chains.find((c) => c.joints.includes(j))?.name.startsWith('skirt') ?? false);
  const rand = rng(seed);

  const SHAKE = 6; // seconds of motion
  const TAIL = 6; // seconds of stillness to measure settling
  const filters = Array.from({ length: 6 }, () => new OneEuroFilter({ minCutoff: 1.2, beta: 0.3, dCutoff: 1 }));
  const prev = joints.map(() => new Vector3());
  const tmp = new Vector3();
  const inv = new Matrix4();
  const samples: Sample[] = [];
  let t = 0;
  let nextSpike = 0.7;
  let first = true;
  let jitterPos = new Vector3();
  let jitterRot = new Vector3();
  let nextTrack = 0;

  avatar.drive.mode = 'face';
  while (t < SHAKE + TAIL) {
    // Frame time: ~60 fps with jitter, plus a 60-120 ms hitch now and then.
    let dt = 1 / 60 + (rand() - 0.5) * 0.004;
    if (t >= nextSpike && t < SHAKE + 1) {
      dt = 0.06 + rand() * 0.06;
      nextSpike = t + 0.9 + rand() * 0.8;
    }
    t += dt;

    // Scripted motion: a sway plus a fast shake, with 30 Hz tracking jitter (held between updates).
    let pos = new Vector3();
    let eul = new Vector3();
    if (t < SHAKE) {
      const env = Math.min(1, t / 0.5);
      pos.set(0.08 * Math.sin(2 * Math.PI * 0.6 * t) + 0.025 * Math.sin(2 * Math.PI * 3.1 * t), 0.015 * Math.sin(2 * Math.PI * 2.3 * t), 0.02 * Math.sin(2 * Math.PI * 1.7 * t)).multiplyScalar(env);
      eul.set(0.05 * Math.sin(2 * Math.PI * 1.3 * t), 0.25 * Math.sin(2 * Math.PI * 0.6 * t) + 0.08 * Math.sin(2 * Math.PI * 2.9 * t), 0.06 * Math.sin(2 * Math.PI * 1.1 * t)).multiplyScalar(env);
      if (t >= nextTrack) {
        nextTrack = t + 1 / 30;
        jitterPos = new Vector3((rand() - 0.5) * 0.012, (rand() - 0.5) * 0.006, (rand() - 0.5) * 0.012);
        jitterRot = new Vector3((rand() - 0.5) * 0.03, (rand() - 0.5) * 0.05, (rand() - 0.5) * 0.03);
      }
      pos.add(jitterPos);
      eul.add(jitterRot);
    }
    if (cond.smoothRoot) {
      const v = [pos.x, pos.y, pos.z, eul.x, eul.y, eul.z].map((x, i) => filters[i].filter(x, t));
      pos = new Vector3(v[0], v[1], v[2]);
      eul = new Vector3(v[3], v[4], v[5]);
    }
    root.position.copy(pos);
    const q = new Quaternion().setFromEuler(new Euler(eul.x, eul.y, eul.z));
    if (cond.smoothRoot) root.quaternion.rotateTowards(q, 4 * dt);
    else root.quaternion.copy(q);
    root.updateMatrixWorld(true);

    avatar.update(dt);

    // Tail speed in the hips frame.
    hips.updateWorldMatrix(true, false);
    inv.copy(hips.matrixWorld).invert();
    let maxS = 0;
    let maxSkirt = 0;
    for (let i = 0; i < joints.length; i++) {
      const j = joints[i] as unknown as { _currentTail: Vector3 };
      tmp.copy(j._currentTail).applyMatrix4(inv);
      if (!first) {
        const s = tmp.distanceTo(prev[i]) / dt;
        if (s > maxS) maxS = s;
        if (isSkirt[i] && s > maxSkirt) maxSkirt = s;
      }
      prev[i].copy(tmp);
    }
    first = false;
    samples.push({ t, maxSpeed: maxS, skirtMaxSpeed: maxSkirt });
  }

  const during = samples.filter((s) => s.t < SHAKE);
  const pct = (a: number[], p: number) => {
    const s = [...a].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
  };
  const SETTLED = 0.05; // m/s
  // Settle time: from motion stop until every joint stays below SETTLED.
  let lastAbove = SHAKE;
  for (const s of samples) if (s.t >= SHAKE && s.maxSpeed > SETTLED) lastAbove = s.t;
  const settle = lastAbove - SHAKE;
  const settled = samples[samples.length - 1].maxSpeed <= SETTLED;
  const skirtDuring = during.map((s) => s.skirtMaxSpeed);
  const allDuring = during.map((s) => s.maxSpeed);
  return {
    condition: cond.name,
    joints: joints.length,
    skirtJoints: isSkirt.filter(Boolean).length,
    maxSpeedAll: Math.max(...allDuring),
    p99SpeedAll: pct(allDuring, 0.99),
    maxSpeedSkirt: Math.max(...skirtDuring),
    p99SpeedSkirt: pct(skirtDuring, 0.99),
    medianSpeedSkirt: pct(skirtDuring, 0.5),
    settleSeconds: settled ? settle : null,
    residualSpeed: samples[samples.length - 1].maxSpeed,
  };
}

async function main() {
  const p = new URLSearchParams(location.search);
  const url = p.get('model') ?? '/__local/model.vrm';
  const seeds = (p.get('seeds') ?? '1,2,3').split(',').map(Number);
  document.body.textContent = 'loading…';
  console.log('[physics] fetching model');
  const buf = await (await fetch(url)).arrayBuffer();
  const results = [];
  for (const c of CONDITIONS) {
    for (const seed of seeds) {
      document.body.textContent = `running ${c.name} seed ${seed}`;
      const t0 = performance.now();
      results.push({ seed, ...(await run(buf, c, seed)) });
      console.log(`[physics] ${c.name} seed ${seed}: ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    }
  }
  (window as unknown as { __physicsResult: unknown }).__physicsResult = results;
  document.body.textContent = 'done';
}

main().catch((e) => {
  (window as unknown as { __physicsResult: unknown }).__physicsResult = { error: String(e?.stack ?? e) };
});
