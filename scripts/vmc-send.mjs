// Virtual VMC sender: stands in for body trackers (SlimeVR, mocopi) or a phone
// face app, so VPuppet's VMC input (VMC window → VMC IN) can be tried without
// hardware.
//   node scripts/vmc-send.mjs [motion=sit] [port=39539] [seconds=30] [host=127.0.0.1]
// Motions: sit (seated at a desk, gentle sway), walk (in place), squat, lean
// (torso side to side), face (ARKit blend shapes only: blink and jaw), all
// (walk plus face). Sends at 60 Hz in VMC's Unity convention: normalized-rig
// local rotations, identity at T-pose, left-handed (see src/vmc/vmcFrame.ts).
import dgram from 'node:dgram';

const [motion = 'sit', portArg = '39539', secondsArg = '30', host = '127.0.0.1'] = process.argv.slice(2);
const port = Number(portArg);
const seconds = Number(secondsArg);
const MOTIONS = ['sit', 'walk', 'squat', 'lean', 'face', 'all'];
if (!MOTIONS.includes(motion)) {
  console.error(`unknown motion ${motion}; one of ${MOTIONS.join(', ')}`);
  process.exit(2);
}

// ---------------------------------------------------------------- OSC encoding
const pad = (n) => (n + 4) & ~3;
function oscString(s) {
  const b = Buffer.alloc(pad(Buffer.byteLength(s)));
  b.write(s);
  return b;
}
/** Args: a string, a number (float32), or { i: n } (int32). */
function message(addr, args) {
  const tags = ',' + args.map((a) => (typeof a === 'string' ? 's' : typeof a === 'object' ? 'i' : 'f')).join('');
  const parts = [oscString(addr), oscString(tags)];
  for (const a of args) {
    if (typeof a === 'string') parts.push(oscString(a));
    else {
      const b = Buffer.alloc(4);
      if (typeof a === 'object') b.writeInt32BE(a.i);
      else b.writeFloatBE(a);
      parts.push(b);
    }
  }
  return Buffer.concat(parts);
}
function bundle(msgs) {
  const parts = [oscString('#bundle'), Buffer.from([0, 0, 0, 0, 0, 0, 0, 1])];
  for (const m of msgs) {
    const len = Buffer.alloc(4);
    len.writeInt32BE(m.length);
    parts.push(len, m);
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- poses
/** Quaternion [x, y, z, w] for `deg` about an axis, in three.js (right-handed, avatar faces +Z) space. */
const axis = (ax, ay, az, deg) => {
  const h = (deg * Math.PI) / 360;
  const s = Math.sin(h);
  return [ax * s, ay * s, az * s, Math.cos(h)];
};
const rx = (deg) => axis(1, 0, 0, deg);
const rz = (deg) => axis(0, 0, 1, deg);
/** three.js -> Unity, as VPuppet's own output does: (x, y, z, w) -> (x, -y, -z, w). */
const unity = ([x, y, z, w]) => [x, -y, -z, w];

function pose(t) {
  const bones = {};
  const set = (name, q) => (bones[name] = unity(q));
  const sway = Math.sin(t * 0.8);
  if (motion === 'sit') {
    for (const s of ['Left', 'Right']) {
      set(`${s}UpperLeg`, rx(-88 + 2 * sway));
      set(`${s}LowerLeg`, rx(85));
      set(`${s}Foot`, rx(-5));
    }
    set('Spine', rx(4 + 2 * sway));
  } else if (motion === 'walk' || motion === 'all') {
    const p = Math.sin(t * 4);
    set('LeftUpperLeg', rx(-35 * Math.max(0, p)));
    set('LeftLowerLeg', rx(60 * Math.max(0, p)));
    set('RightUpperLeg', rx(-35 * Math.max(0, -p)));
    set('RightLowerLeg', rx(60 * Math.max(0, -p)));
    set('Hips', rz(3 * p));
  } else if (motion === 'squat') {
    const d = (1 - Math.cos(t * 1.5)) / 2; // 0..1
    for (const s of ['Left', 'Right']) {
      set(`${s}UpperLeg`, rx(-100 * d));
      set(`${s}LowerLeg`, rx(120 * d));
      set(`${s}Foot`, rx(-20 * d));
    }
    set('Spine', rx(20 * d));
  } else if (motion === 'lean') {
    set('Spine', rz(15 * sway));
    set('Chest', rz(8 * sway));
  }
  const blends = {};
  if (motion === 'face' || motion === 'all') {
    const blink = (t % 3.5) < 0.15 ? 1 : 0;
    blends.eyeBlinkLeft = blink;
    blends.eyeBlinkRight = blink;
    blends.jawOpen = Math.max(0, Math.sin(t * 6)) * 0.6;
    blends.mouthSmileLeft = blends.mouthSmileRight = 0.3 + 0.2 * sway;
  }
  return { bones, blends };
}

// ---------------------------------------------------------------- send loop
const sock = dgram.createSocket('udp4');
const t0 = Date.now();
let sent = 0;
const timer = setInterval(() => {
  const t = (Date.now() - t0) / 1000;
  if (t > seconds) {
    clearInterval(timer);
    sock.close();
    console.log(`done: ${sent} frames`);
    return;
  }
  const { bones, blends } = pose(t);
  // OK: model loaded, calibrated, normal mode, tracking.
  const msgs = [message('/VMC/Ext/OK', [{ i: 1 }, { i: 3 }, { i: 0 }, { i: 1 }]), message('/VMC/Ext/T', [t])];
  msgs.push(message('/VMC/Ext/Root/Pos', ['root', 0, 0, 0, 0, 0, 0, 1]));
  for (const [name, [x, y, z, w]] of Object.entries(bones)) msgs.push(message('/VMC/Ext/Bone/Pos', [name, 0, 0, 0, x, y, z, w]));
  for (const [name, v] of Object.entries(blends)) msgs.push(message('/VMC/Ext/Blend/Val', [name, v]));
  if (Object.keys(blends).length) msgs.push(message('/VMC/Ext/Blend/Apply', []));
  sock.send(bundle(msgs), port, host);
  sent++;
}, 1000 / 60);
console.log(`sending "${motion}" to ${host}:${port} for ${seconds} s (VPuppet: VMC window → VMC IN, port ${port})`);
