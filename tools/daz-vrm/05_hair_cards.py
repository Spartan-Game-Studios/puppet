# Step 5 (Blender, headless): turn strand hair into ribbon cards (D10).
# Daz "dForce strand-based" hair is lines with no faces; glTF / VRM can't draw
# lines, so each kept strand becomes a flat ribbon lying on the head (its width
# runs across the strand, its face points away from the head centre), with a
# small generated texture that fades the edges and the tip.
#   Blender -b 04_baked.blend -P 05_hair_cards.py -- <out.blend> [keep_every=10] [width_mm=3.5]
import sys, bpy, numpy as np
args = sys.argv[sys.argv.index("--") + 1:]
out = args[0]
KEEP = int(args[1]) if len(args) > 1 else 10
WIDTH = (float(args[2]) if len(args) > 2 else 3.5) / 1000.0

rig = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
head = rig.data.bones["head"]
centre = rig.matrix_world @ ((head.head_local + head.tail_local) / 2)

for src in [o for o in bpy.data.objects if o.type == 'MESH' and len(o.data.polygons) == 0 and len(o.data.edges) > 1000]:
    m = src.data
    nv = len(m.vertices)
    co = np.empty(nv * 3); m.vertices.foreach_get("co", co); co = co.reshape(-1, 3)
    e = np.empty(len(m.edges) * 2, dtype=np.int64); m.edges.foreach_get("vertices", e); e = e.reshape(-1, 2)
    nbr = [[] for _ in range(nv)]
    for a, b in e:
        nbr[a].append(b); nbr[b].append(a)
    seen = np.zeros(nv, bool)
    strands = []
    for v in range(nv):
        if seen[v] or len(nbr[v]) != 1:
            continue
        chain = [v]; seen[v] = True; prev, cur = -1, v
        while True:
            nxt = [n for n in nbr[cur] if n != prev]
            if not nxt or seen[nxt[0]]:
                break
            prev, cur = cur, nxt[0]; chain.append(cur); seen[cur] = True
        if len(chain) >= 3:
            # Root = the end nearer the head centre.
            if np.linalg.norm(co[chain[-1]] - centre) < np.linalg.norm(co[chain[0]] - centre):
                chain.reverse()
            strands.append(chain)
    kept = strands[::KEEP]
    verts, faces, uvs = [], [], []
    for chain in kept:
        p = co[chain]; n = len(p)
        t = np.gradient(p, axis=0); t /= np.linalg.norm(t, axis=1, keepdims=True) + 1e-9
        r = p - np.array(centre); r /= np.linalg.norm(r, axis=1, keepdims=True) + 1e-9
        side = np.cross(t, r); side /= np.linalg.norm(side, axis=1, keepdims=True) + 1e-9
        taper = np.linspace(1.0, 0.35, n)[:, None]  # narrower toward the tip
        base = len(verts)
        for i in range(n):
            verts.append(tuple(p[i] - side[i] * WIDTH / 2 * taper[i])); uvs.append((0.0, i / (n - 1)))
            verts.append(tuple(p[i] + side[i] * WIDTH / 2 * taper[i])); uvs.append((1.0, i / (n - 1)))
        for i in range(n - 1):
            a = base + 2 * i
            faces.append((a, a + 1, a + 3, a + 2))
    me = bpy.data.meshes.new(src.name.replace("Mesh", "Cards"))
    me.from_pydata(verts, [], faces)
    uv = me.uv_layers.new(name="UVMap")
    flat = [uvs[li.vertex_index] for li in me.loops]
    uv.data.foreach_set("uv", np.array(flat).ravel())
    ob = bpy.data.objects.new(me.name, me)
    src.users_collection[0].objects.link(ob)
    ob.parent = rig; ob.matrix_world = src.matrix_world.copy()
    # Short hair: all on the head bone, no spring chains (D10).
    vg = ob.vertex_groups.new(name="head"); vg.add(range(len(verts)), 1.0, 'REPLACE')
    mod = ob.modifiers.new("Armature", 'ARMATURE'); mod.object = rig
    # Colour: the strand material's base colour; texture: edge + tip fade.
    col = (0.08, 0.05, 0.03, 1.0)
    for s in src.material_slots:
        b = next((nd for nd in s.material.node_tree.nodes if nd.type == 'BSDF_PRINCIPLED'), None) if s.material else None
        if b and not b.inputs["Base Color"].is_linked:
            col = tuple(b.inputs["Base Color"].default_value); break
    W_, H_ = 32, 128
    u = np.linspace(-1, 1, W_)[None, :]; v = np.linspace(0, 1, H_)[:, None]
    alpha = np.clip(1.0 - np.abs(u) ** 2, 0, 1) * np.clip((1.0 - v) * 1.6, 0, 1)
    shade = 0.75 + 0.25 * v  # a little darker at the root
    px = np.zeros((H_, W_, 4), np.float32)
    for c in range(3):
        px[..., c] = col[c] * shade
    px[..., 3] = alpha
    img = bpy.data.images.new("hair_card", W_, H_, alpha=True)
    img.pixels.foreach_set(px.ravel())
    img.filepath_raw = bpy.path.abspath("//hair_card.png"); img.file_format = 'PNG'; img.save()
    mat = bpy.data.materials.new("Hair Cards"); mat.use_nodes = True
    nt = mat.node_tree; bsdf = nt.nodes["Principled BSDF"]
    tex = nt.nodes.new("ShaderNodeTexImage"); tex.image = img
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    nt.links.new(tex.outputs["Alpha"], bsdf.inputs["Alpha"])
    bsdf.inputs["Roughness"].default_value = 0.6
    mat.surface_render_method = 'DITHERED'
    me.materials.append(mat)
    print(f"HAIR {src.name}: {len(strands)} strands, kept {len(kept)}, {len(verts)} verts, {len(faces)} quads")
    bpy.data.objects.remove(src)

bpy.ops.wm.save_as_mainfile(filepath=out)
print("saved", out)
