#!/usr/bin/env node
// Virtual SlimeVR IMU trackers: speaks the SlimeVR firmware <-> server UDP protocol (the
// extended owoTrack protocol, port 6969) and streams scripted, deterministic body motions.
//
//   node scripts/slimevr-fake-trackers.mjs [options]
//     --motion <m>[:secs][,<m>[:secs]...]  idle | sit | walk | lean | squat   (default idle)
//                                         a sequence loops; type a motion name + Enter on
//                                         stdin to switch live
//     --trackers <n>     6 (chest, hip, thighs, shins) | 8 (+feet) | 10 (+upper arms)  [6]
//     --host <ip>        SlimeVR server address                        [127.0.0.1]
//     --port <n>         SlimeVR tracker port                          [6969]
//     --rate <hz>        rotation packets per second per tracker      [100]
//     --duration <s>     exit after this long (default: run until killed)
//     --mounted          send rotations as if strapped on at an angle (needs the full reset)
//     --no-reset         don't send the "full reset" user action after connecting
//     --print <s>        don't connect: print the poses for <s> seconds as JSON lines and exit
//     --quiet
//
// Protocol (server: SlimeVR-Server server/core/.../tracking/trackers/udp/, firmware:
// SlimeVR-Tracker-ESP src/network/connection.cpp). Big-endian. Every tracker -> server packet:
//   i32 packetType, i64 packetNumber (strictly increasing per device, 0 always accepted), payload
//   3  HANDSHAKE   i32 board, i32 imu, i32 mcu, i32 0, i32 0, i32 0, i32 protocolVersion,
//                  u8 len + firmware string, 6-byte MAC   (server answers 0x03 "Hey OVR =D 5")
//   15 SENSOR_INFO u8 sensorId, u8 status(1=OK), u8 imuType, u16 sensorConfig,
//                  u8 restCalibrated, u8 trackerPosition, u8 dataType(0=rotation)
//                  (server acks with i32 15, u8 sensorId, u8 status — no packet number)
//   17 ROTATION_DATA u8 sensorId, u8 dataType(1=normal), f32 x, y, z, w, u8 accuracy
//   12 BATTERY     f32 voltage, f32 level(0..1)
//   10 PING_PONG   i32 id (echo of the server's ping)
//   21 USER_ACTION u8 type (2 = full reset)
// The server only accepts handshakes from MACs in vrconfig.yml `knownDevices`
// (scripts/slimevr-rig.mjs writes them); each fake tracker is its own "device" with MAC
// 5A:1E:00:00:00:<nn> on its own UDP socket, like real single-IMU trackers.
import dgram from 'node:dgram';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import readline from 'node:readline';
import { MOTIONS, TRACKERS, STRAPS, pose, qMul, qIdentity, toWire } from './lib/slimevr-motion.mjs';

export const fakeMac = (i) => `5A:1E:00:00:00:${(i + 1).toString(16).toUpperCase().padStart(2, '0')}`;

function parseArgs(argv) {
  const o = { motion: 'idle', trackers: 6, host: '127.0.0.1', port: 6969, rate: 100, duration: 0,
    mounted: false, reset: true, print: 0, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--motion') o.motion = next();
    else if (a === '--trackers') o.trackers = Number(next());
    else if (a === '--host') o.host = next();
    else if (a === '--port') o.port = Number(next());
    else if (a === '--rate') o.rate = Number(next());
    else if (a === '--duration') o.duration = Number(next());
    else if (a === '--mounted') o.mounted = true;
    else if (a === '--no-reset') o.reset = false;
    else if (a === '--print') o.print = Number(next());
    else if (a === '--quiet') o.quiet = true;
    else if (a === '-h' || a === '--help') {
      console.log('see the header of scripts/slimevr-fake-trackers.mjs');
      process.exit(0);
    } else throw new Error(`unknown option ${a}`);
  }
  if (![6, 8, 10].includes(o.trackers)) throw new Error('--trackers must be 6, 8 or 10');
  o.sequence = o.motion.split(',').map((s) => {
    const [m, secs] = s.split(':');
    if (!MOTIONS.includes(m)) throw new Error(`unknown motion "${m}" (expected ${MOTIONS.join(', ')})`);
    return { motion: m, secs: secs ? Number(secs) : Infinity };
  });
  return o;
}

function slerp(a, b, t) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const bb = d < 0 ? b.map((v) => -v) : b;
  d = Math.abs(d);
  if (d > 0.9995) {
    const r = a.map((v, i) => v + (bb[i] - v) * t);
    const n = Math.hypot(...r);
    return r.map((v) => v / n);
  }
  const th = Math.acos(d);
  const s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s;
  const wb = Math.sin(t * th) / s;
  return a.map((v, i) => v * wa + bb[i] * wb);
}

/** Motion player: a looping sequence with 1 s slerp blends between motions. Deterministic. */
export class Player {
  constructor(sequence) {
    this.sequence = sequence;
    this.index = 0;
    this.start = 0;
    this.from = null; // pose to blend from at the start of a segment
  }
  get motion() {
    return this.sequence[this.index].motion;
  }
  switchTo(motion, now, current) {
    this.sequence = [{ motion, secs: Infinity }];
    this.index = 0;
    this.start = now;
    this.from = current;
  }
  sample(now) {
    let seg = this.sequence[this.index];
    while (now - this.start >= seg.secs) {
      const end = this.start + seg.secs;
      this.from = this.raw(seg.motion, end - this.start);
      this.start = end;
      this.index = (this.index + 1) % this.sequence.length;
      seg = this.sequence[this.index];
    }
    return this.blend(seg.motion, now - this.start);
  }
  raw(motion, t) {
    return pose(motion, t);
  }
  blend(motion, t) {
    const p = this.raw(motion, t);
    if (!this.from || t >= 1) return p;
    const k = t * t * (3 - 2 * t);
    const out = {};
    for (const key of Object.keys(p)) out[key] = slerp(this.from[key], p[key], k);
    return out;
  }
}

class Writer {
  constructor(size = 128) {
    this.b = Buffer.alloc(size);
    this.o = 0;
  }
  i32(v) { this.o = this.b.writeInt32BE(v, this.o); return this; }
  i64(v) { this.o = this.b.writeBigInt64BE(BigInt(v), this.o); return this; }
  u8(v) { this.o = this.b.writeUInt8(v & 0xff, this.o); return this; }
  u16(v) { this.o = this.b.writeUInt16BE(v & 0xffff, this.o); return this; }
  f32(v) { this.o = this.b.writeFloatBE(v, this.o); return this; }
  bytes(buf) { buf.copy(this.b, this.o); this.o += buf.length; return this; }
  str8(s) { const s8 = Buffer.from(s, 'ascii'); return this.u8(s8.length).bytes(s8); }
  done() { return this.b.subarray(0, this.o); }
}

const FIRMWARE = 'vpuppet-fake-0.1';
const PROTOCOL_VERSION = 22; // >= 9: server waits for SENSOR_INFO; >= 22: no accel offset fix

class FakeTracker {
  constructor(index, spec, opts, log) {
    this.index = index;
    this.spec = spec;
    this.opts = opts;
    this.log = log;
    this.mac = fakeMac(index);
    this.state = 'handshake';
    this.packetNumber = 1n;
    this.lastHeard = 0;
    this.lastHello = 0;
    this.lastBattery = 0;
    this.sock = dgram.createSocket('udp4');
    this.sock.on('message', (m) => this.onMessage(m));
    this.sock.on('error', (e) => this.log(`[${spec.key}] socket error: ${e.message}`));
  }
  bind() {
    return new Promise((res) => this.sock.bind(0, '0.0.0.0', res));
  }
  send(type, payload) {
    const w = new Writer().i32(type).i64(this.packetNumber++);
    if (payload) payload(w);
    this.sock.send(w.done(), this.opts.port, this.opts.host);
  }
  handshake() {
    const mac = Buffer.from(this.mac.split(':').map((h) => parseInt(h, 16)));
    this.send(3, (w) => w.i32(4 /* CUSTOM board */).i32(4 /* BNO085 */).i32(2 /* ESP32 */)
      .i32(0).i32(0).i32(0).i32(PROTOCOL_VERSION).str8(FIRMWARE).bytes(mac));
  }
  sensorInfo() {
    this.send(15, (w) => w.u8(0).u8(1).u8(4).u16(0).u8(1).u8(this.spec.position).u8(0));
  }
  onMessage(m) {
    this.lastHeard = Date.now();
    if (m.length >= 13 && m[0] === 3 && m.toString('ascii', 1, 11) === 'Hey OVR =D') {
      if (this.state === 'handshake') {
        this.state = 'sensor';
        this.log(`[${this.spec.key}] handshake ok (${this.mac})`);
        this.sensorInfo();
      }
      return;
    }
    if (m.length < 4) return;
    const type = m.readInt32BE(0);
    if (type === 15 && this.state === 'sensor') {
      this.state = 'stream';
      this.log(`[${this.spec.key}] sensor registered as ${this.spec.designation}`);
    } else if (type === 10 && m.length >= 16) {
      const id = m.readInt32BE(12);
      if (this.state === 'stream') this.send(10, (w) => w.i32(id));
    }
  }
  tick(now, q) {
    if (this.state !== 'stream') {
      if (now - this.lastHello > 500) {
        this.lastHello = now;
        if (this.state === 'handshake') this.handshake();
        else this.sensorInfo();
      }
      return;
    }
    if (now - this.lastHeard > 3000) {
      this.log(`[${this.spec.key}] server went quiet, re-handshaking`);
      this.state = 'handshake';
      this.packetNumber = 1n;
      return;
    }
    const [w, x, y, z] = toWire(q);
    this.send(17, (b) => b.u8(0).u8(1).f32(x).f32(y).f32(z).f32(w).u8(0));
    if (now - this.lastBattery > 5000) {
      this.lastBattery = now;
      this.send(12, (b) => b.f32(4.0).f32(0.9));
    }
  }
  userAction(type) {
    this.send(21, (w) => w.u8(type));
  }
  close() {
    try { this.sock.close(); } catch {}
  }
}

function printPoses(o) {
  const player = new Player(o.sequence);
  const specs = TRACKERS.slice(0, o.trackers);
  const frames = Math.round(o.print * o.rate);
  for (let f = 0; f <= frames; f++) {
    const t = f / o.rate;
    const p = player.sample(t);
    const out = { t: Number(t.toFixed(4)), motion: player.motion };
    for (const s of specs) out[s.key] = p[s.key].map((v) => Number(v.toFixed(6)));
    console.log(JSON.stringify(out));
  }
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.print) return printPoses(o);
  const log = o.quiet ? () => {} : (s) => console.log(s);
  const specs = TRACKERS.slice(0, o.trackers);
  const trackers = specs.map((s, i) => new FakeTracker(i, s, o, log));
  await Promise.all(trackers.map((t) => t.bind()));
  log(`fake SlimeVR trackers: ${specs.map((s) => s.key).join(', ')} -> ${o.host}:${o.port} at ${o.rate} Hz`);
  log(`MACs: ${trackers.map((t) => t.mac).join(' ')}`);

  const player = new Player(o.sequence);
  const t0 = Date.now();
  let motionClock = null; // ms when motion time 0 began (after the reset)
  let resetSentAt = null;
  let lastPose = null;
  const STAND_BEFORE_RESET = 1500;
  const AFTER_RESET = 700;

  if (process.stdin.isTTY || !process.stdin.readableEnded) {
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      const m = line.trim();
      if (!m) return;
      if (m === 'reset') {
        trackers[0].userAction(2);
        log('sent full reset');
      } else if (MOTIONS.includes(m) && motionClock !== null) {
        player.switchTo(m, (Date.now() - motionClock) / 1000, lastPose);
        log(`motion -> ${m}`);
      } else log(`unknown command "${m}" (motions: ${MOTIONS.join(', ')}, or "reset")`);
    });
    rl.on('close', () => {});
  }

  const period = 1000 / o.rate;
  let next = Date.now();
  const stand = Object.fromEntries(specs.map((s) => [s.key, qIdentity()]));
  const timer = setInterval(() => {
    const now = Date.now();
    if (now < next) return;
    next += period;
    if (now - next > 100) next = now; // fell behind; don't burst
    const allStreaming = trackers.every((t) => t.state === 'stream');
    if (motionClock === null && allStreaming) {
      if (!o.reset) motionClock = now;
      else if (resetSentAt === null && now - t0 > STAND_BEFORE_RESET) {
        trackers[0].userAction(2);
        resetSentAt = now;
        log('sent full reset (standing pose)');
      } else if (resetSentAt !== null && now - resetSentAt > AFTER_RESET) {
        motionClock = now;
        log(`motion: ${o.sequence.map((s) => s.motion + (isFinite(s.secs) ? `:${s.secs}` : '')).join(',')}`);
      }
    }
    const body = motionClock === null ? stand : player.sample((now - motionClock) / 1000);
    lastPose = body;
    for (const tr of trackers) {
      let q = body[tr.spec.key];
      if (o.mounted) q = qMul(q, STRAPS[tr.spec.key]);
      tr.tick(now, q);
    }
  }, Math.max(1, Math.floor(period / 2)));

  const stop = () => {
    clearInterval(timer);
    trackers.forEach((t) => t.close());
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  if (o.duration) setTimeout(stop, o.duration * 1000);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
