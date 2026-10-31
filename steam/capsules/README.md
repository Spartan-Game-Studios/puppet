# Capsules

Every Steam image is composed by `make_capsules.py` from two kinds of input:

- **The logo** comes from `source/base.webp` (1672×941), the original key art. It is re-rendered from thresholded masks of that image so it stays sharp at any size, in flat ink `#0a0a0a` and orange `#ff3b00`. The image model never draws the logo or any text.
- **The art** is a set of text-free plates in `source/ai/`, made by `gen.py` as edits of the key art so the character and style match.

```bash
python3 steam/capsules/make_capsules.py           # writes out/*.png
python3 steam/capsules/make_capsules.py --sheet   # also out/_contact_sheet.png (review only, gitignored)
```

Every capsule is a crop of one plate, and plates are only ever scaled down. The library hero is a native crop of the 3840 px plate. Before the logo is pasted, the script paints out any decorative squares under it. It refuses to place the logo where its ink would land on a dark area.

| File | Size | Steamworks slot | Plate |
|---|---|---|---|
| `header_capsule.png` | 920×430 | Store: header capsule | `landscape_right` |
| `small_capsule.png` | 462×174 | Store: small capsule (logo without tagline) | `landscape_right` (face) |
| `main_capsule.png` | 1232×706 | Store: main capsule | `landscape_right` |
| `vertical_capsule.png` | 748×896 | Store: vertical capsule | `portrait` (marionette, both hands) |
| `page_background.png` | 1438×810 | Store: page background | `clean_landscape`, blurred and darkened |
| `library_capsule.png` | 600×900 | Library: capsule | `portrait_peace_room` (peace sign and wave) |
| `library_header.png` | 920×430 | Library: header | `landscape_right` |
| `library_hero.png` | 3840×1240 | Library: hero (no logo; Steam overlays `library_logo`) | `wide_hero`, native |
| `library_logo.png` | 1280×720 | Library: logo (transparent) | logo only |
| `community_icon.png` | 184×184 | Community icon | the V block from the logo |
| `event_cover.png` | 800×450 | Events: cover | `landscape_right` |
| `event_header.png` | 1920×622 | Events: header | `wide_hero` |

## The AI plates (`source/ai/`)

They were made with OpenAI `gpt-image-2.5-sunburst` through `/v1/images/edits`, at `quality: high`, on 2026-10-31. Each plate has a `.json` sidecar with its exact prompt, reference image, size and token usage.

| Plate | Size | Made from |
|---|---|---|
| `clean_landscape.png` | 2560×1440 | `base.webp` with the logo, menu, slogan and fake UI removed |
| `landscape_right.png` | 2560×1440 | `clean_landscape`, with the CRT moved into the right 58% |
| `wide_hero.png` | 3840×1280 | `clean_landscape`, extended to 3:1 with the avatar on the right |
| `portrait.png` | 1536×2304 | `clean_landscape`, upper body with both hands in frame |
| `portrait_peace.png` | 1536×2304 | `clean_landscape`, new pose: peace sign and an open-hand wave |
| `portrait_peace_room.png` | 1536×2304 | `portrait_peace`, zoomed out to leave room for the logo |
| `cutout.png` | 1024×1536 | `clean_landscape`, the avatar on a transparent background (not used yet; for compositing) |

To regenerate, run one of the following. Each call writes `<job>-<k>.png`. Pick the best result and rename it to `<job>.png`. Move the rest to `source/ai/rejects/`, which is gitignored.

```bash
OPENAI_API_KEY="$(security find-generic-password -s Underdot -a openai-api-key -w)" \
  python3 steam/capsules/gen.py <job> [--n 2]
python3 steam/capsules/gen.py --list
```

The plate geometry hard-coded in `make_capsules.py` (where the CRT starts, where the head top sits, the face box) is measured on these particular plates. Re-measure it after replacing a plate.

## Steamworks content survey

Declare AI-generated content. The original key art (`base.webp`) is AI-generated. So are all the plates above, and they are in every capsule except `library_logo` and `community_icon`. Those two are only the logo, which itself comes from the AI key art. The logo is re-rendered procedurally, and no AI-generated text appears in any capsule.
