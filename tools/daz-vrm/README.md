# Daz 3D (Genesis 9) → VRM with perfect sync

Scripts for the route in the docs guide `apps/docs/content/docs/guides/daz3d.mdx`
("Making an avatar with Daz 3D"). Why each step is the way it is:
`docs/research/daz-to-vrm-log.md`.

| Step | Script | Runs in |
|---|---|---|
| 1 Build the figure (Starter Essentials) | `01_build_scene.dsa` | Daz Studio (headless via `daz_run.py`) |
| 2 Export the `.dbz` | `02_export_dbz.dsa` | Daz Studio; needs Diffeomorphic's `export_to_blender.dsa` |
| 3 Import | `03_import.py` | Blender + Diffeomorphic DAZ Importer |
| 4 Bake the 52 ARKit shapes | `04_bake_arkit.py` | Blender (`-y`) |
| 5 Strand hair → ribbon cards | `05_hair_cards.py` | Blender |
| 6 Strip Daz-only data, T-pose | `06_strip_tpose.py` | Blender |
| 7 glTF materials | `07_materials.py` | Blender |
| 8 Export VRM 1.0 | `08_export_vrm.py` | Blender + VRM Add-on |

`run_all.sh` runs them in order (`WORK=<folder> bash run_all.sh [from_step]`);
`render_check.py` renders the head or body from three sides to judge a step.
`check_ui.dsa` checks the Daz labels the guide names (menus, panes, content
paths, the Base Feminine dial's Parameters path) from inside Daz's GUI; run it
with `daz_run_gui.py`, which starts a separate, hidden Daz instance.

Everything made from Daz content goes in `WORK`, never in this repository (Daz EULA).
