// Build the bundled animation clips (public/clips/ual.glb) from the Quaternius
// Universal Animation Library (CC0 1.0). Run once by a maintainer; the output
// is committed, the sources are not.
//
//   UAL1=/path/UAL1.glb UAL2=/path/UAL2_Standard.glb node scripts/build-builtin-clips.mjs [out.glb]
//
// The output keeps only what retargeting needs:
//  - the skeleton nodes (no mesh, no skin, no textures), with the bind pose
//    baked into the node transforms;
//  - per clip: a rotation track per bone and a translation track for the
//    pelvis. Scale tracks and the other bones' translations are dropped.
//    Rotations are stored as normalized SHORT (glTF allows it for animation
//    samplers), constant tracks as a single key.
// Pure Node: parses and writes GLB directly, no three.js.
import { readFileSync, writeFileSync } from 'node:fs';

// [source, animation name in the source, name in the output]
export const CLIPS = [
  ['UAL1', 'Idle_Loop', 'idle'],
  ['UAL1', 'Idle_LookAround_Loop', 'idle_look'],
  ['UAL1', 'Idle_Talking_Loop', 'idle_talk'],
  ['UAL2', 'Idle_FoldArms_Loop', 'idle_arms_folded'],
  ['UAL2', 'Yes', 'yes'],
  ['UAL2', 'Idle_No_Loop', 'no'],
  ['UAL1', 'Celebration', 'cheer'],
  ['UAL1', 'Dance_Loop', 'dance'],
  ['UAL1', 'Sitting_Idle_Loop', 'sit'],
  ['UAL1', 'Counter_Angry', 'angry'],
  ['UAL1', 'Crying', 'cry'],
  ['UAL1', 'Drink', 'drink'],
];

const SRC = {
  UAL1: process.env.UAL1 ?? '/Volumes/primary_all/game_dev/models/animation/Universal Animation Library[Source]/Unreal-Godot/UAL1.glb',
  UAL2: process.env.UAL2 ?? '/Volumes/primary_all/game_dev/models/animation/Universal Animation Library 2[Standard]/Unreal-Godot/UAL2_Standard.glb',
};
const out = process.argv[2] ?? new URL('../public/clips/ual.glb', import.meta.url).pathname;

function readGlb(path) {
  const b = readFileSync(path);
  if (b.readUInt32LE(0) !== 0x46546c67) throw new Error(`${path}: not a GLB`);
  let off = 12;
  let json = null;
  let bin = null;
  while (off < b.length) {
    const len = b.readUInt32LE(off);
    const type = b.readUInt32LE(off + 4);
    const data = b.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'));
    else if (type === 0x004e4942) bin = data;
    off += 8 + len;
  }
  return { json, bin };
}

const COMP = { 5126: [Float32Array, 4], 5123: [Uint16Array, 2], 5122: [Int16Array, 2], 5121: [Uint8Array, 1], 5120: [Int8Array, 1] };
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function accessor(g, i) {
  const a = g.json.accessors[i];
  const bv = g.json.bufferViews[a.bufferView];
  const [T, size] = COMP[a.componentType];
  const n = NCOMP[a.type];
  if (bv.byteStride && bv.byteStride !== size * n) throw new Error('strided accessors not supported');
  const start = g.bin.byteOffset + (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const copy = new Uint8Array(a.count * n * size);
  copy.set(new Uint8Array(g.bin.buffer, start, copy.length));
  const arr = new T(copy.buffer);
  if (a.componentType !== 5126) throw new Error('expected float accessors in the source');
  return { arr, n, count: a.count };
}

// ---- tiny matrix helpers (column-major 4x4, like glTF)
const mul = (a, b) => {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
};
const trs = (t = [0, 0, 0], q = [0, 0, 0, 1], s = [1, 1, 1]) => {
  const [x, y, z, w] = q;
  const m = [
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
    t[0], t[1], t[2], 1,
  ];
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) m[c * 4 + r] *= s[c];
  return m;
};
function invertRigid(m) {
  // Inverse of an affine matrix with uniform-ish scale (general 3x3 inverse).
  const a = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
  const det = a[0] * (a[4] * a[8] - a[5] * a[7]) - a[3] * (a[1] * a[8] - a[2] * a[7]) + a[6] * (a[1] * a[5] - a[2] * a[4]);
  const i = [
    (a[4] * a[8] - a[5] * a[7]) / det, -(a[1] * a[8] - a[2] * a[7]) / det, (a[1] * a[5] - a[2] * a[4]) / det,
    -(a[3] * a[8] - a[5] * a[6]) / det, (a[0] * a[8] - a[2] * a[6]) / det, -(a[0] * a[5] - a[2] * a[3]) / det,
    (a[3] * a[7] - a[4] * a[6]) / det, -(a[0] * a[7] - a[1] * a[6]) / det, (a[0] * a[4] - a[1] * a[3]) / det,
  ];
  const t = [m[12], m[13], m[14]];
  const it = [0, 1, 2].map((r) => -(i[r] * t[0] + i[3 + r] * t[1] + i[6 + r] * t[2]));
  return [i[0], i[1], i[2], 0, i[3], i[4], i[5], 0, i[6], i[7], i[8], 0, it[0], it[1], it[2], 1];
}
function decompose(m) {
  const sx = Math.hypot(m[0], m[1], m[2]);
  const sy = Math.hypot(m[4], m[5], m[6]);
  const sz = Math.hypot(m[8], m[9], m[10]);
  const r = [m[0] / sx, m[1] / sx, m[2] / sx, m[4] / sy, m[5] / sy, m[6] / sy, m[8] / sz, m[9] / sz, m[10] / sz];
  // column-major r: r[c*3+row]
  const m11 = r[0], m21 = r[1], m31 = r[2], m12 = r[3], m22 = r[4], m32 = r[5], m13 = r[6], m23 = r[7], m33 = r[8];
  const tr = m11 + m22 + m33;
  let q;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    q = [(m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s];
  } else if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
    q = [0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s];
  } else if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
    q = [(m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s];
  } else {
    const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
    q = [(m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s];
  }
  return { t: [m[12], m[13], m[14]], q, s: [sx, sy, sz] };
}

// ---- load sources
const src = {};
for (const k of new Set(CLIPS.map((c) => c[0]))) src[k] = readGlb(SRC[k]);
const ref = src.UAL1 ?? Object.values(src)[0];
const J = ref.json;
const skin = J.skins[0];
const jointSet = new Set(skin.joints);
const keepJoint = (i) => jointSet.has(i) && !/_leaf_|_leaf$/.test(J.nodes[i].name);

// The skeleton must be the same in every source.
for (const [k, g] of Object.entries(src)) {
  const names = g.json.skins[0].joints.map((i) => g.json.nodes[i].name).join(',');
  if (names !== skin.joints.map((i) => J.nodes[i].name).join(',')) throw new Error(`${k}: different skeleton`);
}

// Parent map and world matrices from the node transforms.
const parent = new Map();
J.nodes.forEach((n, i) => (n.children ?? []).forEach((c) => parent.set(c, i)));
const local = (i) => trs(J.nodes[i].translation, J.nodes[i].rotation, J.nodes[i].scale);
const worldOf = (i, loc = local) => (parent.has(i) ? mul(worldOf(parent.get(i), loc), loc(i)) : loc(i));

// Bind pose: inverse of the inverse bind matrices, in the skin's space (the
// mesh node is the skin's frame; here it sits at the identity under Armature).
const ibm = accessor(ref, skin.inverseBindMatrices);
const bindWorld = new Map();
skin.joints.forEach((j, k) => bindWorld.set(j, invertRigid(Array.from(ibm.arr.subarray(16 * k, 16 * k + 16)))));
// Compare with the node rest pose (report only; the bind pose wins).
let maxErr = 0;
for (const j of skin.joints) {
  const a = worldOf(j);
  const b = bindWorld.get(j);
  for (let e = 0; e < 16; e++) maxErr = Math.max(maxErr, Math.abs(a[e] - b[e]));
}
console.log(`node rest vs bind pose: max matrix difference ${maxErr.toExponential(2)}`);

// Bake the bind pose into local transforms (parent bind world^-1 * bind world).
const bakedLocal = new Map();
for (const j of skin.joints) {
  const p = parent.get(j);
  const pw = jointSet.has(p) ? bindWorld.get(p) : worldOf(p);
  bakedLocal.set(j, decompose(mul(invertRigid(pw), bindWorld.get(j))));
}

// ---- output document
const outNodes = [];
const remap = new Map();
function addNode(i) {
  const n = J.nodes[i];
  const o = { name: n.name };
  const b = bakedLocal.get(i);
  const t = b ? b.t : n.translation;
  const r = b ? b.q : n.rotation;
  if (t && t.some((v) => Math.abs(v) > 1e-9)) o.translation = t.map((v) => +v.toFixed(6));
  if (r && Math.abs(r[3]) < 1 - 1e-9) o.rotation = r.map((v) => +v.toFixed(7));
  const idx = outNodes.length;
  outNodes.push(o);
  remap.set(i, idx);
  const kids = (n.children ?? []).filter((c) => keepJoint(c) || (!J.nodes[c].mesh && J.nodes[c].children?.some?.(keepJoint)));
  if (kids.length) o.children = kids.map(addNode);
  return idx;
}
const armature = J.scenes[0].nodes[0];
addNode(armature);

const chunks = [];
let binLen = 0;
const accessors = [];
const bufferViews = [];
function pushData(typed, accessorDef) {
  const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
  const pad = (4 - (binLen % 4)) % 4;
  if (pad) {
    chunks.push(new Uint8Array(pad));
    binLen += pad;
  }
  bufferViews.push({ buffer: 0, byteOffset: binLen, byteLength: bytes.length });
  chunks.push(bytes);
  binLen += bytes.length;
  accessors.push({ bufferView: bufferViews.length - 1, ...accessorDef });
  return accessors.length - 1;
}
const minmax = (arr) => [[Math.min(...arr)], [Math.max(...arr)]];

const animations = [];
const report = [];
for (const [key, srcName, outName] of CLIPS) {
  const g = src[key];
  const a = g.json.animations.find((x) => x.name === srcName);
  if (!a) throw new Error(`${key}: no animation ${srcName}`);
  const channels = [];
  const samplers = [];
  let timeAcc = null;
  let oneKeyAcc = null;
  const times = accessor(g, a.samplers[a.channels[0].sampler].input).arr;
  for (const ch of a.channels) {
    const node = ch.target.node;
    const name = g.json.nodes[node].name;
    const refIdx = J.nodes.findIndex((n) => n.name === name);
    if (!remap.has(refIdx)) continue;
    const isPelvis = name === 'pelvis';
    if (ch.target.path === 'scale') continue;
    if (ch.target.path === 'translation' && !isPelvis) continue;
    const s = a.samplers[ch.sampler];
    if (s.interpolation !== 'LINEAR') throw new Error(`${srcName}: ${s.interpolation} sampler`);
    const inp = accessor(g, s.input).arr;
    if (inp.length !== times.length || inp.some((v, i) => Math.abs(v - times[i]) > 1e-5)) throw new Error(`${srcName}: mixed key times`);
    const val = accessor(g, s.output);
    const n = val.n;
    // Constant track: one key.
    let constant = true;
    for (let k = 1; k < val.count && constant; k++) for (let c = 0; c < n; c++) if (Math.abs(val.arr[k * n + c] - val.arr[c]) > 1e-4) constant = false;
    const count = constant ? 1 : val.count;
    let input;
    if (constant) {
      oneKeyAcc ??= pushData(new Float32Array([0]), { componentType: 5126, count: 1, type: 'SCALAR', min: [0], max: [0] });
      input = oneKeyAcc;
    } else {
      const t0 = times[0];
      const tt = Float32Array.from(times, (v) => v - t0);
      timeAcc ??= pushData(tt, { componentType: 5126, count: tt.length, type: 'SCALAR', ...Object.fromEntries([['min', minmax(tt)[0]], ['max', minmax(tt)[1]]]) });
      input = timeAcc;
    }
    let output;
    if (ch.target.path === 'rotation') {
      const q = new Int16Array(count * 4);
      for (let k = 0; k < count; k++) {
        // Keep consecutive keys in the same hemisphere so LINEAR (slerp) never flips.
        let sgn = 1;
        if (k > 0) {
          let d = 0;
          for (let c = 0; c < 4; c++) d += val.arr[k * 4 + c] * (q[(k - 1) * 4 + c] / 32767);
          if (d < 0) sgn = -1;
        }
        for (let c = 0; c < 4; c++) q[k * 4 + c] = Math.round(Math.max(-1, Math.min(1, sgn * val.arr[k * 4 + c])) * 32767);
      }
      output = pushData(q, { componentType: 5122, normalized: true, count, type: 'VEC4' });
    } else {
      const v = Float32Array.from(val.arr.subarray(0, count * n));
      output = pushData(v, { componentType: 5126, count, type: 'VEC3' });
    }
    samplers.push({ input, output, interpolation: 'LINEAR' });
    channels.push({ sampler: samplers.length - 1, target: { node: remap.get(refIdx), path: ch.target.path } });
  }
  animations.push({ name: outName, channels, samplers, extras: { source: `${key === 'UAL1' ? 'Universal Animation Library' : 'Universal Animation Library 2'} / ${srcName}` } });
  report.push(`${outName.padEnd(18)} <- ${key}/${srcName} (${(times[times.length - 1] - times[0]).toFixed(2)} s, ${channels.length} tracks)`);
}

const json = {
  asset: {
    version: '2.0',
    generator: 'puppet scripts/build-builtin-clips.mjs',
    copyright: 'Animations by Quaternius (Universal Animation Library 1 and 2), CC0 1.0. https://quaternius.com',
  },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: outNodes,
  animations,
  accessors,
  bufferViews,
  buffers: [{ byteLength: binLen }],
};
let jsonBuf = Buffer.from(JSON.stringify(json));
jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
let bin = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
bin = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
const ch = (len, type) => {
  const h = Buffer.alloc(8);
  h.writeUInt32LE(len, 0);
  h.writeUInt32LE(type, 4);
  return h;
};
const glb = Buffer.concat([header, ch(jsonBuf.length, 0x4e4f534a), jsonBuf, ch(bin.length, 0x004e4942), bin]);
writeFileSync(out, glb);
console.log(report.join('\n'));
console.log(`wrote ${out}: ${(glb.length / 1024).toFixed(1)} KiB, ${outNodes.length} nodes, ${animations.length} clips`);
