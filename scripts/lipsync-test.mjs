// Mic lip sync end to end: generates a WAV of five synthetic vowels (a i u e o,
// each 0.6 s with 0.4 s of silence between), feeds it to headless Chrome as a
// fake microphone (--use-file-for-fake-audio-capture), and checks what the
// avatar's mouth did for each vowel and in the gaps.
//
//   PUPPET_MODEL=/path/avatar.vrm [PUPPET_LIPSYNC_MODE=audio|blend|fallback] node scripts/lipsync-test.mjs [out.json]
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, serveLocal, requireEnv } from './lib/browser.mjs';
import { startVite } from './lib/vite.mjs';

const model = requireEnv('PUPPET_MODEL');
const mode = process.env.PUPPET_LIPSYNC_MODE ?? 'fallback';
const SR = 48000;
// Formants as in src/audio/visemes.ts VOWELS, but nudged so this is not the prototype itself.
const SEQ = [
  ['aa', 730, 1250],
  ['ih', 330, 2300],
  ['ou', 370, 950],
  ['ee', 540, 1800],
  ['oh', 500, 870],
];
const VOWEL = 0.6;
const GAP = 0.4;

function synth(f1, f2, n, f0 = 130) {
  const res = (f, fc, bw) => 1 / Math.sqrt(1 + ((f - fc) / (bw / 2)) ** 2);
  const hs = [];
  for (let h = 1; h * f0 < 5000; h++) {
    const f = h * f0;
    hs.push([f, (1 / h) * (0.02 + res(f, f1, 120) + 0.8 * res(f, f2, 160) + 0.3 * res(f, 2900, 250))]);
  }
  const norm = hs.reduce((m, [, a]) => m + a, 0);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let s = 0;
    // a little vibrato so it isn't a static tone
    for (const [f, a] of hs) s += a * Math.sin(2 * Math.PI * f * (t + 0.0015 * Math.sin(2 * Math.PI * 5 * t)));
    const env = Math.min(1, i / (0.03 * SR), (n - i) / (0.03 * SR));
    out[i] = (0.35 * env * s) / norm;
  }
  return out;
}

const per = Math.round((VOWEL + GAP) * SR);
const pcm = new Int16Array(per * SEQ.length);
SEQ.forEach(([, f1, f2], k) => {
  const v = synth(f1, f2, Math.round(VOWEL * SR));
  for (let i = 0; i < v.length; i++) pcm[k * per + i] = Math.round(Math.max(-1, Math.min(1, v[i])) * 32767);
});
const wav = Buffer.alloc(44 + pcm.length * 2);
wav.write('RIFF', 0);
wav.writeUInt32LE(36 + pcm.length * 2, 4);
wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(SR, 24);
wav.writeUInt32LE(SR * 2, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36);
wav.writeUInt32LE(pcm.length * 2, 40);
Buffer.from(pcm.buffer).copy(wav, 44);
const dir = await mkdtemp(join(tmpdir(), 'puppet-lipsync-'));
const wavPath = join(dir, 'vowels.wav');
await writeFile(wavPath, wav);

const vite = await startVite(Number(process.env.PUPPET_PORT ?? 5214));
const browser = await launch({ extraArgs: ['--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wavPath}`] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await serveLocal(page, { '/__local/model.vrm': model });
await page.goto(`${vite.url}/harness/?test=lipsync`);
await page.waitForFunction(() => window.__lipsyncReady, null, { timeout: 60000 });
const info = await page.evaluate(([m]) => window.__lipsync.start('/__local/model.vrm', m), [mode]);
console.log(`model: ${info.perfectSync ? 'perfect sync' : `presets ${info.presets.join(' ')}`}; mic: ${info.label}; mode ${mode}`);
const rec = await page.evaluate(() => window.__lipsync.record(11));
await browser.close();
vite.close();

// Segment by level: voiced runs vs gaps.
const voiced = rec.map((r) => Number.isFinite(r.db) && r.db > -45);
const runs = [];
let cur = null;
rec.forEach((r, i) => {
  if (voiced[i] && !cur) cur = { start: i, end: i };
  else if (voiced[i]) cur.end = i;
  else if (cur) {
    if (rec[cur.end].t - rec[cur.start].t > 0.3) runs.push(cur);
    cur = null;
  }
});
const VIS = ['aa', 'ih', 'ou', 'ee', 'oh'];
const mouthOf = (r) => {
  const e = r.expr;
  return info.perfectSync ? Object.entries(e).filter(([k]) => /jaw|mouth/i.test(k)).reduce((m, [, v]) => Math.max(m, v), 0) : VIS.reduce((m, v) => Math.max(m, e[v] ?? 0), 0);
};
const found = runs.map((run) => {
  const mid = rec.slice(run.start + 4, run.end - 3);
  const votes = Object.fromEntries(VIS.map((v) => [v, 0]));
  for (const r of mid) votes[VIS.reduce((a, b) => ((r.vis[b] ?? 0) > (r.vis[a] ?? 0) ? b : a))]++;
  const top = VIS.reduce((a, b) => (votes[b] > votes[a] ? b : a));
  const mouth = mid.reduce((s, r) => s + mouthOf(r), 0) / Math.max(1, mid.length);
  const f1 = mid.reduce((s, r) => s + r.f1, 0) / Math.max(1, mid.length);
  const f2 = mid.reduce((s, r) => s + r.f2, 0) / Math.max(1, mid.length);
  return { top, share: votes[top] / Math.max(1, mid.length), mouth, f1, f2 };
});
// Gaps: frames well inside silence.
const gapMouth = [];
rec.forEach((r, i) => {
  const w = rec.slice(Math.max(0, i - 14), i + 1); // 0.25 s into the gap (release time)
  if (w.length === 15 && w.every((x) => !Number.isFinite(x.db) || x.db < -60)) gapMouth.push(mouthOf(r));
});
// Align with the sequence (the fake device loops the file from an unknown point).
const order = SEQ.map((s) => s[0]);
let bestRot = 0;
let bestHits = -1;
for (let rot = 0; rot < 5; rot++) {
  const hits = found.filter((f, k) => f.top === order[(k + rot) % 5]).length;
  if (hits > bestHits) {
    bestHits = hits;
    bestRot = rot;
  }
}
console.log('vowel  heard  share  F1/F2 (Hz)   mouth');
found.forEach((f, k) => console.log(`${order[(k + bestRot) % 5].padEnd(6)} ${f.top.padEnd(6)} ${(f.share * 100).toFixed(0).padStart(4)}%  ${f.f1.toFixed(0).padStart(4)}/${f.f2.toFixed(0).padEnd(5)}  ${f.mouth.toFixed(2)}`));
const gapMax = gapMouth.length ? Math.max(...gapMouth) : NaN;
console.log(`${bestHits}/${found.length} vowels matched; mouth in silence: max ${gapMax.toFixed(3)} over ${gapMouth.length} frames`);
if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify({ info, found, gapMax, rec }, null, 1));
process.exitCode = found.length >= 5 && bestHits >= Math.ceil(0.8 * found.length) && gapMax < 0.1 ? 0 : 1;
