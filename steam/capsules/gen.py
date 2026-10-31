"""Generate the AI art plates for the Steam capsules (OpenAI Images API, edits).

    OPENAI_API_KEY=... python3 steam/capsules/gen.py <job> [<job> ...] [--n N] [--model M] [--quality Q]
    python3 steam/capsules/gen.py --list

Every job is an *edit* of a reference image (the original key art, or a plate
made from it), so the character, outfit and style stay consistent. The model is
never asked to draw the logo or any text: make_capsules.py overlays the logo,
re-rendered from the original key art.

Outputs land in source/ai/<job>[-k].png with a <job>[-k].json sidecar holding
the settings and token usage (never the key). Move rejects to source/ai/rejects/
(gitignored).

The key is read from the environment only. To use the macOS keychain entry:
    OPENAI_API_KEY="$(security find-generic-password -s Underdot -a openai-api-key -w)" \
        python3 steam/capsules/gen.py clean_landscape
"""
import base64
import io
import json
import os
import re
import sys
import time
from pathlib import Path

import requests
from PIL import Image

HERE = Path(__file__).resolve().parent
AI = HERE / "source" / "ai"


def _plate_path(name):
    """A plate, stored as lossless WebP (gen.py writes PNG; convert with cwebp -lossless -exact)."""
    webp = AI / f"{name}.webp"
    return webp if webp.exists() else AI / f"{name}.png"
BASE = HERE / "source" / "base.webp"

MODEL = "gpt-image-2.5-sunburst"
QUALITY = "high"
# Token rates for gpt-image-2.x (USD per 1M tokens), for the cost estimate.
RATE = {"image_in": 8.0, "text_in": 5.0, "image_out": 30.0}

STYLE = (
    "Keep the exact same art style as the reference: polished anime illustration, "
    "soft cel shading, a restrained brutalist palette of off-white paper (#f2f2ee), "
    "near-black ink (#0a0a0a) and a single accent of vivid red-orange (#ff3b00). "
    "Same character design as the reference: a young anime woman with shoulder-length "
    "messy silver-white hair, a red-orange X-shaped hair clip on her left side and small "
    "black hair ties, warm orange eyes, a gentle open-mouthed smile, a black choker with "
    "a metal O-ring, a black strap harness over a loose off-white blouse with puffed "
    "sleeves, black cuffs on her wrists and upper arms, black nail polish. Thin bright "
    "red-orange puppet strings run straight up from her wrist cuffs and shoulders out of "
    "the top of the frame. "
    "Hands must be anatomically correct: exactly five fingers on each hand, natural joints. "
    "ABSOLUTELY NO text, letters, numbers, words, logos, labels, captions, watermarks or "
    "signatures anywhere in the image."
)

PAPER = (
    "The background is plain light off-white grid paper: a faint, even, square grid of thin "
    "light-grey lines, like engineering paper, flat and uncluttered."
)

JOBS = {
    # 1. The base scene, all text and fake UI removed, at the largest 16:9 size.
    "clean_landscape": dict(
        ref="base",
        size="2560x1440",
        prompt=(
            "Recreate this exact illustration as a clean, text-free key art plate. Keep the "
            "composition, the camera, the character's pose and the black CRT television "
            "exactly as they are. Remove ALL text and graphic UI: remove the large 'VPUPPET' "
            "wordmark and its orange V block, the '3D AVATAR SOFTWARE' tagline, the "
            "CREATE / ANIMATE / LIVE / EXPORT menu buttons, the 'YOUR AVATAR YOUR CONTROL' "
            "slogan, the small crosshair marks and corner brackets, the little squares and "
            "swatches, and every small label or caption on the screen. Inside the CRT keep "
            "the dark scanline screen; replace the timeline bar, thumbnails and wireframe "
            "panels with plain dark screen texture. Continue the light grid paper naturally "
            "across the whole left side where the logo and menu were, so the left 40% of the "
            "image is calm, empty grid paper. " + PAPER + " " + STYLE
        ),
    ),
    # 1b. 16:9 with the scene pushed right, for the header / main / event capsules,
    # where the logo needs ~45% of the width on clean paper.
    "landscape_right": dict(
        ref="clean_landscape",
        size="2560x1440",
        prompt=(
            "Recompose this illustration: zoom out slightly and move the black CRT television "
            "with the character so the whole CRT sits in the right 55% of the frame, fully "
            "visible including its bottom edge, with a little paper margin on the right. Keep "
            "the character, pose, hands, lighting and style unchanged. The left 45% of the "
            "image must be calm, empty light grid paper (a logo will be placed there later), "
            "with at most two or three tiny orange and black square pixels near the far left "
            "edge. The puppet strings continue straight up out of the top edge. "
            + PAPER + " " + STYLE
        ),
    ),
    # 2. Ultra-wide plate for the library hero (3840x1240) and event header.
    "wide_hero": dict(
        ref="clean_landscape",
        size="3840x1280",
        prompt=(
            "Extend this illustration into an ultra-wide 3:1 panoramic banner. Keep the same "
            "character, pose, CRT television, lighting and style, unchanged, but place the "
            "CRT and the character in the right third of the frame, with her face roughly "
            "two-thirds of the way across from the left. Extend the scene to the left and "
            "right with more of the same light grid paper. The left half and centre of the "
            "banner must be calm, empty grid paper with lots of clear space (a logo will be "
            "placed there later); only a few tiny, sparse decorative orange and black square "
            "pixels near the edges. The puppet strings continue straight up out of the top "
            "edge. Full CRT visible, not cropped at the right. " + PAPER + " " + STYLE
        ),
    ),
    # 3. Portrait plate for the vertical (748x896) and library (600x900) capsules.
    "portrait": dict(
        ref="clean_landscape",
        size="1536x2304",
        prompt=(
            "Redraw this character as a tall portrait-format poster illustration. Show her "
            "full upper body from the top of her head down to her waist, facing the viewer, "
            "with BOTH hands fully inside the frame: her arms raised and held up by the "
            "puppet strings at the wrist cuffs like a marionette, hands relaxed and dangling "
            "gracefully at about shoulder height on either side of her head, all ten fingers "
            "clearly visible and correctly drawn. She leans slightly forward out of the "
            "front of the black CRT television, which frames her from behind at chest "
            "height and below. The top third of the image above her head is calm, empty "
            "light grid paper with only the thin orange strings running up through it (a "
            "logo will be placed there later). " + PAPER + " " + STYLE
        ),
    ),
    # 4. Cutout on transparency.
    "cutout": dict(
        ref="clean_landscape",
        size="1024x1536",
        background="transparent",
        prompt=(
            "Isolate this character as a clean cutout on a fully transparent background: "
            "the character alone, upper body to the waist, same pose as the reference with "
            "both arms raised and both hands fully visible, with the orange puppet strings "
            "running up from her wrist cuffs out of the top of the frame. No CRT, no screen, "
            "no grid, no background, no shadow, no floor. " + STYLE
        ),
    ),
    # 5. Alternative pose: peace sign (hand tracking is a selling point).
    "portrait_peace": dict(
        ref="clean_landscape",
        size="1536x2304",
        prompt=(
            "Redraw this character as a tall portrait-format poster illustration in a new "
            "pose: she smiles at the viewer and makes a cheerful peace sign (V sign) with her "
            "right hand next to her face, index and middle fingers up, the other fingers "
            "and thumb folded; her other hand waves at shoulder height with an open palm and "
            "five spread fingers. Both hands fully inside the frame and correctly drawn. "
            "Puppet strings still attach to her wrist cuffs and run straight up out of the "
            "top of the image. Upper body from the top of her head to her waist, the black "
            "CRT television behind her at chest height and below. The top third of the image "
            "above her head is calm, empty light grid paper with only the thin orange strings "
            "running up through it. " + PAPER + " " + STYLE
        ),
    ),
    # 5b. The peace-sign plate zoomed out: the 600x900 library capsule needs about
    # a third of the height above her head for the logo.
    "portrait_peace_room": dict(
        ref="portrait_peace",
        size="1536x2304",
        prompt=(
            "Zoom out on this exact illustration, keeping the character, the peace-sign and "
            "waving hands, the pose, the CRT and the style unchanged, so the top of her head "
            "sits about 38% of the way down from the top of the image. The space above her "
            "head is calm, empty light grid paper with only the thin orange puppet strings "
            "running straight up through it to the top edge. Both hands fully inside the "
            "frame, with at least a little paper margin left and right. Crop at her hips. "
            + PAPER + " " + STYLE
        ),
    ),
}


def ref_image(name):
    if name == "base":
        im = Image.open(BASE).convert("RGB")
    else:
        # A previous plate: source/ai/<name>.png (the chosen one is named without -k).
        im = Image.open(_plate_path(name)).convert("RGB")
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


def scrub(text):
    return re.sub(r"sk-[A-Za-z0-9_\-]{8,}", "sk-***", text)


def run(job, n, model, quality):
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        sys.exit("OPENAI_API_KEY is not set")
    spec = JOBS[job]
    data = {
        "model": model,
        "prompt": spec["prompt"],
        "size": spec["size"],
        "quality": quality,
        "n": str(n),
        "output_format": "png",
    }
    if "background" in spec:
        data["background"] = spec["background"]
    files = {"image[]": (f"{spec['ref']}.png", ref_image(spec["ref"]), "image/png")}
    t0 = time.time()
    r = requests.post(
        "https://api.openai.com/v1/images/edits",
        headers={"Authorization": f"Bearer {key}"},
        data=data,
        files=files,
        timeout=900,
    )
    if r.status_code != 200:
        sys.exit(f"{job}: HTTP {r.status_code}: {scrub(r.text)[:2000]}")
    body = r.json()
    AI.mkdir(parents=True, exist_ok=True)
    k0 = 1
    while (AI / f"{job}-{k0}.png").exists() or (AI / "rejects" / f"{job}-{k0}.png").exists():
        k0 += 1
    usage = body.get("usage", {})
    det = usage.get("input_tokens_details", {})
    cost = (
        det.get("image_tokens", 0) * RATE["image_in"]
        + det.get("text_tokens", 0) * RATE["text_in"]
        + usage.get("output_tokens", 0) * RATE["image_out"]
    ) / 1e6
    for i, item in enumerate(body["data"]):
        name = f"{job}-{k0 + i}"
        (AI / f"{name}.png").write_bytes(base64.b64decode(item["b64_json"]))
        meta = {k: v for k, v in data.items() if k != "prompt"}
        meta.update(ref=spec["ref"], prompt=spec["prompt"], usage=usage, est_cost_usd_for_request=round(cost, 3),
                    revised_prompt=item.get("revised_prompt"), seconds=round(time.time() - t0, 1))
        (AI / f"{name}.json").write_text(json.dumps(meta, indent=2))
        print(f"{name}.png  {spec['size']}  ~${cost / len(body['data']):.2f}  {time.time() - t0:.0f}s")


def main():
    args = sys.argv[1:]
    if not args or "--list" in args:
        print("\n".join(JOBS))
        return
    opts = {"--n": "1", "--model": MODEL, "--quality": QUALITY}
    jobs = []
    it = iter(args)
    for a in it:
        if a in opts:
            opts[a] = next(it)
        else:
            jobs.append(a)
    for job in jobs:
        run(job, int(opts["--n"]), opts["--model"], opts["--quality"])


if __name__ == "__main__":
    main()
