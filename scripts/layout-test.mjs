// Stage layout test in headless Chrome: the top-bar settings modals, the
// camera card (minimize, sections), the bottom bar's model status, the debug
// overlay, keyboard focus handling and gamepad navigation (a fake pad), and
// no overflow at the minimum window size (960×600) and at 1920×1080.
//
//   [PUPPET_MODEL=/path/cc0.vrm] [PUPPET_RESTRICTED_MODEL=/path/author-only.vrm] node scripts/layout-test.mjs [shots-dir]
//
// PUPPET_RESTRICTED_MODEL (optional, any AUTHOR ONLY / LICENSED ONLY model)
// also checks the accent letter badge. Its screenshots are not written.
//
// Default model: the committed CC0 fixture test-assets/cc0/devil.vrm. Starts
// its own Vite (PUPPET_PORT, default 5241) unless PUPPET_URL is set.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, serveLocal } from './lib/browser.mjs';
import { startVite } from './lib/vite.mjs';

const out = process.argv[2] ?? null;
const model = process.env.PUPPET_MODEL ?? fileURLToPath(new URL('../test-assets/cc0/devil.vrm', import.meta.url));
if (out) await mkdir(out, { recursive: true });

const failures = [];
const check = (ok, msg) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failures.push(msg);
};

const vite = await startVite(Number(process.env.PUPPET_PORT ?? 5241));
const browser = await launch({ extraArgs: ['--use-fake-device-for-media-stream'] });

const MODALS = ['scene', 'face', 'physics', 'motion', 'hotkeys', 'lipsync', 'vmc'];
const KEYS = { scene: 'b', face: 'f', physics: 'p', motion: 'a', hotkeys: 'k', lipsync: 's', vmc: 'n' };

/** Elements sticking out of the window, or out of their bar / the stage. */
async function overflow(page) {
  return page.evaluate(() => {
    const bad = [];
    const W = innerWidth;
    const H = innerHeight;
    const de = document.documentElement;
    if (de.scrollWidth > de.clientWidth || de.scrollHeight > de.clientHeight) bad.push(`page scrolls ${de.scrollWidth}×${de.scrollHeight}`);
    const vis = (el) => el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
    const out = (el, box, name) => {
      if (!vis(el)) return;
      const r = el.getBoundingClientRect();
      if (r.left < box.left - 0.5 || r.right > box.right + 0.5 || r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5)
        bad.push(`${name} ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.right)},${Math.round(r.bottom)} outside ${Math.round(box.left)},${Math.round(box.top)} ${Math.round(box.right)},${Math.round(box.bottom)}`);
    };
    const win = { left: 0, top: 0, right: W, bottom: H };
    // Top and bottom bars clip (overflow hidden): every child must fit.
    for (const bar of document.querySelectorAll('.bar')) {
      const box = bar.getBoundingClientRect();
      for (const el of bar.querySelectorAll(':scope > *, .settings-nav > *')) out(el, box, `${bar.id || bar.className} > ${el.id || el.className || el.tagName}`);
    }
    const stage = document.getElementById('stage').getBoundingClientRect();
    out(document.getElementById('preview-box'), stage, 'camera card');
    out(document.getElementById('debug'), stage, 'debug overlay');
    const left = document.querySelector('.panel.left');
    if (left.scrollWidth > left.clientWidth) bad.push('left panel scrolls sideways');
    for (const d of document.querySelectorAll('dialog[open]')) {
      out(d, win, `modal ${d.id}`);
      const b = d.querySelector('.pm-body');
      if (b && b.scrollWidth > b.clientWidth + 1) bad.push(`modal ${d.id} body scrolls sideways`);
    }
    // Text cut off without an ellipsis in the bars.
    return bad;
  });
}

const rectsOverlap = (a, b) => a && b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

for (const [w, h] of [[960, 600], [1920, 1080]]) {
  console.log(`\n== ${w}×${h}`);
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => {
    console.log('[pageerror]', e.message);
    failures.push(`page error: ${e.message}`);
  });
  // A fake gamepad the test presses buttons on (standard mapping).
  await page.addInitScript(() => {
    window.__pad = { buttons: new Array(17).fill(0), axes: [0, 0, 0, 0] };
    const pad = () => ({ id: 'Test Pad (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard', timestamp: performance.now(), axes: window.__pad.axes, buttons: window.__pad.buttons.map((v) => ({ pressed: v > 0.5, value: v, touched: v > 0 })) });
    Object.defineProperty(navigator, 'getGamepads', { value: () => [pad()] });
  });
  await serveLocal(page, { '/__local/model.vrm': model });
  await page.goto(`${vite.url}/?model=%2F__local%2Fmodel.vrm`);
  await page.waitForFunction(() => window.__puppet?.avatar, null, { timeout: 60000 });
  await page.waitForTimeout(2500);
  const shot = async (name) => out && (await page.screenshot({ path: join(out, `layout-${w}x${h}-${name}.png`) }));
  const pad = async (button) => {
    await page.evaluate((b) => (window.__pad.buttons[b] = 1), button);
    await page.waitForTimeout(80);
    await page.evaluate((b) => (window.__pad.buttons[b] = 0), button);
    await page.waitForTimeout(80);
  };
  const active = () => page.evaluate(() => {
    const a = document.activeElement;
    return a ? (a.id || a.dataset.modal || a.className || a.tagName) : null;
  });

  // ---------------------------------------------------------------- stage
  let bad = await overflow(page);
  check(bad.length === 0, `stage: no overflow${bad.length ? ` (${bad.join('; ')})` : ''}`);
  await shot('stage');

  // ---------------------------------------------------------------- bottom bar
  const bar = await page.evaluate(() => ({
    name: document.getElementById('model-name').textContent,
    letter: document.querySelector('#btn-model-info .badge.lic-letter')?.textContent,
    title: document.querySelector('#btn-model-info .badge.lic-letter')?.title,
    track: document.getElementById('track-state').textContent,
    sync: document.getElementById('sync-mode').textContent,
    status: document.getElementById('status').textContent,
  }));
  check(bar.name && bar.name !== 'NO MODEL', `bottom bar: model name (${bar.name})`);
  check(/^[A-Z]$/.test(bar.letter ?? ''), `bottom bar: one-letter licence badge (${bar.letter}: ${bar.title})`);
  check(['TRACKING', 'LOST', 'FACE ONLY', 'WAITING', 'NO HANDS', 'NO SOURCE'].includes(bar.track), `bottom bar: tracking state (${bar.track})`);
  check(/PRESETS|PERFECT SYNC/.test(bar.sync), `bottom bar: sync (${bar.sync})`);
  await page.click('#btn-model-info');
  await page.waitForTimeout(200);
  check(await page.isVisible('#model-info'), 'model name opens MODEL INFO');
  check(await page.evaluate(() => document.getElementById('model-info').contains(document.activeElement)), 'MODEL INFO takes focus');
  bad = await overflow(page);
  check(bad.length === 0, `MODEL INFO: no overflow${bad.length ? ` (${bad.join('; ')})` : ''}`);
  await shot('model-info');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  check(!(await page.isVisible('#model-info')), 'Esc closes MODEL INFO');
  check((await active()) === 'btn-model-info', 'focus returns to the model name');
  check(await page.evaluate(() => !document.body.classList.contains('on-home')), 'Esc in a modal does not leave the stage');
  await page.keyboard.press('i');
  await page.waitForTimeout(150);
  check(await page.isVisible('#model-info'), 'I opens MODEL INFO');
  await page.keyboard.press('i');
  await page.waitForTimeout(150);
  check(!(await page.isVisible('#model-info')), 'I closes it again');

  // ---------------------------------------------------------------- modals
  for (const id of MODALS) {
    const btn = `#settings-nav [data-modal="${id}"]`;
    await page.click(btn);
    await page.waitForTimeout(250);
    const open = await page.isVisible(`#modal-${id}`);
    check(open, `${id}: top-bar button opens the modal`);
    if (!open) continue;
    check(await page.evaluate((id) => document.getElementById(`modal-${id}`).contains(document.activeElement), id), `${id}: focus moves into it`);
    // Tab stays inside.
    let escaped = false;
    for (let i = 0; i < 40 && !escaped; i++) {
      await page.keyboard.press(i % 7 === 6 ? 'Shift+Tab' : 'Tab');
      escaped = !(await page.evaluate((id) => document.getElementById(`modal-${id}`).contains(document.activeElement), id));
    }
    check(!escaped, `${id}: Tab is trapped inside`);
    bad = await overflow(page);
    check(bad.length === 0, `${id}: no overflow${bad.length ? ` (${bad.join('; ')})` : ''}`);
    if (id === 'scene' || id === 'face' || w === 960) await shot(`modal-${id}`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    check(!(await page.isVisible(`#modal-${id}`)), `${id}: Esc closes`);
    check(await page.evaluate((s) => document.activeElement === document.querySelector(s), btn), `${id}: focus returns to its button`);
    // Its shortcut key opens and closes it.
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press(KEYS[id]);
    await page.waitForTimeout(150);
    check(await page.isVisible(`#modal-${id}`), `${id}: ${KEYS[id].toUpperCase()} opens it`);
    // (In a text / number field the letter is typed instead; press it from the close button.)
    await page.focus(`#modal-${id} .pm-close`);
    await page.keyboard.press(KEYS[id]);
    await page.waitForTimeout(150);
    check(!(await page.isVisible(`#modal-${id}`)), `${id}: ${KEYS[id].toUpperCase()} closes it`);
  }

  // ---------------------------------------------------------------- camera card
  await page.click('.csec[data-csec="vcam"] .csec-head');
  await page.waitForTimeout(200);
  check(await page.isVisible('#vcam-mount #vcam-controls'), 'VIRTUAL CAM section expands (single mount point)');
  check(await page.evaluate(() => window.__puppet.settings.ui.cam.vcam === true), 'section state persists in settings');
  bad = await overflow(page);
  check(bad.length === 0, `card + VIRTUAL CAM open: no overflow${bad.length ? ` (${bad.join('; ')})` : ''}`);
  await shot('card-vcam');
  const framesBefore = await page.evaluate(() => window.__puppet.tracker.stats.face.fps + window.__puppet.tracker.stats.body.fps);
  await page.click('#btn-preview-min');
  await page.waitForTimeout(1500);
  const min = await page.evaluate(() => ({
    min: document.getElementById('preview-box').classList.contains('min'),
    canvas: document.getElementById('preview-canvas').getClientRects().length > 0,
    h: document.getElementById('preview-box').getBoundingClientRect().height,
    preview: window.__puppet.settings.preview,
    fps: window.__puppet.tracker.stats.face.fps + window.__puppet.tracker.stats.body.fps,
    src: window.__puppet.source.kind,
  }));
  check(min.min && !min.canvas && min.h < 40 && !min.preview, `minimize collapses the card to a strip (${Math.round(min.h)}px)`);
  check(min.src !== 'none' && (framesBefore === 0 || min.fps > 0), `tracking keeps running while minimized (${min.fps} fps, source ${min.src})`);
  bad = await overflow(page);
  check(bad.length === 0, `card minimized: no overflow${bad.length ? ` (${bad.join('; ')})` : ''}`);
  await shot('card-min');
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('t');
  await page.waitForTimeout(200);
  check(!(await page.evaluate(() => document.getElementById('preview-box').classList.contains('min'))), 'T restores the card');
  await page.click('.csec[data-csec="vcam"] .csec-head');

  // ---------------------------------------------------------------- debug overlay
  const geo = await page.evaluate(() => {
    const r = (id) => {
      const el = document.getElementById(id);
      return el.getClientRects().length ? el.getBoundingClientRect().toJSON() : null;
    };
    return { debug: r('debug'), card: r('preview-box'), stage: r('stage'), bg: getComputedStyle(document.getElementById('debug')).backgroundColor };
  });
  check(!!geo.debug && geo.debug.right > geo.stage.left + geo.stage.width / 2 && geo.debug.top < geo.stage.top + geo.stage.height / 2, 'debug overlay sits in the top-right of the viewport');
  check(!rectsOverlap(geo.debug, geo.card), 'debug overlay does not cover the camera card');
  check(/rgba\(.*0\.\d+\)/.test(geo.bg), `debug overlay is semi-transparent (${geo.bg})`);
  await page.keyboard.press('d');
  await page.waitForTimeout(150);
  check(!(await page.isVisible('#debug')), 'D hides the debug overlay');
  await page.keyboard.press('d');
  await page.waitForTimeout(150);
  check(await page.isVisible('#debug'), 'D shows it again');

  // ---------------------------------------------------------------- gamepad
  await page.evaluate(() => document.activeElement?.blur());
  await pad(6); // LT: menu mode
  check(await page.evaluate(() => document.body.classList.contains('pad-menu')), 'pad LT enters menu mode');
  check((await active()) === 'scene', `menu mode focuses the first settings button (${await active()})`);
  await page.evaluate(() => window.__puppet.padNav.nav('right'));
  check((await active()) === 'face', `d-pad right moves to the next button (${await active()})`);
  await pad(0); // A
  await page.waitForTimeout(200);
  check(await page.isVisible('#modal-face'), 'pad A opens the focused modal');
  await pad(1); // B
  await page.waitForTimeout(200);
  check(!(await page.isVisible('#modal-face')), 'pad B closes the modal');
  check((await active()) === 'face', 'focus returns to its button after B');
  await page.evaluate(() => window.__puppet.padNav.nav('down'));
  const afterDown = await active();
  check(afterDown && afterDown !== 'face', `d-pad down leaves the top bar (${afterDown})`);
  await pad(1);
  check(await page.evaluate(() => !document.body.classList.contains('pad-menu')), 'pad B leaves menu mode');
  // Outside menu mode the pad is the performer's: A fires its hotkey, not the UI.
  const before = await page.evaluate(() => document.activeElement === document.body);
  await pad(0);
  check(before && (await page.evaluate(() => document.activeElement === document.body && !document.querySelector('dialog[open]'))), 'outside menu mode, pad A is left to the hotkeys');

  // ---------------------------------------------------------------- transparent + capture
  await page.keyboard.press('b');
  await page.waitForTimeout(150);
  await page.click('#bg-kind button[data-value="transparent"]');
  await page.keyboard.press('Escape');
  check(await page.evaluate(() => document.body.classList.contains('transparent')), 'CLEAR background still sets body.transparent');
  await page.keyboard.press('h');
  await page.waitForTimeout(300);
  const cap = await page.evaluate(() => ['.bar.top', '.bar.bottom', '.panel.left', '#preview-box', '#debug'].map((s) => document.querySelector(s).getClientRects().length));
  check(cap.every((n) => n === 0), 'capture view hides bars, panel, card and debug overlay');
  await page.keyboard.press('h');
  await page.click('#settings-nav [data-modal="scene"]');
  await page.click('#bg-kind button[data-value="color"]');
  await page.keyboard.press('Escape');

  // ---------------------------------------------------------------- HOME still works
  await page.keyboard.press('l');
  await page.waitForTimeout(400);
  check(await page.evaluate(() => document.body.classList.contains('on-home')), 'L opens HOME');
  check(!(await page.isVisible('#settings-nav')), 'settings buttons hide on HOME');
  await pad(1); // B on HOME = Esc = back to the stage
  await page.waitForTimeout(400);
  check(await page.evaluate(() => !document.body.classList.contains('on-home')), 'pad B on HOME returns to the stage');
  await page.close();
}

// ---------------------------------------------------------------- restricted licence badge (optional)
if (process.env.PUPPET_RESTRICTED_MODEL) {
  console.log('\n== restricted model');
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await serveLocal(page, { '/__local/restricted.vrm': process.env.PUPPET_RESTRICTED_MODEL });
  await page.goto(`${vite.url}/?model=%2F__local%2Frestricted.vrm`);
  await page.waitForFunction(() => window.__puppet?.avatar && document.querySelector('#btn-model-info .badge.lic-letter'), null, { timeout: 90000 });
  const b = await page.evaluate(() => {
    const el = document.querySelector('#btn-model-info .badge.lic-letter');
    return { letter: el.textContent, warn: el.classList.contains('warn'), bg: getComputedStyle(el).backgroundColor, title: el.title };
  });
  check(['A', 'L'].includes(b.letter) && b.warn && b.bg === 'rgb(255, 59, 0)', `restricted licence: letter ${b.letter} in the accent colour (${b.title})`);
  await page.close();
}

await browser.close();
vite.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASS');
process.exit(failures.length ? 1 : 0);
