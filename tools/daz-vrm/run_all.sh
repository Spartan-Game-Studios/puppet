#!/usr/bin/env bash
# Run the whole Daz -> VRM route. WORK holds the Daz scene and every file made
# from it (never commit those: Daz content). Steps can also be run one by one.
#   WORK=~/Documents/vpuppet-avatars/daz-g9-starter bash run_all.sh [from_step]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${WORK:?set WORK to the work folder}"
BLENDER="${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}"
FROM="${1:-1}"
b() { "$BLENDER" -b "$@" 2>&1 | grep -E "^(BAKE|HAIR|MAT|VRM|shape keys|helper|left upper|saved|import:)|Error|Traceback" || true; }
[ "$FROM" -le 1 ] && WORK="$WORK" python3 "$HERE/daz_run.py" "$HERE/01_build_scene.dsa" 300
[ "$FROM" -le 2 ] && WORK="$WORK" python3 "$HERE/daz_run.py" "$HERE/02_export_dbz.dsa" 600
[ "$FROM" -le 3 ] && b --python-exit-code 1 -P "$HERE/03_import.py" -- "$WORK/g9-starter.duf" "$WORK/03_imported.blend"
[ "$FROM" -le 4 ] && b -y "$WORK/03_imported.blend" -P "$HERE/04_bake_arkit.py" -- "$WORK/04_baked.blend" | grep -E "NOTHING|saved|Error"
[ "$FROM" -le 5 ] && b "$WORK/04_baked.blend" -P "$HERE/05_hair_cards.py" -- "$WORK/05_hair.blend" 8 5
[ "$FROM" -le 6 ] && b "$WORK/05_hair.blend" -P "$HERE/06_strip_tpose.py" -- "$WORK/06_tpose.blend"
LIBRARY="${LIBRARY:-/Users/Shared/My DAZ 3D Library}"
EYES="${EYES:-$LIBRARY/Runtime/Textures/DAZ/Characters/Genesis9/Base/Eyes/G9_Eyes05_D.jpg}"
[ "$FROM" -le 7 ] && b "$WORK/06_tpose.blend" -P "$HERE/07_materials.py" -- "$WORK/07_materials.blend" "$EYES"
[ "$FROM" -le 8 ] && b "$WORK/07_materials.blend" -P "$HERE/08_export_vrm.py" -- "$WORK/avatar.vrm" "${NAME:-Genesis 9 Starter}"
echo done
