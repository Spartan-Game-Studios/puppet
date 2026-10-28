// VRM compatibility sweep: loads every model in headless Chrome, measures
// what tends to break per model (harness/compat.ts), drives it with the
// tracking test clip in the real app, and writes an HTML + JSON report with
// a PASS / WARN / FAIL per check.
//
//   node scripts/compat-sweep.mjs [out-dir] [model.vrm ...]
//
// Models: the arguments, else PUPPET_MODELS (path-delimiter separated), else
// the committed CC0 fixtures in test-assets/cc0/. Options (env):
//   PUPPET_CLIP_DIR  rendered tracking clip (clip.webm + truth.json); without it the app pass is skipped
//   PUPPET_NO_APP=1  skip the app pass (tracking clip, MODEL INFO, library card)
//   PUPPET_PORT      vite port (default 5233)
//   PUPPET_STRICT=1  exit 1 when any check FAILs (CI)
//   PUPPET_CI=1      software GL (no GPU): skip the fps check
//   PUPPET_CHROME_ARGS  extra Chrome switches, e.g. "--use-angle=swiftshader"
//
// The report shows the models: keep it out of git unless every model is CC0.
import { mkdir, readdir, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, serveLocal } from './lib/browser.mjs';
import { startVite } from './lib/vite.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const out = resolve(process.argv[2] ?? join(ROOT, 'harness/out/compat'));
let models = process.argv.slice(3);
if (!models.length && process.env.PUPPET_MODELS) models = process.env.PUPPET_MODELS.split(delimiter).filter(Boolean);
if (!models.length) {
  const dir = join(ROOT, 'test-assets/cc0');
  models = existsSync(dir) ? (await readdir(dir)).filter((f) => f.toLowerCase().endsWith('.vrm')).map((f) => join(dir, f)) : [];
}
if (!models.length) {
  console.error('No models. Pass .vrm paths, set PUPPET_MODELS, or run scripts/fetch-test-avatars.mjs.');
  process.exit(2);
}
const clipDir = process.env.PUPPET_CLIP_DIR;
const appPass = process.env.PUPPET_NO_APP !== '1' && clipDir && existsSync(join(clipDir, 'clip.webm'));
await mkdir(out, { recursive: true });

const slugOf = (p) => basename(p).replace(/\.vrm$/i, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'model';
const used = new Set();
const entries = models.map((p) => {
  let s = slugOf(p);
  while (used.has(s)) s += '-2';
  used.add(s);
  return { path: p, slug: s };
});

const saveImg = async (dir, name, dataUrl) => {
  if (!dataUrl) return null;
  const ext = dataUrl.startsWith('data:image/png') ? 'png' : 'jpg';
  const file = `${name}.${ext}`;
  await writeFile(join(dir, file), Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
  return file;
};

const vite = await startVite(Number(process.env.PUPPET_PORT ?? 5233));
const browser = await launch({ extraArgs: (process.env.PUPPET_CHROME_ARGS ?? '').split(' ').filter(Boolean) });
const results = [];

try {
  for (const [i, e] of entries.entries()) {
    const dir = join(out, e.slug);
    await mkdir(dir, { recursive: true });
    const size = (await stat(e.path)).size;
    console.log(`\n[${i + 1}/${entries.length}] ${basename(e.path)} (${(size / 1e6).toFixed(1)} MB)`);
    const r = { slug: e.slug, file: basename(e.path), bytes: size, images: {} };

    // ---- pass 1: harness measurements
    const page = await browser.newPage({ viewport: { width: 800, height: 700 } });
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    await serveLocal(page, { '/__local/model.vrm': e.path });
    try {
      await page.goto(`${vite.url}/harness/?test=compat`);
      await page.waitForFunction(() => window.__compatReady, null, { timeout: 60000 });
      const h = await page.evaluate(() => window.__compat.analyze('/__local/model.vrm'));
      // Pull the images out of the JSON.
      for (const [k, v] of Object.entries(h.shots ?? {})) r.images[k] = await saveImg(dir, k, v);
      delete h.shots;
      for (const [f, v] of Object.entries(h.framing ?? {})) {
        r.images[`frame-${f}`] = await saveImg(dir, `frame-${f}`, v.shot);
        delete v.shot;
      }
      for (const [id, c] of Object.entries(h.clips ?? {})) {
        const n = id.replace(/^builtin:/, '');
        c.shots = await Promise.all((c.shots ?? []).map((s, k) => saveImg(dir, `clip-${n}-${k}`, s)));
      }
      if (h.library?.thumb) {
        r.images.thumb = await saveImg(dir, 'thumb', h.library.thumb);
        delete h.library.thumb;
      }
      Object.assign(r, h);
    } catch (err) {
      r.harnessError = String(err.message ?? err).slice(0, 2000);
    }
    r.pageErrors = pageErrors;
    await page.close();
    console.log(`  harness: load ${r.load?.ok ? 'ok' : 'FAILED'} ${r.load?.ms ?? '?'} ms, ${r.render?.fps ?? '?'} fps, warnings: ${(r.facts?.warnings ?? []).map((w) => w.code).join(', ') || '-'}`);

    // ---- pass 2: the real app, driven by the tracking clip
    if (appPass && r.load?.ok) {
      try {
        r.app = await appRun(e, dir, r);
      } catch (err) {
        r.app = { error: String(err.message ?? err).slice(0, 2000) };
      }
      console.log(`  app: ${r.app.error ? `ERROR ${r.app.error.slice(0, 200)}` : `status "${r.app.status}"`}`);
    }
    r.checks = judge(r);
    console.log('  ' + Object.entries(r.checks).map(([k, v]) => `${k}:${v.s}`).join(' '));
    results.push(r);
    await writeFile(join(out, 'report.json'), JSON.stringify({ generated: new Date().toISOString(), appPass: !!appPass, results }, null, 1));
  }
} finally {
  await browser.close();
  vite.close();
}

await writeFile(join(out, 'report.html'), html(results));
const summary = summarize(results);
console.log('\n' + Object.entries(summary).map(([k, v]) => `${k.padEnd(12)} PASS ${v.PASS}  WARN ${v.WARN}  FAIL ${v.FAIL}  N/A ${v['N/A']}`).join('\n'));
console.log(`\nreport: ${join(out, 'report.html')}`);
const failed = results.some((r) => Object.values(r.checks).some((c) => c.s === 'FAIL'));
process.exit(process.env.PUPPET_STRICT === '1' && failed ? 1 : 0);

// ---------------------------------------------------------------- app pass
async function appRun(e, dir, r) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 300)));
  await serveLocal(page, { '/__local/model.vrm': e.path, '/__local/clip.webm': join(clipDir, 'clip.webm') });
  await page.goto(`${vite.url}/?model=/__local/model.vrm&source=file&src=/__local/clip.webm&loop=0&mirror=1&mode=hands`);
  await page.waitForFunction(() => window.__puppet?.avatar && window.__puppet.tracker.stats.face.fps > 0, null, { timeout: 180000 });
  const status = await page.$eval('#status', (el) => el.textContent);
  // Calibrate on the neutral opening, then play the clip through in real time (as in use).
  await page.evaluate(async () => {
    const v = window.__puppet.source.video;
    v.pause();
    v.currentTime = 0.4;
    await new Promise((res) => (v.onseeked = res));
    await new Promise((res) => setTimeout(res, 1500));
    window.__puppet.calibrate();
    v.currentTime = 0;
    await new Promise((res) => (v.onseeked = res));
    await v.play();
  });
  // Rig readout in the stage's space: forearm direction, head forward.
  const probe = () =>
    page.evaluate(() => {
      const a = window.__puppet.avatar;
      a.vrm.scene.updateMatrixWorld(true);
      const raw = (b) => a.vrm.humanoid.getRawBoneNode(b);
      const P = (n) => {
        const m = n.matrixWorld.elements;
        return [m[12], m[13], m[14]];
      };
      const dir = (x, y) => {
        const p = raw(x);
        const q = raw(y);
        if (!p || !q) return null;
        const A = P(p);
        const B = P(q);
        const d = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
        const l = Math.hypot(...d) || 1;
        return d.map((v) => +(v / l).toFixed(3));
      };
      const head = a.vrm.humanoid.getNormalizedBoneNode('head');
      const m = head.matrixWorld.elements;
      // Normalized bones face +Z (VRM 1.0) or -Z (VRM 0.x, the scene is turned instead).
      const s = a.isVrm0 ? -1 : 1;
      const fwd = [m[8] * s, m[9] * s, m[10] * s];
      const l = Math.hypot(...fwd) || 1;
      return { foreLeft: dir('leftLowerArm', 'leftHand'), foreRight: dir('rightLowerArm', 'rightHand'), upperLeft: dir('leftUpperArm', 'leftLowerArm'), upperRight: dir('rightUpperArm', 'rightLowerArm'), headFwd: fwd.map((v) => +(v / l).toFixed(3)) };
    });
  const moments = [
    ['rest-body', 1.2, 'upper'],
    ['head-left', 10.1, 'bust'],
    ['arms-up', 12.9, 'upper'],
  ];
  const rig = {};
  const at = (tt) => page.waitForFunction((x) => window.__puppet.source.video.currentTime >= x || window.__puppet.source.video.ended, tt, { timeout: 60000, polling: 16 });
  for (const [name, t, framing] of moments) {
    await at(t - 1);
    await page.evaluate((f) => window.__puppet.frame(f), framing);
    await at(t);
    rig[name] = await probe();
    rig[name].vt = await page.evaluate(() => +window.__puppet.source.video.currentTime.toFixed(2));
    const file = `app-${name}.jpg`;
    await page.locator('#stage').screenshot({ path: join(dir, file), type: 'jpeg', quality: 80 });
    r.images[`app-${name}`] = file;
  }
  await page.evaluate(() => window.__puppet.source.video.pause());
  // MODEL INFO.
  await page.keyboard.press('i');
  await page.waitForTimeout(400);
  let info = null;
  if (await page.isVisible('#model-info')) {
    info = await page.$eval('#model-info', (el) => el.innerText);
    await page.locator('#model-info').screenshot({ path: join(dir, 'app-model-info.png') });
    r.images['app-model-info'] = 'app-model-info.png';
    await page.keyboard.press('i');
  }
  // Library: loading imported it; go home and shoot its card.
  await page.waitForFunction(() => window.__puppet.home.library.size >= 1, null, { timeout: 60000 }).catch(() => {});
  await page.keyboard.press('l');
  await page.waitForSelector('#home-grid .card:not(.no-img)', { timeout: 30000 }).catch(() => {});
  let card = null;
  if (await page.isVisible('#home-grid .card')) {
    card = await page.$eval('#home-grid .card', (el) => ({ text: el.innerText, hasImg: !el.classList.contains('no-img') }));
    await page.locator('#home-grid .card').first().screenshot({ path: join(dir, 'app-card.png') });
    r.images['app-card'] = 'app-card.png';
  }
  await ctx.close();
  return { status, rig, info, card, errors: errors.slice(0, 20) };
}

// ---------------------------------------------------------------- judging
function judge(r) {
  const c = {};
  const set = (k, s, note = '') => (c[k] = { s, note });
  if (!r.load?.ok) {
    set('load', 'FAIL', r.load?.error?.split('\n')[0] ?? r.harnessError ?? 'no result');
    return c;
  }
  const consoleErr = (r.console ?? []).filter((x) => x.type === 'error').length + (r.pageErrors ?? []).length;
  const consoleWarn = (r.console ?? []).filter((x) => x.type === 'warn').length;
  set('load', consoleErr ? 'FAIL' : consoleWarn ? 'WARN' : 'PASS', `${r.load.ms} ms${consoleErr ? `, ${consoleErr} errors` : ''}${consoleWarn ? `, ${consoleWarn} warnings` : ''}`);

  const m = r.meta ?? {};
  set('meta', !m.name ? 'WARN' : 'PASS', `VRM ${m.spec} · ${m.name || '(no name)'} · ${m.badge}`);

  const f = r.facts ?? {};
  set('bones', f.missingRequired?.length ? 'FAIL' : !f.fingers || f.missingOptional?.some((b) => ['neck', 'chest'].includes(b)) ? 'WARN' : 'PASS',
    `${r.bones?.count} bones${f.missingRequired?.length ? `; MISSING ${f.missingRequired.join(', ')}` : ''}${!f.fingers ? '; no fingers' : ''}${f.missingOptional?.length ? `; no ${f.missingOptional.filter((b) => !/Proximal/.test(b)).join(', ')}` : ''}`);
  set('rest', !f.rest ? 'WARN' : f.rest.pose === 'T' ? 'PASS' : 'WARN', f.rest ? `${f.rest.pose}-pose (${f.rest.droopDeg}° down)` : 'unknown');
  const faceNote = f.face ? `face ${f.face[1] > 0 ? '+Z' : '-Z'} (${f.faceFrom})` : 'face direction unknown';
  set('facing', f.facing === -1 || f.warnings?.some((w) => w.code === 'face-backwards') ? 'FAIL' : f.facing === 0 || !f.face ? 'WARN' : 'PASS', `skeleton ${f.facing === 1 ? '+Z' : f.facing === -1 ? '-Z' : '?'}, ${faceNote}`);

  const b = r.bounds ?? {};
  const fr = r.framing ?? {};
  const bad = [];
  for (const k of ['bust', 'upper', 'full']) {
    const x = fr[k];
    if (!x) continue;
    if (x.inside) bad.push(`${k}: camera inside mesh`);
    if (k !== 'full' && !x.headInView) bad.push(`${k}: head out of view`);
    if (k === 'full' && !x.wholeInView) bad.push('full: not all in view');
    if (x.coveragePct < 1) bad.push(`${k}: avatar tiny (${x.coveragePct}%)`);
    if (k !== 'bust' && x.coveragePct > 97) bad.push(`${k}: frame filled by the model (${x.coveragePct}%)`);
  }
  set('framing', bad.some((s) => /inside|head out/.test(s)) ? 'FAIL' : bad.length ? 'WARN' : 'PASS', `height ${b.height} m${bad.length ? '; ' + bad.join('; ') : ''}`);

  const ex = r.expressions ?? {};
  const hasFace = (ex.presets ?? []).some((p) => ['aa', 'blink'].includes(p)) || ex.usePerfectSync;
  const surfaced = (f.warnings ?? []).some((w) => w.code === 'empty-expressions' || w.code === 'no-expressions');
  set('expressions', !ex.count || surfaced ? 'WARN' : hasFace && ex.driveDiffPx < 40 ? 'FAIL' : ex.driveDiffPx < 40 ? 'WARN' : 'PASS',
    `${ex.presets?.length ?? 0}/13 presets, ARKit ${ex.perfectSync}/52${ex.usePerfectSync ? ' (perfect sync)' : ''}; drive changed ${ex.driveDiffPx} px${surfaced ? '; model problem, surfaced in MODEL INFO' : ''}`);

  const la = r.lookAt ?? {};
  const eyes = (r.bones?.present ?? []).some((b) => /Eye$/.test(b));
  const laNote = `${la.declared ?? 'none'}${la.type && la.type !== String(la.declared).toLowerCase() ? ` → driven as ${la.type}` : ''}${eyes ? '' : ', no eye bones'}; gaze changed ${la.diffPx} px${la.eyeBoneTurned != null ? `, eye bone ${la.eyeBoneTurned}°` : ''}`;
  set('lookAt', !la.type ? 'WARN' : la.diffPx > 15 || (la.eyeBoneTurned ?? 0) > 2 ? 'PASS' : 'WARN', laNote);

  const sp = r.springs ?? {};
  if (sp.error) set('springs', 'FAIL', sp.error);
  else if (!sp.joints) set('springs', 'N/A', 'no spring bones');
  else set('springs', sp.nan ? 'FAIL' : sp.maxSpeed > 10 || sp.settleSeconds == null || sp.settleSeconds > 3 ? 'WARN' : 'PASS',
    `${sp.chains} chains / ${sp.joints} joints; groups ${sp.groups?.join(' ') || '-'}; max ${sp.maxSpeed} m/s, settle ${sp.settleSeconds ?? 'never'} s${sp.nan ? ', NaN' : ''}`);

  const sk = r.skin ?? {};
  set('skin', sk.maxBones > 256 && (r.skinIndexTypes ?? []).includes('u8') ? 'WARN' : 'PASS', `${sk.maxBones} skinned bones, indices ${(r.skinIndexTypes ?? []).join('/')}${sk.maxBones > 256 ? ' (16-bit path)' : ''}`);

  const mt = r.materials ?? {};
  const col = mt.colour ?? {};
  set('materials', mt.missingTextures?.length || col.pinkPct > 1 ? 'FAIL' : col.blackPct > 35 ? 'WARN' : 'PASS',
    `${Object.entries(mt.types ?? {}).map(([k, v]) => `${k}×${v}`).join(' ')}; transparent ${mt.transparent}, outline ${mt.outlines}; black ${col.blackPct?.toFixed(1)}%, pink ${col.pinkPct?.toFixed(1)}%${mt.missingTextures?.length ? `; missing ${mt.missingTextures.join(', ')}` : ''}`);

  const fps = r.render?.fps ?? 0;
  if (process.env.PUPPET_CI === '1') set('fps', 'N/A', `${fps} fps (software GL, not judged)`);
  else set('fps', fps >= 60 ? 'PASS' : fps >= 30 ? 'WARN' : 'FAIL', `${fps} fps uncapped at 1280×720 (${r.render?.frameMs} ms, ${r.render?.calls} draws)`);

  if (r.app) {
    if (r.app.error) set('body', 'FAIL', r.app.error.split('\n')[0]);
    else {
      const rg = r.app.rig;
      const up = (d) => (d ? d[1] : -1);
      const issues = [];
      const au = rg['arms-up'];
      const rb = rg['rest-body'];
      if (!(up(au.foreLeft) > 0.3 && up(au.foreRight) > 0.3)) issues.push(`arms-up forearms y ${up(au.foreLeft)}/${up(au.foreRight)}`);
      if (!(up(rb.upperLeft) < 0 && up(rb.upperRight) < 0)) issues.push(`rest upper arms y ${up(rb.upperLeft)}/${up(rb.upperRight)}`);
      const hl = rg['head-left'].headFwd;
      // Mirrored: the user turns to her left, the avatar turns to ITS right (screen left): forward x < 0.
      if (!(hl[0] < -0.15)) issues.push(`head-left forward x ${hl[0]}`);
      if (hl[2] < 0) issues.push('head faces backwards');
      set('body', issues.length ? 'WARN' : 'PASS', issues.join('; ') || `forearms up ${up(au.foreLeft)}/${up(au.foreRight)}, head x ${hl[0]}`);
    }
    const missing = (f.warnings ?? []).filter((w) => !r.app.info?.includes(w.text));
    const cardWarn = (r.app.card?.text ?? '').includes('⚠');
    set('modelInfo', !r.app.info ? 'FAIL' : missing.length ? 'FAIL' : 'PASS', !r.app.info ? 'MODEL INFO did not open' : missing.length ? `not shown: ${missing.map((w) => w.text).join('; ')}` : `${(f.warnings ?? []).length} model checks shown${cardWarn ? ', card flagged' : ''}`);
  }

  const cl = r.clips ?? {};
  const clipFails = [];
  const clipWarns = [];
  for (const [id, x] of Object.entries(cl)) {
    if (!x.ok) clipFails.push(`${id}: ${x.error}`);
    else if (x.nan) clipFails.push(`${id}: NaN`);
    else if (x.maxStepDeg > 45) clipWarns.push(`${id}: ${x.maxStepDeg}°/frame at ${x.maxStepAt}`);
  }
  set('clips', clipFails.length ? 'FAIL' : clipWarns.length ? 'WARN' : 'PASS', [...clipFails, ...clipWarns].join('; ') || Object.entries(cl).map(([id, x]) => `${id.replace('builtin:', '')} ${x.maxStepDeg}°`).join(', '));

  const lib = r.library ?? {};
  set('library', lib.error ? 'FAIL' : r.images.thumb ? (r.app && !r.app.card?.hasImg ? 'WARN' : 'PASS') : 'FAIL', lib.error ?? `${lib.stats?.polygons} tris, ${lib.stats?.springChains} chains${r.app?.card ? `; card ${r.app.card.hasImg ? 'has' : 'NO'} thumbnail` : ''}`);
  return c;
}

function summarize(results) {
  const s = {};
  for (const r of results) for (const [k, v] of Object.entries(r.checks)) {
    s[k] ??= { PASS: 0, WARN: 0, FAIL: 0, 'N/A': 0 };
    s[k][v.s]++;
  }
  return s;
}

// ---------------------------------------------------------------- report
function html(results) {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
  const keys = [...new Set(results.flatMap((r) => Object.keys(r.checks)))];
  const summary = summarize(results);
  const img = (r, k, cls = '') => (r.images[k] ? `<a href="${r.slug}/${r.images[k]}"><img class="${cls}" loading="lazy" src="${r.slug}/${r.images[k]}" alt="${esc(k)}" title="${esc(k)}"></a>` : '');
  const rows = results.map((r) => {
    const cells = keys.map((k) => {
      const c = r.checks[k];
      return c ? `<td class="${c.s.replace('/', '')}"><b>${c.s}</b><small>${esc(c.note)}</small></td>` : '<td></td>';
    });
    const warns = (r.facts?.warnings ?? []).map((w) => `<li>${esc(w.text)}</li>`).join('');
    const clipShots = Object.entries(r.clips ?? {}).flatMap(([, c]) => c.shots ?? []).map((f) => `<a href="${r.slug}/${f}"><img loading="lazy" src="${r.slug}/${f}"></a>`).join('');
    return `<tr><th class="model">${img(r, 'thumb', 'thumb')}<div>${esc(r.meta?.name || r.file)}</div><small>${esc(r.file)} · ${(r.bytes / 1e6).toFixed(1)} MB · VRM ${esc(r.meta?.spec)} · ${esc(r.meta?.badge)}<br>${esc((r.meta?.authors ?? []).join(', '))}</small>${warns ? `<ul class="warn">${warns}</ul>` : ''}</th>${cells.join('')}</tr>
<tr class="shots"><td colspan="${keys.length + 1}">${['neutral', 'driven', 'gaze', 'frame-bust', 'frame-upper', 'frame-full', 'full', 'back', 'app-rest-body', 'app-head-left', 'app-arms-up', 'app-model-info', 'app-card'].map((k) => img(r, k)).join('')}${clipShots}</td></tr>`;
  });
  const sumRows = keys.map((k) => `<tr><th>${k}</th><td class="PASS">${summary[k].PASS}</td><td class="WARN">${summary[k].WARN}</td><td class="FAIL">${summary[k].FAIL}</td><td class="NA">${summary[k]['N/A']}</td></tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Puppet VRM compatibility</title>
<style>
:root{--bg:#f4f3ee;--fg:#1b1b1b;--mute:#666;--pass:#d7ecd3;--warn:#f6e7b5;--fail:#f4c4c0;--na:#e4e4e4;--line:#ccc}
@media (prefers-color-scheme:dark){:root{--bg:#161616;--fg:#e8e8e8;--mute:#999;--pass:#21402a;--warn:#4a3f17;--fail:#55201d;--na:#2a2a2a;--line:#333}}
body{background:var(--bg);color:var(--fg);font:12px/1.35 ui-monospace,Menlo,monospace;margin:16px}
h1{font-size:18px}table{border-collapse:collapse}td,th{border:1px solid var(--line);padding:4px;vertical-align:top;text-align:left}
td small,th small{display:block;color:var(--mute);font-weight:normal;max-width:220px;word-break:break-word}
.PASS{background:var(--pass)}.WARN{background:var(--warn)}.FAIL{background:var(--fail)}.NA{background:var(--na)}
.model{min-width:180px}.thumb{width:128px;height:128px}ul.warn{margin:4px 0;padding-left:16px;color:#b04000}
tr.shots img{height:150px;margin:2px}.wrap{overflow-x:auto}
</style></head><body><h1>Puppet VRM compatibility sweep</h1>
<p>${results.length} models · generated ${new Date().toISOString()} · app pass ${appPass ? 'on (tracking clip)' : 'off'}</p>
<table><tr><th>check</th><th>PASS</th><th>WARN</th><th>FAIL</th><th>N/A</th></tr>${sumRows}</table>
<h2>Models</h2><div class="wrap"><table><tr><th>model</th>${keys.map((k) => `<th>${k}</th>`).join('')}</tr>${rows.join('\n')}</table></div></body></html>`;
}
