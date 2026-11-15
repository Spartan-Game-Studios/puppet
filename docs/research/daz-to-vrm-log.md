# Daz 3D → VRM: working log and decisions

The first full run of the Daz route, done to write `apps/docs/content/docs/guides/daz3d.mdx`
from what actually worked. Each decision says what we chose, why, and what we tried
first if something failed. Scripts are in `tools/daz-vrm/`; Daz content and every
file made from it stay in `~/Documents/vpuppet-avatars/` (outside the repo: Daz's
EULA doesn't let us redistribute it).

## Setup on this machine

- Daz Studio 6 (`/Applications/DAZ 3D/DAZStudio6 64-bit`), content library
  `/Users/Shared/My DAZ 3D Library`.
- Blender 5.2 LTS with the **Diffeomorphic DAZ Importer** (`import_daz` 5.2.0) and
  the **VRM Add-on for Blender** 4.10.2.

## Decisions

### D1. The figure: Genesis 9 Starter Essentials only
Genesis 9 base figure with the **Base Feminine** body dial and **G9 Feminine Skin 01
MAT**, plus **G9 Base dForce Pixie Hair**, **G9 Base Shirt** and **G9 Base Shorts**.
All of it comes free with Daz Studio, so every reader can reproduce the exact avatar.
The bare figure is androgynous and untextured grey (we first exported it like that and
got a grey body with no skin maps); a skin MAT preset is required. A character preset
(Kat, Laura…) changes only shape and skin and goes through the same steps.

### D2. Genesis 9's face rig already speaks ARKit
Genesis 9's base FACS set (`data/Daz 3D/Genesis 9/Base/Morphs/Daz 3D/FACS/`, 755
files) contains **all 52 ARKit names**: 31 as plain shapes (`facs_bs_EyeBlinkLeft`,
`facs_bs_JawOpen`…), 13 only as controls that combine shapes and bones
(`facs_ctrl_BrowInnerUp`, `facs_ctrl_MouthPucker`, `facs_ctrl_EyeWideLeft`…), 8 as
both (the eight `EyeLook*`). So perfect sync is a *bake*, not sculpting: drive each
control in Blender and save the deformed face as a shape key with the ARKit name.
(Genesis 8 and older have no such set; that would be a much longer route.)

### D3. Eye-look shapes move the lids only, never the eyeballs
VPuppet drives the `eyeLook*` expressions **and** the VRM look-at (eye bones) from
the same gaze (`src/scene/avatar.ts`, `applyExpressions`). A shape that also turned
the eyeballs would turn them twice. So the eight `eyeLook*` keys are baked with the
eye bones held still (lid and skin follow-through only), and the eyeballs are left
to the look-at bones.

### D4. Tooling: scripts, Daz headless
Every Daz step is a DazScript run headless (`daz_run.py`, Daz Studio 6's
undocumented `-headless` flag; no window, ~30 s), every Blender step a Python
script, so the route can be re-run end to end and the guide's steps are the
scripts' steps. A reader can do each step by hand in the GUI; the guide shows both.

### D5. Import from a .dbz, not the bare .duf
Diffeomorphic's Easy Import defaults to fitting meshes from a `.dbz` that its own Daz
Studio script writes (`export_to_blender.dsa`, from github.com/Diffeomorphic/import_daz,
`to_daz_studio/Scripts/Diffeomorphic/`; the Blender extension doesn't include it).
Without it the import stops ("Mesh fitting set to DBZ"). The no-DBZ mode `MORPHED` is
documented as incompatible with ERC morphs, which is exactly what drives the jaw and
lid bones in the FACS rig, so we installed the Daz script instead. Headless, its
`exportToBlender()` is called directly (its main function opens a dialog).

### D6. No subdivision
Daz SubD comes in as Subsurf modifiers. The avatar uses the base resolution (body
25k vertices); the bake also needs evaluated and stored vertex counts to match (the
first bake failed on the lashes, 2,028 vs 5,616).

### D7. Two-way controls for the sideways jaw and mouth
`jawLeft`, `jawRight`, `jawForward`, `mouthLeft`, `mouthRight` baked to nothing from
their `facs_bs_` halves: in Genesis 9 they are joint motions on two-way controls
(`facs_ctrl_JawLeft-Right`, `JawForward-Recess`, `MouthLeft-Right`, -1..1). The figure
faces -Y in Blender, so its own left is +X; +1 moves the jaw / mouth to +X (measured),
so `jawLeft` = +1, `jawRight` = -1, `jawForward` = `JawForward-Recess` +1, likewise
the mouth. Checked after export: every `…Left` shape moves the avatar's left side.

### D8. Drop everything Daz-only after the bake
VRM can't run Daz's drivers, joint correctives (JCMs) or morph formulas. After the
bake: all drivers removed, all shape keys except the 52 removed (562), Daz morph
properties removed, the 38 `(drv)` helper bones removed. Elbows and knees lose their
correctives; the twist bones now simply follow their parents (VRM 1.0 roll
constraints could restore twist later; not done).

### D9. T-pose as the rest pose, keeping the shape keys
Genesis 9 rests in an A-pose (upper arm 48° below horizontal); VRM wants a T-pose
and VPuppet's MODEL CHECKS warns otherwise. Upper arm, forearm and hand are aimed
along ±X, then the pose is baked into every mesh **per shape key** (evaluate the mesh
with each key alone at 1 under the posed armature, store those as the new keys), and
the pose is applied as rest. Blender's own "apply armature" refuses meshes with shape
keys; Diffeomorphic's Apply Rest Pose either keeps or applies all keys, not ours.

### D10. Strand hair becomes ribbon cards
The starter Pixie Cut is dForce *strand* hair: 447,010 vertices of lines, no faces
(43,510 strands of 7–8 points plus 100,371 loose points). glTF / VRM can't draw lines.
Diffeomorphic has no strands-to-cards tool, so `05_hair_cards.py` turns every 8th
strand into a 5 mm ribbon lying on the head (width across the strand, face away from
the head centre, tapering to the tip), with a generated texture that fades the edges
and tip; all on the head bone (short hair, no spring bones). 1 in 10 at 3.5 mm left
scalp showing; 1 in 8 at 5 mm covers it (87k vertices, 38k quads: the heaviest part).
Card hair (Eirgrid, Mavick…) skips this step but is heavy too (~430k vertices).

### D11. Plain glTF materials, textures ≤ 2048
Daz's Iray node groups don't export. Each material becomes a Principled BSDF: base
colour and normal map from the Daz textures (`_D_`, `_NM_`, `BaseColor`, `Normal`),
alpha *cutout* (glTF MASK, via a Round node) for brows, lashes and hair cards, all
three double-sided (they are single planes; one-sided hair cards half vanished in
VPuppet). The tear mesh and eye-moisture shells are deleted (path-tracer-only).
Textures are capped at 2048 px (JPEG 90; PNG for alpha).
Bugs on the way: hair invisible (alpha read from the colour channel of an RGBA
texture); black eyes (copying an in-memory Blender image gives a blank copy).

### D12. Brows tinted to the hair colour
The brow albedo is a light grey that Daz tints in its layered shader; the tint doesn't
come through, so the brows are multiplied by the hair colour.

### D13. No jaw bone in the humanoid
The mouth opens through the baked shapes (they include the jaw bone's movement). A VRM
`jaw` bone would let other apps' lip sync rotate it on top of the shapes.

### D14. VRM presets built from the ARKit shapes
Apps without perfect sync use the VRM presets (blink, aa ih ou ee oh, happy angry sad
relaxed surprised); they are bound as weighted mixes of the 52 baked shapes, so no
extra shape keys are needed.

### D15. Meta matches the Daz licence
`avatarPermission: onlyAuthor`, `commercialUsage: personalNonProfit`,
`allowRedistribution: false`, `modification: prohibited`, and a copyright line saying
it contains Daz content. The user can loosen these if their licences allow.

### D16. Eye colour: one of Genesis 9's combined eye maps
Daz layers a greyscale iris over the sclera; composited faithfully it gives a pale grey
iris that reads as staring in VPuppet. Starter Essentials has 15 combined maps
(`Runtime/Textures/DAZ/Characters/Genesis9/Base/Eyes/G9_EyesNN_D.jpg`, same UVs);
we use 05 (dark brown).

## Run log (15 Nov 2026)

| Step | Script | Time | Result |
|---|---|---|---|
| 1 Daz scene | `01_build_scene.dsa` | ~30 s | `g9-starter.duf` |
| 2 DBZ | `02_export_dbz.dsa` | ~22 s | `g9-starter.dbz` (13 MB) |
| 3 Import | `03_import.py` | ~14 s | 1 armature (181 bones, 285 FACS controls), body 246 shape keys |
| 4 Bake | `04_bake_arkit.py` | ~3 s | 52/52 move (jaw 3.06 cm, tongue 2.48 cm) |
| 5 Hair | `05_hair_cards.py` | ~10 s | 5,439 ribbons |
| 6 Strip + T-pose | `06_strip_tpose.py` | ~5 s | 562 keys and 38 helper bones removed |
| 7 Materials | `07_materials.py` | ~10 s | 16 materials, 24 textures |
| 8 VRM | `08_export_vrm.py` | ~10 s | `avatar.vrm` 66 MB |

`run_all.sh 3` re-runs steps 3–8 in 38 s. VPuppet's compatibility sweep: every check
PASS; expressions "13/13 presets, ARKit 52/52 (perfect sync)"; look-at: bone.

The VRM: 9 meshes, 179,537 triangles, 16 materials, 24 images (14.7 MB). Size
breakdown: body morph targets 33 MB (52 shapes × all 25k body vertices, though only
the face moves), hair cards 8 MB, textures 15 MB.

## Open issues

- **File size / weight**: 66 MB, 180k triangles. Biggest wins: store morphs sparsely or
  split the head from the body (−25 MB), fewer hair ribbons.
- **Twist bones** follow their parent rigidly (D8): forearm twist wraps at the wrist.
- **No spring bones**: nothing loose on this outfit; a skirt or long hair would need them.
- **Eyebrows** read faint at a distance.
- Not yet checked **in the running app** with a live camera (only the headless sweep).
