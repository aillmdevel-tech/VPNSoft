"""Clay-style cartoon planet from the app's own land/elevation data.

Run headless:  blender -b -P art/blender/build_planet.py -- OUT_DIR [--render]
Inputs: android/assets/journey/world-land.js (Natural Earth 110m, public domain),
        android/assets/journey/elevation.js (Mapzen terrain 1024x512).
Outputs: OUT_DIR/planet.blend, OUT_DIR/planet-render.png (with --render).
"""
import base64, json, math, re, sys
from pathlib import Path

import bpy
import bmesh
import numpy as np
from mathutils import Vector, noise

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "android/assets/journey"
argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = Path(argv[0]) if argv else ROOT / "art/out"
RENDER = "--render" in argv
OUT.mkdir(parents=True, exist_ok=True)

W, H = 1024, 512
rng = np.random.default_rng(7)

# ---------- data ----------
def land_mask():
    text = (ASSETS / "world-land.js").read_text()
    rings = json.loads(text[text.index("["):text.rindex("]") + 1])
    mask = np.zeros((H, W), np.uint8)
    for ring in rings:
        pts = np.array(ring, float)
        xs = (pts[:, 0] + 180) / 360 * W
        ys = (90 - pts[:, 1]) / 180 * H
        x0, y0, x1, y1 = xs, ys, np.roll(xs, -1), np.roll(ys, -1)
        for row in range(max(0, int(ys.min())), min(H, int(ys.max()) + 1)):
            yc = row + .5
            hit = ((y0 <= yc) & (y1 > yc)) | ((y1 <= yc) & (y0 > yc))
            if not hit.any():
                continue
            t = (yc - y0[hit]) / (y1[hit] - y0[hit])
            cross = np.sort(x0[hit] + t * (x1[hit] - x0[hit]))
            for a, b in zip(cross[0::2], cross[1::2]):
                mask[row, max(0, int(a + .5)):min(W, int(b + .5))] ^= 1
    mask[int(H * (1 - 12 / 180)):, :] = 1  # Antarctica cap below -78
    return mask.astype(np.float32)


def elevation():
    text = (ASSETS / "elevation.js").read_text()
    data = re.search(r'atob\("([^"]+)"\)', text)[1]
    return np.frombuffer(base64.b64decode(data), np.uint8).reshape(H, W).astype(np.float32) / 255


def blur(img, radius, passes=3):
    out = img.copy()
    for _ in range(passes):
        k = 2 * radius + 1
        pad = np.pad(out, ((0, 0), (radius, radius)), mode="wrap")
        c = np.cumsum(pad, axis=1)
        c = np.concatenate([np.zeros((out.shape[0], 1)), c], axis=1)
        out = (c[:, k:] - c[:, :-k]) / k
        pad = np.pad(out, ((radius, radius), (0, 0)), mode="edge")
        c = np.cumsum(pad, axis=0)
        c = np.concatenate([np.zeros((1, out.shape[1])), c], axis=0)
        out = (c[k:, :] - c[:-k, :]) / k
    return out


def sample(img, lat, lon):
    x = (lon + 180) / 360 * W - .5
    y = (90 - lat) / 180 * H - .5
    x0 = math.floor(x); y0 = min(max(math.floor(y), 0), H - 2)
    fx, fy = x - x0, min(max(y - y0, 0), 1)
    xa, xb = x0 % W, (x0 + 1) % W
    top = img[y0, xa] * (1 - fx) + img[y0, xb] * fx
    bot = img[y0 + 1, xa] * (1 - fx) + img[y0 + 1, xb] * fx
    return top * (1 - fy) + bot * fy


def smooth(e0, e1, x):
    t = min(max((x - e0) / (e1 - e0), 0), 1)
    return t * t * (3 - 2 * t)


mask = land_mask()
soft = blur(mask, 3)          # rounded "puffy" coast
wide = blur(mask, 14)         # shallow water halo
elev = blur(elevation(), 2, 2)

# ---------- scene ----------
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene


def hexcol(h, a=1.0):
    h = h.lstrip("#")
    srgb = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    lin = [c / 12.92 if c <= .04045 else ((c + .055) / 1.055) ** 2.4 for c in srgb]
    return (*lin, a)


PAL = {
    "deep": "#1a7fe0", "shallow": "#4fd2ff", "sand": "#f2d27e", "desert": "#ffb648", "grass": "#79cf3a",
    "meadow": "#b4df45", "forest": "#4c9f2e", "rock": "#b08257", "snow": "#f5fbff",
    "trunk": "#9a6438", "leaf": "#3f9a2c", "leaf2": "#68c23a", "cloud": "#ffffff",
}


def material(name, color=None, rough=.5, attr=None, coat=0.0, sheen=0.0):
    m = bpy.data.materials.new(name)
    nodes = m.node_tree.nodes
    bsdf = next(n for n in nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Roughness"].default_value = rough
    if coat:
        bsdf.inputs["Coat Weight"].default_value = coat
        bsdf.inputs["Coat Roughness"].default_value = .08
    if sheen:
        bsdf.inputs["Sheen Weight"].default_value = sheen
    if attr:
        node = nodes.new("ShaderNodeVertexColor")
        node.layer_name = attr
        m.node_tree.links.new(node.outputs["Color"], bsdf.inputs["Base Color"])
    elif color:
        bsdf.inputs["Base Color"].default_value = hexcol(color)
    return m


def ico(name, subdiv, radius=1.0):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=subdiv, radius=radius)
    bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new(name, me)
    scene.collection.objects.link(ob)
    for p in me.polygons:
        p.use_smooth = True
    return ob


def mix(a, b, t):
    return tuple(a[i] * (1 - t) + b[i] * t for i in range(4))


SEA = 1.0
land = ico("Land", 7)
me = land.data
col = me.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
vcols = []
heights = []
for v in me.vertices:
    d = v.co.normalized()
    lat = math.degrees(math.asin(max(-1, min(1, d.z))))
    lon = math.degrees(math.atan2(d.y, d.x))
    s = smooth(.3, .7, sample(soft, lat, lon))
    e = sample(elev, lat, lon)
    n = noise.noise(d * 6) * .5 + noise.noise(d * 17) * .25
    h = SEA - .03 + s * (.058 + .1 * e ** .8 + .006 * n)
    v.co = d * h
    heights.append(h)
    polar = abs(lat) > 66 or (lat > 58 and -75 < lon < -10)  # Greenland/caps
    c = hexcol(PAL["grass"])
    c = mix(c, hexcol(PAL["meadow"]), smooth(-.15, .35, n))
    c = mix(c, hexcol(PAL["forest"]), smooth(.05, .25, e) * .7)
    c = mix(c, hexcol(PAL["rock"]), smooth(.28, .45, e))
    c = mix(c, hexcol(PAL["snow"]), max(smooth(.48, .6, e), 1.0 if polar else 0))
    alat = abs(lat)
    arid = smooth(11, 19, alat) * (1 - smooth(30, 37, alat))
    region = (lat > 0 and -18 < lon < 62) or (lat < 0 and 112 < lon < 150) or (lat > 0 and -118 < lon < -100)
    if region and not polar:
        c = mix(c, hexcol(PAL["desert"]), min(1, arid * 1.4) * (1 - smooth(.2, .35, e)))
    shore = 1 - smooth(SEA + .004, SEA + .018, h)
    if not polar:
        c = mix(c, hexcol(PAL["sand"]), shore)
    vcols.append(c)
for poly in me.polygons:
    for li, vi in zip(poly.loop_indices, poly.vertices):
        col.data[li].color = vcols[vi]
land.data.materials.append(material("LandClay", attr="Col", rough=.62, sheen=.25))

ocean = ico("Ocean", 6, SEA + .008)
oc = ocean.data.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
ocol = []
for v in ocean.data.vertices:
    d = v.co.normalized()
    lat = math.degrees(math.asin(max(-1, min(1, d.z))))
    lon = math.degrees(math.atan2(d.y, d.x))
    t = smooth(.02, .45, sample(wide, lat, lon))
    ocol.append(mix(hexcol(PAL["deep"]), hexcol(PAL["shallow"]), t))
for poly in ocean.data.polygons:
    for li, vi in zip(poly.loop_indices, poly.vertices):
        oc.data[li].color = ocol[vi]
ocean.data.materials.append(material("OceanGloss", attr="Col", rough=.12, coat=.6))

# ---------- trees ----------
def tree_mesh(kind):
    bm = bmesh.new()
    trunk = bmesh.ops.create_cone(bm, cap_ends=True, segments=6, radius1=.12, radius2=.09, depth=.5)
    bmesh.ops.translate(bm, verts=trunk["verts"], vec=(0, 0, .25))
    if kind == "pine":
        for z, r in ((.55, .55), (.9, .42), (1.2, .28)):
            c = bmesh.ops.create_cone(bm, cap_ends=True, segments=7, radius1=r, radius2=0, depth=.6)
            bmesh.ops.translate(bm, verts=c["verts"], vec=(0, 0, z))
    else:
        c = bmesh.ops.create_icosphere(bm, subdivisions=2, radius=.5)
        bmesh.ops.translate(bm, verts=c["verts"], vec=(0, 0, .9))
    me = bpy.data.meshes.new("Tree_" + kind)
    bm.to_mesh(me); bm.free()
    for p in me.polygons:
        p.use_smooth = kind != "pine"
        p.material_index = 0 if p.center.z < .45 and abs(p.center.x) < .13 and abs(p.center.y) < .13 else 1
    me.materials.append(trunk_mat); me.materials.append(leaf_mat if kind == "pine" else leaf2_mat)
    return me


trunk_mat = material("Trunk", PAL["trunk"], .7)
leaf_mat = material("Leaf", PAL["leaf"], .6, sheen=.3)
leaf2_mat = material("Leaf2", PAL["leaf2"], .6, sheen=.3)
trees = {k: tree_mesh(k) for k in ("pine", "round")}
forest = bpy.data.collections.new("Trees"); scene.collection.children.link(forest)
verts = land.data.vertices
placed = 0
for i in rng.permutation(len(verts)):
    if placed >= 560:
        break
    v = verts[i]
    h = heights[i]
    d = v.co.normalized()
    lat = math.degrees(math.asin(d.z))
    if h < SEA + .02 or abs(lat) > 62 or vcols[i][0] > .5:  # skip shore, poles, snow/sand
        continue
    if noise.noise(d * 5 + Vector((3, 1, 2))) < .08 or vcols[i][1] < vcols[i][0] * 1.4:
        continue
    kind = "pine" if lat > 45 or h > SEA + .07 else "round"
    ob = bpy.data.objects.new("tree", trees[kind])
    s = rng.uniform(.02, .032)
    ob.scale = (s, s, s * rng.uniform(.9, 1.3))
    ob.location = d * (h - .002)
    ob.rotation_mode = "QUATERNION"
    ob.rotation_quaternion = d.to_track_quat("Z", "Y") @ Vector((0, 0, 1)).rotation_difference(Vector((0, 0, 1)))
    forest.objects.link(ob)
    placed += 1

# ---------- clouds ----------
cloud_mat = material("Cloud", PAL["cloud"], .95, sheen=.6)
clouds = bpy.data.collections.new("Clouds"); scene.collection.children.link(clouds)
for k, (lat, lon, r) in enumerate([(52, -40, 1.22), (8, -25, 1.2), (-22, 48, 1.24), (35, 60, 1.18), (-40, -5, 1.22), (62, 30, 1.2)]):
    base = Vector((math.cos(math.radians(lat)) * math.cos(math.radians(lon)),
                   math.cos(math.radians(lat)) * math.sin(math.radians(lon)), math.sin(math.radians(lat))))
    tangent = base.cross(Vector((0, 0, 1))).normalized()
    up = tangent.cross(base).normalized()
    for j in range(6):
        puff = ico(f"cloud{k}_{j}", 3, 1)
        off = (j - 2.5) * .028
        rad = .035 + .02 * math.sin(j * 1.7 + k) ** 2 + (.015 if 1 < j < 4 else 0)
        puff.location = base * r + tangent * off + up * (abs(off) * -.25 + .01)
        puff.scale = (rad, rad, rad * .85)
        puff.data.materials.append(cloud_mat)
        clouds.objects.link(puff); scene.collection.objects.unlink(puff)

# ---------- light, camera, render ----------
world = bpy.data.worlds.new("Sky"); scene.world = world
bg = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
bg.inputs["Color"].default_value = hexcol("#9fe6ff"); bg.inputs["Strength"].default_value = .75

sun = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", "SUN"))
sun.data.energy = 4.6; sun.data.color = (1, .95, .86); sun.data.angle = math.radians(8)
sun.rotation_euler = (math.radians(50), math.radians(-25), math.radians(-35))
scene.collection.objects.link(sun)

look_lat, look_lon = math.radians(28), math.radians(14)
eye = Vector((math.cos(look_lat) * math.cos(look_lon), math.cos(look_lat) * math.sin(look_lon), math.sin(look_lat))) * 4.6
cam = bpy.data.objects.new("Camera", bpy.data.cameras.new("Camera"))
cam.data.lens = 60
cam.location = eye
cam.rotation_mode = "QUATERNION"
cam.rotation_quaternion = (-eye).to_track_quat("-Z", "Y")
scene.collection.objects.link(cam); scene.camera = cam

scene.render.resolution_x = scene.render.resolution_y = 900
scene.render.film_transparent = True
scene.view_settings.view_transform = "Standard"
try:
    scene.view_settings.look = "Medium High Contrast"
except TypeError:
    pass
scene.render.engine = "CYCLES"
scene.cycles.samples = 48
scene.cycles.use_denoising = True
scene.cycles.device = "CPU"  # Metal init hangs in background mode on this Mac
scene.render.threads_mode = "AUTO"

bpy.ops.wm.save_as_mainfile(filepath=str(OUT / "planet.blend"))
print("trees", placed, "land verts", len(verts))
if RENDER:
    scene.render.filepath = str(OUT / "planet-render.png")
    bpy.ops.render.render(write_still=True)
    print("render", scene.render.filepath)
