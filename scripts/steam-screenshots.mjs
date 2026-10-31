// Steam store screenshots (1920x1080 PNG, English) of the real app UI with a
// hero avatar, rendered in headless Chrome (nothing opens on screen).
//   node scripts/steam-screenshots.mjs <path/to/hero.vrm> [--only name,name]
// Writes steam/screenshots/<nn>-<name>.png.
//
// The hero model is read from the given path and served to the page from
// memory: it is never copied into the repo. Only use a model you may show in
// advertising (see steam/store-page/legal.md). The camera is Chrome's fake
// device, so the preview card is minimised and expressions and emotes are set
// through the app's own MCP tools rather than tracked.
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './lib/browser.mjs';
import { startVite } from './lib/vite.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'steam/screenshots');
const heroPath = process.argv[2];
if (!heroPath || heroPath.startsWith('--')) {
  console.error('usage: node scripts/steam-screenshots.mjs <hero.vrm> [--only name,name]');
  process.exit(2);
}
const i = process.argv.indexOf('--only');
const ONLY = i > 0 ? process.argv[i + 1].split(',') : null;
const hero = readFileSync(heroPath);
mkdirSync(OUT, { recursive: true });

const vite = await startVite(5192);
const browser = await launch({ extraArgs: ['--use-fake-device-for-media-stream'] });
let made = 0;

try {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.route('**/__local/hero.vrm', (r) => r.fulfill({ body: hero, contentType: 'application/octet-stream' }));
  await page.goto(`${vite.url}/?lang=en&home=1`);
  await page.waitForFunction(() => window.__puppet?.home, null, { timeout: 30000 });
  await page.waitForTimeout(1500);

  const key = async (k) => {
    await page.keyboard.press(k);
    await page.waitForTimeout(400);
  };
  const closeModal = () => page.evaluate(() => document.querySelector('dialog[open] .pm-close')?.click());
  const mcp = (tool, args = {}) => page.evaluate(([t, a]) => window.__puppet.mcp.call(t, a), [tool, args]);
  /** Scene id, framing, then let lights, shadows and the idle settle. */
  const stage = async (env, framing) => {
    await page.evaluate(
      ([e, f]) => {
        const p = window.__puppet;
        if (e) {
          p.env.set(e, 'high');
          if (p.settings.background.kind !== 'environment') p.env.toggle();
        }
        p.frame(f);
      },
      [env, framing],
    );
    await page.waitForTimeout(2500);
  };
  const shot = async (n, name, prep) => {
    if (ONLY && !ONLY.includes(name)) return;
    await prep?.();
    await page.waitForTimeout(800);
    const file = join(OUT, `${String(n).padStart(2, '0')}-${name}.png`);
    await page.screenshot({ path: file });
    made++;
    console.log(file);
  };

  const ids = await page.evaluate(async () => {
    const lib = window.__puppet.home.library;
    const add = async (name, url) => (await lib.import({ name, bytes: await (await fetch(url)).arrayBuffer() })).id;
    const hero = await add('hero.vrm', '/__local/hero.vrm');
    await add('devil.vrm', '/test-assets/cc0/devil.vrm');
    await add('the-worm.vrm', '/test-assets/cc0/the-worm.vrm');
    return { hero };
  });

  await page.evaluate(() => window.__puppet.home.show(true));
  await shot(8, 'library');
  await shot(9, 'model-doctor', async () => {
    await page.click(`.card[data-id="${ids.hero}"] .more`);
    await page.click(`.card[data-id="${ids.hero}"] [data-act="doctor"]`);
    await page.waitForTimeout(1200);
  });
  await closeModal();

  await mcp('library_load', { id: ids.hero });
  await page.waitForTimeout(3000);
  // The licence notice shown once per model (GOT IT).
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'GOT IT')?.click());
  if (await page.evaluate(() => !document.body.classList.contains('no-debug'))) await key('d');
  await key('t'); // minimise the camera preview (the fake device's test pattern)

  await shot(1, 'stage', async () => {
    await stage('room', 'upper');
    await page.waitForTimeout(2500); // the first framing glides in from the default
  });
  await shot(2, 'face', async () => {
    await stage('room', 'bust');
    await mcp('expression_set', { name: 'happy', weight: 0.8 });
    await key('f');
  });
  await closeModal();
  await mcp('expression_set', { reset: true });
  await shot(3, 'capture-neon', async () => {
    await stage('neon', 'upper');
    await key('h');
  });
  await key('h');
  await shot(4, 'motion', async () => {
    await stage('moor', 'full');
    await key('a');
    await mcp('clip_play', { clip: 'wave' });
    await page.waitForTimeout(900);
  });
  await closeModal();
  await shot(5, 'physics', async () => {
    await stage('forest', 'upper');
    await key('p');
  });
  await closeModal();
  await shot(6, 'hotkeys', async () => {
    await stage('studio', 'upper');
    await key('k');
  });
  await closeModal();
  await shot(7, 'capture-hall', async () => {
    await stage('hall', 'bust');
    await mcp('expression_set', { name: 'surprised', weight: 0.7 });
    await key('h');
  });
  await key('h');
  await ctx.close();
} finally {
  await browser.close();
  vite.close();
}
console.log(`${made} screenshots`);
