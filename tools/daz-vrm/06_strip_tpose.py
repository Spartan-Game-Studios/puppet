# Step 6 (Blender, headless): strip what only Daz can drive, then make a T-pose
# the rest pose without losing the baked ARKit shape keys.
#   Blender -b 05_hair.blend -P 06_strip_tpose.py -- <out.blend>
import sys, re, bpy, numpy as np, mathutils
out = sys.argv[sys.argv.index("--") + 1]
ARKIT = set("""browDownLeft browDownRight browInnerUp browOuterUpLeft browOuterUpRight cheekPuff
cheekSquintLeft cheekSquintRight eyeBlinkLeft eyeBlinkRight eyeLookDownLeft eyeLookDownRight
eyeLookInLeft eyeLookInRight eyeLookOutLeft eyeLookOutRight eyeLookUpLeft eyeLookUpRight
eyeSquintLeft eyeSquintRight eyeWideLeft eyeWideRight jawForward jawLeft jawOpen jawRight
mouthClose mouthDimpleLeft mouthDimpleRight mouthFrownLeft mouthFrownRight mouthFunnel mouthLeft
mouthLowerDownLeft mouthLowerDownRight mouthPressLeft mouthPressRight mouthPucker mouthRight
mouthRollLower mouthRollUpper mouthShrugLower mouthShrugUpper mouthSmileLeft mouthSmileRight
mouthStretchLeft mouthStretchRight mouthUpperUpLeft mouthUpperUpRight noseSneerLeft
noseSneerRight tongueOut""".split())
rig = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
meshes = [o for o in bpy.data.objects if o.type == 'MESH']

# 1. Strip (D8): drivers, Daz morph properties, every shape key that isn't one of
#    the 52 (VRM can't drive Daz's joint correctives or morph formulas), helper bones.
for idb in [rig, rig.data] + [o.data.shape_keys for o in meshes if o.data.shape_keys]:
    if idb.animation_data:
        for fc in list(idb.animation_data.drivers):
            idb.animation_data.drivers.remove(fc)
for k in [k for k in rig.keys() if k.lower().startswith(("facs", "daz"))]:
    del rig[k]
dropped = 0
for o in meshes:
    sk = o.data.shape_keys
    if not sk:
        continue
    for kb in list(sk.key_blocks)[1:]:
        if kb.name not in ARKIT:
            o.shape_key_remove(kb); dropped += 1
    if len(sk.key_blocks) == 1:
        o.shape_key_clear()
print("shape keys dropped:", dropped)
bpy.context.view_layer.objects.active = rig
bpy.ops.object.mode_set(mode='EDIT')
helpers = [b for b in rig.data.edit_bones if b.name.endswith("(drv)") and not b.children]
for b in helpers:
    rig.data.edit_bones.remove(b)
bpy.ops.object.mode_set(mode='OBJECT')
print("helper bones removed:", len(helpers))
for pb in rig.pose.bones:
    pb.matrix_basis = mathutils.Matrix.Identity(4)
    for c in list(pb.constraints):
        pb.constraints.remove(c)

# 2. T-pose (D9): upper arm, forearm and hand straight out along +-X, level.
bpy.ops.object.mode_set(mode='POSE')
def aim(name, child, direction):
    pb = rig.pose.bones[name]
    bpy.context.view_layer.update()
    cur = (rig.pose.bones[child].head - pb.head).normalized()
    rot = cur.rotation_difference(direction)
    m = pb.matrix.copy()
    loc = m.to_translation()
    m = mathutils.Matrix.Translation(loc) @ rot.to_matrix().to_4x4() @ mathutils.Matrix.Translation(-loc) @ m
    pb.matrix = m
for side, sign in (("l", 1), ("r", -1)):
    d = mathutils.Vector((sign, 0, 0))
    aim(f"{side}_upperarm", f"{side}_forearm", d)
    aim(f"{side}_forearm", f"{side}_hand", d)
    aim(f"{side}_hand", f"{side}_midmetacarpal", d)
bpy.ops.object.mode_set(mode='OBJECT')
bpy.context.view_layer.update()

# 3. Bake the pose into every mesh, shape keys included: evaluate the mesh with
#    each key alone at 1 under the posed armature, keep those as the new keys,
#    then make the pose the rest pose.
dg = bpy.context.evaluated_depsgraph_get()
def posed_coords(o):
    dg.update(); e = o.evaluated_get(dg); m = e.to_mesh()
    a = np.empty(len(m.vertices) * 3, np.float32); m.vertices.foreach_get("co", a); e.to_mesh_clear()
    return a
for o in meshes:
    arm = [m for m in o.modifiers if m.type == 'ARMATURE']
    if not arm:
        continue
    for m in o.modifiers:
        if m.type != 'ARMATURE':
            m.show_viewport = False
    sk = o.data.shape_keys
    if sk:
        kbs = list(sk.key_blocks)
        for kb in kbs: kb.value = 0.0
        base = posed_coords(o); new = {}
        for kb in kbs[1:]:
            kb.value = 1.0; new[kb.name] = posed_coords(o); kb.value = 0.0
        kbs[0].data.foreach_set("co", base)
        for kb in kbs[1:]:
            kb.data.foreach_set("co", new[kb.name])
        o.data.vertices.foreach_set("co", base)
    else:
        o.data.vertices.foreach_set("co", posed_coords(o))
    o.data.update()
    for m in o.modifiers: m.show_viewport = True
bpy.context.view_layer.objects.active = rig
bpy.ops.object.mode_set(mode='POSE')
bpy.ops.pose.armature_apply(selected=False)
bpy.ops.object.mode_set(mode='OBJECT')
ua = rig.data.bones["l_upperarm"]; v = (rig.data.bones["l_forearm"].head_local - ua.head_local).normalized()
print(f"left upper arm now ({v.x:+.2f},{v.y:+.2f},{v.z:+.2f})")
bpy.ops.wm.save_as_mainfile(filepath=out)
print("saved", out)
