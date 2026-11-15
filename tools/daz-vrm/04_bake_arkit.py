# Step 4 (Blender, headless): bake the 52 ARKit shapes from Genesis 9's FACS rig.
# For each ARKit name, set its Daz control to 1 (the importer's drivers move the
# morphs and, for the jaw and lids, bones), read the deformed face meshes, and
# store the difference from rest as a shape key named after the ARKit shape.
#   Blender -b 03_imported.blend -P 04_bake_arkit.py -- <out.blend>
# In the Scripting tab: open 03_imported.blend and Run Script.
import sys, re, bpy, addon_utils
def _args(default_out):
    """Command line: the arguments after "--". Scripting tab (no "--"): save
    next to the open .blend as default_out, with the defaults."""
    import os
    if "--" in sys.argv:
        return sys.argv[sys.argv.index("--") + 1:]
    folder = os.path.dirname(bpy.data.filepath) or os.path.expanduser("~")
    return [os.path.join(folder, default_out)]
import numpy as np
out = _args("04_baked.blend")[0]
if bpy.app.autoexec_fail:
    # The importer's drivers are simple expressions, which run anyway; a blocked
    # file matters only if something printed NOTHING MOVES below.
    print("note: Blender blocked scripts in this file; if shapes don't move, allow execution")
addon_utils.enable("bl_ext.user_default.import_daz", default_set=True)

ARKIT = """browDownLeft browDownRight browInnerUp browOuterUpLeft browOuterUpRight cheekPuff
cheekSquintLeft cheekSquintRight eyeBlinkLeft eyeBlinkRight eyeLookDownLeft eyeLookDownRight
eyeLookInLeft eyeLookInRight eyeLookOutLeft eyeLookOutRight eyeLookUpLeft eyeLookUpRight
eyeSquintLeft eyeSquintRight eyeWideLeft eyeWideRight jawForward jawLeft jawOpen jawRight
mouthClose mouthDimpleLeft mouthDimpleRight mouthFrownLeft mouthFrownRight mouthFunnel mouthLeft
mouthLowerDownLeft mouthLowerDownRight mouthPressLeft mouthPressRight mouthPucker mouthRight
mouthRollLower mouthRollUpper mouthShrugLower mouthShrugUpper mouthSmileLeft mouthSmileRight
mouthStretchLeft mouthStretchRight mouthUpperUpLeft mouthUpperUpRight noseSneerLeft
noseSneerRight tongueOut""".split()

rig = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
# The face meshes: the body and every follower that carries face morphs
# (lashes, brows, mouth with teeth and tongue, tear, eyes). Hair and clothes don't.
FACE = [o for o in bpy.data.objects if o.type == 'MESH' and o.parent == rig
        and any(s in o.name for s in ("Genesis 9 Mesh", "Eyelashes", "Eyebrows", "Mouth", "Tear", "Eyes"))]
props = [k for k in rig.keys() if k.lower().startswith("facs") and not k.endswith("(fin)")]
# Daz's subdivision comes in as Subsurf modifiers. A real-time avatar uses the
# base resolution (D6), and the bake needs the evaluated vertices to match.
for ob in bpy.data.objects:
    for m in [m for m in ob.modifiers if m.type == 'SUBSURF']:
        ob.modifiers.remove(m)

# Pure joint motions are two-way controls (-1..1) in Genesis 9; the one-way
# facs_bs_ halves of these move nothing on their own. The figure faces -Y, so
# its own left is +X: +1 moves the jaw / mouth to the avatar's left (D7).
TWO_WAY = {
    "jawLeft": ("facs_ctrl_JawLeft-Right", 1.0), "jawRight": ("facs_ctrl_JawLeft-Right", -1.0),
    "jawForward": ("facs_ctrl_JawForward-Recess", 1.0),
    "mouthLeft": ("facs_ctrl_MouthLeft-Right", 1.0), "mouthRight": ("facs_ctrl_MouthLeft-Right", -1.0),
}

def control_for(name):
    """(Daz control, value) that makes this ARKit shape (D2, D3, D7 in the log)."""
    if name in TWO_WAY:
        return TWO_WAY[name]
    found = {}
    for p in props:
        m = re.match(r"facs_(bs_|ctrl_|cbs_)?(.*)$", p)
        if m and m.group(2).lower() == name.lower():
            found[(m.group(1) or "").rstrip("_") or "alias"] = p
    # eyeLook*: the lid-only shape, never the eyeball (D3). Otherwise the
    # control (it combines shapes and bones the way Daz poses the face).
    order = ("bs", "alias", "ctrl") if name.startswith("eyeLook") else ("ctrl", "alias", "bs")
    p = next((found[k] for k in order if k in found), None)
    return (p, 1.0) if p else None

def evaluate():
    rig.update_tag()
    bpy.context.scene.frame_set(1)
    dg = bpy.context.evaluated_depsgraph_get(); dg.update()
    res = {}
    for ob in FACE:
        e = ob.evaluated_get(dg); m = e.to_mesh()
        a = np.empty(len(m.vertices) * 3, dtype=np.float32); m.vertices.foreach_get("co", a)
        e.to_mesh_clear(); res[ob.name] = a.reshape(-1, 3)
    return res

for p in props:
    rig[p] = 0.0
rest = evaluate()
report = []
deltas = {}
for name in ARKIT:
    c = control_for(name)
    if not c:
        report.append((name, None, 0, 0)); continue
    p, value = c
    rig[p] = value
    cur = evaluate()
    rig[p] = 0.0
    deltas[name] = {k: cur[k] - rest[k] for k in rest}
    moved = {k: float(np.linalg.norm(d, axis=1).max()) for k, d in deltas[name].items()}
    report.append((name, f"{p} = {value:+g}", max(moved.values()), max(moved, key=moved.get)))

# Write the shape keys (relative to Basis) on every face mesh.
for ob in FACE:
    if not ob.data.shape_keys:
        ob.shape_key_add(name="Basis")
    basis = ob.data.shape_keys.reference_key
    base = np.empty(len(ob.data.vertices) * 3, dtype=np.float32); basis.data.foreach_get("co", base)
    base = base.reshape(-1, 3)
    for name, per in deltas.items():
        d = per[ob.name]
        if np.abs(d).max() < 1e-6:
            continue  # this mesh doesn't take part in this shape
        kb = ob.data.shape_keys.key_blocks.get(name) or ob.shape_key_add(name=name, from_mix=False)
        kb.data.foreach_set("co", (base + d).ravel())
        kb.value = 0.0

for name, p, mv, where in report:
    flag = "" if mv > 1e-3 else "   <-- NOTHING MOVES"
    print(f"BAKE {name:20} {str(p):38} {mv*100:6.2f} cm  ({where}){flag}")
bpy.ops.wm.save_as_mainfile(filepath=out)
print("saved", out)
