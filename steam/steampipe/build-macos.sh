#!/usr/bin/env bash
# Universal (Apple silicon + Intel) VPuppet.app for the Steam macOS depot:
# Developer ID-signed with the camera extension's entitlements, then
# notarized and stapled.
#
#   APPLE_TEAM_ID=<TEAMID> \
#   PUPPET_APP_PROFILE=<path>/VPuppet_Developer_ID.provisionprofile \
#   PUPPET_CAMEXT_PROFILE=<path>/VPuppet_Camera_Developer_ID.provisionprofile \
#   NOTARY_PROFILE=vpuppet \
#   bash steam/steampipe/build-macos.sh
#
# PUPPET_CAMEXT_PROFILE is optional (see docs/virtual-camera.md#macos-signing).
# NOTARY_PROFILE names a notarytool keychain profile, made once with
#   xcrun notarytool store-credentials vpuppet --apple-id <id> --team-id <TEAMID>
# (it asks for an app-specific password). Without it the app is signed but
# not notarized, and the script stops before stapling.
#
# Output: src-tauri/target/universal-apple-darwin/release/bundle/macos/VPuppet.app
# (the path depot_build_full_macos.vdf uploads).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

: "${APPLE_TEAM_ID:?set APPLE_TEAM_ID}"
: "${PUPPET_APP_PROFILE:?set PUPPET_APP_PROFILE to the app provisioning profile}"
APP_ID="com.spartangamestudios.vpuppet"
APP="src-tauri/target/universal-apple-darwin/release/bundle/macos/VPuppet.app"
EXT="$APP/Contents/Library/SystemExtensions/$APP_ID.camera.systemextension"

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

APPLE_SIGNING_IDENTITY="$(security find-identity -v -p codesigning | sed -n "s/.*\"\(Developer ID Application: .*($APPLE_TEAM_ID)\)\"/\1/p" | head -1)"
[[ -n "$APPLE_SIGNING_IDENTITY" ]] || { echo "build-macos: no Developer ID Application identity for team $APPLE_TEAM_ID in the keychain" >&2; exit 1; }
export APPLE_TEAM_ID APPLE_SIGNING_IDENTITY PUPPET_CAMEXT_PROFILE
# Notarization is done below with the keychain profile, not by Tauri.
unset APPLE_ID APPLE_PASSWORD APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH

rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null
bash src-tauri/macos/prepare-signing.sh
pnpm tauri build --target universal-apple-darwin --bundles app --config src-tauri/macos/build/tauri.signed.conf.json

echo "build-macos: checking $APP"
for bin in "$APP/Contents/MacOS/"* "$EXT/Contents/MacOS/"*; do
  archs="$(lipo -archs "$bin")"
  echo "  $(basename "$bin"): $archs"
  [[ "$archs" == *arm64* && "$archs" == *x86_64* ]] || { echo "build-macos: $bin is not universal" >&2; exit 1; }
done
codesign --verify --deep --strict --verbose=1 "$APP"
codesign -d --entitlements - --xml "$APP" | plutil -p - | grep -q system-extension.install \
  || { echo "build-macos: the app lacks the system-extension.install entitlement" >&2; exit 1; }

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
