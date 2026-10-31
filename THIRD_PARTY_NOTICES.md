# Third-party notices

VPuppet is MIT licensed. It uses the components below. Every direct dependency
is under a permissive licence; transitive notes are at the end.

## Shipped in the app (frontend)

| Component | Version | Licence | Notes |
|---|---|---|---|
| [three.js](https://github.com/mrdoob/three.js) | 0.186.1 | MIT | rendering; also from `three/examples/jsm`: `GLTFLoader`, `OrbitControls`, `FBXLoader` (animation clip import; uses three's bundled `fflate`, MIT), and for 3D environments `HDRLoader`, `EXRLoader` (with its bundled `fflate`, MIT), `LightProbeGenerator`, `BufferGeometryUtils`, `FullScreenQuad` (`postprocessing/Pass.js`) |
| [@pixiv/three-vrm](https://github.com/pixiv/three-vrm) (+ `three-vrm-core`, `-springbone`, `-materials-mtoon`, `-materials-v0compat`, `-materials-hdr-emissive-multiplier`, `-node-constraint`, `types-*`) | 3.5.5 | MIT | VRM 0.x / 1.0 loading, humanoid, expressions, lookAt, spring bones |
| [@mediapipe/tasks-vision](https://www.npmjs.com/package/@mediapipe/tasks-vision) | 1.1.0 | Apache-2.0 | Face / Pose / Hand landmarkers, WASM runtime (copied from the package at build time) |
| MediaPipe models: `face_landmarker.task`, `pose_landmarker_lite.task`, `pose_landmarker_full.task`, `hand_landmarker.task` | float16 v1 | Apache-2.0 | downloaded at build time from `storage.googleapis.com/mediapipe-models/`, SHA-256 pinned in `scripts/fetch-models.mjs`; not stored in git |
| [@tauri-apps/api](https://github.com/tauri-apps/tauri) | 2.x | Apache-2.0 OR MIT | |
| [@tauri-apps/plugin-dialog](https://github.com/tauri-apps/plugins-workspace) | 2.x | MIT OR Apache-2.0 | |
| [@tauri-apps/plugin-global-shortcut](https://github.com/tauri-apps/plugins-workspace) | 2.x | MIT OR Apache-2.0 | system-wide hotkeys |
| [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) via [@fontsource/jetbrains-mono](https://fontsource.org/fonts/jetbrains-mono) | 5.x | SIL OFL 1.1 (font) | bundled font files |

## Shipped in the app (Rust shell)

| Crate | Licence |
|---|---|
| [tauri](https://crates.io/crates/tauri), tauri-build | Apache-2.0 OR MIT |
| [tauri-plugin-dialog](https://crates.io/crates/tauri-plugin-dialog) | Apache-2.0 OR MIT |
| [tauri-plugin-global-shortcut](https://crates.io/crates/tauri-plugin-global-shortcut) and its [global-hotkey](https://crates.io/crates/global-hotkey) | Apache-2.0 OR MIT |
| [rosc](https://crates.io/crates/rosc) | MIT OR Apache-2.0 |
| [serde](https://crates.io/crates/serde), serde_json | MIT OR Apache-2.0 |
| [webkit2gtk](https://crates.io/crates/webkit2gtk) (Linux only) | MIT |
| [libc](https://crates.io/crates/libc) (Linux only: V4L2 ioctls for the virtual camera) | MIT OR Apache-2.0 |
| [libloading](https://crates.io/crates/libloading) (Windows only: loads softcam.dll) | ISC |
| [cc](https://crates.io/crates/cc) (build time, macOS: compiles the Objective-C camera bridge) | MIT OR Apache-2.0 |

## Shipped in the app (virtual camera)

| Component | Version | Licence | Notes |
|---|---|---|---|
| [softcam](https://github.com/tshino/softcam) | v1.8.1 (`afb424c`) | MIT, Copyright (c) 2020 tshino | Windows only. Built by `scripts/build-softcam.ps1` from the pinned commit, with VPuppet's own filter name, CLSID and shared-memory names patched in; shipped as `softcam.dll` with its licence as `LICENSE-softcam.txt`. Loaded at runtime, not linked. |
| DirectShow Base Classes (part of softcam, from [Windows-classic-samples](https://github.com/microsoft/Windows-classic-samples)) | as in softcam | MIT, Copyright (c) Microsoft Corporation | compiled into `softcam.dll` |
| VPuppet camera extension (`src-tauri/macos/camera-extension/`) and bridge (`src-tauri/macos/bridge/`) | | MIT (VPuppet's own code) | macOS only; uses Apple system frameworks (CoreMediaIO, CoreMedia, CoreVideo, Accelerate, SystemExtensions) |

Linux uses the user-installed [v4l2loopback](https://github.com/umlaeute/v4l2loopback) kernel module (GPL-2.0) only through the standard V4L2 device interface (`open`, `ioctl`, `write` on `/dev/videoN`). No v4l2loopback code is linked into or shipped with VPuppet.

Transitive Rust dependencies (about 250 crates, pulled in by Tauri) are almost
all MIT / Apache-2.0 / BSD / ISC / Zlib / Unicode-3.0 / Unlicense. Run
`cargo metadata` or `cargo about` in `src-tauri/` for the full list.

**Exceptions, for transparency.**

- `option-ext` (MPL-2.0) is linked into the app through Tauri (`tauri → dirs → dirs-sys → option-ext`).
- `cssparser`, `cssparser-macros`, `selectors` and `dtoa-short` (MPL-2.0) are used only at compile time, by Tauri's code-generation macros.

MPL-2.0 is file-level copyleft. Using these crates unmodified (their source is on crates.io) places no obligations on VPuppet's own MIT code. They come with Tauri itself and every Tauri app carries them.

## Dev / test only (not shipped)

| Component | Licence |
|---|---|
| Vite, Vitest | MIT |
| TypeScript | Apache-2.0 |
| @tauri-apps/cli | Apache-2.0 OR MIT |
| @types/three | MIT |
| Playwright | Apache-2.0 |

## Animation clips

| Asset | Licence | Notes |
|---|---|---|
| `public/clips/ual.glb`: 12 clips from the [Universal Animation Library](https://quaternius.com) and Universal Animation Library 2 by Quaternius (`Idle_Loop`, `Idle_LookAround_Loop`, `Idle_Talking_Loop`, `Idle_FoldArms_Loop`, `Yes`, `Idle_No_Loop`, `Celebration`, `Dance_Loop`, `Sitting_Idle_Loop`, `Counter_Angry`, `Crying`, `Drink`) | CC0 1.0 (both packs' `License.txt`) | skeleton and bone tracks only, made by `scripts/build-builtin-clips.mjs`; the source names are in each animation's `extras.source` |
| WAVE, CLAP, BOW, POINT, SHRUG, THINK (`src/anim/authored.ts`) | MIT (VPuppet's own) | keyframed poses |

Retargeting (`src/anim/retarget.ts`) is VPuppet's own code. The idea of mapping a clip onto a VRM's normalized bones through world-space rest rotations is the one three-vrm's `loadMixamoAnimation` example shows (MIT); no code was copied from it. Users' imported clips (Mixamo or other) stay on their machine and are never bundled.

## Environment assets

The built-in 3D environments ship **no asset files**. Every scene, texture and sky is generated at runtime from code in `src/scene/environment/` (geometry, GLSL shaders, value noise painted into canvas textures). Custom `.glb`/`.gltf`/`.hdr`/`.exr` files are the user's own and are never bundled.

## Algorithms

- VRM meta: field names and the 0.x → 1.0 licence mapping follow the VRM specification (<https://github.com/vrm-c/vrm-specification>, MIT) and its published migration rules; the model library adds no new dependencies.
- One-euro filter: Géry Casiez, Nicolas Roussel, Daniel Vogel, "1€ Filter: A Simple Speed-based Low-pass Filter for Noisy Input in Interactive Systems", CHI 2012. Implemented from the paper.
- VMC protocol: <https://protocol.vmc.info/> (message layout only).
- Lip sync: formant (F1/F2) vowel matching with LPC-style pre-emphasis is textbook speech analysis; vowel formant averages after Peterson & Barney (1952) and Japanese vowel measurements. Implemented from scratch in `src/audio/visemes.ts`.
- Colour temperature: blackbody sRGB values at 1000 K steps, approximated from Mitchell Charity's blackbody colour data ("What color is a blackbody?", vendian.org), interpolated and luminance-normalised in `src/scene/environment/look.ts`.
- Value noise and the mulberry32 PRNG in `src/scene/environment/parts.ts` are standard public-domain techniques, written from scratch.

## Apache-2.0 notice (MediaPipe)

MediaPipe is Copyright The MediaPipe Authors, licensed under the Apache
License, Version 2.0 (<https://www.apache.org/licenses/LICENSE-2.0>). The
tasks-vision WASM files and the `.task` models are redistributed unmodified.
