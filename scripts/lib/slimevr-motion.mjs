// Deterministic body motions for the virtual SlimeVR rig (scripts/slimevr-fake-trackers.mjs).
//
// Everything here is a pure function of time, so the same motion at the same t always gives
// the same rotations (handy for tests).
//
// Frame: SlimeVR's world frame (OpenGL / SteamVR): +X right, +Y up, user faces -Z.
// A rotation returned by `pose(motion, t)` is the GLOBAL rotation of that body part relative
// to standing straight (identity = standing). Sign cheat-sheet (right-hand rule):
//   +X pitch  : a thigh swings forward (hip flexion); a chest/hip leans BACK
//   -X pitch  : chest/hip lean forward; a shin swings back (heel up)
//   +Z roll   : the upper body tilts to the user's left (toward -X)
//   +Y yaw    : the body turns to the user's left (counter-clockwise seen from above)

export const DEG = Math.PI / 180;

/** Quaternion as [w, x, y, z]. */
export const qIdentity = () => [1, 0, 0, 0];

export function qMul(a, b) {
  const [aw, ax, ay, az] = a;
  const [bw, bx, by, bz] = b;
  return [
    aw * bw - ax * bx - ay * by - az * bz,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
  ];
}

export const qConj = ([w, x, y, z]) => [w, -x, -y, -z];

export function qAxisAngle(ax, ay, az, angle) {
  const s = Math.sin(angle / 2);
  return [Math.cos(angle / 2), ax * s, ay * s, az * s];
}

/** Yaw (Y), then pitch (X), then roll (Z), in degrees: q = Ry * Rx * Rz. */
export function qEuler(pitchDeg = 0, yawDeg = 0, rollDeg = 0) {
  return qMul(
    qMul(qAxisAngle(0, 1, 0, yawDeg * DEG), qAxisAngle(1, 0, 0, pitchDeg * DEG)),
    qAxisAngle(0, 0, 1, rollDeg * DEG),
  );
}

/** Angle between two rotations, degrees. */
export function qAngleDeg(a, b) {
  const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return (2 * Math.acos(Math.min(1, d))) / DEG;
}

/** The trackers the rig emulates, in sensor order. `position` is SlimeVR's TrackerPosition id. */
export const TRACKERS = [
  { key: 'chest', designation: 'body:chest', position: 4 },
  { key: 'hip', designation: 'body:hip', position: 6 },
  { key: 'leftUpperLeg', designation: 'body:left_upper_leg', position: 7 },
  { key: 'rightUpperLeg', designation: 'body:right_upper_leg', position: 8 },
  { key: 'leftLowerLeg', designation: 'body:left_lower_leg', position: 9 },
  { key: 'rightLowerLeg', designation: 'body:right_lower_leg', position: 10 },
  // Optional extras (--trackers 8 / 10)
  { key: 'leftFoot', designation: 'body:left_foot', position: 11 },
  { key: 'rightFoot', designation: 'body:right_foot', position: 12 },
  { key: 'leftUpperArm', designation: 'body:left_upper_arm', position: 15 },
  { key: 'rightUpperArm', designation: 'body:right_upper_arm', position: 16 },
];

export const MOTIONS = ['idle', 'sit', 'walk', 'lean', 'squat'];

const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const TAU = 2 * Math.PI;

/**
 * Euler angles (degrees, [pitch, yaw, roll]) per body part for a motion at time t (seconds since
 * the motion started). Each motion eases in from standing over its first second.
 */
export function angles(motion, t) {
  const a = Object.fromEntries(TRACKERS.map((tr) => [tr.key, [0, 0, 0]]));
  const ease = smooth(t);
  const breathe = Math.sin(TAU * 0.25 * t);
  switch (motion) {
    case 'idle': {
      // Standing, breathing and swaying a little.
      a.chest = [-2 + 1.5 * breathe, 2 * Math.sin(TAU * 0.1 * t), 1 * Math.sin(TAU * 0.13 * t)];
      a.hip = [0, 1.5 * Math.sin(TAU * 0.1 * t), -1 * Math.sin(TAU * 0.13 * t)];
      break;
    }
    case 'sit': {
      // Seated at a desk: thighs horizontal, shins vertical, slight forward lean, typing sway.
      const e = ease;
      const sway = Math.sin(TAU * 0.2 * t);
      a.hip = [8 * e, 0, 0]; // pelvis rolls back a little on the chair
      a.chest = [(-12 + 2 * sway) * e, 4 * Math.sin(TAU * 0.07 * t) * e, 0];
      a.leftUpperLeg = [88 * e, -6 * e, 0];
      a.rightUpperLeg = [88 * e, 6 * e, 0];
      a.leftLowerLeg = [(3 + 3 * Math.sin(TAU * 0.3 * t)) * e, -4 * e, 0]; // foot tapping
      a.rightLowerLeg = [2 * e, 4 * e, 0];
      a.leftFoot = [0, -6 * e, 0];
      a.rightFoot = [0, 6 * e, 0];
      break;
    }
    case 'walk': {
      // Marching in place at 1 stride/s.
      const e = ease;
      const p = TAU * 1.0 * t;
      const lLift = Math.max(0, Math.sin(p));
      const rLift = Math.max(0, Math.sin(p + Math.PI));
      a.leftUpperLeg = [(45 * lLift - 5 * rLift) * e, 0, 0];
      a.rightUpperLeg = [(45 * rLift - 5 * lLift) * e, 0, 0];
      // knee bends up to ~75 deg while the thigh is lifted: shin global = thigh - knee
      a.leftLowerLeg = [(45 * lLift - 75 * lLift - 5 * rLift) * e, 0, 0];
      a.rightLowerLeg = [(45 * rLift - 75 * rLift - 5 * lLift) * e, 0, 0];
      a.hip = [0, 4 * Math.sin(p) * e, 3 * Math.sin(p) * e];
      a.chest = [-3 * e, -5 * Math.sin(p) * e, -2 * Math.sin(p) * e];
      a.leftUpperArm = [-25 * Math.sin(p) * e, 0, 0];
      a.rightUpperArm = [25 * Math.sin(p) * e, 0, 0];
      break;
    }
    case 'lean': {
      // Leaning the upper body left and right (0.2 Hz), with a forward/back nod at 0.1 Hz.
      const e = ease;
      const side = Math.sin(TAU * 0.2 * t);
      const fwd = Math.sin(TAU * 0.1 * t);
      a.chest = [-15 * fwd * e, 0, 20 * side * e];
      a.hip = [-6 * fwd * e, 0, 8 * side * e];
      break;
    }
    case 'squat': {
      // Squat down and up every 4 s (bottom at t = 2 s, 6 s, ...).
      const s = (1 - Math.cos(TAU * 0.25 * t)) / 2; // 0 standing .. 1 bottom
      a.leftUpperLeg = [85 * s, -8 * s, 0];
      a.rightUpperLeg = [85 * s, 8 * s, 0];
      a.leftLowerLeg = [-35 * s, -8 * s, 0];
      a.rightLowerLeg = [-35 * s, 8 * s, 0];
      a.hip = [-30 * s, 0, 0];
      a.chest = [-40 * s, 0, 0];
      break;
    }
    default:
      throw new Error(`unknown motion "${motion}" (expected ${MOTIONS.join(', ')})`);
  }
  return a;
}

/** Global rotation (SlimeVR world frame, [w,x,y,z]) per body part. */
export function pose(motion, t) {
  const out = {};
  for (const [k, [p, y, r]] of Object.entries(angles(motion, t))) out[k] = qEuler(p, y, r);
  return out;
}

/**
 * How each emulated tracker is "strapped on": a fixed rotation of the IMU relative to the body
 * part (pitch/roll only, so SlimeVR's full reset can remove it exactly). With `--mounted` the
 * fake trackers send body * strap, which only looks right after a full reset, like real ones.
 */
export const STRAPS = {
  chest: qEuler(-20, 0, 0),
  hip: qEuler(10, 0, 5),
  leftUpperLeg: qEuler(15, 0, -10),
  rightUpperLeg: qEuler(15, 0, 10),
  leftLowerLeg: qEuler(-5, 0, -8),
  rightLowerLeg: qEuler(-5, 0, 8),
  leftFoot: qEuler(-80, 0, 0),
  rightFoot: qEuler(-80, 0, 0),
  leftUpperArm: qEuler(0, 0, 30),
  rightUpperArm: qEuler(0, 0, -30),
};

/**
 * SlimeVR multiplies every incoming IMU quaternion by AXES_OFFSET (-90 deg about X) to go from
 * IMU axes to its world frame (TrackersUDPServer.kt). We send AXES_OFFSET^-1 * q so the tracker
 * ends up at exactly q inside the server.
 */
export const AXES_OFFSET = qAxisAngle(1, 0, 0, -Math.PI / 2);
export const toWire = (q) => qMul(qConj(AXES_OFFSET), q);
