// HOME / model library test in headless Chrome, using the browser's IndexedDB
// fallback for storage. Imports local models through the real UI (file dialog,
// drag-drop, the "last model" migration offer), toggles favourites, filters,
// searches, renames, removes, loads a model onto the stage, returns home,
// reloads to check persistence, and saves screenshots along the way.
//
//   PUPPET_MODELS="/a.vrm:/b.vrm:..." [PUPPET_URL=http://localhost:5173] node scripts/library-test.mjs out/
//
// The models stay where they are (served by request interception). Screenshots
// show the models, so they carry the models' licences: keep them out of git.
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { BASE, launch, serveLocal, requireEnv } from './lib/browser.mjs';

const out = process.argv[2] ?? 'library-shots';
const models = requireEnv('PUPPET_MODELS').split(delimiter).filter(Boolean);
if (models.length < 3) {
  console.error('PUPPET_MODELS needs at least 3 .vrm files.');
  process.exit(2);
}
await mkdir(out, { recursive: true });

const failures = [];
const check = (ok, msg) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failures.push(msg);
};
let shotN = 0;
const shot = async (page, name) => {
  const p = join(out, `${String(++shotN).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: p });
  console.log(`      shot ${p}`);
};

// A file that is not a VRM, to see the per-file error.
const junk = join(tmpdir(), 'puppet-library-test-not-a-model.vrm');
await writeFile(junk, 'this is a text file pretending to be a model');

const browser = await launch({ extraArgs: ['--use-fake-device-for-media-stream'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await context.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error' || process.env.PUPPET_VERBOSE) console.log(`[${m.type()}]`, m.text());
});
const map = {};
models.forEach((m, i) => (map[`/__local/m${i}.vrm`] = m));
await serveLocal(page, map);

// Pre-library settings with a "last model", to exercise the one-time import offer.
await page.addInitScript(() => {
  if (!sessionStorage.getItem('seeded')) {
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('puppet.settings', JSON.stringify({ lastModelPath: '/__local/m0.vrm', ui: { tab: 'face', debug: false } }));
  }
});

const ready = async () => {
  await page.waitForFunction(() => window.__puppet?.home, null, { timeout: 30000 });
  await page.waitForTimeout(400);
};
const lib = () => page.evaluate(() => window.__puppet.home.library.size);
const cardNames = () => page.$$eval('#home-grid .card .name', (els) => els.map((e) => e.textContent));
const waitImports = (n) =>
  page.waitForFunction((n) => document.querySelectorAll('#home-import-list li.ok, #home-import-list li.dup, #home-import-list li.err').length >= n, n, { timeout: 180000 });

await page.goto(`${BASE}/`);
await ready();

// ---------------------------------------------------------------- 1. first launch: empty state + migration offer
check(await page.evaluate(() => document.body.classList.contains('on-home')), 'home is the first screen');
check(await page.isVisible('#home-empty'), 'empty state shown');
check(await page.isVisible('#home-migrate'), 'offers to import the old "last model" setting');
check((await page.$$('#home-empty a[data-link]')).length === 3, 'three "where to get models" links');
await shot(page, 'home-empty-first-launch');

// ---------------------------------------------------------------- 2. import: migration, dialog (many + junk), drop
await page.click('#btn-migrate-yes');
await waitImports(1);
check((await lib()) === 1, 'migration imported the last model');
check(!(await page.isVisible('#home-migrate')), 'offer goes away');

const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#btn-import')]);
check(chooser.isMultiple(), 'import dialog takes several files');
await chooser.setFiles([...models.slice(1), junk]);
// Mid-import shot: wait until at least one row is busy.
await page.waitForSelector('#home-import-list li.busy', { timeout: 30000 }).catch(() => {});
await shot(page, 'home-importing-progress');
await waitImports(models.length + 1);
await page.waitForTimeout(300);
check((await lib()) === models.length, `all ${models.length} models imported`);
const err = await page.$eval('#home-import-list li.err .s', (e) => e.textContent).catch(() => '');
check(/NOT A VRM/.test(err), `per-file error for the junk file ("${err}")`);
await shot(page, 'home-import-done');

// Drag-drop a model that is already in the library: dedup by hash.
await page.evaluate(async () => {
  const buf = await (await fetch('/__local/m1.vrm')).arrayBuffer();
  const dt = new DataTransfer();
  dt.items.add(new File([buf], 'copy-of-model.vrm'));
  const home = document.getElementById('home');
  home.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
  home.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
});
await waitImports(models.length + 2);
check((await page.$$('#home-import-list li.dup')).length === 1, 'dropping a duplicate says ALREADY IN LIBRARY');
check((await lib()) === models.length, 'no duplicate entry');
await page.click('#btn-imports-close');

// ---------------------------------------------------------------- 3. keyboard + favourites
const all = await cardNames();
console.log('      cards:', all.join(' | '));
// Click an unrestricted card (restricted ones are kept for the one-time notice check below).
const plain = await page.$$eval('#home-grid .card', (els) => els.findIndex((e) => !e.querySelector('.badges .lic.warn')) + 1);
// A single click only selects; USE MODEL loads.
await page.click(`#home-grid .card:nth-child(${plain}) .name`);
await page.waitForTimeout(300);
check(await page.evaluate(() => document.body.classList.contains('on-home')), 'single click does not load');
await page.click(`#home-grid .card:nth-child(${plain}) .use`);
// USE MODEL loads it; come back.
await page.waitForFunction(() => !document.body.classList.contains('on-home'));
await page.waitForFunction(() => window.__puppet.avatar, null, { timeout: 60000 });
await page.keyboard.press('Escape');
await page.waitForFunction(() => document.body.classList.contains('on-home'));
check(true, 'USE MODEL loads, Esc returns home');
await page.focus('#home-grid .card');
await page.keyboard.press('ArrowRight');
const focused1 = await page.evaluate(() => document.activeElement?.dataset.id);
const second = await page.$eval('#home-grid .card:nth-child(2)', (e) => e.dataset.id);
check(focused1 === second, 'ArrowRight moves focus to the next card');
await page.keyboard.press('ArrowLeft');
await page.keyboard.press('ArrowDown');
const cols = await page.evaluate(() => getComputedStyle(document.getElementById('home-grid')).gridTemplateColumns.split(' ').length);
const focusedDown = await page.evaluate(() => [...document.querySelectorAll('#home-grid .card')].indexOf(document.activeElement));
check(focusedDown === Math.min(cols, models.length - 1), `ArrowDown moves one row (${cols} columns)`);

// Favourite the last two cards (one by key S, one by clicking the star).
const before = await cardNames();
await page.focus(`#home-grid .card:nth-child(${models.length})`);
await page.keyboard.press('s');
await page.click(`#home-grid .card:nth-child(${models.length}) .star`); // the old second-to-last is now last
const favNames = await page.$$eval('#home-grid .card.fav .name', (e) => e.map((x) => x.textContent));
const afterFav = await cardNames();
check(favNames.length === 2, 'two favourites');
check(afterFav.slice(0, 2).every((n) => favNames.includes(n)), 'favourites sort first in ALL');
console.log('      before:', before.join(' | '), '\n      after: ', afterFav.join(' | '));
await page.focus('#home-grid .card:nth-child(1)');
await shot(page, 'home-grid-favourites-first');

await page.click('#home-filter button[data-value="favourites"]');
check((await page.$$('#home-grid .card')).length === 2, 'FAVOURITES filter shows 2');
await shot(page, 'home-filter-favourites');
await page.click('#home-filter button[data-value="all"]');

// ---------------------------------------------------------------- 4. search + sort
const authors = await page.$$eval('#home-grid .card .author', (e) => e.map((x) => x.textContent.replace(/^BY /, '')));
const term = (authors.find((a, i) => a && authors.indexOf(a) !== authors.lastIndexOf(a)) ?? authors[0]).split(' ')[0];
await page.keyboard.press('/');
await page.keyboard.type(term.toLowerCase());
const hits = await page.$$eval('#home-grid .card .author', (e) => e.map((x) => x.textContent));
check(hits.length > 0 && hits.every((h) => h.toLowerCase().includes(term.toLowerCase())), `search "${term.toLowerCase()}" matches by author (${hits.length})`);
await shot(page, 'home-search');
await page.keyboard.press('Escape');
check((await page.$$('#home-grid .card')).length === models.length, 'Esc clears the search');
await page.selectOption('#home-sort', 'name');
const byName = await cardNames();
const nonFav = byName.slice(2);
check(nonFav.join() === [...nonFav].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })).join(), 'SORT NAME orders the rest by name');
await page.selectOption('#home-sort', 'used');

// ---------------------------------------------------------------- 5. licence drawer, menu, rename
const restrictedIdx = await page.$$eval('#home-grid .card .badges .lic', (e) => e.findIndex((x) => x.classList.contains('warn')));
check(restrictedIdx >= 0, 'a restricted (AUTHOR ONLY / LICENSED ONLY) badge is shown');
const target = restrictedIdx >= 0 ? restrictedIdx + 1 : 1;
await page.focus(`#home-grid .card:nth-child(${target})`);
await page.keyboard.press('l');
check(await page.isVisible(`#home-grid .card:nth-child(${target}) .lic-drawer`), 'L opens the licence drawer');
await shot(page, 'home-licence-drawer');
await page.keyboard.press('Escape');
check(!(await page.isVisible(`#home-grid .card:nth-child(${target}) .lic-drawer`)), 'Esc closes it');

await page.click('#home-grid .card:nth-child(2) .more');
await shot(page, 'home-card-menu');
await page.click('#home-grid .card:nth-child(2) [data-act="rename"]');
await page.keyboard.press('ControlOrMeta+a');
await page.keyboard.type('Renamed In Test');
await page.keyboard.press('Enter');
check((await cardNames()).includes('Renamed In Test'), 'rename');

// Re-render a thumbnail.
await page.click('#home-grid .card:nth-child(2) .more');
await page.click('#home-grid .card:nth-child(2) [data-act="thumb"]');
await page.waitForFunction(() => /THUMBNAIL UPDATED/.test(document.getElementById('status').textContent), null, { timeout: 60000 });
check(true, 're-render thumbnail');

// ---------------------------------------------------------------- 6. remove (confirm)
const victim = (await cardNames())[models.length - 1];
await page.focus(`#home-grid .card:nth-child(${models.length})`);
await page.keyboard.press('Delete');
check(await page.isVisible('#home-confirm'), 'remove asks for confirmation');
await shot(page, 'home-remove-confirm');
await page.click('#btn-confirm-cancel');
check((await lib()) === models.length, 'cancel keeps it');
await page.keyboard.press('Delete');
await page.click('#btn-confirm-ok');
await page.waitForFunction((n) => window.__puppet.home.library.size === n, models.length - 1);
check(!(await cardNames()).includes(victim), `removed "${victim}"`);

// ---------------------------------------------------------------- 7. load a restricted model: stage, notice, model info
const restrictedName = await page.$$eval('#home-grid .card', (els) => {
  // Prefer a perfect-sync model: it makes the better stage shot.
  const warn = els.filter((e) => e.querySelector('.badges .lic.warn'));
  const c = warn.find((e) => e.querySelector('.badges .b.ps.hi')) ?? warn[0];
  return c?.querySelector('.name').textContent ?? null;
});
if (restrictedName) {
  const n = (await cardNames()).indexOf(restrictedName) + 1;
  await page.focus(`#home-grid .card:nth-child(${n})`);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.body.classList.contains('on-home'));
  await page.waitForFunction((name) => document.getElementById('model-name').textContent === name, restrictedName, { timeout: 90000 });
  await page.waitForTimeout(2500);
  check(await page.isVisible('#lic-notice'), 'one-time licence notice on load (non-blocking)');
  check((await page.evaluate(() => !!window.__puppet.avatar)), 'model loaded despite the restriction');
  check(await page.isVisible('#btn-model-info .badge.lic-letter.warn'), 'bottom-bar licence letter badge (accent for restricted)');
  await shot(page, 'stage-licence-notice');
  await page.keyboard.press('i');
  check(await page.isVisible('#model-info'), 'I opens MODEL INFO with the licence');
  await shot(page, 'stage-model-info');
  await page.keyboard.press('i');
  await page.keyboard.press('l');
  await page.waitForFunction(() => document.body.classList.contains('on-home'));
  check(await page.isVisible('#home-grid .card.current'), 'the card on stage is marked ON STAGE');
  await page.waitForTimeout(300);
  await shot(page, 'home-after-stage');
}

// ---------------------------------------------------------------- 8. stage open imports into the library
await page.keyboard.press('Escape');
await page.waitForFunction(() => !document.body.classList.contains('on-home'));
await page.evaluate(async () => {
  const buf = await (await fetch('/__local/m' + (window.__testLast ?? 0) + '.vrm')).arrayBuffer();
  const dt = new DataTransfer();
  dt.items.add(new File([buf], 'stage-drop.vrm'));
  window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
});
await page.waitForTimeout(3000);
check((await lib()) === models.length - 1, 'dropping a library model on the stage loads it without a duplicate');

// ---------------------------------------------------------------- 9. persistence across reload
const favsBefore = await page.evaluate(() => Object.values(window.__puppet.home.library.index.entries).filter((e) => e.favourite).length);
await page.reload();
await ready();
check((await lib()) === models.length - 1, 'library survives a reload (IndexedDB)');
check(!(await page.isVisible('#home-migrate')), 'migration offered only once');
const favsAfter = await page.evaluate(() => Object.values(window.__puppet.home.library.index.entries).filter((e) => e.favourite).length);
check(favsAfter === favsBefore && favsAfter > 0, 'favourites persist');
check((await cardNames()).includes('Renamed In Test'), 'rename persists');
if (restrictedName) {
  const n = (await cardNames()).indexOf(restrictedName) + 1;
  await page.dblclick(`#home-grid .card:nth-child(${n}) .name`);
  await page.waitForFunction((name) => document.getElementById('model-name').textContent === name, restrictedName, { timeout: 90000 });
  await page.waitForTimeout(1500);
  check(!(await page.isVisible('#lic-notice')), 'the notice is one-time (not shown again)');
  await page.keyboard.press('l');
}

// ---------------------------------------------------------------- 10. minimum window size
await page.setViewportSize({ width: 960, height: 600 });
await page.waitForTimeout(500);
const overflow = await page.evaluate(() => document.getElementById('home').scrollWidth - document.getElementById('home').clientWidth);
check(overflow <= 0, 'no horizontal overflow at 960×600');
await page.focus('#home-grid .card');
await shot(page, 'home-min-size-960x600');
await page.setViewportSize({ width: 1440, height: 900 });

await writeFile(join(out, 'models.txt'), models.map((m) => basename(m)).join('\n') + '\n');
await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED:\n- ${failures.join('\n- ')}` : '\nALL PASSED');
process.exit(failures.length ? 1 : 0);
