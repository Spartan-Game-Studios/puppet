# VPuppet features

Plain-Markdown feature list for the press kit, website and other storefront fields. Every item here is described in the repo's `README.md`; keep it that way when editing (don't list anything the app doesn't do yet).

## Tracking (ordinary webcam, Google MediaPipe, runs locally)

- **Face:** the 52 ARKit blendshapes (all but `tongueOut`), head rotation and gaze.
- **Perfect sync:** models with ARKit-named expressions are driven 1:1 by name (detected at 40+ of 52). Other models get the VRM presets derived from the blendshapes: blink (both and per eye), the five vowels `aa` `ih` `ou` `ee` `oh`, and happy / angry / sad / surprised / relaxed (switchable).
- **Gaze** drives the model's look-at (bone or expression type).
- **Per-blendshape gain and curve,** edited live next to the raw and output values.
- **Calibrate** (`C`) captures your neutral face, head angle and gaze.
- **Smoothing:** one slider; blinks and jaw stay fast at every setting.
- **Upper body:** spine, chest, shoulders, clavicles and arms, with a true elbow hinge (0–150°), limited arm twist, and separately limited torso lean and twist.
- **Hands and fingers:** every finger joint, solved as anatomical angles and clamped to their ranges; thumb opposition; hands tracked in their own worker in parallel with the pose; both hands searched for in the full frame every frame.
- **Gestures:** fist, open palm, point, peace, thumbs up, OK and rock, per hand, with hysteresis so they don't flicker.
- **Modes:** FACE, +BODY, +HANDS; LITE / FULL pose model, switchable live.

## Output

- **Virtual camera** "VPuppet Virtual Camera" for Zoom, Meet, Discord, FaceTime, OBS and other camera apps: 1280×720 or 1920×1080 at 30 fps. Plain backgrounds are sent as a chroma-key colour (green by default); 3D environments are sent as rendered.
  - macOS 12.3+: CoreMediaIO camera extension inside the app.
  - Windows 10/11: DirectShow camera (one admin prompt to register).
  - Linux: a v4l2loopback device.
- **VMC protocol** over OSC/UDP: all humanoid bones, root, blendshapes; perfect-sync models also send the 13 VRM 0.x presets so preset-only receivers still see a moving face. Works with VSeeFace, Warudo, VNyan, VMC4U and other receivers, local or over the LAN.
- **Capture view** (`H`): all UI hidden, for clean window capture in OBS.
- Transparent, solid-colour (chroma-key presets) or image backgrounds.

## Physics

- **Bone-cloth solver** over the VRM's own spring bones: neighbouring chains (skirt rings, capes, hair fringes) linked into a lattice so panels move together.
- **Body colliders generated from the skeleton** and fitted to the mesh, alongside the model's own colliders; swept segment collisions so fast limbs don't tunnel through cloth.
- OFF / STIFF / NORMAL switch, per-chain and per-collider controls, saved per model.

## Motion and performance controls

- **Animation clips:** idle loops (breathe, look around, talking, arms folded) and emotes (nod, shake, cheer, angry, cry, dance, sit, drink, wave, clap, point, shrug, think, bow), layered over live tracking with face expressions still tracked.
- **Import your own** FBX / GLB clips; Mixamo, Unreal-mannequin / UAL and VRoid rigs detected by bone names; retargeted onto VRM 0.x and 1.0.
- **Hotkeys:** emotes and expressions (toggle, on, or hold) on keyboard, gamepad or hand gestures; optional system-wide keys; on-screen picker (`G` / pad RB); per-model bindings.
- **Mic lip sync:** FALLBACK (drives the mouth when the face isn't tracked), BLEND or AUDIO; off by default.

## Scenes

- **3D environments:** Studio Cyclorama, Cosy Room, Moor at Dusk, Night Clearing, Neon Grid, Concrete Hall, all procedural (no asset downloads).
- **Custom scenes:** your own `.glb` / `.gltf` with an equirectangular `.hdr` / `.exr` sky (image-based lighting).
- Light presets (scene, key, rim, soft), intensity, white balance, fog, ground shadow, idle sway, optional depth of field; LOW / HIGH quality.
- Bust / upper / full framing that scales with the avatar's size.

## Library and app

- **Model library** home screen: bust thumbnails, VRM version, perfect-sync coverage, triangle count, favourites, search, sort, rename; models deduplicated and copied into the app's own folder.
- **Licence display:** each VRM's author terms shown in plain language with a badge (author only, licensed only, CC0, commercial OK, solo commercial, personal, no terms). Information, not DRM.
- **Model checks:** common authoring problems flagged on load (face on the back of the head, missing bones, empty expressions).
- VRM 0.x and 1.0.
- Keyboard and gamepad navigation throughout (`Tab`, gamepad menu mode).
- macOS 12.3+, Windows 10/11, Linux.

## Open source

- MIT-licensed source on GitHub (`<GITHUB_URL>`). The Steam version is the signed, auto-updating, supported build.
