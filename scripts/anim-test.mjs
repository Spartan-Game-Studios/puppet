// Animation clip test: plays clips on one or more VRMs in headless Chrome
// (harness/anim.ts), saves a contact sheet and an mp4 per clip and model, and
// compares limb directions between the avatars (a VRM 0.x and a VRM 1.0 should
// move the same) and frame to frame (no flipped limbs, no physics blow-ups).
//
//   PUPPET_MODELS=/a.vrm,/b.vrm [PUPPET_FBX=/clip.fbx] [PUPPET_CLIPS=builtin:wave,...]
//     node scripts/anim-test.mjs out/
//
// Outputs derive from the models you feed it: keep them out of the repo.
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { basename, join } from 'node:path';
import { launch, serveLocal } from './lib/browser.mjs';
import { startVite } from './lib/vite.mjs';

const out = process.argv[2] ?? 'harness/out/anim';
const models = (process.env.PUPPET_MODELS ?? '').split(',').filter(Boolean);
if (!models.length) {
  console.error('Set PUPPET_MODELS to one or more .vrm paths (comma separated).');
  process.exit(2);
}
const fbx = process.env.PUPPET_FBX;
const only = (process.env.PUPPET_CLIPS ?? '').split(',').filter(Boolean);
const mp4 = process.env.PUPPET_MP4 !== '0';
await mkdir(out, { recursive: true });

const vite = await startVite(Number(process.env.PUPPET_PORT ?? 5211));
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 600, height: 400 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => (m.type() === 'error' || process.env.PUPPET_VERBOSE) && console.log(`[${m.type()}]`, m.text()));
const map = {};
models.forEach((m, i) => (map[`/__local/model${i}.vrm`] = m));
if (fbx) map[`/__local/clip.${fbx.split('.').pop().toLowerCase()}`] = fbx;
await serveLocal(page, map);
await page.goto(`${vite.url}/harness/?test=anim`);
await page.waitForFunction(() => window.__animReady, null, { timeout: 60000 });

const angle = (a, b) => (Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180) / Math.PI;
const results = {}; // model -> clip -> run
let clipIds = null;
let fbxIds = [];

for (const [i, m] of models.entries()) {
  const info = await page.evaluate((u) => window.__anim.load(u), `/__local/model${i}.vrm`);
  const tag = `${i}-${info.vrm0 ? 'vrm0' : 'vrm1'}`;
  console.log(`model ${tag}: ${info.name} (${basename(m)}), ${info.bones} bones, ${info.springs} spring joints`);
  if (fbx && !fbxIds.length) {
    fbxIds = await page.evaluate(([u, n]) => window.__anim.importClip(u, n), [`/__local/clip.${fbx.split('.').pop().toLowerCase()}`, basename(fbx)]);
    console.log(`imported ${basename(fbx)}: ${fbxIds.map((c) => `${c.label} [${c.rig}] ${c.duration.toFixed(2)} s`).join(', ')}`);
  }
  clipIds ??= (await page.evaluate(() => window.__anim.clips())).map((c) => c.id).filter((id) => !only.length || only.includes(id));
  const ids = ['none', ...clipIds, ...fbxIds.map((c) => c.id).filter((id) => !clipIds.includes(id))];
  results[tag] = {};
  for (const id of ids) {
    const r = await page.evaluate(([id]) => window.__anim.run(id, { every: 2 }), [id]);
    results[tag][id] = r;
    const name = id.replace(/[^a-z0-9_]+/gi, '_');
    // Frame-to-frame flips.
    let maxStep = 0;
    let at = '';
    for (let k = 1; k < r.samples.length; k++) {
      for (const [b, d] of Object.entries(r.samples[k].d)) {
        if (b.endsWith('Q')) continue;
        const p = r.samples[k - 1].d[b];
        if (!p) continue;
        const s = angle(p, d);
        if (s > maxStep) {
          maxStep = s;
          at = `${b}@${r.samples[k].t.toFixed(2)}s`;
        }
      }
    }
    r.maxStep = maxStep;
    r.maxStepAt = at;
    console.log(`  ${r.label.padEnd(22)} ${r.mask.padEnd(5)} ${r.duration.toFixed(2)} s  max limb step ${maxStep.toFixed(1)}°/frame (${at})  max spring ${r.maxSpring.toFixed(2)} m/s @${(r.maxSpringAt ?? 0).toFixed(2)}s`);
    if (mp4) {
      const dir = join(out, `.frames-${tag}-${name}`);
      await mkdir(dir, { recursive: true });
      await Promise.all(r.frames.map((f, k) => writeFile(join(dir, `${String(k).padStart(4, '0')}.jpg`), Buffer.from(f.split(',')[1], 'base64'))));
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '15', '-i', join(dir, '%04d.jpg'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(out, `${tag}-${name}.mp4`)]);
      await rm(dir, { recursive: true });
    }
  }
}

// Contact sheet per model: 6 moments per clip, front + side.
for (const [tag, runs] of Object.entries(results)) {
  const rows = Object.values(runs).map((r) => {
    const n = r.frames.length;
    const picks = [0.1, 0.25, 0.4, 0.55, 0.7, 0.85].map((x) => r.frames[Math.min(n - 1, Math.floor(x * n))]);
    return { label: `${r.label} [${r.mask}]`, picks };
  });
  const png = await page.evaluate(async (rows) => {
    const W = 512, H = 320, S = 0.5, LBL = 150;
    const c = document.createElement('canvas');
    c.width = LBL + 6 * W * S;
    c.height = rows.length * H * S;
    const g = c.getContext('2d');
    g.fillStyle = '#111';
    g.fillRect(0, 0, c.width, c.height);
    g.font = 'bold 13px monospace';
    for (const [ri, row] of rows.entries()) {
      g.fillStyle = '#fff';
      g.fillText(row.label, 6, ri * H * S + 20);
      for (const [ci, src] of row.picks.entries()) {
        const img = new Image();
        img.src = src;
        await img.decode();
        g.drawImage(img, LBL + ci * W * S, ri * H * S, W * S, H * S);
      }
    }
    return c.toDataURL('image/png');
  }, rows);
  await writeFile(join(out, `contact-${tag}.png`), Buffer.from(png.split(',')[1], 'base64'));
}

// Cross-model agreement: same clip, same moment, angle between limb directions.
const tags = Object.keys(results);
const summary = { models: tags, clips: {} };
for (let a = 0; a < tags.length; a++) {
  for (let b = a + 1; b < tags.length; b++) {
    console.log(`\nagreement ${tags[a]} vs ${tags[b]} (limb direction difference, degrees: mean / p95 / max):`);
    for (const id of Object.keys(results[tags[a]])) {
      const ra = results[tags[a]][id];
      const rb = results[tags[b]][id];
      if (!rb) continue;
      const diffs = [];
      const byBone = {};
      for (let k = 0; k < Math.min(ra.samples.length, rb.samples.length); k++) {
        for (const [bone, d] of Object.entries(ra.samples[k].d)) {
          if (bone.endsWith('Q')) continue;
          const e = rb.samples[k].d[bone];
          if (!e) continue;
          const x = angle(d, e);
          diffs.push(x);
          byBone[bone] = Math.max(byBone[bone] ?? 0, x);
        }
      }
      const worst = Object.entries(byBone).sort((x, y) => y[1] - x[1])[0] ?? ['-', 0];
      diffs.sort((x, y) => x - y);
      const mean = diffs.reduce((s, x) => s + x, 0) / Math.max(1, diffs.length);
      const p95 = diffs[Math.floor(0.95 * (diffs.length - 1))] ?? 0;
      const max = diffs[diffs.length - 1] ?? 0;
      console.log(`  ${ra.label.padEnd(22)} ${mean.toFixed(1).padStart(5)} / ${p95.toFixed(1).padStart(5)} / ${max.toFixed(1).padStart(5)}  worst ${worst[0]}`);
      (summary.clips[id] ??= {})[`${tags[a]}~${tags[b]}`] = { mean, p95, max };
    }
  }
}
for (const [tag, runs] of Object.entries(results))
  for (const [id, r] of Object.entries(runs)) Object.assign((summary.clips[id] ??= {}), { [tag]: { maxStep: r.maxStep, maxStepAt: r.maxStepAt, maxSpring: r.maxSpring } });
await writeFile(join(out, 'summary.json'), JSON.stringify(summary, null, 1));
console.log(`\nwrote ${out}`);
await browser.close();
vite.close();
