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
// PUPPET_HANDS='full=off' (or 'fullEvery=2', ...): hand search options (HandSearchOptions).
await page.goto(`${BASE}/harness/?test=seq&pose=${process.env.PUPPET_POSE ?? 'lite'}&${process.env.PUPPET_HANDS ?? ''}`);
await page.waitForFunction(() => document.title === 'ready' || document.title === 'error', null, { timeout: 120000 });
const end = Number(to ?? truth.frames.length);
const res = await page.evaluate(([a, b, c]) => window.__seq.run(a, b, c), [Number(from), end, Number(step)]);
await browser.close();
const seg = {};
// A hand reported for side s counts as found if it sits on that hand in the
// truth (handPos, newer clips): nearer s's true wrist than the other one, and
// within 2 hand sizes of it. Otherwise it is a wrong-side / false hand.
const onHand = (t, s, h) => {
  const p = t.handPos;
  if (!p) return true;
  const o = s === 'left' ? 'right' : 'left';
  const d = (q) => Math.hypot((h.wrist[0] - q.wrist[0]) * 4 / 3, h.wrist[1] - q.wrist[1]);
  const size = Math.hypot((p[s].mcp[0] - p[s].wrist[0]) * 4 / 3, p[s].mcp[1] - p[s].wrist[1]);
  return d(p[s]) <= d(p[o]) && d(p[s]) < 2 * size;
};
const count = (k, r, t) => {
  const v = (seg[k] ??= { n: { left: 0, right: 0 }, found: { left: 0, right: 0 }, wrong: 0, bothN: 0, both: 0, status: { left: {}, right: {} } });
  const f = {};
  for (const [j, s] of ['left', 'right'].entries()) {
    const h = r.hands.find((x) => x.side === s);
    f[s] = !!h && onHand(t, s, h);
    if (h && !f[s]) v.wrong++;
    if (t.handInFrame?.[s]) {
      v.n[s]++;
      if (f[s]) v.found[s]++;
      const st = r.status?.[j];
      if (st) v.status[s][st] = (v.status[s][st] ?? 0) + 1;
    }
  }
  if (t.handInFrame?.left && t.handInFrame?.right) {
    v.bothN++;
    if (f.left && f.right) v.both++;
  }
};
for (const r of res) {
  const t = truth.frames[r.i];
  count(t.segment, r, t);
  if (/^face|nearFace/.test(t.segment)) count('FACE', r, t);
  count('ALL', r, t);
}
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : '-').padStart(6);
const st = (o) => Object.entries(o).map(([k, n]) => `${k}:${n}`).join(' ');
console.log(`${'segment'.padEnd(12)} ${'left'.padStart(6)} ${'right'.padStart(6)} ${'both'.padStart(6)} ${'wrong'.padStart(5)}  status (hand in view) L | R`);
for (const [k, v] of Object.entries(seg)) {
  console.log(`${k.padEnd(12)} ${pct(v.found.left, v.n.left)} ${pct(v.found.right, v.n.right)} ${pct(v.both, v.bothN)} ${String(v.wrong).padStart(5)}  ${st(v.status.left)} | ${st(v.status.right)}`);
}
const ms = res.map((r) => r.ms);
const avg = (f) => (ms.reduce((s, x) => s + f(x), 0) / ms.length).toFixed(1);
console.log(`pose ${avg((x) => x.pose)} ms, hands ${avg((x) => x.hands)} ms`);
await writeFile(join(dir, 'seq-report.json'), JSON.stringify(res));
