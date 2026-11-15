# Step 7 (Blender, headless): replace Daz's Iray materials with plain
# Principled BSDF materials that glTF / VRM can carry (D11): base colour,
# normal map, and an alpha cutout where needed. Textures capped at 2048 px and
# saved next to the .blend in textures/. Transparent shells that only make
# sense in a path tracer (tear, eye moisture) are removed.
#   Blender -b 06_tpose.blend -P 07_materials.py -- <out.blend> [eye texture]
# The optional eye texture is one of Genesis 9's combined eye maps
# (Runtime/Textures/DAZ/Characters/Genesis9/Base/Eyes/G9_EyesNN_D.jpg, D16).
import os, re, sys, bpy, numpy as np
args = sys.argv[sys.argv.index("--") + 1:]
out = args[0]
EYES = args[1] if len(args) > 1 else None
TEX = os.path.join(os.path.dirname(out), "textures"); os.makedirs(TEX, exist_ok=True)
MAX = 2048

def images(nt, depth=0):
    r = []
    for n in nt.nodes:
        if n.type == 'TEX_IMAGE' and n.image: r.append(n.image)
        if n.type == 'GROUP' and n.node_tree and depth < 4: r += images(n.node_tree, depth + 1)
    return r
def find(imgs, *pats):
    for p in pats:
        for im in imgs:
            if re.search(p, im.name, re.I): return im
def capped(im, name, fmt='JPEG'):
    """A copy of the image at <= MAX px, saved to textures/."""
    path = os.path.join(TEX, name + ('.jpg' if fmt == 'JPEG' else '.png'))
    if os.path.exists(path):
        return bpy.data.images.load(path, check_existing=True)
    # A copy of an image made in memory comes out blank: save that one itself.
    c = im if im.source == 'GENERATED' else im.copy(); w, h = c.size
    if max(w, h) > MAX: c.scale(MAX * w // max(w, h), MAX * h // max(w, h))
    c.filepath_raw = path; c.file_format = fmt
    if fmt == 'JPEG': bpy.context.scene.render.image_settings.quality = 90
    c.save(); c.name = name
    return c

def build(mat, color=None, color_value=(0.8, 0.8, 0.8, 1), normal=None, alpha=None, rough=0.55, cutout=True):
    nt = mat.node_tree; nt.nodes.clear()
    outn = nt.nodes.new("ShaderNodeOutputMaterial"); b = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(b.outputs[0], outn.inputs[0])
    b.inputs["Roughness"].default_value = rough
    b.inputs["Base Color"].default_value = color_value
    if color:
        t = nt.nodes.new("ShaderNodeTexImage"); t.image = color; nt.links.new(t.outputs["Color"], b.inputs["Base Color"])
    if normal:
        normal.colorspace_settings.name = 'Non-Color'
        t = nt.nodes.new("ShaderNodeTexImage"); t.image = normal
        nm = nt.nodes.new("ShaderNodeNormalMap"); nt.links.new(t.outputs["Color"], nm.inputs["Color"]); nt.links.new(nm.outputs[0], b.inputs["Normal"])
    if alpha:
        if alpha != color: alpha.colorspace_settings.name = 'Non-Color'
        t = nt.nodes.new("ShaderNodeTexImage"); t.image = alpha
        # A separate opacity map is greyscale; an RGBA texture keeps it in alpha.
        a = t.outputs["Alpha"] if alpha == color else t.outputs["Color"]
        if cutout:  # glTF alphaMode MASK: alpha through Round
            r = nt.nodes.new("ShaderNodeMath"); r.operation = 'ROUND'
            nt.links.new(a, r.inputs[0]); nt.links.new(r.outputs[0], b.inputs["Alpha"])
        else:
            nt.links.new(a, b.inputs["Alpha"])
        mat.surface_render_method = 'DITHERED'
    # Cards (hair, brows, lashes) are single planes: draw both sides (glTF doubleSided).
    mat.use_backface_culling = False

# Remove path-tracer-only shells.
for o in [o for o in bpy.data.objects if o.type == 'MESH' and "Tear" in o.name]:
    bpy.data.objects.remove(o)
for o in bpy.data.objects:
    if o.type != 'MESH': continue
    idx = [i for i, s in enumerate(o.material_slots) if s.material and "Moisture" in s.material.name]
    if idx:
        import bmesh
        bm = bmesh.new(); bm.from_mesh(o.data)
        bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.material_index in idx], context='FACES')
        bm.to_mesh(o.data); bm.free()

hair_col = (0.08, 0.05, 0.03, 1)
for o in bpy.data.objects:
    if o.type == 'MESH' and "Cards" in o.name:
        img = o.material_slots[0].material.node_tree.nodes["Image Texture"].image
        hair_col = tuple(np.array(img.pixels[:]).reshape(-1, 4)[-1][:3]) + (1,)

# Hair cards: cutout alpha (glTF MASK) rather than blended, which sorts badly
# in real time, and both sides drawn.
for o in bpy.data.objects:
    if o.type == 'MESH' and "Cards" in o.name:
        cm = o.material_slots[0].material
        img = cm.node_tree.nodes["Image Texture"].image
        build(cm, color=img, alpha=img, rough=0.6)

done = set()
for o in bpy.data.objects:
    if o.type != 'MESH': continue
    for s in o.material_slots:
        m = s.material
        if not m or m.name in done or "Hair Cards" in m.name or "Moisture" in m.name: continue
        done.add(m.name)
        imgs = images(m.node_tree); n = m.name
        if "Eyelash" in n:
            build(m, color_value=(0.02, 0.015, 0.012, 1), alpha=capped(find(imgs, r"_C$"), "eyelashes_alpha", 'PNG'), rough=0.6)
        elif "Eyebrow" in n:
            # Daz tints the light brow albedo in its layered shader; tint it to
            # the hair colour instead (D12).
            src = find(imgs, "Albedo"); w, h = src.size
            px = np.array(src.pixels[:], np.float32).reshape(h, w, 4)
            px[..., :3] = np.clip(px[..., :3] * np.array(hair_col[:3]) * 1.8, 0, 1)
            im = bpy.data.images.new("eyebrows_color_src", w, h); im.pixels.foreach_set(px.ravel())
            build(m, color=capped(im, "eyebrows_color"), alpha=capped(find(imgs, "Opacity"), "eyebrows_alpha", 'PNG'), rough=0.6)
        elif n.startswith("Eye") and EYES:
            build(m, color=capped(bpy.data.images.load(EYES), "eyes_color"), rough=0.15)
        elif n.startswith("Eye"):
            sclera, iris = find(imgs, r"Sclera_\d+$"), find(imgs, r"Iris_\d+$")
            w, h = sclera.size
            sc = np.array(sclera.pixels[:], np.float32).reshape(h, w, 4)
            ir = iris.copy(); ir.scale(w, h); ir = np.array(ir.pixels[:], np.float32).reshape(h, w, 4)
            comp = sc.copy(); a = ir[..., 3:4]; comp[..., :3] = ir[..., :3] * a + sc[..., :3] * (1 - a)
            im = bpy.data.images.new("eyes_color_src", w, h); im.pixels.foreach_set(comp.ravel())
            build(m, color=capped(im, "eyes_color"), rough=0.15)
        elif "Head-3" in n or "Cap" in o.name:  # hair cap: scalp tint in the hair colour
            build(m, color_value=hair_col, alpha=capped(find(imgs, "Opacity"), "hair_cap_alpha", 'PNG'), rough=0.7, cutout=False)
        else:
            col = find(imgs, r"_D_\d+$", r"BaseColor", r"_D$")
            nrm = find(imgs, r"_NM_\d+$", r"_Normal$", r"_NM$")
            build(m, color=capped(col, re.sub(r"\W+", "_", n) + "_color") if col else None,
                  normal=capped(nrm, re.sub(r"\W+", "_", n) + "_normal") if nrm else None,
                  rough=0.45 if o.name.startswith("Genesis 9 Mesh") else 0.7)
        print(f"MAT {o.name:32} {n:24} {[im.name for im in images(m.node_tree)]}")

# Drop the original 4K images from the file.
for im in list(bpy.data.images):
    if im.users == 0: bpy.data.images.remove(im)
bpy.ops.wm.save_as_mainfile(filepath=out)
print("saved", out)
