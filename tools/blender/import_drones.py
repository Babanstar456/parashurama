"""Convert downloaded drone scans into game models (real size, metres, nose along +Y, one root named drone_<threat id>):
    blender -b --factory-startup --python tools/blender/import_drones.py -- <fpv_drone.glb> <shahed_136.glb> apps/web/public/models [<bayraktar_tb2.glb>]
Writes models/drone_fpv.glb, models/drone_swarm.glb and (with the fourth file) models/drone_male.glb; the 3D views use them in place of the built-in shapes from drones.py
when present. Each scan is cleaned (helper planes removed), decimated, and its textures cut to 512 px JPEG.
  fpv_drone.glb:  "FPV Drone" by Jeyhun1985, CC-BY-4.0 (see THIRD_PARTY_NOTICES.md).
  shahed_136.glb: "Shahed 136" by faintastic, CC-BY-4.0 (see apps/web/public/models/CREDITS.txt).
  bayraktar_tb2.glb: "Bayraktar TB2" by Kellot, CC-BY-4.0: the large military UAV (MALE class) model."""
import os, sys, math
import bpy, bmesh, mathutils

argv = sys.argv[sys.argv.index('--') + 1:]
FPV, SHAHED, OUT = argv[0], argv[1], argv[2] if len(argv) > 2 else 'apps/web/public/models'
TB2 = argv[3] if len(argv) > 3 else None

def load(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=path)
    return [o for o in bpy.data.objects if o.type == 'MESH']

def drop_helpers(meshes):
    """Sketchfab leftovers: tiny meshes whose material is fully transparent (alpha 0)."""
    keep = []
    for o in meshes:
        m = o.data.materials[0] if o.data.materials else None
        bsdf = m and m.node_tree and m.node_tree.nodes.get('Principled BSDF')
        a = bsdf.inputs['Alpha'].default_value if bsdf else 1
        linked = bsdf and bsdf.inputs['Alpha'].is_linked
        if len(o.data.polygons) < 50 and a < 0.01 and not linked: bpy.data.objects.remove(o)
        else: keep.append(o)
    return keep

def join_apply(meshes):
    bpy.ops.object.select_all(action='DESELECT')
    for o in meshes:
        o.select_set(True)
        # Bake parent transforms in, then unparent.
        mw = o.matrix_world.copy(); o.parent = None; o.matrix_world = mw
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1: bpy.ops.object.join()
    o = bpy.context.view_layer.objects.active
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    for e in [x for x in bpy.data.objects if x.type == 'EMPTY']: bpy.data.objects.remove(e)
    return o

def fit(o, yaw_deg, length=None):
    """Turn the nose to +Y, scale to the real length (along Y), centre on the origin."""
    o.rotation_mode = 'XYZ'  # the glTF importer leaves objects in quaternion mode
    o.rotation_euler = (0, 0, math.radians(yaw_deg)); bpy.ops.object.transform_apply(rotation=True)
    bb = [o.matrix_world @ mathutils.Vector(v) for v in o.bound_box]
    mn = mathutils.Vector([min(v[i] for v in bb) for i in range(3)]); mx = mathutils.Vector([max(v[i] for v in bb) for i in range(3)])
    k = length / (mx.y - mn.y) if length else 1
    o.location = -(mn + mx) / 2 * k; o.scale = (k, k, k)
    bpy.ops.object.transform_apply(location=True, scale=True)
    return (mx - mn) * k

def decimate(o, tris):
    n = sum(len(p.vertices) - 2 for p in o.data.polygons)
    if n > tris:
        d = o.modifiers.new('dec', 'DECIMATE'); d.ratio = tris / n
        bpy.ops.object.modifier_apply(modifier=d.name)
    return sum(len(p.vertices) - 2 for p in o.data.polygons)

def shrink_images(px=512):
    for im in bpy.data.images:
        if im.size[0] > px: im.scale(px, int(px * im.size[1] / im.size[0]))

def finish(o, name, out):
    o.name = name + '_mesh'
    root = bpy.data.objects.new(name, None); bpy.context.scene.collection.objects.link(root)
    o.parent = root
    bpy.ops.object.select_all(action='DESELECT'); root.select_set(True); o.select_set(True)
    shrink_images()
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', use_selection=True, export_apply=True, export_yup=True,
                              export_image_format='JPEG', export_jpeg_quality=85, export_cameras=False, export_lights=False)
    print('EXPORTED', out, os.path.getsize(out))

os.makedirs(OUT, exist_ok=True)
# FPV attack drone: camera end already along +Y; real size as scanned (about 0.55 m over the props).
o = join_apply(drop_helpers(load(FPV)))
size = fit(o, 0); print('fpv size', tuple(round(x, 2) for x in size), 'tris', decimate(o, 9000))
finish(o, 'drone_fpv', os.path.join(OUT, 'drone_fpv.glb'))
# Swarm drone (Shahed-136 type delta): the scan's nose is along -Y; real length about 3.5 m (span about 2.5 m).
o = join_apply(drop_helpers(load(SHAHED)))
size = fit(o, 180, 3.5); print('shahed size', tuple(round(x, 2) for x in size), 'tris', decimate(o, 8000))
finish(o, 'drone_swarm', os.path.join(OUT, 'drone_swarm.glb'))
# Large military UAV (MALE class, Bayraktar TB2 type): the scan's nose is along -Y; length 5.5 m gives the real span of about 12 m.
if TB2:
    o = join_apply(drop_helpers(load(TB2)))
    size = fit(o, 180, 5.5); print('tb2 size', tuple(round(x, 2) for x in size), 'tris', decimate(o, 9000))
    finish(o, 'drone_male', os.path.join(OUT, 'drone_male.glb'))
