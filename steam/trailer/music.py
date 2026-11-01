"""Quiet music bed for the trailer.

    python3 steam/trailer/music.py <seconds> <out.wav> [track]

With a track (any format ffmpeg reads), it is looped to the length, faded in
and out and normalised to -32 LUFS. Licensed tracks stay outside the repo.
Without one, a bed is synthesised from scratch (no samples, so nothing to
license):

72 bpm in D major: Dmaj7 - Bm7 - Gmaj7 - Asus4/A, two bars each, as a soft
detuned pad over a sine sub, with an eighth-note pluck arpeggio and a faint
shaker while the steps play. The pluck and shaker wait for the title card
(about 4 s) and stop before the end card, where the pad resolves on D. The
result is loudness-normalised by ffmpeg to -32 LUFS so it stays a bed.
"""
import subprocess
import sys
import tempfile

import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, fftconvolve, sosfilt

DUR, OUT = float(sys.argv[1]), sys.argv[2]
SR = 48000
LOUDNORM = "loudnorm=I=-32:TP=-3:LRA=11"

if len(sys.argv) > 3:
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-stream_loop", "-1", "-i", sys.argv[3], "-t", f"{DUR:.3f}",
         "-af", f"afade=in:d=1.5,afade=out:st={DUR - 3:.3f}:d=3,{LOUDNORM}", "-ar", str(SR), "-ac", "2", OUT],
        check=True,
    )
    print(OUT)
    sys.exit()
BEAT = 60 / 72
BAR = 4 * BEAT
INTRO, OUTRO = 3.8, 4.2   # title and end cards, in seconds
rng = np.random.default_rng(7)
n = int(DUR * SR)
t = np.arange(n) / SR


def hz(midi):
    return 440 * 2 ** ((midi - 69) / 12)


# Chords as MIDI notes (pad voicing); roots for the sub.
PROG = [
    ([62, 66, 69, 73], 38),   # Dmaj7
    ([59, 62, 66, 69], 35),   # Bm7
    ([55, 59, 62, 66], 31),   # Gmaj7
    ([57, 62, 64, 69], 33),   # Asus4
]
LAST = ([62, 66, 69, 74], 38)  # D, held under the end card


def env(length, attack, release):
    e = np.ones(length)
    a, r = min(int(attack * SR), length // 2), min(int(release * SR), length // 2)
    # Equal-power ramps, so overlapping chords cross-fade without a dip.
    e[:a] = np.sin(np.linspace(0, np.pi / 2, a))
    e[-r:] *= np.cos(np.linspace(0, np.pi / 2, r))
    return e


def saw(f, tt):
    # Band-limited enough at these pitches once low-passed.
    return 2 * ((f * tt) % 1) - 1


pad = np.zeros((n, 2))
sub = np.zeros(n)
# Chord spans: two bars each until the end card, then D to the end.
spans, s = [], 0.0
while s < DUR - OUTRO - 0.5:
    spans.append((s, min(s + 2 * BAR, DUR - OUTRO), PROG[len(spans) % 4]))
    s += 2 * BAR
spans.append((DUR - OUTRO, DUR, LAST))
XF = 1.2  # chords overlap by this much so they cross-fade
for k, (a, b, (notes, root)) in enumerate(spans):
    i0, i1 = int(max(0, a - XF / 2) * SR), int(min(DUR, b + XF / 2) * SR)
    tt = t[i0:i1]
    first, last = k == 0, k == len(spans) - 1
    e = env(i1 - i0, 2.5 if first else XF, 3.0 if last else XF)
    for m in notes:
        for ch, cents in ((0, -7), (1, 7), (0, 2), (1, -2)):
            f = hz(m) * 2 ** (cents / 1200)
            pad[i0:i1, ch] += saw(f, tt + rng.random()) * e * 0.05
    # Sub: soft sine root, swelling on each beat.
    beat_env = 0.6 + 0.4 * np.exp(-((tt - a) % BEAT) * 3)
    sub[i0:i1] += np.sin(2 * np.pi * hz(root) * tt) * e * beat_env * 0.07

lp = butter(2, 1100, "low", fs=SR, output="sos")
pad = sosfilt(lp, pad, axis=0)

# Pluck arpeggio and shaker while the steps play.
pluck = np.zeros((n, 2))
shaker = np.zeros((n, 2))
start, stop = INTRO + 0.2, DUR - OUTRO - 0.3
hp = butter(2, 6000, "high", fs=SR, output="sos")
noise = sosfilt(hp, rng.standard_normal(n))
step = 0
x = start
while x < stop:
    notes = next(c[0] for a, b, c in spans if a <= x < b)
    pattern = [notes[0] + 12, notes[2] + 12, notes[1] + 12, notes[3] + 12]
    f = hz(pattern[step % 4])
    i0 = int(x * SR)
    ln = min(int(1.4 * SR), n - i0)
    tt = np.arange(ln) / SR
    tone = (np.sin(2 * np.pi * f * tt) + 0.3 * np.sin(4 * np.pi * f * tt)) * np.exp(-tt * 4.5)
    tone *= np.minimum(1, tt / 0.004)
    pan = 0.5 + 0.25 * np.sin(step * 0.7)
    vel = 0.14 if step % 2 == 0 else 0.09
    pluck[i0 : i0 + ln, 0] += tone * vel * (1 - pan)
    pluck[i0 : i0 + ln, 1] += tone * vel * pan
    sl = min(int(0.12 * SR), n - i0)
    sh = noise[i0 : i0 + sl] * np.exp(-np.arange(sl) / SR * 40) * (0.025 if step % 2 else 0.012)
    shaker[i0 : i0 + sl, 0] += sh * 0.8
    shaker[i0 : i0 + sl, 1] += sh
    step += 1
    x += BEAT / 2
# Fade the arpeggio in and out rather than switching it.
ramp = np.clip(np.minimum((t - start) / 2.0, (stop + 0.5 - t) / 1.5), 0, 1)[:, None]
pluck *= ramp
shaker *= ramp

# Reverb: exponentially decaying stereo noise.
ir_len = int(2.6 * SR)
irt = np.arange(ir_len) / SR
ir = rng.standard_normal((ir_len, 2)) * np.exp(-irt * 2.6)[:, None]
ir = sosfilt(butter(1, 4000, "low", fs=SR, output="sos"), ir, axis=0)
ir /= np.sqrt((ir**2).sum(0))
dry = pad + pluck + shaker
wet = np.stack([fftconvolve(dry[:, c], ir[:, c])[:n] for c in range(2)], 1)
mix = dry * 0.75 + wet * 0.45 + sub[:, None]
mix = sosfilt(butter(2, 40, "high", fs=SR, output="sos"), mix, axis=0)  # no rumble

fade = np.clip(np.minimum(t / 1.5, (DUR - t) / 2.5), 0, 1)[:, None]
mix *= fade
mix /= np.abs(mix).max() * 1.05

with tempfile.NamedTemporaryFile(suffix=".wav") as raw:
    wavfile.write(raw.name, SR, (mix * 32767).astype(np.int16))
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", raw.name,
         "-af", LOUDNORM, "-ar", str(SR), OUT],
        check=True,
    )
print(OUT)
