// Virtual camera end-to-end test of the DESKTOP app, without any camera:
// runs a built Puppet binary with the file sink (PUPPET_VCAM_SINK=file:...),
// a model and debuglog, and reports what arrived in Rust (size, pixel format,
// rate, drops) plus per-frame costs and the CPU used by the app and its
// WebKit processes, with the output on and off.
//
//   PUPPET_MODEL=/abs/avatar.vrm PUPPET_CLIP=/abs/clip.mp4 node scripts/vcam-desktop-test.mjs <path/to/puppet binary> [outdir] [1280x720|1920x1080] [seconds]
//
// The binary is e.g. src-tauri/target/release/bundle/macos/Puppet.app/Contents/MacOS/puppet
// (`pnpm tauri build --bundles app`). It opens the app window; set
// PUPPET_LAUNCH_PREFIX (e.g. "private-run --mode offscreen --") to wrap it.
// Settings go to a temporary dir (PUPPET_SETTINGS_DIR), never your own.
// Tracking runs on the clip (?source=file; render one with render-clip.mjs),
// so the webcam is never opened.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requireEnv } from './lib/browser.mjs';

const model = requireEnv('PUPPET_MODEL');
const clip = requireEnv('PUPPET_CLIP');
const bin = process.argv[2] ?? requireEnv('PUPPET_BIN');
const outDir = process.argv[3] ?? (await mkdtemp(join(tmpdir(), 'puppet-vcam-')));
const res = process.argv[4] ?? '1280x720';
const seconds = Number(process.argv[5] ?? 20);
const [W, H] = res.split('x').map(Number);
const prefix = (process.env.PUPPET_LAUNCH_PREFIX ?? '').split(' ').filter(Boolean);

/** Accumulated CPU seconds of a set of pids (ps cputime). */
function cpuSeconds(pids) {
  if (!pids.length) return 0;
  let out = '';
  try {
    out = execFileSync('ps', ['-o', 'cputime=', '-p', pids.join(',')], { encoding: 'utf8' });
  } catch {
    return 0;
  }
  return out
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const p = l.trim().split(':').map(Number);
      return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
    })
    .reduce((a, b) => a + b, 0);
}

function webkitPids() {
  const out = execFileSync('ps', ['-axo', 'pid=,comm='], { encoding: 'utf8' });
  return new Set(
    out
      .split('\n')
      .filter((l) => /com\.apple\.WebKit\.(WebContent|GPU|Networking)/.test(l))
      .map((l) => Number(l.trim().split(/\s+/)[0])),
  );
}

async function run(vcamOn, extra = {}, sinkSpec = null) {
  const settingsDir = await mkdtemp(join(tmpdir(), 'puppet-settings-'));
  const sinkPath = join(outDir, `frames-${res}-${vcamOn ? 'on' : 'off'}.yuyv`);
  const query = new URLSearchParams({ model, source: 'file', src: clip, mode: 'face', debuglog: '1', vcam: vcamOn ? '1' : '0', vcamres: res, capture: '1', ...extra });
  const before = webkitPids();
  const env = {
    ...process.env,
    PUPPET_QUERY: query.toString(),
    PUPPET_VCAM_SINK: sinkSpec ?? `file:${sinkPath}?max=60`,
    PUPPET_SETTINGS_DIR: settingsDir,
  };
  const argv = [...prefix, bin];
  const child = spawn(argv[0], argv.slice(1), { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = [];
  child.stdout.on('data', (d) => lines.push(...d.toString().split('\n').filter((l) => l.startsWith('[puppet]'))));
  child.stderr.on('data', () => {});
  // Warm-up: model load, first frames.
  await new Promise((r) => setTimeout(r, 8000));
  const appPid = Number(execFileSync('pgrep', ['-n', '-f', bin], { encoding: 'utf8' }).trim());
  const wk = [...webkitPids()].filter((p) => !before.has(p));
  const pids = [appPid, ...wk];
  const c0 = cpuSeconds(pids);
  const appC0 = cpuSeconds([appPid]);
  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, seconds * 1000));
  const c1 = cpuSeconds(pids);
  const appC1 = cpuSeconds([appPid]);
  const elapsed = (Date.now() - t0) / 1000;
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 1000));
  if (child.exitCode === null) child.kill('SIGKILL');
  await rm(settingsDir, { recursive: true, force: true });
  let summary = null;
  try {
    summary = JSON.parse(await readFile(`${sinkPath}.json`, 'utf8'));
  } catch {
    /* off run: no file */
  }
  let fileBytes = 0;
  try {
    fileBytes = (await stat(sinkPath)).size;
  } catch {
    /* none */
  }
  return {
    vcamOn,
    cpuPct: (100 * (c1 - c0)) / elapsed,
    appCpuPct: (100 * (appC1 - appC0)) / elapsed,
    webkitProcs: wk.length,
    summary,
    fileBytes,
    last: lines.at(-1) ?? '(no debuglog line)',
  };
}

let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
  if (!ok) failures++;
};

const off = await run(false);
const on = await run(true);
// Break the cost down: grab only (no IPC), and grab + IPC into a null sink.
const grabOnly = process.env.PUPPET_BREAKDOWN ? await run(true, { vcamsend: '0' }) : null;
const ipcNull = process.env.PUPPET_BREAKDOWN ? await run(true, {}, 'null') : null;
console.log(`\n== desktop app, ${res}, ${seconds} s measured per run`);
console.log(`last debuglog line (on):\n  ${on.last}`);
const s = on.summary;
check(!!s, 'file sink wrote a summary');
if (s) {
  check(s.width === W && s.height === H, `frames are ${s.width}x${s.height}`);
  check(s.format === 'YUYV' && s.bytes_per_frame === W * H * 2, `pixel format ${s.format}, ${s.bytes_per_frame} bytes/frame`);
  check(on.fileBytes === s.stored * s.bytes_per_frame, `file holds ${s.stored} whole frames (${on.fileBytes} bytes)`);
  check(s.fps > 27 && s.fps < 33, `rate ${s.fps.toFixed(2)} fps over ${s.elapsed_s.toFixed(1)} s (${s.frames} frames, seq gaps ${s.seq_gaps}, interval ${s.min_interval_ms.toFixed(1)}-${s.max_interval_ms.toFixed(1)} ms)`);
  console.log(`   YUYV conversion ${s.convert_ms.toFixed(2)} ms/frame (Rust writer thread)`);
}
console.log(`CPU (app + its WebKit processes): off ${off.cpuPct.toFixed(1)}%  on ${on.cpuPct.toFixed(1)}%  => +${(on.cpuPct - off.cpuPct).toFixed(1)}% of one core`);
if (grabOnly) {
  console.log(`  breakdown: grab only (no IPC) ${grabOnly.cpuPct.toFixed(1)}%  | grab + IPC, null sink ${ipcNull.cpuPct.toFixed(1)}% (app ${ipcNull.appCpuPct.toFixed(1)}%)  | full file sink ${on.cpuPct.toFixed(1)}%`);
  console.log(`  ${ipcNull.last}`);
}
console.log(`CPU (app process only):           off ${off.appCpuPct.toFixed(1)}%  on ${on.appCpuPct.toFixed(1)}%`);
console.log(`=> about ${((10 * (on.cpuPct - off.cpuPct)) / 30).toFixed(2)} ms of CPU per frame at 30 fps`);
console.log(`files in ${outDir}`);
process.exit(failures ? 1 : 0);
