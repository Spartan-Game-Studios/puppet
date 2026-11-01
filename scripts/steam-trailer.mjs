// Steam store trailer: a one-minute setup guide recorded from the real app UI
// in headless Chrome (nothing opens on screen), with captions and title cards
// drawn into the page so every script renders the same.
//   node scripts/steam-trailer.mjs <hero.vrm> <performer-clip-dir> [--lang en,ru,zh-CN,es] [--keep]
// Writes steam/trailer/setup-guide-<lang>.mp4 (1920x1080, 60 fps, H.264, AAC),
// scored with the quiet bed from steam/trailer/music.py.
//
// Tracking is real: the performer clip (scripts/render-clip.mjs) is fed in as
// the webcam (?source=file) and the hero follows it. Render it from a model
// with a realistic face (MediaPipe finds no face on the cartoon CC0 avatars);
// the camera preview stays minimised, as in the store screenshots. The hero
// model is served from memory and never copied into the repo; only use a model
// you may show in advertising (see steam/store-page/legal.md).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { launch } from './lib/browser.mjs';
import { startVite } from './lib/vite.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'steam/trailer');
const [heroPath, clipDir] = process.argv.slice(2);
if (!heroPath || !clipDir || clipDir.startsWith('--')) {
  console.error('usage: node scripts/steam-trailer.mjs <hero.vrm> <performer-clip-dir> [--lang en,ru] [--keep]');
  process.exit(2);
}
const li = process.argv.indexOf('--lang');
const LANGS = li > 0 ? process.argv[li + 1].split(',') : ['en', 'ru', 'zh-CN', 'es'];
const KEEP = process.argv.includes('--keep');
const FPS = 60;

const files = {
  '/__local/hero.vrm': readFileSync(heroPath),
  '/__local/clip.webm': readFileSync(join(clipDir, 'clip.webm')),
  '/__trailer/logo.png': readFileSync(join(ROOT, 'steam/capsules/out/library_logo.png')),
  '/__trailer/jersey.ttf': readFileSync(join(ROOT, 'steam/capsules/source/fonts/Jersey10-Regular.ttf')),
};
const TYPES = { vrm: 'application/octet-stream', webm: 'video/webm', png: 'image/png', ttf: 'font/ttf' };

/** On-screen text. Product and UI terms stay as the app shows them in that language. */
const TEXT = {
  en: {
    guide: 'SETUP GUIDE',
    tagline: 'From your avatar to your call or stream in a minute',
    steps: [
      'Import your VRM: click IMPORT .VRM or drop the file on the window',
      'Your webcam tracks your face, body and hands',
      'Look straight ahead and press C to calibrate',
      'Pick the framing and a 3D scene',
      'Play emotes from hotkeys or a gamepad',
      'Press W, then choose “VPuppet Virtual Camera” in Zoom, Meet, Discord or OBS',
    ],
    end1: 'Free demo: every feature for 100 hours',
    end2: 'Wishlist VPuppet on Steam',
  },
  ru: {
    guide: 'КАК НАЧАТЬ',
    tagline: 'От аватара до звонка или стрима за минуту',
    steps: [
      'Импортируйте VRM: нажмите ИМПОРТ .VRM или перетащите файл в окно',
      'Веб-камера отслеживает лицо, тело и руки',
      'Смотрите прямо и нажмите C для калибровки',
      'Выберите кадр и 3D-сцену',
      'Эмоции по горячим клавишам или с геймпада',
      'Нажмите W и выберите «VPuppet Virtual Camera» в Zoom, Meet, Discord или OBS',
    ],
    end1: 'Бесплатная демоверсия: все функции на 100 часов',
    end2: 'Добавьте VPuppet в список желаемого в Steam',
  },
  'zh-CN': {
    guide: '快速上手',
    tagline: '一分钟内，从你的虚拟形象到通话或直播',
    steps: [
      '导入 VRM：点击「导入 .VRM」或把文件拖进窗口',
      '用普通摄像头追踪面部、身体和双手',
      '直视前方，按 C 校准',
      '选择取景和 3D 场景',
      '用快捷键或手柄播放表情动作',
      '按 W，然后在 Zoom、Meet、Discord 或 OBS 中选择“VPuppet Virtual Camera”',
    ],
    end1: '免费试玩版：全部功能，可用 100 小时',
    end2: '在 Steam 上将 VPuppet 加入愿望单',
  },
  es: {
    guide: 'GUÍA DE INICIO',
    tagline: 'De tu avatar a tu llamada o directo en un minuto',
    steps: [
      'Importa tu VRM: pulsa IMPORTAR .VRM o suelta el archivo en la ventana',
      'Tu webcam sigue tu cara, tu cuerpo y tus manos',
      'Mira al frente y pulsa C para calibrar',
      'Elige el encuadre y una escena 3D',
      'Lanza gestos con atajos de teclado o un mando',
      'Pulsa W y elige «VPuppet Virtual Camera» en Zoom, Meet, Discord u OBS',
    ],
    end1: 'Demo gratuita: todas las funciones durante 100 horas',
    end2: 'Añade VPuppet a tu lista de deseados en Steam',
  },
};

/** Injected into the page: caption band and full-screen cards above the app. */
function overlaySetup() {
  const css = `
    @font-face { font-family: Jersey; src: url(/__trailer/jersey.ttf); }
    #tr { position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; }
    #tr .cap { position: absolute; left: 50%; bottom: 72px; transform: translate(-50%, 16px); opacity: 0;
      transition: opacity .35s, transform .35s; display: flex; align-items: stretch; max-width: 1560px;
      background: #0a0a0a; box-shadow: 0 10px 40px rgba(0,0,0,.35); }
    #tr .cap.on { opacity: 1; transform: translate(-50%, 0); }
    #tr .n { font: 64px/1 Jersey, sans-serif; color: #0a0a0a; background: #ff3b00; padding: 10px 26px 4px; display: flex; align-items: center; }
    #tr .t { font: 700 30px/1.25 'JetBrains Mono', 'PingFang SC', 'Hiragino Sans GB', monospace; color: #f2f1ec;
      padding: 18px 30px; display: flex; align-items: center; letter-spacing: -.01em; }
    #tr .card { position: absolute; inset: 0; opacity: 0; transition: opacity .6s; display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 18px;
      background: #f2f1ec; background-image: linear-gradient(#e4e2da 1px, transparent 1px), linear-gradient(90deg, #e4e2da 1px, transparent 1px);
      background-size: 64px 64px; }
    #tr .card.on { opacity: 1; }
    #tr .card img { width: 1100px; }
    #tr .big { font: 120px/1 Jersey, sans-serif; color: #ff3b00; letter-spacing: .02em; }
    #tr .sub { font: 700 36px/1.3 'JetBrains Mono', 'PingFang SC', 'Hiragino Sans GB', monospace; color: #0a0a0a; text-align: center; }
    #tr .sub.o { color: #ff3b00; }`;
  const st = document.createElement('style');
  st.textContent = css;
  document.head.append(st);
  const tr = document.createElement('div');
  tr.id = 'tr';
  tr.innerHTML = `<div class="card" id="tr-title"></div><div class="card" id="tr-end"></div><div class="card" id="tr-wipe"></div>
    <div class="cap"><div class="n"></div><div class="t"></div></div>`;
  document.body.append(tr);
}

const browser = await launch({ extraArgs: ['--use-fake-device-for-media-stream'] });
const vite = await startVite(5193);
mkdirSync(OUT, { recursive: true });

try {
  for (const lang of LANGS) await record(lang);
} finally {
  await browser.close();
  vite.close();
}

async function record(lang) {
  const T = TEXT[lang];
  const tmp = join(tmpdir(), `vpuppet-trailer-${lang}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });

  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.route(
    (u) => u.pathname in files,
    (r) => {
      const p = new URL(r.request().url()).pathname;
      r.fulfill({ body: files[p], contentType: TYPES[p.split('.').pop()] });
    },
  );
  await page.goto(`${vite.url}/?lang=${lang}&home=1&source=file&src=/__local/clip.webm&mirror=1&mode=face`);
  await page.waitForFunction(() => window.__puppet?.home && window.__puppet.source.video, null, { timeout: 30000 });
  await page.evaluate(overlaySetup);
  await page.evaluate(async () => document.fonts.load('64px Jersey'));
  await page.evaluate(
    ({ T }) => {
      document.getElementById('tr-title').innerHTML =
        `<img src="/__trailer/logo.png"><div class="big">${T.guide}</div><div class="sub">${T.tagline}</div>`;
      document.getElementById('tr-end').innerHTML =
        `<img src="/__trailer/logo.png"><div class="sub o">${T.end1}</div><div class="sub">${T.end2}</div>`;
      document.getElementById('tr-title').classList.add('on');
    },
    { T },
  );
  await page.waitForTimeout(1500);

  const wait = (ms) => page.waitForTimeout(ms);
  const key = async (k, ms = 0) => {
    await page.keyboard.press(k);
    if (ms) await wait(ms);
  };
  const mcp = (tool, args = {}) => page.evaluate(([t, a]) => window.__puppet.mcp.call(t, a), [tool, args]);
  const card = (id, on) => page.evaluate(([i, o]) => document.getElementById(i).classList.toggle('on', o), [id, on]);
  const caption = async (i) => {
    await page.evaluate(
      ([n, text]) => {
        const c = document.querySelector('#tr .cap');
        c.classList.remove('on');
        setTimeout(() => {
          c.querySelector('.n').textContent = n;
          c.querySelector('.t').textContent = text;
          c.classList.add('on');
        }, n === '1' ? 0 : 380);
      },
      [String(i + 1), T.steps[i]],
    );
  };
  const hideCaption = () => page.evaluate(() => document.querySelector('#tr .cap').classList.remove('on'));
  const env = (id) =>
    page.evaluate((e) => {
      const p = window.__puppet;
      p.env.set(e, 'high');
      if (p.settings.background.kind !== 'environment') p.env.toggle();
    }, id);
  const frame = (f) => page.evaluate((x) => window.__puppet.frame(x), f);

  // ---- recording: the page's own frames over CDP, written as they arrive.
  const cdp = await ctx.newCDPSession(page);
  const stamps = [];
  const writes = [];
  cdp.on('Page.screencastFrame', (f) => {
    const n = stamps.length;
    stamps.push(f.metadata.timestamp);
    writes.push(Promise.resolve().then(() => writeFileSync(join(tmp, `${String(n).padStart(6, '0')}.jpg`), Buffer.from(f.data, 'base64'))));
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });

  // 0: title card over the empty library.
  await wait(3800);
  await card('tr-title', false);
  await wait(500);

  // 1: import (the file picker is the OS's, so the files arrive as a drop would).
  await caption(0);
  await wait(1200);
  const ids = {};
  for (const [name, url] of [
    ['devil.vrm', '/test-assets/cc0/devil.vrm'],
    ['the-worm.vrm', '/test-assets/cc0/the-worm.vrm'],
    ['hero.vrm', '/__local/hero.vrm'],
  ]) {
    ids[name] = await page.evaluate(
      async ([n, u]) => {
        const lib = window.__puppet.home.library;
        const id = (await lib.import({ name: n, bytes: await (await fetch(u)).arrayBuffer() })).id;
        window.__puppet.home.show(true);
        return id;
      },
      [name, url],
    );
    await wait(900);
  }
  await wait(1200);
  await page.click(`.card[data-id="${ids['hero.vrm']}"]`); // select, then USE MODEL
  await wait(900);
  // A paper wipe covers the load and the one-time notices (caption 1 stays up).
  await card('tr-wipe', true);
  await wait(650);
  await page.click(`.card[data-id="${ids['hero.vrm']}"] [data-act="load"]`);
  await page.waitForFunction(() => window.__puppet.avatar, null, { timeout: 60000 });
  await wait(1200);
  await page.evaluate(() => document.getElementById('btn-lic-notice-ok')?.click()); // the once-per-model licence notice
  await page.evaluate(() => [...document.querySelectorAll('dialog[open] .pm-close')].forEach((b) => b.click()));
  if (await page.evaluate(() => !document.body.classList.contains('no-debug'))) await key('d');
  await key('t'); // the camera card: minimised, as in the screenshots
  await env('room');
  await frame('upper');
  await wait(1500);

  // 2: tracking. The performer's body section starts at 14.6 s.
  await page.evaluate(async () => {
    const v = window.__puppet.source.video;
    v.currentTime = 14.6;
    await new Promise((r) => (v.onseeked = r));
  });
  await page.waitForFunction(() => window.__puppet.lastResult?.face, null, { timeout: 30000 });
  // A neutral baseline before the reveal: without it dark lipstick reads as an
  // open mouth. Step 3 then shows calibrating as the user does it.
  // The rendered performer's black lips also read as a slightly open mouth;
  // steeper curves (FACE window) keep those faint values near zero.
  await page.evaluate(() => {
    const g = window.__puppet.settings.gains;
    for (const n of ['jawOpen', 'mouthFunnel', 'mouthPucker']) g[n] = { gain: 1.2, curve: 2.4 };
  });
  await wait(800);
  await page.evaluate(() => window.__puppet.calibrate());
  await wait(1400);
  await card('tr-wipe', false);
  await caption(1);
  await wait(1800);
  await key('2', 2200);
  await key('3', 5000);

  // 3: calibrate.
  await caption(2);
  await wait(1500);
  await key('c', 3500);

  // 4: framing and scenes.
  await caption(3);
  await wait(600);
  await page.click('#framing [data-value="bust"]');
  await wait(1800);
  await page.click('#framing [data-value="full"]');
  await wait(1800);
  await page.click('#framing [data-value="upper"]');
  await wait(1200);
  for (const e of ['neon', 'forest', 'moor']) {
    await env(e);
    await wait(1700);
  }

  // 5: emotes over live tracking.
  await caption(4);
  await key('k', 1800);
  await key('k', 400);
  await mcp('clip_play', { clip: 'wave' });
  await wait(2600);
  await mcp('clip_play', { clip: 'clap' });
  await wait(2600);

  // 6: go live. The capture view is the picture the virtual camera sends.
  await caption(5);
  await wait(1500);
  if (!(await page.evaluate(() => window.__puppet.lastResult?.face))) throw new Error('no face tracked: is the performer clip a realistic face?');
  await key('h', 5500);
  await hideCaption();
  await wait(300);

  // End card.
  await card('tr-end', true);
  await wait(4200);

  await cdp.send('Page.stopScreencast');
  await Promise.all(writes);
  await ctx.close();

  // Each frame lasts until the next one arrived, then everything is resampled
  // to a constant 60 fps.
  const lines = ['ffconcat version 1.0'];
  for (let i = 0; i < stamps.length; i++) {
    const d = i + 1 < stamps.length ? stamps[i + 1] - stamps[i] : 1 / FPS;
    lines.push(`file '${String(i).padStart(6, '0')}.jpg'`, `duration ${d.toFixed(5)}`);
  }
  writeFileSync(join(tmp, 'list.ffconcat'), lines.join('\n'));
  const out = join(OUT, `setup-guide-${lang}.mp4`);
  const bed = join(tmp, 'bed.wav');
  execFileSync('python3', [join(OUT, 'music.py'), (stamps.at(-1) - stamps[0] + 1 / FPS).toFixed(3), bed]);
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', join(tmp, 'list.ffconcat'),
    '-i', bed,
    '-vf', `fps=${FPS},format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-profile:v', 'high', '-movflags', '+faststart',
    '-c:a', 'aac', '-b:a', '192k', '-shortest',
    out,
  ]);
  if (!KEEP) rmSync(tmp, { recursive: true, force: true });
  console.log(`${out}: ${stamps.length} frames over ${(stamps.at(-1) - stamps[0]).toFixed(1)} s`);
}
