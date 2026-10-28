// Cloth physics benchmark (harness/cloth.ts): clipping, spacing, speed,
// settle, jitter and CPU for each solver and scenario.
//   PUPPET_MODEL=/path/model.vrm node scripts/cloth-test.mjs [out.json]
// Options (env):
//   SCENARIOS=shake,lean,arms,hitch,recorded   CONDITIONS=legacy,cloth   SEEDS=1,2
//   PUPPET_POSE=/path/pose.json   a recorded tracking session (scripts/record-pose.mjs) for the 'recorded' scenario
//   VIDEO=/out/dir   also render each scenario per condition and a side-by-side mp4 (needs ffmpeg)
//   VIDEO_SCENARIOS=lean,arms   which scenarios to film (default: all run)
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { BASE, launch, requireEnv, serveLocal } from './lib/browser.mjs';

const model = requireEnv('PUPPET_MODEL');
const pose = process.env.PUPPET_POSE;
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 800, height: 800 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && console.log(`[${m.type()}]`, m.text()));
const local = { '/__local/model.vrm': model };
if (pose) local['/__local/pose.json'] = pose;
await serveLocal(page, local);
await page.goto(`${BASE}/harness/?test=cloth${pose ? '&pose=/__local/pose.json' : ''}`);
await page.waitForFunction(() => window.__cloth?.ready, null, { timeout: 120000, polling: 250 });
const err = await page.evaluate(() => window.__cloth.error);
if (err) {
  console.error(err);
  process.exit(1);
}
const available = await page.evaluate(() => window.__cloth.scenarios);
const scenarios = (process.env.SCENARIOS ?? available.join(',')).split(',').filter((s) => available.includes(s));
const conditions = (process.env.CONDITIONS ?? 'main,legacy,cloth').split(',');
const seeds = (process.env.SEEDS ?? '1').split(',').map(Number);

const results = [];
for (const scenario of scenarios) {
  for (const condition of conditions) {
    for (const seed of seeds) {
      const t0 = Date.now();
      const r = await page.evaluate((o) => window.__cloth.run(o), { condition, scenario, seed });
      results.push(r);
      console.log(`${scenario} / ${condition} / seed ${seed}: ${((Date.now() - t0) / 1000).toFixed(1)} s; fastest ${r.fastest}; top clipping: ${r.offenders.join(', ')}`);
    }
  }
}
if (results.length) {
  console.log(`groups: ${results[0].groups.join('; ')}`);
  console.log(`body colliders: ${results[0].bodyColliders.join(', ')}`);
  console.log(`joints ${results[0].joints} (cloth ${results[0].clothJoints}), cloth mesh samples ${results[0].meshSamples}`);
}
const f = (x, d = 2) => (x == null ? 'never' : Number(x).toFixed(d));
console.log('\nscenario | solver | clip frames % | clip segs max | seg depth max mm | clip verts % mean / max | vert depth p95 / max mm | spacing err p95 / max % | max / p99 speed all | max / p99 cloth | settle s | jitter mm (p50/max) | ms mean / p99 / max | arms: clip frames % / verts %');
const by = new Map();
for (const r of results) {
  const k = `${r.scenario}|${r.condition}`;
  if (!by.has(k)) by.set(k, []);
  by.get(k).push(r);
}
for (const [k, rs] of by) {
  const [sc, cond] = k.split('|');
  const mx = (key) => Math.max(...rs.map((r) => r[key] ?? 0));
  const mean = (key) => rs.reduce((s, r) => s + (r[key] ?? 0), 0) / rs.length;
  const settle = rs.some((r) => r.settleSeconds == null) ? null : mx('settleSeconds');
  console.log(
    [
      sc,
      cond,
      f(100 * mean('clipFrames'), 1),
      mx('clipSegsMax'),
      f(1000 * mx('clipDepthMax'), 1),
      `${f(100 * mean('clipVertFracMean'), 2)} / ${f(100 * mx('clipVertFracMax'), 2)}`,
      `${f(1000 * mx('clipVertDepthP95'), 1)} / ${f(1000 * mx('clipVertDepthMax'), 1)}`,
      `${f(100 * mx('spacingErrP95'), 1)} / ${f(100 * mx('spacingErrMax'), 1)}`,
      `${f(mx('maxSpeedAll'))} / ${f(mx('p99SpeedAll'))}`,
      `${f(mx('maxSpeedCloth'))} / ${f(mx('p99SpeedCloth'))}`,
      f(settle),
      `${f(mx('jitterMm'), 3)} / ${f(mx('jitterMaxMm'), 3)}`,
      `${f(mean('msMean'), 3)} / ${f(mx('msP99'), 3)} / ${f(mx('msMax'), 3)}`,
      `${f(100 * mean('armClipFrames'), 1)} / ${f(100 * mean('armVertFracMean'), 2)}`,
    ].join(' | '),
  );
}
if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(results, null, 2));

// Videos.
const videoDir = process.env.VIDEO;
if (videoDir) {
  const vids = (process.env.VIDEO_SCENARIOS ?? scenarios.join(',')).split(',').filter((s) => available.includes(s));
  const W = 640, H = 720, FPS = 30;
  for (const scenario of vids) {
    const dirs = [];
    const vconds = (process.env.VIDEO_CONDITIONS ?? 'main,cloth').split(',');
    for (const condition of vconds) {
      const dir = join(videoDir, `${scenario}_${condition}_frames`);
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });
      dirs.push(dir);
      let n = 0;
      const label = { main: 'BEFORE (main)', legacy: 'LEGACY SOLVER + LOADER FIX', cloth: 'AFTER (cloth)', off: 'PHYSICS OFF' }[condition] ?? condition;
      const done = page.evaluate((o) => window.__cloth.render(o), { condition, scenario, seed: 1, render: { w: W, h: H, fps: FPS, label } }).then(() => true);
      let finished = false;
      done.then(() => (finished = true));
      while (true) {
        const frames = await page.evaluate(() => window.__cloth.takeFrames());
        for (const url of frames) await writeFile(join(dir, `${String(n++).padStart(5, '0')}.jpg`), Buffer.from(url.split(',')[1], 'base64'));
        if (finished && !frames.length) break;
        if (!frames.length) await new Promise((r) => setTimeout(r, 50));
      }
      await done;
      console.log(`rendered ${scenario} ${condition}: ${n} frames`);
    }
    const out = join(videoDir, `${scenario}_side_by_side.mp4`);
    execFileSync('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-framerate', String(FPS), '-i', join(dirs[0], '%05d.jpg'),
      ...(dirs[1] ? ['-framerate', String(FPS), '-i', join(dirs[1], '%05d.jpg')] : []),
      '-filter_complex', dirs.length === 1 ? '[0:v]copy[v]' : '[0:v][1:v]hstack=inputs=2[v]',
      '-map', '[v]', '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p', out,
    ]);
    console.log(`wrote ${out}`);
  }
}
await browser.close();
