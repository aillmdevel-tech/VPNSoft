"""Clay-style props and characters for the journey scene.

Run headless:  blender -b --factory-startup -P art/blender/build_props.py -- OUT_DIR [--render]
Outputs: OUT_DIR/props.glb (one empty per prop, parts as children), OUT_DIR/props.blend,
         with --render: OUT_DIR/icons/<name>.png (server list icons) and OUT_DIR/fox/####.png (avatar loop).
Units: 1 = prop height-ish, Z up in Blender (glTF exports Y up). Ground at z = 0.
"""
import math, sys
from pathlib import Path

import bpy
from mathutils import Vector, Euler

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = Path(argv[0]) if argv else Path(__file__).resolve().parents[2] / "art/out"
RENDER = "--render" in argv
OUT.mkdir(parents=True, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
MATS = {}


def lin(h):
    h = h.lstrip("#")
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return [x / 12.92 if x <= .04045 else ((x + .055) / 1.055) ** 2.4 for x in c]


def mat(hexc, rough=.55, metal=0.0, emit=0.0):
    key = (hexc, rough, metal, emit)
    if key in MATS:
        return MATS[key]
    m = bpy.data.materials.new(f"c{hexc.strip('#')}_{int(rough*100)}{'_m' if metal else ''}{'_e' if emit else ''}")
    b = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    b.inputs["Base Color"].default_value = (*lin(hexc), 1)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    if emit:
        b.inputs["Emission Color"].default_value = (*lin(hexc), 1)
        b.inputs["Emission Strength"].default_value = emit
    MATS[key] = m
    return m


def finish(ob, color, rough=.55, smooth=True, bevel=0.0, seg=2, metal=0.0, emit=0.0, subsurf=0):
    ob.data.materials.clear()
    ob.data.materials.append(mat(color, rough, metal, emit))
    if bevel:
        mod = ob.modifiers.new("bevel", "BEVEL"); mod.width = bevel; mod.segments = seg; mod.limit_method = "ANGLE"
    if subsurf:
        mod = ob.modifiers.new("sub", "SUBSURF"); mod.levels = subsurf; mod.render_levels = subsurf
    if smooth:
        ob.data.shade_smooth()
    else:
        ob.data.shade_flat()
    return ob


def add(kind, name, loc=(0, 0, 0), scale=(1, 1, 1), rot=(0, 0, 0), parent=None, **kw):
    ops = {
        "cube": bpy.ops.mesh.primitive_cube_add, "ico": bpy.ops.mesh.primitive_ico_sphere_add,
        "uv": bpy.ops.mesh.primitive_uv_sphere_add, "cyl": bpy.ops.mesh.primitive_cylinder_add,
        "cone": bpy.ops.mesh.primitive_cone_add, "torus": bpy.ops.mesh.primitive_torus_add,
    }
    ops[kind](location=(0, 0, 0), **kw)
    ob = bpy.context.active_object
    ob.name = name
    ob.scale = scale
    ob.rotation_euler = rot
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    ob.location = loc
    if parent:
        ob.parent = parent
    return ob


def empty(name, loc=(0, 0, 0), parent=None):
    e = bpy.data.objects.new(name, None)
    scene.collection.objects.link(e)
    e.location = loc
    if parent:
        e.parent = parent
    return e


def pivot(ob, point):
    """Move the object's origin to `point` (object-local coords) without moving the mesh."""
    off = Vector(point)
    ob.data.transform(__import__("mathutils").Matrix.Translation(-off))
    ob.location = ob.location + off
    return ob


C = dict(grass="#79cf3a", grass2="#9edb45", dirt="#c98a4b", dirt2="#a96c38", stone="#e9dcc4", stone2="#cdb99a",
         gold="#ffc93c", red="#e8483b", white="#fbfbf7", blue="#3aa0f0", glass="#8fd8ff", wood="#9a6438",
         leaf="#3f9a2c", leaf2="#68c23a", palm="#4cb33a", snow="#f5fbff", rock="#8d8a86", lava="#ff6a1f",
         navy="#2b4a8a", cream="#fff3d6", orange="#ff8a2b", ink="#1d2b26", pink="#ff9e9e", coat="#4f8f4a",
         hair="#f2a516", skin="#ffc99a", boot="#7a4a2a", scarf="#f6e7c1", scarf2="#e8b84a", fox="#ff8b2e", foxdark="#5a2e17")


def island(parent, r=1.0, h=.28):
    top = add("cyl", parent.name + "_grass", (0, 0, 0), (r, r, .06), parent=parent, vertices=20)
    pivot(top, (0, 0, -.06)); top.location = (0, 0, 0)
    finish(top, C["grass"], .6, bevel=.05, seg=3)
    side = add("cone", parent.name + "_dirt", (0, 0, -h / 2), (r * 1.0, r * 1.0, h / 2), parent=parent,
               vertices=20, radius1=1, radius2=.72, depth=2)
    side.rotation_euler = (math.pi, 0, 0)
    finish(side, C["dirt"], .7, bevel=.04, seg=2)
    return top


def tree(kind, parent, loc=(0, 0, 0), s=1.0):
    g = empty(f"{parent.name}_{kind}", loc, parent)
    t = add("cyl", g.name + "_trunk", (0, 0, .18 * s), (.06 * s, .06 * s, .18 * s), parent=g, vertices=6)
    finish(t, C["wood"], .7, smooth=False)
    if kind == "pine":
        for z, r in ((.42, .32), (.66, .25), (.86, .16)):
            c = add("cone", g.name + "_leaf", (0, 0, z * s), (r * s, r * s, .2 * s), parent=g, vertices=7, depth=2)
            finish(c, C["leaf"], .6, smooth=False, bevel=.01, seg=1)
    elif kind == "palm":
        t.scale = (1, 1, 1.6); t.location.z = .29 * s
        for k in range(5):
            a = k / 5 * math.tau
            f = add("cube", g.name + "_frond", (math.cos(a) * .17 * s, math.sin(a) * .17 * s, .6 * s),
                    (.2 * s, .055 * s, .015 * s), rot=(0, .45, a), parent=g)
            finish(f, C["palm"], .6, smooth=False)
    else:
        c = add("ico", g.name + "_leaf", (0, 0, .55 * s), (.3 * s, .3 * s, .32 * s), parent=g, subdivisions=2)
        finish(c, C["leaf2"], .6)
    return g


# ---------------- vegetation (instanced in runtime) ----------------
for kind in ("pine", "round", "palm"):
    root = empty("tree_" + kind)
    tree(kind, root)

# ---------------- city dioramas ----------------
def city_sofia():
    root = empty("city_sofia")
    island(root, 1.0)
    base = add("cube", "sofia_hall", (0, 0, .28), (.42, .32, .28), parent=root)
    finish(base, C["stone"], .55, smooth=False, bevel=.03)
    for x, y, r, z in ((0, 0, .2, .78), (.3, .2, .1, .62), (-.3, .2, .1, .62), (.3, -.2, .1, .62), (-.3, -.2, .1, .62)):
        drum = add("cyl", "sofia_drum", (x, y, z - r * .9), (r * .9, r * .9, r * .5), parent=root, vertices=12)
        finish(drum, C["stone2"], .55, bevel=.01)
        dome = add("uv", "sofia_dome", (x, y, z), (r, r, r * 1.15), parent=root, segments=16, ring_count=8)
        finish(dome, C["gold"], .25, metal=.6)
        sp = add("cone", "sofia_spire", (x, y, z + r * 1.25), (r * .18, r * .18, r * .4), parent=root, vertices=6, depth=2)
        finish(sp, C["gold"], .25, metal=.6)
    door = add("cube", "sofia_door", (0, -.325, .14), (.08, .01, .12), parent=root)
    finish(door, C["wood"], .6, smooth=False)
    for p in ((.7, .45), (-.72, .3), (.55, -.62), (-.6, -.55)):
        tree("round", root, (*p, 0), .7)
    return root


def city_zurich():
    root = empty("city_zurich")
    island(root, 1.0)
    m = add("cone", "zurich_alp", (-.25, .25, .45), (.62, .55, .45), parent=root, vertices=9, depth=2)
    finish(m, C["rock"], .8, smooth=False, bevel=.02)
    cap = add("cone", "zurich_snow", (-.25, .25, .72), (.3, .27, .19), parent=root, vertices=9, depth=2)
    finish(cap, C["snow"], .6, smooth=False, bevel=.01)
    m2 = add("cone", "zurich_alp2", (.35, .45, .3), (.38, .34, .3), parent=root, vertices=8, depth=2)
    finish(m2, C["rock"], .8, smooth=False)
    cap2 = add("cone", "zurich_snow2", (.35, .45, .5), (.18, .16, .11), parent=root, vertices=8, depth=2)
    finish(cap2, C["snow"], .6, smooth=False)
    house = add("cube", "zurich_chalet", (.25, -.3, .17), (.22, .18, .17), parent=root)
    finish(house, C["cream"], .6, smooth=False, bevel=.02)
    roof = add("cyl", "zurich_roof", (.25, -.3, .36), (.16, .27, .22), rot=(0, math.pi / 2, 0), parent=root, vertices=3)
    roof.rotation_euler = (0, 0, 0); roof.scale = (1, 1, 1)
    finish(roof, C["red"], .6, smooth=False, bevel=.015)
    for p in ((-.7, -.4), (.75, .0), (-.1, -.75)):
        tree("pine", root, (*p, 0), .75)
    return root


def city_chisinau():
    root = empty("city_chisinau")
    island(root, 1.0)
    for x, y in ((-.35, -.35), (.35, -.35), (-.35, .35), (.35, .35)):
        t = add("cyl", "chis_tower", (x, y, .32), (.15, .15, .32), parent=root, vertices=12)
        finish(t, C["stone"], .6, bevel=.02)
        c = add("cone", "chis_cap", (x, y, .74), (.18, .18, .12), parent=root, vertices=12, depth=2)
        finish(c, C["red"], .55, bevel=.01)
    for (x, y, sx, sy) in ((0, -.35, .35, .06), (0, .35, .35, .06), (-.35, 0, .06, .35), (.35, 0, .06, .35)):
        w = add("cube", "chis_wall", (x, y, .19), (sx, sy, .19), parent=root)
        finish(w, C["stone2"], .65, smooth=False, bevel=.015)
        for k in range(-2, 3):
            mer = add("cube", "chis_merlon", (x + (k * .13 if sx > sy else 0), y + (k * .13 if sy > sx else 0), .42),
                      (.035, .035, .04), parent=root)
            finish(mer, C["stone2"], .65, smooth=False)
    keep = add("cube", "chis_keep", (0, 0, .3), (.15, .15, .3), parent=root)
    finish(keep, C["stone"], .6, smooth=False, bevel=.02)
    flag = add("cube", "chis_flag", (.06, 0, .72), (.07, .005, .04), parent=root)
    finish(flag, C["gold"], .5, smooth=False)
    for p in ((.75, .3), (-.75, .15), (.1, .78)):
        tree("round", root, (*p, 0), .7)
    return root


def city_vilnius():
    root = empty("city_vilnius")
    island(root, 1.0)
    hill = add("uv", "viln_hill", (0, 0, 0), (.75, .75, .38), parent=root, segments=16, ring_count=8)
    finish(hill, C["grass2"], .65)
    t = add("cyl", "viln_tower", (0, 0, .55), (.17, .17, .26), parent=root, vertices=8)
    finish(t, C["red"], .7, smooth=False, bevel=.015)
    top = add("cyl", "viln_top", (0, 0, .85), (.13, .13, .06), parent=root, vertices=8)
    finish(top, C["stone"], .6, smooth=False)
    roof = add("cone", "viln_roof", (0, 0, .98), (.14, .14, .08), parent=root, vertices=8, depth=2)
    finish(roof, C["navy"], .5, smooth=False)
    for p in ((.7, -.45), (-.65, -.5), (-.5, .6)):
        tree("pine", root, (*p, 0), .7)
    return root


def city_auto():
    root = empty("city_auto")
    island(root, 1.0)
    for x, y, h, c in ((0, 0, .9, "glass"), (.32, .18, .6, "blue"), (-.3, .2, .5, "glass"), (.15, -.32, .4, "blue")):
        b = add("cube", "auto_tower", (x, y, h / 2), (.13, .13, h / 2), parent=root)
        finish(b, C[c], .2, smooth=False, bevel=.02, metal=.2)
        cap = add("cube", "auto_cap", (x, y, h + .02), (.1, .1, .02), parent=root)
        finish(cap, C["white"], .4, smooth=False)
    for p in ((.7, .4), (-.7, -.3), (-.2, -.7)):
        tree("round", root, (*p, 0), .65)
    return root


for f in (city_sofia, city_zurich, city_chisinau, city_vilnius, city_auto):
    f()

# ---------------- vehicles & nature ----------------
def plane():
    root = empty("plane")
    body = add("uv", "plane_body", (0, 0, 0), (.55, .16, .16), parent=root, segments=16, ring_count=10)
    finish(body, C["red"], .35)
    nose = add("uv", "plane_nose", (.52, 0, 0), (.08, .12, .12), parent=root, segments=12, ring_count=8)
    finish(nose, C["white"], .35)
    wing = add("cube", "plane_wing", (.05, 0, -.02), (.16, .62, .025), parent=root)
    finish(wing, C["white"], .4, smooth=False, bevel=.02)
    tail = add("cube", "plane_tail", (-.5, 0, .14), (.09, .02, .13), rot=(0, -.3, 0), parent=root)
    finish(tail, C["red"], .4, smooth=False, bevel=.015)
    stab = add("cube", "plane_stab", (-.5, 0, .02), (.07, .22, .02), parent=root)
    finish(stab, C["white"], .4, smooth=False, bevel=.01)
    win = add("uv", "plane_window", (.28, 0, .1), (.12, .1, .06), parent=root, segments=12, ring_count=6)
    finish(win, C["glass"], .1)
    prop = add("cube", "plane_prop", (.61, 0, 0), (.01, .25, .03), parent=root)
    finish(prop, C["ink"], .5, smooth=False)
    return root


def boat():
    root = empty("boat")
    hull = add("cube", "boat_hull", (0, 0, .08), (.5, .2, .09), parent=root)
    finish(hull, C["red"], .45, smooth=False, bevel=.06, seg=3)
    deck = add("cube", "boat_deck", (0, 0, .19), (.46, .17, .02), parent=root)
    finish(deck, C["white"], .5, smooth=False, bevel=.01)
    cab = add("cube", "boat_cabin", (-.08, 0, .3), (.18, .13, .1), parent=root)
    finish(cab, C["white"], .5, smooth=False, bevel=.03)
    chim = add("cyl", "boat_chimney", (-.12, 0, .48), (.05, .05, .09), parent=root, vertices=10)
    finish(chim, C["orange"], .5, bevel=.01)
    return root


def balloon():
    root = empty("balloon")
    env = add("uv", "balloon_env", (0, 0, .75), (.42, .42, .5), parent=root, segments=12, ring_count=10)
    # stripes: two materials alternate by face index around the sphere
    env.data.materials.clear(); env.data.materials.append(mat(C["red"], .45)); env.data.materials.append(mat(C["cream"], .45))
    for p in env.data.polygons:
        p.material_index = int((math.atan2(p.center.y, p.center.x) + math.pi) / (math.tau / 12)) % 2
    env.data.shade_smooth()
    bask = add("cube", "balloon_basket", (0, 0, .07), (.1, .1, .07), parent=root)
    finish(bask, C["wood"], .7, smooth=False, bevel=.02)
    for x, y in ((.08, .08), (-.08, .08), (.08, -.08), (-.08, -.08)):
        r = add("cyl", "balloon_rope", (x, y, .22), (.006, .006, .14), parent=root, vertices=4)
        finish(r, C["ink"], .7, smooth=False)
    return root


def whale():
    root = empty("whale")
    body = add("uv", "whale_body", (0, 0, 0), (.5, .26, .24), parent=root, segments=16, ring_count=10)
    finish(body, C["navy"], .4)
    belly = add("uv", "whale_belly", (.05, 0, -.08), (.4, .2, .14), parent=root, segments=12, ring_count=8)
    finish(belly, C["cream"], .5)
    tail = add("cube", "whale_tail", (-.55, 0, .08), (.08, .28, .02), rot=(0, .35, 0), parent=root)
    finish(tail, C["navy"], .4, smooth=False, bevel=.03, seg=3)
    for y in (.12, -.12):
        e = add("uv", "whale_eye", (.36, y * 1.6, .06), (.03, .03, .03), parent=root, segments=8, ring_count=6)
        finish(e, C["ink"], .2)
    return root


def volcano():
    root = empty("volcano")
    c = add("cone", "volcano_cone", (0, 0, .4), (.8, .8, .4), parent=root, vertices=12, radius1=1, radius2=.28, depth=2)
    finish(c, C["dirt2"], .8, smooth=False, bevel=.03)
    lava = add("cyl", "volcano_lava", (0, 0, .79), (.21, .21, .02), parent=root, vertices=12)
    finish(lava, C["lava"], .4, emit=2.0)
    return root


def meteor():
    root = empty("meteor")
    r = add("ico", "meteor_rock", (0, 0, 0), (1, .9, .85), parent=root, subdivisions=2)
    for v in r.data.vertices:
        v.co *= 1 + .18 * math.sin(v.co.x * 7) * math.cos(v.co.y * 5)
    finish(r, "#7b5a42", .9, smooth=False)
    return root


for f in (plane, boat, balloon, whale, volcano, meteor):
    f()

# ---------------- characters (parts with pivots for procedural animation) ----------------
def prince():
    root = empty("prince")
    hips = empty("prince_hips", (0, 0, .34), root)
    for side, x in (("l", .07), ("r", -.07)):
        leg = add("cyl", f"prince_leg_{side}", (x, 0, -.16), (.055, .055, .16), parent=hips, vertices=10)
        pivot(leg, (0, 0, .16)); finish(leg, C["cream"], .6)
        boot = add("uv", f"prince_boot_{side}", (0, .02, -.32), (.07, .09, .05), parent=leg, segments=10, ring_count=6)
        finish(boot, C["boot"], .55)
    body = add("cone", "prince_body", (0, 0, .16), (.17, .15, .2), parent=hips, vertices=16, radius1=1, radius2=.62, depth=2)
    pivot(body, (0, 0, -.18)); finish(body, C["coat"], .6, bevel=.02)
    belt = add("cyl", "prince_belt", (0, 0, -.1), (.165, .15, .02), parent=body, vertices=16)
    finish(belt, C["boot"], .5)
    for k in range(3):
        btn = add("uv", "prince_button", (0, -.14, .02 - k * .07), (.016, .01, .016), parent=body, segments=8, ring_count=4)
        finish(btn, C["gold"], .3, metal=.5)
    for side, x in (("l", .17), ("r", -.17)):
        arm = add("cyl", f"prince_arm_{side}", (x, 0, .06), (.045, .045, .12), rot=(0, 0, 0), parent=body, vertices=10)
        pivot(arm, (0, 0, .12)); finish(arm, C["coat"], .6)
        hand = add("uv", f"prince_hand_{side}", (0, 0, -.14), (.04, .04, .04), parent=arm, segments=10, ring_count=6)
        finish(hand, C["skin"], .6)
    pack = add("cube", "prince_pack", (0, .15, .04), (.12, .06, .14), parent=body)
    finish(pack, C["dirt"], .7, smooth=False, bevel=.04, seg=3)
    head = add("uv", "prince_head", (0, 0, .44), (.23, .22, .22), parent=body, segments=20, ring_count=12)
    pivot(head, (0, 0, -.16)); finish(head, C["skin"], .65)
    for k in range(14):
        a = k / 14 * math.tau
        if -2.2 < a - math.pi * 2 * (a > math.pi) < -0.95:
            continue  # keep the face clear
        z = .08 + .06 * math.sin(k * 2.3)
        cur = add("uv", "prince_curl", (math.cos(a) * .2, math.sin(a) * .19 + .02, z + .06), (.085, .085, .085),
                  parent=head, segments=10, ring_count=6)
        finish(cur, C["hair"], .55)
    crown = add("uv", "prince_hairtop", (0, .03, .1), (.24, .235, .17), parent=head, segments=14, ring_count=8)
    finish(crown, "#d9860f", .6)
    for side, x in (("l", .07), ("r", -.07)):
        eye = add("uv", f"prince_eye_{side}", (x * 1.15, -.205, -.01), (.03, .015, .04), parent=head, segments=10, ring_count=6)
        finish(eye, C["ink"], .2)
        hl = add("uv", f"prince_glint_{side}", (x * 1.15 + .01, -.218, .005), (.008, .004, .008), parent=head, segments=6, ring_count=4)
        finish(hl, C["white"], .1, emit=.5)
        ch = add("uv", f"prince_cheek_{side}", (x * 1.8, -.19, -.06), (.03, .01, .02), parent=head, segments=8, ring_count=4)
        finish(ch, C["pink"], .7)
    nose = add("uv", "prince_nose", (0, -.225, -.035), (.022, .02, .02), parent=head, segments=8, ring_count=6)
    finish(nose, C["skin"], .6)
    scarf = add("torus", "prince_scarf", (0, 0, .24), (1, 1, 1), parent=body, major_radius=.13, minor_radius=.045,
                major_segments=16, minor_segments=8)
    finish(scarf, C["scarf"], .65)
    prev = scarf
    for k in range(4):
        link = add("cube", f"prince_scarf{k}", (0, .1 if k == 0 else .09, 0), (.045, .05, .02),
                   parent=prev if k else scarf, )
        if k == 0:
            link.location = (-.05, .12, 0)
        pivot(link, (0, -.045, 0))
        finish(link, C["scarf2"] if k == 3 else C["scarf"], .65, bevel=.012)
        prev = link
    return root


def fox():
    """Sitting chibi fox facing -Y. Parts are placed in world coords (wat) so pivots don't shift children."""
    root = empty("fox")

    def wpos(ob):
        return ob.location.copy() + (wpos(ob.parent) if ob.parent else Vector((0, 0, 0)))

    def wat(kind, name, world, scale, parent, **kw):
        ob = add(kind, name, (0, 0, 0), scale, parent=parent, rot=kw.pop("rot", (0, 0, 0)), **kw)
        ob.location = Vector(world) - wpos(parent)
        return ob

    def wpivot(ob, world):
        pivot(ob, Vector(world) - wpos(ob))

    body = wat("uv", "fox_body", (0, 0, .17), (.14, .13, .17), root, segments=16, ring_count=10)
    wpivot(body, (0, 0, .03)); finish(body, C["fox"], .6)
    finish(wat("uv", "fox_chest", (0, -.095, .19), (.085, .05, .11), body, segments=12, ring_count=8), C["white"], .65)
    for side, x in (("l", 1), ("r", -1)):
        finish(wat("cyl", f"fox_leg_{side}", (x * .055, -.075, .045), (.032, .032, .045), body, vertices=10), C["foxdark"], .6)
        finish(wat("uv", f"fox_haunch_{side}", (x * .095, .03, .075), (.065, .09, .065), body, segments=12, ring_count=8), C["fox"], .6)
    head = wat("uv", "fox_head", (0, -.03, .44), (.17, .15, .14), body, segments=18, ring_count=12)
    wpivot(head, (0, 0, .33)); finish(head, C["fox"], .6)
    for side, x in (("l", 1), ("r", -1)):
        finish(wat("uv", f"fox_cheek_{side}", (x * .075, -.095, .39), (.06, .05, .045), head, segments=12, ring_count=8), C["white"], .65)
        ear = wat("cone", f"fox_ear_{side}", (x * .095, -.005, .585), (.07, .035, .085), head, rot=(0, x * .38, 0), vertices=8, depth=2)
        wpivot(ear, (x * .08, -.005, .52)); finish(ear, C["fox"], .6, smooth=False, bevel=.01)
        finish(wat("cone", f"fox_eartip_{side}", (x * .118, -.02, .64), (.035, .02, .04), ear, rot=(0, x * .38, 0), vertices=8, depth=2), C["foxdark"], .6, smooth=False)
        eye = wat("uv", f"fox_eye_{side}", (x * .06, -.138, .48), (.022, .012, .03), head, segments=10, ring_count=8)
        finish(eye, C["ink"], .2)
        finish(wat("uv", f"fox_glint_{side}", (x * .054, -.15, .493), (.007, .004, .008), head, segments=6, ring_count=4), C["white"], .3, emit=.6)
    finish(wat("uv", "fox_muzzle", (0, -.15, .405), (.055, .065, .045), head, segments=12, ring_count=8), C["white"], .65)
    finish(wat("uv", "fox_nose", (0, -.212, .418), (.022, .016, .017), head, segments=8, ring_count=6), C["ink"], .2)
    tail = wat("uv", "fox_tail", (.15, .1, .13), (.075, .18, .075), body, rot=(.9, 0, -.5), segments=14, ring_count=8)
    wpivot(tail, (.07, .06, .05)); finish(tail, C["fox"], .6)
    finish(wat("uv", "fox_tailtip", (.21, .17, .27), (.06, .07, .06), tail, rot=(.9, 0, -.5), segments=10, ring_count=6), C["white"], .65)
    sc = wat("torus", "fox_scarf", (0, -.01, .315), (1, 1, .8), body, major_radius=.115, minor_radius=.035,
             major_segments=16, minor_segments=8)
    finish(sc, C["red"], .6)
    finish(wat("cube", "fox_scarfend", (.07, -.115, .25), (.035, .018, .06), sc, rot=(0, .3, 0)), C["red"], .6, bevel=.012)
    return root


prince(); fox()

# Apply modifiers so the export has the bevels.
for ob in list(scene.objects):
    if ob.type == "MESH" and ob.modifiers:
        bpy.context.view_layer.objects.active = ob
        for m in list(ob.modifiers):
            bpy.ops.object.modifier_apply(modifier=m.name)

# Lay props out on a grid for previews; runtime places them itself.
tops = [o for o in scene.objects if o.parent is None]
for i, o in enumerate(tops):
    o.location = ((i % 6) * 2.6, (i // 6) * 2.6, 0)

tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in scene.objects if o.type == "MESH")
print("props", len(tops), "tris", tris)
bpy.ops.wm.save_as_mainfile(filepath=str(OUT / "props.blend"))
bpy.ops.export_scene.gltf(filepath=str(OUT / "props.glb"), export_format="GLB", export_yup=True,
                          export_apply=True, export_animations=False, export_cameras=False, export_lights=False)
print("glb", (OUT / "props.glb").stat().st_size)

if RENDER:
    world = bpy.data.worlds.new("w"); scene.world = world
    bg = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
    bg.inputs["Color"].default_value = (*lin("#bfefff"), 1); bg.inputs["Strength"].default_value = .9
    sun = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", "SUN")); scene.collection.objects.link(sun)
    sun.data.energy = 3.4; sun.data.angle = math.radians(10); sun.rotation_euler = (math.radians(45), 0, math.radians(-35))
    scene.render.engine = "CYCLES"; scene.cycles.device = "CPU"; scene.cycles.samples = 32; scene.cycles.use_denoising = True
    scene.render.film_transparent = True
    scene.view_settings.view_transform = "Standard"
    cam = bpy.data.objects.new("Cam", bpy.data.cameras.new("Cam")); scene.collection.objects.link(cam); scene.camera = cam
    cam.data.type = "ORTHO"

    def shoot(target, path, size, scale, height=.35, yaw=-.6, pitch=.5):
        keep = {target, *target.children_recursive}
        for o in scene.objects:
            o.hide_render = o not in keep and o.type != 'LIGHT'
        tgt = target.location + Vector((0, 0, height))
        d = Vector((math.sin(yaw) * math.cos(pitch), -math.cos(yaw) * math.cos(pitch), math.sin(pitch)))
        cam.location = tgt + d * 6
        cam.rotation_mode = "QUATERNION"; cam.rotation_quaternion = (-d).to_track_quat("-Z", "Y")
        cam.data.ortho_scale = scale
        scene.render.resolution_x = scene.render.resolution_y = size
        scene.render.filepath = str(path)
        bpy.ops.render.render(write_still=True)

    (OUT / "icons").mkdir(exist_ok=True)
    for name in ("city_sofia", "city_zurich", "city_chisinau", "city_vilnius", "city_auto"):
        shoot(bpy.data.objects[name], OUT / "icons" / f"{name}.png", 192, 2.5, .25)
    shoot(bpy.data.objects["prince"], OUT / "icons" / "prince.png", 256, 1.05, .45, yaw=-.35, pitch=.12)
    # Fox avatar loop: gentle bob, head tilt, tail wag, ear flick.
    fx = bpy.data.objects["fox"]
    body = bpy.data.objects["fox_body"]; head = bpy.data.objects["fox_head"]; tail = bpy.data.objects["fox_tail"]
    earl = bpy.data.objects["fox_ear_l"]
    (OUT / "fox").mkdir(exist_ok=True)
    base = {o.name: o.rotation_euler.copy() for o in (body, head, tail, earl)}
    bz = body.location.z
    for f in range(16):
        t = f / 16 * math.tau
        body.location.z = bz + .012 * math.sin(t * 2)
        head.rotation_euler = Euler((base[head.name].x + .05 * math.sin(t), base[head.name].y + .12 * math.sin(t), base[head.name].z))
        tail.rotation_euler = Euler((base[tail.name].x, base[tail.name].y, base[tail.name].z + .35 * math.sin(t * 2)))
        earl.rotation_euler = Euler((base[earl.name].x + (.4 if f in (5, 6) else 0), base[earl.name].y, base[earl.name].z))
        shoot(fx, OUT / "fox" / f"{f:04d}.png", 160, .85, .34, yaw=-.35, pitch=.15)
    print("rendered icons and fox loop")
