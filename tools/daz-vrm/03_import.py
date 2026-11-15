# Step 3 (Blender, headless): import the Daz scene with the Diffeomorphic DAZ
# Importer: one merged armature, the Genesis 9 FACS face rig as driven morphs,
# joint correctives, face morphs transferred to lashes and brows.
#   Blender -b -P 03_import.py -- <scene.duf> <out.blend>
import sys, bpy
duf, out = sys.argv[sys.argv.index("--") + 1:][:2]
# Installed as an extension (bl_ext.user_default.import_daz). It needs its add-on
# preferences to register, so enable it properly; a background run doesn't save
# the user's preferences.
import os, addon_utils
addon_utils.enable("bl_ext.user_default.import_daz", default_set=True)
from bl_ext.user_default.import_daz import api
api.set_silent_mode(True)
for ob in list(bpy.data.objects):
    bpy.data.objects.remove(ob)
# Tell the importer where this machine's Daz library is, from the .dbz (Daz
# wrote its own root paths into it). A fresh install only knows the default
# folders and stops with "Some assets were not found" (the guide's by-hand
# route sets this in DAZ Setup > Global Settings). This run only; not saved.
import json, gzip
from bl_ext.user_default.import_daz.settings import GS
dbz = os.path.splitext(duf)[0] + ".dbz"
try:
    with gzip.open(dbz, "rt", encoding="utf-8-sig") as f: roots = json.load(f)["rootpaths"]
except OSError:
    with open(dbz, encoding="utf-8-sig") as f: roots = json.load(f)["rootpaths"]
for d in GS.readAutoDirs("content", roots) + GS.readAutoDirs("builtin_content", roots):
    if d not in GS.contentDirs: GS.contentDirs.append(d)
for d in GS.readAutoDirs("builtin_mdl", roots) + GS.readAutoDirs("mdl_dirs", roots):
    if d not in GS.mdlDirs: GS.mdlDirs.append(d)
print("content dirs:", GS.contentDirs)

# Exactly what the guide asks for in the Easy Import dialog: the defaults
# (Merge Rigs, Eliminate Empties, Transfer To Face Meshes / Clothes on,
# mesh fitting from the .dbz) plus FACS.
r = bpy.ops.daz.easy_import_daz(
    directory=os.path.dirname(duf) + "/", files=[{"name": os.path.basename(duf)}],
    useFacs=True,
)
print("import:", r, api.get_error_message() or "no error")
for ob in bpy.data.objects:
    sk = len(ob.data.shape_keys.key_blocks) if ob.type == 'MESH' and ob.data.shape_keys else 0
    extra = f" verts={len(ob.data.vertices)} shapekeys={sk} parent={ob.parent.name if ob.parent else '-'}" if ob.type == 'MESH' else ""
    if ob.type == 'ARMATURE':
        props = [k for k in ob.keys() if 'facs' in k.lower()]
        extra = f" bones={len(ob.data.bones)} facs_props={len(props)} e.g. {props[:4]}"
    print(f"{ob.type:9} {ob.name}{extra}")
bpy.ops.wm.save_as_mainfile(filepath=out)
print("saved", out)
