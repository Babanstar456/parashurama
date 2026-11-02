"""Rig the downloaded ZSU-23-4 "Shilka" model (Models_New/zsu-23-4_shilka.glb) for the 3D field drill and the urban drive.
    blender -b --factory-startup --python tools/blender/shilka.py -- Models_New/zsu-23-4_shilka.glb apps/web/public/models [--preview DIR]
The source model points +X; the game contract is +Y forward, Z up, origin on the ground at the hull centre.
Nodes written (same contract as guns.py, plus the vehicle nodes used by the drive):
  zsu234 (root) > yaw (turret ring) > pitch (trunnion) > muzzle0..3;  yaw > radar, eye (commander), sight_eye (gunner);
  root > wheel_l0..7, wheel_r0..7 (origin on the axle), track_l, track_r, driver_eye."""
import os, sys, math
import bpy, mathutils

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
SRC = argv[0] if argv else 'Models_New/zsu-23-4_shilka.glb'
OUT = argv[1] if len(argv) > 1 else 'apps/web/public/models'
PREV = argv[argv.index('--preview') + 1] if '--preview' in argv else None

# Positions in the SOURCE frame (+X forward), measured from the mesh (see the probe in the commit notes).
RING = (0.3, 0.0, 1.72)       # turret traverse axis (centre of the turret ring), on the hull roof
TRUNNION = (1.25, 0.0, 1.97)  # elevation axis of the gun mount, between the upper and lower barrel pairs
MUZZLES = [(3.25, -0.08, 2.15), (3.25, 0.11, 2.15), (3.55, -0.17, 1.84), (3.55, 0.20, 1.84)]

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
ROT = mathutils.Matrix.Rotation(math.radians(90), 4, 'Z')  # +X forward -> +Y forward
def to_game(p):
    return ROT @ mathutils.Vector(p)

meshes = [o for o in bpy.data.objects if o.type == 'MESH']
# Bake every mesh into world space (rotated to +Y forward), then drop the source hierarchy.
for o in meshes:
    o.data = o.data.copy()
    o.data.transform(ROT @ o.matrix_world)
    o.parent = None
    o.matrix_world = mathutils.Matrix.Identity(4)
for o in [o for o in bpy.data.objects if o.type != 'MESH']:
    bpy.data.objects.remove(o)

def empty(name, loc, parent=None):
    e = bpy.data.objects.new(name, None); e.empty_display_size = 0.2
    bpy.context.scene.collection.objects.link(e)
    if parent: e.parent = parent
    e.matrix_world = mathutils.Matrix.Translation(loc)
    return e

def set_origin(o, loc):
    """Move the object's origin to loc (world) without moving its geometry."""
    loc = mathutils.Vector(loc)
    o.data.transform(mathutils.Matrix.Translation(-loc))
    o.matrix_world = mathutils.Matrix.Translation(loc)

def parent_keep(o, p):
    mw = o.matrix_world.copy(); o.parent = p; o.matrix_world = mw

def join(objs, name):
    objs = [o for o in objs if o]
    if not objs: return None
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs: o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1: bpy.ops.object.join()
    o = bpy.context.view_layer.objects.active; o.name = name; o.data.name = name
    return o

base = lambda o: o.name.split('_shilka')[0]
by = {}
for o in meshes: by.setdefault(base(o), []).append(o)
get = lambda *names: [o for n in names for o in by.get(n, [])]

root = empty('zsu234', (0, 0, 0))
yaw = empty('yaw', to_game(RING), root)
pitch = empty('pitch', to_game(TRUNNION), yaw)
# Hull: everything static on the hull, joined (one mesh per material comes out of the exporter as primitives).
hull = join(get('hull', 'hull details', 'hull lens', 'hatch3', 'interior'), 'hull'); parent_keep(hull, root)
turret = join(get('turret', 'hatch', 'hatch2', 'interior turret'), 'turret'); set_origin(turret, yaw.matrix_world.translation); parent_keep(turret, yaw)
radar = join(get('antenna'), 'radar')
rc = sum((v.co for v in radar.data.vertices), mathutils.Vector()) / len(radar.data.vertices)
set_origin(radar, (rc.x, rc.y, 2.32)); parent_keep(radar, yaw)
guns = join(get('mount', 'weapon', 'weapon2', 'weapon3', 'weapon4'), 'guns'); set_origin(guns, pitch.matrix_world.translation); parent_keep(guns, pitch)
for i, m in enumerate(MUZZLES): empty(f'muzzle{i}', to_game(m), pitch)
# Wheels: each road wheel with its tyre, origin on its axle; named by side and position (front = 0).
wheels = []
for n in list(by):
    if n.startswith('wheel'):
        num = n[5:] or '1'
        parts = get(n, f'tire{num}') if num != '1' else get(n)
        w = join(parts, n)
        c = sum((v.co for v in w.data.vertices), mathutils.Vector()) / len(w.data.vertices)
        bb = [v.co for v in w.data.vertices]
        set_origin(w, (c.x, (min(v.y for v in bb) + max(v.y for v in bb)) / 2, (min(v.z for v in bb) + max(v.z for v in bb)) / 2))
        wheels.append(w)
for side, sel in (('l', lambda w: w.matrix_world.translation.x < 0), ('r', lambda w: w.matrix_world.translation.x >= 0)):
    for i, w in enumerate(sorted([w for w in wheels if sel(w)], key=lambda w: -w.matrix_world.translation.y)):
        w.name = f'wheel_{side}{i}'; parent_keep(w, root)
for n, nm in (('track', None), ('track2', None)):
    t = join(get(n), n)
    t.name = 'track_l' if sum(v.co.x for v in t.data.vertices) < 0 else 'track_r'; parent_keep(t, root)
# Crew eye points: commander head out of the cupola hatch, gunner's sight, driver's hatch (front left).
empty('eye', to_game((-0.5, 0.72, 3.15)), yaw)
empty('sight_eye', to_game((1.0, -0.55, 2.62)), yaw)
empty('driver_eye', to_game((2.55, 0.45, 2.1)), root)

for o in bpy.data.objects:
    if o.type == 'MESH':
        for m in o.data.materials:
            if m and m.use_nodes:
                for nd in m.node_tree.nodes:
                    if nd.type == 'BSDF_PRINCIPLED': nd.inputs['Roughness'].default_value = max(0.55, nd.inputs['Roughness'].default_value)

if PREV:
    os.makedirs(PREV, exist_ok=True)
    yaw.rotation_euler.z = math.radians(30); pitch.rotation_euler.x = math.radians(40)
    pts = [o.matrix_world @ mathutils.Vector(c) for o in bpy.data.objects if o.type == 'MESH' for c in o.bound_box]
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam')); bpy.context.scene.collection.objects.link(cam)
    sc = bpy.context.scene; sc.camera = cam
    sc.render.engine = 'BLENDER_WORKBENCH'; sc.display.shading.light = 'STUDIO'; sc.display.shading.color_type = 'TEXTURE'
    sc.render.resolution_x, sc.render.resolution_y = 900, 560
    for k, (dx, dy, dz) in enumerate([(9, 9, 5), (-10, -6, 4), (12, 0, 1.5)]):
        cam.location = (dx, dy, dz); cam.rotation_euler = (mathutils.Vector((0, 0, 1.4)) - cam.location).to_track_quat('-Z', 'Y').to_euler()
        sc.render.filepath = os.path.join(PREV, f'zsu234_{k}.png'); bpy.ops.render.render(write_still=True)
    yaw.rotation_euler.z = 0; pitch.rotation_euler.x = 0

bpy.ops.object.select_all(action='DESELECT')
def sel(o):
    o.select_set(True)
    for c in o.children: sel(c)
sel(root)
os.makedirs(OUT, exist_ok=True)
bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, 'zsu234.glb'), export_format='GLB', use_selection=True, export_apply=True,
                          export_yup=True, export_cameras=False, export_lights=False, export_image_format='JPEG', export_jpeg_quality=85)
for o in sorted(bpy.data.objects, key=lambda o: o.name):
    print('NODE', o.name, 'parent', o.parent.name if o.parent else None, tuple(round(x, 2) for x in o.matrix_world.translation))
print('EXPORTED zsu234')
