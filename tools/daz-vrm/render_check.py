# Check renders (EEVEE): the head or the whole figure from front, side and back,
# tiled into one image. Not a pipeline step; used to judge each step.
#   Blender -b <file.blend> -P render_check.py -- <out.png> [head|body]
import sys, math, bpy, mathutils
args = sys.argv[sys.argv.index("--") + 1:]
out = args[0]; what = args[1] if len(args) > 1 else "head"
rig = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
b = rig.data.bones["head"]
if what == "head":
    target = rig.matrix_world @ ((b.head_local + b.tail_local) / 2); dist, lens = 0.75, 85
else:
    target = mathutils.Vector((0, 0, 0.95)); dist, lens = 4.2, 50
sc = bpy.context.scene
sc.render.engine = 'BLENDER_EEVEE'
sc.render.resolution_x = sc.render.resolution_y = 512
sc.render.film_transparent = False
world = bpy.data.worlds.new("check"); world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (0.55, 0.55, 0.58, 1); world.node_tree.nodes["Background"].inputs[1].default_value = 1.2
sc.world = world
sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", 'SUN')); sun.data.energy = 3
sun.rotation_euler = (math.radians(50), 0, math.radians(30)); sc.collection.objects.link(sun)
cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam")); cam.data.lens = lens; sc.collection.objects.link(cam); sc.camera = cam
import os, tempfile
tiles = []
for i, ang in enumerate((0, 90, 180)):  # front (-Y), avatar's left, back
    a = math.radians(ang)
    cam.location = target + mathutils.Vector((math.sin(a) * dist, -math.cos(a) * dist, 0.02))
    cam.rotation_euler = (target - cam.location).to_track_quat('-Z', 'Y').to_euler()
    p = os.path.join(tempfile.gettempdir(), f"chk_{i}.png"); sc.render.filepath = p
    bpy.ops.render.render(write_still=True); tiles.append(p)
imgs = [bpy.data.images.load(p) for p in tiles]
W, H = imgs[0].size
sheet = bpy.data.images.new("sheet", W * 3, H)
import numpy as np
px = np.zeros((H, W * 3, 4), np.float32)
for i, im in enumerate(imgs):
    a = np.array(im.pixels[:], np.float32).reshape(H, W, 4); px[:, i * W:(i + 1) * W] = a
sheet.pixels.foreach_set(px.ravel()); sheet.filepath_raw = out; sheet.file_format = 'PNG'; sheet.save()
print("wrote", out)
