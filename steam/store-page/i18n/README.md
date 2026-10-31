# Store page translations

Translations of the Steam store copy for the full app (`steam/store-page/i18n/`) and the demo (`steam/demo-page/i18n/`). Folder names are Steam's API language codes. **The English files are the source of truth:** when the English changes, update every language here in the same change, and don't add claims to a translation that the English doesn't make.

```
store-page/i18n/<lang>/              demo-page/i18n/<lang>/
├── short-description.txt            ├── short-description.txt
├── about.bbcode                     └── about.bbcode
├── features.md          (press kit / website, not pasted into Steam)
└── system-requirements.md
```

| Folder | Steamworks language | Notes |
|---|---|---|
| `russian` | Russian | |
| `schinese` | Simplified Chinese | |
| `spanish` | Spanish - Spain **and** Spanish - Latin America | One neutral Spanish (addresses the reader as *tú*, never *vosotros*; avoids regional words such as *ordenador*/*computadora*, *mando*/*control*, *en directo*/*en vivo* where a neutral word exists), written to read naturally in both. Paste the same files into both language slots. |

## Where each file goes in Steamworks

For each app (full app `<FULL_APP_ID>`, then the demo `<DEMO_APP_ID>` with the `demo-page/` files):

1. Steamworks → the app → **Store page admin** → **Description** tab.
2. Pick the language from the **language dropdown** at the top of the page (Russian, Simplified Chinese, Spanish - Spain, Spanish - Latin America). Each language has its own copy of every text field; untranslated fields fall back to English.
3. Paste:
   - `short-description.txt` → **Short Description** (≤ 300 characters; all files here are under that, see the counts below).
   - `about.bbcode` → **About This Software** (Steam's "About the Game" field). The `[img]{STEAM_APP_IMAGE}/extras/...[/img]` lines are unchanged from English and use the same uploaded images; upload them once in the English description and they work in every language.
4. **System Requirements** tab, same language dropdown: copy each row of the tables in `system-requirements.md` into the matching field (OS, Processor, Memory, Graphics, Storage, Additional Notes) on each OS tab.
5. Save, then **Publish** (Store page changes go to Valve's review with the rest of the page).

`features.md` is press-kit and website copy; it is not pasted into Steam.

Character counts (Python `len`, i.e. Unicode code points; Chinese counts one per character):

| File | English | Russian | Simplified Chinese | Spanish |
|---|---|---|---|---|
| `store-page/.../short-description.txt` | 269 | 290 | 168 | 282 |
| `demo-page/.../short-description.txt` | 271 | 290 | 128 | 297 |

Recount after any edit: `python3 -c "import glob; [print(len(open(f, encoding='utf-8').read()), f) for f in sorted(glob.glob('steam/*/short-description.txt') + glob.glob('steam/*/i18n/*/short-description.txt'))]"`

## Supported languages (Steamworks → Store page admin → Supported Languages)

Tick these, for both the full app and the demo, **once the app's UI translation ships** (until then, tick English only; the README's checklist item still applies):

| Language | Interface | Full audio | Subtitles |
|---|---|---|---|
| English | yes | n/a | n/a |
| Russian | yes | n/a | n/a |
| Simplified Chinese | yes | n/a | n/a |
| Spanish - Spain | yes | n/a | n/a |
| Spanish - Latin America | yes | n/a | n/a |

VPuppet has no voice-over and no subtitles, so leave Full audio and Subtitles unticked for every language.

## Terminology

Kept in Latin script / English in every language: VPuppet, VPuppet Virtual Camera (the device name users pick in Zoom/OBS), VRM, VMC, MediaPipe, ARKit, OBS, Zoom, Meet, Discord, VSeeFace, Warudo, VNyan, VRoid Studio, Mixamo, FBX, glTF, HDR, the app's own mode and button labels (FACE, +BODY, +HANDS, FALLBACK / BLEND / AUDIO, OFF / STIFF / NORMAL...) and key names. Translate those labels only once the app UI is translated, using the app's own strings.

| English | Russian | Simplified Chinese | Spanish |
|---|---|---|---|
| VTuber | VTuber / втубер | 虚拟主播（VTuber） | VTuber |
| perfect sync | perfect sync | 完美同步（Perfect Sync） | perfect sync |
| blendshape | блендшейп | BlendShape | blendshape |
| face tracking | трекинг лица | 面部捕捉 / 面部追踪 | seguimiento facial |
| emote | эмоут | 表情动作 | emote |
| lip sync | липсинк | 口型同步 | lip sync |
| spring bones | spring bones | Spring Bone（摇摆骨） | spring bones |
| chroma key | хромакей | 色度键 / 绿幕 | croma |
| retargeting | ретаргетинг | 重定向 | retargeting |
