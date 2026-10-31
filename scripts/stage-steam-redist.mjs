// Copy the Steamworks runtime library (from the steamworks-sys crate the
// `steam` feature builds against) into src-tauri/vendor/steam/, where the demo
// bundle (src-tauri/tauri.demo.conf.json) and the SteamPipe depot scripts
// (steam/steampipe/) pick it up. Run by `pnpm tauri:demo`.
//
//   node scripts/stage-steam-redist.mjs
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tauri = join(root, 'src-tauri');
const meta = JSON.parse(
  execFileSync('cargo', ['metadata', '--format-version', '1', '--features', 'steam'], { cwd: tauri, encoding: 'utf8', maxBuffer: 64 << 20 }),
);
const sys = meta.packages.find((p) => p.name === 'steamworks-sys');
if (!sys) throw new Error('steamworks-sys not in the dependency graph (is the `steam` feature declared in src-tauri/Cargo.toml?)');
const bin = join(dirname(sys.manifest_path), 'lib', 'steam', 'redistributable_bin');
const [dir, file] = {
  darwin: ['osx', 'libsteam_api.dylib'],
  win32: ['win64', 'steam_api64.dll'],
  linux: ['linux64', 'libsteam_api.so'],
}[process.platform] ?? [];
if (!file) throw new Error(`no Steam redistributable for ${process.platform}`);
const out = join(tauri, 'vendor', 'steam');
mkdirSync(out, { recursive: true });
copyFileSync(join(bin, dir, file), join(out, file));
console.log(`staged ${file} (steamworks-sys ${sys.version}) -> src-tauri/vendor/steam/`);
