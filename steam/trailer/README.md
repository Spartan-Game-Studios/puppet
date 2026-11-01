# Trailer

`setup-guide-<lang>.mp4` (en, ru, zh-CN, es) is a one-minute setup guide recorded from the real app UI. It runs 1920×1080 at 60 fps, H.264 with AAC audio, and is about 53 MB. The files are git-ignored, so rebuild them with:

```bash
PUPPET_URL=http://localhost:5173 PUPPET_MODEL=hero.vrm node scripts/render-clip.mjs perf/   # the "webcam" performer
node scripts/steam-trailer.mjs hero.vrm perf/ [--lang en,ru,zh-CN,es]
```

The trailer has six steps:

1. Import a VRM.
2. Webcam tracking of face, body and hands.
3. Calibrate with `C`.
4. Framing and 3D scenes.
5. Emotes from hotkeys or a gamepad.
6. `W` and "VPuppet Virtual Camera" in Zoom, Meet, Discord or OBS.

Title and end cards bracket the steps. The end card says "Free demo: every feature for 100 hours" and "Wishlist on Steam".

## Music

The current trailers use "Ambience 3" from the *50 Cozy Fantasy RPG Tracks* pack (the loop version). It is a licensed track, so it stays out of the repo; pass it with `--music`. `music.py` loops the track to the recording's length, fades it in and out, and normalises it to -32 LUFS so it stays a quiet bed:

```bash
node scripts/steam-trailer.mjs hero.vrm perf/ --music ".../Loops/mp3/Ambience 3.mp3"
```

Without `--music`, `music.py` synthesises a bed instead, with numpy and scipy and no samples, so there is nothing to license. It is a soft pad at 72 bpm in D major. To rescore existing MP4s without re-recording:

```bash
python3 steam/trailer/music.py 61.2 bed.wav [track.mp3]
ffmpeg -i setup-guide-en.mp4 -i bed.wav -map 0:v -map 1:a -c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart out.mp4
```

## How it is made

Tracking is real: the performer clip plays as the webcam and the hero follows it. Render the performer from a model with a realistic face, because MediaPipe finds no face on the cartoon CC0 avatars. The camera preview stays minimised, so the performer is never on screen.

The script makes three adjustments before the reveal, both of which a user could also make:

- It sets a calibration baseline.
- It raises Smoothing from 0.5 to 0.9, which cuts frame-to-frame arm jitter by about 60%. The added lag doesn't show, because the performer is off screen.
- It steepens the jawOpen, funnel and pucker curves, because the rendered performer's black lips otherwise read as a slightly open mouth.

The hero (Morrígan) is served from memory and never written to the repo, the same as for `steam/screenshots`.
