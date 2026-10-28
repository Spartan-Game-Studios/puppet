// Replay raw tracker results (scripts/track-clip.mjs with PUPPET_RAW) through
// the app's body path in virtual time (harness/replay.ts) and report the body
// metrics against the clip's truth. Deterministic: compare pipeline changes on
// the same input.
//   PUPPET_MODEL=model.vrm node scripts/track-replay.mjs <clip-dir> <raw.json> ['{"handsOnArrival":false}' ...]
// Each extra argument is a JSON ReplayOptions object, run in turn.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BASE, launch, requireEnv, serveLocal } from './lib/browser.mjs';
import { bodyReport } from './lib/bodyMetrics.mjs';

const model = requireEnv('PUPPET_MODEL');
const [dir, rawPath, ...variants] = process.argv.slice(2);
const truth = JSON.parse(await readFile(join(dir, 'truth.json'), 'utf8'));
const raw = JSON.parse(await readFile(rawPath, 'utf8'));
const browser = await launch();
const page = await browser.newPage();
page.on('console', (m) => m.type() === 'error' && console.log('[page]', m.text()));
await serveLocal(page, { '/__local/model.vrm': model });
await page.goto(`${BASE}/harness/?test=replay`);
await page.waitForFunction(() => document.title === 'ready' || document.title === 'error', null, { timeout: 120000 });
const out = [];
for (const v of variants.length ? variants : ['{}']) {
  const rec = await page.evaluate(([log, o]) => window.__replay.run(log, o), [raw, JSON.parse(v)]);
  const b = bodyReport(rec, truth);
  const all = b.perSegment.ALL;
  const row = {
    options: v,
    lagMs: b.lag.ms,
    upperArmErrDeg: all.upperArmErrDeg,
    forearmErrDeg: all.forearmErrDeg,
    elbowBendErrDeg: all.elbowBendErrDeg,
    fingerErrDeg: all.fingerErrDeg,
    gesturePct: b.gestures.accuracyPct,
    jitterArmDeg: b.jitter.armDeg.rms,
    jitterFingerDeg: b.jitter.fingerDeg.rms,
  };
  console.log(JSON.stringify(row));
  out.push({ row, report: b, rec });
}
if (process.env.PUPPET_REPLAY_OUT) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(process.env.PUPPET_REPLAY_OUT, JSON.stringify(out));
}
await browser.close();
