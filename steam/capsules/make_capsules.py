"""Build every Steam capsule size from the AI art plates and the VPuppet logo.

    python3 steam/capsules/make_capsules.py [--sheet]

Inputs:
  - source/fonts/Jersey10-Regular.ttf (SIL OFL 1.1, licence beside it): the
    logo is set in it, "V" on an orange block then "PUPPET", flat ink and
    orange on a transparent background. The image model never draws the logo.
  - source/ai/*.png, text-free plates made by gen.py from that key art:
      landscape_right      2560x1440  CRT + avatar in the right 58%, calm paper left
      wide_hero            3840x1280  ultra-wide, avatar right, calm paper left/centre
      portrait             1536x2304  marionette pose, both hands in frame
      portrait_peace_room  1536x2304  peace sign + wave, room for the logo on top
      clean_landscape      2560x1440  the original composition without text (page bg)

Every capsule is a crop of one plate (only ever downscaled, never upscaled)
with the logo on the plate's calm paper. Before the logo goes down, small
decorative squares under it are painted out, and the script refuses to put
ink on a dark area (asserts the paper under the logo is light).

--sheet also writes out/_contact_sheet.png (not a Steam asset).
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont
from scipy import ndimage

HERE = Path(__file__).resolve().parent
AI = HERE / "source" / "ai"


def _plate_path(name):
    """A plate, stored as lossless WebP (gen.py writes PNG; convert with cwebp -lossless -exact)."""
    webp = AI / f"{name}.webp"
    return webp if webp.exists() else AI / f"{name}.png"
OUT = HERE / "out"

INK = (10, 10, 10)        # #0a0a0a
ORANGE = (255, 59, 0)     # #ff3b00

FONT = HERE / "source" / "fonts" / "Jersey10-Regular.ttf"
TAGLINE = "3D AVATAR SOFTWARE"


# ---------------------------------------------------------------- logo

def _text(draw, xy, text, font, fill, spacing=0):
    """Draw `text` with extra `spacing` px between letters; returns the end x."""
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=font, fill=fill)
        x += draw.textlength(ch, font=font) + spacing
    return x - spacing


def render_logo(width, tagline=True):
    """The logo at `width` px: drawn 4x large in Jersey 10, then downscaled."""
    big = 640                                   # font px at 4x
    f = ImageFont.truetype(str(FONT), big)
    probe = ImageDraw.Draw(Image.new("L", (1, 1)))
    l, t, r, b = probe.textbbox((0, 0), "V", font=f)
    cap = b - t
    pad = round(cap * 0.16)                     # orange around the V
    gap = round(cap * 0.14)                     # block to "PUPPET"
    track = round(cap * 0.04)                   # letter spacing
    block_w, block_h = (r - l) + 2 * pad, cap + 2 * pad
    word_w = probe.textlength("PUPPET", font=f) + track * 5
    tag_f = ImageFont.truetype(str(FONT), round(big * 0.30))
    tag_h = round(cap * 0.42) if tagline else 0
    tag_w = probe.textlength(TAGLINE, font=tag_f) + round(cap * 0.08) * (len(TAGLINE) - 1)
    W = round(block_w + gap + max(word_w, tag_w if tagline else 0))
    im = Image.new("RGBA", (W, block_h + tag_h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rectangle((0, 0, block_w - 1, block_h - 1), fill=ORANGE)
    d.text((pad - l, pad - t), "V", font=f, fill=INK)
    _text(d, (block_w + gap, pad - t), "PUPPET", f, INK, track)
    if tagline:
        tb = probe.textbbox((0, 0), TAGLINE, font=tag_f)
        _text(d, (block_w + gap, block_h + tag_h * 0.35 - tb[1]), TAGLINE, tag_f, INK, round(cap * 0.08))
    im = im.crop(im.getbbox())
    return im.resize((width, max(1, round(im.height * width / im.width))), Image.LANCZOS)


def icon(size):
    """The orange V block alone, square."""
    f = ImageFont.truetype(str(FONT), size * 4)
    canvas = Image.new("RGB", (size * 4, size * 4), ORANGE)
    d = ImageDraw.Draw(canvas)
    l, t, r, b = d.textbbox((0, 0), "V", font=f)
    k = size * 4 * 0.72 / (b - t)
    f = ImageFont.truetype(str(FONT), round(size * 4 * k))
    l, t, r, b = d.textbbox((0, 0), "V", font=f)
    d.text(((size * 4 - (r - l)) / 2 - l, (size * 4 - (b - t)) / 2 - t), "V", font=f, fill=INK)
    return canvas.resize((size, size), Image.LANCZOS)


# ---------------------------------------------------------------- plates

def plate(name):
    return Image.open(_plate_path(name)).convert("RGB")


def lum(a):
    return a[..., 0] * 0.299 + a[..., 1] * 0.587 + a[..., 2] * 0.114


def clear_specks(im, box, pad=8):
    """Paint out small dark/orange marks (the plates' decorative squares)
    inside `box`: each column is filled from the clean paper just above the
    mark, so the vertical grid lines carry on through it. Thin strings (tall,
    narrow components) are left alone."""
    a = np.asarray(im).astype(float).copy()
    x0, y0, x1, y1 = [int(v) for v in box]
    sub = a[y0:y1, x0:x1]
    obj = (lum(sub) < 200) | ((sub.max(2) - sub.min(2)) > 60)
    lab, _ = ndimage.label(obj)
    for sl in ndimage.find_objects(lab):
        h, w = sl[0].stop - sl[0].start, sl[1].stop - sl[1].start
        if h > 3 * max(w, 1) and h > 60:      # a puppet string: keep
            continue
        if h * w > 120 * 120:                 # not a speck: leave for the check
            continue
        ya, yb = y0 + sl[0].start - pad, y0 + sl[0].stop + pad
        xa, xb = x0 + sl[1].start - pad, x0 + sl[1].stop + pad
        ya, xa = max(ya, 1), max(xa, 0)
        src_row = a[ya - 1 : ya, xa:xb]
        a[ya:yb, xa:xb] = src_row + np.random.default_rng(ya).normal(0, 1.5, (yb - ya, xb - xa, 1))
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))


def put_logo(canvas, logo, xy, name):
    """Paste the logo, after checking that it sits on light paper."""
    x, y = xy
    box = (x, y, x + logo.width, y + logo.height)
    canvas = clear_specks(canvas, box)
    under = np.asarray(canvas.crop(box)).astype(float)
    ink = np.asarray(logo)[..., 3] > 128
    # Dark = low luminance and unsaturated (the orange strings may pass behind).
    dark = (lum(under) < 100) & ((under.max(2) - under.min(2)) < 60) & ink
    assert dark.mean() < 0.002, f"{name}: logo over a dark area ({dark.mean():.2%} of it)"
    canvas.paste(logo, (x, y), logo)
    return canvas


def crop_fit(im, box, W, H):
    """Crop `box` (x0, y0, x1, y1) from a plate and downscale it to W x H."""
    c = im.crop(tuple(round(v) for v in box))
    assert c.width >= W and c.height >= H, f"would upscale {c.size} -> {(W, H)}"
    return c.resize((W, H), Image.LANCZOS)


GRID = 75  # the plates' paper grid period, px (vertical lines at x = 37 + 75k)


ROW = 80   # the paper's horizontal grid period, px (lines at y = 1327, 1407, ...)
STRIP = 8 * GRID  # width of the calm paper strip that widen() repeats


def widen(pl, extra, calm_x, below=0):
    """Prepend `extra` px (a whole number of grid cells) of the plate's own
    calm paper on the left, repeating one strip, so the grid runs on unbroken
    into the original; then add `below` px (whole grid rows) of the bottom
    band of clean paper under it, which lets the art be scaled down further."""
    assert extra % GRID == 0 and below % ROW == 0 and 2 * GRID + STRIP <= calm_x - 40
    strip = pl.crop((2 * GRID, 0, 2 * GRID + STRIP, pl.height))
    out = Image.new("RGB", (pl.width + extra, pl.height + below))
    for x in range(extra - STRIP, -STRIP, -STRIP):     # right to left, aligned at `extra`
        out.paste(strip, (x, 0))
    out.paste(pl, (extra, 0))
    band = out.crop((0, pl.height - ROW, out.width, pl.height))  # clean paper (CRT ends at y=1340)
    for y in range(pl.height, pl.height + below, ROW):
        out.paste(band, (0, y))
    return out


def landscape(pl, W, H, logo_frac, tagline=True, name="", extra=0, cut=0, below=0):
    """landscape_right, full width (or full height if narrower), logo on the left
    calm paper, vertically centred on the band above the CRT's bottom. `extra`
    widens the paper on the left and `below` under the art (see widen) and `cut` crops that many plate px
    off the CRT's right edge, together making room for a bigger logo."""
    calm_x = 1030                         # CRT/avatar start at x=1058 in the plate
    # The plate's few decorative squares sit at the far left, where the crops
    # cut them in half: clear the whole calm area first.
    pl = clear_specks(pl, (0, 0, calm_x - 40, pl.height))
    if extra or below:
        pl = widen(pl, extra, calm_x, below)
    calm_x += extra
    PW, PH = pl.size
    if PW / PH < W / H:                   # wider than the plate: crop height
        h = PW * H / W
        y0 = min(max(150, 0), PH - h)     # keep the CRT top (y=160)
        box = (0, y0, PW, y0 + h)
    else:                                 # narrower: crop the right edge only
        w = PH * W / H
        x0 = max(0.0, min(PW, 2550 + extra - cut) - w)  # CRT's right edge is x=2530
        box = (x0, 0, x0 + w, PH)
    s = W / (box[2] - box[0])
    canvas = crop_fit(pl, box, W, H)
    calm_w = (calm_x - box[0]) * s
    margin, gap = round(W * 0.035), round(W * 0.015)   # left edge, gap to the CRT
    logo = render_logo(round(min(calm_w - margin - gap, W * logo_frac)), tagline)
    # Centred on the CRT (plate y 160..1300), or a little low on uncropped plates.
    y = round(((160 + 1300) / 2 - box[1]) * s - logo.height / 2) if below else round(H * 0.44 - logo.height / 2)
    return put_logo(canvas, logo, (margin, y), name)


def small(pl, W, H):
    """Logo (no tagline) on calm paper at left, the face tight on the right."""
    face = (1450, 400, 1990, 900)                       # in landscape_right
    s = H / (face[3] - face[1])
    fw = round((face[2] - face[0]) * s)
    paper = crop_fit(pl, (0, 300, (W - fw) / s, 300 + H / s), W - fw, H)
    canvas = Image.new("RGB", (W, H))
    canvas.paste(paper, (0, 0))
    canvas.paste(crop_fit(pl, face, fw, H), (W - fw, 0))
    logo = render_logo(W - fw - 28, tagline=False)
    return put_logo(canvas, logo, (14, (H - logo.height) // 2), "small_capsule")


def portrait(pl, W, H, y0, band, logo_frac, name, tagline=True):
    """A portrait plate cropped to W:H from y0 (full width), logo centred in the
    paper band above the head (`band` = plate y of the head top)."""
    PW, PH = pl.size
    h = PW * H / W
    assert y0 + h <= PH
    s = W / PW
    canvas = crop_fit(pl, (0, y0, PW, y0 + h), W, H)
    logo = render_logo(round(W * logo_frac), tagline)
    band_h = (band - y0) * s
    assert logo.height < band_h - 30, f"{name}: no room above the head"
    y = round((band_h - logo.height) / 2)
    return put_logo(canvas, logo, ((W - logo.width) // 2, y), name)


def page_background(pl, W, H):
    """Dark, blurred, low contrast: Steam's page sits on it."""
    im = crop_fit(pl, (300, 0, pl.width, pl.width * 0 + pl.height), W, round(W * pl.height / (pl.width - 300)))
    im = im.crop((0, (im.height - H) // 2, W, (im.height - H) // 2 + H))
    im = im.filter(ImageFilter.GaussianBlur(14)).convert("L").convert("RGB")
    a = np.asarray(im).astype(float) * 0.22 + np.array([18, 14, 12])
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))


def contact_sheet(names):
    ims = [(n, Image.open(OUT / f"{n}.png")) for n in names]
    W = 1800
    x = y = 0
    row_h = 0
    placed = []
    for n, im in ims:
        k = min(1.0, 560 / im.height, (W - 40) / im.width)
        t = im.resize((round(im.width * k), round(im.height * k)), Image.LANCZOS)
        if x + t.width + 20 > W:
            x, y, row_h = 0, y + row_h + 40, 0
        placed.append((n, im.size, t, x + 20, y + 20))
        x += t.width + 20
        row_h = max(row_h, t.height)
    sheet = Image.new("RGB", (W, y + row_h + 70), (60, 60, 64))
    d = ImageDraw.Draw(sheet)
    for n, size, t, px, py in placed:
        if t.mode == "RGBA":
            bg = Image.new("RGBA", t.size, (120, 120, 126, 255))
            bg.alpha_composite(t)
            t = bg
        sheet.paste(t.convert("RGB"), (px, py))
        d.text((px, py + t.height + 4), f"{n} {size[0]}x{size[1]}", fill=(230, 230, 230))
    sheet.save(OUT / "_contact_sheet.png")


def main():
    lr = plate("landscape_right")
    wide = plate("wide_hero")
    por = plate("portrait")
    peace = plate("portrait_peace_room")
    OUT.mkdir(exist_ok=True)
    names = []

    def save(name, im):
        im.convert("RGBA" if name == "library_logo" else "RGB").save(OUT / f"{name}.png", optimize=True)
        names.append(name)
        print(f"{name:<22} {im.width}x{im.height}")

    # Store and library capsules: Valve allows only the logo as text on these
    # (no tagline), and the header's logo must fill at least a third of it.
    save("header_capsule", landscape(lr, 920, 430, 0.70, tagline=False, name="header_capsule", extra=1500, cut=250, below=320))
    save("small_capsule", small(lr, 462, 174))
    save("main_capsule", landscape(lr, 1232, 706, 0.70, tagline=False, name="main_capsule", extra=825, cut=300, below=320))
    save("vertical_capsule", portrait(por, 748, 896, y0=150, band=600, logo_frac=0.80, name="vertical_capsule", tagline=False))
    save("page_background", page_background(plate("clean_landscape"), 1438, 810))
    # Library
    save("library_capsule", portrait(peace, 600, 900, y0=0, band=740, logo_frac=0.84, name="library_capsule", tagline=False))
    save("library_header", landscape(lr, 920, 430, 0.70, tagline=False, name="library_header", extra=1500, cut=250, below=320))
    # Hero: native crop of the wide plate (3840 wide), no logo (Steam overlays library_logo).
    save("library_hero", wide.crop((0, 20, 3840, 1260)))
    logo = render_logo(1200, tagline=False)
    ll = Image.new("RGBA", (1280, 720), (0, 0, 0, 0))
    ll.alpha_composite(logo, ((1280 - logo.width) // 2, (720 - logo.height) // 2))
    save("library_logo", ll)
    # Community / events
    save("community_icon", icon(184))
    save("event_cover", landscape(lr, 800, 450, 0.40, name="event_cover"))
    eh = crop_fit(wide, (0, 18, 3840, 18 + 3840 * 622 / 1920), 1920, 622)
    lg = render_logo(820)
    save("event_header", put_logo(eh, lg, (round(1920 * 0.06), round(622 * 0.46 - lg.height / 2)), "event_header"))

    if "--sheet" in sys.argv:
        contact_sheet(names)


if __name__ == "__main__":
    main()
