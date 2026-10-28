// Feed a rendered test clip (scripts/render-clip.mjs) through the app's real
// tracking pipeline (?source=file) and compare against the ground truth.
//   PUPPET_MODEL=/path/model.vrm node scripts/track-clip.mjs <clip-dir> [shots-dir]
// Pass 1 plays the clip unmirrored and records every tracking result.
// Pass 2 (if shots-dir is given) pauses on key moments, mirrored as in normal
// use, and screenshots the whole UI.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { BASE, launch, requireEnv, serveLocal } from './lib/browser.mjs';

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

// ---- pass 1: record
const page = await open(browser, 'loop=0&record=1&mirror=0&mode=hands');
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
  v.currentTime = 0;
  await new Promise((r) => (v.onseeked = r));
  await v.play();
}, calibrate);
await page.waitForFunction(() => window.__puppet.source.video.ended, null, { timeout: 120000, polling: 250 });
const rec = await page.evaluate(() => window.__puppet.record);
const stats = await page.evaluate(() => window.__puppet.tracker.stats);
await page.close();

const tr = (vt) => truth.frames[Math.min(truth.frames.length - 1, Math.max(0, Math.round(vt * truth.fps)))];
const rows = rec.filter((r) => r.vt != null && r.face);
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
  results: rec.length,
  faceDetectedPct: (100 * rows.length) / rec.length,
  poseDetectedPct: (100 * rec.filter((r) => r.pose).length) / rec.length,
  handsDetectedPct: (100 * rec.filter((r) => r.hands > 0).length) / rec.length,
  calibrated: calibrate,
  stats,
  handsRanPct: (100 * rec.filter((r) => r.handsRan).length) / rec.length,
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
  ];
  for (const [name, t] of moments) {
    await p2.evaluate((n) => window.__puppet.frame(n === 'arms-up' || n === 'rest-body' ? 'upper' : 'bust'), name);
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
}
await browser.close();
