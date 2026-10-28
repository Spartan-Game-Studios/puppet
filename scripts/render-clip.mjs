// Render test footage from a VRM (see harness/renderClip.ts) and encode it.
//   PUPPET_MODEL=/path/model.vrm node scripts/render-clip.mjs <out-dir>
// Writes <out-dir>/frames/*.png, clip.webm (VP9, for Chromium), clip.mp4
// (H.264, for WebKit) and truth.json. Needs ffmpeg on PATH.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { BASE, launch, requireEnv, serveLocal } from './lib/browser.mjs';

const model = requireEnv('PUPPET_MODEL');
const out = process.argv[2] ?? requireEnv('PUPPET_OUT');
const frames = join(out, 'frames');
await mkdir(frames, { recursive: true });

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 700, height: 520 } });
page.on('console', (m) => m.type() === 'error' && console.log('[page]', m.text()));
await serveLocal(page, { '/__local/model.vrm': model });
// PUPPET_SCRIPT=webcam renders the webcam-realism script (hands at the face, both hands up,
// low, close, together); PUPPET_CAM=desk the closer desk-webcam framing.
await page.goto(`${BASE}/harness/?test=render&clean=${process.env.PUPPET_CLEAN ?? '0'}&script=${process.env.PUPPET_SCRIPT ?? 'default'}&cam=${process.env.PUPPET_CAM ?? 'default'}`);
await page.waitForFunction(() => document.title === 'ready' || document.title === 'error', null, { timeout: 180000 });
if ((await page.title()) === 'error') throw new Error('render harness failed');
const n = await page.evaluate(() => window.__clip.frames);
const truth = [];
for (let i = 0; i < n; i++) {
  const url = await page.evaluate((k) => window.__clip.frame(k), i);
  await writeFile(join(frames, `${String(i).padStart(4, '0')}.png`), Buffer.from(url.split(',')[1], 'base64'));
  truth.push(await page.evaluate((k) => window.__clip.truth(k), i));
  if (i % 60 === 0) console.log(`frame ${i}/${n}`);
}
await browser.close();
await writeFile(join(out, 'truth.json'), JSON.stringify({ fps: 30, frames: truth }));
const ff = (args) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '30', '-i', join(frames, '%04d.png'), ...args]);
ff(['-c:v', 'libvpx-vp9', '-b:v', '3M', '-pix_fmt', 'yuv420p', '-row-mt', '1', join(out, 'clip.webm')]);
ff(['-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', join(out, 'clip.mp4')]);
console.log(`wrote ${n} frames, clip.webm, clip.mp4, truth.json to ${out}`);
