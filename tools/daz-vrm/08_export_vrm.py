# Step 8 (Blender, headless): set up and export the VRM 1.0 with the VRM Add-on
# for Blender: humanoid bones, the 52 ARKit expressions (perfect sync), VRM
# presets built from them (for apps without perfect sync), look-at on the eye
# bones, and meta that matches what Daz's licence allows.
#   Blender -b 07_materials.blend -P 08_export_vrm.py -- <out.vrm> [name]
# In the Scripting tab: open 07_materials.blend and Run Script (writes the next file
# next to it, with the default settings below).
import sys, bpy, addon_utils
def _args(default_out):
    """Command line: the arguments after "--". Scripting tab (no "--"): save
    next to the open .blend as default_out, with the defaults."""
    import os
    if "--" in sys.argv:
        return sys.argv[sys.argv.index("--") + 1:]
    folder = os.path.dirname(bpy.data.filepath) or os.path.expanduser("~")
    return [os.path.join(folder, default_out)]
args = _args("avatar.vrm")
out = args[0]; name = args[1] if len(args) > 1 else "Genesis 9 Starter"
addon_utils.enable("bl_ext.user_default.vrm", default_set=True)
rig = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
ext = rig.data.vrm_addon_extension
ext.spec_version = "1.0"
bpy.context.view_layer.objects.active = rig

# Humanoid: the add-on's automatic assignment, then the bones it can't guess.
bpy.ops.vrm.assign_vrm1_humanoid_human_bones_automatically(armature_object_name=rig.name)
hb = ext.vrm1.humanoid.human_bones
FIX = {"hips": "hip", "spine": "spine1", "chest": "spine3", "upper_chest": "spine4",
       "neck": "neck1", "head": "head", "left_eye": "l_eye", "right_eye": "r_eye", "jaw": None}
for side, s in (("left", "l"), ("right", "r")):
    FIX.update({f"{side}_shoulder": f"{s}_shoulder", f"{side}_upper_arm": f"{s}_upperarm", f"{side}_lower_arm": f"{s}_forearm",
                f"{side}_hand": f"{s}_hand", f"{side}_upper_leg": f"{s}_thigh", f"{side}_lower_leg": f"{s}_shin",
                f"{side}_foot": f"{s}_foot", f"{side}_toes": f"{s}_toes"})
    for f, d in (("thumb", ("metacarpal", "proximal", "distal")), ):
        pass
    for i, part in enumerate(("metacarpal", "proximal", "distal")):
        FIX[f"{side}_thumb_{part}"] = f"{s}_thumb{i + 1}"
    for finger, dz in (("index", "index"), ("middle", "mid"), ("ring", "ring"), ("little", "pinky")):
        for i, part in enumerate(("proximal", "intermediate", "distal")):
            FIX[f"{side}_{finger}_{part}"] = f"{s}_{dz}{i + 1}"
for prop, bone in FIX.items():
    hbone = getattr(hb, prop, None)
    if hbone is None: continue
    # No jaw bone (D13): the mouth is driven by the baked shapes; a VRM jaw
    # bone would be posed by other apps' lip sync on top of them.
    hbone.node.bone_name = bone if bone and bone in rig.data.bones else ""
missing = [p for p, b in FIX.items() if b and getattr(hb, p, None) and not getattr(hb, p).node.bone_name]
print("VRM humanoid unmapped:", missing or "none")

# Expressions: one custom expression per ARKit name, bound on every mesh that has the key.
meshes = [o for o in bpy.data.objects if o.type == 'MESH' and o.data.shape_keys]
keys = sorted({kb.name for o in meshes for kb in o.data.shape_keys.key_blocks[1:]})
ex = ext.vrm1.expressions
def bind(expr, key, weight=1.0):
    for o in meshes:
        if key in o.data.shape_keys.key_blocks:
            b = expr.morph_target_binds.add(); b.node.mesh_object_name = o.name; b.index = key; b.weight = weight
for k in keys:
    e = ex.custom.add(); e.custom_name = k; bind(e, k)
# VRM presets from the ARKit shapes (D14), so other apps get blink, visemes and emotions.
P = ex.preset
for preset, parts in {
    "blink": [("eyeBlinkLeft", 1), ("eyeBlinkRight", 1)], "blink_left": [("eyeBlinkLeft", 1)], "blink_right": [("eyeBlinkRight", 1)],
    "aa": [("jawOpen", 0.7), ("mouthLowerDownLeft", 0.3), ("mouthLowerDownRight", 0.3)],
    "ih": [("jawOpen", 0.25), ("mouthStretchLeft", 0.5), ("mouthStretchRight", 0.5)],
    "ou": [("jawOpen", 0.25), ("mouthFunnel", 0.6), ("mouthPucker", 0.5)],
    "ee": [("jawOpen", 0.2), ("mouthSmileLeft", 0.35), ("mouthSmileRight", 0.35), ("mouthStretchLeft", 0.4), ("mouthStretchRight", 0.4)],
    "oh": [("jawOpen", 0.45), ("mouthFunnel", 0.7)],
    "happy": [("mouthSmileLeft", 1), ("mouthSmileRight", 1), ("cheekSquintLeft", 0.6), ("cheekSquintRight", 0.6), ("eyeSquintLeft", 0.3), ("eyeSquintRight", 0.3)],
    "angry": [("browDownLeft", 1), ("browDownRight", 1), ("noseSneerLeft", 0.5), ("noseSneerRight", 0.5), ("mouthFrownLeft", 0.4), ("mouthFrownRight", 0.4)],
    "sad": [("browInnerUp", 1), ("mouthFrownLeft", 0.8), ("mouthFrownRight", 0.8), ("mouthShrugLower", 0.3)],
    "relaxed": [("mouthSmileLeft", 0.4), ("mouthSmileRight", 0.4), ("eyeSquintLeft", 0.2), ("eyeSquintRight", 0.2)],
    "surprised": [("browInnerUp", 1), ("browOuterUpLeft", 1), ("browOuterUpRight", 1), ("eyeWideLeft", 1), ("eyeWideRight", 1), ("jawOpen", 0.4)],
}.items():
    e = getattr(P, preset)
    for k, w in parts: bind(e, k, w)
    if preset.startswith("blink") or preset in ("happy", "relaxed"):
        e.override_blink = "block" if preset in ("happy", "relaxed") else e.override_blink

# Look-at: the eye bones (D3), from the head.
la = ext.vrm1.look_at
la.type = "bone"
eyes = (rig.data.bones["l_eye"].head_local + rig.data.bones["r_eye"].head_local) / 2
la.offset_from_head_bone = tuple(eyes - rig.data.bones["head"].head_local)

# Meta (D15): Daz content may not be redistributed, so lock it down.
m = ext.vrm1.meta
m.vrm_name = name; m.version = "1"
if not m.authors: m.authors.add()
m.authors[0].value = "Made with Daz 3D Genesis 9 Starter Essentials"
m.avatar_permission = "onlyAuthor"; m.commercial_usage = "personalNonProfit"
m.allow_redistribution = False; m.modification = "prohibited"
m.copyright_information = "Contains Daz 3D content (Daz EULA). Personal use only; do not share this file."

r = bpy.ops.export_scene.vrm(filepath=out, export_invisibles=False, export_try_sparse_sk=True)
print("VRM export:", r, out)
