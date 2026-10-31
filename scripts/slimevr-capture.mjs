#!/usr/bin/env node
// Capture VMC (OSC over UDP) traffic to JSON lines and summarise it.
//
//   node scripts/slimevr-capture.mjs [--port 39539] [--seconds 5] [--keep-hz 0] [--out file.jsonl] [--meta '{...}']
//
// Output format (one JSON object per line; see docs/slimevr-testing.md "Fixture format"):
//   line 1: {"meta": {format, port, seconds, startedAt, ...extra --meta fields}}
//   then one line per OSC message, in arrival order:
//   {"t": 0.0123, "d": 0, "address": "/VMC/Ext/Bone/Pos", "types": ",sfffffff", "args": ["Hips", px, py, pz, qx, qy, qz, qw]}
//     t     seconds since the capture started (receive time of the datagram, ms resolution)
//     d     datagram index; messages from the same OSC bundle share it (= one sender frame).
//           With --keep-hz the capture keeps only whole datagrams at about that rate, so d has gaps.
//     types the OSC type-tag string, so ints and floats can be told apart on replay
import dgram from 'node:dgram';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import { decodePacket } from './lib/osc.mjs';

export const FORMAT = 'vpuppet-vmc-capture/1';

/** Listen on `port` for `seconds`; resolve with { meta, lines } (lines = message records). */
/** keepHz > 0 keeps whole datagrams at no more than ~keepHz (all of them when 0). */
export function capture({ port = 39539, seconds = 5, keepHz = 0, meta = {} } = {}) {
  return new Promise((resolve, reject) => {
    const lines = [];
    let d = 0;
    let kept = 0;
    let t0 = null;
    let lastKept = -Infinity;
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: false });
    sock.on('error', reject);
    sock.on('message', (b) => {
      const now = performance.now();
      if (t0 === null) t0 = now;
      const t = Math.round(now - t0) / 1000;
      if (!keepHz || now - lastKept >= 1000 / keepHz - 0.5) {
        lastKept = now;
        kept++;
        for (const m of decodePacket(b)) lines.push({ t, d, address: m.address, types: m.types, args: m.args });
      }
      d++;
    });
    sock.bind(port, '0.0.0.0', () => {
      setTimeout(() => {
        sock.close();
        resolve({
          meta: {
            format: FORMAT,
            port,
            seconds,
            startedAt: new Date().toISOString(),
            datagrams: d,
            datagramsPerSecond: Math.round((d / seconds) * 10) / 10,
            keptDatagrams: kept,
            keepHz,
            ...meta,
          },
          lines,
        });
      }, seconds * 1000);
    });
  });
}

const r6 = (v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v);

export function writeJsonl(file, { meta, lines }) {
  const out = [JSON.stringify({ meta })];
  for (const l of lines) out.push(JSON.stringify({ ...l, args: l.args.map(r6) }));
  fs.writeFileSync(file, out.join('\n') + '\n');
}

function angleDeg(a, b) {
  const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return (2 * Math.acos(Math.min(1, d)) * 180) / Math.PI;
}

/** Human-readable summary: addresses, rates, bones, and how much each bone rotates. */
export function summarise({ meta, lines }) {
  const out = [];
  const span = lines.length ? lines[lines.length - 1].t - lines[0].t || 1 : 1;
  out.push(`${meta.datagrams} datagrams in ${meta.seconds}s (${meta.datagramsPerSecond}/s), kept ${meta.keptDatagrams}`);
  const byAddr = new Map();
  for (const l of lines) byAddr.set(l.address, (byAddr.get(l.address) ?? 0) + 1);
  for (const [a, n] of byAddr) out.push(`  ${a}: ${n} (${(n / span).toFixed(1)}/s)`);
  const bones = new Map();
  for (const l of lines) {
    if (l.address !== '/VMC/Ext/Bone/Pos') continue;
    const q = l.args.slice(4, 8);
    const b = bones.get(l.args[0]) ?? { first: q, firstPos: l.args.slice(1, 4), max: 0, n: 0 };
    b.max = Math.max(b.max, angleDeg(b.first, q));
    b.last = q;
    b.n++;
    bones.set(l.args[0], b);
  }
  if (bones.size) {
    out.push(`  bones (${bones.size}): rotation range over the capture (deg), first local pos`);
    for (const [name, b] of bones)
      out.push(`    ${name.padEnd(18)} ${b.max.toFixed(1).padStart(6)}  pos [${b.firstPos.map((v) => v.toFixed(3)).join(', ')}]`);
  }
  for (const a of ['/VMC/Ext/Root/Pos', '/VMC/Ext/OK', '/VMC/Ext/T']) {
    const l = lines.find((x) => x.address === a);
    if (l) out.push(`  sample ${a} ${l.types} ${JSON.stringify(l.args.map(r6))}`);
  }
  return out.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  const opt = (name, def) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : def;
  };
  const result = await capture({
    port: Number(opt('--port', 39539)),
    seconds: Number(opt('--seconds', 5)),
    keepHz: Number(opt('--keep-hz', 0)),
    meta: JSON.parse(opt('--meta', '{}')),
  });
  console.log(summarise(result));
  const out = opt('--out');
  if (out) {
    writeJsonl(out, result);
    console.log(`wrote ${result.lines.length} messages to ${out}`);
  }
}
