// Body / hand metrics for scripts/track-clip.mjs: compares the tracked avatar's
// arm directions, finger joint angles, hand detection and gestures (recorded per
// body result with ?record=1) against the rendered clip's measured ground truth.
// The clip is played unmirrored, so the user's left is the avatar's left.

const SIDES = ['left', 'right'];
const GESTURES = ['none', 'open', 'fist', 'point', 'peace', 'thumbsUp', 'ok', 'rock'];
const deg = (r) => (r * 180) / Math.PI;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const angle = (a, b) => {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return deg(Math.acos(Math.max(-1, Math.min(1, d))));
};
const r1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);

export function bodyReport(rec, truth, { gestureGraceMs = 250 } = {}) {
  const fps = truth.fps;
  const tr = (vt) => truth.frames[Math.min(truth.frames.length - 1, Math.max(0, Math.round(vt * fps)))];
  const rows = rec.filter((r) => r.body && r.vt != null && r.rig).map((r) => ({ ...r, truth: tr(r.vt) }));
  const segments = [...new Set(rows.map((r) => r.truth.segment))];

  // Start time of each held-gesture run, per side (for the grace period).
  const holdStart = { left: new Map(), right: new Map() };
  for (const s of SIDES) {
    let start = 0;
    let prev = null;
    for (const f of truth.frames) {
      const g = f.gesture?.[s] ?? null;
      if (g !== prev) start = f.t;
      holdStart[s].set(f.t, start);
      prev = g;
    }
  }

  const perSegment = {};
  for (const seg of [...segments, 'ALL']) {
    const rs = seg === 'ALL' ? rows : rows.filter((r) => r.truth.segment === seg);
    const out = { n: rs.length };
    // Hand detection where the hand is in frame.
    const det = { left: [], right: [] };
    const finger = [];
    const fingerDetected = [];
    const upper = [];
    const fore = [];
    const elbow = [];
    for (const r of rs) {
      const t = r.truth;
      for (const s of SIDES) {
        const inFrame = t.handInFrame?.[s];
        const found = r.hands.includes(s);
        if (inFrame) det[s].push(found ? 1 : 0);
        if (t.rig) {
          const tu = t.rig.dirs[`${s}UpperArm`];
          const tl = t.rig.dirs[`${s}LowerArm`];
          const au = r.rig.dirs[`${s}UpperArm`];
          const al = r.rig.dirs[`${s}LowerArm`];
          if (tu && au) upper.push(angle(tu, au));
          if (tl && al) fore.push(angle(tl, al));
          elbow.push(Math.abs(t.rig.elbow[s] - r.rig.elbow[s]));
          if (inFrame) {
            const errs = [];
            for (const [k, v] of Object.entries(t.rig.joints)) {
              if (!k.startsWith(s) || r.rig.joints[k] == null) continue;
              errs.push(Math.abs(v - r.rig.joints[k]));
            }
            if (errs.length) {
              finger.push(mean(errs));
              if (found) fingerDetected.push(mean(errs));
            }
          }
        }
      }
    }
    const dl = mean(det.left);
    const dr = mean(det.right);
    out.handDetectPct = { left: r1(100 * dl), right: r1(100 * dr), both: r1(100 * mean([...det.left, ...det.right])) };
    out.fingerErrDeg = r1(mean(finger));
    out.fingerErrDetectedDeg = r1(mean(fingerDetected));
    out.upperArmErrDeg = r1(mean(upper));
    out.forearmErrDeg = r1(mean(fore));
    out.elbowBendErrDeg = r1(mean(elbow));
    perSegment[seg] = out;
  }

  // Gestures: held frames, hand in frame, after a grace period from the hold start.
  const confusion = Object.fromEntries(GESTURES.map((g) => [g, Object.fromEntries([...GESTURES, 'missing'].map((h) => [h, 0]))]));
  let correct = 0;
  let total = 0;
  for (const r of rows) {
    const t = r.truth;
    if (!t.gesture) continue;
    for (const s of SIDES) {
      const g = t.gesture[s];
      if (!g || g === 'transition' || !t.handInFrame?.[s]) continue;
      if ((t.t - holdStart[s].get(t.t)) * 1000 < gestureGraceMs) continue;
      if (t.segment !== 'gestures' && g === 'none' && !['cross', 'nearFace', 'lean'].includes(t.segment)) continue;
      const p = r.gestures ? (r.gestures[s] ?? 'none') : 'missing';
      confusion[g][p] = (confusion[g][p] ?? 0) + 1;
      total++;
      if (p === g) correct++;
    }
  }
  // Flicker: gesture changes per second while a gesture is held.
  let changes = 0;
  let heldSecs = 0;
  for (const s of SIDES) {
    let prev = null;
    let prevT = null;
    for (const r of rows) {
      const g = r.truth.gesture?.[s];
      const held = g && g !== 'transition' && r.truth.segment === 'gestures';
      const p = r.gestures?.[s] ?? 'none';
      if (held && prev !== null && p !== prev) changes++;
      if (held && prevT !== null) heldSecs += r.vt - prevT;
      prev = held ? p : null;
      prevT = held ? r.vt : null;
    }
  }

  // Jitter at rest: RMS second difference while the truth is static.
  const series = (r) => {
    const v = [];
    for (const s of SIDES) {
      for (const b of ['UpperArm', 'LowerArm', 'Hand']) {
        const d = r.rig.dirs[`${s}${b}`];
        if (d) v.push(...d.map((x) => deg(x)));
      }
    }
    return v;
  };
  const fingerSeries = (r) => Object.keys(r.rig.joints).sort().map((k) => r.rig.joints[k]);
  const static3 = (a, b, c) => {
    const ja = a.truth.rig, jb = b.truth.rig, jc = c.truth.rig;
    if (!ja || !jb || !jc) return false;
    for (const k of Object.keys(ja.joints)) {
      if (Math.abs(ja.joints[k] - jb.joints[k]) > 0.05 || Math.abs(jb.joints[k] - jc.joints[k]) > 0.05) return false;
    }
    for (const k of Object.keys(ja.dirs)) {
      if (angle(ja.dirs[k], jb.dirs[k]) > 0.05 || angle(jb.dirs[k], jc.dirs[k]) > 0.05) return false;
    }
    return true;
  };
  const sd2 = (f) => {
    let ss = 0;
    let n = 0;
    for (let i = 1; i < rows.length - 1; i++) {
      if (!static3(rows[i - 1], rows[i], rows[i + 1])) continue;
      const a = f(rows[i - 1]), b = f(rows[i]), c = f(rows[i + 1]);
      for (let k = 0; k < Math.min(a.length, b.length, c.length); k++) {
        const d = a[k] - 2 * b[k] + c[k];
        ss += d * d;
        n++;
      }
    }
    return { rms: Math.round(Math.sqrt(ss / Math.max(1, n)) * 100) / 100, samples: n };
  };

  // End-to-end lag: shift of the tracked elbow-bend + finger-curl signal that best matches the truth.
  const signal = (rig) => rig.elbow.left + rig.elbow.right + Object.values(rig.joints).reduce((s, x) => s + x, 0) / 10;
  const lagMs = (() => {
    const xs = rows.filter((r) => r.truth.rig);
    let best = 0;
    let bestC = -Infinity;
    for (let lag = 0; lag <= 600; lag += 20) {
      const a = [];
      const b = [];
      for (const r of xs) {
        const t = tr(r.vt - lag / 1000);
        if (!t.rig) continue;
        a.push(signal(r.rig));
        b.push(signal(t.rig));
      }
      const ma = mean(a), mb = mean(b);
      let num = 0, da = 0, db = 0;
      for (let i = 0; i < a.length; i++) {
        num += (a[i] - ma) * (b[i] - mb);
        da += (a[i] - ma) ** 2;
        db += (b[i] - mb) ** 2;
      }
      const c = num / Math.sqrt(da * db || 1);
      if (c > bestC) {
        bestC = c;
        best = lag;
      }
    }
    return { ms: best, corr: Math.round(bestC * 1000) / 1000 };
  })();

  // Snapping when an arm leaves / re-enters the frame: peak angular speed of the arm bones.
  const peakSpeed = (seg) => {
    let peak = 0;
    const rs = rows.filter((r) => r.truth.segment === seg);
    for (let i = 1; i < rs.length; i++) {
      const dt = rs[i].vt - rs[i - 1].vt;
      if (dt <= 0 || dt > 0.2) continue;
      for (const s of SIDES) {
        for (const b of ['UpperArm', 'LowerArm']) {
          const a = rs[i - 1].rig.dirs[`${s}${b}`], c = rs[i].rig.dirs[`${s}${b}`];
          if (a && c) peak = Math.max(peak, angle(a, c) / dt);
        }
      }
    }
    return Math.round(peak);
  };

  return {
    bodyResults: rows.length,
    perSegment,
    gestures: {
      accuracyPct: total ? r1((100 * correct) / total) : null,
      frames: total,
      flickerPerSec: heldSecs ? Math.round((100 * changes) / heldSecs) / 100 : null,
      confusion,
    },
    jitter: { armDeg: sd2(series), fingerDeg: sd2(fingerSeries) },
    lag: lagMs,
    peakArmSpeedDegPerSec: { outOfFrame: peakSpeed('outOfFrame'), cross: peakSpeed('cross'), nearFace: peakSpeed('nearFace') },
  };
}

/**
 * Hand search report from the per-hands-frame rows (`handsFrame` in the
 * ?record=1 log): per segment, how often each hand in view was found, how
 * often BOTH were found when both were in view, what the search did (status
 * counts per side), and the hands worker's time per frame.
 */
export function handSearchReport(rec, truth) {
  const fps = truth.fps;
  const tr = (vt) => truth.frames[Math.min(truth.frames.length - 1, Math.max(0, Math.round(vt * fps)))];
  const rows = rec.filter((r) => r.handsFrame && r.vt != null).map((r) => ({ ...r, truth: tr(r.vt) }));
  const segs = {};
  const add = (k, r) => {
    const t = r.truth;
    const s = (segs[k] ??= { frames: 0, inView: { left: 0, right: 0, both: 0 }, found: { left: 0, right: 0, both: 0 }, status: { left: {}, right: {} } });
    s.frames++;
    const f = { left: r.hands.includes('left'), right: r.hands.includes('right') };
    for (const side of SIDES) {
      if (t.handInFrame?.[side]) {
        s.inView[side]++;
        if (f[side]) s.found[side]++;
      }
      const st = r.status?.[side];
      if (st) s.status[side][st] = (s.status[side][st] ?? 0) + 1;
    }
    if (t.handInFrame?.left && t.handInFrame?.right) {
      s.inView.both++;
      if (f.left && f.right) s.found.both++;
    }
  };
  for (const r of rows) {
    add(r.truth.segment, r);
    if (/^face|nearFace/.test(r.truth.segment)) add('FACE', r);
    add('ALL', r);
  }
  const pct = (a, b) => (b ? r1((100 * a) / b) : null);
  const perSegment = {};
  for (const [k, s] of Object.entries(segs)) {
    perSegment[k] = {
      frames: s.frames,
      foundPct: { left: pct(s.found.left, s.inView.left), right: pct(s.found.right, s.inView.right), any: pct(s.found.left + s.found.right, s.inView.left + s.inView.right), both: pct(s.found.both, s.inView.both) },
      inView: s.inView,
      status: s.status,
    };
  }
  const ms = rows.map((r) => r.ms).filter((x) => x != null).sort((a, b) => a - b);
  return { frames: rows.length, perSegment, handsMs: { mean: r1(mean(ms)), p95: r1(ms[Math.floor(0.95 * (ms.length - 1))]) } };
}

/**
 * Face stability while hands are at the face: head angle error against the
 * truth (deg, RMS) and the largest frame-to-frame head jump, per segment,
 * from the face rows of the ?record=1 log (head = [yaw, pitch, roll], rad).
 */
export function faceStabilityReport(rec, truth) {
  const fps = truth.fps;
  const tr = (vt) => truth.frames[Math.min(truth.frames.length - 1, Math.max(0, Math.round(vt * fps)))];
  const rows = rec.filter((r) => !r.body && !r.handsFrame && r.vt != null && r.head).map((r) => ({ ...r, truth: tr(r.vt) }));
  const out = {};
  const segs = [...new Set(rows.map((r) => r.truth.segment))];
  for (const seg of segs) {
    const rs = rows.filter((r) => r.truth.segment === seg);
    let ss = 0;
    let jump = 0;
    let mouthJump = 0;
    for (let i = 0; i < rs.length; i++) {
      const h = rs[i].head.map(deg);
      const th = rs[i].truth.head;
      ss += (h[0] - th.yaw) ** 2 + (h[1] - th.pitch) ** 2 + (h[2] - th.roll) ** 2;
      if (i > 0 && rs[i].vt - rs[i - 1].vt < 0.1) {
        const p = rs[i - 1].head.map(deg);
        jump = Math.max(jump, Math.hypot(h[0] - p[0], h[1] - p[1], h[2] - p[2]));
        mouthJump = Math.max(mouthJump, Math.abs((rs[i].values?.jawOpen ?? 0) - (rs[i - 1].values?.jawOpen ?? 0)));
      }
    }
    out[seg] = { n: rs.length, faceFoundPct: r1((100 * rs.filter((r) => r.face).length) / Math.max(1, rs.length)), headErrRmsDeg: r1(Math.sqrt(ss / Math.max(1, rs.length))), maxHeadJumpDeg: r1(jump), maxJawJump: Math.round(mouthJump * 100) / 100 };
  }
  return out;
}
