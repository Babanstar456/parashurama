"""Build the three air-defence guns for the 3D field drill and export them as GLB.
    ~/blender-4.5.13-linux-x64/blender -b --factory-startup --python tools/blender/guns.py -- apps/web/public/models [--preview DIR] [--only zu23]
Proportions follow public overall dimensions (training models, not engineering drawings).
Each gun: root <id> with children "yaw" (turns with azimuth) and yaw/"pitch" (turns with elevation),
empties "muzzle0..n" (pitch), "eye" (the gunner's head, yaw) and "sight_eye" (sight eyepiece)."""
import os, sys, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy
from common import reset, mat, clear_mats, box, cyl, tube_y, torus, empty, wheel, side_prism, export, preview, attach

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = argv[0] if argv else 'apps/web/public/models'
PREV = argv[argv.index('--preview') + 1] if '--preview' in argv else None
ONLY = argv[argv.index('--only') + 1] if '--only' in argv else None

def paints():
    return dict(
        olive=mat('olive_paint', (0.115, 0.135, 0.075), 0.62),
        olive2=mat('olive_paint_dark', (0.075, 0.09, 0.05), 0.7),
        steel=mat('gun_steel', (0.05, 0.05, 0.048), 0.42, 0.85),
        blued=mat('blued_steel', (0.025, 0.026, 0.028), 0.35, 0.9),
        worn=mat('worn_metal', (0.28, 0.27, 0.25), 0.45, 0.8),
        rubber=mat('rubber', (0.018, 0.018, 0.018), 0.85),
        seat=mat('seat_canvas', (0.09, 0.08, 0.05), 0.9),
        glass=mat('lens', (0.02, 0.03, 0.04), 0.05, 0.0),
        brass=mat('brass', (0.55, 0.38, 0.12), 0.35, 1.0),
        black=mat('black_paint', (0.02, 0.02, 0.02), 0.6),
    )

# ---------------------------------------------------------------- ZU-23-2
def zu23():
    P = paints()
    root = empty('zu23')
    # Triangular base with three levelling jacks (front, rear left, rear right), wheels lifted off the ground.
    jacks = [(0, 1.75), (-1.2, -1.05), (1.2, -1.05)]
    for x, y in jacks:
        L = math.hypot(x, y); ang = math.degrees(math.atan2(x, y))
        box((0.16, L, 0.15), (x / 2, y / 2, 0.36), P['olive'], root, (0, 0, -ang), 0.015)
        cyl(0.045, 0.42, (x, y, 0.2), P['worn'], root, verts=12)          # jack screw
        cyl(0.09, 0.16, (x, y, 0.36), P['olive'], root, verts=16, bevel=0.01)  # jack housing
        cyl(0.17, 0.04, (x, y, 0.02), P['olive2'], root, verts=20, bevel=0.01)  # foot pad
        box((0.06, 0.25, 0.06), (x * 0.92 + 0.12, y * 0.92, 0.48), P['worn'], root, (0, 0, -ang), 0.005)  # jack handle
    cyl(0.62, 0.14, (0, 0, 0.42), P['olive'], root, verts=40, bevel=0.015)  # base plate
    cyl(0.5, 0.12, (0, 0, 0.55), P['olive2'], root, verts=40, bevel=0.01)   # race ring
    for s in (-1, 1):
        # Travelling wheels on their swing arms, raised for firing.
        box((0.12, 0.7, 0.12), (s * 0.78, -0.2, 0.5), P['olive'], root, (25, 0, 0), 0.01)
        wheel(0.39, 0.2, (s * 1.0, -0.42, 0.62), root, 'X', P['rubber'], P['olive'])
        box((0.28, 0.5, 0.04), (s * 1.0, -0.42, 1.05), P['olive'], root, (0, 0, 0), 0.01)  # mudguard
    # Upper carriage (traverses).
    yaw = empty('yaw', (0, 0, 0.6), root)
    cyl(0.48, 0.1, (0, 0, 0.66), P['olive'], yaw, verts=40, bevel=0.01)
    box((1.15, 0.9, 0.12), (0, -0.25, 0.76), P['olive'], yaw, bevel=0.02)  # floor plate
    for s in (-1, 1):
        side_prism([(-0.45, 0.8), (0.4, 0.8), (0.3, 1.32), (-0.2, 1.32)], 0.05, P['olive'], yaw, s * 0.47, 0.008)  # trunnion brackets
        cyl(0.07, 0.12, (s * 0.47, 0.0, 1.18), P['worn'], yaw, (0, 90, 0), 20)  # trunnion
        # Seats: layer (left) and second gunner (right), backrests and foot rests.
        box((0.36, 0.34, 0.06), (s * 0.48, -0.8, 1.0), P['seat'], yaw, bevel=0.02)
        box((0.36, 0.06, 0.36), (s * 0.48, -0.98, 1.2), P['seat'], yaw, (-12, 0, 0), 0.02)
        cyl(0.025, 0.25, (s * 0.48, -0.8, 0.86), P['worn'], yaw, verts=10)
        box((0.32, 0.12, 0.03), (s * 0.48, -0.25, 0.86), P['worn'], yaw, (20, 0, 0), 0.005)  # foot rest / firing pedal
    # Handwheels in front of the layer: elevation (right hand) and traverse (left hand).
    for (x, y, z, rot) in [(-0.27, -0.48, 1.14, (0, 90, 0)), (-0.7, -0.5, 1.1, (0, 90, 0))]:
        torus(0.13, 0.016, (x, y, z), P['worn'], yaw, rot)
        cyl(0.025, 0.2, (x + 0.08, y, z), P['worn'], yaw, (0, 90, 0), 10)
        cyl(0.018, 0.08, (x - 0.02, y + 0.1, z + 0.05), P['black'], yaw, (0, 90, 0), 8)  # handle
    box((0.2, 0.18, 0.25), (-0.55, -0.42, 1.1), P['olive'], yaw, bevel=0.01)  # traverse gearbox
    eye = empty('eye', (-0.52, -0.98, 1.92), yaw)
    # Elevating mass.
    pitch = empty('pitch', (0, 0.0, 1.18), yaw)
    box((0.62, 0.5, 0.12), (0, -0.05, 1.04), P['olive'], pitch, bevel=0.01)  # cradle
    for s in (-1, 1):
        x = s * 0.17
        box((0.15, 1.15, 0.2), (x, -0.08, 1.2), P['olive2'], pitch, bevel=0.012)   # receiver
        box((0.16, 0.6, 0.05), (x, -0.25, 1.32), P['olive'], pitch, bevel=0.01)    # feed cover
        box((0.05, 0.18, 0.07), (x, -0.62, 1.33), P['worn'], pitch, bevel=0.005)   # charging handle
        cyl(0.03, 0.5, (x, 0.22, 1.08), P['steel'], pitch, (-90, 0, 0), 14)       # recoil spring housing
        # Barrel: jacket at the breech, plain tube, the gas block, conical flash hider.
        tube_y(0.062, 0.32, 0.5, x, 1.2, P['steel'], pitch, verts=20)
        tube_y(0.04, 1.85, 0.82, x, 1.2, P['blued'], pitch, r2=0.034, verts=20)
        cyl(0.05, 0.08, (x, 1.35, 1.2), P['steel'], pitch, (-90, 0, 0), 16)
        tube_y(0.045, 0.24, 2.62, x, 1.2, P['steel'], pitch, r2=0.068, verts=20)
        cyl(0.07, 0.03, (x, 2.87, 1.2), P['steel'], pitch, (-90, 0, 0), 20)
        empty(f'muzzle{0 if s < 0 else 1}', (x, 2.9, 1.2), pitch)
        # 50-round ammunition boxes on the outside of each gun, with the belt chute.
        box((0.24, 0.48, 0.36), (s * 0.43, -0.3, 1.18), P['olive'], pitch, bevel=0.015)
        box((0.25, 0.49, 0.03), (s * 0.43, -0.3, 1.37), P['olive2'], pitch, bevel=0.005)
        box((0.1, 0.16, 0.12), (s * 0.29, -0.18, 1.3), P['olive2'], pitch, bevel=0.008)
    box((0.42, 0.06, 0.08), (0, 0.42, 1.12), P['olive'], pitch, bevel=0.008)    # cross member
    # ZAP-23 type sight on the left of the cradle, eyepiece towards the layer.
    box((0.14, 0.34, 0.24), (-0.36, -0.28, 1.5), P['olive2'], pitch, bevel=0.012)
    cyl(0.05, 0.08, (-0.36, -0.49, 1.52), P['black'], pitch, (-90, 0, 0), 16)
    cyl(0.04, 0.02, (-0.36, -0.535, 1.52), P['glass'], pitch, (-90, 0, 0), 16)
    box((0.2, 0.02, 0.16), (-0.36, -0.08, 1.55), P['glass'], pitch, bevel=0.0)    # collimator window
    box((0.04, 0.2, 0.14), (-0.27, -0.28, 1.36), P['olive2'], pitch, bevel=0.005)  # sight bracket
    empty('sight_eye', (-0.36, -0.6, 1.52), pitch)
    return root, ['zu23']

# ---------------------------------------------------------------- ZSU-23-4
def zsu234():
    P = paints()
    root = empty('zsu234')
    # Hull (side profile extruded across), sloped glacis, engine deck.
    side_prism([(-3.15, 0.5), (2.95, 0.5), (3.32, 0.95), (2.45, 1.62), (-2.95, 1.7), (-3.22, 1.25)], 2.3, P['olive'], root, 0, 0.03)
    for s in (-1, 1):
        box((0.42, 6.3, 0.04), (s * 1.36, -0.05, 1.12), P['olive'], root, bevel=0.01)       # fender
        box((0.04, 6.2, 0.38), (s * 1.57, -0.05, 0.95), P['olive2'], root, bevel=0.01)      # side skirt lip
        for i in range(6):
            wheel(0.33, 0.3, (s * 1.32, -2.45 + i * 0.93, 0.36), root, 'X', P['rubber'], P['olive2'])
        wheel(0.29, 0.3, (s * 1.32, -3.0, 0.62), root, 'X', P['olive2'], P['worn'])       # drive sprocket
        wheel(0.26, 0.3, (s * 1.32, 2.95, 0.55), root, 'X', P['olive2'], P['worn'])       # idler
        # Track: upper and lower runs and the ends.
        box((0.4, 5.9, 0.06), (s * 1.32, -0.03, 0.02), P['rubber'], root, bevel=0.01)
        box((0.4, 5.9, 0.06), (s * 1.32, -0.03, 0.72), P['rubber'], root, bevel=0.01)
        box((0.4, 0.06, 0.6), (s * 1.32, -3.3, 0.6), P['rubber'], root, (35, 0, 0), 0.01)
        box((0.4, 0.06, 0.6), (s * 1.32, 3.22, 0.5), P['rubber'], root, (-30, 0, 0), 0.01)
        cyl(0.07, 0.25, (s * 0.85, -3.18, 1.3), P['worn'], root, (90, 0, 0), 14)            # exhaust
    box((1.2, 0.5, 0.05), (0.6, 2.6, 1.62), P['olive2'], root, (-37, 0, 0), 0.01)           # driver's hatch
    box((0.6, 1.3, 0.08), (-0.6, -2.2, 1.74), P['olive2'], root, bevel=0.01)                # engine grille
    # Turret.
    yaw = empty('yaw', (0, -0.25, 1.72), root)
    cyl(1.15, 0.12, (0, -0.25, 1.76), P['olive2'], yaw, verts=48, bevel=0.01)
    side_prism([(-1.85, 1.75), (1.25, 1.75), (1.5, 2.0), (1.15, 2.55), (-1.6, 2.6), (-1.9, 2.15)], 2.85, P['olive'], yaw, 0, 0.03)
    for s in (-1, 1):
        box((0.35, 1.3, 0.4), (s * 1.58, -0.6, 2.12), P['olive'], yaw, bevel=0.02)          # side stowage boxes
    cyl(0.32, 0.18, (-0.62, -0.5, 2.68), P['olive'], yaw, verts=32, bevel=0.01)            # commander's cupola
    box((0.5, 0.5, 0.05), (-0.62, -0.75, 2.8), P['olive2'], yaw, (-60, 0, 0), 0.01)        # open hatch
    for k in range(4):
        box((0.06, 0.1, 0.08), (-0.62 + math.cos(k * 1.57) * 0.3, -0.5 + math.sin(k * 1.57) * 0.3, 2.78), P['glass'], yaw, bevel=0.0)
    box((0.22, 0.25, 0.22), (0.55, 0.8, 2.66), P['olive2'], yaw, bevel=0.01)              # gunner's sight head
    box((0.16, 0.02, 0.12), (0.55, 0.93, 2.68), P['glass'], yaw, bevel=0.0)
    cyl(0.012, 2.2, (0.9, -1.3, 3.6), P['black'], yaw, verts=6)                             # antenna
    # Radar on its mast at the turret rear (dish scans while searching).
    radar = empty('radar', (0, -1.45, 2.6), yaw)
    box((0.28, 0.28, 0.55), (0, -1.45, 2.85), P['olive2'], radar, bevel=0.01)
    cyl(0.7, 0.08, (0, -1.3, 3.35), P['worn'], radar, (-80, 0, 0), 32, bevel=0.01)
    cyl(0.05, 0.45, (0, -1.05, 3.38), P['worn'], radar, (-80, 0, 0), 10)
    box((0.12, 0.12, 0.12), (0, -0.84, 3.4), P['olive2'], radar, bevel=0.005)
    eye = empty('eye', (-0.62, -0.45, 3.2), yaw)  # commander, head out of the hatch
    empty('sight_eye', (0.55, 0.62, 2.68), yaw)
    # Guns: four 23 mm barrels, two pairs, on the elevating mass at the turret front.
    pitch = empty('pitch', (0, 1.25, 2.2), yaw)
    box((1.55, 0.45, 0.62), (0, 1.25, 2.2), P['olive2'], pitch, bevel=0.03)                # mantlet
    i = 0
    for sx in (-1, 1):
        for sz in (1, -1):
            x, z = sx * (0.42 if sz > 0 else 0.3), 2.2 + sz * 0.15
            tube_y(0.085, 0.55, 1.45, x, z, P['olive'], pitch, verts=20, bevel=0.005)      # cooling jacket
            tube_y(0.04, 1.45, 2.0, x, z, P['blued'], pitch, r2=0.034, verts=18)
            tube_y(0.042, 0.2, 3.42, x, z, P['steel'], pitch, r2=0.06, verts=18)
            empty(f'muzzle{i}', (x, 3.66, z), pitch); i += 1
    return root, ['zsu234']

# ---------------------------------------------------------------- 40 mm L/70
def l70():
    P = paints()
    root = empty('l70')
    # Four-wheel carriage on its jacks, outriggers down.
    side_prism([(-2.4, 0.5), (2.2, 0.5), (2.55, 0.7), (2.2, 0.85), (-2.5, 0.85)], 1.5, P['olive'], root, 0, 0.02)
    for sx in (-1, 1):
        for sy in (-1, 1):
            wheel(0.47, 0.3, (sx * 0.98, sy * 1.55, 0.55), root, 'X', P['rubber'], P['olive'])
            box((0.42, 0.75, 0.05), (sx * 0.98, sy * 1.55, 1.08), P['olive'], root, bevel=0.01)      # mudguard
            ang = math.degrees(math.atan2(sx * 1.25, sy * 1.0))
            box((0.14, 1.55, 0.13), (sx * 0.95, sy * 1.9, 0.45), P['olive'], root, (0, 0, -ang), 0.01)  # outrigger
            cyl(0.05, 0.4, (sx * 1.55, sy * 2.38, 0.22), P['worn'], root, verts=12)
            cyl(0.22, 0.05, (sx * 1.55, sy * 2.38, 0.025), P['olive2'], root, verts=24, bevel=0.01)
    box((0.12, 0.9, 0.1), (0, 2.85, 0.7), P['olive'], root, bevel=0.01)                            # towbar
    yaw = empty('yaw', (0, 0, 0.9), root)
    cyl(1.0, 0.16, (0, 0, 0.95), P['olive2'], yaw, verts=48, bevel=0.015)
    box((1.9, 1.7, 0.08), (0, -0.2, 1.05), P['olive'], yaw, bevel=0.02)                           # platform
    for s in (-1, 1):
        # Side housings (elevation and traverse gear), with the layers' seats behind them.
        side_prism([(-0.55, 1.05), (0.75, 1.05), (0.75, 1.55), (0.35, 2.05), (-0.45, 2.05)], 0.36, P['olive'], yaw, s * 0.62, 0.02)
        box((0.4, 0.38, 0.06), (s * 0.68, -0.85, 1.42), P['seat'], yaw, bevel=0.02)
        box((0.4, 0.06, 0.4), (s * 0.68, -1.05, 1.64), P['seat'], yaw, (-10, 0, 0), 0.02)
        cyl(0.03, 0.35, (s * 0.68, -0.85, 1.22), P['worn'], yaw, verts=10)
        torus(0.14, 0.016, (s * 0.88, -0.5, 1.55), P['worn'], yaw, (0, 90, 0))                     # handwheels
    # Upgrade kit: operator console with the thermal / TV display in front of the left layer.
    box((0.34, 0.08, 0.26), (-0.68, -0.48, 1.78), P['black'], yaw, (-20, 0, 0), 0.01)
    box((0.28, 0.01, 0.2), (-0.68, -0.525, 1.79), mat('screen', (0.02, 0.05, 0.04), 0.2, 0.0, (0.05, 0.25, 0.12)), yaw, (-20, 0, 0), 0.0)
    box((0.12, 0.1, 0.12), (-0.5, -0.62, 1.55), P['black'], yaw, bevel=0.01)                      # joystick box
    cyl(0.02, 0.14, (-0.5, -0.62, 1.66), P['black'], yaw, verts=8)
    eye = empty('eye', (-0.7, -1.05, 2.3), yaw)
    pitch = empty('pitch', (0, 0.25, 1.8), yaw)
    side_prism([(-1.05, 1.58), (0.55, 1.58), (0.6, 2.0), (-0.95, 2.05)], 0.5, P['olive2'], pitch, 0, 0.02)  # breech casing
    box((0.38, 0.46, 0.85), (0, -0.35, 2.42), P['olive'], pitch, bevel=0.02)                     # loading rack
    for k in range(5):
        for j in (-1, 1):
            cyl(0.022, 0.42, (j * 0.08, -0.35, 2.12 + k * 0.13), P['brass'], pitch, (-90, 0, 0), 10)  # rounds in clips
    for s in (-1, 1):
        cyl(0.05, 1.1, (s * 0.15, 0.95, 1.66), P['steel'], pitch, (-90, 0, 0), 16)              # recoil cylinders
    tube_y(0.1, 0.45, 0.55, 0, 1.82, P['olive2'], pitch, verts=24)                              # barrel jacket
    tube_y(0.065, 2.65, 1.0, 0, 1.82, P['blued'], pitch, r2=0.052, verts=24)
    tube_y(0.06, 0.12, 3.62, 0, 1.82, P['steel'], pitch, verts=24)
    tube_y(0.065, 0.42, 3.72, 0, 1.82, P['steel'], pitch, r2=0.12, verts=24)                    # conical flash suppressor
    empty('muzzle0', (0, 4.16, 1.82), pitch)
    # Electro-optical sight pod: thermal imager, TV camera and laser rangefinder, on the left of the cradle.
    box((0.3, 0.55, 0.32), (-0.45, 0.2, 2.15), P['olive2'], pitch, bevel=0.025)
    cyl(0.1, 0.06, (-0.5, 0.49, 2.17), P['glass'], pitch, (-90, 0, 0), 24)
    cyl(0.05, 0.06, (-0.36, 0.49, 2.24), P['glass'], pitch, (-90, 0, 0), 16)
    cyl(0.04, 0.06, (-0.36, 0.49, 2.08), P['glass'], pitch, (-90, 0, 0), 16)
    empty('sight_eye', (-0.45, -0.1, 2.15), pitch)
    return root, ['l70']

BUILDS = {'zu23': zu23, 'zsu234': zsu234, 'l70': l70}
VIEW = {'zu23': ((0, 0.3, 1.0), 6.0), 'zsu234': ((0, 0, 1.6), 11.0), 'l70': ((0, 0.4, 1.4), 9.0)}
os.makedirs(OUT, exist_ok=True)
for gid, fn in BUILDS.items():
    if ONLY and gid != ONLY:
        continue
    reset(); clear_mats()
    root, names = fn()
    if PREV:
        os.makedirs(PREV, exist_ok=True)
        t, d = VIEW[gid]
        preview(os.path.join(PREV, f'{gid}.png'), t, d)
        preview(os.path.join(PREV, f'{gid}_rear.png'), t, d, az=150, el=22)
    export(os.path.join(OUT, f'{gid}.glb'), names)
    print('EXPORTED', gid)
