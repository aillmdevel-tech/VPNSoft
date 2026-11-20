"""Portraits for the hero picker: android/assets/journey/art/hero_<id>.webp (256 px, transparent).

Run headless:  blender -b --factory-startup -P art/blender/render_heroes.py -- PROPS_GLB CHARACTERS_GLB OUT_DIR
"""
import math, sys
from pathlib import Path

import bpy
from mathutils import Vector

props, chars, out = sys.argv[sys.argv.index("--") + 1:][:3]
OUT = Path(out); OUT.mkdir(parents=True, exist_ok=True)
HEROES = {"prince": "prince", "bear": "char_bear", "pig": "char_pig", "rv": "char_rv"}

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
for f in (props, chars):
    bpy.ops.import_scene.gltf(filepath=f)

try:
    scene.render.engine = "BLENDER_EEVEE"
except TypeError as e:
    scene.render.engine = str(e).split("'")[1] if "'" in str(e) else "BLENDER_WORKBENCH"
scene.render.film_transparent = True
scene.render.resolution_x = scene.render.resolution_y = 256
scene.render.image_settings.file_format = "WEBP"
scene.render.image_settings.color_mode = "RGBA"
scene.render.image_settings.quality = 88
scene.view_settings.view_transform = "Standard"

world = bpy.data.worlds.new("w"); scene.world = world
bg = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
bg.inputs["Color"].default_value = (.75, .85, 1, 1); bg.inputs["Strength"].default_value = 1.1
sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN")); scene.collection.objects.link(sun)
sun.data.energy = 3.2; sun.rotation_euler = (math.radians(50), 0, math.radians(-35))

cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam")); scene.collection.objects.link(cam)
cam.data.type = "ORTHO"; scene.camera = cam

roots = {k: bpy.data.objects[v] for k, v in HEROES.items()}


def bounds(root):
    lo, hi = Vector((1e9,) * 3), Vector((-1e9,) * 3)
    for o in [root, *root.children_recursive]:
        if o.type == "MESH":
            for v in o.bound_box:
                w = o.matrix_world @ Vector(v); lo = Vector(map(min, lo, w)); hi = Vector(map(max, hi, w))
    return lo, hi


for key, root in roots.items():
    keep = {root, *root.children_recursive}
    for o in scene.objects:
        if o.type in ("MESH", "EMPTY"):
            o.hide_render = o not in keep
    bpy.context.view_layer.update()
    lo, hi = bounds(root)
    c = (lo + hi) / 2
    size = max(hi - lo)
    d = Vector((math.sin(math.radians(-28)), -math.cos(math.radians(-28)), .32)).normalized()
    cam.location = c + d * 10
    cam.rotation_euler = (-d).to_track_quat("-Z", "Y").to_euler()
    # tight fit: extent of every vertex projected on the camera plane
    right = d.cross(Vector((0, 0, 1))).normalized(); up = right.cross(d).normalized()
    pts = [o.matrix_world @ v.co for o in [root, *root.children_recursive] if o.type == "MESH" and not o.hide_render for v in o.data.vertices]
    xs = [p.dot(right) for p in pts]; ys = [p.dot(up) for p in pts]
    mid = right * (min(xs) + max(xs)) / 2 + up * (min(ys) + max(ys)) / 2 + d * c.dot(d)
    cam.location = mid + d * 10
    cam.data.ortho_scale = max(max(xs) - min(xs), max(ys) - min(ys)) * 1.12
    scene.render.filepath = str(OUT / f"hero_{key}.webp")
    bpy.ops.render.render(write_still=True)
    print("hero", key, scene.render.filepath)
