// Render a few frames of the test clip (harness/renderClip.ts) for a quick look.
//   PUPPET_MODEL=/path/model.vrm node scripts/render-frames.mjs <out-dir> 16.5 20.1 ...
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BASE, launch, requireEnv, serveLocal } from './lib/browser.mjs';

const model = requireEnv('PUPPET_MODEL');
const [out, ...times] = process.argv.slice(2);
await mkdir(out, { recursive: true });
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 700, height: 520 } });
page.on('console', (m) => m.type() === 'error' && console.log('[page]', m.text()));
await serveLocal(page, { '/__local/model.vrm': model });
await page.goto(`${BASE}/harness/?test=render&clean=${process.env.PUPPET_CLEAN ?? '0'}&script=${process.env.PUPPET_SCRIPT ?? 'default'}&cam=${process.env.PUPPET_CAM ?? 'default'}`);
await page.waitForFunction(() => document.title === 'ready' || document.title === 'error', null, { timeout: 180000 });
for (const t of times) {
  const i = Math.round(Number(t) * 30);
  const url = await page.evaluate((k) => window.__clip.frame(k), i);
  await writeFile(join(out, `t${t}.png`), Buffer.from(url.split(',')[1], 'base64'));
  const tr = await page.evaluate((k) => window.__clip.truth(k), i);
  console.log(t, tr.segment, JSON.stringify(tr.gesture), JSON.stringify(tr.handInFrame), 'elbow', tr.rig.elbow.left.toFixed(0), tr.rig.elbow.right.toFixed(0));
}
await browser.close();
