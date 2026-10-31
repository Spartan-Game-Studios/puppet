# Store graphical assets checklist

Sizes are Valve's current required sizes (Steamworks → Store page → Graphical Assets, and Library Assets). Upload at exactly these sizes; Steam rejects or rescales others. Re-check the Steamworks upload pages before production in case Valve has changed a size.

Rules that apply to every capsule:
- The **VPuppet logo/name must be legible** on every capsule. Valve requires capsules to show the product name and no review quotes, award laurels, discount text or "sale" banners (other than on dedicated event art).
- Show an avatar that the studio has advertising rights to (see `legal.md`), not a borrowed VRoid Hub model.
- Keep the visual identity consistent: the app's orange accent and monospace UI type, one hero avatar.
- The demo app needs its own set of the store capsules too (it has its own store page); reuse the art with a small "DEMO" mark only if Valve's guidelines allow it on that capsule, otherwise rely on the demo page's own label.

## Store capsules

| Asset | Size (px) | Format | What to show |
|---|---|---|---|
| [ ] **Header capsule** | 920 × 430 | PNG/JPG | Hero avatar waist-up on the left, mid-expression (a clear smile or surprise), VPuppet logo on the right. The most-seen asset: top of the store page, recommendations, and lists. No UI. |
| [ ] **Small capsule** | 462 × 174 | PNG/JPG | Logo dominant, avatar face cropped tight beside it. Shown tiny in search results and lists, so it's mostly about the logo being readable at ~120 px wide. |
| [ ] **Main capsule** | 1232 × 706 | PNG/JPG | The front-page feature: avatar large in one of the built-in 3D environments (Cosy Room or Neon Grid read best), logo, and a small inset of a real person at a webcam to say "this is webcam-driven" at a glance. |
| [ ] **Vertical capsule** | 748 × 896 | PNG/JPG | Avatar full upper body, hands up in a gesture (peace or wave) to show hand tracking, logo at the top. Used in seasonal sales and some events. |

## Library assets (Steam client library)

| Asset | Size (px) | Format | What to show |
|---|---|---|---|
| [ ] **Library capsule** | 600 × 900 | PNG/JPG | Portrait version of the vertical capsule: avatar and logo. |
| [ ] **Library header** | 920 × 430 | PNG/JPG | Can reuse the header capsule art. |
| [ ] **Library hero** | 3840 × 1240 | PNG/JPG | Wide background art, **no text or logo** (the logo is overlaid separately). An environment scene with the avatar off-centre; keep the centre-left area calm for the logo overlay. Valve's safe area guide is in the Library Assets page. |
| [ ] **Library logo** | up to 1280 wide and/or 720 tall | PNG with transparency | The VPuppet wordmark only, transparent background. Set its position over the hero in the Library Assets page preview. |

## Other required or near-required images

| Asset | Size (px) | Format | What to show |
|---|---|---|---|
| [ ] **Page background** | 1438 × 810 | PNG/JPG | Optional but recommended. A dark, low-contrast, blurred environment scene; Steam fades it at the edges. Must not hurt text legibility. |
| [ ] **Community / client icon** | 184 × 184 | JPG | App icon, square. |
| [ ] **Client icon** | 32 × 32 (`.ico`) | ICO | From `src-tauri/icons/icon.ico` once the icons are renamed/rebranded. |
| [ ] **Event / announcement cover** | 800 × 450 | PNG/JPG | For launch and update announcements. |
| [ ] **Event / announcement header** | 1920 × 622 | PNG/JPG | Same. |

## Screenshots (at least 5; 8–10 recommended)

1920 × 1080, 16:9, PNG or JPG. The first four show in the store page's top carousel and in hover previews, so they matter most. **Retake all of them from the renamed app**; `docs/ui.png` shows an old layout with no avatar loaded and must not be used. `docs/environments.jpg` (six scenes, no avatar) is fine as reference but too small (1440 × 540) and avatar-less to upload.

Take them with the app at 1920 × 1080, a well-lit hero avatar, and real tracking (not a static pose) so faces and hands look alive. Turn off the debug overlay unless the shot is about it.

| # | Screenshot | What to show |
|---|---|---|
| [ ] 1 | **The stage, tracking** | The main stage with an avatar mid-expression, the camera card showing the real webcam preview with the landmark overlay, bottom bar reading TRACKING and PERFECT SYNC. This one shot explains the product. |
| [ ] 2 | **Hands and fingers** | +HANDS mode, both hands up in different gestures (peace and thumbs up), the debug overlay's gesture readout visible. |
| [ ] 3 | **Virtual camera in a call** | VPuppet as the camera in a video call app (Zoom / Meet / Discord). Use your own test meeting; blur or avoid other participants and avoid third-party logos dominating (check each app's brand guidelines). |
| [ ] 4 | **3D environment** | Capture view (`H`) in Cosy Room or Moor at Dusk at HIGH quality: what viewers see. |
| [ ] 5 | **Model library** | HOME with several model cards (thumbnails, PERFECT SYNC n/52, licence badges, favourites). Use only avatars you may show. |
| [ ] 6 | **FACE window** | Per-blendshape bars with gain and curve, raw vs output, alongside the avatar's face. For the technical buyer. |
| [ ] 7 | **Cloth and hair** | An avatar with a skirt / cape and long hair mid-motion (a turn or an emote like CHEER), showing the cloth draping instead of clipping. |
| [ ] 8 | **Hotkeys and emotes** | The HOTKEYS window with keyboard and gamepad bindings, or the on-screen picker over the stage. |
| [ ] 9 | **OBS / VMC** | Capture view in an OBS scene, or VMC output feeding another app (only if that app's name/trademark may be shown). |
| [ ] 10 | **Environments grid** | A composite of the six scenes with the avatar in each (one image). |

## Trailer

| Spec | Value |
|---|---|
| Resolution | 1920 × 1080 (16:9). Steam also accepts 4K; upload the highest-quality master you have. |
| Format | MP4 (H.264), high bitrate (5,000+ kbps; Valve transcodes it). AAC stereo audio. |
| Length | 45–90 s. The first 5 s autoplay muted in many places: open on the product working, no logo intro. |
| Audio | Music you have a licence for; captions or on-screen text for anything said, since it autoplays muted. |
| Thumbnail | Steam picks a frame; upload a custom one (1920 × 1080) if the option is offered. |

Suggested cut:
1. 0–5 s: split screen, a person at a webcam and their avatar mirroring them exactly (smile, blink, head turn). No title card first.
2. 5–20 s: face close-up of perfect sync (brows, cheeks, mouth shapes), then hands and finger gestures.
3. 20–35 s: the avatar appearing as the camera in a video call and in an OBS scene ("Shows up as a webcam in Zoom, Meet, Discord and OBS").
4. 35–50 s: emote hotkeys from a gamepad (wave, cheer), cloth and hair moving, a quick tour of the 3D environments.
5. 50–60 s: model library, "Bring your own VRM", "Open source, MIT", logo, "Free demo available".

Also make a **short GIF/WebM loop** (≤ 5 MB) per section for the About This Software images referenced in `about.bbcode` (`vpuppet_banner_face.gif`, `vpuppet_hands.gif`, `vpuppet_environments.png`), at most 616 px wide (the About section's content width). Upload them as Store page → "Additional images" / extras.
