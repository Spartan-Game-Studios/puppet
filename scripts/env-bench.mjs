// Benchmark the 3D environments: render fps, frame time and tracking rates for
// every preset at LOW and HIGH, against the flat background, in capture view
// at 1920×1080. Optionally saves a screenshot per preset and measures the
// avatar's face brightness (to catch blown-out or black faces).
//
//   PUPPET_MODEL=avatar.vrm PUPPET_CLIP=clip.webm node scripts/env-bench.mjs [out-dir]
//
// PUPPET_UNCAPPED=1 turns off vsync and the frame-rate limit so fps shows
// headroom above 60. PUPPET_SECONDS sets the sample length per case (default 8).
// PUPPET_ONLY="moor,forest" limits the presets. PUPPET_DOF=1 adds a depth-of-field case. Shots and results land in
// out-dir (keep it outside the repo if the model isn't redistributable).
import { mkdir, writeFile } from 'node:fs/promises';
import { BASE, launch, requireEnv, serveLocal } from './lib/browser.mjs';

const outDir = process.argv[2] ?? null;
const model = requireEnv('PUPPET_MODEL');
const clip = process.env.PUPPET_CLIP;
const seconds = Number(process.env.PUPPET_SECONDS ?? 8);
const uncapped = process.env.PUPPET_UNCAPPED === '1';
const presets = (process.env.PUPPET_ONLY ?? 'studio,room,moor,forest,neon,hall').split(',');
const W = Number(process.env.PUPPET_W ?? 1920);
const H = Number(process.env.PUPPET_H ?? 1080);

const browser = await launch({
  extraArgs: uncapped ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : [],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !/XNNPACK|TensorFlow/.test(m.text())) console.log('[error]', m.text());
});
const map = { '/__local/model.vrm': model };
if (clip) map['/__local/clip.webm'] = clip;
await serveLocal(page, map);
const qs = new URLSearchParams({ model: '/__local/model.vrm', capture: '1' });
if (clip) {
  qs.set('source', 'file');
  qs.set('src', '/__local/clip.webm');
}
await page.goto(`${BASE}/?${qs}`);
// (With vsync off, headless Chrome stops delivering video frames to the tracker, so only wait for tracking when capped.)
await page.waitForFunction((u) => window.__puppet?.avatar && (u || window.__puppet.tracker.stats.face.fps > 0), uncapped, { timeout: 60000 });
await page.evaluate(() => window.__puppet.frame('upper'));
if (outDir) await mkdir(outDir, { recursive: true });

async function sample(label) {
  await page.waitForTimeout(3000); // settle: shader compile, tracker rate windows
  const a = await page.evaluate(() => ({ f: window.__puppet.frames, t: performance.now() }));
  const track = [];
  const frameMs = [];
  for (let i = 0; i < seconds; i++) {
    await page.waitForTimeout(1000);
    const s = await page.evaluate(() => {
      const st = window.__puppet.tracker.stats;
      return { face: st.face.fps, body: st.body.fps, fi: st.face.infer, pi: st.body.pose, ms: document.getElementById('d-render').textContent };
    });
    track.push(s);
    const m = /([\d.]+)MS/.exec(s.ms);
    if (m) frameMs.push(Number(m[1]));
  }
  const b = await page.evaluate(() => ({ f: window.__puppet.frames, t: performance.now() }));
  const mean = (xs) => xs.reduce((x, y) => x + y, 0) / Math.max(1, xs.length);
  const face = await faceLuma();
  const r = {
    label,
    fps: +(((b.f - a.f) * 1000) / (b.t - a.t)).toFixed(1),
    cpuFrameMs: +mean(frameMs).toFixed(2),
    trackFace: +mean(track.map((x) => x.face)).toFixed(1),
    trackBody: +mean(track.map((x) => x.body)).toFixed(1),
    inferFace: +mean(track.map((x) => x.fi)).toFixed(1),
    inferPose: +mean(track.map((x) => x.pi)).toFixed(1),
    faceLuma: face.mean,
    faceClipped: face.clipped,
    faceBlack: face.black,
    post: await page.evaluate(() => window.__puppet.env.manager.info.post),
  };
  console.log(JSON.stringify(r));
  return r;
}

/** Mean linear luminance of the face region, plus the share of clipped (>0.96) and near-black (<0.03) pixels. */
async function faceLuma() {
  return page.evaluate(() => {
    const p = window.__puppet;
    const v = p.viewer;
    const head = p.avatar.headPosition();
    const cam = v.camera;
    const proj = (dx, dy) => {
      const q = head.clone();
      q.x += dx;
      q.y += dy;
      q.z += 0.08;
      q.project(cam);
      return q;
    };
    const tl = proj(-0.05, 0.04);
    const br = proj(0.05, -0.06);
    v.render();
    const c = v.renderer.domElement;
    const x0 = Math.round(((tl.x + 1) / 2) * c.width);
    const x1 = Math.round(((br.x + 1) / 2) * c.width);
    const y0 = Math.round(((1 - tl.y) / 2) * c.height);
    const y1 = Math.round(((1 - br.y) / 2) * c.height);
    const w = Math.max(1, x1 - x0);
    const h = Math.max(1, y1 - y0);
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext('2d');
    ctx.drawImage(c, x0, y0, w, h, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    const lin = (u) => (u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4);
    let sum = 0;
    let clipped = 0;
    let black = 0;
    const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      const y = 0.2126 * lin(d[i] / 255) + 0.7152 * lin(d[i + 1] / 255) + 0.0722 * lin(d[i + 2] / 255);
      sum += y;
      if (y > 0.96) clipped++;
      if (y < 0.03) black++;
    }
    return { mean: +(sum / n).toFixed(3), clipped: +(clipped / n).toFixed(3), black: +(black / n).toFixed(3) };
  });
}

const results = [];
const gl = await page.evaluate(() => {
  const g = window.__puppet.viewer.renderer.getContext();
  const e = g.getExtension('WEBGL_debug_renderer_info');
  return e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown';
});
console.log(`# ${gl} ${W}x${H} ${uncapped ? 'UNCAPPED' : 'vsync'} ${seconds}s/case`);
results.push(await sample('flat (no environment)'));
if (process.env.PUPPET_DOF === '1') {
  await page.evaluate(() => window.__puppet.env.set('moor', 'high', { dof: true }));
  results.push(await sample('moor high + depth of field'));
  await page.evaluate(() => window.__puppet.env.set('moor', 'high', { dof: false }));
}
for (const id of presets) {
  for (const q of ['low', 'high']) {
    await page.evaluate(([id, q]) => window.__puppet.env.set(id, q), [id, q]);
    const r = await sample(`${id} ${q}`);
    results.push(r);
    if (outDir && q === 'high' && !uncapped) await page.screenshot({ path: `${outDir}/${id}.png` });
  }
}
await page.evaluate(() => window.__puppet.env.toggle());
results.push(await sample('flat again'));
if (outDir) await writeFile(`${outDir}/bench${uncapped ? '-uncapped' : ''}.json`, JSON.stringify({ gl, W, H, uncapped, results }, null, 2));
await browser.close();
