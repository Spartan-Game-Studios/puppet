# Third-party notices

Puppet is MIT licensed. It uses the components below. Every direct dependency
is under a permissive licence; transitive notes are at the end.

## Shipped in the app (frontend)

| Component | Version | Licence | Notes |
|---|---|---|---|
| [three.js](https://github.com/mrdoob/three.js) | 0.186.1 | MIT | rendering; also `GLTFLoader`, `OrbitControls` from `three/examples/jsm` |
| [@pixiv/three-vrm](https://github.com/pixiv/three-vrm) (+ `three-vrm-core`, `-springbone`, `-materials-mtoon`, `-materials-v0compat`, `-materials-hdr-emissive-multiplier`, `-node-constraint`, `types-*`) | 3.5.5 | MIT | VRM 0.x / 1.0 loading, humanoid, expressions, lookAt, spring bones |
| [@mediapipe/tasks-vision](https://www.npmjs.com/package/@mediapipe/tasks-vision) | 1.1.0 | Apache-2.0 | Face / Pose / Hand landmarkers, WASM runtime (copied from the package at build time) |
| MediaPipe models: `face_landmarker.task`, `pose_landmarker_lite.task`, `pose_landmarker_full.task`, `hand_landmarker.task` | float16 v1 | Apache-2.0 | downloaded at build time from `storage.googleapis.com/mediapipe-models/`, SHA-256 pinned in `scripts/fetch-models.mjs`; not stored in git |
| [@tauri-apps/api](https://github.com/tauri-apps/tauri) | 2.x | Apache-2.0 OR MIT | |
| [@tauri-apps/plugin-dialog](https://github.com/tauri-apps/plugins-workspace) | 2.x | MIT OR Apache-2.0 | |
| [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) via [@fontsource/jetbrains-mono](https://fontsource.org/fonts/jetbrains-mono) | 5.x | SIL OFL 1.1 (font) | bundled font files |

## Shipped in the app (Rust shell)

| Crate | Licence |
|---|---|
| [tauri](https://crates.io/crates/tauri), tauri-build | Apache-2.0 OR MIT |
| [tauri-plugin-dialog](https://crates.io/crates/tauri-plugin-dialog) | Apache-2.0 OR MIT |
| [rosc](https://crates.io/crates/rosc) | MIT OR Apache-2.0 |
| [serde](https://crates.io/crates/serde), serde_json | MIT OR Apache-2.0 |
| [webkit2gtk](https://crates.io/crates/webkit2gtk) (Linux only) | MIT |

Transitive Rust dependencies (about 250 crates, pulled in by Tauri) are almost
all MIT / Apache-2.0 / BSD / ISC / Zlib / Unicode-3.0 / Unlicense. Run
`cargo metadata` or `cargo about` in `src-tauri/` for the full list.

**Exceptions, for transparency.**

- `option-ext` (MPL-2.0) is linked into the app through Tauri (`tauri → dirs → dirs-sys → option-ext`).
- `cssparser`, `cssparser-macros`, `selectors` and `dtoa-short` (MPL-2.0) are used only at compile time, by Tauri's code-generation macros.

MPL-2.0 is file-level copyleft. Using these crates unmodified (their source is on crates.io) places no obligations on Puppet's own MIT code. They come with Tauri itself and every Tauri app carries them.

## Dev / test only (not shipped)

| Component | Licence |
|---|---|
| Vite, Vitest | MIT |
| TypeScript | Apache-2.0 |
| @tauri-apps/cli | Apache-2.0 OR MIT |
| @types/three | MIT |
| Playwright | Apache-2.0 |

## Algorithms

- One-euro filter: Géry Casiez, Nicolas Roussel, Daniel Vogel, "1€ Filter: A Simple Speed-based Low-pass Filter for Noisy Input in Interactive Systems", CHI 2012. Implemented from the paper.
- VMC protocol: <https://protocol.vmc.info/> (message layout only).

## Apache-2.0 notice (MediaPipe)

MediaPipe is Copyright The MediaPipe Authors, licensed under the Apache
License, Version 2.0 (<https://www.apache.org/licenses/LICENSE-2.0>). The
tasks-vision WASM files and the `.task` models are redistributed unmodified.
