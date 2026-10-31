# VPuppet on Steam

Everything needed to put VPuppet on Steam: store copy, the demo's store copy, asset checklists and SteamPipe build templates. Nothing here is read by the app or the build; it is reference material and templates.

```
steam/
├── README.md                     this file: contents + launch checklist
├── store-page/                   full version ($19.99)
│   ├── short-description.txt     the ≤300-character blurb under the header capsule
│   ├── about.bbcode              "About This Software" section, Steam BBCode
│   ├── features.md               feature list in plain Markdown (press kit, website, reference for about.bbcode)
│   ├── system-requirements.md    minimum / recommended per OS
│   ├── tags.md                   suggested tags, ranked
│   ├── legal.md                  EULA / licence notes for the Steamworks legal fields
│   ├── assets.md                 every graphical asset Steam asks for, with sizes and what to show
│   └── i18n/                     russian/, schinese/, spanish/ translations + README (where to paste, supported languages)
├── demo-page/                    free demo (separate App ID)
│   ├── short-description.txt
│   ├── about.bbcode
│   └── i18n/                     russian/, schinese/, spanish/ translations
└── steampipe/                    TEMPLATES: SteamPipe app and depot build scripts
    ├── README.md
    ├── app_build_full.vdf
    ├── app_build_demo.vdf
    ├── depot_build_full_windows.vdf / _macos.vdf / _linux.vdf
    └── depot_build_demo_windows.vdf / _macos.vdf / _linux.vdf
```

Placeholders used throughout: `<FULL_APP_ID>`, `<DEMO_APP_ID>`, `<FULL_DEPOT_ID_WIN>`, `<FULL_DEPOT_ID_MAC>`, `<FULL_DEPOT_ID_LINUX>`, `<DEMO_DEPOT_ID_WIN>`, `<DEMO_DEPOT_ID_MAC>`, `<DEMO_DEPOT_ID_LINUX>`, `<GITHUB_URL>` (https://github.com/Spartan-Game-Studios/puppet, until the repo is renamed), `<SUPPORT_EMAIL>`, `<SUPPORT_URL>`.

## Product setup in brief

| | Full version | Demo |
|---|---|---|
| App ID | `<FULL_APP_ID>` | `<DEMO_APP_ID>` (a separate app, linked to the full one as its demo) |
| Price | $19.99 USD | free |
| Build | `pnpm tauri build` with the `steam` cargo feature | same, plus the `demo` build flag |
| Limit | none | 100 hours of use, counted in the `demo_seconds` stat; after that tracking output, the virtual camera and VMC lock; the model library still opens |
| Data folder | shared: both use the same app identifier, so the library and settings carry over when a demo user buys | |

Steam app type: **Software / Application**, not Game. VPuppet is a creative and streaming tool.

## Launch checklist

### 1. Steamworks partner account

- [ ] Steamworks partner account for Spartan Game Studios (partner.steamgames.com): legal name, bank and tax information (the tax interview must be accepted before any payout or release).
- [ ] Pay the Steam Direct fee (US$100 per app, recoupable after $1,000 in gross revenue). The demo does not need its own fee.
- [ ] Identity verification done. Valve requires a 30-day wait between paying the first app fee and releasing; start this early.

### 2. App IDs and depots

- [ ] Create the full app (`<FULL_APP_ID>`), type Application/Software.
- [ ] Create the demo from the full app's dashboard (**Create Demo**); this makes `<DEMO_APP_ID>` and links it as the base app's demo. Give the demo its own store page (Store page → "Demo" settings) so it can carry its own text from `demo-page/`.
- [ ] Depots: one per OS for each app (six total). In SteamPipe → Depots set each depot's **Operating System** filter (Windows 64-bit, macOS, Linux) so each user only downloads their own.
- [ ] Launch options (Installation → General) per OS. The executable name depends on the renamed binary; check what `pnpm tauri build` writes after the rename lands:
  - Windows: `vpuppet.exe` (check the actual name in `src-tauri/target/release/`)
  - macOS: `VPuppet.app` (Steam launches the bundle)
  - Linux: `VPuppet.AppImage` (see `steampipe/README.md` for the staging step), or the binary in an extracted AppDir
- [ ] Windows: WebView2 runtime. Windows 11 ships it; most Windows 10 machines have it via Edge updates, but not all. Steam does not run the Tauri installer (it ships files), so either add an install script (Installation → Redistributables / `installscript.vdf`) that runs Microsoft's WebView2 bootstrapper, or detect its absence at startup and point the user to the download. Decide before release.
- [ ] Ship the Steamworks SDK runtime libraries (`steam_api64.dll`, `libsteam_api.dylib`, `libsteam_api.so`) where the `steam` feature expects them in every depot. The SteamPipe templates have a placeholder line for this.

### 3. The `demo_seconds` stat (demo app only)

Define it in the **demo** app's Stats & Achievements (stats belong to an App ID; the full app does not need it):

| Field | Value |
|---|---|
| API Name | `demo_seconds` |
| Type | INT |
| Set by | Client |
| Increment Only | **yes** (the value can never go down, so reinstalling, deleting local files or writing a lower value cannot reset the clock) |
| Max Change | leave empty, or at least `360000`: the client stores every minute of use, but the first sync after time counted offline (Steam not running) jumps by all of it, and a Max Change below the jump rejects it |
| Min / Max | 0 / leave empty (or 2147483647) |
| Default | 0 |
| Display name | Demo time used (seconds) |

- [ ] 100 hours = **360000** seconds. Make sure the client and this number agree.
- [ ] **Publish** the stats changes (Steamworks changes are not live until published on the Publish tab).
- [ ] Test with a Steam test account: fresh account starts at 0, the value survives a reinstall, and the lock engages at 360000 (lower the limit in a dev build to test the transition rather than waiting 100 hours).
- [ ] Offline behaviour: decide and test what the demo does when Steam is not running or offline (stats can't sync). The store text in `demo-page/` makes no promise about offline use.

### 4. Pricing

- [ ] Base price: **$19.99 USD**.
- [ ] Regional pricing: start from Valve's **recommended** regional prices for $19.99 (Pricing → "Use recommended prices"). They are adjusted for purchasing power and are what Steam users in those regions expect. Review the few that end on awkward numbers, but don't hand-raise low-income regions: VTubing is popular in Latin America and Southeast Asia, where a dollar-pegged price would price most users out.
- [ ] Launch discount: optional, up to 40% at launch is common. Remember a discount locks out further discounts for 28 days after it ends (Steam's discount cooldown).
- [ ] Demo: free, no pricing needed.

### 5. Store page

- [ ] Fill text from `store-page/` (short description, About This Software, system requirements, tags, legal).
- [ ] Supported languages: English (interface). Do not tick other languages until the UI is localised.
- [ ] Localization: paste the Russian, Simplified Chinese and Spanish store and demo copy from `store-page/i18n/` and `demo-page/i18n/` into each language in the Store page language dropdown (Spanish goes into both Spanish - Spain and Spanish - Latin America), and tick those languages as supported (interface only) once the app UI translation ships. Steps, character counts and terminology: `store-page/i18n/README.md`. Re-translate whenever the English copy changes.
- [ ] Controller support: the app is fully keyboard/gamepad navigable (Tab and gamepad menu mode reach every control) but setup tasks (file dialogs, OS camera permissions, the virtual camera install) leave the app. Declare **Partial Controller Support**, not Full.
- [ ] Upload assets per `store-page/assets.md`; **retake screenshots**: `docs/ui.png` in the repo shows an older UI layout (left settings column with SOURCE / TRACKING / BACKGROUND / VMC sections) and no avatar loaded. It must not go on the store page.
- [ ] Link the GitHub repository in the store page's external links. Being open source is part of the pitch, not a secret.
- [ ] Privacy: VPuppet sends no telemetry and processes the camera image locally. Add a short privacy policy URL anyway (Steam asks for one under some regional rules, and users ask about webcam apps). `<PRIVACY_URL>`.

### 6. Content survey

Answer the Content Survey (Store Admin → Content Survey) honestly:

- [ ] **Mature content:** none in the app itself. VPuppet ships no avatars; it displays whatever VRM the user imports. Select no mature content categories for the app.
- [ ] **User-generated content:** yes, describe it: users import their own VRM avatars, FBX/glTF animation clips, glTF environments and HDR skies from their own disk. Nothing is uploaded, shared or browsable between users; there is no Workshop and no in-app content store. The user is responsible for the rights to what they import (see `store-page/legal.md`).
- [ ] **Webcam / microphone:** state that the app uses the webcam (required) and optionally the microphone (lip sync), processed locally on the device with MediaPipe; no image or audio leaves the machine. The only network output is VMC (UDP, to an address the user sets, off by default) and the virtual camera (local).
- [ ] **AI content disclosure:** VPuppet uses machine-learning models (Google MediaPipe) for live tracking: landmark and blendshape estimation, not generative AI. It generates no images, text, voice or 3D content. Check the current wording of Valve's AI disclosure section; if it asks about "live-generated content", the honest answer is that no content is generated, only pose data. If in doubt, disclose the tracking models in the free-text field rather than leave it out.

### 7. Review lead times

- [ ] **Store page review**: Valve reviews the store page before it can go Coming Soon. Allow about 3–5 business days, more around holidays and big Steam events; a rejection restarts the clock.
- [ ] **Coming Soon** page live **at least 2 weeks** before release (Valve's rule). Longer is better for wishlists; aim for 4–8 weeks if the schedule allows.
- [ ] **Build review**: a separate review of the actual build (Valve launches it, checks it starts and matches the store page). Allow 3–5 business days. Upload a build to the default branch, mark it for review, and have it approved before the release date. Release requires both reviews passed.
- [ ] Demo: same two reviews for the demo App ID. Submit both together.
- [ ] The release button is pressed by you; nothing goes live automatically on the date.

### 8. Builds

- [ ] Full build: `steam` feature on, `demo` flag off. Demo build: `steam` feature on, `demo` flag on. Build each into a clean tree (or clean between) so the two never mix; see `steampipe/README.md`.
- [ ] Upload with `steampipe/app_build_full.vdf` and `app_build_demo.vdf` (fill in the IDs first), set live on a `beta` branch, install via Steam on each OS and run it before setting the default branch.
- [ ] Steam handles updates; make sure the Steam build does not also run Tauri's own updater (if one is ever added for the GitHub builds).
- [ ] Steam overlay: the Tauri webview is not a game renderer. Check whether the overlay injects at all and whether it causes trouble; if it does, there is nothing to gain from it.

### 9. macOS: signing, notarization and the camera extension

- [ ] The Mac depot must contain a **Developer ID–signed and notarized** `VPuppet.app` (Steam does not sign anything for you). Follow `docs/virtual-camera.md#macos-signing`: Developer ID certificate, the `com.apple.developer.system-extension.install` entitlement via a Developer ID provisioning profile, notarize and staple **before** uploading to SteamPipe. Upload the stapled `.app` itself, not the `.dmg`.
- [ ] Verify the uploaded bundle survives the Steam round trip: install it through Steam, then `codesign --verify --deep --strict` and `spctl -a -vv` on the installed copy. SteamPipe preserves file contents but check that executable bits and symlinks inside the bundle (`Contents/Frameworks`) arrive intact.
- [ ] **Blocker to resolve:** macOS only activates a system extension (the camera extension) from an app in `/Applications`. Steam installs to `~/Library/Application Support/Steam/steamapps/common/VPuppet/`. The current VIRTUAL CAM panel already says "VPuppet must be in /Applications". For the Steam build either (a) have the app offer to copy or symlink itself into /Applications for the camera install, (b) document the step on the store page and in-app, or (c) ship a small helper. Test which of these macOS accepts (a symlink may not be enough). Until solved, the macOS virtual camera does not work from a Steam install, and the store copy promises it on macOS.
- [ ] Bump `src-tauri/macos/camera-extension/BUILD` whenever the extension changes (macOS replaces an installed extension only when its version differs).
- [ ] Windows: the virtual camera registration (`REGISTER CAMERA`) registers `softcam.dll` by path inside the Steam install folder. Test that it still works after a Steam update and after moving the library to another drive, and that uninstalling through Steam leaves no dangling registration (or document how to remove it).

### 10. Things to confirm before launch (from the repo's own Known limitations)

The README lists these as not yet tested on real hardware. The store copy describes them as features, so each needs a real test before release:

- [ ] Webcam permission prompt in the packaged app on macOS, Windows and Linux.
- [ ] Virtual camera with a real Zoom / Meet / Discord / OBS session on all three OSes (Windows softcam and Linux v4l2loopback have only run in CI).
- [ ] Microphone prompt and lip sync with a real voice in the signed macOS app.
- [ ] Global hotkeys on Windows and Linux (X11 only; not on pure Wayland).
- [ ] The minimum specs in `store-page/system-requirements.md` on actual minimum-spec machines (they are estimates).
