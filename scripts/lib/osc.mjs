// Tiny OSC 1.0 decoder (messages + nested bundles) for the VMC tooling. No dependencies.

const str = (b, o) => {
  let e = o;
  while (e < b.length && b[e] !== 0) e++;
  return [b.toString('utf8', o, e), (e + 4) & ~3];
};

/** Decode one OSC message at offset o. Returns { address, types, args }. */
export function decodeMessage(b, o = 0) {
  let address, tags;
  [address, o] = str(b, o);
  [tags, o] = str(b, o);
  const args = [];
  for (const t of tags.slice(1)) {
    if (t === 'f') {
      args.push(b.readFloatBE(o));
      o += 4;
    } else if (t === 'i') {
      args.push(b.readInt32BE(o));
      o += 4;
    } else if (t === 'd') {
      args.push(b.readDoubleBE(o));
      o += 8;
    } else if (t === 'h') {
      args.push(Number(b.readBigInt64BE(o)));
      o += 8;
    } else if (t === 's') {
      let s;
      [s, o] = str(b, o);
      args.push(s);
    } else if (t === 'T') args.push(true);
    else if (t === 'F') args.push(false);
    else if (t === 'N') args.push(null);
    else throw new Error(`unsupported OSC type tag ${t} in ${address}`);
  }
  return { address, types: tags, args };
}

/** Decode a datagram into a flat list of messages (bundles flattened in order). */
export function decodePacket(b, o = 0, end = b.length, out = []) {
  if (b.toString('utf8', o, o + 7) === '#bundle') {
    o += 16; // "#bundle\0" + 8-byte timetag
    while (o < end) {
      const n = b.readInt32BE(o);
      decodePacket(b, o + 4, o + 4 + n, out);
      o += 4 + n;
    }
  } else out.push(decodeMessage(b, o));
  return out;
}
