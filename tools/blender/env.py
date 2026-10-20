"""Environment kit for the 3D field drill: trees (scanned foliage on a modelled trunk), a decimated bush and rock,
sandbags, and Indian town buildings. Exports env.glb (roots named below) and tree impostor sprites.
    ~/blender-4.5.13-linux-x64/blender -b --factory-startup --python tools/blender/env.py -- apps/web/public [--preview DIR]
Needs the source scans first (node scripts/fetch-assets.mjs puts them in tools/blender/src-assets). Building materials are named wall_*, concrete,
window, metal_dark, tank; the app puts the downloaded PBR plaster and concrete textures on them."""
import os, sys, math, random
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy
from mathutils import Vector
from common import reset, mat, box, cyl, empty, export, preview, attach

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
PUB = argv[0] if argv else 'apps/web/public'
PREV = argv[argv.index('--preview') + 1] if '--preview' in argv else None
# Raw scans used only to build the kit (not shipped with the app): scripts/fetch-assets.mjs puts them here.
SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'src-assets')
A = os.path.join(SRC, 'models')
reset()
rnd = random.Random(23)

def import_gltf(name):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(A, name, f'{name}.gltf'))
    objs = [o for o in bpy.data.objects if o not in before and o.type == 'MESH']
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1:
        bpy.ops.object.join()
    o = bpy.context.object
    o.parent = None
    for x in [x for x in bpy.data.objects if x not in before and x.type != 'MESH']:
        bpy.data.objects.remove(x, do_unlink=True)
    return o

def decimate(o, target_tris):
    """Decimate to about target_tris triangles (game weight for instancing hundreds of copies)."""
    import bmesh
    n = sum(len(p.vertices) - 2 for p in o.data.polygons)
    if target_tris < n:
        # Scans come in with vertices split along texture seams, which stops the collapse early: weld them first.
        bm = bmesh.new(); bm.from_mesh(o.data); bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.0005); bm.to_mesh(o.data); bm.free()
    m = o.modifiers.new('dec', 'DECIMATE'); m.ratio = min(1.0, target_tris / max(1, n))
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.modifier_apply(modifier='dec')
    return o

def dup(o, loc=(0, 0, 0), scale=1.0, rotz=0.0, parent=None):
    c = o.copy(); c.data = o.data; bpy.context.scene.collection.objects.link(c)
    c.location = loc; c.scale = (scale, scale, scale * rnd.uniform(0.8, 1.1)); c.rotation_euler = (0, 0, rotz)
    if parent is not None:
        attach(c, parent)
    return c

# --- vegetation and rock from the scans --------------------------------------------------------
shrub = decimate(import_gltf('shrub_02'), 1650); shrub.name = 'bush'  # original detail
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
dims = shrub.dimensions; print('bush tris', len(shrub.data.polygons), 'dims', tuple(round(d, 2) for d in dims))
rock = decimate(import_gltf('boulder_01'), 1500); rock.name = 'rock'
bark = mat('bark', (0.09, 0.07, 0.05), 0.9)

def render_foliage(path, seed=5):
    """Render a canopy clump to an RGBA texture: ~700 photographed leaves (ambientCG LeafSet013, CC0) on twigs."""
    import bmesh
    L = os.path.join(SRC, 'tex', 'leafset')
    lm = bpy.data.materials.new('leaf_src'); lm.use_nodes = True
    nt = lm.node_tree; b = nt.nodes['Principled BSDF']
    ct = nt.nodes.new('ShaderNodeTexImage'); ct.image = bpy.data.images.load(os.path.abspath(os.path.join(L, 'color.jpg')))
    ot = nt.nodes.new('ShaderNodeTexImage'); ot.image = bpy.data.images.load(os.path.abspath(os.path.join(L, 'opacity.jpg'))); ot.image.colorspace_settings.name = 'Non-Color'
    nt.links.new(ct.outputs['Color'], b.inputs['Base Color']); nt.links.new(ot.outputs['Color'], b.inputs['Alpha'])
    b.inputs['Roughness'].default_value = 0.7
    try: b.inputs['Subsurface Weight'].default_value = 0.15
    except Exception: pass
    r = random.Random(seed)
    me = bpy.data.meshes.new('clump'); bm = bmesh.new(); uv = bm.loops.layers.uv.new()
    for n in range(700):
        # Point in a squashed sphere, mostly near the shell; the leaf hangs outwards and a little down.
        while True:
            p = Vector((r.uniform(-1, 1), r.uniform(-1, 1), r.uniform(-1, 1)))
            if 0.35 < p.length <= 1: break
        p = Vector((p.x, p.y, p.z * 0.75))
        out = p.normalized()
        side = out.cross(Vector((0, 0, 1)))
        if side.length < 1e-3: side = Vector((1, 0, 0))
        side.normalize()
        rot = r.uniform(-1.2, 1.2)
        along = (Vector((0, 0, -1)) * 0.4 + out * 0.6).normalized()
        along = (along * math.cos(rot) + side * math.sin(rot)).normalized()
        across = along.cross(out).normalized()
        k = r.randrange(6); u0, u1 = k / 6, (k + 1) / 6
        ln, wd = r.uniform(0.17, 0.24), r.uniform(0.07, 0.1)
        cs = [p - across * wd / 2, p + across * wd / 2, p + across * wd / 2 + along * ln, p - across * wd / 2 + along * ln]
        f = bm.faces.new([bm.verts.new(c) for c in cs])
        for l, (u, v) in zip(f.loops, ((u0, 0), (u1, 0), (u1, 1), (u0, 1))):
            l[uv].uv = (u, v)
    bm.to_mesh(me); bm.free()
    cl = bpy.data.objects.new('clump', me); bpy.context.scene.collection.objects.link(cl); cl.data.materials.append(lm)
    twigs = [cyl(0.012, 1.1, (math.cos(a) * 0.35, math.sin(a) * 0.35, -0.1), bark, None, (r.uniform(40, 80), 0, math.degrees(a) + 90), 6) for a in [r.uniform(0, 6.28) for _ in range(6)]]
    others = [o for o in bpy.data.objects if o.type == 'MESH' and o is not cl and o not in twigs]
    for o in others:
        o.hide_render = True
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'; sc.cycles.device = 'CPU'; sc.cycles.samples = 64; sc.cycles.use_denoising = True
    sc.cycles.transparent_max_bounces = 64
    sc.render.film_transparent = True; sc.render.resolution_x = sc.render.resolution_y = 512
    sc.render.image_settings.file_format = 'PNG'; sc.render.image_settings.color_mode = 'RGBA'
    w = bpy.data.worlds.new('fol'); sc.world = w; w.use_nodes = True
    w.node_tree.nodes['Background'].inputs['Color'].default_value = (0.6, 0.7, 0.8, 1); w.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.9
    sun = bpy.data.lights.new('fol_sun', 'SUN'); sun.energy = 3.5
    so = bpy.data.objects.new('fol_sun', sun); sc.collection.objects.link(so); so.rotation_euler = (math.radians(30), math.radians(15), math.radians(25))
    cd = bpy.data.cameras.new('fol_cam'); cd.type = 'ORTHO'; cd.ortho_scale = 2.35; cam = bpy.data.objects.new('fol_cam', cd); sc.collection.objects.link(cam)
    cam.location = (0, -20, 0); cam.rotation_euler = (math.radians(90), 0, 0)
    sc.camera = cam; sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    for o in others:
        o.hide_render = False
    for o in [cl, so, cam] + twigs:
        bpy.data.objects.remove(o, do_unlink=True)
    print('FOLIAGE', path)

FOL = os.path.join(PUB, 'models', 'foliage.png')
os.makedirs(os.path.dirname(FOL), exist_ok=True)
render_foliage(FOL)
fol = bpy.data.materials.new('foliage'); fol.use_nodes = True
nt = fol.node_tree; bsdf = nt.nodes['Principled BSDF']; tex = nt.nodes.new('ShaderNodeTexImage'); tex.image = bpy.data.images.load(os.path.abspath(FOL))
nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color']); nt.links.new(tex.outputs['Alpha'], bsdf.inputs['Alpha'])
bsdf.inputs['Roughness'].default_value = 0.8
try: fol.blend_method = 'CLIP'
except Exception: pass

def card(center, size, rotz, parent):
    """Two crossed vertical quads plus one tilted, all with the foliage clump texture."""
    import bmesh
    me = bpy.data.meshes.new('cards'); bm = bmesh.new(); uv = bm.loops.layers.uv.new()
    for k, tilt in ((0, 0), (90, 0), (45, 65)):
        a = math.radians(rotz + k); t = math.radians(tilt)
        ux, uy = math.cos(a) * size / 2, math.sin(a) * size / 2
        up = Vector((-math.sin(a) * math.sin(t), math.cos(a) * math.sin(t), math.cos(t))) * size / 2
        cs = [Vector((-ux, -uy, 0)) - up, Vector((ux, uy, 0)) - up, Vector((ux, uy, 0)) + up, Vector((-ux, -uy, 0)) + up]
        f = bm.faces.new([bm.verts.new(Vector(center) + c) for c in cs])
        for l, (u, v) in zip(f.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):
            l[uv].uv = (u, v)
    bm.to_mesh(me); bm.free()
    o = bpy.data.objects.new('cards', me); bpy.context.scene.collection.objects.link(o); o.data.materials.append(fol)
    attach(o, parent)
    return o

def tree(name, h, crown, clumps, seed):
    r = random.Random(seed)
    root = empty(name)
    trunk_h = h * 0.42
    cyl(h * 0.03, trunk_h, (0, 0, trunk_h / 2), bark, root, verts=10, r2=h * 0.02)
    tips = []
    for k in range(5):
        a = k / 5 * 2 * math.pi + r.uniform(-0.3, 0.3)
        L = crown * r.uniform(0.3, 0.45)
        tip = Vector((math.cos(a) * L, math.sin(a) * L, trunk_h + h * r.uniform(0.15, 0.3)))
        b0 = Vector((0, 0, trunk_h * 0.92)); mid = (b0 + tip) / 2
        b = cyl(h * 0.012, (tip - b0).length, tuple(mid), bark, root, verts=6)
        b.rotation_euler = (tip - b0).to_track_quat('Z', 'Y').to_euler()
        tips.append(tip)
    for k in range(clumps):
        if k < len(tips):
            t = tips[k]
        else:
            a = r.uniform(0, 6.28); rr = r.uniform(0, 0.38) * crown
            t = Vector((math.cos(a) * rr, math.sin(a) * rr, trunk_h + h * r.uniform(0.2, 0.55)))
        card(tuple(t), crown * r.uniform(0.45, 0.65), r.uniform(0, 180), root)
    return root

trees = [tree('tree_a', 9, 7, 14, 1), tree('tree_b', 12, 9, 18, 2), tree('tree_c', 7, 5.5, 11, 3)]
TREE_H = {'tree_a': (9, 7), 'tree_b': (12, 9), 'tree_c': (7, 5.5)}
bush = empty('bush_r'); attach(dup(shrub, (0, 0, 0), 1.0), bush)
rockr = empty('rock_r'); attach(dup(rock, (0, 0, 0), 1.0), rockr)

# --- sandbag -----------------------------------------------------------------------------------
hess = mat('hessian', (0.32, 0.27, 0.17), 0.95)
sb = empty('sandbag')
o = box((0.62, 0.34, 0.16), (0, 0, 0.08), hess, sb, bevel=0.06)
o.modifiers['bevel'].segments = 3

# --- Indian town buildings -----------------------------------------------------------------------
walls = [mat('wall_cream', (0.78, 0.72, 0.6), 0.9), mat('wall_yellow', (0.8, 0.65, 0.35), 0.9), mat('wall_pink', (0.78, 0.6, 0.58), 0.9),
         mat('wall_blue', (0.58, 0.68, 0.74), 0.9), mat('wall_grey', (0.6, 0.6, 0.58), 0.9), mat('wall_white', (0.85, 0.85, 0.82), 0.9)]
conc = mat('concrete', (0.55, 0.54, 0.5), 0.95)
win = mat('window', (0.03, 0.04, 0.05), 0.2, 0.3)
grille = mat('metal_dark', (0.08, 0.08, 0.09), 0.5, 0.8)
tank = mat('tank', (0.02, 0.02, 0.02), 0.5)

def building(name, w, d, floors, wall, seed):
    r = random.Random(seed)
    root = empty(name)
    FH = 3.1
    H = floors * FH
    box((w, d, H), (0, 0, H / 2), wall, root, bevel=0.02)
    box((w + 0.1, d + 0.1, 0.25), (0, 0, H + 0.12), conc, root, bevel=0.01)          # roof slab edge
    for sx, sy, lx, ly in ((0, 1, w, 0.15), (0, -1, w, 0.15), (1, 0, 0.15, d), (-1, 0, 0.15, d)):
        box((lx, ly, 0.9), (sx * (w / 2 - 0.07), sy * (d / 2 - 0.07), H + 0.6), wall, root, bevel=0.01)  # parapet
    for f in range(floors):
        z = f * FH + 1.6
        box((w + 0.2, d + 0.2, 0.12), (0, 0, f * FH + FH), conc, root, bevel=0.005) if f < floors - 1 else None  # floor band
        for face in range(4):
            along = w if face < 2 else d
            n = max(1, int(along // 3.4))
            for i in range(n):
                if r.random() < 0.15:
                    continue
                u = -along / 2 + (i + 0.5) * along / n
                ww, wh = 1.2, 1.3
                if face == 0: loc, size = (u, d / 2 + 0.02, z), (ww, 0.06, wh)
                elif face == 1: loc, size = (u, -d / 2 - 0.02, z), (ww, 0.06, wh)
                elif face == 2: loc, size = (w / 2 + 0.02, u, z), (0.06, ww, wh)
                else: loc, size = (-w / 2 - 0.02, u, z), (0.06, ww, wh)
                box(size, loc, win, root, bevel=0.0)
                sh = (size[0] + 0.3, size[1] + 0.25, 0.08) if face < 2 else (size[0] + 0.25, size[1] + 0.3, 0.08)
                box(sh, (loc[0], loc[1], z + wh / 2 + 0.12), conc, root, bevel=0.005)   # chajja (window shade)
    if floors >= 2 and r.random() < 0.6:  # balcony on the front
        box((w * 0.5, 1.1, 0.15), (r.uniform(-w * 0.2, w * 0.2), d / 2 + 0.55, FH), conc, root, bevel=0.01)
        box((w * 0.5, 0.05, 0.9), (0, d / 2 + 1.08, FH + 0.5), grille, root, bevel=0.0)
    # Stair head room and black water tanks on the roof.
    sx, sy = r.uniform(-w * 0.25, w * 0.25), r.uniform(-d * 0.25, d * 0.25)
    box((2.6, 3.0, 2.4), (sx, sy, H + 1.2), wall, root, bevel=0.02)
    box((0.9, 0.06, 2.0), (sx, sy + 1.52, H + 1.0), grille, root, bevel=0.0)
    for k in range(r.choice((1, 1, 2))):
        tx, ty = sx + (k * 1.4 - 0.7), sy
        cyl(0.62, 1.2, (tx, ty, H + 2.4 + 0.65), tank, root, verts=20, bevel=0.03)
        cyl(0.2, 0.15, (tx, ty, H + 3.4), tank, root, verts=12)
    if r.random() < 0.5:  # door and a small shop shutter
        box((1.8, 0.08, 2.4), (r.uniform(-w * 0.3, w * 0.3), d / 2 + 0.03, 1.2), grille, root, bevel=0.0)
    return root

blds = []
for i in range(10):
    fl = [1, 1, 2, 2, 2, 3, 3, 4, 4, 5][i]
    blds.append(building(f'bld_{fl}_{i}', rnd.uniform(8, 13), rnd.uniform(9, 15), fl, walls[i % len(walls)], 100 + i))

# Cube-project UVs at 2 m per tile so the app's PBR textures tile at real scale.
for o in bpy.data.objects:
    if o.type == 'MESH' and (o.name.startswith('Cube') or o.name.startswith('Cylinder')) and o.data.users == 1:
        bpy.ops.object.select_all(action='DESELECT'); o.select_set(True); bpy.context.view_layer.objects.active = o
        bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.uv.cube_project(cube_size=2.0); bpy.ops.object.mode_set(mode='OBJECT')

roots = [t.name for t in trees] + ['bush_r', 'rock_r', 'sandbag'] + [b.name for b in blds]
for o in (shrub, rock):  # the sources stay out of the export
    o.hide_set(True); o.hide_render = True

# Tree impostors: each tree rendered side-on with a transparent background, for distant trees.
def impostor(t, path):
    s = bpy.context.scene
    for r in roots:
        bpy.data.objects[r].hide_render = r != t.name
        for c in bpy.data.objects[r].children_recursive:
            c.hide_render = r != t.name
    s.render.engine = 'CYCLES'; s.cycles.device = 'CPU'; s.cycles.samples = 32; s.cycles.use_denoising = True; s.cycles.transparent_max_bounces = 64
    s.render.film_transparent = True; s.render.resolution_x = s.render.resolution_y = 512
    s.render.image_settings.file_format = 'PNG'; s.render.image_settings.color_mode = 'RGBA'
    w = bpy.data.worlds.get('imp') or bpy.data.worlds.new('imp'); s.world = w; w.use_nodes = True
    w.node_tree.nodes['Background'].inputs['Strength'].default_value = 1.0
    if not bpy.data.objects.get('imp_sun'):
        sun = bpy.data.lights.new('imp_sun', 'SUN'); sun.energy = 3.5
        so = bpy.data.objects.new('imp_sun', sun); s.collection.objects.link(so); so.rotation_euler = (math.radians(40), 0, math.radians(30))
    cam = bpy.data.objects.get('imp_cam')
    if not cam:
        cd = bpy.data.cameras.new('imp_cam'); cd.type = 'ORTHO'; cam = bpy.data.objects.new('imp_cam', cd); s.collection.objects.link(cam)
    h, crown = TREE_H[t.name]
    zmax = h * 1.05; size = max(zmax, crown * 1.2) * 1.04
    cam.data.ortho_scale = size; cam.location = (0, -50, zmax / 2); cam.rotation_euler = (math.radians(90), 0, 0)
    s.camera = cam; s.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print('IMPOSTOR', path, round(size, 2))
    for r in roots:
        bpy.data.objects[r].hide_render = False
        for c in bpy.data.objects[r].children_recursive:
            c.hide_render = False

os.makedirs(os.path.join(PUB, 'models'), exist_ok=True)
for t in trees:
    impostor(t, os.path.join(PUB, 'models', f'{t.name}.png'))
if PREV:
    os.makedirs(PREV, exist_ok=True)
    for i, r in enumerate(roots):
        bpy.data.objects[r].location = ((i % 6) * 16 - 40, (i // 6) * 18, 0)
    bpy.context.scene.render.film_transparent = False
    preview(os.path.join(PREV, 'env.png'), (0, 14, 4), 75, az=-20, el=25, res=(1400, 800))
    for r in roots:
        bpy.data.objects[r].location = (0, 0, 0)
export(os.path.join(PUB, 'models', 'env.glb'), roots)
print('EXPORTED env', len(roots))
