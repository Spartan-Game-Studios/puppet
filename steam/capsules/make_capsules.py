"""Build every Steam capsule size from the AI art plates and the original logo.

    python3 steam/capsules/make_capsules.py [--sheet]

Inputs:
  - source/base.webp (1672x941), the original key art. Only its logo is used:
    re-rendered from thresholded masks so it stays crisp at any size (flat ink
    and orange, transparent background). The image model never draws the logo.
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
from PIL import Image, ImageDraw, ImageFilter
from scipy import ndimage

HERE = Path(__file__).resolve().parent
SRC = HERE / "source" / "base.webp"
AI = HERE / "source" / "ai"


def _plate_path(name):
    """A plate, stored as lossless WebP (gen.py writes PNG; convert with cwebp -lossless -exact)."""
    webp = AI / f"{name}.webp"
    return webp if webp.exists() else AI / f"{name}.png"
OUT = HERE / "out"

INK = (10, 10, 10)        # #0a0a0a
ORANGE = (255, 59, 0)     # #ff3b00

# Logo geometry in base.webp.
LOGO_BOX = (52, 60, 790, 236)   # logo incl. tagline, in source px
TAGLINE_Y = 200                 # source y where the tagline starts
V_BOX = (56, 64, 186, 226)      # the orange V block


# ---------------------------------------------------------------- logo

def masks(src):
    """(ink, orange) masks of the logo region, as float arrays 0..1."""
    a = np.asarray(src.crop(LOGO_BOX)).astype(float)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    lum = 0.299 * r + 0.587 * g + 0.114 * b
    orange = (r > 170) & (g < 130) & (b < 100)
    ink = (lum < 110) & ~orange
    # Drop the corner bracket decoration right of the tagline.
    x0, y0 = LOGO_BOX[0], LOGO_BOX[1]
    ink[TAGLINE_Y - 15 - y0 :, 610 - x0 :] = False
    return ink.astype(float), orange.astype(float)


def render_logo(src, width, tagline=True):
    """The logo at `width` px, crisp: masks upscaled smoothly, re-thresholded."""
    ink, orange = masks(src)
    if not tagline:
        cut = TAGLINE_Y - LOGO_BOX[1] - 4
        ink, orange = ink[:cut], orange[:cut]
    h0, w0 = ink.shape
    k = width / w0
    size = (width, max(1, round(h0 * k)))

    def up(m):
        im = Image.fromarray((m * 255).astype(np.uint8)).resize(size, Image.LANCZOS)
        im = im.filter(ImageFilter.GaussianBlur(max(0.6, k * 0.35)))
        return np.asarray(im).astype(float) / 255

    mi, mo = up(ink), up(orange)
    edge = lambda m: np.clip((m - 0.5) * 6 + 0.5, 0, 1)
    ai, ao = edge(mi), edge(mo)
    alpha = np.maximum(ao, ai)
    rgb = (np.array(ORANGE) * (ao * (1 - ai))[..., None] + np.array(INK) * ai[..., None]) / np.maximum(alpha, 1e-6)[..., None]
    out = np.dstack([rgb, alpha * 255])
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))


def icon(src, size):
    """The orange V block alone, square."""
    a = np.asarray(src.crop(V_BOX)).astype(float)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    ink = ((0.299 * r + 0.587 * g + 0.114 * b) < 90) & (r < 120)
    ink[:, :6] = ink[:, -6:] = False
    ink[:6] = ink[-6:] = False
    ink = ink.astype(float)
    ys, xs = np.nonzero(ink > 0.5)
    ink = ink[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1]
    h0, w0 = ink.shape
    k = size * 0.72 / h0
    vw, vh = round(w0 * k), round(h0 * k)
    m = Image.fromarray((ink * 255).astype(np.uint8)).resize((vw, vh), Image.LANCZOS)
    m = Image.fromarray((np.clip((np.asarray(m) / 255 - 0.5) * 6 + 0.5, 0, 1) * 255).astype(np.uint8))
    canvas = Image.new("RGB", (size, size), ORANGE)
    canvas.paste(Image.new("RGB", (vw, vh), INK), ((size - vw) // 2, (size - vh) // 2), m)
    return canvas


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


def landscape(src, pl, W, H, logo_frac, tagline=True, name=""):
    """landscape_right, full width (or full height if narrower), logo on the left
    calm paper, vertically centred on the band above the CRT's bottom."""
    PW, PH = pl.size
    calm_x = 1030                         # CRT/avatar start at x=1058 in the plate
    if PW / PH < W / H:                   # wider than the plate: crop height
        h = PW * H / W
        y0 = min(max(150, 0), PH - h)     # keep the CRT top (y=160)
        box = (0, y0, PW, y0 + h)
    else:                                 # narrower: crop the right edge only
        w = PH * W / H
        x0 = max(0.0, min(PW, 2550) - w)  # keep the CRT's right edge (x=2530)
        box = (x0, 0, x0 + w, PH)
    s = W / (box[2] - box[0])
    # The plate's few decorative squares sit at the far left, where the crops
    # cut them in half: clear the whole calm area first.
    canvas = crop_fit(clear_specks(pl, (0, 0, calm_x - 40, PH)), box, W, H)
    calm_w = (calm_x - box[0]) * s
    margin, gap = round(W * 0.035), round(W * 0.015)   # left edge, gap to the CRT
    logo = render_logo(src, round(min(calm_w - margin - gap, W * logo_frac)), tagline)
    y = round(H * 0.44 - logo.height / 2)
    return put_logo(canvas, logo, (margin, y), name)


def small(src, pl, W, H):
    """Logo (no tagline) on calm paper at left, the face tight on the right."""
    face = (1450, 400, 1990, 900)                       # in landscape_right
    s = H / (face[3] - face[1])
    fw = round((face[2] - face[0]) * s)
    paper = crop_fit(pl, (0, 300, (W - fw) / s, 300 + H / s), W - fw, H)
    canvas = Image.new("RGB", (W, H))
    canvas.paste(paper, (0, 0))
    canvas.paste(crop_fit(pl, face, fw, H), (W - fw, 0))
    logo = render_logo(src, W - fw - 28, tagline=False)
    return put_logo(canvas, logo, (14, (H - logo.height) // 2), "small_capsule")


def portrait(src, pl, W, H, y0, band, logo_frac, name):
    """A portrait plate cropped to W:H from y0 (full width), logo centred in the
    paper band above the head (`band` = plate y of the head top)."""
    PW, PH = pl.size
    h = PW * H / W
    assert y0 + h <= PH
    s = W / PW
    canvas = crop_fit(pl, (0, y0, PW, y0 + h), W, H)
    logo = render_logo(src, round(W * logo_frac))
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
    src = Image.open(SRC).convert("RGB")
    assert src.size == (1672, 941), f"logo coordinates are for 1672x941, got {src.size}"
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

    # Store
    save("header_capsule", landscape(src, lr, 920, 430, 0.40, name="header_capsule"))
    save("small_capsule", small(src, lr, 462, 174))
    save("main_capsule", landscape(src, lr, 1232, 706, 0.40, name="main_capsule"))
    save("vertical_capsule", portrait(src, por, 748, 896, y0=150, band=600, logo_frac=0.80, name="vertical_capsule"))
    save("page_background", page_background(plate("clean_landscape"), 1438, 810))
    # Library
    save("library_capsule", portrait(src, peace, 600, 900, y0=0, band=740, logo_frac=0.84, name="library_capsule"))
    save("library_header", landscape(src, lr, 920, 430, 0.40, name="library_header"))
    # Hero: native crop of the wide plate (3840 wide), no logo (Steam overlays library_logo).
    save("library_hero", wide.crop((0, 20, 3840, 1260)))
    logo = render_logo(src, 1200, tagline=True)
    ll = Image.new("RGBA", (1280, 720), (0, 0, 0, 0))
    ll.alpha_composite(logo, ((1280 - logo.width) // 2, (720 - logo.height) // 2))
    save("library_logo", ll)
    # Community / events
    save("community_icon", icon(src, 184))
    save("event_cover", landscape(src, lr, 800, 450, 0.40, name="event_cover"))
    eh = crop_fit(wide, (0, 18, 3840, 18 + 3840 * 622 / 1920), 1920, 622)
    lg = render_logo(src, 820)
    save("event_header", put_logo(eh, lg, (round(1920 * 0.06), round(622 * 0.46 - lg.height / 2)), "event_header"))

    if "--sheet" in sys.argv:
        contact_sheet(names)


if __name__ == "__main__":
    main()
