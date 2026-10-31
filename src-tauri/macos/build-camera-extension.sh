#!/usr/bin/env bash
# Build VPuppet's CoreMediaIO Camera Extension as a universal (arm64 + x86_64)
# .systemextension bundle, ready to embed at
# VPuppet.app/Contents/Library/SystemExtensions/ (tauri.macos.conf.json copies
# it there; this script runs as the beforeBundleCommand).
#
# Signing (all optional; without them the bundle is ad-hoc signed, which is
# enough to build and inspect but macOS will refuse to install it):
#   APPLE_SIGNING_IDENTITY   "Developer ID Application: Name (TEAMID)"
#   APPLE_TEAM_ID            10-character team ID (Mach service + app group prefix)
#   PUPPET_CAMEXT_PROFILE    path to the extension's Developer ID provisioning
#                            profile (.provisionprofile), embedded if given
#
# Output: src-tauri/macos/build/com.spartangamestudios.vpuppet.camera.systemextension
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/camera-extension"
OUT_DIR="$HERE/build"
ID="com.spartangamestudios.vpuppet.camera"
BUNDLE="$OUT_DIR/$ID.systemextension"
TEAM_ID="${APPLE_TEAM_ID:-0000000000}"
IDENTITY="${APPLE_SIGNING_IDENTITY:--}"
VERSION="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$HERE/../tauri.conf.json" | head -1)"
# Extension build number (CFBundleVersion). Bump camera-extension/BUILD on
# every change to the extension: macOS only replaces an installed extension
# whose CFBundleVersion differs, and the app shows NEEDS UPDATE on a mismatch.
BUILD="$(tr -d '[:space:]' < "$SRC/BUILD")"
MIN_OS="12.3"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "build-camera-extension: not macOS, skipping" >&2
  exit 0
fi

echo "build-camera-extension: $ID $VERSION build $BUILD (team $TEAM_ID, identity ${IDENTITY})"
rm -rf "$BUNDLE" "$OUT_DIR/obj"
mkdir -p "$BUNDLE/Contents/MacOS" "$OUT_DIR/obj"

# 1. Compile for both architectures and merge.
for arch in arm64 x86_64; do
  xcrun swiftc -O -whole-module-optimization \
    -target "$arch-apple-macos$MIN_OS" \
    -module-name PuppetCamera \
    -o "$OUT_DIR/obj/$ID-$arch" \
    "$SRC/main.swift" "$SRC/Provider.swift"
done
xcrun lipo -create -output "$BUNDLE/Contents/MacOS/$ID" "$OUT_DIR/obj/$ID-arm64" "$OUT_DIR/obj/$ID-x86_64"

# 2. Info.plist.
sed -e "s/@TEAM_ID@/$TEAM_ID/g" -e "s/@VERSION@/$VERSION/g" -e "s/@BUILD@/$BUILD/g" "$SRC/Info.plist.in" > "$BUNDLE/Contents/Info.plist"
plutil -lint "$BUNDLE/Contents/Info.plist" >/dev/null

# 3. Entitlements (+ provisioning profile when signing for real).
PROFILE_ENT=""
if [[ -n "${PUPPET_CAMEXT_PROFILE:-}" ]]; then
  cp "$PUPPET_CAMEXT_PROFILE" "$BUNDLE/Contents/embedded.provisionprofile"
  PROFILE_ENT="  <key>com.apple.application-identifier</key>
  <string>$TEAM_ID.$ID</string>
  <key>com.apple.developer.team-identifier</key>
  <string>$TEAM_ID</string>
"
fi
ENT="$OUT_DIR/obj/extension.entitlements"
python3 - "$SRC/Extension.entitlements.in" "$ENT" "$TEAM_ID" "$PROFILE_ENT" <<'PY'
import sys
src, dst, team, prof = sys.argv[1:5]
s = open(src).read().replace("@TEAM_ID@", team).replace("@PROFILE_ENTITLEMENTS@", prof)
open(dst, "w").write(s)
PY
plutil -lint "$ENT" >/dev/null

# 4. Sign. Hardened runtime + secure timestamp for a real identity.
if [[ "$IDENTITY" == "-" ]]; then
  codesign --force --sign - --entitlements "$ENT" --generate-entitlement-der "$BUNDLE"
else
  codesign --force --sign "$IDENTITY" --options runtime --timestamp --entitlements "$ENT" --generate-entitlement-der "$BUNDLE"
fi
codesign --verify --strict --verbose=1 "$BUNDLE"
echo "build-camera-extension: wrote $BUNDLE"
