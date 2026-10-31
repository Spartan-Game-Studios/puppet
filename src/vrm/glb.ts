/**
 * GLB container read/write, for editing a VRM without touching its geometry:
 * the JSON chunk is parsed, changed and re-serialised; the BIN chunk (and any
 * other chunk) is written back byte for byte.
 */

const MAGIC = 0x46546c67; // "glTF"
const JSON_CHUNK = 0x4e4f534a;

export interface GlbChunk {
  type: number;
  data: Uint8Array;
}

export interface Glb {
  // glTF JSON is untyped by nature; the doctor reads it defensively.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: Record<string, any>;
  /** Every chunk after the JSON one, in order (normally just BIN). */
  chunks: GlbChunk[];
}

export function readGlb(buf: ArrayBuffer): Glb {
  const dv = new DataView(buf);
  if (buf.byteLength < 20 || dv.getUint32(0, true) !== MAGIC) throw new Error('NOT A VRM (NOT A GLB FILE)');
  const total = Math.min(dv.getUint32(8, true), buf.byteLength);
  let off = 12;
  let json: Glb['json'] | null = null;
  const chunks: GlbChunk[] = [];
  while (off + 8 <= total) {
    const len = dv.getUint32(off, true);
    const type = dv.getUint32(off + 4, true);
    if (off + 8 + len > total) throw new Error('NOT A VRM (TRUNCATED GLB)');
    const data = new Uint8Array(buf, off + 8, len);
    if (json === null) {
      if (type !== JSON_CHUNK) throw new Error('NOT A VRM (BAD GLB JSON CHUNK)');
      json = JSON.parse(new TextDecoder().decode(data));
    } else {
      chunks.push({ type, data: data.slice() });
    }
    off += 8 + len;
  }
  if (!json || typeof json !== 'object') throw new Error('NOT A VRM (BAD GLB JSON)');
  return { json, chunks };
}

/** Chunks are 4-byte aligned: JSON pads with spaces, binary with zeros. */
function padded(data: Uint8Array, fill: number): Uint8Array {
  const n = (4 - (data.byteLength % 4)) % 4;
  if (!n) return data;
  const out = new Uint8Array(data.byteLength + n).fill(fill);
  out.set(data);
  return out;
}

export function writeGlb(g: Glb): ArrayBuffer {
  const parts = [{ type: JSON_CHUNK, data: padded(new TextEncoder().encode(JSON.stringify(g.json)), 0x20) }];
  for (const c of g.chunks) parts.push({ type: c.type, data: padded(c.data, 0) });
  const total = 12 + parts.reduce((n, p) => n + 8 + p.data.byteLength, 0);
  const out = new ArrayBuffer(total);
  const dv = new DataView(out);
  const u8 = new Uint8Array(out);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  let off = 12;
  for (const p of parts) {
    dv.setUint32(off, p.data.byteLength, true);
    dv.setUint32(off + 4, p.type, true);
    u8.set(p.data, off + 8);
    off += 8 + p.data.byteLength;
  }
  return out;
}
