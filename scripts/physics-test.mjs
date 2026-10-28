// Physics stability test: shakes a spring-boned VRM with and without the
// stabilisers and prints max joint speed and settle time.
//   PUPPET_MODEL=/path/to/model.vrm node scripts/physics-test.mjs [out.json]
import { writeFile } from 'node:fs/promises';
import { BASE, launch, requireEnv, serveLocal } from './lib/browser.mjs';

const model = requireEnv('PUPPET_MODEL');
const browser = await launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => console.log(`[${m.type()}]`, m.text()));
await serveLocal(page, { '/__local/model.vrm': model });
await page.goto(`${BASE}/harness/?test=physics&seeds=${process.env.SEEDS ?? '1,2,3'}`);
await page.waitForFunction(() => window.__physicsResult, null, { timeout: 600000, polling: 500 });
const res = await page.evaluate(() => window.__physicsResult);
await browser.close();
if (res.error) {
  console.error(res.error);
  process.exit(1);
}
if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(res, null, 2));

// Aggregate across seeds.
const by = new Map();
for (const r of res) {
  if (!by.has(r.condition)) by.set(r.condition, []);
  by.get(r.condition).push(r);
}
const f = (x) => (x == null ? 'never' : x.toFixed(2));
console.log(`joints: ${res[0].joints} (skirt ${res[0].skirtJoints})  seeds: ${[...new Set(res.map((r) => r.seed))].join(',')}`);
console.log('condition | max all m/s | p99 all | max skirt | p99 skirt | median skirt | settle s (worst)');
for (const [name, rs] of by) {
  const mx = (k) => Math.max(...rs.map((r) => r[k]));
  const settle = rs.some((r) => r.settleSeconds == null) ? null : Math.max(...rs.map((r) => r.settleSeconds));
  console.log(`${name} | ${f(mx('maxSpeedAll'))} | ${f(mx('p99SpeedAll'))} | ${f(mx('maxSpeedSkirt'))} | ${f(mx('p99SpeedSkirt'))} | ${f(mx('medianSpeedSkirt'))} | ${f(settle)}`);
}
