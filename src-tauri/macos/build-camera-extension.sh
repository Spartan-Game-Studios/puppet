#!/usr/bin/env bash
# Build VPuppet's CoreMediaIO Camera Extension as a universal (arm64 + x86_64)
# .systemextension bundle, and wrap it in "VPuppet Camera.app", the helper that
# installs it (camera-helper/main.swift). VPuppet embeds the helper at
# Contents/Helpers/ (tauri.macos.conf.json copies it there; this script runs as
# the beforeBundleCommand) and copies it to /Applications, the only place
# macOS activates system extensions from, so VPuppet itself can live anywhere
# (Steam installs it under ~/Library/Application Support/Steam).
#
# Signing (all optional; without them the bundle is ad-hoc signed, which is
# enough to build and inspect but macOS will refuse to install it):
#   APPLE_SIGNING_IDENTITY   "Developer ID Application: Name (TEAMID)"
#   APPLE_TEAM_ID            10-character team ID (Mach service + app group prefix)
#   PUPPET_CAMEXT_PROFILE    path to the extension's Developer ID provisioning
#                            profile (.provisionprofile), embedded if given
#   PUPPET_CAMHOST_PROFILE   path to the helper's Developer ID provisioning
#                            profile (App ID com.spartangamestudios.vpuppet.camerahost,
#                            System Extension capability). Without it the helper
#                            lacks com.apple.developer.system-extension.install
#                            and activation fails with "missing entitlement".
#
# Output: src-tauri/macos/build/VPuppet Camera.app
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/camera-extension"
OUT_DIR="$HERE/build"
ID="com.spartangamestudios.vpuppet.camera"
HELPER_SRC="$HERE/camera-helper"
HELPER="$OUT_DIR/VPuppet Camera.app"
HELPER_ID="com.spartangamestudios.vpuppet.camerahost"
BUNDLE="$HELPER/Contents/Library/SystemExtensions/$ID.systemextension"
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
rm -rf "$HELPER" "$OUT_DIR/$ID.systemextension" "$OUT_DIR/obj"
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

# 5. The helper app around it: compile, Info.plist, icon, entitlements, sign.
mkdir -p "$HELPER/Contents/MacOS" "$HELPER/Contents/Resources"
for arch in arm64 x86_64; do
  xcrun swiftc -O -target "$arch-apple-macos$MIN_OS" -module-name VPuppetCamera \
    -o "$OUT_DIR/obj/helper-$arch" "$HELPER_SRC/main.swift"
done
xcrun lipo -create -output "$HELPER/Contents/MacOS/VPuppet Camera" "$OUT_DIR/obj/helper-arm64" "$OUT_DIR/obj/helper-x86_64"
sed -e "s/@VERSION@/$VERSION/g" -e "s/@BUILD@/$BUILD/g" "$HELPER_SRC/Info.plist.in" > "$HELPER/Contents/Info.plist"
plutil -lint "$HELPER/Contents/Info.plist" >/dev/null
cp "$HERE/../icons/icon.icns" "$HELPER/Contents/Resources/AppIcon.icns"
HELPER_ENT="$OUT_DIR/obj/helper.entitlements"
if [[ -n "${PUPPET_CAMHOST_PROFILE:-}" ]]; then
  cp "$PUPPET_CAMHOST_PROFILE" "$HELPER/Contents/embedded.provisionprofile"
  cat > "$HELPER_ENT" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.developer.system-extension.install</key>
  <true/>
  <key>com.apple.application-identifier</key>
  <string>$TEAM_ID.$HELPER_ID</string>
  <key>com.apple.developer.team-identifier</key>
  <string>$TEAM_ID</string>
</dict>
</plist>
PLIST
else
  # A restricted entitlement without a profile would stop the helper from
  # launching at all; without one it runs and reports "missing entitlement".
  [[ "$IDENTITY" == "-" ]] || echo "build-camera-extension: warning: no PUPPET_CAMHOST_PROFILE, the helper cannot install the extension" >&2
  printf '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict/></plist>\n' > "$HELPER_ENT"
fi
plutil -lint "$HELPER_ENT" >/dev/null
if [[ "$IDENTITY" == "-" ]]; then
  codesign --force --sign - --entitlements "$HELPER_ENT" --generate-entitlement-der "$HELPER"
else
  codesign --force --sign "$IDENTITY" --options runtime --timestamp --entitlements "$HELPER_ENT" --generate-entitlement-der "$HELPER"
fi
codesign --verify --deep --strict --verbose=1 "$HELPER"
echo "build-camera-extension: wrote $HELPER"
