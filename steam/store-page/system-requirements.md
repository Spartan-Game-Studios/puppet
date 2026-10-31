# System requirements

Paste each block into Steamworks → Store page → System Requirements (one tab per OS). Steam's fields are: OS, Processor, Memory, Graphics, Storage, Additional Notes.

**These are estimates, not measurements.** They are based on what VPuppet runs: three MediaPipe models (face, pose, hands) on the GPU through WebGL in the system webview, plus a three.js WebGL2 scene, at 30 fps tracking. The README's measurements are from an Apple M3 Pro only. Before launch, run the app on a machine at each "minimum" line in +HANDS mode and in FACE mode and adjust. The heaviest load is +HANDS mode with a 3D environment on HIGH.

## Windows

| | Minimum | Recommended |
|---|---|---|
| OS | Windows 10 64-bit (version 1809 or later) | Windows 11 64-bit |
| Processor | Quad-core, e.g. Intel Core i5-6500 / AMD Ryzen 3 1300X | 6-core, e.g. Intel Core i5-10400 / AMD Ryzen 5 3600 |
| Memory | 8 GB RAM | 16 GB RAM |
| Graphics | WebGL 2 capable GPU with current drivers, e.g. Intel UHD Graphics 620 / NVIDIA GeForce GTX 950 / AMD Radeon RX 460 | NVIDIA GeForce GTX 1060 / AMD Radeon RX 580 or better |
| Storage | 500 MB available space (plus your avatars and clips) | 1 GB available space |
| Additional Notes | **Webcam required** (720p at 30 fps or better). Microsoft Edge WebView2 Runtime (included with Windows 11). Virtual camera: 64-bit camera apps only; registering it needs one administrator prompt. Microphone optional (lip sync). | 1080p webcam; even front lighting improves tracking more than a better camera. |

## macOS

| | Minimum | Recommended |
|---|---|---|
| OS | macOS 12.3 Monterey | macOS 14 Sonoma or later |
| Processor | Apple M1, or Intel Core i5 quad-core (2018 or later) | Apple M1 Pro / M2 or later |
| Memory | 8 GB RAM | 16 GB RAM |
| Graphics | Integrated (Apple silicon GPU or Intel Iris Plus) | Apple silicon GPU |
| Storage | 500 MB available space (plus your avatars and clips) | 1 GB available space |
| Additional Notes | **Webcam required** (the built-in FaceTime camera works). The virtual camera installs as a camera extension and needs one approval in System Settings. Microphone optional (lip sync). | |

Check before publishing: whether the Mac depot is universal (Apple silicon + Intel) or Apple silicon only. The local build in the repo is `aarch64` only. If Intel isn't built, change the minimum processor line to "Apple silicon (M1 or later)".

## Linux / SteamOS

| | Minimum | Recommended |
|---|---|---|
| OS | 64-bit Ubuntu 22.04 or equivalent (WebKitGTK 4.1) | Ubuntu 24.04 or equivalent |
| Processor | Quad-core, e.g. Intel Core i5-6500 / AMD Ryzen 3 1300X | 6-core, e.g. Intel Core i5-10400 / AMD Ryzen 5 3600 |
| Memory | 8 GB RAM | 16 GB RAM |
| Graphics | WebGL 2 capable GPU with Mesa 22+ or the proprietary NVIDIA driver | NVIDIA GeForce GTX 1060 / AMD Radeon RX 580 or better |
| Storage | 500 MB available space (plus your avatars and clips) | 1 GB available space |
| Additional Notes | **Webcam required** (V4L2). Virtual camera needs the v4l2loopback kernel module. System-wide hotkeys need an X11 session (not available on pure Wayland). A compositor is needed for a transparent window. Microphone optional (lip sync). | |

Steam Deck: not a target (no front webcam). Don't apply for Deck Verified; leave the compatibility unrated or expect "Unsupported".

## Notes

- Storage: the app itself is small (the MediaPipe models and WASM runtime are tens of MB). 500 MB leaves room for the bundled runtime files and the webview cache; imported VRMs commonly run 10–100 MB each and are stored in the app's data folder.
- Tracking speed depends on MediaPipe running on the GPU (the status bar's ML field shows the delegate). If the minimum-spec test shows the GPU path unavailable on some drivers (older Intel graphics under Windows are the likely case), raise the minimum or say so in Additional Notes.
