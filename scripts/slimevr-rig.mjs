#!/usr/bin/env node
// Virtual SlimeVR body-tracker rig: a headless SlimeVR-Server fed by fake IMU trackers, with its
// VMC output pointed at a VMC receiver (VPuppet). See docs/slimevr-testing.md.
//
//   node scripts/slimevr-rig.mjs setup [--release]   portable JDK 17 + SlimeVR-Server build
//   node scripts/slimevr-rig.mjs up [options]        start server + trackers (Ctrl-C stops both)
//   node scripts/slimevr-rig.mjs up --detach ...     ...in the background; stop with `down`
//   node scripts/slimevr-rig.mjs down                stop a detached rig
//   node scripts/slimevr-rig.mjs status
//   node scripts/slimevr-rig.mjs fixtures [--seconds 5] [--keep-hz 30] [--motions idle,sit,...]
//                                         [--suffix -x] [--out dir]
//                                                    record scripts/fixtures/slimevr-<motion><suffix>.jsonl
// Options for up / fixtures:
//   --vmc-port <n>   where SlimeVR sends VMC                      [39539]
//   --vmc-host <ip>  ...and to which host                          [127.0.0.1]
//   --vmc-in <n>     SlimeVR's own VMC *input* port (it binds it)  [39540]
//   --motion <seq>   passed to slimevr-fake-trackers.mjs           [idle]
//   --trackers <n>   6 | 8 | 10                                    [6]
//   --mounted        trackers strapped on at an angle (exercises the full reset)
//   --vrm <file>     VRM whose proportions SlimeVR uses for VMC    [test-assets/cc0/devil.vrm]
//   --no-vrm         don't give SlimeVR a VRM (it then sends its own default proportions)
//   --filter <type>  SlimeVR rotation filter: prediction | smoothing | none   [prediction]
//   --anchor-head    VMC "anchor at head" instead of SlimeVR's default "anchor at hip"
// Everything lives in the rig directory: $SLIMEVR_RIG_DIR, or --dir, or ~/.cache/vpuppet-slimevr
//   jdk/  SlimeVR-Server/  gradle-home/  run/ (config, logs)  rig.json (pids of a detached rig)
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TRACKERS } from './lib/slimevr-motion.mjs';
import { fakeMac } from './slimevr-fake-trackers.mjs';
import { capture, summarise, writeJsonl } from './slimevr-capture.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Pinned SlimeVR-Server commit (v21.1.0-9-g83941fd, 2026-09-18) and its release fallback.
export const SLIMEVR_COMMIT = '83941fd38e91cc91ca6b360deab5c2ae986dd1b6';
const SLIMEVR_RELEASE_JAR = 'https://github.com/SlimeVR/SlimeVR-Server/releases/download/v21.1.0/slimevr.jar';
const JDK_FEATURE = 17; // server/desktop/build.gradle.kts: jvmToolchain 17

const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'help';
const flag = (n) => argv.includes(n);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};

const DIR = path.resolve(opt('--dir', process.env.SLIMEVR_RIG_DIR ?? path.join(os.homedir(), '.cache', 'vpuppet-slimevr')));
const P = {
  jdk: path.join(DIR, 'jdk'),
  jdkDownload: path.join(DIR, 'jdk-download'),
  src: path.join(DIR, 'SlimeVR-Server'),
  gradleHome: path.join(DIR, 'gradle-home'),
  releaseJar: path.join(DIR, 'release', 'slimevr.jar'),
  run: path.join(DIR, 'run'),
  state: path.join(DIR, 'rig.json'),
};
P.builtJar = path.join(P.src, 'server', 'desktop', 'build', 'libs', 'slimevr.jar');

const log = (s) => console.log(`[rig] ${s}`);

// ---------------------------------------------------------------- setup

function javaHome() {
  if (!fs.existsSync(P.jdk)) return null;
  for (const d of fs.readdirSync(P.jdk)) {
    for (const home of [path.join(P.jdk, d, 'Contents', 'Home'), path.join(P.jdk, d)]) {
      if (fs.existsSync(path.join(home, 'bin', 'java'))) return home;
    }
  }
  return null;
}

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

async function download(url, file) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
}

async function setupJdk() {
  if (javaHome()) return log(`JDK present: ${javaHome()}`);
  const osName = { darwin: 'mac', linux: 'linux', win32: 'windows' }[process.platform];
  const arch = { arm64: 'aarch64', x64: 'x64' }[process.arch];
  const api = `https://api.adoptium.net/v3/assets/latest/${JDK_FEATURE}/hotspot?architecture=${arch}&image_type=jdk&os=${osName}&vendor=eclipse`;
  const [asset] = await fetchJson(api);
  const pkg = asset.binary.package;
  log(`downloading Eclipse Temurin ${asset.release_name} (${(pkg.size / 1e6).toFixed(0)} MB) from ${pkg.link}`);
  fs.mkdirSync(P.jdkDownload, { recursive: true });
  const tgz = path.join(P.jdkDownload, pkg.name);
  await download(pkg.link, tgz);
  const sha = crypto.createHash('sha256').update(fs.readFileSync(tgz)).digest('hex');
  if (sha !== pkg.checksum) throw new Error(`JDK checksum mismatch: ${sha} != ${pkg.checksum}`);
  log('checksum ok, extracting');
  fs.mkdirSync(P.jdk, { recursive: true });
  execFileSync('tar', ['-xzf', tgz, '-C', P.jdk], { stdio: 'inherit' });
  log(`JDK: ${javaHome()}`);
}

const git = (args, cwd) => execFileSync('git', args, { cwd, stdio: 'inherit' });

function setupSource() {
  if (!fs.existsSync(path.join(P.src, '.git'))) {
    log(`fetching SlimeVR-Server @ ${SLIMEVR_COMMIT.slice(0, 9)}`);
    fs.mkdirSync(P.src, { recursive: true });
    git(['init', '-q'], P.src);
    git(['remote', 'add', 'origin', 'https://github.com/SlimeVR/SlimeVR-Server.git'], P.src);
    git(['fetch', '-q', '--depth', '50', 'origin', SLIMEVR_COMMIT], P.src);
    git(['checkout', '-q', SLIMEVR_COMMIT], P.src);
  } else {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: P.src }).toString().trim();
    if (head !== SLIMEVR_COMMIT) log(`note: SlimeVR-Server is at ${head.slice(0, 9)}, pinned is ${SLIMEVR_COMMIT.slice(0, 9)}`);
  }
  git(['submodule', 'update', '--init', '--depth', '1', 'solarxr-protocol'], P.src);
}

function build() {
  const home = javaHome();
  log('building SlimeVR-Server (gradle :server:desktop:shadowJar, a few minutes the first time)');
  const r = spawnSync(
    path.join(P.src, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew'),
    ['--no-daemon', `-Dorg.gradle.java.installations.paths=${home}`, ':server:desktop:shadowJar'],
    { cwd: P.src, stdio: 'inherit', env: { ...process.env, JAVA_HOME: home, GRADLE_USER_HOME: P.gradleHome } },
  );
  if (r.status !== 0) throw new Error('SlimeVR build failed');
  log(`built ${P.builtJar}`);
}

async function setup() {
  fs.mkdirSync(DIR, { recursive: true });
  await setupJdk();
  if (flag('--release')) {
    if (!fs.existsSync(P.releaseJar)) {
      fs.mkdirSync(path.dirname(P.releaseJar), { recursive: true });
      log(`downloading ${SLIMEVR_RELEASE_JAR}`);
      await download(SLIMEVR_RELEASE_JAR, P.releaseJar);
    }
    return log(`release jar: ${P.releaseJar}`);
  }
  setupSource();
  if (!fs.existsSync(P.builtJar) || flag('--rebuild')) build();
  else log(`jar present: ${P.builtJar} (--rebuild to rebuild)`);
}

// ---------------------------------------------------------------- config

/** The JSON chunk of a .vrm (glTF binary): what SlimeVR's GUI hands the server as vmc.vrmJson. */
export function vrmJson(file) {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'glTF') throw new Error(`${file} is not a binary glTF/VRM`);
  const len = b.readUInt32LE(12);
  if (b.toString('ascii', 16, 20) !== 'JSON') throw new Error(`${file}: first chunk is not JSON`);
  return b.toString('utf8', 20, 20 + len).replace(/[\s\0]+$/, '');
}

function rigOptions() {
  const vrm = flag('--no-vrm') ? null : path.resolve(opt('--vrm', path.join(REPO, 'test-assets', 'cc0', 'devil.vrm')));
  return {
    vmcPort: Number(opt('--vmc-port', 39539)),
    vmcHost: opt('--vmc-host', '127.0.0.1'),
    vmcIn: Number(opt('--vmc-in', 39540)),
    motion: opt('--motion', 'idle'),
    trackers: Number(opt('--trackers', 6)),
    mounted: flag('--mounted'),
    vrm,
    filter: opt('--filter', 'prediction'),
    anchorHip: !flag('--anchor-head'),
  };
}

/**
 * vrconfig.yml. YAML is a superset of JSON, so we write JSON. Only the fields we care about;
 * SlimeVR fills in defaults for the rest (and rewrites the file in its own YAML on save).
 */
function writeConfig(o) {
  fs.rmSync(P.run, { recursive: true, force: true });
  // A `config/` folder in the working directory makes SlimeVR use ./vrconfig.yml instead of
  // ~/Library/Application Support/dev.slimevr.SlimeVR (desktop Main.kt resolveConfig()).
  fs.mkdirSync(path.join(P.run, 'config'), { recursive: true });
  const trackers = {};
  const knownDevices = [];
  TRACKERS.slice(0, o.trackers).forEach((t, i) => {
    const mac = fakeMac(i);
    knownDevices.push(mac);
    trackers[`udp://${mac}/0`] = {
      designation: t.designation,
      customName: `fake ${t.key}`,
      // Identity mounting: the fake IMU's axes line up with the body part (the default,
      // 180 deg "back" mounting, would mirror the motion front/back).
      mountingOrientation: { w: 1, x: 0, y: 0, z: 0 },
      allowDriftCompensation: false,
    };
  });
  const cfg = {
    vmc: {
      enabled: true,
      portIn: o.vmcIn,
      portOut: o.vmcPort,
      address: o.vmcHost,
      anchorHip: o.anchorHip,
      mirrorTracking: false,
      ...(o.vrm ? { vrmJson: vrmJson(o.vrm) } : {}),
    },
    filters: { type: o.filter, amount: 0.2 },
    resetsConfig: { fullResetDelay: 0, yawResetDelay: 0, mountingResetDelay: 0 },
    trackers,
    knownDevices,
  };
  fs.writeFileSync(path.join(P.run, 'vrconfig.yml'), JSON.stringify(cfg, null, 1));
}

// ---------------------------------------------------------------- processes

function jarPath() {
  if (fs.existsSync(P.builtJar)) return P.builtJar;
  if (fs.existsSync(P.releaseJar)) return P.releaseJar;
  throw new Error(`no SlimeVR jar in ${DIR}: run \`node scripts/slimevr-rig.mjs setup\` first`);
}

function udpFree(port) {
  return new Promise((res) => {
    const s = dgram.createSocket('udp4');
    s.once('error', () => res(false));
    s.bind(port, () => s.close(() => res(true)));
  });
}
function tcpFree(port) {
  return new Promise((res) => {
    const s = net.createServer();
    s.once('error', () => res(false));
    s.listen(port, () => s.close(() => res(true)));
  });
}

async function preflight(o) {
  const busy = [];
  if (!(await udpFree(6969))) busy.push('UDP 6969 (SlimeVR trackers)');
  if (!(await tcpFree(21110))) busy.push('TCP 21110 (SlimeVR WebSocket)');
  if (!(await udpFree(o.vmcIn))) busy.push(`UDP ${o.vmcIn} (SlimeVR VMC input, --vmc-in)`);
  if (busy.length) throw new Error(`ports busy: ${busy.join(', ')} — is another SlimeVR (or the rig: \`down\`) running?`);
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function waitFor(file, re, ms) {
  const end = Date.now() + ms;
  return new Promise((res, rej) => {
    const t = setInterval(() => {
      const s = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      if (re.test(s)) {
        clearInterval(t);
        res();
      } else if (Date.now() > end) {
        clearInterval(t);
        rej(new Error(`timed out waiting for ${re} in ${file}`));
      }
    }, 200);
  });
}

function startServer(o, detached) {
  const home = javaHome();
  if (!home) throw new Error('no JDK: run `node scripts/slimevr-rig.mjs setup` first');
  const out = fs.openSync(path.join(P.run, 'server.log'), 'a');
  const child = spawn(path.join(home, 'bin', 'java'), ['-Djava.awt.headless=true', '-jar', jarPath(), 'run'], {
    cwd: P.run,
    // HOME -> run dir keeps SlimeVR's log folder (~/Library/Logs/...) inside the rig too.
    env: { ...process.env, JAVA_HOME: home, HOME: P.run },
    stdio: ['pipe', out, out],
    detached,
  });
  return child;
}

function startTrackers(o, motion, detached, extra = []) {
  const args = [path.join(REPO, 'scripts', 'slimevr-fake-trackers.mjs'), '--motion', motion, '--trackers', String(o.trackers)];
  if (o.mounted) args.push('--mounted');
  const out = detached ? fs.openSync(path.join(P.run, 'trackers.log'), 'a') : 'inherit';
  return spawn(process.execPath, [...args, ...extra], { stdio: ['pipe', detached ? out : 'pipe', out], detached });
}

function killTree(pid, sig = 'SIGTERM') {
  try {
    process.kill(-pid, sig); // detached children lead their own process group
  } catch {
    try {
      process.kill(pid, sig);
    } catch {}
  }
}

async function stopPid(pid, name) {
  if (!pid || !alive(pid)) return;
  killTree(pid);
  for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  if (alive(pid)) killTree(pid, 'SIGKILL');
  log(`stopped ${name} (${pid})`);
}

async function bringUpServer(o, detached) {
  await preflight(o);
  writeConfig(o);
  const server = startServer(o, detached);
  log(`SlimeVR server pid ${server.pid}, log ${path.join(P.run, 'server.log')}`);
  await waitFor(path.join(P.run, 'server.log'), /Starting the tracker server|\[VMCHandler\] Sending to port/, 60000);
  await waitFor(path.join(P.run, 'server.log'), /\[VMCHandler\] Sending to port/, 20000);
  return server;
}

function banner(o) {
  log(`VMC -> ${o.vmcHost}:${o.vmcPort}   (VPuppet: enable VMC input on port ${o.vmcPort})`);
  log(`trackers: ${o.trackers}${o.mounted ? ' (mounted)' : ''}, motion: ${o.motion}, filter: ${o.filter}, VRM: ${o.vrm ?? 'none'}`);
}

async function up() {
  const o = rigOptions();
  const detached = flag('--detach');
  if (fs.existsSync(P.state)) {
    const s = JSON.parse(fs.readFileSync(P.state, 'utf8'));
    if (alive(s.server) || alive(s.trackers)) throw new Error('a detached rig is already running: `node scripts/slimevr-rig.mjs down`');
    fs.rmSync(P.state);
  }
  const server = await bringUpServer(o, detached);
  const trackers = startTrackers(o, o.motion, detached);
  if (detached) {
    server.unref();
    trackers.unref();
    server.stdin.destroy();
    trackers.stdin.destroy();
    fs.writeFileSync(P.state, JSON.stringify({ server: server.pid, trackers: trackers.pid, options: o }, null, 1));
    banner(o);
    log(`detached; logs in ${P.run}; stop with: node scripts/slimevr-rig.mjs down`);
    return;
  }
  trackers.stdout.on('data', (d) => process.stdout.write(d));
  process.stdin.on('data', (d) => trackers.stdin.write(d)); // motion names / "reset"
  banner(o);
  log('type a motion name (idle, sit, walk, lean, squat) or "reset" + Enter; Ctrl-C to stop');
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await stopPid(trackers.pid, 'trackers');
    await stopPid(server.pid, 'server');
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  server.on('exit', (c) => {
    log(`server exited (${c})`);
    stop();
  });
}

async function down() {
  if (!fs.existsSync(P.state)) return log('no detached rig running');
  const s = JSON.parse(fs.readFileSync(P.state, 'utf8'));
  await stopPid(s.trackers, 'trackers');
  await stopPid(s.server, 'server');
  fs.rmSync(P.state);
}

function status() {
  if (!fs.existsSync(P.state)) return log('no detached rig running');
  const s = JSON.parse(fs.readFileSync(P.state, 'utf8'));
  log(`server ${s.server} ${alive(s.server) ? 'running' : 'dead'}, trackers ${s.trackers} ${alive(s.trackers) ? 'running' : 'dead'}`);
  log(`VMC -> ${s.options.vmcHost}:${s.options.vmcPort}`);
}

/** Record a few seconds of SlimeVR's VMC output per motion into scripts/fixtures/. */
async function fixtures() {
  const o = rigOptions();
  if (o.vmcHost !== '127.0.0.1') throw new Error('fixtures captures locally: leave --vmc-host at 127.0.0.1');
  const seconds = Number(opt('--seconds', 5));
  const keepHz = Number(opt('--keep-hz', 30));
  const suffix = opt('--suffix', '');
  const motions = opt('--motions', 'idle,sit,walk,lean,squat').split(',');
  const outDir = path.resolve(opt('--out', path.join(REPO, 'scripts', 'fixtures')));
  fs.mkdirSync(outDir, { recursive: true });
  if (!(await udpFree(o.vmcPort))) throw new Error(`UDP ${o.vmcPort} is busy (VPuppet running?): close it or pass --vmc-port`);
  const server = await bringUpServer(o, false);
  const version = (fs.readFileSync(path.join(P.run, 'server.log'), 'utf8').match(/Running version (\S+)/) ?? [])[1];
  try {
    for (const motion of motions) {
      const tr = startTrackers(o, motion, false, ['--duration', String(seconds + 10)]);
      let out = '';
      await new Promise((res, rej) => {
        const to = setTimeout(() => rej(new Error(`trackers never started "${motion}":\n${out}`)), 20000);
        tr.stdout.on('data', (d) => {
          out += d;
          if (/^motion: /m.test(out)) {
            clearTimeout(to);
            res();
          }
        });
      });
      const result = await capture({
        port: o.vmcPort,
        seconds,
        keepHz,
        meta: {
          source: 'SlimeVR-Server (headless) fed by scripts/slimevr-fake-trackers.mjs',
          slimevrVersion: version,
          slimevrCommit: SLIMEVR_COMMIT,
          motion,
          motionStartsAt: 0,
          trackers: TRACKERS.slice(0, o.trackers).map((t) => t.designation),
          mounted: o.mounted,
          vrm: o.vrm ? path.relative(REPO, o.vrm) : null,
          filter: o.filter,
          anchorHip: o.anchorHip,
        },
      });
      await stopPid(tr.pid, `trackers (${motion})`);
      const file = path.join(outDir, `slimevr-${motion}${suffix}.jsonl`);
      writeJsonl(file, result);
      log(`${motion}: ${result.lines.length} messages -> ${file.startsWith(REPO) ? path.relative(REPO, file) : file}`);
      console.log(summarise(result));
    }
  } finally {
    await stopPid(server.pid, 'server');
  }
}

const commands = { setup, up, down, status, fixtures };
if (!commands[cmd]) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\nimport ')[0]);
  process.exit(cmd === 'help' || cmd === '--help' ? 0 : 1);
}
Promise.resolve().then(commands[cmd]).catch((e) => {
  console.error(`[rig] ${e.message}`);
  process.exit(1);
});
