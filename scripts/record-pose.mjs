// Record a real tracking session as avatar bone rotations, for replay in the
// cloth benchmark (scripts/cloth-test.mjs, scenario 'recorded'). Plays a clip
// (scripts/render-clip.mjs output) through the app's real tracking pipeline
// and samples every humanoid bone's normalized local rotation each rendered
// frame, with the real frame time.
//   PUPPET_MODEL=/path/model.vrm node scripts/record-pose.mjs <clip-dir> <out.json> [mode]
// mode: face | upper (default) | hands
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BASE, launch, requireEnv, serveLocal } from './lib/browser.mjs';

const model = requireEnv('PUPPET_MODEL');
const dir = process.argv[2] ?? requireEnv('PUPPET_CLIP_DIR');
const out = process.argv[3] ?? 'pose.json';
const mode = process.argv[4] ?? 'upper';

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await serveLocal(page, { '/__local/model.vrm': model, '/__local/clip.webm': join(dir, 'clip.webm') });
await page.goto(`${BASE}/?model=/__local/model.vrm&source=file&src=/__local/clip.webm&loop=0&mode=${mode}`);
await page.waitForFunction(() => window.__puppet?.avatar && window.__puppet.tracker.stats.face.fps > 0, null, { timeout: 120000 });
await page.evaluate(async () => {
  const v = window.__puppet.source.video;
  v.pause();
  v.currentTime = 0;
  await new Promise((r) => (v.onseeked = r));
  const a = window.__puppet.avatar;
  const names = a.humanBoneNames;
  const frames = [];
  window.__poseRec = frames;
  let last = null;
  const tick = (ts) => {
    if (last != null) {
      const bones = {};
      for (const n of names) {
        const q = a.bone(n).quaternion;
        bones[n] = [q.x, q.y, q.z, q.w];
      }
      frames.push({ dt: (ts - last) / 1000, bones });
    }
    last = ts;
    if (!v.ended) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  await v.play();
});
await page.waitForFunction(() => window.__puppet.source.video.ended, null, { timeout: 300000, polling: 250 });
const frames = await page.evaluate(() => window.__poseRec);
const vrm0 = await page.evaluate(() => window.__puppet.avatar.isVrm0);
await browser.close();
await writeFile(out, JSON.stringify({ mode, vrm0, frames }));
console.log(`recorded ${frames.length} frames (${frames.reduce((s, f) => s + f.dt, 0).toFixed(1)} s) to ${out}`);
