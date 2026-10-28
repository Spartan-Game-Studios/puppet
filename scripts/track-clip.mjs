// Feed a rendered test clip (scripts/render-clip.mjs) through the app's real
// tracking pipeline (?source=file) and compare against the ground truth.
//   PUPPET_MODEL=/path/model.vrm node scripts/track-clip.mjs <clip-dir> [shots-dir]
// Pass 1 plays the clip unmirrored and records every tracking result.
// Pass 2 (if shots-dir is given) pauses on key moments, mirrored as in normal
// use, and screenshots the whole UI. With PUPPET_VIDEO=1 it also records the
// UI playing the body section into <shots-dir>/mirror.mp4 (needs ffmpeg).
// PUPPET_RAW=raw.json also saves the raw body / hands results for
// scripts/track-replay.mjs.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { BASE, launch, requireEnv, serveLocal } from './lib/browser.mjs';
import { bodyReport, faceStabilityReport, handSearchReport } from './lib/bodyMetrics.mjs';

const model = requireEnv('PUPPET_MODEL');
const dir = process.argv[2] ?? requireEnv('PUPPET_CLIP_DIR');
const shots = process.argv[3];
const truth = JSON.parse(await readFile(join(dir, 'truth.json'), 'utf8'));

async function open(browser, query) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  page.on('console', (m) => m.type() === 'error' && console.log('[page error]', m.text()));
  await serveLocal(page, { '/__local/model.vrm': model, '/__local/clip.webm': join(dir, 'clip.webm') });
  await page.goto(`${BASE}/?model=/__local/model.vrm&source=file&src=/__local/clip.webm&${query}`);
  await page.waitForFunction(() => window.__puppet?.avatar && window.__puppet.tracker.stats.face.fps > 0, null, { timeout: 120000 });
  return page;
}

const browser = await launch();

// ---- pass 1: record (PUPPET_MIRROR=1: mirrored, as in normal use; the arm and
// finger metrics assume unmirrored, hand detection and gestures don't).
const mirror = process.env.PUPPET_MIRROR === '1' ? 1 : 0;
const page = await open(browser, `loop=0&record=1&mirror=${mirror}&mode=hands`);
const calibrate = process.env.PUPPET_CALIBRATE !== '0';
await page.evaluate(async (cal) => {
  const v = window.__puppet.source.video;
  v.pause();
  v.currentTime = 0.4;
  await new Promise((r) => (v.onseeked = r));
  // The clip opens on a neutral face: capture it, as a user would with [C].
  await new Promise((r) => setTimeout(r, 1500));
  if (cal) window.__puppet.face.captureNeutral();
  else window.__puppet.face.clearCalibration();
  window.__puppet.record.length = 0;
  // Raw body / hands results as they reach the main thread (PUPPET_RAW, for scripts/track-replay.mjs).
  const tr = window.__puppet.tracker;
  const handle = tr.handle.bind(tr);
  window.__raw = [];
  tr.handle = (pipeline, m) => {
    handle(pipeline, m);
    if (m.type === 'result' && pipeline !== 'face') window.__raw.push({ now: performance.now(), pipeline, m: { ...m } });
  };
  v.currentTime = 0;
  await new Promise((r) => (v.onseeked = r));
  await v.play();
}, calibrate);
// Sample the tracker rates once a second while the clip plays.
const fpsSamples = [];
while (!(await page.evaluate(() => window.__puppet.source.video.ended))) {
  await page.waitForTimeout(1000);
  fpsSamples.push(await page.evaluate(() => {
    const s = window.__puppet.tracker.stats;
    return { face: s.face.fps, body: s.body.fps, hands: s.hands?.fps ?? null, faceLat: s.face.latency, bodyLat: s.body.latency, pose: s.body.pose, handsMs: s.body.hands };
  }));
}
const rec = await page.evaluate(() => window.__puppet.record);
if (process.env.PUPPET_RAW) await writeFile(process.env.PUPPET_RAW, JSON.stringify(await page.evaluate(() => window.__raw)));
const stats = await page.evaluate(() => window.__puppet.tracker.stats);
await page.close();

const tr = (vt) => truth.frames[Math.min(truth.frames.length - 1, Math.max(0, Math.round(vt * truth.fps)))];
const rows = rec.filter((r) => r.vt != null && r.face);
const faceRec = rec.filter((r) => !r.body && !r.handsFrame);
const avg = (k) => {
  const xs = fpsSamples.slice(2).map((x) => x[k]).filter((x) => x != null);
  return xs.length ? Math.round((10 * xs.reduce((a, b) => a + b, 0)) / xs.length) / 10 : null;
};
const pearson = (a, b) => {
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return num / Math.sqrt(da * db || 1);
};
const corr = (name, f = (r) => r.values[name]) =>
  pearson(rows.map(f), rows.map((r) => tr(r.vt).expr[name] ?? 0));
const meanIn = (a, b, f) => {
  const s = rows.filter((r) => r.vt >= a && r.vt <= b).map(f);
  return s.reduce((x, y) => x + y, 0) / Math.max(1, s.length);
};
const deg = (x) => (x * 180) / Math.PI;

const report = {
  results: faceRec.length,
  faceDetectedPct: (100 * rows.length) / faceRec.length,
  poseDetectedPct: (100 * faceRec.filter((r) => r.pose).length) / faceRec.length,
  handsDetectedPct: (100 * faceRec.filter((r) => r.hands > 0).length) / faceRec.length,
  calibrated: calibrate,
  stats,
  meanFps: { face: avg('face'), body: avg('body'), hands: avg('hands'), faceLatencyMs: avg('faceLat'), bodyLatencyMs: avg('bodyLat'), poseMs: avg('pose'), handsMs: avg('handsMs') },
  handsRanPct: (100 * faceRec.filter((r) => r.handsRan).length) / faceRec.length,
  where: `${stats.where}/${stats.delegate}`,
  correlation: {
    jawOpen: corr('jawOpen'),
    eyeBlinkLeft: corr('eyeBlinkLeft'),
    eyeBlinkRight: corr('eyeBlinkRight'),
    mouthSmile: corr('mouthSmileLeft', (r) => (r.values.mouthSmileLeft + r.values.mouthSmileRight) / 2),
    mouthPucker: corr('mouthPucker'),
    browInnerUp: corr('browInnerUp'),
    headYaw: pearson(rows.map((r) => deg(r.head[0])), rows.map((r) => tr(r.vt).head.yaw)),
    headPitch: pearson(rows.map((r) => deg(r.head[1])), rows.map((r) => tr(r.vt).head.pitch)),
  },
  checks: {
    // Her LEFT eye winks at 4.6-5.2 s. Unmirrored, the tracked "Left" should win.
    winkLeftVsRight: [meanIn(4.7, 5.1, (r) => r.raw.eyeBlinkLeft), meanIn(4.7, 5.1, (r) => r.raw.eyeBlinkRight)],
    jawOpenPeakVsRest: [meanIn(1.6, 2.0, (r) => r.values.jawOpen), meanIn(0.2, 0.8, (r) => r.values.jawOpen)],
    // Head turn to her left at ~10.1 s: positive yaw expected.
    headYawAt10_1: meanIn(9.95, 10.25, (r) => deg(r.head[0])),
    headYawAt11_3: meanIn(11.15, 11.45, (r) => deg(r.head[0])),
    headPitchAt12_4: meanIn(12.25, 12.55, (r) => deg(r.head[1])),
    // Forearm direction y (up) when both arms are raised (12.5-13.0) vs down (0.5-1.5).
    foreLeftUp: [meanIn(12.5, 13.0, (r) => r.foreLeft?.[1] ?? 0), meanIn(0.5, 1.5, (r) => r.foreLeft?.[1] ?? 0)],
    foreRightUp: [meanIn(12.5, 13.0, (r) => r.foreRight?.[1] ?? 0), meanIn(0.5, 1.5, (r) => r.foreRight?.[1] ?? 0)],
  },
};
if (truth.frames.some((f) => f.rig)) report.body = bodyReport(rec, truth);
report.mirror = !!mirror;
report.handSearch = handSearchReport(rec, truth);
report.faceStability = faceStabilityReport(rec, truth);
console.log(JSON.stringify(report, null, 2));
await writeFile(join(dir, 'track-report.json'), JSON.stringify({ report, rec }, null, 1));

// ---- pass 2: screenshots
if (shots) {
  await mkdir(shots, { recursive: true });
  const p2 = await open(browser, 'loop=0&mirror=1&mode=hands');
  await p2.evaluate(async () => {
    const v = window.__puppet.source.video;
    v.pause();
    v.currentTime = 0.4;
    await new Promise((r) => (v.onseeked = r));
    await new Promise((r) => setTimeout(r, 1500));
    window.__puppet.calibrate();
  });
  const moments = [
    ['jaw-open', 1.8],
    ['wink', 4.9],
    ['smile', 6.3],
    ['pucker', 7.8],
    ['head-left', 10.1],
    ['arms-up', 12.9],
    ['rest-body', 0.6],
    ...(truth.frames.length > 14 * truth.fps
      ? [
          ['gesture-open-peace', 16.2],
          ['gesture-fist-thumbsup', 17.4],
          ['gesture-point-ok', 18.6],
          ['gesture-peace-rock', 19.8],
          ['curls', 26.3],
          ['cross', 30.2],
          ['near-face', 32.8],
          ['lean', 35.0],
          ['twist', 38.5],
          ['out-of-frame', 41.5],
          ['abduct90', 46.0],
        ]
      : []),
  ];
  for (const [name, t] of moments) {
    await p2.evaluate((n) => window.__puppet.frame(n === 'arms-up' || n === 'rest-body' || n.includes('-') || ['curls', 'cross', 'lean', 'twist', 'abduct90'].includes(n) ? 'upper' : 'bust'), name);
    await p2.evaluate(async (tt) => {
      const v = window.__puppet.source.video;
      v.pause();
      v.currentTime = tt;
      await new Promise((r) => (v.onseeked = r));
    }, t);
    await p2.waitForTimeout(1500);
    console.log(name, await p2.evaluate(() => window.__puppet.source.video.currentTime));
    await p2.screenshot({ path: join(shots, `track-${name}.png`) });
    console.log(`shot ${name}`);
  }
  await p2.close();
  if (process.env.PUPPET_VIDEO === '1') {
    // Screenshots in a loop while the clip plays in real time, then encoded at
    // the rate they were taken (Playwright's own video recorder needs a download).
    const { execFileSync } = await import('node:child_process');
    const framesDir = join(shots, 'mirror-frames');
    await mkdir(framesDir, { recursive: true });
    const p3 = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await serveLocal(p3, { '/__local/model.vrm': model, '/__local/clip.webm': join(dir, 'clip.webm') });
    await p3.goto(`${BASE}/?model=/__local/model.vrm&source=file&src=/__local/clip.webm&loop=0&mirror=1&mode=hands`);
    await p3.waitForFunction(() => window.__puppet?.avatar && window.__puppet.tracker.stats.face.fps > 0, null, { timeout: 120000 });
    const from = Number(process.env.PUPPET_VIDEO_FROM ?? 14.6);
    await p3.evaluate(async (t0) => {
      window.__puppet.frame('upper');
      const v = window.__puppet.source.video;
      v.pause();
      v.currentTime = t0;
      await new Promise((r) => (v.onseeked = r));
      await v.play();
    }, from);
    const startedAt = Date.now();
    let n = 0;
    while (!(await p3.evaluate(() => window.__puppet.source.video.ended))) {
      await p3.screenshot({ path: join(framesDir, `${String(n++).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 80 });
    }
    const rate = n / ((Date.now() - startedAt) / 1000);
    await p3.close();
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', rate.toFixed(3), '-i', join(framesDir, '%05d.jpg'), '-c:v', 'libx264', '-crf', '23', '-pix_fmt', 'yuv420p', '-r', '30', join(shots, 'mirror.mp4')]);
    console.log(`wrote ${join(shots, 'mirror.mp4')}`);
  }
}
await browser.close();
