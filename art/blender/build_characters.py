"""Selectable globe characters from Alex's source models (owner files in art/characters/source, git-ignored).

Run headless:  blender -b --factory-startup -P art/blender/build_characters.py -- OUT_GLB [--render PREVIEW_DIR]
Output: one GLB with a root empty per character (char_bear, char_pig, char_rv), each normalized to
height 1, standing on z = 0, facing -Y (Blender) = +Z (glTF), like the Prince in props.glb.
Pig: decimated 27k -> ~4k tris. Textures downsized to 512 px, exported as JPEG.
"""
import math, sys
from pathlib import Path

import bpy
from mathutils import Vector, Matrix

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "art/characters/source"
argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = Path(argv[0]) if argv else ROOT / "web/assets/characters.glb"
PREVIEW = Path(argv[argv.index("--render") + 1]) if "--render" in argv else None

# yaw (degrees, around Z) that turns each model's face toward -Y
MODELS = {
    "bear": dict(file=SRC / "bearey-ducky-style-character/source/character_bear.gltf", yaw=0),
    "pig": dict(file=SRC / "cute-pig/source/Cute Pig.fbx", yaw=0, decimate=4200,
                tex=SRC / "cute-pig/textures/Pig_Color_Base_Color.png"),
    "rv": dict(file=SRC / "breaking-bad-rv/source/RV.fbx", yaw=0,
               tex=SRC / "breaking-bad-rv/textures/RV_Texture.png"),
}
PARTS = {"bear": {"character_bear": "bear_body", "character_bearHead": "bear_head",
                  "character_bearArmLeft": "bear_arm_l", "character_bearArmRight": "bear_arm_r"}}

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene


def import_model(path: Path):
    before = set(bpy.data.objects)
    if path.suffix == ".fbx":
        bpy.ops.import_scene.fbx(filepath=str(path))
    else:
        bpy.ops.import_scene.gltf(filepath=str(path))
    return [o for o in bpy.data.objects if o not in before]


def tris(objs):
    return sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objs if o.type == "MESH")


def bbox(objs):
    lo, hi = Vector((1e9,) * 3), Vector((-1e9,) * 3)
    bpy.context.view_layer.update()
    for o in objs:
        if o.type != "MESH":
            continue
        for v in o.data.vertices:
            w = o.matrix_world @ v.co
            lo, hi = Vector(map(min, lo, w)), Vector(map(max, hi, w))
    return lo, hi


def small_image(src: Path, name: str, size=512):
    img = bpy.data.images.load(str(src), check_existing=True)
    img.name = name
    if max(img.size) > size:
        img.scale(size, size)
    img.pack()
    return img


roots = []
for key, cfg in MODELS.items():
    objs = import_model(cfg["file"])
    for a in list(bpy.data.actions):  # the pig ships a turntable action; we animate procedurally
        bpy.data.actions.remove(a)
    for o in objs:
        o.animation_data_clear()
    meshes = [o for o in objs if o.type == "MESH"]
    # flatten: bake world transforms into mesh data for single-mesh models, keep hierarchy for part rigs
    rig = PARTS.get(key)
    if rig:
        for o in objs:
            if o.name in rig:
                o.name = rig[o.name]
    else:
        for o in meshes:
            mw = o.matrix_world.copy()
            o.parent = None
            o.data.transform(mw)
            o.matrix_world = Matrix.Identity(4)
        for o in objs:
            if o.type != "MESH":
                bpy.data.objects.remove(o)
        objs = meshes
        for i, o in enumerate(meshes):
            o.name = f"{key}_mesh{i}"
    if cfg.get("decimate"):
        for o in meshes:
            k = min(1, cfg["decimate"] / max(1, tris([o])))
            mod = o.modifiers.new("dec", "DECIMATE"); mod.ratio = k
            bpy.context.view_layer.objects.active = o
            with bpy.context.temp_override(object=o, active_object=o):
                bpy.ops.object.modifier_apply(modifier=mod.name)
    if cfg.get("tex"):
        img = small_image(cfg["tex"], f"{key}_albedo")
        for o in meshes:
            for m in o.data.materials:
                bs = next((n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
                for n in [n for n in m.node_tree.nodes if n.type == "TEX_IMAGE"]:
                    m.node_tree.nodes.remove(n)
                tex = m.node_tree.nodes.new("ShaderNodeTexImage"); tex.image = img
                m.node_tree.links.new(tex.outputs["Color"], bs.inputs["Base Color"])
                bs.inputs["Metallic"].default_value = 0
                bs.inputs["Roughness"].default_value = .6
                for link in list(m.node_tree.links):  # drop normal/bump chains
                    if link.to_socket == bs.inputs["Normal"]:
                        m.node_tree.links.remove(link)
    root = bpy.data.objects.new(f"char_{key}", None)
    scene.collection.objects.link(root)
    for o in objs:
        if o.parent is None:
            o.parent = root
    root.rotation_euler.z = math.radians(cfg["yaw"])
    bpy.context.view_layer.update()
    lo, hi = bbox(objs)
    k = 1 / (hi.z - lo.z)
    c = (lo + hi) / 2
    root.matrix_world = Matrix.Scale(k, 4) @ Matrix.Translation((-c.x, -c.y, -lo.z)) @ root.matrix_world
    bpy.context.view_layer.update()
    lo, hi = bbox(objs)
    print(f"char_{key}: tris={tris(objs)} size={tuple(round(x, 3) for x in hi - lo)} parts={[o.name for o in objs]}")
    roots.append(root)

# lay out side by side for the preview render (export resets positions in props.ts)
for i, r in enumerate(roots):
    r.location.x = (i - 1) * 1.6

bpy.ops.export_scene.gltf(filepath=str(OUT), export_format="GLB", export_yup=True, export_apply=True,
                          export_animations=False, export_cameras=False, export_lights=False,
                          export_image_format="JPEG", export_image_quality=85)
print("glb", OUT, OUT.stat().st_size)

if PREVIEW:
    PREVIEW.mkdir(parents=True, exist_ok=True)
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.color_type = "TEXTURE"
    scene.display.shading.light = "STUDIO"
    scene.render.resolution_x, scene.render.resolution_y = 900, 360
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam")); scene.collection.objects.link(cam)
    cam.data.type = "ORTHO"; cam.data.ortho_scale = 4.8; scene.camera = cam
    for name, loc, rot in [("front", (0, -8, .5), (90, 0, 0)), ("side", (8, 0, .5), (90, 0, 90))]:
        cam.location = loc; cam.rotation_euler = [math.radians(a) for a in rot]
        if name == "side":
            for i, r in enumerate(roots):
                r.location.x, r.location.y = 0, (1 - i) * 1.6
        scene.render.filepath = str(PREVIEW / f"{name}.png")
        bpy.ops.render.render(write_still=True)
