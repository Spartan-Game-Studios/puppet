// Virtual camera frame-source test in headless Chrome (no camera, no Tauri).
// Runs the real app with ?vcam=1, lets the output loop grab frames, then
// checks size, BGRA byte order, the background composite (COLOUR and CLEAR
// must both come out as the chosen colour, since cameras have no alpha) and
// that the avatar is in the frame. Reports fps and per-frame costs, and saves
// PNGs of the grabbed frames.
//
//   PUPPET_MODEL=/path/avatar.vrm node scripts/vcam-test.mjs [outdir] [1280x720|1920x1080]
import { mkdir, writeFile } from 'node:fs/promises';
import { BASE, launch, requireEnv, serveLocal } from './lib/browser.mjs';

const model = requireEnv('PUPPET_MODEL');
const outDir = process.argv[2] ?? 'harness/out/vcam';
const res = process.argv[3] ?? '1280x720';
const [W, H] = res.split('x').map(Number);
await mkdir(outDir, { recursive: true });

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error' || process.env.PUPPET_VERBOSE) console.log(`[${m.type()}]`, m.text());
});
await serveLocal(page, { '/__local/model.vrm': model });
await page.goto(`${BASE}/?model=/__local/model.vrm&vcam=1&vcamres=${res}&mode=face`);
await page.waitForFunction(() => window.__puppet?.avatar && window.__puppet.vcam.running, null, { timeout: 60000 });

let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
  if (!ok) failures++;
};

async function measure(label, bgKind, color) {
  await page.evaluate(
    ({ bgKind, color }) => {
      const p = window.__puppet;
      p.settings.background = { ...p.settings.background, kind: bgKind, color };
      document.querySelector(`#bg-kind button[data-value="${bgKind}"]`).click();
      if (bgKind === 'color') document.querySelector(`#swatches button[data-color="${color}"]`)?.click();
      p.vcam.keepLast = true;
    },
    { bgKind, color },
  );
  await page.waitForTimeout(1500);
  const before = await page.evaluate(() => ({ ...window.__puppet.vcam.stats, t: performance.now() }));
  await page.waitForTimeout(4000);
  const r = await page.evaluate(() => {
    const p = window.__puppet;
    const f = p.vcam.lastFrame;
    const v = new DataView(f.buffer);
    const w = v.getUint32(4, true);
    const h = v.getUint32(8, true);
    const px = (x, y) => Array.from(f.subarray(16 + (y * w + x) * 4, 16 + (y * w + x) * 4 + 4));
    // Fraction of pixels that differ from the top-left corner (the avatar).
    let diff = 0;
    const c0 = px(0, 0);
    for (let y = 0; y < h; y += 8)
      for (let x = 0; x < w; x += 8) {
        const q = px(x, y);
        if (Math.abs(q[0] - c0[0]) + Math.abs(q[1] - c0[1]) + Math.abs(q[2] - c0[2]) > 30) diff++;
      }
    // Is the avatar's head in the upper half (rows top-down)?
    let topDiff = 0;
    let botDiff = 0;
    for (let y = 0; y < h; y += 8)
      for (let x = w / 4; x < (3 * w) / 4; x += 8) {
        const q = px(x, y);
        const d = Math.abs(q[0] - c0[0]) + Math.abs(q[1] - c0[1]) + Math.abs(q[2] - c0[2]) > 30;
        if (d) y < h / 2 ? topDiff++ : botDiff++;
      }
    // PNG of the frame (BGRA -> RGBA) for eyeballing.
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(w, h);
    for (let i = 0; i < w * h; i++) {
      img.data[i * 4] = f[16 + i * 4 + 2];
      img.data[i * 4 + 1] = f[16 + i * 4 + 1];
      img.data[i * 4 + 2] = f[16 + i * 4];
      img.data[i * 4 + 3] = f[16 + i * 4 + 3];
    }
    ctx.putImageData(img, 0, 0);
    return {
      magic: String.fromCharCode(...f.subarray(0, 4)),
      w,
      h,
      len: f.length,
      corners: [px(0, 0), px(w - 1, 0), px(0, h - 1), px(w - 1, h - 1)],
      avatarFrac: diff / ((w / 8) * (h / 8)),
      topDiff,
      botDiff,
      stats: { ...p.vcam.stats, t: performance.now() },
      png: c.toDataURL('image/png'),
    };
  });
  const fps = ((r.stats.sent - before.sent) * 1000) / (r.stats.t - before.t);
  const bgra = [parseInt(color.slice(5, 7), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(1, 3), 16), 255];
  console.log(`\n== ${label} (${res})`);
  check(r.magic === 'PVCF' && r.w === W && r.h === H && r.len === 16 + W * H * 4, `frame ${r.w}x${r.h}, ${r.len} bytes, magic ${r.magic}`);
  check(
    r.corners.every((c) => c.every((v, i) => Math.abs(v - bgra[i]) <= 1)),
    `corners are the background ${color} as BGRA ${JSON.stringify(bgra)}: ${JSON.stringify(r.corners)}`,
  );
  check(r.avatarFrac > 0.02 && r.avatarFrac < 0.9, `avatar covers ${(100 * r.avatarFrac).toFixed(1)}% of the frame`);
  check(r.topDiff > r.botDiff * 0.3, `rows are top-down (avatar pixels top ${r.topDiff} / bottom ${r.botDiff})`);
  check(fps > 27 && fps < 33, `rate ${fps.toFixed(1)} fps (target 30)`);
  console.log(
    `   render ${r.stats.render.toFixed(2)} ms  readback ${r.stats.readback.toFixed(2)} ms  total ${r.stats.total.toFixed(2)} ms  busy ${r.stats.busy}  errors ${r.stats.errors}`,
  );
  await writeFile(`${outDir}/${label}-${res}.png`, Buffer.from(r.png.split(',')[1], 'base64'));
  return { label, fps, ...r.stats };
}

const results = [];
results.push(await measure('colour-green', 'color', '#00ff00'));
results.push(await measure('clear-as-green', 'transparent', '#00ff00'));
results.push(await measure('clear-as-magenta', 'transparent', '#ff00ff'));

// Cost of the grab itself: frame time with the output on vs off.
const frameCost = await page.evaluate(async () => {
  const p = window.__puppet;
  const sample = async () => {
    const t = [];
    let last = performance.now();
    await new Promise((res) => {
      const f = (now) => {
        t.push(now - last);
        last = now;
        if (t.length < 240) requestAnimationFrame(f);
        else res();
      };
      requestAnimationFrame(f);
    });
    t.sort((a, b) => a - b);
    return { median: t[120], p95: t[228] };
  };
  const on = await sample();
  await p.vcam.stop();
  const off = await sample();
  return { on, off };
});
console.log(`\nrAF interval with output on: median ${frameCost.on.median.toFixed(1)} ms p95 ${frameCost.on.p95.toFixed(1)}; off: median ${frameCost.off.median.toFixed(1)} p95 ${frameCost.off.p95.toFixed(1)}`);
await writeFile(`${outDir}/results-${res}.json`, JSON.stringify({ res, results, frameCost }, null, 2));
await browser.close();
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
