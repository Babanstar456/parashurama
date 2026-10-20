"""Build the drone library for the 3D field drill (real size, metres) and export one GLB with a root per type:
    ~/blender-4.5.13-linux-x64/blender -b --factory-startup --python tools/blender/drones.py -- apps/web/public/models [--preview DIR]
Roots are named drone_<threat id>; propellers are named prop* (the app spins them). Training models, not any one product."""
import os, sys, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy
from common import reset, mat, box, cyl, tube_y, sphere, empty, prism, export, preview, attach

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = argv[0] if argv else 'apps/web/public/models'
PREV = argv[argv.index('--preview') + 1] if '--preview' in argv else None
reset()
C = dict(
    carbon=mat('carbon', (0.02, 0.02, 0.022), 0.45, 0.1), grey=mat('drone_grey', (0.22, 0.23, 0.22), 0.5),
    white=mat('drone_white', (0.75, 0.76, 0.75), 0.4), olive=mat('drone_olive', (0.14, 0.16, 0.1), 0.6),
    tan=mat('drone_tan', (0.36, 0.33, 0.26), 0.6), lgrey=mat('drone_lgrey', (0.45, 0.47, 0.46), 0.45),
    motor=mat('motor', (0.12, 0.12, 0.13), 0.35, 0.9), prop=mat('prop', (0.03, 0.03, 0.03), 0.4),
    glass=mat('cam_glass', (0.01, 0.01, 0.02), 0.05), warhead=mat('warhead', (0.25, 0.27, 0.16), 0.5),
    battery=mat('battery', (0.1, 0.1, 0.35), 0.5), saffron=mat('roundel_saffron', (0.95, 0.42, 0.05), 0.5),
    rwhite=mat('roundel_white', (0.9, 0.9, 0.9), 0.5), rgreen=mat('roundel_green', (0.03, 0.35, 0.1), 0.5),
)

def prop(r, loc, parent, blades=2):
    """A propeller disc: blades as thin boxes, grouped under an empty named prop* so the app can spin it."""
    p = empty(f'prop{len([o for o in bpy.data.objects if o.name.startswith("prop")])}', loc, parent)
    for k in range(blades):
        a = 180 / blades * k
        box((r * 2, r * 0.16, 0.004), loc, C['prop'], p, (0, 0, a), 0.0)
    cyl(r * 0.12, 0.02, loc, C['motor'], p, verts=10)
    return p

def quad(name, span, body, arms=4, warhead=False, payload=False, gimbal=False, folded=False):
    root = empty(name)
    s = span / 2
    box((span * 0.22, span * 0.42, span * 0.1), (0, 0, 0), body, root, bevel=span * 0.02)
    box((span * 0.18, span * 0.2, span * 0.07), (0, -span * 0.08, span * 0.08), C['battery'] if warhead else body, root, bevel=span * 0.01)
    for i in range(arms):
        a = (i / arms) * 2 * math.pi + math.pi / arms
        x, y = math.sin(a) * s * 0.75, math.cos(a) * s * 0.75
        box((span * 0.05, s * 0.78, span * 0.035), (x / 2, y / 2, 0), C['carbon'] if not folded else body, root, (0, 0, -math.degrees(a)), span * 0.005)
        cyl(span * 0.05, span * 0.07, (x, y, span * 0.04), C['motor'], root, verts=14)
        prop(span * 0.22, (x, y, span * 0.085), root)
    box((span * 0.06, span * 0.03, span * 0.05), (0, span * 0.22, span * 0.02), C['glass'], root, bevel=0.0)   # camera
    if warhead:
        tube_y(span * 0.08, span * 0.55, span * 0.05, 0, -span * 0.07, C['warhead'], root, r2=span * 0.05)        # RPG-type warhead
        cyl(span * 0.004, span * 0.3, (span * 0.08, -span * 0.25, span * 0.12), C['carbon'], root, (60, 0, 0), 6)  # antenna
    if gimbal:
        sphere(span * 0.06, (0, span * 0.17, -span * 0.08), C['grey'], root)
        box((span * 0.05, span * 0.02, span * 0.05), (0, span * 0.23, -span * 0.08), C['glass'], root, bevel=0.0)
    if payload:
        cyl(span * 0.08, span * 0.25, (0, 0, -span * 0.17), C['warhead'], root, verts=14)
        for k in range(4):
            cyl(span * 0.006, span * 0.18, (math.cos(k * 1.57) * span * 0.1, math.sin(k * 1.57) * span * 0.1, -span * 0.08), C['carbon'], root, verts=6)
    for k in (-1, 1):  # landing legs / skids
        box((span * 0.02, span * 0.3, span * 0.1), (k * span * 0.1, 0, -span * 0.07), C['carbon'], root, bevel=0.0)
    return root

def plane(name, span, length, body, kind='conv', pusher=True, jet=False, vtol=False, vtail=False, high=False, roundel=False):
    root = empty(name)
    r = length * 0.06
    cyl(r, length * 0.82, (0, 0, 0), body, root, (-90, 0, 0), 20, bevel=0.0)
    sphere(r, (0, length * 0.41, 0), body, root, (1, 2.2, 1))                                     # nose
    cyl(r, length * 0.2, (0, -length * 0.5, 0), body, root, (-90, 0, 0), 20, r2=r * 0.35)          # tail cone
    if kind == 'delta':
        # Cropped delta (Shahed-type) with tip fins.
        prism([(0, length * 0.35), (span / 2, -length * 0.38), (span * 0.42, -length * 0.45), (-span * 0.42, -length * 0.45), (-span / 2, -length * 0.38)], length * 0.025, body, root, (0, 0, -length * 0.012), 0.004)
        for s in (-1, 1):
            box((length * 0.012, length * 0.16, length * 0.12), (s * span * 0.47, -length * 0.4, length * 0.05), body, root, bevel=0.002)
    elif kind == 'xwing':
        # Lancet-type: two cruciform wing sets.
        for y, sp in ((length * 0.15, span), (-length * 0.3, span * 0.9)):
            for a in (45, -45):
                box((sp, length * 0.13, length * 0.012), (0, y, 0), body, root, (0, a, 0), 0.002)
    else:
        z = r * 0.9 if high else 0
        box((span, length * 0.13, length * 0.016), (0, length * 0.02, z), body, root, bevel=0.004)
        if vtail:
            for s in (-1, 1):
                box((span * 0.16, length * 0.1, length * 0.012), (s * span * 0.06, -length * 0.5, r * 0.8), body, root, (0, s * -35, 0), 0.003)
        else:
            box((span * 0.32, length * 0.09, length * 0.012), (0, -length * 0.5, 0), body, root, bevel=0.003)
            box((length * 0.012, length * 0.09, length * 0.13), (0, -length * 0.5, length * 0.065), body, root, bevel=0.003)
        if roundel:
            # Indian Air Force roundel (saffron, white, green) on both wing tops: a visual friend clue.
            for s in (-1, 1):
                for rr, m, dz in ((span * 0.07, C['saffron'], 0.001), (span * 0.047, C['rwhite'], 0.002), (span * 0.024, C['rgreen'], 0.003)):
                    cyl(rr, 0.002, (s * span * 0.32, length * 0.02, z + length * 0.008 + dz), m, root, verts=24)
    if jet:
        cyl(r * 0.75, length * 0.3, (0, -length * 0.3, r * 1.4), C['grey'], root, (-90, 0, 0), 16, bevel=0.0)
    elif pusher:
        prop(length * 0.13 if span < 6 else length * 0.08, (0, -length * 0.62, 0), root)
    else:
        prop(length * 0.12, (0, length * 0.62, 0), root)
    if vtol:
        for sx in (-1, 1):
            box((length * 0.02, length * 0.9, length * 0.02), (sx * span * 0.22, 0, 0), body, root, bevel=0.002)
            for sy in (-1, 1):
                prop(span * 0.09, (sx * span * 0.22, sy * length * 0.42, length * 0.04), root)
    return root

def bird():
    root = empty('drone_bird')
    m = mat('bird', (0.12, 0.1, 0.08), 0.8)
    sphere(0.09, (0, 0, 0), m, root, (0.8, 2.2, 0.8))
    sphere(0.05, (0, 0.2, 0.02), m, root)
    for s in (-1, 1):
        w = empty(f'wing{"L" if s < 0 else "R"}', (s * 0.05, 0, 0), root)
        box((0.4, 0.15, 0.012), (s * 0.25, 0, 0), m, w, bevel=0.0)
    return root

roots = [
    quad('drone_fpv', 0.3, C['carbon'], warhead=True), quad('drone_fibre', 0.3, C['carbon'], warhead=True),
    quad('drone_swarm', 0.35, C['olive'], warhead=True), quad('drone_recon', 0.38, C['grey'], gimbal=True, folded=True),
    quad('drone_civil', 0.36, C['white'], gimbal=True, folded=True), quad('drone_dropper', 1.3, C['carbon'], arms=6, payload=True),
    plane('drone_loiter', 2.5, 3.5, C['lgrey'], kind='delta'), plane('drone_jetOwa', 3.0, 4.2, C['grey'], kind='delta', jet=True),
    plane('drone_aiStrike', 1.0, 1.6, C['tan'], kind='xwing'), plane('drone_vtol', 3.4, 2.1, C['lgrey'], vtol=True, vtail=True),
    plane('drone_tacIsr', 3.1, 1.9, C['grey'], high=True, pusher=False), plane('drone_male', 16, 8.5, C['lgrey'], vtail=True),
    plane('drone_friendly', 3.0, 2.0, C['olive'], high=True, pusher=False, roundel=True), bird(),
]
# Fibre-optic FPV: the spool on its back.
cyl(0.05, 0.06, (0, -0.1, 0.06), mat('spool', (0.75, 0.75, 0.7), 0.5), bpy.data.objects['drone_fibre'], (-90, 0, 0), 16)
names = [r.name for r in roots]
if PREV:
    os.makedirs(PREV, exist_ok=True)
    for i, r in enumerate(roots):  # line them up for a contact sheet
        r.location = ((i % 5) * 4.5 - 9, (i // 5) * 4.5, 1.5)
    bpy.data.objects['drone_male'].location = (0, 18, 3)
    preview(os.path.join(PREV, 'drones.png'), (0, 6, 1.5), 26, az=0, el=35, res=(1200, 800))
    for r in roots:
        r.location = (0, 0, 0)
os.makedirs(OUT, exist_ok=True)
export(os.path.join(OUT, 'drones.glb'), names)
print('EXPORTED drones', len(names))
