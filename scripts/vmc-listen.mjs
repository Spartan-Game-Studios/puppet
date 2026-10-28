// Minimal VMC/OSC listener for checking Puppet's output.
//   node scripts/vmc-listen.mjs [port=39539] [seconds=5] [blends]
// With `blends`, also lists every /VMC/Ext/Blend/Val name and its peak value.
// Prints message counts per address and a few sample values.
import dgram from 'node:dgram';

const port = Number(process.argv[2] ?? 39539);
const seconds = Number(process.argv[3] ?? 5);
const counts = new Map();
const samples = new Map();
let datagrams = 0;
const blendPeak = new Map();

const str = (b, o) => {
  let e = o;
  while (b[e] !== 0) e++;
  return [b.toString('utf8', o, e), (e + 4) & ~3];
};

function message(b, o) {
  let addr, tags;
  [addr, o] = str(b, o);
  [tags, o] = str(b, o);
  const args = [];
  for (const t of tags.slice(1)) {
    if (t === 'f') {
      args.push(b.readFloatBE(o));
      o += 4;
    } else if (t === 'i') {
      args.push(b.readInt32BE(o));
      o += 4;
    } else if (t === 's') {
      let s;
      [s, o] = str(b, o);
      args.push(s);
    }
  }
  counts.set(addr, (counts.get(addr) ?? 0) + 1);
  if (addr === '/VMC/Ext/Blend/Val') blendPeak.set(args[0], Math.max(blendPeak.get(args[0]) ?? 0, args[1]));
  samples.set(addr + (typeof args[0] === 'string' ? ` ${args[0]}` : ''), args);
}

function packet(b, o, end) {
  if (b.toString('utf8', o, o + 7) === '#bundle') {
    o += 16;
    while (o < end) {
      const n = b.readInt32BE(o);
      packet(b, o + 4, o + 4 + n);
      o += 4 + n;
    }
  } else message(b, o);
}

const sock = dgram.createSocket('udp4');
sock.on('message', (b) => {
  datagrams++;
  packet(b, 0, b.length);
});
sock.bind(port, () => console.log(`listening on ${port} for ${seconds}s`));
setTimeout(() => {
  sock.close();
  console.log(`datagrams: ${datagrams}`);
  for (const [a, n] of counts) console.log(`${a}: ${n}`);
  for (const k of [
    '/VMC/Ext/OK',
    '/VMC/Ext/Root/Pos root',
    '/VMC/Ext/Bone/Pos Hips',
    '/VMC/Ext/Bone/Pos Head',
    '/VMC/Ext/Bone/Pos LeftThumbProximal',
    '/VMC/Ext/Blend/Val jawOpen',
    '/VMC/Ext/Blend/Val eyeBlinkLeft',
  ]) {
    if (samples.has(k)) console.log(k, JSON.stringify(samples.get(k)));
  }
  if (process.argv[4] === 'blends')
    console.log(`blends (${blendPeak.size}, peak): ${[...blendPeak].map(([n, v]) => `${n}=${v.toFixed(2)}`).join(' ')}`);
}, seconds * 1000);
