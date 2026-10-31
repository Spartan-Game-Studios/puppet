# SteamPipe build scripts (TEMPLATES)

**These are templates. They have not been run against Steam.** Fill in the IDs, check every path against the actual build output (the binary and bundle names change with the Puppet → VPuppet rename), and do a `"Preview" "1"` dry run before the first real upload.

| File | Uploads |
|---|---|
| `app_build_full.vdf` | the full app `<FULL_APP_ID>`: its three depots |
| `app_build_demo.vdf` | the demo app `<DEMO_APP_ID>`: its three depots |
| `depot_build_{full,demo}_windows.vdf` | `vpuppet.exe`, `softcam.dll` (+ licence); the demo also `steam_api64.dll` |
| `depot_build_{full,demo}_macos.vdf` | the signed, notarized `VPuppet.app` |
| `depot_build_{full,demo}_linux.vdf` | `VPuppet.AppImage` (staged under a fixed name); the demo also `libsteam_api.so` |
| `.gitignore` | keeps `output/` (SteamPipe logs/cache) and `staging/` out of git |

All paths are relative to this folder; `ContentRoot` is `../../`, the repo root.

## 1. Build

The full and demo builds go into **separate Cargo target folders** so one can never be uploaded as the other: the full build uses the normal `src-tauri/target/`, the demo build `src-tauri/target-demo/` (the demo depot scripts point there). Tauri honours `CARGO_TARGET_DIR`.

```sh
# full version (on each OS)
pnpm tauri build

# demo: cargo features demo + steam, the Steamworks library staged into
# src-tauri/vendor/steam/ and bundled (tauri.demo.conf.json), own target folder.
# VPUPPET_STEAM_APP_ID is the FULL app's ID: the demo's BUY button opens its store page.
CARGO_TARGET_DIR=src-tauri/target-demo VPUPPET_STEAM_APP_ID=<FULL_APP_ID> pnpm tauri:demo
```

The frontend asks the Rust side (`demo_status`), so the cargo feature is the only switch. The full build has no Steamworks dependency and ships no Steam library.

macOS: sign, notarize and staple as in `docs/virtual-camera.md#macos-signing` (the signed build uses `--config src-tauri/macos/build/tauri.signed.conf.json`). Verify before uploading:

```sh
codesign --verify --deep --strict --verbose=2 src-tauri/target/release/bundle/macos/VPuppet.app
spctl -a -vv src-tauri/target/release/bundle/macos/VPuppet.app
xcrun stapler validate src-tauri/target/release/bundle/macos/VPuppet.app
```

Linux: stage the AppImage under a fixed name (the commands are at the top of `depot_build_*_linux.vdf`).

## 2. Collect the artefacts on one machine

An app build uploads every depot it lists, so all three OS outputs must be under the repo on the machine that runs steamcmd (copy the Windows and Linux outputs into the same `src-tauri/target*/` paths, e.g. from CI artefacts). Uploading per OS (one depot per app build file, run on each OS) is possible, but check in Valve's SteamPipe documentation how a build that omits a depot is combined before relying on it: you don't want a release where one OS's depot is missing or stale. Simplest is one machine, one upload, all three depots.

## 3. Upload

Install steamcmd (Steamworks SDK `tools/ContentBuilder/builder*/`, or the standalone download). Use a Steam account that has the Steamworks "Edit App Metadata" and "Publish App Changes To Steam" permissions for both apps; Steam Guard will ask for a code the first time.

```sh
steamcmd +login <steam_build_account> \
  +run_app_build "$PWD/steam/steampipe/app_build_full.vdf" \
  +quit

steamcmd +login <steam_build_account> \
  +run_app_build "$PWD/steam/steampipe/app_build_demo.vdf" \
  +quit
```

- Pass **absolute paths** to `+run_app_build`.
- `"Preview" "1"` in the app build file does a dry run: it scans the files and writes the manifest and log to `output/` without uploading. Check the file list in the log before the first real upload.
- The build appears in Steamworks → SteamPipe → Builds. Set it live on a `beta` branch (or `"SetLive" "beta"` in the file), install it through the Steam client on each OS, run it, then set it live on `default`.
- Before release, each app's first build also has to pass Valve's build review (see `../README.md`).

## 4. Steamworks settings these scripts assume

- Depot OS filters: each depot set to its OS (Windows 64-bit / macOS / Linux) under SteamPipe → Depots.
- Launch options (Installation → General), one per OS:
  - Windows: executable `vpuppet.exe`
  - macOS: executable `VPuppet.app`
  - Linux: executable `VPuppet.AppImage`, with the environment variable `APPIMAGE_EXTRACT_AND_RUN=1` if FUSE isn't available in Steam's runtime (test this)
- Never ship `steam_appid.txt` (excluded in every depot script); it is for development runs outside Steam only.

## Open questions to settle before the first upload

- **Exact binary name** after the rename (`vpuppet.exe`? check `src-tauri/target/release/`).
- **Linux: does the AppImage find `libsteam_api.so`** next to it? The binary links it by name; inside an AppImage the loader may not look beside the image. Test, or ship the extracted tree.
- **Universal or Apple-silicon-only Mac build.** The current local build is `aarch64` only.
- **WebView2 on Windows**: Steam does not run Tauri's installer, so the WebView2 bootstrapper isn't run. Add an install script or an in-app check.
- **Linux packaging**: AppImage (self-contained, FUSE question) vs. the extracted `.deb` tree (needs the system's WebKitGTK 4.1). Test the AppImage under the Steam client's runtime first.
