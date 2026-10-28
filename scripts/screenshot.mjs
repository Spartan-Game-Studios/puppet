// Screenshot the app UI with a model loaded, optionally fed by a test clip.
//   PUPPET_MODEL=/path/to/avatar.vrm [PUPPET_CLIP=/path/to/clip.webm] node scripts/screenshot.mjs out.png
import { BASE, launch, serveLocal } from './lib/browser.mjs';

const out = process.argv[2] ?? 'screenshot.png';
const model = process.env.PUPPET_MODEL;
const clip = process.env.PUPPET_CLIP;
const query = process.env.PUPPET_QUERY ?? '';
const wait = Number(process.env.PUPPET_WAIT ?? 8000);

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning' || process.env.PUPPET_VERBOSE) console.log(`[${m.type()}]`, m.text());
});
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
const map = {};
if (model) map['/__local/model.vrm'] = model;
if (clip) map['/__local/clip.webm'] = clip;
await serveLocal(page, map);
const qs = new URLSearchParams(query);
if (model) qs.set('model', '/__local/model.vrm');
if (clip) {
  qs.set('source', 'file');
  qs.set('src', '/__local/clip.webm');
}
await page.goto(`${BASE}/?${qs}`);
await page.waitForTimeout(wait);
// PUPPET_KEYS="p 2": press keys (shortcuts) before the shot.
for (const k of (process.env.PUPPET_KEYS ?? '').split(' ').filter(Boolean)) {
  await page.keyboard.press(k);
  await page.waitForTimeout(300);
}
const info = await page.evaluate(() => {
  const p = window.__puppet;
  return {
    status: document.getElementById('status')?.textContent,
    sync: document.getElementById('sync-mode')?.textContent,
    tracker: p.tracker.stats,
    frames: p.frames,
    gl: (() => {
      const gl = p.viewer.renderer.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
    })(),
  };
});
console.log(JSON.stringify(info, null, 2));
await page.screenshot({ path: out });
await browser.close();
