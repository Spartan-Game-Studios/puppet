# Virtual camera

Puppet can show up as a webcam called **Puppet Virtual Camera**, so Zoom, Meet, Discord, FaceTime, OBS and other apps can use the avatar directly. Turn it on in the **06 VIRTUAL CAM** panel or press `W`.

| OS | How | One-time setup by the user | Status |
|---|---|---|---|
| macOS 12.3+ | CoreMediaIO Camera Extension (a system extension inside Puppet.app) | Puppet in /Applications, click **INSTALL** on the EXTENSION line, approve in System Settings | Needs a Developer ID–signed build (see [Signing](#macos-signing)). Unsigned builds show the OBS route. |
| Windows 10/11 | [softcam](https://github.com/tshino/softcam) (MIT), a DirectShow virtual camera | Click **REGISTER CAMERA**, accept the admin prompt | Builds in CI; not run on hardware yet. |
| Linux | [v4l2loopback](https://github.com/umlaeute/v4l2loopback) device you create | `sudo modprobe v4l2loopback …` (see below) | Builds and unit-tests in CI; not run on hardware yet. |

Cameras carry no alpha. Whatever background you pick in **03 BACKGROUND** is what the camera shows; with **CLEAR**, the avatar is composited over the chosen colour (chroma green `#00ff00` by default), so a chroma key in the receiving app still works.

The frame is the capture view (`H`): same camera position, field of view and lights, rendered at 16:9 (1280×720 by default, or 1920×1080) at 30 fps. The vertical field of view matches the stage, so framing (BUST / UPPER / FULL) carries over; on a window that isn't 16:9 the camera shows a little more or less at the sides than the stage.

## No native camera? The OBS route

Works everywhere and needs no install beyond OBS:

1. Pick a background (green is easiest to key).
2. Press `H` for capture view.
3. In OBS, add a **Window Capture** source (macOS: *macOS Screen Capture*, method *Window Capture*; Linux: *Window Capture (Xcomposite)*) and pick the PUPPET window.
4. Optional: **Filters → Chroma Key**.
5. Click **Start Virtual Camera** in OBS, and pick **OBS Virtual Camera** in your video app.

## How it works

```
three.js scene ──render──▶ 1280×720 MSAA half-float target (linear, premultiplied alpha)
               ──output pass──▶ 8-bit target: over background colour, sRGB encode,
                                swizzle to BGRA, flip rows to top-down
               ──readRenderTargetPixelsAsync (PBO + fence; no pipeline stall)──▶
frame buffer [16-byte header | BGRA pixels]   (the readback writes straight into the IPC body)
               ──invoke('vcam_frame', bytes): raw binary IPC, no JSON, no base64──▶
Rust: copy into a recycled buffer, try_send to the writer thread (1-slot channel: drop, never queue)
               ──VirtualCamSink::write──▶ macOS: BGRA CVPixelBuffer → CMIO sink queue → extension → apps
                                          Windows: BGR24 → softcam shared memory → DirectShow filter
                                          Linux: YUYV → write() to /dev/videoN
```

- `src/vcam/frame.ts`: wire format, 30 fps pacer, CPU reference of the output pass (unit tested).
- `src/vcam/grabber.ts`: offscreen render, output pass, async readback.
- `src/vcam/output.ts`: pacing, triple buffering, stats.
- `src-tauri/src/vcam/mod.rs`: frame parsing, the `VirtualCamSink` trait, the writer thread, stats.
- `src-tauri/src/vcam/convert.rs`: BGRA → YUYV (BT.601 limited range) and BGR24.
- `src-tauri/src/vcam/{macos,windows,linux,file_sink}.rs`: the sinks.
- `src-tauri/macos/bridge/PuppetVCamBridge.m`: app side on macOS (activation + CMIO sink writer).
- `src-tauri/macos/camera-extension/`: the Swift camera extension; `build-camera-extension.sh` builds it (universal, signed if a signing identity is set) and `tauri.macos.conf.json` embeds it at `Contents/Library/SystemExtensions/`.
- `scripts/build-softcam.ps1`: builds `softcam.dll` from a pinned commit with Puppet's own filter name, CLSID and shared-memory names; runs automatically before `tauri dev` / `tauri build` on Windows.

If all three frame buffers are still in flight when the next frame is due, that frame is skipped (counted as DROP). The camera never lags behind the avatar.

## macOS

### What the user does (signed build)

1. Move **Puppet.app** to **/Applications** and open it from there. macOS installs system extensions only from apps in /Applications.
2. In **06 VIRTUAL CAM**, click **INSTALL** on the **EXTENSION** line.
3. macOS asks for approval. Click **OPEN SETTINGS** in the panel to jump to the right page (macOS has no in-app approval prompt for system extensions):
   - macOS 15 and later: **System Settings → General → Login Items & Extensions → Camera Extensions**, switch **Puppet** on.
   - macOS 13–14: **System Settings → Privacy & Security**, under "System software from application Puppet was blocked", click **Allow**.
4. The EXTENSION line reads **ACTIVE**. Switch **CAMERA OUTPUT** on (`W`, or START on a gamepad).
5. In Zoom / Meet / Discord / FaceTime pick **Puppet Virtual Camera**.

### The camera exists only while Puppet sends

The extension publishes the **Puppet Virtual Camera** device only while Puppet is running with **CAMERA OUTPUT** on. Turn the output off, quit Puppet, or let it crash, and the camera disappears from every app's camera list: no frozen or black "Puppet" camera is left behind.

How: while the output is on, the app sends a heartbeat once a second, a Darwin notification (`com.spartangamestudios.puppet.camera.presence`, `pvc_presence` in `PuppetVCamBridge.m`) whose state is a beat counter. The extension (`ProviderSource` in `Provider.swift`) adds the device on the first beat and removes it when the app posts "off" (output off, or quit: the app closes the output on exit) or when no beat or frame arrives for 3.5 s (crash, force quit). A stale beat left by a crashed app does not bring the device back when the extension restarts; only a fresh beat does. Between the device appearing and the first frame (or if frames stall), apps see a **PUPPET / WAITING FOR FRAMES** card.

Darwin notifications are allowed by the camera-extension sandbox (`cmioextension.sb` imports `system.sb`, which permits `com.apple.system.notification_center`). If registering for them ever fails, the extension falls back to keeping the device present.

### Extension controls (EXTENSION line)

`src/app/vcamControls.ts` (`mountVcamControls(container)`) shows the extension's state and the buttons that apply:

| State | Buttons |
|---|---|
| NOT INSTALLED | INSTALL (an activation request) |
| WAITING FOR APPROVAL | OPEN SETTINGS (Login Items & Extensions) |
| ACTIVE vN | UNINSTALL |
| NEEDS UPDATE (installed and bundled versions differ) | UPDATE, UNINSTALL |
| RESTART YOUR MAC TO FINISH / REMOVED AFTER A RESTART | none |
| FAILED | RETRY (unless it's a signing or location problem) |

**UNINSTALL** asks for a second press (**CONFIRM UNINSTALL?**, 5 s; Escape cancels), turns the output off and submits a deactivation request; macOS may ask for an administrator password. The extension's version is its `CFBundleVersion`, taken from `src-tauri/macos/camera-extension/BUILD`: **bump BUILD whenever the extension changes**, since macOS only replaces an installed extension whose `CFBundleVersion` differs, and the app compares the installed and bundled values to show NEEDS UPDATE. The first release's extension (always-on device, version 0.1.0) shows as NEEDS UPDATE.

Removing Puppet.app from /Applications also removes its extension.

### Minimized, hidden or covered

Puppet keeps tracking, rendering and sending (virtual camera and VMC) while its window is minimized, hidden (Cmd-H) or covered. WebKit stops `requestAnimationFrame` for a page it considers not visible, whatever the background-throttling setting, and every loop in Puppet runs off rAF. Two fixes:

- `src-tauri/macos/bridge/PuppetBackground.m`: turns off WKWebView's window-occlusion detection (a covered or off-screen window stays "visible", rAF keeps its full rate), WebKit's hidden-page timer throttling and visibility-based process suppression, and opts the process out of App Nap (an `NSProcessInfo` activity that still allows idle system sleep).
- `src/app/backgroundLoop.ts`: wraps `requestAnimationFrame`; a Worker ticks at 60 Hz and runs pending callbacks when real rAF has been silent for 100 ms (minimized / hidden). In the foreground nothing changes.

`scripts/background-test.mjs` checks it on a built binary (`hide` = app hidden from start, `offscreen` = window off every screen; `PUPPET_EXTRA_QUERY=bgloop=0` turns the frontend half off).

The panel shows every state in plain words: not in /Applications, waiting for approval, restart needed, not signed (with the OBS route), installed, running.

### macOS signing

A camera extension installs only when **the app is signed with a Developer ID certificate and carries the `com.apple.developer.system-extension.install` entitlement from a provisioning profile**. These can only be created by the team's Account Holder in the Apple Developer portal. Unsigned (CI) builds still contain the extension, ad-hoc signed; activation then fails at once with *missing entitlement com.apple.developer.system-extension.install (OSSystemExtensionErrorDomain 2)*, and the panel points to the OBS route.

#### One-time setup in the Apple Developer portal (developer.apple.com/account)

1. **Certificate.** Certificates → **+** → **Developer ID Application** (G2 Sub-CA). Create it from a CSR made in Keychain Access, download it, double-click to add it to your login keychain, then export it with its private key as a `.p12` with a password.
2. **App ID for the app.** Identifiers → **+** → App IDs → App → Bundle ID (Explicit) `com.spartangamestudios.puppet`. Under Capabilities, enable **System Extension**.
3. **App ID for the extension.** Identifiers → **+** → App IDs → App → Bundle ID (Explicit) `com.spartangamestudios.puppet.camera`. No capability is needed: its app group, `<TEAMID>.com.spartangamestudios.puppet.camera`, is a macOS team-prefixed group, which needs no registration.
4. **Profile for the app.** Profiles → **+** → Distribution → **Developer ID** → App ID `com.spartangamestudios.puppet` → the Developer ID certificate from step 1 → name it `Puppet Developer ID` → download `Puppet_Developer_ID.provisionprofile`.
5. **Profile for the extension** (recommended; it is what Xcode would create). Same as step 4 with App ID `com.spartangamestudios.puppet.camera`, named `Puppet Camera Developer ID`.
6. **Notarization credentials.** Either an app-specific password for your Apple ID (appleid.apple.com → Sign-In and Security → App-Specific Passwords), or an App Store Connect API key (Users and Access → Integrations → Keys).
7. Note your **Team ID** (Membership details, 10 characters).

#### GitHub secrets (Settings → Secrets and variables → Actions)

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATE` | `base64 -i DeveloperID.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12` password |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: <Name> (<TEAMID>)` (from `security find-identity -v -p codesigning`) |
| `APPLE_TEAM_ID` | the Team ID |
| `PUPPET_APP_PROFILE` | `base64 -i Puppet_Developer_ID.provisionprofile` |
| `PUPPET_CAMEXT_PROFILE` | `base64 -i Puppet_Camera_Developer_ID.provisionprofile` (optional) |
| `APPLE_ID`, `APPLE_PASSWORD` | Apple ID and app-specific password, for notarization |

With `APPLE_CERTIFICATE` and `PUPPET_APP_PROFILE` set, the macOS jobs import the certificate into a temporary keychain, sign the extension (`build-camera-extension.sh`), generate the app entitlements and a config overlay (`prepare-signing.sh`), and Tauri signs and notarizes the app. Without them, the build stays unsigned, exactly as before.

#### Signed build on your Mac

```sh
export APPLE_SIGNING_IDENTITY="Developer ID Application: <Name> (<TEAMID>)"
export APPLE_TEAM_ID=<TEAMID>
export PUPPET_CAMEXT_PROFILE=~/Downloads/Puppet_Camera_Developer_ID.provisionprofile
PUPPET_APP_PROFILE=~/Downloads/Puppet_Developer_ID.provisionprofile bash src-tauri/macos/prepare-signing.sh
APPLE_ID=<you@example.com> APPLE_PASSWORD=<app-specific password> \
  pnpm tauri build --config src-tauri/macos/build/tauri.signed.conf.json
```

Then copy `src-tauri/target/release/bundle/macos/Puppet.app` to /Applications and follow [What the user does](#what-the-user-does-signed-build). Check the result with `codesign -d --entitlements - /Applications/Puppet.app` (it must list `com.apple.developer.system-extension.install`) and `systemextensionsctl list` after approval. You do not need `systemextensionsctl developer on` or any SIP change for a Developer ID–signed, notarized build.

## Windows

1. In **06 VIRTUAL CAM**, click **REGISTER CAMERA** and accept the Windows admin prompt. This runs `regsvr32` on the `softcam.dll` that ships next to `puppet.exe` (once per install location).
2. Tick **SEND TO VIRTUAL CAMERA** (`W`) and pick **Puppet Virtual Camera** in your video app.

To remove it before uninstalling Puppet, run in an admin terminal: `regsvr32 /u "<Puppet install folder>\softcam.dll"`.

softcam is a DirectShow camera, which Zoom, Discord, OBS, Chrome / Edge (Meet) and most desktop apps read. Apps that only use Media Foundation's frame server (the Windows 11 Camera app, some UWP apps) don't list DirectShow cameras. Only the 64-bit DLL is built, so 32-bit camera apps won't see it.

**Why softcam rather than `MFCreateVirtualCamera`:** both need a COM DLL registered with admin rights (MF virtual cameras run a custom media source inside the Frame Server service, which Puppet would have to write and register). `MFCreateVirtualCamera` exists only on Windows 11 build 22000+, while softcam works on Windows 10 and 11 and is a small, MIT-licensed, maintained library with a two-function sender API. It builds in CI from a pinned commit.

## Linux

Puppet writes YUYV frames into a v4l2loopback device. It never loads kernel modules itself. Once:

```sh
sudo apt install v4l2loopback-dkms          # Fedora: akmod-v4l2loopback; Arch: v4l2loopback-dkms
sudo modprobe v4l2loopback devices=1 video_nr=10 card_label="Puppet" exclusive_caps=1
```

`exclusive_caps=1` is needed for Chrome / WebRTC (Meet, Discord in the browser) to list the device. To create it at every boot:

```sh
echo v4l2loopback | sudo tee /etc/modules-load.d/v4l2loopback.conf
echo 'options v4l2loopback devices=1 video_nr=10 card_label="Puppet" exclusive_caps=1' | sudo tee /etc/modprobe.d/v4l2loopback.conf
```

The panel lists every loopback device (DEVICE), shows the `modprobe` command when there is none (click it to copy), and says if another program holds the device.

## Testing without a camera

| hook | effect |
|---|---|
| `PUPPET_VCAM_SINK=file:/abs/out.yuyv[?max=N]` | desktop app: write frames to a file (`.yuyv`, `.bgr`, else BGRA) plus `out.yuyv.json` (size, format, fps, intervals, sequence gaps, conversion time) instead of the OS camera |
| `PUPPET_VCAM_SINK=null` | desktop app: accept and discard frames (IPC cost only) |
| `PUPPET_VCAM_SELFTEST=status\|setup` | desktop app: print the sink status for 15 s (`setup` first submits the macOS activation request) |
| `PUPPET_SETTINGS_DIR=/tmp/x` | desktop app: use another settings folder |
| `?vcam=1&vcamres=1920x1080` | start the output at launch |
| `?vcamsend=0` | grab frames but skip the IPC |

- `PUPPET_MODEL=avatar.vrm node scripts/vcam-test.mjs out/ [1280x720|1920x1080]` runs the frame source in headless Chrome: frame size, BGRA order, row order, COLOUR and CLEAR backgrounds, fps, render and readback times; writes PNGs.
- `PUPPET_MODEL=avatar.vrm PUPPET_CLIP=clip.mp4 node scripts/vcam-desktop-test.mjs <puppet binary> out/ [res] [seconds]` runs a built desktop app with the file sink (tracking a clip, so no webcam) and reports what arrived in Rust and the CPU cost with the output on and off. It opens the app window; wrap it with `PUPPET_LAUNCH_PREFIX`.
- `cargo test` covers the conversions, the frame header, the writer thread (with a mock sink: order, size, dropping) and the file sink; `pnpm test` covers the header, pacing and the output-pass maths.

View a file-sink capture with `ffmpeg -f rawvideo -pix_fmt yuyv422 -s 1280x720 -i out.yuyv -frames:v 1 frame.png`.
