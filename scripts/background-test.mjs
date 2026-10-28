// Does Puppet keep tracking, rendering and sending (virtual camera + VMC)
// while its window is hidden, minimized or covered? Runs a built desktop
// binary on a clip (no webcam), with the virtual camera going into the file
// sink and VMC into a local UDP listener, and reports the rates per phase.
//
//   PUPPET_MODEL=/abs/avatar.vrm PUPPET_CLIP=/abs/clip.mp4 \
//     node scripts/background-test.mjs <path/to/puppet binary> [hide|offscreen] [seconds]
//
// hide       the whole run goes through `private-run` (default mode): the app
//            is hidden as soon as it starts, the worst case (no window on any
//            screen; WebKit stops requestAnimationFrame).
// offscreen  `private-run --mode offscreen`: the window keeps drawing, off
//            every screen. A control run.
//
// Prints the app's debuglog lines (render / track fps, vcam stats) and, per
// 2 s window, the VMC datagrams received and the frames the file sink wrote.
// Exits non-zero when any rate after warm-up falls below half of nominal.
// PUPPET_EXTRA_QUERY adds URL parameters (e.g. bgloop=0 to turn the
// frontend's background loop off and see the native half alone).
// Settings go to a temporary dir (PUPPET_SETTINGS_DIR), never your own.
import { execFileSync, spawn } from 'node:child_process';
import dgram from 'node:dgram';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requireEnv } from './lib/browser.mjs';

const model = requireEnv('PUPPET_MODEL');
const clip = requireEnv('PUPPET_CLIP');
const bin = process.argv[2] ?? requireEnv('PUPPET_BIN');
const mode = process.argv[3] ?? 'hide';
const seconds = Number(process.argv[4] ?? 30);
const warmup = 10;
const vmcPort = 39500 + Math.floor(Math.random() * 400);

const dir = await mkdtemp(join(tmpdir(), 'puppet-bg-'));
const sink = join(dir, 'frames.bgra');
await writeFile(join(dir, 'settings.json'), JSON.stringify({ vmc: { enabled: true, host: '127.0.0.1', port: vmcPort, presets: true } }));

let vmc = 0;
const sock = dgram.createSocket('udp4');
sock.on('message', () => vmc++);
await new Promise((r) => sock.bind(vmcPort, '127.0.0.1', r));

const query = new URLSearchParams({ model, source: 'file', src: clip, mode: 'face', debuglog: '1', vcam: '1', vmc: '1', capture: '1', ...Object.fromEntries(new URLSearchParams(process.env.PUPPET_EXTRA_QUERY ?? '')) });
const env = { ...process.env, PUPPET_QUERY: query.toString(), PUPPET_VCAM_SINK: `file:${sink}?max=1`, PUPPET_SETTINGS_DIR: dir };
const argv = ['private-run', ...(mode === 'offscreen' ? ['--mode', 'offscreen'] : []), '--', bin];
const child = spawn(argv[0], argv.slice(1), { env, stdio: ['ignore', 'pipe', 'pipe'] });
const t0 = Date.now();
const el = () => ((Date.now() - t0) / 1000).toFixed(0).padStart(3);
child.stdout.on('data', (d) => {
  for (const l of d.toString().split('\n')) {
    const m = /^\[puppet\] render (\d+)fps.*?\| (vcam [^|]*?)(?: \|| ).*?face (\d+)fps/.exec(l);
    if (m) console.log(`${el()}s  render ${m[1]} fps  face ${m[3]} fps  ${m[2].replace(/ render .*/, '')}`);
  }
});
child.stderr.on('data', () => {});

const samples = [];
let lastVmc = 0;
let lastFrames = 0;
for (let t = 2; t <= seconds; t += 2) {
  await new Promise((r) => setTimeout(r, 2000));
  let frames = lastFrames;
  try {
    frames = JSON.parse(await readFile(`${sink}.json`, 'utf8')).frames;
  } catch {
    /* not yet */
  }
  const s = { t, vmc: (vmc - lastVmc) / 2, vcam: (frames - lastFrames) / 2 };
  lastVmc = vmc;
  lastFrames = frames;
  samples.push(s);
  console.log(`${el()}s  [listener] vmc ${s.vmc.toFixed(0)} msg/s  vcam sink ${s.vcam.toFixed(1)} fps`);
}
child.kill('SIGTERM');
await new Promise((r) => setTimeout(r, 1000));
if (child.exitCode === null) child.kill('SIGKILL');
try {
  execFileSync('pkill', ['-f', bin]); // private-run may leave the app behind
} catch {
  /* already gone */
}
sock.close();
await rm(dir, { recursive: true, force: true });

const after = samples.filter((s) => s.t > warmup);
const mean = (k) => after.reduce((a, s) => a + s[k], 0) / Math.max(1, after.length);
const minOf = (k) => Math.min(...after.map((s) => s[k]));
console.log(`\n== ${mode}: after ${warmup} s warm-up, vcam sink mean ${mean('vcam').toFixed(1)} fps (min ${minOf('vcam').toFixed(1)}), vmc mean ${mean('vmc').toFixed(0)} msg/s (min ${minOf('vmc').toFixed(0)})`);
const ok = minOf('vcam') >= 15 && minOf('vmc') > 0;
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
