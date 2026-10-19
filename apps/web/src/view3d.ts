// 3D tactical view: the same drill as the radar, shown as a live 3D battlespace (PS outcome 1: desktop / VR simulator).
// It only shows what the sensors show: undetected drones are invisible, and an unidentified drone is a yellow marker
// until it comes within camera range, so the 3D view never gives away the answer.
import * as THREE from 'three';
import { cameraRange, mulberry, visibleBlip, weatherFx, type Contact } from '@parashurama/engine';
import { app, on } from './app';
import { isLite, onLite } from './lite';
import { C, EFF, SIM, TYPES } from './cfg';
import { $ } from './dom';
import { kindOfCls } from './paper';

const S = 0.1;            // world units per metre (1 unit = 10 m)
const ALT = 2.2;          // altitude exaggeration so low drones are visible
const MODEL = 4.2;        // drone model size multiplier (tactical, not to scale)
const COL: Record<string, number> = { unknown: 0xf2c94c, hostile: 0xe5484d, friend: 0x4c8dff, neutral: 0x3fa796 };
const TOWER = new THREE.Vector3(8, 19, -5); // radar / effector tower top: weapon effects start here
const EFFCOL: Record<string, number> = { jam: 0x2fb9a0, spoof: 0xa47be8, intc: 0x5aa9ff, gun: 0xff8a3d };

interface Vis { g: THREE.Group; marker: THREE.Mesh; model: THREE.Group | null; shape: string; drop: THREE.Line; label: THREE.Sprite | null;
  labelText: string; trail: THREE.Line; pts: THREE.Vector3[]; pos: THREE.Vector3; ring: THREE.Mesh; kind: string; rotors: THREE.Object3D[]; }

let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene, camera: THREE.PerspectiveCamera, sweep: THREE.Mesh, dish: THREE.Object3D, world: THREE.Group, fx: THREE.Group;
let weather: THREE.Points | null = null;
let host: HTMLDivElement, big = false, min = false, mode: 'orbit' | 'follow' = 'orbit';
const MIN_KEY = 'parashurama.3dmin';
let orbit = { th: 0.6, ph: 0.95, r: 380 }, drag: { x: number; y: number } | null = null, dragMoved = false;
const vis = new Map<number, Vis>();
let builtFor = '';
let beams: { line: THREE.Line; cid: number; eff: string; until: number }[] = [];
let booms: { m: THREE.Mesh; t0: number; col: number }[] = [];
let shots: { m: THREE.Mesh; cid: number; t0: number; dur: number }[] = [];
const seenEng = new Set<string>();
const clock = new THREE.Clock();

// Engine: x = east, y = south (metres). Three.js: x = east, y = up, z = south.
const altOf = (c: Contact) => Math.max(1.2, c.alt * S * ALT);
const wpos = (c: Contact, out = new THREE.Vector3()) => out.set(c.x * S, altOf(c), c.y * S);

function mat(col: number, emissive = 0.35) {
  return new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: emissive, roughness: 0.6, metalness: 0.1 });
}
function lineMat(col: number, opacity = 1) { return new THREE.LineBasicMaterial({ color: col, transparent: opacity < 1, opacity }); }

function textSprite(txt: string, col = '#ffffff'): THREE.Sprite {
  const cv = document.createElement('canvas'); cv.width = 128; cv.height = 48;
  const x = cv.getContext('2d')!;
  x.fillStyle = 'rgba(10,17,23,0.75)'; x.fillRect(0, 6, 128, 36);
  x.font = '600 26px "Barlow Condensed", Arial, sans-serif'; x.fillStyle = col; x.textAlign = 'center'; x.fillText(txt, 64, 33);
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sp.scale.set(30, 11.25, 1); sp.renderOrder = 10; return sp;
}

function droneModel(shape: string, col: number): { g: THREE.Group; rotors: THREE.Object3D[] } {
  const g = new THREE.Group(), m = mat(col, 0.5), dark = mat(0x222831, 0.1), rotors: THREE.Object3D[] = [];
  if (shape === 'quad') {
    g.add(new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.7, 2.2), m));
    for (const [a, b] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 3.2), dark); arm.position.set(a * 1.1, 0, b * 1.1); arm.rotation.y = Math.atan2(a, b); g.add(arm);
      const rot = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.3, 0.08, 16), new THREE.MeshBasicMaterial({ color: 0xdfe6ec, transparent: true, opacity: 0.45 }));
      rot.position.set(a * 2.2, 0.45, b * 2.2); g.add(rot); rotors.push(rot);
    }
  } else if (shape === 'wing') {
    g.add(new THREE.Mesh(new THREE.BoxGeometry(9, 0.3, 1.8), m));
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.35, 5, 10), m); body.rotation.x = Math.PI / 2; g.add(body);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(3, 0.25, 0.9), m); tail.position.z = 2.3; g.add(tail);
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.2, 1.4, 0.9), m); fin.position.set(0, 0.7, 2.3); g.add(fin);
  } else {
    g.add(new THREE.Mesh(new THREE.SphereGeometry(0.6, 10, 8), m));
    for (const s of [-1, 1]) { const w = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.1, 1), m); w.position.x = s * 1.6; w.name = s < 0 ? 'wl' : 'wr'; g.add(w); rotors.push(w); }
  }
  g.scale.setScalar(MODEL);
  return { g, rotors };
}

/** Build the static world (ground, terrain, asset, rings, sky, weather) for the current drill. */
function buildWorld() {
  const cfg = app.live.cfg, night = cfg.time === 'night', wx = cfg.weather || 'clear', fxw = weatherFx(C, wx);
  builtFor = `${cfg.seed}|${cfg.time}|${cfg.terrain}|${wx}`;
  if (world) scene.remove(world);
  if (weather) { scene.remove(weather); weather = null; }
  world = new THREE.Group(); scene.add(world);
  const sky = night ? 0x111c2c : wx === 'dust' ? 0xb79a74 : wx === 'fog' ? 0xb8c0c6 : wx === 'rain' ? 0x7d8b97 : 0x9cc0d8;
  const fogCol = night ? (wx === 'dust' ? 0x2a2218 : 0x101824) : sky;
  scene.background = new THREE.Color(sky);
  // fog starts beyond the default camera distance (~380), so the defended area stays readable while the horizon fades
  const far = { clear: 1500, rain: 1000, fog: 700, dust: 820 }[wx] ?? 1500;
  scene.fog = new THREE.Fog(fogCol, wx === 'clear' ? 600 : 300, far * (night ? 0.85 : 1));
  scene.children.filter((o) => (o as any).isLight).forEach((l) => scene.remove(l));
  scene.add(new THREE.HemisphereLight(night ? 0x6f8fa0 : 0xdfeaf2, night ? 0x1a2420 : 0x4a5a3a, night ? 1.0 : 1.1));
  const sun = new THREE.DirectionalLight(night ? 0xa9c4d8 : 0xfff3df, night ? 0.7 : 1.4); sun.position.set(-200, 300, 120); scene.add(sun);

  const urban = cfg.terrain === 'urban';
  const groundCol = urban ? (night ? 0x2c3338 : 0x6b7074) : (night ? 0x26331f : 0x667a4a);
  const ground = new THREE.Mesh(new THREE.CircleGeometry(900, 64), new THREE.MeshStandardMaterial({ color: groundCol, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2; world.add(ground);
  const grid = new THREE.PolarGridHelper(300, 12, 3, 72, night ? 0x2f4a5a : 0x46575f, night ? 0x2f4a5a : 0x46575f);
  (grid.material as THREE.Material).transparent = true; (grid.material as THREE.Material).opacity = 0.35; grid.position.y = 0.05; world.add(grid);

  // terrain: buildings (urban) or trees (rural), seeded so the same drill looks the same
  const r = mulberry(cfg.seed + 99);
  if (urban) {
    const n = 420, geo = new THREE.BoxGeometry(1, 1, 1), m = new THREE.MeshStandardMaterial({ color: night ? 0x2b3138 : 0x9aa0a6, roughness: 0.9 });
    const inst = new THREE.InstancedMesh(geo, m, n), o = new THREE.Object3D();
    for (let i = 0; i < n; i++) {
      const a = r() * 6.283, d = 25 + Math.sqrt(r()) * 420, h = 3 + r() * r() * 30;
      o.position.set(Math.sin(a) * d, h / 2, Math.cos(a) * d); o.scale.set(5 + r() * 9, h, 5 + r() * 9); o.rotation.y = r() * 3; o.updateMatrix(); inst.setMatrixAt(i, o.matrix);
    }
    world.add(inst);
  } else {
    const n = 600, geo = new THREE.ConeGeometry(1.6, 6, 6), m = new THREE.MeshStandardMaterial({ color: night ? 0x1a2a1a : 0x3f5f32, roughness: 1 });
    const inst = new THREE.InstancedMesh(geo, m, n), o = new THREE.Object3D();
    for (let i = 0; i < n; i++) {
      const a = r() * 6.283, d = 20 + Math.sqrt(r()) * 480, s = 0.7 + r() * 1.4;
      o.position.set(Math.sin(a) * d, 3 * s, Math.cos(a) * d); o.scale.setScalar(s); o.updateMatrix(); inst.setMatrixAt(i, o.matrix);
    }
    world.add(inst);
  }

  // protected asset: compound, tower and a rotating radar dish
  const base = new THREE.Mesh(new THREE.CylinderGeometry(SIM.assetRadiusM * S, SIM.assetRadiusM * S, 0.3, 40), new THREE.MeshStandardMaterial({ color: 0x4c8dff, transparent: true, opacity: 0.35 }));
  base.position.y = 0.15; world.add(base);
  const hangar = new THREE.Mesh(new THREE.BoxGeometry(16, 7, 11), new THREE.MeshStandardMaterial({ color: night ? 0x56606a : 0xc9cfd4 })); hangar.position.set(-6, 3.5, 4); world.add(hangar);
  const roof = new THREE.Mesh(new THREE.CylinderGeometry(5.6, 5.6, 16, 16, 1, false, 0, Math.PI), new THREE.MeshStandardMaterial({ color: night ? 0x46505a : 0x8f9aa3 })); roof.rotation.z = Math.PI / 2; roof.position.set(-6, 7, 4); world.add(roof);
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(1, 1.8, 18, 8), new THREE.MeshStandardMaterial({ color: 0x8a949c })); tower.position.set(TOWER.x, 9, TOWER.z); world.add(tower);
  dish = new THREE.Group(); dish.position.copy(TOWER);
  const plate = new THREE.Mesh(new THREE.BoxGeometry(9, 3.2, 0.5), mat(0xe6edf2, 0.2)); plate.position.z = -0.8; plate.rotation.x = -0.25; dish.add(plate); world.add(dish);
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 8), new THREE.MeshBasicMaterial({ color: 0xff4d4d })); beacon.position.set(TOWER.x, TOWER.y + 2.4, TOWER.z); beacon.name = 'beacon'; world.add(beacon);

  // reach rings: radar 3 km, jammer, gun
  const ring = (R: number, col: number, op: number) => {
    const m = new THREE.Mesh(new THREE.RingGeometry(R * S - 0.6, R * S + 0.6, 128), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: op, side: THREE.DoubleSide }));
    m.rotation.x = -Math.PI / 2; m.position.y = 0.2; world.add(m);
  };
  ring(SIM.radarRangeM, 0xdfe6ec, 0.35); ring(EFF.jam.range, EFFCOL.jam, 0.6); ring(EFF.gun.range, EFFCOL.gun, 0.6);

  // radar sweep wedge
  sweep = new THREE.Mesh(new THREE.CircleGeometry(SIM.radarRangeM * S, 32, 0, 0.32), new THREE.MeshBasicMaterial({ color: 0x3fa796, transparent: true, opacity: night ? 0.22 : 0.16, side: THREE.DoubleSide, depthWrite: false }));
  sweep.rotation.x = -Math.PI / 2; sweep.position.y = 0.3; world.add(sweep);

  // weather particles
  if (wx !== 'clear' && !isLite()) {
    const n = wx === 'rain' ? 4000 : wx === 'dust' ? 2600 : 1200, p = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { p[i * 3] = (r() - 0.5) * 700; p[i * 3 + 1] = r() * 160; p[i * 3 + 2] = (r() - 0.5) * 700; }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    const col = wx === 'rain' ? 0xc9d6e2 : wx === 'dust' ? 0xc8a274 : 0xe8ecef;
    weather = new THREE.Points(g, new THREE.PointsMaterial({ color: col, size: wx === 'rain' ? 1.1 : 1.6, transparent: true, opacity: wx === 'fog' ? 0.35 : 0.6, depthWrite: false }));
    weather.userData.kind = wx; scene.add(weather);
  }
  for (const v of vis.values()) scene.remove(v.g);
  vis.clear(); beams.forEach((b) => fx.remove(b.line)); beams = []; booms.forEach((b) => fx.remove(b.m)); booms = []; shots.forEach((s) => fx.remove(s.m)); shots = []; seenEng.clear();
  $('#v3wx').textContent = `${night ? 'Night' : 'Day'} · ${fxw.label} · ${urban ? 'Urban' : 'Rural'}`;
}

function kindOf(c: Contact) {
  const d = app.live.did[c.id] || {};
  return kindOfCls(c.idCls || (d.id && d.id.cls));
}

/** Create or update the 3D object for one contact. */
function syncContact(c: Contact, now: number) {
  const tracked = c.trackTick != null || (app.live.did[c.id] || {}).track;
  const shown = c.state === 'live' && (tracked || visibleBlip(app.L, c));
  let v = vis.get(c.id);
  if (!shown) { if (v) v.g.visible = false; return; }
  if (!v) {
    const g = new THREE.Group();
    const marker = new THREE.Mesh(new THREE.OctahedronGeometry(5.5), mat(COL.unknown, 0.9)); g.add(marker);
    const drop = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, -1, 0)]), lineMat(0xffffff, 0.35)); g.add(drop);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(12, 0.7, 8, 40), new THREE.MeshBasicMaterial({ color: 0xffffff })); ring.rotation.x = Math.PI / 2; ring.visible = false; g.add(ring);
    const trail = new THREE.Line(new THREE.BufferGeometry(), lineMat(COL.unknown, 0.5));
    scene.add(g); scene.add(trail);
    v = { g, marker, model: null, shape: '', drop, label: null, labelText: '', trail, pts: [], pos: wpos(c), ring, kind: '', rotors: [] };
    g.userData.cid = c.id; marker.userData.cid = c.id;
    vis.set(c.id, v);
  }
  v.g.visible = true;
  const target = wpos(c);
  v.pos.lerp(target, 0.25); v.g.position.copy(v.pos);
  // drop line to the ground helps judge height
  (v.drop.geometry as THREE.BufferGeometry).setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, -v.pos.y, 0)]);
  // identify-before-reveal: model shape only when identified or inside camera range
  const kind = kindOf(c), dist = Math.hypot(c.x, c.y);
  const reveal = kind !== 'unknown' || dist < cameraRange(C, app.live.cfg.time, app.live.cfg.weather);
  const shape = reveal ? TYPES[c.type].shape : '';
  if (shape !== v.shape || kind !== v.kind) {
    if (v.model) v.g.remove(v.model);
    v.model = null; v.rotors = [];
    if (shape) { const d = droneModel(shape, COL[kind] ?? COL.unknown); v.model = d.g; v.rotors = d.rotors; v.g.add(d.g); }
    v.marker.visible = !shape;
    ((v.marker.material) as THREE.MeshStandardMaterial).color.setHex(COL[kind] ?? COL.unknown);
    ((v.trail.material) as THREE.LineBasicMaterial).color.setHex(COL[kind] ?? COL.unknown);
    v.shape = shape; v.kind = kind;
  }
  if (v.model) v.model.rotation.y = -c.hdg; // model nose points north (-z); heading is a bearing
  v.marker.rotation.y += 0.03; v.marker.scale.setScalar(1 + Math.sin(now * 6 + c.id) * 0.12);
  v.rotors.forEach((r, i) => { if (r.name === 'wl' || r.name === 'wr') r.rotation.z = Math.sin(now * 9) * 0.6 * (r.name === 'wl' ? 1 : -1); else r.rotation.y += 0.9 + i * 0.05; });
  // label for tracked contacts
  const lt = tracked ? (app.live.labels[c.id] || '') : '';
  if (lt !== v.labelText) {
    if (v.label) v.g.remove(v.label);
    v.label = lt ? textSprite(lt, '#' + (COL[kind] ?? COL.unknown).toString(16).padStart(6, '0')) : null;
    if (v.label) { v.label.position.y = 17; v.g.add(v.label); }
    v.labelText = lt;
  }
  v.ring.visible = app.live.sel === c.id; v.ring.rotation.z = now;
  // trail
  if (!v.pts.length || v.pts[v.pts.length - 1].distanceTo(v.pos) > 1.5) { v.pts.push(v.pos.clone()); if (v.pts.length > 60) v.pts.shift(); v.trail.geometry.setFromPoints(v.pts); }
}

function weaponFx(c: Contact, now: number) {
  c.engs.forEach((e, i) => {
    const key = `${c.id}:${i}`;
    if (seenEng.has(key) || e.eff === 'hold') return;
    seenEng.add(key);
    const col = EFFCOL[e.eff] ?? 0xffffff, dur = EFF[e.eff]?.delay ?? 2;
    if (e.eff === 'intc' || e.eff === 'gun') {
      const m = new THREE.Mesh(new THREE.SphereGeometry(e.eff === 'gun' ? 0.8 : 1.3, 8, 6), new THREE.MeshBasicMaterial({ color: col }));
      m.position.set(3, 10, -2); fx.add(m); shots.push({ m, cid: c.id, t0: now, dur: Math.max(0.6, dur) });
    } else {
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([TOWER.clone(), new THREE.Vector3()]), lineMat(col, 0.9));
      fx.add(line); beams.push({ line, cid: c.id, eff: e.eff, until: now + dur });
    }
  });
}

function boom(at: THREE.Vector3, col: number, now: number) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.9 }));
  m.position.copy(at); fx.add(m); booms.push({ m, t0: now, col });
}

function frame() {
  if (!renderer) return;
  const inXR = renderer.xr.isPresenting;
  if (app.phase !== 'fight' || !app.L || !app.live.cfg || (min && !big)) { if (!inXR) return; }
  const now = clock.getElapsedTime(), L = app.L;
  const cfgKey = `${app.live.cfg.seed}|${app.live.cfg.time}|${app.live.cfg.terrain}|${app.live.cfg.weather || 'clear'}`;
  if (cfgKey !== builtFor) buildWorld();
  const swDeg = (L.tick * SIM.dt / SIM.sweepSec * 360) % 360;
  sweep.rotation.z = Math.PI / 2 - swDeg * Math.PI / 180; // leading edge on the sweep bearing dish.rotation.y = -swDeg * Math.PI / 180;
  for (const c of L.contacts as Contact[]) {
    const v = vis.get(c.id);
    if (c.state !== 'live' && v && v.g.visible) { boom(v.pos.clone(), c.state === 'leaked' ? 0xe5484d : 0xffc36b, now); v.g.visible = false; v.trail.visible = false; }
    syncContact(c, now); weaponFx(c, now);
  }
  // beams follow their target until the effect lands
  beams = beams.filter((b) => {
    const v = vis.get(b.cid);
    if (now > b.until || !v || !v.g.visible) { fx.remove(b.line); return false; }
    b.line.geometry.setFromPoints([TOWER.clone(), v.pos]); (b.line.material as THREE.LineBasicMaterial).opacity = 0.5 + 0.5 * Math.abs(Math.sin(now * 18)); return true;
  });
  shots = shots.filter((s) => {
    const v = vis.get(s.cid); const k = Math.min(1, (now - s.t0) / s.dur);
    if (!v || k >= 1) { fx.remove(s.m); return false; }
    s.m.position.lerpVectors(TOWER.clone(), v.pos, k); s.m.position.y += Math.sin(k * Math.PI) * 12; return true;
  });
  booms = booms.filter((b) => {
    const k = (now - b.t0) / 1.4; if (k >= 1) { fx.remove(b.m); return false; }
    b.m.scale.setScalar(2 + k * 16); (b.m.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - k); return true;
  });
  if (weather) {
    const p = weather.geometry.getAttribute('position') as THREE.BufferAttribute, k = weather.userData.kind;
    for (let i = 0; i < p.count; i++) {
      let y = p.getY(i) - (k === 'rain' ? 2.6 : k === 'dust' ? 0.15 : 0.05); let x = p.getX(i) + (k === 'dust' ? 0.5 : 0.04);
      if (y < 0) y += 160; if (x > 350) x -= 700; p.setXYZ(i, x, y, p.getZ(i));
    }
    p.needsUpdate = true;
  }
  const bc = world.getObjectByName('beacon'); if (bc) bc.visible = Math.sin(now * 5) > 0;
  if (!inXR) placeCamera(now);
  renderer.render(scene, camera);
}

function placeCamera(now: number) {
  let sel = app.live.sel != null ? vis.get(app.live.sel) : null;
  if (mode === 'follow' && (!sel || !sel.g.visible)) {
    const L = app.L, live = (L.contacts as Contact[]).filter((c) => c.state === 'live' && vis.get(c.id)?.g.visible && kindOf(c) !== 'friend' && kindOf(c) !== 'neutral');
    live.sort((a, b) => Math.hypot(a.x, a.y) / a.v - Math.hypot(b.x, b.y) / b.v);
    sel = live.length ? vis.get(live[0].id) ?? null : null;
  }
  if (mode === 'follow' && sel && sel.g.visible) {
    // chase camera: behind the drone, looking towards the protected asset
    const toAsset = new THREE.Vector3(-sel.pos.x, 0, -sel.pos.z).normalize();
    const want = sel.pos.clone().addScaledVector(toAsset, -70).add(new THREE.Vector3(0, 24, 0));
    camera.position.lerp(want, 0.08); camera.lookAt(sel.pos.clone().addScaledVector(toAsset, 30));
    return;
  }
  if (!big && !drag) orbit.th += 0.0016;
  const r = orbit.r;
  camera.position.set(Math.sin(orbit.th) * Math.sin(orbit.ph) * r, Math.cos(orbit.ph) * r, Math.cos(orbit.th) * Math.sin(orbit.ph) * r);
  camera.lookAt(0, 8, 0);
  void now;
}

function resize() {
  if (!renderer) return;
  const w = host.clientWidth, h = host.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
}

function setBig(b: boolean) {
  big = b; host.classList.toggle('big', b);
  $('#v3big').textContent = b ? 'Shrink' : 'Expand';
  $('#v3big').setAttribute('aria-pressed', String(b));
  requestAnimationFrame(resize);
}
function setMin(m: boolean, remember = true) {
  min = m; host.classList.toggle('min', m); $('#v3min').textContent = m ? 'Show 3D' : '–';
  $('#v3min').setAttribute('aria-label', m ? 'Show the 3D view' : 'Hide the 3D view');
  if (m && big) setBig(false);
  if (remember) try { localStorage.setItem(MIN_KEY, m ? '1' : '0'); } catch { /* private mode */ }
  requestAnimationFrame(resize);
}
function setMode(m: 'orbit' | 'follow') {
  mode = m; $('#v3follow').classList.toggle('on', m === 'follow');
  $('#v3tip').textContent = m === 'follow' ? 'Chase camera: following the selected (or most urgent) threat · drag to return to orbit' : 'Drag to rotate · scroll to zoom · click a drone to select · V expand';
}

function pick(ev: PointerEvent) {
  const rect = renderer!.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
  const ray = new THREE.Raycaster(); ray.setFromCamera(ndc, camera);
  // generous hit test: nearest visible contact to the ray
  let best: { id: number; d: number } | null = null;
  for (const [id, v] of vis) {
    if (!v.g.visible) continue;
    const d = ray.ray.distanceToPoint(v.pos);
    const lim = 4 + camera.position.distanceTo(v.pos) * 0.03;
    if (d < lim && (!best || d < best.d)) best = { id, d };
  }
  if (!best) return;
  const c = app.L.contacts.find((x: Contact) => x.id === best!.id);
  if (!c) return;
  if (!(c.trackTick != null || (app.live.did[c.id] || {}).track)) app.doTrack(c);
  app.select(c.id);
}

async function setupVR() {
  const xr = (navigator as any).xr;
  if (!xr || !renderer) return;
  try { if (!(await xr.isSessionSupported('immersive-vr'))) return; } catch { return; }
  const b = $('#v3vr'); b.hidden = false;
  b.onclick = async () => {
    if (renderer!.xr.isPresenting) { renderer!.xr.getSession()?.end(); return; }
    const session = await xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor'] });
    // stand on the radar tower, looking out over the defended area
    camera.position.set(TOWER.x, TOWER.y + 2, TOWER.z);
    await renderer!.xr.setSession(session); b.textContent = 'Exit VR';
    session.addEventListener('end', () => { b.textContent = 'Enter VR'; });
  };
}

export function init3D() {
  const wrap = $('#radarWrap'); if (!wrap) return;
  host = document.createElement('div'); host.id = 'view3d'; host.className = 'view3d';
  host.innerHTML = `<div class="v3bar"><b>3D tactical view</b><span id="v3wx"></span>
    <span class="v3btns"><button id="v3follow" title="Chase the selected contact">Follow</button><button id="v3vr" hidden>Enter VR</button><button id="v3big" aria-pressed="false">Expand</button><button id="v3min" title="Hide the 3D view" aria-label="Hide the 3D view">–</button></span></div>
    <div class="v3tip" id="v3tip">Drag to rotate · scroll to zoom · click a drone to select · <kbd>V</kbd> expand</div>`;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  } catch { renderer = null; }
  if (!renderer || !renderer.getContext()) { renderer = null; return; } // no WebGL: the 2D radar still does everything
  renderer.setPixelRatio(isLite() ? 1 : Math.min(2, devicePixelRatio)); renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.xr.enabled = true;
  host.prepend(renderer.domElement); wrap.appendChild(host);
  scene = new THREE.Scene(); camera = new THREE.PerspectiveCamera(50, 1.5, 0.5, 3000);
  fx = new THREE.Group(); scene.add(fx); world = new THREE.Group();
  renderer.setAnimationLoop(frame);
  new ResizeObserver(resize).observe(host);

  $('#v3big').onclick = (e: Event) => { e.stopPropagation(); if (min) setMin(false); setBig(!big); };
  $('#v3min').onclick = (e: Event) => { e.stopPropagation(); setMin(!min); };
  $('#v3follow').onclick = (e: Event) => { e.stopPropagation(); setMode(mode === 'follow' ? 'orbit' : 'follow'); };
  const el = renderer.domElement;
  el.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; dragMoved = false; el.setPointerCapture(e.pointerId); });
  el.addEventListener('pointermove', (e) => {
    if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) dragMoved = true;
    orbit.th -= dx * 0.006; orbit.ph = Math.min(1.45, Math.max(0.25, orbit.ph - dy * 0.005)); drag = { x: e.clientX, y: e.clientY };
    if (dragMoved && mode === 'follow') setMode('orbit');
  });
  el.addEventListener('pointerup', (e) => { const moved = dragMoved; drag = null; if (moved) return; if (!big) { setBig(true); return; } pick(e); });
  el.addEventListener('wheel', (e) => { e.preventDefault(); orbit.r = Math.min(900, Math.max(60, orbit.r * (1 + Math.sign(e.deltaY) * 0.1))); }, { passive: false });
  addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement)?.closest?.('input,select,textarea')) return;
    if (app.phase === 'fight' && e.key.toLowerCase() === 'v' && !e.ctrlKey && !e.metaKey) { if (min) setMin(false, false); setBig(!big); }
  });
  on('start', () => {
    buildWorld(); setMode('orbit'); setBig(false); orbit = { th: 0.6, ph: 0.95, r: 380 };
    // Academy: keep the screen simple for beginners. Otherwise use the trainee's last choice.
    let saved = false; try { saved = localStorage.getItem(MIN_KEY) === '1'; } catch { /* ignore */ }
    setMin(app.live.mode === 'academy' || saved || isLite(), false);
  });
  onLite((lite) => {
    renderer?.setPixelRatio(lite ? 1 : Math.min(2, devicePixelRatio));
    if (lite) { setMin(true, false); if (weather) { scene.remove(weather); weather = null; } }
  });
  void setupVR();
}
