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

Title and end cards bracket the steps.

## Music

The music bed is synthesised by `music.py` (numpy and scipy, no samples), so there is nothing to license. It is a soft pad at 72 bpm in D major (Dmaj7, Bm7, Gmaj7, Asus4), with a pluck arpeggio and a faint shaker during the steps, resolving on D under the end card, normalised to -20 LUFS. `steam-trailer.mjs` renders it to the recording's exact length. To rescore existing MP4s without re-recording:

```bash
python3 steam/trailer/music.py 61.17 bed.wav
ffmpeg -i setup-guide-en.mp4 -i bed.wav -map 0:v -map 1:a -c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart out.mp4
``` The end card says "Free demo: every feature for 100 hours" and "Wishlist on Steam".

Tracking is real: the performer clip plays as the webcam and the hero follows it. Render the performer from a model with a realistic face, because MediaPipe finds no face on the cartoon CC0 avatars. The camera preview stays minimised, so the performer is never on screen.

The script makes two adjustments before the reveal, both of which a user could also make:

- It sets a calibration baseline.
- It steepens the jawOpen, funnel and pucker curves, because the rendered performer's black lips otherwise read as a slightly open mouth.

The hero (Morrígan) is served from memory and never written to the repo, the same as for `steam/screenshots`.
