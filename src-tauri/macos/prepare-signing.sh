#!/usr/bin/env bash
# Prepare a SIGNED macOS build that can install the camera extension.
# Writes, under src-tauri/macos/build/:
#   embedded.provisionprofile   the app's Developer ID provisioning profile
#   Entitlements.app.plist      app entitlements incl. system-extension.install
#   tauri.signed.conf.json      config overlay: pass it to `tauri build --config`
#
# Inputs (env):
#   APPLE_TEAM_ID            10-character team ID
#   PUPPET_APP_PROFILE       path to the app's .provisionprofile
#                            (App ID com.spartangamestudios.vpuppet, with the
#                            System Extension capability)
# The extension's own signing happens in build-camera-extension.sh
# (APPLE_SIGNING_IDENTITY, PUPPET_CAMEXT_PROFILE). See docs/virtual-camera.md.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/build"
: "${APPLE_TEAM_ID:?set APPLE_TEAM_ID}"
: "${PUPPET_APP_PROFILE:?set PUPPET_APP_PROFILE to the app provisioning profile}"
mkdir -p "$OUT"
cp "$PUPPET_APP_PROFILE" "$OUT/embedded.provisionprofile"

cat > "$OUT/Entitlements.app.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.device.camera</key>
  <true/>
  <key>com.apple.security.device.audio-input</key>
  <true/>
  <key>com.apple.developer.system-extension.install</key>
  <true/>
  <key>com.apple.application-identifier</key>
  <string>$APPLE_TEAM_ID.com.spartangamestudios.vpuppet</string>
  <key>com.apple.developer.team-identifier</key>
  <string>$APPLE_TEAM_ID</string>
</dict>
</plist>
PLIST
plutil -lint "$OUT/Entitlements.app.plist" >/dev/null

# Paths in the overlay are relative to src-tauri/.
cat > "$OUT/tauri.signed.conf.json" <<JSON
{
  "bundle": {
    "macOS": {
      "entitlements": "macos/build/Entitlements.app.plist",
      "files": {
        "embedded.provisionprofile": "macos/build/embedded.provisionprofile",
        "Library/SystemExtensions/com.spartangamestudios.vpuppet.camera.systemextension": "macos/build/com.spartangamestudios.vpuppet.camera.systemextension"
      }
    }
  }
}
JSON
echo "prepare-signing: wrote $OUT/tauri.signed.conf.json"
