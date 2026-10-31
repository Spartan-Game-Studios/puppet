# Legal notes (EULA and licences)

Not legal advice. These are the facts the EULA and the Steamworks legal fields need to reflect; have the final EULA text reviewed.

## Which EULA

- Steam offers the **Steam Subscriber Agreement** default terms. A custom EULA is optional (Store page → Legal / EULA). If used, Steam shows it before first launch.
- Recommendation: use Steam's default terms plus a short custom EULA that only covers the points below. Don't write anything that contradicts the MIT licence of the source.

## Points the EULA (or a "Licences" page) must cover

1. **The source code is MIT-licensed.** VPuppet's source is published at `<GITHUB_URL>` under the MIT License (`LICENSE` in the repository). Buying on Steam pays for the compiled, signed, Steam-updated build and support; it does not restrict anyone's rights under the MIT licence, and the EULA must not claim it does (no "you may not reverse engineer / redistribute the software" boilerplate aimed at the code).
2. **What the Steam purchase covers:** the build distributed through Steam, updates through Steam, and support at `<SUPPORT_URL>` / `<SUPPORT_EMAIL>`. The VPuppet name, logo and store artwork are not covered by the MIT licence (state that trademarks and artwork are reserved, if that is the intent; the MIT licence covers code, not branding).
3. **Third-party components.** The app includes third-party software under its own licences: three.js, @pixiv/three-vrm, Google MediaPipe Tasks Vision and its models (Apache-2.0), Tauri, rosc, softcam (Windows), JetBrains Mono (SIL OFL 1.1), Quaternius Universal Animation Library clips (CC0), and others. The full list with versions and licences is in `THIRD_PARTY_NOTICES.md`. **Ship that file in every depot** (and the softcam licence, which the Windows build already bundles as `LICENSE-softcam.txt`) and reference it from the EULA. Apache-2.0 requires the licence text and any NOTICE files to accompany redistribution; check the MediaPipe package for a NOTICE file before the first upload.
4. **Avatars and other imported content are the user's responsibility.** VPuppet ships no avatars. Users import their own VRM models, animation clips, scenes and skies. The user must have the right to use each one for their purpose (streaming, commercial use, etc.). VPuppet reads and shows each VRM's licence metadata as information only; it does not enforce it and does not verify it. Mixamo and similar clip libraries have their own terms on redistribution.
5. **Privacy.** Camera and microphone input is processed locally; no images, audio or tracking data are sent to Spartan Game Studios or anyone else. Network output happens only when the user turns on VMC, to the address the user sets. The Steam build talks to Steam (ownership, the demo's usage stat). No analytics or telemetry. (Keep this true; if telemetry is ever added, the EULA and privacy policy must change first.)
6. **Demo.** The demo is the full application, usable for 100 hours of use. After that, tracking output, the virtual camera and VMC output stop working in the demo; imported models remain on the user's disk and in the library. Usage time is recorded as a Steam stat on the user's account.
7. **Virtual camera driver.** On Windows, registering the virtual camera installs a DirectShow component (softcam) system-wide with administrator rights; on macOS it installs a system camera extension after user approval. Say how to remove each (the app's UNINSTALL on macOS; unregister on Windows).
8. **No warranty / limitation of liability:** standard; it matches the MIT licence's own disclaimer.

## Steamworks fields

- **Copyright line:** "© <YEAR> Spartan Game Studios. VPuppet's source code is available under the MIT License."
- **Third-party copyright notices** (Store page → Legal lines, shown at the bottom of the store page): "Uses Google MediaPipe (Apache-2.0), three.js (MIT), three-vrm (MIT), Tauri (MIT/Apache-2.0). See THIRD_PARTY_NOTICES.md."
- **Ratings:** software is generally exempt from age ratings; complete the content survey (see `../README.md`) and decline IARC unless Valve asks.

## Avatar licences shown in screenshots and the trailer

Every avatar shown on the store page, in screenshots, GIFs or the trailer must be one Spartan Game Studios has the right to use commercially in advertising: commissioned with that right in writing, the studio's own, or CC0 (e.g. the CC0 test avatars in `test-assets/cc0/`). A VRoid Hub model marked "commercial use OK" is not automatically OK for advertising a product; check the specific terms or ask the author. Keep the source and licence of each avatar used in marketing in a list next to the assets.
