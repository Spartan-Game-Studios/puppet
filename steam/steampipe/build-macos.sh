#!/usr/bin/env bash
# Universal (Apple silicon + Intel) VPuppet.app for the Steam macOS depot:
# Developer ID-signed, with the camera installer (VPuppet Camera.app, which
# carries the camera extension) inside, then notarized and stapled.
#
#   APPLE_TEAM_ID=<TEAMID> \
#   PUPPET_APP_PROFILE=<path>/VPuppet_Developer_ID.provisionprofile \
#   PUPPET_CAMEXT_PROFILE=<path>/VPuppet_Camera_Developer_ID.provisionprofile \
#   PUPPET_CAMHOST_PROFILE=<path>/VPuppet_Camera_Host_Developer_ID.provisionprofile \
#   NOTARY_PROFILE=vpuppet \
#   bash steam/steampipe/build-macos.sh
#
# PUPPET_CAMEXT_PROFILE is optional (see docs/virtual-camera.md#macos-signing).
# PUPPET_CAMHOST_PROFILE is required: VPuppet Camera.app is what installs the
# extension, from /Applications, wherever Steam puts VPuppet.
# NOTARY_PROFILE names a notarytool keychain profile, made once with
#   xcrun notarytool store-credentials vpuppet --apple-id <id> --team-id <TEAMID>
# (it asks for an app-specific password). Without it the app is signed but
# not notarized, and the script stops before stapling.
#
# Output: src-tauri/target/universal-apple-darwin/release/bundle/macos/VPuppet.app
# (the path depot_build_full_macos.vdf uploads).
#
# DEMO=1 builds the free demo instead (cargo features demo + steam, with
# libsteam_api.dylib in Contents/MacOS) into its own target folder,
# src-tauri/target-demo/, so it can never be uploaded as the full app.
# Its BUY button opens the full app's store page (VPUPPET_STEAM_APP_ID).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

: "${APPLE_TEAM_ID:?set APPLE_TEAM_ID}"
: "${PUPPET_APP_PROFILE:?set PUPPET_APP_PROFILE to the app provisioning profile}"
: "${PUPPET_CAMHOST_PROFILE:?set PUPPET_CAMHOST_PROFILE to the camera installer provisioning profile}"
APP_ID="com.spartangamestudios.vpuppet"
TARGET_DIR="src-tauri/target"
BUILD_ARGS=()
if [[ "${DEMO:-0}" == 1 ]]; then
  TARGET_DIR="src-tauri/target-demo"
  export CARGO_TARGET_DIR="$PWD/$TARGET_DIR"
  export VPUPPET_STEAM_APP_ID="${VPUPPET_STEAM_APP_ID:-5540350}"
  node scripts/stage-steam-redist.mjs
  BUILD_ARGS=(--features demo,steam --config src-tauri/tauri.demo.conf.json)
fi
APP="$TARGET_DIR/universal-apple-darwin/release/bundle/macos/VPuppet.app"
HELPER="$APP/Contents/Helpers/VPuppet Camera.app"
EXT="$HELPER/Contents/Library/SystemExtensions/$APP_ID.camera.systemextension"

# A profile for another bundle ID (e.g. the pre-rename com.spartangamestudios.puppet)
# signs fine but the app is killed at launch, so check before building.
profile_id() {
  security cms -D -i "$1" | python3 -c 'import plistlib, sys; print(plistlib.loads(sys.stdin.buffer.read())["Entitlements"]["com.apple.application-identifier"])'
}
check_profile() {
  local got
  got="$(profile_id "$1")"
  [[ "$got" == "$APPLE_TEAM_ID.$2" ]] || { echo "build-macos: $1 is for $got, expected $APPLE_TEAM_ID.$2" >&2; exit 1; }
}
check_profile "$PUPPET_APP_PROFILE" "$APP_ID"
[[ -z "${PUPPET_CAMEXT_PROFILE:-}" ]] || check_profile "$PUPPET_CAMEXT_PROFILE" "$APP_ID.camera"
check_profile "$PUPPET_CAMHOST_PROFILE" "$APP_ID.camerahost"

APPLE_SIGNING_IDENTITY="$(security find-identity -v -p codesigning | sed -n "s/.*\"\(Developer ID Application: .*($APPLE_TEAM_ID)\)\"/\1/p" | head -1)"
[[ -n "$APPLE_SIGNING_IDENTITY" ]] || { echo "build-macos: no Developer ID Application identity for team $APPLE_TEAM_ID in the keychain" >&2; exit 1; }
export APPLE_TEAM_ID APPLE_SIGNING_IDENTITY PUPPET_CAMEXT_PROFILE PUPPET_CAMHOST_PROFILE
# Notarization is done below with the keychain profile, not by Tauri.
unset APPLE_ID APPLE_PASSWORD APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH

rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null
bash src-tauri/macos/prepare-signing.sh
pnpm tauri build --target universal-apple-darwin --bundles app "${BUILD_ARGS[@]}" --config src-tauri/macos/build/tauri.signed.conf.json
if [[ "${DEMO:-0}" == 1 ]]; then
  test -f "$APP/Contents/MacOS/libsteam_api.dylib" || { echo "build-macos: the demo bundle lacks libsteam_api.dylib" >&2; exit 1; }
  otool -L "$APP/Contents/MacOS/vpuppet" | grep -q '@loader_path/libsteam_api.dylib' \
    || { echo "build-macos: vpuppet does not load libsteam_api.dylib from beside itself" >&2; otool -L "$APP/Contents/MacOS/vpuppet" >&2; exit 1; }
fi

echo "build-macos: checking $APP"
for bin in "$APP/Contents/MacOS/"* "$HELPER/Contents/MacOS/"* "$EXT/Contents/MacOS/"*; do
  archs="$(lipo -archs "$bin")"
  echo "  $(basename "$bin"): $archs"
  [[ "$archs" == *arm64* && "$archs" == *x86_64* ]] || { echo "build-macos: $bin is not universal" >&2; exit 1; }
done
codesign --verify --deep --strict --verbose=1 "$APP"
codesign -d --entitlements - --xml "$HELPER" | plutil -p - | grep -q system-extension.install \
  || { echo "build-macos: VPuppet Camera.app lacks the system-extension.install entitlement" >&2; exit 1; }

if [[ -z "${NOTARY_PROFILE:-}" ]]; then
  echo "build-macos: signed, not notarized (set NOTARY_PROFILE to notarize and staple)"
  exit 0
fi
ZIP="$(mktemp -d)/VPuppet.zip"
ditto -c -k --keepParent "$APP" "$ZIP"
xcrun notarytool submit "$ZIP" --keychain-profile "$NOTARY_PROFILE" --wait
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"
spctl -a -vv "$APP"
echo "build-macos: ready for depot_build_full_macos.vdf"
