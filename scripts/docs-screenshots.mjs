// Screenshots of the real app UI for the docs site, in every UI language.
//   node scripts/docs-screenshots.mjs [--only name,name] [--langs en,ru]
// Writes apps/docs/public/screenshots/<lang>/<name>.webp (needs `cwebp`).
//
// Runs the app's frontend in headless Chrome (nothing opens on screen) on a
// private Vite server, with the fake camera and only the CC0 test avatars in
// test-assets/cc0/ (never personal models: these images are published). The
// MODEL DOCTOR shot needs a model with misnamed ARKit shapes, so one is made
// on the fly from the CC0 worm by renaming its morph targets.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './lib/browser.mjs';
import { startVite } from './lib/vite.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'apps/docs/public/screenshots');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1].split(',') : null;
};
const LANGS = arg('--langs') ?? ['en', 'ru', 'zh-CN', 'es'];
const ONLY = arg('--only');

/** The CC0 worm with some morph targets renamed to near-ARKit spellings (for the doctor). */
function wormWithArkitShapes() {
  const b = readFileSync(join(ROOT, 'test-assets/cc0/the-worm.vrm'));
  const n = b.readUInt32LE(12);
  const json = JSON.parse(b.subarray(20, 20 + n).toString('utf8'));
  const rest = b.subarray(20 + n);
  const m = json.meshes[0];
  const names = m.extras?.targetNames ?? m.primitives[0].extras.targetNames;
  const fake = ['blendShape1.jawOpen', 'eyeBlink_L', 'eyeBlink_R', 'MouthSmile_L', 'MouthSmile_R', 'facs_bs_cheekPuff', 'browInnerUp', 'mouthFunnel', 'mouthPucker', 'eyeWide_L', 'eyeWide_R', 'mouthClose', 'tongueOut', 'noseSneer_L', 'noseSneer_R'];
  fake.forEach((f, i) => i < names.length && (names[i] = f));
  json.extensions.VRM.meta.title = 'Worm (ARKit test)';
  let s = Buffer.from(JSON.stringify(json));
  s = Buffer.concat([s, Buffer.alloc((4 - (s.length % 4)) % 4, 0x20)]);
  const head = Buffer.alloc(20);
  head.write('glTF', 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(20 + s.length + rest.length, 8);
  head.writeUInt32LE(s.length, 12);
  head.write('JSON', 16);
  return Buffer.concat([head, s, rest]);
}

const tmp = join(tmpdir(), `vpuppet-docs-shots-${process.pid}`);
mkdirSync(tmp, { recursive: true });
const wormArkit = wormWithArkitShapes();

const vite = await startVite(5191);
const browser = await launch({ extraArgs: ['--use-fake-device-for-media-stream'] });
let made = 0;

try {
  for (const lang of LANGS) {
    const dir = join(OUT, lang);
    mkdirSync(dir, { recursive: true });
    // A fresh context per language: its own (empty) model library.
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log(`[${lang}] pageerror`, e.message));
    await page.route('**/__local/worm-arkit.vrm', (r) => r.fulfill({ body: wormArkit, contentType: 'application/octet-stream' }));
    await page.goto(`${vite.url}/?lang=${lang}&home=1`);
    await page.waitForFunction(() => window.__puppet?.home, null, { timeout: 30000 });
    await page.waitForTimeout(1500);

    const shot = async (name, prep, clip) => {
      if (ONLY && !ONLY.includes(name)) return;
      await prep?.();
      await page.waitForTimeout(700);
      const png = join(tmp, `${lang}-${name}.png`);
      await page.screenshot({ path: png, clip: clip ? await clip() : undefined });
      execFileSync('cwebp', ['-quiet', '-q', '85', png, '-o', join(dir, `${name}.webp`)]);
      made++;
      console.log(`${lang}/${name}.webp`);
    };
    const key = async (k) => {
      await page.keyboard.press(k);
      await page.waitForTimeout(400);
    };
    const closeModal = () => page.evaluate(() => document.querySelector('dialog[open] .pm-close')?.click());

    // Library with the CC0 avatars (and the doctor's test model).
    const ids = await page.evaluate(async () => {
      const lib = window.__puppet.home.library;
      const add = async (name, url) => (await lib.import({ name, bytes: await (await fetch(url)).arrayBuffer() })).id;
      return {
        devil: await add('devil.vrm', '/test-assets/cc0/devil.vrm'),
        worm: await add('the-worm.vrm', '/test-assets/cc0/the-worm.vrm'),
        arkit: await add('worm-arkit.vrm', '/__local/worm-arkit.vrm'),
      };
    });
    await page.evaluate(() => window.__puppet.home.show(true));
    await shot('library');

    // MODEL DOCTOR on the misnamed-shapes worm (card menu → MODEL DOCTOR).
    await shot('model-doctor', async () => {
      await page.click(`.card[data-id="${ids.arkit}"] .more`);
      await page.click(`.card[data-id="${ids.arkit}"] [data-act="doctor"]`);
      await page.waitForTimeout(1200);
    });
    await closeModal();

    // The stage with the devil, full body, debug overlay off.
    await page.evaluate(async (id) => {
      await window.__puppet.mcp.call('library_load', { id });
      window.__puppet.frame('full');
    }, ids.devil);
    await page.waitForTimeout(2500);
    if (await page.evaluate(() => !document.body.classList.contains('no-debug'))) await key('d');
    await shot('stage');

    // Settings windows, one at a time.
    await shot('scene', async () => {
      await page.evaluate(() => {
        const p = window.__puppet;
        p.env.set('room', 'high');
        if (p.settings.background.kind !== 'environment') p.env.toggle();
      });
      await page.waitForTimeout(2500); // the scene loads
      await key('b');
    });
    await closeModal();
    await shot('face', () => key('f'));
    await closeModal();
    await shot('physics', () => key('p'));
    await closeModal();
    await shot('motion', () => key('a'));
    await closeModal();
    await shot('hotkeys', () => key('k'));
    await closeModal();
    await shot('lipsync', () => key('s'));
    await closeModal();
    // Cut above AI AGENTS (MCP): in a browser it says DESKTOP APP ONLY, which isn't what users see.
    await shot(
      'vmc',
      () => key('n'),
      async () => {
        const top = await page.evaluate(() => document.getElementById('mcp-controls')?.closest('section')?.getBoundingClientRect().top ?? 900);
        return { x: 0, y: 0, width: 1440, height: Math.max(300, Math.min(900, Math.floor(top))) };
      },
    );
    await closeModal();
    await ctx.close();
  }
} finally {
  await browser.close();
  vite.close();
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`${made} screenshots`);
