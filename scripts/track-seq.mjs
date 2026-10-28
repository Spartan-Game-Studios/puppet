// Run the body pipeline (pose + hand crops) over a rendered clip's PNG frames
// on the main thread and report hand detection per segment. Faster and more
// repeatable than playing the video through the app.
//   node scripts/track-seq.mjs <clip-dir> [from] [to] [step]
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BASE, launch } from './lib/browser.mjs';

const [dir, from = '0', to, step = '1'] = process.argv.slice(2);
const truth = JSON.parse(await readFile(join(dir, 'truth.json'), 'utf8'));
const browser = await launch();
const page = await browser.newPage();
page.on('console', (m) => m.type() === 'error' && console.log('[page]', m.text()));
await page.route('**/__local/frames/*', async (route) => {
  const name = route.request().url().split('/').pop();
  await route.fulfill({ status: 200, body: await readFile(join(dir, 'frames', name)), headers: { 'content-type': 'image/png' } });
});
await page.goto(`${BASE}/harness/?test=seq&pose=${process.env.PUPPET_POSE ?? 'lite'}`);
await page.waitForFunction(() => document.title === 'ready' || document.title === 'error', null, { timeout: 120000 });
const end = Number(to ?? truth.frames.length);
const res = await page.evaluate(([a, b, c]) => window.__seq.run(a, b, c), [Number(from), end, Number(step)]);
await browser.close();
const seg = {};
for (const r of res) {
  const t = truth.frames[r.i];
  for (const s of ['left', 'right']) {
    if (!t.handInFrame?.[s]) continue;
    const k = t.segment;
    seg[k] ??= { n: 0, found: 0, wrongSide: 0 };
    seg[k].n++;
    const h = r.hands.find((x) => x.side === s);
    if (h) seg[k].found++;
  }
}
for (const [k, v] of Object.entries(seg)) console.log(k.padEnd(12), `${((100 * v.found) / v.n).toFixed(1)}% of ${v.n}`);
const ms = res.map((r) => r.ms);
const avg = (f) => (ms.reduce((s, x) => s + f(x), 0) / ms.length).toFixed(1);
console.log(`pose ${avg((x) => x.pose)} ms, hands ${avg((x) => x.hands)} ms`);
await writeFile(join(dir, 'seq-report.json'), JSON.stringify(res));
