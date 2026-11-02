"""Convert the two downloaded gun models in Models_New/ into game-ready GLBs for the 3D field drill.
    blender -b --factory-startup --python tools/blender/import_guns.py -- [OUT_DIR] [--src DIR] [--only zu23|l70] [--preview DIR]
OUT_DIR defaults to apps/web/public/models and --src to Models_New (both relative to the repo root).
Inputs:
  fdae5a37901941fea3a02578506072a3.glb  ZU-23-2 twin 23 mm (hand-modelled, named parts, barrels along +X)
  flugabwehrkanone.glb                  photogrammetry scan of a 40 mm Bofors on a grassy plinth (barrel raised ~31 deg)
Output contract (same as guns.py, read by apps/web/src/field3d.ts): Blender Z up, +Y forward, metres, origin on the
ground at the traverse centre; root <id> > "yaw" (traverses) > "pitch" (elevates, origin on the trunnion, local X axis);
empties "muzzle0..n" (pitch), "eye" (yaw, gunner's head when seated) and "sight_eye" (sight eyepiece). At rest the
barrels are horizontal along +Y. Meshes are decimated to the game budget and textures re-encoded as JPEG.
The scan is cut into base / mount / gun by position (see bofors()); the cut is approximate and documented there."""
import os, sys, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy
import numpy as np
from mathutils import Matrix, Vector
from common import reset, clear_mats, empty, attach, preview

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = argv[0] if argv and not argv[0].startswith('--') else 'apps/web/public/models'
SRC = argv[argv.index('--src') + 1] if '--src' in argv else 'Models_New'
PREV = argv[argv.index('--preview') + 1] if '--preview' in argv else None
ONLY = argv[argv.index('--only') + 1] if '--only' in argv else None

# ---------------------------------------------------------------- helpers
def load(path):
    """Fresh scene with the GLB imported; every mesh baked to world space, unparented, single-user; empties removed."""
    reset(); clear_mats()
    bpy.ops.import_scene.gltf(filepath=path)
    meshes = [o for o in bpy.data.objects if o.type == 'MESH']
    for o in meshes:
        if o.data.users > 1:
            o.data = o.data.copy()
        mw = o.matrix_world.copy()
        o.data.transform(mw)
        o.parent = None
        o.matrix_world = Matrix.Identity(4)
    for o in [o for o in bpy.data.objects if o.type != 'MESH']:
        bpy.data.objects.remove(o, do_unlink=True)
    return meshes

def tris(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)

def decimate(o, ratio, keep=96):
    """Collapse-decimate one object in place (small parts under `keep` triangles are left alone)."""
    n = tris(o)
    if n <= keep:
        return
    r = max(ratio, keep / n)
    if r >= 0.97:
        return
    m = o.modifiers.new('dec', 'DECIMATE')
    m.decimate_type = 'COLLAPSE'
    m.ratio = r
    m.use_collapse_triangulate = True
    dg = bpy.context.evaluated_depsgraph_get()
    old = o.data
    o.data = bpy.data.meshes.new_from_object(o.evaluated_get(dg))
    o.modifiers.clear()
    for i, mt in enumerate(old.materials):   # new_from_object keeps materials, but be explicit for safety
        if i >= len(o.data.materials):
            o.data.materials.append(mt)
    if old.users == 0:
        bpy.data.meshes.remove(old)

def join(objs, name):
    objs = [o for o in objs if o is not None]
    if not objs:
        return None
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1:
        bpy.ops.object.join()
    o = bpy.context.view_layer.objects.active
    o.name = o.data.name = name
    return o

def transform(objs, M):
    for o in objs:
        o.data.transform(M)
        o.data.update()

def smooth_by_angle(o, deg=35):
    """Smooth shading with hard creases above `deg` (flat panels stay flat, round parts round; exported as split normals)."""
    bpy.ops.object.select_all(action='DESELECT'); o.select_set(True); bpy.context.view_layer.objects.active = o
    bpy.ops.object.shade_smooth_by_angle(angle=math.radians(deg))

def olive_paint(objs, olive=(0.31, 0.34, 0.21), dark=0.5, max_sat=0.32):
    """Repaint low-saturation paint (greys, grey-greens) in the base-colour textures as olive drab, keeping each pixel's
    lightness (so wear, dirt and markings survive). Saturated colours (red caps, brown wood, blue glass) and near-black
    rubber are left alone."""
    import numpy as np
    lum_o = 0.299 * olive[0] + 0.587 * olive[1] + 0.114 * olive[2]
    done = set()
    for o in objs:
        for m in o.data.materials:
            if not m or not m.use_nodes: continue
            for nd in m.node_tree.nodes:
                if nd.type != 'BSDF_PRINCIPLED': continue
                inp = nd.inputs['Base Color']
                if not inp.is_linked:
                    c = inp.default_value; l = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
                    if max(c[:3]) - min(c[:3]) < max_sat * max(1e-3, max(c[:3])) and l > 0.04:
                        inp.default_value = (*(v / lum_o * l * dark for v in olive), c[3])
                    continue
                src = inp.links[0].from_node
                if src.type != 'TEX_IMAGE' or not src.image or src.image.name in done: continue
                im = src.image; done.add(im.name)
                px = np.array(im.pixels[:], dtype=np.float32).reshape(-1, 4)
                rgb = px[:, :3]; mx = rgb.max(1); mn = rgb.min(1); lum = rgb @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
                sat = (mx - mn) / np.maximum(mx, 1e-3)
                k = np.clip((max_sat - sat) / 0.08, 0, 1) * np.clip((lum - 0.05) / 0.06, 0, 1)
                new = np.outer(lum / lum_o * dark, np.array(olive, dtype=np.float32))
                px[:, :3] = np.clip(rgb * (1 - k[:, None]) + new * k[:, None], 0, 1)
                im.pixels[:] = px.ravel(); im.update()

def shrink_images(maxpx):
    for im in bpy.data.images:
        if im.size[0] > maxpx or im.size[1] > maxpx:
            k = maxpx / max(im.size)
            im.scale(max(1, int(im.size[0] * k)), max(1, int(im.size[1] * k)))

def split_faces(o, mask, name):
    """Move the faces where mask is True into a new object (returns it); o keeps the rest."""
    bpy.ops.object.select_all(action='DESELECT')
    bpy.context.view_layer.objects.active = o
    o.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='DESELECT')
    bpy.ops.object.mode_set(mode='OBJECT')
    o.data.polygons.foreach_set('select', mask.astype(bool))
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.separate(type='SELECTED')
    bpy.ops.object.mode_set(mode='OBJECT')
    new = [x for x in bpy.context.selected_objects if x is not o][0]
    new.name = new.data.name = name
    return new

def delete_faces(o, mask):
    bpy.ops.object.select_all(action='DESELECT')
    bpy.context.view_layer.objects.active = o
    o.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='DESELECT')
    bpy.ops.object.mode_set(mode='OBJECT')
    o.data.polygons.foreach_set('select', mask.astype(bool))
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.delete(type='FACE')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.delete_loose()
    bpy.ops.object.mode_set(mode='OBJECT')

def centers(o):
    a = np.zeros(len(o.data.polygons) * 3)
    o.data.polygons.foreach_get('center', a)
    return a.reshape(-1, 3)

def verts(o):
    a = np.zeros(len(o.data.vertices) * 3)
    o.data.vertices.foreach_get('co', a)
    return a.reshape(-1, 3)

def face_colours(o):
    """Mean texture colour under each face (RGB, from the first image of the first material)."""
    me = o.data
    im = next(n.image for n in me.materials[0].node_tree.nodes if n.type == 'TEX_IMAGE' and n.image)
    w, hgt = im.size
    px = np.zeros(w * hgt * 4, dtype=np.float32)
    im.pixels.foreach_get(px)
    px = px.reshape(hgt, w, 4)
    uv = np.zeros(len(me.loops) * 2)
    me.uv_layers.active.data.foreach_get('uv', uv)
    uv = uv.reshape(-1, 2)
    start = np.zeros(len(me.polygons), dtype=np.int64)
    count = np.zeros(len(me.polygons), dtype=np.int64)
    me.polygons.foreach_get('loop_start', start)
    me.polygons.foreach_get('loop_total', count)
    fuv = np.add.reduceat(uv, start) / count[:, None]
    u = np.clip((fuv[:, 0] % 1.0) * (w - 1), 0, w - 1).astype(int)
    v = np.clip((fuv[:, 1] % 1.0) * (hgt - 1), 0, hgt - 1).astype(int)
    return px[v, u, :3]

def drop_specks(o, min_area):
    """Delete loose pieces smaller than min_area (m^2): floating scan noise."""
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bm.faces.ensure_lookup_table()
    seen, kill = set(), []
    for f in bm.faces:
        if f.index in seen:
            continue
        comp, stack = [], [f]
        seen.add(f.index)
        while stack:
            g = stack.pop()
            comp.append(g)
            for e in g.edges:
                for h in e.link_faces:
                    if h.index not in seen:
                        seen.add(h.index)
                        stack.append(h)
        if sum(g.calc_area() for g in comp) < min_area:
            kill.extend(comp)
    bmesh.ops.delete(bm, geom=kill, context='FACES')
    bm.to_mesh(o.data)
    bm.free()
    print('  dropped', len(kill), 'speck faces from', o.name)

def bake_lowpoly(hi, target_tris, size, name):
    """Decimate a copy of `hi`, give it a fresh UV atlas and bake the scan's colour onto it. A plain decimate keeping
    the scan's own UVs does not work: its atlas is made of tiny islands, and collapsing across them shows the black
    atlas background. Returns the new object; `hi` is removed."""
    hi.name = hi.data.name = name + '_hi'
    lo = hi.copy()
    lo.data = hi.data.copy()
    bpy.context.scene.collection.objects.link(lo)
    lo.name = lo.data.name = name
    bpy.ops.object.select_all(action='DESELECT')
    bpy.context.view_layer.objects.active = lo
    lo.select_set(True)
    # The import splits the surface at every UV seam: weld it first so the decimate and the new atlas see one surface.
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.remove_doubles(threshold=0.0005)
    bpy.ops.object.mode_set(mode='OBJECT')
    drop_specks(lo, 0.0004)
    decimate(lo, target_tris / tris(lo), keep=0)
    bpy.ops.object.select_all(action='DESELECT')
    bpy.context.view_layer.objects.active = lo
    lo.select_set(True)
    while lo.data.uv_layers:
        lo.data.uv_layers.remove(lo.data.uv_layers[0])
    lo.data.uv_layers.new(name='UVMap')
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(72), island_margin=0.002, area_weight=0.6)
    bpy.ops.object.mode_set(mode='OBJECT')
    img = bpy.data.images.new(name + '_col', size * 2, size * 2)   # baked at 2x, then filtered down
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    m.use_backface_culling = True     # single-sided: hides the inner layer of the scanned sheet metal where it pokes through
    nt = m.node_tree
    bsdf = nt.nodes['Principled BSDF']
    bsdf.inputs['Roughness'].default_value = 0.78
    bsdf.inputs['Metallic'].default_value = 0.15
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = img
    nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    nt.nodes.active = tex
    lo.data.materials.clear()
    lo.data.materials.append(m)
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.cycles.samples = 4
    sc.render.bake.use_selected_to_active = True
    sc.render.bake.cage_extrusion = 0.07     # start well outside: the decimated sheet metal can sit a few cm inside the scan
    sc.render.bake.max_ray_distance = 0.14
    sc.render.bake.margin = 8
    hi.select_set(True)
    lo.select_set(True)
    bpy.context.view_layer.objects.active = lo
    bpy.ops.object.bake(type='DIFFUSE', pass_filter={'COLOR'})
    img.scale(size, size)
    img.pack()
    bpy.data.objects.remove(hi, do_unlink=True)
    for p in lo.data.polygons:
        p.use_smooth = True
    return lo

def export_glb(path, root_name, quality=82):
    """Like common.export, but re-encodes textures as JPEG to keep the GLB small."""
    bpy.ops.object.select_all(action='DESELECT')
    def sel(o):
        o.select_set(True)
        for c in o.children:
            sel(c)
    sel(bpy.data.objects[root_name])
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_apply=True, export_yup=True,
                              export_extras=True, export_cameras=False, export_lights=False, export_materials='EXPORT',
                              export_image_format='JPEG', export_jpeg_quality=quality)

def report(root_name):
    total = 0
    def walk(o, d):
        nonlocal total
        n = tris(o) if o.type == 'MESH' else 0
        total += n
        print('  ' * d + f'{o.name} [{o.type}] world={tuple(round(v, 3) for v in o.matrix_world.translation)}' + (f' tris={n}' if n else ''))
        for c in sorted(o.children, key=lambda c: c.name):
            walk(c, d + 1)
    walk(bpy.data.objects[root_name], 0)
    print(f'TOTAL_TRIS {root_name} {total}')

def preview_eevee(path, target, dist, az=-35, el=18, res=(960, 600), lens=40):
    """Like common.preview, but in Eevee, which honours single-sided (backface-culled) materials as the web app does."""
    s = bpy.context.scene
    s.render.engine = 'BLENDER_EEVEE_NEXT'
    s.render.resolution_x, s.render.resolution_y = res
    w = bpy.data.worlds.new('w'); s.world = w; w.use_nodes = True
    bg = w.node_tree.nodes['Background']; bg.inputs['Color'].default_value = (0.55, 0.65, 0.78, 1); bg.inputs['Strength'].default_value = 1.0
    sun = bpy.data.lights.new('sun', 'SUN'); sun.energy = 4.0
    so = bpy.data.objects.new('sun', sun); s.collection.objects.link(so); so.rotation_euler = (math.radians(50), math.radians(10), math.radians(-40))
    bpy.ops.mesh.primitive_plane_add(size=60, location=(0, 0, 0)); g = bpy.context.object; g.name = 'preview_ground'
    gm = bpy.data.materials.new('preview_ground'); gm.use_nodes = True
    gm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.32, 0.29, 0.22, 1); g.data.materials.append(gm)
    cam = bpy.data.cameras.new('cam'); cam.lens = lens
    co = bpy.data.objects.new('cam', cam); s.collection.objects.link(co)
    t = Vector(target); a, e = math.radians(az), math.radians(el)
    co.location = t + Vector((math.sin(a) * math.cos(e), -math.cos(a) * math.cos(e), math.sin(e))) * dist
    co.rotation_euler = (t - co.location).to_track_quat('-Z', 'Y').to_euler()
    s.camera = co
    s.render.filepath = path
    bpy.ops.render.render(write_still=True)
    for n in ('preview_ground', 'cam', 'sun'):
        o = bpy.data.objects.get(n)
        if o:
            bpy.data.objects.remove(o, do_unlink=True)

def previews(gid, target, dist):
    if not PREV:
        return
    os.makedirs(PREV, exist_ok=True)
    preview(os.path.join(PREV, f'{gid}.png'), target, dist)
    preview(os.path.join(PREV, f'{gid}_rear.png'), target, dist, az=150, el=22)
    preview_eevee(os.path.join(PREV, f'{gid}_eevee.png'), target, dist)
    preview_eevee(os.path.join(PREV, f'{gid}_eevee_rear.png'), target, dist, az=150, el=22)
    yaw, pitch = bpy.data.objects['yaw'], bpy.data.objects['pitch']
    yaw.rotation_euler.z = math.radians(30)
    pitch.rotation_euler.x = math.radians(40)
    bpy.context.view_layer.update()
    preview(os.path.join(PREV, f'{gid}_rig.png'), target, dist * 1.15, az=-70, el=15)
    yaw.rotation_euler.z = 0
    pitch.rotation_euler.x = 0
    bpy.context.view_layer.update()

# ---------------------------------------------------------------- ZU-23-2
ZU_SRC = 'fdae5a37901941fea3a02578506072a3.glb'
# Source frame: barrels along +X, bore axis z = 1.08, side discs (trunnion) centred x = 0.015, z = 1.05,
# traverse ring centred x = -0.295. Gunner sits on the -Y seat and looks into the offset eyepiece at x -0.70.
ZU_PITCH_GROUPS = ('Twin_barrel_visuals', 'Side_boxes')
ZU_PITCH_PARTS = ('Front_cradle_cheek', 'Front_open_cradle_floor')
ZU_STATIC_GROUPS = ('Chassis_0', 'Chassis_details', 'Wheels')

def zu23():
    path = os.path.join(SRC, ZU_SRC)
    # Classify before baking (group = child of the glTF scene root, part = parent of the mesh).
    reset(); clear_mats()
    bpy.ops.import_scene.gltf(filepath=path)
    def top(o):
        while o.parent and o.parent.name != 'GLTF_SceneRootNode':
            o = o.parent
        return o.name
    cls = {}
    for o in bpy.data.objects:
        if o.type != 'MESH':
            continue
        g, p = top(o), (o.parent.name if o.parent else '')
        if g.startswith(ZU_STATIC_GROUPS):
            c = 'base'
        elif g.startswith(ZU_PITCH_GROUPS) or p.startswith(ZU_PITCH_PARTS):
            c = 'gun'
        else:
            c = 'upper'          # turret, seats, sight
        cls[o.name] = (c, g, p)
    names = list(cls)
    meshes = [o for o in bpy.data.objects if o.type == 'MESH']
    for o in meshes:
        if o.data.users > 1:
            o.data = o.data.copy()
        mw = o.matrix_world.copy()
        o.data.transform(mw)
        o.parent = None
        o.matrix_world = Matrix.Identity(4)
    for o in [o for o in bpy.data.objects if o.type != 'MESH']:
        bpy.data.objects.remove(o, do_unlink=True)
    before = sum(tris(o) for o in meshes)
    # Keep detail where the gunner looks (ammunition boxes, sight, cradle in front of the seat); thin out the rest.
    eye_src = Vector((-1.075, -0.5, 1.55))   # the 'eye' empty below, in the source frame
    for o in meshes:
        c, g, p = cls[o.name]
        bb = [Vector(v) for v in o.bound_box]; ctr = sum(bb, Vector()) / 8
        near = (ctr - eye_src).length < 1.7
        r = 0.14 if g.startswith('Wheels') else 0.6 if p.startswith(('Barrel_', 'Muzzle_', 'Receiver_')) else 0.6 if near else 0.22
        decimate(o, r, keep=96)
    # Barrels along +Y, traverse centre at the origin.
    M = Matrix.Rotation(math.radians(90), 4, 'Z') @ Matrix.Translation((0.295, 0, 0))
    transform(meshes, M)
    groups = {c: [o for o in meshes if cls[o.name][0] == c] for c in ('base', 'upper', 'gun')}
    parts = {c: join(groups[c], f'zu23_{c}') for c in groups}
    print('ZU23 tris', before, '->', sum(tris(o) for o in parts.values()))
    for o in parts.values():
        smooth_by_angle(o, 35)
    olive_paint(parts.values())
    shrink_images(512)
    root = empty('zu23')
    attach(parts['base'], root)
    yaw = empty('yaw', (0, 0, 0.43), root)
    attach(parts['upper'], yaw)
    pitch = empty('pitch', (0, 0.31, 1.05), yaw)
    attach(parts['gun'], pitch)
    empty('muzzle0', (-0.14, 3.115, 1.08), pitch)
    empty('muzzle1', (0.14, 3.115, 1.08), pitch)
    empty('eye', (0.5, -0.78, 1.55), yaw)            # gunner on the right-hand seat, ~0.8 m above it
    empty('sight_eye', (0.415, -0.45, 1.595), yaw)   # just behind the offset sight eyepiece (sight body is on the carriage)
    return 'zu23', ((0, 0.4, 0.9), 6.5)

# ---------------------------------------------------------------- 40 mm Bofors (scan)
BOF_SRC = 'flugabwehrkanone.glb'
# Source frame (measured from the scan): barrel points ~-X, raised 30.7 deg; trunnion on the bore axis at x = 6.12
# (bearing boss in the side brackets, also the centre of the elevating arc); plinth / grass top at z = 3.0;
# pedestal footprint x 5.0..7.25, y -7.47..-5.42; traverse floor at z ~3.46.
BOF_TRUNNION_X = 6.12
BOF_GROUND_Z = 3.0
BOF_TRAVERSE_Z = 3.44
BOF_FOOT = (5.0, 7.25, -7.47, -5.42)

def bofors():
    meshes = load(os.path.join(SRC, BOF_SRC))
    for o in list(meshes):
        if o.data.materials and o.data.materials[0].name == 'sides':     # the grey sides of the turf block
            meshes.remove(o)
            bpy.data.objects.remove(o, do_unlink=True)
    scan = join(meshes, 'scan')
    before = tris(scan)
    # Bore axis from the free barrel (everything in front of the carriage, x < 4.25).
    V = verts(scan)
    b = V[V[:, 0] < 4.25]
    c = b.mean(0)
    d = np.linalg.svd(b - c)[2][0]
    d = -d if d[0] > 0 else d
    T = c + d * ((BOF_TRUNNION_X - c[0]) / d[0])
    elev = math.asin(d[2])
    lat = np.cross(d, [0, 0, 1]); lat /= np.linalg.norm(lat)
    up = np.cross(lat, d)
    print('BOFORS bore dir', d, 'elev', math.degrees(elev), 'trunnion', T)
    # 1. Remove the turf: everything at ground level, and anything low outside the pedestal footprint.
    F = centers(scan)
    x0, x1, y0, y1 = BOF_FOOT
    out = (F[:, 0] < x0) | (F[:, 0] > x1) | (F[:, 1] < y0) | (F[:, 1] > y1)
    rgb = face_colours(scan)
    green = (rgb[:, 1] > rgb[:, 0] * 1.12) & (rgb[:, 1] > rgb[:, 2] * 1.12) & (F[:, 2] < BOF_TRAVERSE_Z + 0.1)
    # Low faces are kept only under the traverse floor plate (5 cm grid of its footprint, grown by one cell).
    cell = 0.05
    plate = (F[:, 2] > BOF_TRAVERSE_Z - 0.04) & (F[:, 2] < BOF_TRAVERSE_Z + 0.16)
    ij = np.floor(F[:, :2] / cell).astype(np.int64)
    occ = {(a, b) for a, b in ij[plate]}
    occ = {(a + da, b + db) for a, b in occ for da in (-1, 0, 1) for db in (-1, 0, 1)}
    under = np.array([(a, b) in occ for a, b in ij])
    low = (F[:, 2] < BOF_TRAVERSE_Z - 0.04) & ~under
    N = np.zeros(len(scan.data.polygons) * 3)
    scan.data.polygons.foreach_get('normal', N)
    turf = (F[:, 2] < BOF_TRAVERSE_Z - 0.06) & (N.reshape(-1, 3)[:, 2] > 0.5)      # up-facing below the floor: turf
    turf |= (F[:, 2] < BOF_TRAVERSE_Z - 0.04) & (rgb[:, 1] > rgb[:, 0] * 1.04) & (rgb[:, 1] > rgb[:, 2] * 1.04)
    delete_faces(scan, (F[:, 2] < BOF_GROUND_Z + 0.03) | (out & (F[:, 2] < BOF_GROUND_Z + 0.3)) | green | low | turf)
    # 2. Elevating mass, in bore coordinates about the trunnion (t forward, s lateral +Y, h up). Faces are taken whole.
    F = centers(scan)
    R = F - T
    t, s, h = R @ d, R @ lat, R @ up
    x, z = F[:, 0], F[:, 2]
    gun = ((t > 0.12) & (np.hypot(s, h) < 0.16))                                              # barrel and jacket
    gun |= (t > 0.9) & (np.abs(s) < 0.24) & (h > -0.3) & (h < 0.25)                          # recoil rod, fittings
    gun |= (t > 0.5) & (t <= 0.9) & (np.abs(s) < 0.14) & (h > -0.25) & (h < 0.2)
    gun |= (t > -0.85) & (t <= 0.12) & (np.abs(s) < 0.16) & (h > -0.3) & (h < 0.8)          # breech, feed guides
    gun |= (t > 0.12) & (t < 0.95) & (h > 0.5) & (h < 1.0) & (np.abs(s) < 0.12)             # hose over the breech
    gun |= (x > 5.38) & (x < 5.64) & (z > 4.66) & (s < -0.1) & (s > -1.0)                    # sight arm and sight
    gun_o = split_faces(scan, gun, 'l70_gun')
    # 3. Fixed pedestal below the traverse floor; the rest traverses.
    F = centers(scan)
    base_o = split_faces(scan, F[:, 2] < BOF_TRAVERSE_Z, 'l70_base')
    mount_o = scan
    mount_o.name = mount_o.data.name = 'l70_mount'
    # 4. Into the game frame: origin on the ground under the trunnion, barrel azimuth to +Y; then lower the gun.
    O = Vector((T[0], T[1], BOF_GROUND_Z))
    az = math.atan2(d[1], d[0])
    M = Matrix.Rotation(math.pi / 2 - az, 4, 'Z') @ Matrix.Translation(-O)
    transform([gun_o, base_o, mount_o], M)
    Tn = M @ Vector(T)
    transform([gun_o], Matrix.Translation(Tn) @ Matrix.Rotation(-elev, 4, 'X') @ Matrix.Translation(-Tn))
    for o in (base_o, mount_o, gun_o):      # turf remnants under the plinth: clamp to the ground
        co = verts(o)
        co[:, 2] = np.maximum(co[:, 2], 0.0)
        o.data.vertices.foreach_set('co', co.ravel())
        o.data.update()
    G = verts(gun_o)
    muzzle_y = G[(np.abs(G[:, 0] - Tn.x) < 0.15) & (np.abs(G[:, 2] - Tn.z) < 0.15), 1].max()
    # 5. Budget: ~80k triangles, relatively more on the gun so the barrel silhouette stays clean; colour re-baked.
    gun_o = bake_lowpoly(gun_o, 24000, 1024, 'l70_gun')
    mount_o = bake_lowpoly(mount_o, 46000, 1024, 'l70_mount')
    base_o = bake_lowpoly(base_o, 8000, 512, 'l70_base')
    print('BOFORS tris', before, '->', tris(gun_o) + tris(mount_o) + tris(base_o))
    root = empty('l70')
    attach(base_o, root)
    yaw = empty('yaw', (0, 0, BOF_TRAVERSE_Z - BOF_GROUND_Z), root)
    attach(mount_o, yaw)
    pitch = empty('pitch', tuple(Tn), yaw)
    attach(gun_o, pitch)
    empty('muzzle0', (Tn.x, muzzle_y, Tn.z), pitch)
    empty('eye', (-0.77, -0.05, 1.52), yaw)                    # layer's seat (top 0.72 m) on the left, head ~0.8 m above
    empty('sight_eye', (-0.74, 0.5, Tn.z - 0.04), pitch)       # just behind the sight on the cradle's left arm
    return 'l70', ((0, 0.6, 1.1), 7.5)

BUILDS = {'zu23': zu23, 'l70': bofors}
os.makedirs(OUT, exist_ok=True)
for gid, fn in BUILDS.items():
    if ONLY and gid != ONLY:
        continue
    root, (target, dist) = fn()
    report(root)
    previews(gid, target, dist)
    export_glb(os.path.join(OUT, f'{gid}.glb'), root)
    print('EXPORTED', gid, os.path.getsize(os.path.join(OUT, f'{gid}.glb')))
