// Field drill, 3D, first person: you are the gunner, seated at the gun.
//   Mouse (pointer lock) aims; the gun follows at its real traverse and elevation rates (the engine's handwheel rates).
//   Hold the right button to look through the gun's own sight: ZAP-23 type collimator (ZU-23-2), optical sight and
//   radar scope (ZSU-23-4), thermal display (L70). Z: binoculars. V: outside view. E: report the contact in the middle.
//   Models: Blender-built guns, drones, trees and buildings (tools/blender); sky, textures and props are CC0 from Poly Haven
//   and ambientCG (scripts/fetch-assets.mjs). Everything falls back to plain shapes if the files are missing.
//   What is drawn follows the engine's detection model (detectRangeM), so you can only spot what the scorer counts as visible.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  angDiff, detectable, detectRangeM, dirOf, fcsOf, fly, getConfig, losOf, mulberry, targetPos, weatherFx,
  type AimSolution, type GunEngine, type GunTarget, type Vec3,
} from '@parashurama/engine';
import { app } from './app';
import { fieldAudio } from './fieldaudio';

export type FieldViewMode = 'gun' | 'ext';
export interface FieldMarks { selected: number | null; ident: (cid: number) => string | null; indicated: number | null; }
export interface FieldCallbacks {
  /** A click landed on a visible target (spotted or not). */ pick: (cid: number) => void;
  /** Old mouse-drag joystick (kept for touch screens): slew rates −1…1, or null when released. */ joystick: (r: [number, number] | null) => void;
}
export interface FieldView {
  frame: (E: GunEngine, sol: AimSolution | null, frac: number, marks: FieldMarks) => void;
  setMode: (m: FieldViewMode) => void; mode: () => FieldViewMode; zoom: () => void;
  /** Slew rates that bring the gun onto the mouse aim, or null when the mouse is not aiming. */
  rates: (E: GunEngine, sol: AimSolution | null) => [number, number] | null;
  /** The visible target nearest the middle of the view (for the report key). */ centreTarget: (E: GunEngine) => number | null;
  /** Point the view (demo and test automation). */ look: (az: number, el: number, binoculars?: boolean, sight?: boolean) => void;
  /** Thermal sight: white-hot / black-hot. */ polarity: () => void;
  /** Renderer statistics of the last frame (performance checks). */ info: () => { calls: number; triangles: number; ms: number };
  dispose: () => void;
}

const D2R = Math.PI / 180;
const BASE = import.meta.env.BASE_URL;
const offline = location.protocol === 'file:';
/** Height of the gun's ballistic origin (trunnion) above the ground, set from the model. */
let ORIGIN_H = 1.2;
/** Engine (x east, y north, z up, origin at the trunnion) → three.js (x east, y up, z south, origin on the ground). */
const W = (p: Vec3, out = new THREE.Vector3()) => out.set(p[0], p[2] + ORIGIN_H, -p[1]);
const dirW = (az: number, el: number, out = new THREE.Vector3()) => { const d = dirOf(az, el); return out.set(d[0], d[2], -d[1]); };

// ---------- loading (cached across drills) ----------
const gltfCache = new Map<string, Promise<THREE.Group | null>>();
function gltf(path: string): Promise<THREE.Group | null> {
  if (offline) return Promise.resolve(null);
  if (!gltfCache.has(path)) gltfCache.set(path, new GLTFLoader().loadAsync(`${BASE}${path}`).then((g) => g.scene as unknown as THREE.Group).catch(() => null));
  return gltfCache.get(path)!;
}
const texLoader = new THREE.TextureLoader();
function tex(path: string, srgb = true, rep = 1): THREE.Texture | null {
  if (offline) return null;
  const t = texLoader.load(`${BASE}${path}`, undefined, undefined, () => undefined);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rep, rep); t.anisotropy = 4;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function pbr(id: string, rep: number, o: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, ...o });
  const d = tex(`assets/tex/${id}/diff.jpg`, true, rep), n = tex(`assets/tex/${id}/nor.jpg`, false, rep), a = tex(`assets/tex/${id}/arm.jpg`, false, rep);
  if (d) { m.map = d; m.normalMap = n; m.roughnessMap = a; m.aoMap = a; m.normalScale.set(0.8, 0.8); } else m.color.setHex(o.color as number ?? 0x777766);
  return m;
}
function hdr(cond: string): Promise<THREE.DataTexture | null> {
  if (offline) return Promise.resolve(null);
  return new RGBELoader().loadAsync(`${BASE}assets/hdri/${cond}.hdr`).then((t) => { t.mapping = THREE.EquirectangularReflectionMapping; return t; }).catch(() => null);
}

/** Soft dot texture (specks, smoke, flashes). */
function dotTexture(): THREE.Texture {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d')!, gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.45, 'rgba(255,255,255,0.8)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = gr; x.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
/** Low-frequency value noise texture for blending ground materials. */
function noiseTexture(seed: number): THREE.DataTexture {
  const n = 256, r = mulberry(seed), g = new Float32Array(17 * 17).map(() => r()), d = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const fx = (x / n) * 16, fy = (y / n) * 16, ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
    const s = (a: number) => a * a * (3 - 2 * a), at = (i: number, j: number) => g[(j % 16) * 17 + (i % 16)];
    const v = (at(ix, iy) * (1 - s(tx)) + at(ix + 1, iy) * s(tx)) * (1 - s(ty)) + (at(ix, iy + 1) * (1 - s(tx)) + at(ix + 1, iy + 1) * s(tx)) * s(ty);
    d.set([v * 255, v * 255, v * 255, 255], (y * n + x) * 4);
  }
  const t = new THREE.DataTexture(d, n, n); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = THREE.LinearFilter; t.needsUpdate = true; return t;
}

// ---------- gunfire sound (generated) ----------
let ac: AudioContext | null = null, noiseBuf: AudioBuffer | null = null;
function bang(gain: number, low: number) {
  if ((app.DB.settings?.sound ?? 'sound') === 'off') return;
  try {
    if (!ac) ac = new AudioContext();
    if (ac.state === 'suspended') void ac.resume();
    if (!noiseBuf) { noiseBuf = ac.createBuffer(1, ac.sampleRate * 0.5, ac.sampleRate); const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 4); }
    const t = ac.currentTime, s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
    s.buffer = noiseBuf; f.type = 'lowpass'; f.frequency.value = low; g.gain.setValueAtTime(gain, t);
    const o = ac.createOscillator(), og = ac.createGain(); o.frequency.setValueAtTime(low > 1000 ? 110 : 70, t); o.frequency.exponentialRampToValueAtTime(35, t + 0.15);
    og.gain.setValueAtTime(gain * 0.9, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    s.connect(f).connect(g).connect(ac.destination); o.connect(og).connect(ac.destination); s.start(); o.start(); o.stop(t + 0.2);
  } catch { /* no audio */ }
}

// ---------- fallback shapes when the GLBs are missing ----------
function fallbackGun(): THREE.Group {
  const root = new THREE.Group(), m = new THREE.MeshStandardMaterial({ color: 0x3a4628, roughness: 0.6 });
  root.add(new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.7, 0.5, 20), m));
  const yaw = new THREE.Group(); yaw.name = 'yaw'; yaw.position.y = 0.6; root.add(yaw);
  const pitch = new THREE.Group(); pitch.name = 'pitch'; pitch.position.y = 0.6; yaw.add(pitch);
  const b = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.6, 12), m); b.rotation.x = Math.PI / 2; b.position.z = -1.3; pitch.add(b);
  const mz = new THREE.Object3D(); mz.name = 'muzzle0'; mz.position.z = -2.6; pitch.add(mz);
  const eye = new THREE.Object3D(); eye.name = 'eye'; eye.position.set(-0.45, 0.8, 0.8); yaw.add(eye);
  const se = new THREE.Object3D(); se.name = 'sight_eye'; se.position.set(-0.3, 0.25, 0.5); pitch.add(se);
  return root;
}

// ---------- the view ----------
export async function mountField(host: HTMLElement, E0: GunEngine, cb: FieldCallbacks, lite: boolean): Promise<FieldView> {
  const C = getConfig(), cfg = E0.cfg, night = cfg.time === 'night', urban = cfg.terrain === 'urban', wx = cfg.weather ?? 'clear', wfx = weatherFx(C, wx);
  const gunDef = E0.gun, thermalSight = gunDef.sight === 'eo' && !cfg.radarFault, radarSight = gunDef.sight === 'radar' && !cfg.radarFault;
  const rng = mulberry(cfg.seed * 31 + 7);
  const renderer = new THREE.WebGLRenderer({ antialias: !lite, powerPreference: 'high-performance' });
  renderer.setPixelRatio(lite ? 0.8 : Math.min(1.5, devicePixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = night ? 0.9 : wx === 'clear' ? 0.75 : 0.85;
  renderer.shadowMap.enabled = !lite; renderer.shadowMap.type = THREE.PCFShadowMap;
  const cv = renderer.domElement; cv.className = 'fdGl';
  const hud = document.createElement('canvas'); hud.className = 'fdHud';
  const tip = document.createElement('div'); tip.className = 'fdTip';
  host.append(cv, hud, tip);
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(70, 1, 0.05, 25000);
  camera.layers.enable(1);

  // Sky and light: HDRI by condition, image-based lighting, a sun with a shadow around the gun position.
  const sky = await hdr(night ? 'night' : wx === 'clear' ? 'day' : wx === 'rain' ? 'overcast' : wx);
  const pmrem = new THREE.PMREMGenerator(renderer);
  if (sky) { scene.background = sky; scene.environment = pmrem.fromEquirectangular(sky).texture; scene.backgroundIntensity = night ? 0.6 : 1; }
  else scene.background = new THREE.Color(night ? 0x060a12 : 0x9fb6c8);
  const sunDir = new THREE.Vector3(-0.45, night ? 0.6 : 0.8, -0.4).normalize();
  const sun = new THREE.DirectionalLight(night ? 0x7f93b8 : 0xfff0d8, night ? 0.25 : wx === 'clear' ? 2.6 : 0.9);
  sun.position.copy(sunDir).multiplyScalar(80); sun.castShadow = !lite;
  sun.shadow.mapSize.set(1024, 1024); Object.assign(sun.shadow.camera, { left: -25, right: 25, top: 25, bottom: -25, near: 1, far: 200 }); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);
  if (!sky) scene.add(new THREE.HemisphereLight(0xdfe9f2, 0x5b5a48, 0.8));
  // Haze from the drill's visibility (the engine's visual range for a medium target).
  const D = E0.G.detect, visM = (D?.visualM?.Medium ?? 3000) * (night ? D?.night ?? 0.4 : 1) * wfx.camera;
  const hazeCol = new THREE.Color(night ? 0x0a0f18 : wx === 'dust' ? 0xb19a78 : wx === 'clear' ? 0xb7c6d2 : 0x9aa3a8);
  const fogDay = new THREE.Fog(hazeCol, Math.min(500, visM * 0.25), Math.max(1800, visM * (wx === 'clear' ? 3 : 1.6)));
  const thermRange = (fcsOf(gunDef)?.acquireRangeM ?? 5000) * wfx.camera;
  const fogHot = new THREE.Fog(0x050505, thermRange * 0.35, thermRange * 1.7);
  scene.fog = fogDay;

  // ---------- ground ----------
  const SIZE = 12000, SEG = lite ? 128 : 192, gg = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG); gg.rotateX(-Math.PI / 2);
  const ph = [rng() * 10, rng() * 10, rng() * 10];
  const heightAt = (x: number, z: number) => {
    const d = Math.hypot(x, z), n = Math.sin(x * 0.0021 + ph[0]) * Math.cos(z * 0.0017 + ph[1]) + 0.5 * Math.sin((x + z) * 0.0051 + ph[2]);
    if (urban) return d < 3000 ? 0 : (d - 3000) * 0.012 * (1 + n);
    const cap = Math.max(0, 0.0045 * d - 1.5) - 1.0; // below the 0.3° rural horizon mask
    return d < 60 ? 0 : d < 4800 ? Math.min(cap, 3 + 3 * n) : Math.min(cap + 0.03 * (d - 4800), 40 + 90 * (1 + n));
  };
  { const p = gg.attributes.position as THREE.BufferAttribute; for (let i = 0; i < p.count; i++) p.setY(i, heightAt(p.getX(i), p.getZ(i))); gg.computeVertexNormals(); }
  gg.setAttribute('uv2', gg.attributes.uv);
  const groundA = pbr(urban ? 'concrete_pavement' : 'red_laterite_soil_stones', SIZE / 6), groundB = pbr(urban ? 'dry_ground_01' : 'sparse_grass', SIZE / 5);
  const noise = noiseTexture(cfg.seed);
  if (groundA.map && groundB.map) {
    // Splat: blend two scanned ground textures with a low-frequency noise so the tiling does not show.
    const bmap = groundB.map, bnor = groundB.normalMap!;
    groundA.onBeforeCompile = (sh) => {
      sh.uniforms.mapB = { value: bmap }; sh.uniforms.norB = { value: bnor }; sh.uniforms.noiseT = { value: noise };
      sh.fragmentShader = 'uniform sampler2D mapB; uniform sampler2D norB; uniform sampler2D noiseT;\n' + sh.fragmentShader
        .replace('#include <map_fragment>', `
          vec4 cA = texture2D(map, vMapUv); vec4 cB = texture2D(mapB, vMapUv * 1.37);
          float nz = texture2D(noiseT, vMapUv / ${(SIZE / 6 / 3).toFixed(1)}).r * 0.75 + texture2D(noiseT, vMapUv / ${(SIZE / 6 / 40).toFixed(1)}).r * 0.25;
          float k = smoothstep(0.42, 0.58, nz);
          diffuseColor *= mix(cA, cB, k);`);
    };
  }
  const ground = new THREE.Mesh(gg, groundA); ground.receiveShadow = true; scene.add(ground);
  // Gun pit: an earth berm of sandbags round the gun, and the floor of the pit.
  const pitR = cfg.gun === 'zsu234' ? 7.5 : 5.2;
  { const floor = new THREE.Mesh(new THREE.CircleGeometry(pitR + 0.5, 40).rotateX(-Math.PI / 2), pbr('excavated_soil_wall', 3)); floor.position.y = 0.01; floor.receiveShadow = true; scene.add(floor); }
  const env = await gltf('models/env.glb');
  const wallTex: Record<string, THREE.MeshStandardMaterial> = {};
  const fixMaterials = (o: THREE.Object3D) => o.traverse((c) => {
    const m = (c as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
    if (!m || !(c as THREE.Mesh).isMesh) return;
    (c as THREE.Mesh).castShadow = true; (c as THREE.Mesh).receiveShadow = true;
    if (m.name === 'foliage') { m.alphaTest = 0.45; m.transparent = false; m.side = THREE.DoubleSide; }
    else if (m.name === 'hessian') { m.color.setRGB(0.16, 0.13, 0.08); m.roughness = 1; }
    else if (m.name.startsWith('wall_') || m.name === 'concrete') {
      const key = m.name;
      if (!wallTex[key]) { const t = pbr(m.name === 'concrete' ? 'rough_concrete' : 'plastered_wall_03', 1, { color: m.color.getHex() }); t.color.copy(m.color).multiplyScalar(1.25); wallTex[key] = t; }
      (c as THREE.Mesh).material = wallTex[key];
    }
  });
  /** One env root's parts merged into one geometry per material (a few draw calls instead of dozens). */
  const mergedCache = new Map<string, { geo: THREE.BufferGeometry; mat: THREE.Material }[]>();
  const merged = (name: string) => {
    if (mergedCache.has(name)) return mergedCache.get(name)!;
    const src = env?.getObjectByName(name);
    if (!src) return [];
    fixMaterials(src); src.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(src.matrixWorld).invert(), groups = new Map<THREE.Material, THREE.BufferGeometry[]>();
    src.traverse((c) => {
      const m = c as THREE.Mesh; if (!m.isMesh) return;
      const g = m.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
      for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
      if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
      const mat = m.material as THREE.Material; (groups.get(mat) ?? groups.set(mat, []).get(mat)!).push(g.index ? g.toNonIndexed() : g);
    });
    const out = [...groups].map(([mat, gs]) => ({ mat, geo: (gs.length > 1 ? mergeGeometries(gs, false) : gs[0]) ?? gs[0] }));
    mergedCache.set(name, out); return out;
  };
  /** Place copies as instanced meshes, split into 8 compass sectors so what is behind you is not drawn. */
  const SECTORS = 8;
  const addInstances = (parts: { geo: THREE.BufferGeometry; mat: THREE.Material }[], mats: THREE.Matrix4[], shadows = false) => {
    if (!parts.length || !mats.length) return false;
    const bins: THREE.Matrix4[][] = Array.from({ length: SECTORS }, () => []);
    for (const m of mats) { const x = m.elements[12], z = m.elements[14], near = Math.hypot(x, z) < 30; bins[near ? 0 : Math.floor(((Math.atan2(x, -z) / (2 * Math.PI) + 1) % 1) * SECTORS)].push(m); }
    for (const bin of bins) {
      if (!bin.length) continue;
      for (const { geo, mat } of parts) {
        const im = new THREE.InstancedMesh(geo, mat, bin.length);
        bin.forEach((m, k) => im.setMatrixAt(k, m));
        im.computeBoundingSphere(); im.castShadow = shadows; im.receiveShadow = true; scene.add(im);
      }
    }
    return true;
  };
  const instance = (name: string, mats: THREE.Matrix4[], shadows = false) => addInstances(merged(name), mats, shadows);
  /** Distant buildings: a plain plastered block of the same size (windows are not visible at that range anyway). */
  const blockOf = (name: string) => {
    const src = env?.getObjectByName(name); if (!src) return [];
    const box = new THREE.Box3().setFromObject(src), sz = box.getSize(new THREE.Vector3());
    const g = new THREE.BoxGeometry(sz.x * 0.97, sz.y * 0.82, sz.z * 0.97).translate(0, sz.y * 0.41, 0);
    const wall = merged(name).find((p) => p.mat.name.startsWith('wall_'))?.mat ?? new THREE.MeshStandardMaterial({ color: 0xb9b3a4 });
    return [{ geo: g, mat: wall }];
  };
  const place = (x: number, z: number, s = 1, ry = rng() * Math.PI * 2) => new THREE.Matrix4().compose(new THREE.Vector3(x, heightAt(x, z), z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ry), new THREE.Vector3(s, s, s));
  // Sandbag berm: three courses in a ring with a gap at the rear for the crew.
  { const bags: THREE.Matrix4[] = [];
    for (let course = 0; course < 3; course++) {
      const n = Math.floor((2 * Math.PI * pitR) / 0.6);
      for (let i = 0; i < n; i++) {
        const a = (i + (course % 2) * 0.5) / n * Math.PI * 2; if (Math.abs(angDiff(a / D2R, 180)) < 18) continue;
        bags.push(new THREE.Matrix4().compose(new THREE.Vector3(Math.sin(a) * pitR, course * 0.16, Math.cos(a) * pitR), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), a + Math.PI / 2), new THREE.Vector3(1, 1, 1)));
      }
    }
    instance('sandbag', bags, true); }
  // Terrain dressing.
  const blocked = (x: number, z: number, r: number) => Math.hypot(x, z) < r;
  const MASK = (d: number) => (d < 4600 ? 1.2 + 0.026 * d : 200);
  if (urban) {
    const kinds = (env ? ['bld_1_0', 'bld_1_1', 'bld_2_2', 'bld_2_3', 'bld_2_4', 'bld_3_5', 'bld_3_6', 'bld_4_7', 'bld_4_8', 'bld_5_9'] : []).filter((k) => env!.getObjectByName(k));
    const by: Record<string, THREE.Matrix4[]> = {};
    const N = lite ? 600 : 1300;
    for (let i = 0, tries = 0; i < N && tries < N * 8; tries++) {
      const gx = Math.round((rng() - 0.5) * 120) * 34 + (rng() - 0.5) * 6, gz = Math.round((rng() - 0.5) * 120) * 30 + (rng() - 0.5) * 6, d = Math.hypot(gx, gz);
      if (d < 180 || d > 5200 || Math.abs(gx % 102) < 8 || Math.abs(gz % 90) < 8) continue;
      const cap = MASK(d), fit = kinds.filter((k) => +k.split('_')[1] * 3.1 + 3.5 <= cap);
      if (!fit.length) continue;
      const k = fit[Math.floor(rng() * fit.length)];
      (by[k] ??= []).push(place(gx, gz, 1, Math.round(rng() * 4) * Math.PI / 2)); i++;
    }
    // Full models within 450 m, plain blocks beyond.
    const NEAR = lite ? 300 : 450;
    for (const [k, m] of Object.entries(by)) {
      const d = (x: THREE.Matrix4) => Math.hypot(x.elements[12], x.elements[14]);
      instance(k, m.filter((x) => d(x) < NEAR)); addInstances(blockOf(k), m.filter((x) => d(x) >= NEAR));
    }
    // Roads (asphalt) on the street grid, and the open maidan the gun stands in.
    const road = pbr('worn_asphalt', 1); (road.map ?? { repeat: null }).repeat?.set(2, 600); road.normalMap?.repeat.set(2, 600); road.roughnessMap?.repeat.set(2, 600);
    for (let i = -24; i <= 24; i++) {
      const a = new THREE.Mesh(new THREE.PlaneGeometry(9, 5000).rotateX(-Math.PI / 2), road); a.position.set(i * 102, 0.03, 0); a.receiveShadow = true; scene.add(a);
      const b = new THREE.Mesh(new THREE.PlaneGeometry(5000, 9).rotateX(-Math.PI / 2), road); b.position.set(0, 0.031, i * 90); b.receiveShadow = true; scene.add(b);
    }
    const maidan = new THREE.Mesh(new THREE.CircleGeometry(165, 48).rotateX(-Math.PI / 2), pbr('sparse_grass', 60)); maidan.position.y = 0.035; maidan.receiveShadow = true; scene.add(maidan);
  }
  { // Trees: near ones as models, far ones as photographed impostor sprites.
    const near: Record<string, THREE.Matrix4[]> = { tree_a: [], tree_b: [], tree_c: [] }, far: THREE.Vector3[] = [], farK: number[] = [], farS: number[] = [];
    const NT = urban ? (lite ? 120 : 260) : lite ? 700 : 1600;
    for (let i = 0; i < NT; i++) {
      const a = rng() * Math.PI * 2, d = 40 + Math.pow(rng(), 0.6) * 4800, x = Math.sin(a) * d, z = Math.cos(a) * d;
      if (blocked(x, z, pitR + 25) || (urban && d < 170)) continue;
      const k = ['tree_a', 'tree_b', 'tree_c'][Math.floor(rng() * 3)], hk = k === 'tree_b' ? 12 : k === 'tree_a' ? 9 : 7;
      const s = Math.min(1.2, Math.max(0.5, (MASK(d) + 3) / hk)) * (0.8 + rng() * 0.3);
      if (d < (lite ? 500 : 900)) near[k].push(place(x, z, s)); else { far.push(new THREE.Vector3(x, heightAt(x, z), z).setY(heightAt(x, z) + hk * s * 0.5)); farK.push(['tree_a', 'tree_b', 'tree_c'].indexOf(k)); farS.push(s); }
    }
    for (const [k, m] of Object.entries(near)) instance(k, m);
    // Far trees: two crossed quads with the photographed tree (one instanced mesh per type and sector).
    const H = [9.8, 13.1, 7.6];
    ['tree_a', 'tree_b', 'tree_c'].forEach((k, j) => {
      const t = tex(`models/${k}.png`); if (!t) return;
      const q1 = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0), q2 = q1.clone().rotateY(Math.PI / 2);
      const geo = mergeGeometries([q1, q2], false)!;
      const mat = new THREE.MeshBasicMaterial({ map: t, alphaTest: 0.5, side: THREE.DoubleSide });
      const mats = far.map((p, i) => ({ p, i })).filter(({ i }) => farK[i] === j).map(({ p, i }) => new THREE.Matrix4().compose(new THREE.Vector3(p.x, p.y - H[j] * farS[i] * 0.5, p.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng() * Math.PI), new THREE.Vector3(H[j] * farS[i], H[j] * farS[i], H[j] * farS[i])));
      addInstances([{ geo, mat }], mats);
    });
    // Scrub and rocks.
    const bushes: THREE.Matrix4[] = [], rocks: THREE.Matrix4[] = [];
    for (let i = 0; i < (lite ? 180 : 380); i++) { const a = rng() * 6.28, d = pitR + 6 + Math.pow(rng(), 1.5) * 900, x = Math.sin(a) * d, z = Math.cos(a) * d; if (urban && d > 160) continue; (rng() < 0.75 ? bushes : rocks).push(place(x, z, 0.5 + rng() * 0.8)); }
    instance('bush_r', bushes); instance('rock_r', rocks);
  }
  // Props at the gun position (Poly Haven CC0): ammunition, jerrycans, the radio set.
  const props: [string, number, number, number][] = [['wooden_military_crate', -2.8, 2.6, 0.3], ['wooden_military_crate', -3.4, 2.0, 1.2], ['ammo_box', -2.2, 3.1, 0.1], ['ammo_box', -2.0, 3.4, 0.4],
    ['metal_jerrycan_green', 3.0, 2.8, 0.2], ['vintage_radio_transceiver', 2.6, 3.4, 2.6], ['concrete_road_barrier', 0, -pitR - 3, 0]];
  for (const [id, x, z, r] of props) void gltf(`assets/models/${id}/${id}.gltf`).then((g) => { if (!g) return; const o = g.clone(true); o.position.set(x, 0.02, z); o.rotation.y = r; o.traverse((c) => { (c as THREE.Mesh).castShadow = (c as THREE.Mesh).receiveShadow = true; }); scene.add(o); });
  // The defended asset: vehicles under camouflage nets inside the asset radius.
  { const olive = new THREE.MeshStandardMaterial({ color: 0x3b4429, roughness: 0.8 }), net = new THREE.MeshStandardMaterial({ color: 0x48552f, roughness: 1, transparent: true, opacity: 0.92 });
    for (const [x, z, r] of [[-45, 30, 0.3], [-58, 18, 1.2], [-38, 52, -0.4]]) { const v = new THREE.Mesh(new THREE.BoxGeometry(2.5, 2.4, 6.5), olive); v.position.set(x, 1.2, z); v.rotation.y = r; v.castShadow = true; scene.add(v); const n = new THREE.Mesh(new THREE.BoxGeometry(7, 0.15, 10), net); n.position.set(x, 3, z); n.rotation.y = r; scene.add(n); } }

  // ---------- the gun ----------
  const gunRoot = ((await gltf(`models/${gunDef.model ?? cfg.gun}.glb`))?.clone(true)) ?? fallbackGun();
  gunRoot.traverse((c) => { (c as THREE.Mesh).castShadow = (c as THREE.Mesh).receiveShadow = true; });
  scene.add(gunRoot); gunRoot.updateMatrixWorld(true);
  const yaw = gunRoot.getObjectByName('yaw') ?? gunRoot, pitch = gunRoot.getObjectByName('pitch') ?? yaw;
  const eyeN = gunRoot.getObjectByName('eye'), sightN = gunRoot.getObjectByName('sight_eye'), radarN = gunRoot.getObjectByName('radar');
  const muzzles: THREE.Object3D[] = []; gunRoot.traverse((c) => { if (/^muzzle\d/.test(c.name)) muzzles.push(c); });
  ORIGIN_H = pitch.getWorldPosition(new THREE.Vector3()).y;
  const yaw0 = yaw.quaternion.clone(), pitch0 = pitch.quaternion.clone();
  const barrels: THREE.Object3D[] = [];
  pitch.children.forEach((c) => { if ((c as THREE.Mesh).isMesh && (c as THREE.Mesh).geometry?.boundingSphere == null) (c as THREE.Mesh).geometry.computeBoundingSphere(); });

  // ---------- drones ----------
  const droneLib = await gltf('models/drones.glb');
  interface Vis { g: THREE.Object3D; props: THREE.Object3D[]; wings: THREE.Object3D[]; speck: THREE.Sprite; mats: THREE.MeshStandardMaterial[]; fall?: { t0: number; p: THREE.Vector3; v: THREE.Vector3 } }
  const vis = new Map<number, Vis>(), dot = dotTexture();
  const droneOf = (type: string): THREE.Object3D => {
    const src = droneLib?.getObjectByName(`drone_${type}`) ?? droneLib?.getObjectByName('drone_fpv');
    if (src) { const c = src.clone(true); c.position.set(0, 0, 0); c.traverse((o) => { const mm = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined; if (mm) (o as THREE.Mesh).material = mm.clone(); }); return c; }
    return new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.15, 0.4), new THREE.MeshStandardMaterial({ color: 0x333333 }));
  };

  // ---------- fire effects ----------
  const fx = new THREE.Group(); scene.add(fx);
  const MAXT = 900, tpos = new Float32Array(MAXT * 6), tgeo = new THREE.BufferGeometry();
  tgeo.setAttribute('position', new THREE.BufferAttribute(tpos, 3));
  const tracerLines = new THREE.LineSegments(tgeo, new THREE.LineBasicMaterial({ color: night ? 0xffe2a0 : 0xffa848, fog: false, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }));
  tracerLines.frustumCulled = false; fx.add(tracerLines);
  const hpos = new Float32Array(MAXT * 3), hgeo = new THREE.BufferGeometry(); hgeo.setAttribute('position', new THREE.BufferAttribute(hpos, 3));
  const heads = new THREE.Points(hgeo, new THREE.PointsMaterial({ map: dot, color: night ? 0xfff1c0 : 0xffc070, size: 5, sizeAttenuation: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
  heads.frustumCulled = false; fx.add(heads);
  const tracers = new Map<number, { t0: number; pts: Vec3[]; step: number }>();
  const puffs: { s: THREE.Sprite; t0: number; life: number; grow: number; kind: 'smoke' | 'flash' }[] = [];
  const flashes = muzzles.map((m) => { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: dot, color: 0xffc56a, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, transparent: true })); s.visible = false; m.add(s); return s; });
  const flashLight = new THREE.PointLight(0xffb060, 0, 18, 2); pitch.add(flashLight); if (muzzles[0]) flashLight.position.copy(muzzles[0].position);
  const puff = (at: THREE.Vector3, t: number, kind: 'smoke' | 'flash', size: number, life: number, col = 0x2d2d2d) => {
    if (puffs.length > 400) { const o = puffs.shift()!; fx.remove(o.s); o.s.material.dispose(); }
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: dot, color: kind === 'flash' ? 0xffd27a : col, transparent: true, depthWrite: false, fog: kind !== 'flash', blending: kind === 'flash' ? THREE.AdditiveBlending : THREE.NormalBlending }));
    s.position.copy(at); s.scale.setScalar(size); fx.add(s); puffs.push({ s, t0: t, life, grow: size, kind });
  };
  let precip: THREE.Points | THREE.LineSegments | null = null;
  if (!lite && (wx === 'rain' || wx === 'dust')) {
    const n = wx === 'rain' ? 3000 : 1500, p = new Float32Array(n * (wx === 'rain' ? 6 : 3));
    for (let i = 0; i < n; i++) { const x = (rng() - 0.5) * 60, y = rng() * 30, z = (rng() - 0.5) * 60; if (wx === 'rain') p.set([x, y, z, x + 0.04, y - 0.7, z], i * 6); else p.set([x, y, z], i * 3); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    precip = wx === 'rain' ? new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xb4bec8, transparent: true, opacity: 0.3, fog: false }))
      : new THREE.Points(g, new THREE.PointsMaterial({ color: 0xb59c72, size: 2, sizeAttenuation: false, transparent: true, opacity: 0.5 }));
    precip.frustumCulled = false; scene.add(precip);
  }

  // ---------- state and input ----------
  let mode: FieldViewMode = 'gun', ads = false, binos = false, locked = false;
  const aim = { az: E0.g.az, el: Math.max(5, E0.g.el) }, ext = { th: 0.7, ph: 1.15, r: cfg.gun === 'zsu234' ? 16 : 11 };
  let drag: { x0: number; y0: number; x: number; y: number; moved: boolean } | null = null;
  let thermalOn = false, blackHot = false, tiNarrow = false;
  // Thermal imager (L70 electro-optical fire control): the scene is rendered with "temperatures" (cold black sky,
  // ground and buildings by solar loading, hot drone motors, tracers and muzzle flash), then a post-process turns it
  // into a thermal picture: soft optics, sensor grain, fixed-pattern column noise, bloom on hot spots, vignette.
  const pmremEnv = scene.environment;
  const hotLight = new THREE.HemisphereLight(0x8a8a8a, 0x5a5a5a, 1.1); hotLight.visible = false; scene.add(hotLight);
  const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType });
  const tiMat = new THREE.ShaderMaterial({
    uniforms: { tDiffuse: { value: rt.texture }, res: { value: new THREE.Vector2(4, 4) }, time: { value: 0 }, black: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `
      uniform sampler2D tDiffuse; uniform vec2 res; uniform float time; uniform float black; varying vec2 vUv;
      float rnd(vec2 c){ return fract(sin(dot(c, vec2(12.9898, 78.233))) * 43758.5453); }
      float heat(vec2 uv){ vec3 c = texture2D(tDiffuse, uv).rgb; float l = dot(c, vec3(0.299, 0.587, 0.114)); return l / (l + 0.55); }
      void main(){
        vec2 px = 1.0 / res;
        // Thermal optics are soft: a small blur, plus a wide glow round hot spots.
        float t = heat(vUv) * 0.4 + (heat(vUv + vec2(px.x, 0.0)) + heat(vUv - vec2(px.x, 0.0)) + heat(vUv + vec2(0.0, px.y)) + heat(vUv - vec2(0.0, px.y))) * 0.15;
        float g = 0.0;
        for (int i = 0; i < 8; i++) { float a = float(i) * 0.785; g += max(0.0, heat(vUv + vec2(cos(a), sin(a)) * px * 3.0) - 0.55) + max(0.0, heat(vUv + vec2(cos(a), sin(a)) * px * 7.0) - 0.6); }
        t = max(t, heat(vUv)) + g * 0.1;
        t = pow(clamp(t, 0.0, 1.0), 1.1);
        t += (rnd(vUv * res + fract(time) * 91.0) - 0.5) * 0.07;          // sensor noise (NETD)
        t += (rnd(vec2(floor(vUv.x * res.x * 0.5), 3.0)) - 0.5) * 0.025;   // fixed-pattern column noise
        if (black > 0.5) t = 1.0 - t;
        float v = smoothstep(0.82, 0.35, length((vUv - 0.5) * vec2(res.x / res.y, 1.0)) * 0.9);
        gl_FragColor = vec4(vec3(clamp(t, 0.0, 1.0) * (0.35 + 0.65 * v)), 1.0);
      }`,
    depthTest: false, depthWrite: false,
  });
  const tiScene = new THREE.Scene(), tiCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  tiScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), tiMat));
  const setThermal = (hot: boolean) => {
    if (hot === thermalOn) return; thermalOn = hot;
    scene.background = hot ? new THREE.Color(0x020202) : sky ?? new THREE.Color(night ? 0x060a12 : 0x9fb6c8);
    scene.environment = hot ? null : pmremEnv;
    scene.fog = hot ? fogHot : fogDay;
    // Drones: motors and electronics run hot; the airframe warms up. Same picture by day and night.
    for (const v of vis.values()) for (const m of v.mats) { m.emissive.setHex(hot ? 0xffffff : 0x000000); m.emissiveIntensity = hot ? 7 : 1; }
    sun.intensity = hot ? (night ? 0 : 1.2) : night ? 0.25 : wx === 'clear' ? 2.6 : 0.9;
    hotLight.visible = hot;
  };
  const resize = () => {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
    const pr = renderer.getPixelRatio(); rt.setSize(Math.round(w * pr), Math.round(h * pr)); tiMat.uniforms.res.value.set(w * pr, h * pr);
    hud.width = w * devicePixelRatio; hud.height = h * devicePixelRatio;
  };
  const ro = new ResizeObserver(resize); ro.observe(host); resize();
  let lastE: GunEngine = E0, lastT = 0;
  const project = (p: THREE.Vector3) => { const v = p.clone().project(camera); return { x: (v.x + 1) / 2 * host.clientWidth, y: (1 - v.y) / 2 * host.clientHeight, front: v.z < 1 && v.z > -1 }; };
  const visibility = (E: GunEngine, T: GunTarget, t: number) => {
    if (T.state !== 'live') return 0;
    const L = losOf(targetPos(T, t, E.dt)), R = detectRangeM(E, T), mask = urban ? 1.5 : 0.3;
    if (L.el < mask - 0.6) return 0;
    // Fully visible from the moment the scorer counts it as visible; a short fade-in just beyond.
    return Math.max(0, Math.min(1, (1.12 * R - L.range) / (0.12 * R)));
  };
  const pickAt = (sx: number, sy: number): number | null => {
    let best: number | null = null, bd = 22;
    for (const T of lastE.targets) {
      if (visibility(lastE, T, lastT) <= 0.05) continue;
      const s = project(W(targetPos(T, lastT, lastE.dt))); if (!s.front) continue;
      const d = Math.hypot(s.x - sx, s.y - sy); if (d < bd) { bd = d; best = T.id; }
    }
    return best;
  };
  const onLock = () => { locked = document.pointerLockElement === cv; tip.style.display = locked || mode === 'ext' ? 'none' : ''; if (!locked) ads = false; };
  document.addEventListener('pointerlockchange', onLock);
  tip.innerHTML = '<b>Click to take the gun</b><span>Mouse aims · hold right button: sight · Z binoculars · E report the contact in the middle · Space fire · Esc releases the mouse</span>';
  cv.addEventListener('contextmenu', (e) => e.preventDefault());
  cv.addEventListener('mousedown', (e) => {
    if (mode === 'gun' && !locked && e.button === 0) { void cv.requestPointerLock(); return; }
    if (mode === 'gun' && locked && e.button === 2) { ads = true; binos = false; }
    if (mode === 'gun' && locked && e.button === 1) { e.preventDefault(); const id = centre(); if (id != null) cb.pick(id); }
  });
  addEventListener('mouseup', (e) => { if (e.button === 2) ads = false; });
  cv.addEventListener('mousemove', (e) => {
    if (mode !== 'gun' || !locked) return;
    const k = camera.fov / host.clientHeight * 0.9;
    aim.az = (aim.az + e.movementX * k + 360) % 360; aim.el = Math.max(gunDef.elevDeg[0], Math.min(gunDef.elevDeg[1], aim.el - e.movementY * k));
  });
  // Outside view: drag to orbit, click a target to report it.
  cv.addEventListener('pointerdown', (e) => { if (mode === 'ext') { cv.setPointerCapture(e.pointerId); drag = { x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, moved: false }; } });
  cv.addEventListener('pointermove', (e) => { if (!drag || mode !== 'ext') return; if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > 4) drag.moved = true; ext.th -= (e.clientX - drag.x) * 0.008; ext.ph = Math.max(0.2, Math.min(1.5, ext.ph - (e.clientY - drag.y) * 0.006)); drag.x = e.clientX; drag.y = e.clientY; });
  cv.addEventListener('pointerup', (e) => { if (drag && !drag.moved) { const r = cv.getBoundingClientRect(), id = pickAt(e.clientX - r.left, e.clientY - r.top); if (id != null) cb.pick(id); } drag = null; });
  cv.addEventListener('wheel', (e) => { e.preventDefault(); if (mode === 'ext') ext.r = Math.max(5, Math.min(60, ext.r * (e.deltaY > 0 ? 1.1 : 0.9))); else binos = e.deltaY < 0; }, { passive: false });
  const centre = () => pickAt(host.clientWidth / 2, host.clientHeight / 2) ?? (() => {
    let best: number | null = null, bd = 70;
    for (const T of lastE.targets) { if (visibility(lastE, T, lastT) <= 0.05) continue; const s = project(W(targetPos(T, lastT, lastE.dt))); if (!s.front) continue; const d = Math.hypot(s.x - host.clientWidth / 2, s.y - host.clientHeight / 2); if (d < bd) { bd = d; best = T.id; } }
    return best;
  })();

  // ---------- per frame ----------
  let lastTick = -1, firedSeen = 0, evSeen = 0, prevAz = E0.g.az, prevEl = E0.g.el, curAz = E0.g.az, curEl = E0.g.el, lastBang = 0, kick = 0;
  const am = E0.G.ammo[gunDef.ammo], big = am.caliberM > 0.03, snd = fieldAudio(cfg.gun);
  let wasFiring = false;
  const hctx = hud.getContext('2d')!;
  const fcsLocked = (E: GunEngine) => gunDef.sight !== 'manual' && !cfg.radarFault && E.g.lockCid != null && E.g.lockStart != null && E.tick - E.g.lockStart >= Math.round((fcsOf(gunDef)?.lockSec ?? 0) / E.dt);

  function syncTargets(E: GunEngine, t: number, now: number) {
    for (const T of E.targets) {
      let v = vis.get(T.id);
      if (!v) {
        const g = droneOf(T.type), props: THREE.Object3D[] = [], wings: THREE.Object3D[] = [], mats: THREE.MeshStandardMaterial[] = [];
        g.traverse((o) => { if (/^prop/.test(o.name)) props.push(o); if (/^wing/.test(o.name)) wings.push(o); const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined; if (m && (m as any).isMeshStandardMaterial) mats.push(m); });
        const speck = new THREE.Sprite(new THREE.SpriteMaterial({ map: dot, color: night ? 0x9aa2ab : 0x101010, fog: false, depthWrite: false, sizeAttenuation: false, transparent: true }));
        speck.scale.setScalar(0.0035);
        v = { g, props, wings, speck, mats }; vis.set(T.id, v); scene.add(g, speck);
        if (thermalOn) for (const m of mats) { m.emissive.setHex(0xffffff); m.emissiveIntensity = 7; }
      }
      if (T.state === 'destroyed' || T.state === 'leaked') {
        if (T.state === 'leaked' || T.endTick == null) { v.g.visible = v.speck.visible = false; continue; }
        if (!v.fall) { const p = W(targetPos(T, T.endTick * E.dt, E.dt)); v.fall = { t0: T.endTick * E.dt, p, v: new THREE.Vector3((rng() - 0.5) * 6, 2, (rng() - 0.5) * 6) }; puff(p, t, 'flash', big ? 9 : 6, 0.35); puff(p, t, 'smoke', big ? 7 : 5, 5, 0x2a2622); }
        const s = t - v.fall.t0, y = v.fall.p.y + v.fall.v.y * s - 4.9 * s * s;
        v.g.visible = y > 0 && s < 15; v.speck.visible = false;
        v.g.position.set(v.fall.p.x + v.fall.v.x * s, Math.max(0, y), v.fall.p.z + v.fall.v.z * s); v.g.rotation.x += 0.12; v.g.rotation.z += 0.08;
        if (y > 0 && Math.random() < 0.3) puff(v.g.position.clone(), t, 'smoke', 1.5, 2, 0x222222);
        continue;
      }
      if (T.state !== 'live') { v.g.visible = v.speck.visible = false; continue; }
      const p = targetPos(T, t, E.dt), q2 = targetPos(T, t + 0.25, E.dt), a = visibility(E, T, t);
      W(p, v.g.position); v.speck.position.copy(v.g.position);
      const hd = Math.atan2(q2[0] - p[0], q2[1] - p[1]);
      v.g.rotation.set(0, -hd, Math.sin(now * 0.002 + T.id) * 0.05);
      v.g.visible = a > 0; v.speck.visible = a > 0; v.speck.material.opacity = a * 0.9;
      v.speck.material.color.setHex(thermalOn ? 0xffffff : night ? 0x9aa2ab : 0x101010);
      for (const r of v.props) r.rotateY(1.9);
      for (const [i, f] of v.wings.entries()) f.rotation.y = Math.sin(now * 0.014 + T.id) * 0.7 * (i ? -1 : 1);
    }
  }

  function syncFire(E: GunEngine, t: number) {
    if (E.rounds.length > firedSeen) { snd?.rounds(E.rounds.length - firedSeen, E.dt); kick = 1; }
    for (; firedSeen < E.rounds.length; firedSeen++) {
      const r = E.rounds[firedSeen];
      if (!big && r.i % 2) continue;
      const pts: Vec3[] = [], end = Math.min(am.tracerSec, r.hit ? r.tau + 0.02 : am.tracerSec);
      fly(am, { az: r.az, el: r.el, mv: r.mv }, E.cfg.met, { dt: 0.05, tMax: end }, (_t, p) => { pts.push([p[0], p[1], p[2]]); });
      tracers.set(r.i, { t0: r.tick * E.dt, pts, step: 0.05 });
      if (!r.hit && !r.dud && am.selfDestructSec > 0 && (big || r.i % 4 === 0)) {
        let at: Vec3 | null = null; fly(am, { az: r.az, el: r.el, mv: r.mv }, E.cfg.met, { dt: 0.1, tMax: am.selfDestructSec }, (_t, p) => { at = [p[0], p[1], p[2]]; return p[2] < -2; });
        if (at && (at as Vec3)[2] > 2) tracers.set(-1 - r.i, { t0: r.tick * E.dt + am.selfDestructSec, pts: [at], step: 0 });
      }
      if (!snd && performance.now() - lastBang > (big ? 150 : 40)) { bang(big ? 0.7 : 0.35, big ? 700 : 1500); lastBang = performance.now(); }
    }
    for (; evSeen < E.ev.length; evSeen++) {
      const e = E.ev[evSeen], T = e.k === 'destroyed' ? E.targets.find((x) => x.id === e.cid) : undefined;
      if (T) { if (snd) snd.boom(losOf(targetPos(T, t, E.dt)).range, true); else bang(0.4, 400); }
      if (e.k === 'loading') snd?.loader('start'); else if (e.k === 'loaded') snd?.loader('done');
    }
    let n = 0;
    for (const [i, tr] of tracers) {
      if (i < 0) { if (t >= tr.t0) { const at = W(tr.pts[0]); puff(at, t, 'flash', big ? 5 : 3, 0.12); puff(at, t, 'smoke', big ? 4 : 2.5, 4, 0x262626); if (Math.random() < 0.25) snd?.boom(Math.hypot(...tr.pts[0]), false); tracers.delete(i); } continue; }
      const age = t - tr.t0, k = age / tr.step;
      if (age < 0) continue;
      if (k >= tr.pts.length - 1) { tracers.delete(i); continue; }
      if (n >= MAXT) continue;
      const k0 = Math.floor(k), f = k - k0, a = tr.pts[k0], b = tr.pts[k0 + 1];
      const head: Vec3 = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
      const tk = Math.max(0, k - (big ? 0.9 : 0.6)), t0 = Math.floor(tk), tf = tk - t0, c = tr.pts[t0], d2 = tr.pts[Math.min(tr.pts.length - 1, t0 + 1)];
      const tail: Vec3 = [c[0] + (d2[0] - c[0]) * tf, c[1] + (d2[1] - c[1]) * tf, c[2] + (d2[2] - c[2]) * tf];
      tpos.set([tail[0], tail[2] + ORIGIN_H, -tail[1], head[0], head[2] + ORIGIN_H, -head[1]], n * 6); hpos.set([head[0], head[2] + ORIGIN_H, -head[1]], n * 3); n++;
    }
    tgeo.setDrawRange(0, n * 2); (tgeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    hgeo.setDrawRange(0, n); (hgeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    for (let i = puffs.length - 1; i >= 0; i--) {
      const p = puffs[i], a = (t - p.t0) / p.life;
      if (a >= 1 || a < -0.5) { fx.remove(p.s); p.s.material.dispose(); puffs.splice(i, 1); continue; }
      p.s.material.opacity = p.kind === 'flash' ? 1 - a : 0.7 * (1 - a);
      p.s.scale.setScalar(p.grow * (p.kind === 'flash' ? 1 + a : 1 + a * 2.5)); if (p.kind === 'smoke') p.s.position.y += 0.012;
    }
    const firing = E.g.trig && E.g.loaded && !E.g.safety && !E.g.busy && !E.g.stoppage;
    if (wasFiring && !firing) snd?.burstEnd();
    wasFiring = firing;
    flashes.forEach((f) => { f.visible = firing && Math.random() < 0.75; f.scale.setScalar((big ? 1.3 : 0.7) * (0.7 + Math.random() * 0.6)); });
    flashLight.intensity = firing ? (night ? 40 : 15) * Math.random() : 0;
    if (firing && Math.random() < (big ? 0.2 : 0.35) && muzzles[0]) puff(muzzles[0].getWorldPosition(new THREE.Vector3()), t, 'smoke', big ? 1.6 : 0.9, 1.6, 0x8a8a84);
    kick *= 0.82;
  }

  /** Line of sight of the gun's sight: on a manual sight the barrel leads it, so the sight looks behind the barrel. */
  function sightLine(E: GunEngine, sol: AimSolution | null, t: number) {
    let az = curAz, el = curEl;
    if (sol?.ok) {
      const T = E.targets.find((x) => x.id === (E.cleared ?? E.g.lockCid)) ?? E.targets.find((x) => x.state === 'live' && Math.hypot(angDiff(losOf(targetPos(x, t, E.dt)).az, E.g.az), losOf(targetPos(x, t, E.dt)).el - E.g.el) < gunDef.sightFovDeg / 2);
      if (T && T.state === 'live') { const l = losOf(targetPos(T, t, E.dt)); az = curAz - angDiff(sol.az, l.az); el = curEl - (sol.el - l.el); }
    }
    return { az, el };
  }

  function placeCamera(E: GunEngine, sol: AimSolution | null, t: number) {
    const fwd = new THREE.Vector3();
    if (mode === 'ext') {
      camera.fov = 50;
      camera.position.set(Math.sin(ext.th) * Math.sin(ext.ph) * ext.r, Math.cos(ext.ph) * ext.r + 1.2, Math.cos(ext.th) * Math.sin(ext.ph) * ext.r);
      camera.lookAt(0, 1.2, 0);
    } else if (ads) {
      const s = sightLine(E, sol, t);
      (sightN ?? pitch).getWorldPosition(camera.position);
      camera.fov = thermalSight ? (tiNarrow ? 3 : gunDef.sightFovDeg) : gunDef.sight === 'radar' ? gunDef.sightFovDeg : 22;
      dirW(s.az, s.el, fwd); camera.up.set(0, 1, 0); camera.lookAt(camera.position.clone().add(fwd));
    } else {
      (eyeN ?? yaw).getWorldPosition(camera.position);
      camera.position.y += Math.sin(performance.now() * 0.0011) * 0.006 + kick * 0.01;
      camera.fov = binos ? 7.5 : 72; dirW(aim.az + (Math.random() - 0.5) * kick * 0.15, aim.el + kick * 0.1, fwd);
      camera.up.set(0, 1, 0); camera.lookAt(camera.position.clone().add(fwd));
    }
    camera.updateProjectionMatrix();
    setThermal(mode === 'gun' && ads && thermalSight);
    // Hide what would block the sight picture.
    gunRoot.visible = !(ads && mode === 'gun');
  }

  // ---------- HUD ----------
  const pad3 = (n: number) => String(Math.round(((n % 360) + 360) % 360)).padStart(3, '0');
  /** Black mask over the whole view with clean round holes cut out (eyepiece, binoculars). */
  function mask(c: CanvasRenderingContext2D, w: number, h: number, holes: [number, number, number][], alpha: number) {
    c.save();
    c.fillStyle = `rgba(0,0,0,${alpha})`; c.fillRect(0, 0, w, h);
    c.globalCompositeOperation = 'destination-out'; c.fillStyle = '#000';
    for (const [x, y, r] of holes) { c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill(); }
    c.restore();
  }
  function drawHud(E: GunEngine, sol: AimSolution | null, t: number, marks: FieldMarks) {
    const c = hctx, w = hud.width, h = hud.height, dp = devicePixelRatio, cx = w / 2, cy = h / 2;
    c.clearRect(0, 0, w, h);
    const hot = thermalOn, sightView = mode === 'gun' && ads;
    const ink = hot ? 'rgba(255,255,255,0.92)' : night && sightView ? 'rgba(150,255,170,0.9)' : sightView ? 'rgba(255,60,40,0.9)' : 'rgba(255,255,255,0.85)';
    c.font = `${13 * dp}px Barlow Condensed, sans-serif`; c.lineWidth = 1.4 * dp;
    const T = getConfig().threats.threats;
    // Brackets on reported contacts (finding them is the drill; unreported contacts are never marked).
    for (const tg of E.targets) {
      if (tg.state !== 'live' || E.spots[tg.id] == null) continue;
      const s = project(W(targetPos(tg, t, E.dt)));
      const id = marks.ident(tg.id), cls = !id || id === 'unknown' ? 'unk' : T[id]?.hostile ? 'h' : T[id]?.friendly ? 'f' : 'n';
      const col = cls === 'h' ? '#FF5C61' : cls === 'f' ? '#5DA9FF' : cls === 'n' ? '#6FCF97' : '#F2C94C';
      const off = !s.front || s.x < 0 || s.x > host.clientWidth || s.y < 0 || s.y > host.clientHeight;
      if (off) {
        if (tg.id !== marks.selected && tg.id !== marks.indicated) continue;
        const v = W(targetPos(tg, t, E.dt)).applyMatrix4(camera.matrixWorldInverse), a = Math.atan2(-v.y, v.x), r = Math.min(w, h) / 2 - 34 * dp;
        c.save(); c.translate(cx + Math.cos(a) * r, cy + Math.sin(a) * r); c.rotate(a); c.fillStyle = col;
        c.beginPath(); c.moveTo(14 * dp, 0); c.lineTo(-6 * dp, -8 * dp); c.lineTo(-6 * dp, 8 * dp); c.fill(); c.restore();
        continue;
      }
      const x = s.x * dp, y = s.y * dp, b = (tg.id === marks.selected ? 15 : 11) * dp;
      c.strokeStyle = col; c.lineWidth = (tg.id === marks.selected ? 2 : 1.3) * dp;
      for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { c.beginPath(); c.moveTo(x + sx * b, y + sy * b * 0.45); c.lineTo(x + sx * b, y + sy * b); c.lineTo(x + sx * b * 0.45, y + sy * b); c.stroke(); }
      c.fillStyle = col; c.fillText(`${tg.id}${id ? ' ' + (id === 'unknown' ? '?' : T[id]?.short ?? id) : ''}`, x + b + 3 * dp, y - b + 10 * dp);
    }
    c.strokeStyle = ink; c.fillStyle = ink; c.lineWidth = 1.4 * dp;
    if (sightView) {
      const pxDeg = h / camera.fov;
      if (gunDef.sight === 'manual' || cfg.radarFault) {
        // Collimator sight: lead rings (10, 20, 30 mils) and the cross.
        for (const mil of [10, 20, 30]) { c.beginPath(); c.arc(cx, cy, mil * 0.0573 * pxDeg, 0, 7); c.stroke(); }
        c.beginPath(); c.moveTo(cx - 34 * 0.0573 * pxDeg, cy); c.lineTo(cx + 34 * 0.0573 * pxDeg, cy); c.moveTo(cx, cy - 34 * 0.0573 * pxDeg); c.lineTo(cx, cy + 34 * 0.0573 * pxDeg); c.stroke();
        c.beginPath(); c.arc(cx, cy, 2 * dp, 0, 7); c.fill();
        mask(c, w, h, [[cx, cy, Math.min(w, h) * 0.46]], 0.92);
        c.fillStyle = 'rgba(255,255,255,0.8)';
        if (E.g.sight) c.fillText(`SPEED ${E.g.sight.spd} m/s   COURSE ${E.g.sight.crs > 0 ? '+' : ''}${E.g.sight.crs}°   RANGE ${E.g.sight.rng} m   ([ ] ; ' , .)`, 14 * dp, h - 14 * dp);
      } else {
        // Fire-control display (L70 thermal or ZSU-23-4 optical with radar): tracking gate and data.
        const lk = fcsLocked(E);
        c.strokeStyle = lk ? (hot ? '#ffffff' : '#22d36a') : ink;
        c.strokeRect(cx - 30 * dp, cy - 20 * dp, 60 * dp, 40 * dp);
        c.beginPath(); c.moveTo(cx - 90 * dp, cy); c.lineTo(cx - 36 * dp, cy); c.moveTo(cx + 36 * dp, cy); c.lineTo(cx + 90 * dp, cy); c.moveTo(cx, cy - 70 * dp); c.lineTo(cx, cy - 26 * dp); c.moveTo(cx, cy + 26 * dp); c.lineTo(cx, cy + 70 * dp); c.stroke();
        c.fillStyle = c.strokeStyle;
        c.fillText(lk ? (thermalSight ? 'TRACK  ·  LRF  ·  FCS SOLUTION' : 'LOCK  ·  FCS SOLUTION') : E.g.lockCid != null ? 'ACQUIRING…' : thermalSight ? 'TI  WHT-HOT  ·  SEARCH' : 'SEARCH', cx - 70 * dp, cy + 92 * dp);
        if (lk && E.g.lockCid != null) { const tg = E.targets.find((x) => x.id === E.g.lockCid); if (tg && tg.state === 'live') c.fillText(`RNG ${Math.round(losOf(targetPos(tg, t, E.dt)).range)} m`, cx + 40 * dp, cy - 26 * dp); }
        if (thermalSight) {
          // Fire-control monitor symbology.
          const sym = blackHot ? 'rgba(0,0,0,0.85)' : 'rgba(255,255,255,0.85)';
          c.strokeStyle = sym; c.fillStyle = sym; c.lineWidth = 1.5 * dp;
          for (const [x, y, sx, sy] of [[24, 24, 1, 1], [w / dp - 24, 24, -1, 1], [24, h / dp - 24, 1, -1], [w / dp - 24, h / dp - 24, -1, -1]]) { c.beginPath(); c.moveTo(x * dp, (y + sy * 30) * dp); c.lineTo(x * dp, y * dp); c.lineTo((x + sx * 30) * dp, y * dp); c.stroke(); }
          c.font = `600 ${14 * dp}px Barlow Condensed, sans-serif`;
          c.fillText(`TI  ${blackHot ? 'BLK-HOT' : 'WHT-HOT'}   ${tiNarrow ? 'NFOV 3°' : `WFOV ${gunDef.sightFovDeg}°`}`, 36 * dp, 46 * dp);
          c.fillText(`AZ ${E.g.az.toFixed(1)}°   EL ${E.g.el.toFixed(1)}°`, 36 * dp, h - 36 * dp);
          c.fillText('Z  FOV    T  POLARITY    Q  TRACK', w - 230 * dp, h - 36 * dp);
          const lkd = E.g.lockCid != null ? E.targets.find((x) => x.id === E.g.lockCid && x.state === 'live') : undefined;
          c.fillText(lkd && lk ? `LRF ${Math.round(losOf(targetPos(lkd, t, E.dt)).range)} m` : 'LRF ----', w - 130 * dp, 46 * dp);
          // Elevation scale on the left.
          for (let k = 0; k <= 9; k++) { const y = h - 90 * dp - k * (h - 180 * dp) / 9; c.fillRect(30 * dp, y, (k % 3 ? 6 : 12) * dp, dp); if (k % 3 === 0) c.fillText(`${k * 10}`, 46 * dp, y + 4 * dp); }
          const ey = h - 90 * dp - Math.max(0, Math.min(90, E.g.el)) / 90 * (h - 180 * dp); c.beginPath(); c.moveTo(28 * dp, ey); c.lineTo(20 * dp, ey - 5 * dp); c.lineTo(20 * dp, ey + 5 * dp); c.fill();
        }
      }
    } else if (mode === 'gun') {
      if (binos) { mask(c, w, h, [[cx - h * 0.22, cy, h * 0.36], [cx + h * 0.22, cy, h * 0.36]], 0.9); c.fillStyle = ink; }
      // Aim dot, and the gun line (where the barrels actually point) so you can see the gun catching up.
      c.beginPath(); c.arc(cx, cy, 2.2 * dp, 0, 7); c.fillStyle = 'rgba(255,255,255,0.9)'; c.fill();
      const g = project(W(dirOf(curAz, curEl).map((x) => x * 1500) as Vec3));
      if (g.front) { c.strokeStyle = 'rgba(242,201,76,0.9)'; c.beginPath(); c.arc(g.x * dp, g.y * dp, 9 * dp, 0, 7); c.stroke(); c.beginPath(); c.moveTo(g.x * dp, g.y * dp - 14 * dp); c.lineTo(g.x * dp, g.y * dp - 9 * dp); c.moveTo(g.x * dp, g.y * dp + 9 * dp); c.lineTo(g.x * dp, g.y * dp + 14 * dp); c.stroke(); }
    }
    // Compass and elevation.
    if (mode === 'gun') {
      const az = sightView ? sightLine(E, sol, t).az : aim.az, pxDeg = 4 * dp;
      c.fillStyle = 'rgba(0,0,0,0.35)'; c.fillRect(cx - 200 * dp, 8 * dp, 400 * dp, 24 * dp); c.fillStyle = 'rgba(255,255,255,0.9)';
      for (let a = Math.ceil((az - 50) / 5) * 5; a <= az + 50; a += 5) { const x = cx + angDiff(a, az) * pxDeg; if (Math.abs(x - cx) > 196 * dp) continue; c.fillRect(x, 24 * dp, dp, (a % 10 ? 4 : 8) * dp); if (a % 30 === 0) c.fillText(a % 360 === 0 ? 'N' : a % 360 === 90 ? 'E' : a % 360 === 180 ? 'S' : a % 360 === 270 ? 'W' : pad3(a), x - 8 * dp, 21 * dp); }
      c.fillText(`${pad3(az)}°  EL ${(sightView ? sightLine(E, sol, t).el : aim.el).toFixed(0)}°`, cx - 30 * dp, 48 * dp);
      // Early warning from the air-defence control room: bearing marks for air contacts inside 5 km (sector cue only;
      // the detachment still has to find, report and identify each one).
      for (const tg of E.targets) {
        if (tg.state !== 'live') continue;
        const L = losOf(targetPos(tg, t, E.dt)); if (L.range > 5000) continue;
        const brg = Math.round(L.az / 5) * 5, d = angDiff(brg, az), id = marks.ident(tg.id);
        const col = E.spots[tg.id] == null ? '#F2C94C' : !id || id === 'unknown' ? '#F2C94C' : T[id]?.hostile ? '#FF5C61' : T[id]?.friendly ? '#5DA9FF' : '#6FCF97';
        const x = Math.abs(d) <= 48 ? cx + d * pxDeg : cx + Math.sign(d) * 196 * dp;
        c.fillStyle = col; c.beginPath(); c.moveTo(x, 34 * dp); c.lineTo(x - 5 * dp, 42 * dp); c.lineTo(x + 5 * dp, 42 * dp); c.fill();
        if (Math.abs(d) > 48) c.fillText(`${d > 0 ? '▶' : '◀'}${pad3(brg)}`, x + (d > 0 ? -44 : 4) * dp, 54 * dp);
      }
    }
    // Radar scope (ZSU-23-4).
    if (radarSight && mode === 'gun') {
      const R = 74 * dp, ox = 20 * dp + R, oy = h - R - 20 * dp, maxM = fcsOf(gunDef)?.acquireRangeM ?? 6000;
      c.fillStyle = 'rgba(6,16,10,0.85)'; c.beginPath(); c.arc(ox, oy, R, 0, 7); c.fill();
      c.strokeStyle = 'rgba(80,220,120,0.5)'; c.lineWidth = dp; for (const k of [0.33, 0.66, 1]) { c.beginPath(); c.arc(ox, oy, R * k, 0, 7); c.stroke(); }
      const sw = (t * 120) % 360; c.beginPath(); c.moveTo(ox, oy); c.lineTo(ox + Math.sin(sw * D2R) * R, oy - Math.cos(sw * D2R) * R); c.stroke();
      const b = dirOf(E.g.az, 0); c.strokeStyle = '#F2C94C'; c.beginPath(); c.moveTo(ox, oy); c.lineTo(ox + b[0] * R, oy - b[1] * R); c.stroke();
      for (const tg of E.targets) if (detectable(E, tg, t)) { const p = targetPos(tg, t, E.dt), k = R / maxM; c.fillStyle = E.spots[tg.id] != null ? '#F2C94C' : '#7dff9a'; c.fillRect(ox + p[0] * k - 2 * dp, oy - p[1] * k - 2 * dp, 4 * dp, 4 * dp); }
      c.fillStyle = 'rgba(125,255,154,0.9)'; c.fillText('RADAR', ox - R, oy - R - 4 * dp);
    }
    // Gun state, bottom right (Squad-style).
    c.font = `600 ${15 * dp}px Barlow Condensed, sans-serif`;
    const lines: [string, string][] = [
      [`${gunDef.short}  ·  ${E.g.loaded ? `${E.g.ready} READY` : E.g.busy === 'rstep' || E.g.busy === 'load' ? 'LOADING…' : E.g.fired ? 'OUT OF ROUNDS · R: LOAD' : 'NOT LOADED · R: LOAD'}  /  ${E.g.reserve}`, E.g.loaded || E.g.busy ? '#ffffff' : '#F2C94C'],
      [E.g.safety ? 'SAFE' : 'FIRE', E.g.safety ? '#9fe0a8' : '#FF5C61'],
    ];
    if (E.g.stoppage) lines.push(['STOPPAGE  ·  C to clear', '#FF5C61']);
    if (E.held) lines.push(['HOLD FIRE', '#FF5C61']); else if (E.cleared != null) lines.push([`CLEARED: TARGET ${E.cleared}`, '#9fe0a8']);
    if ((E.cfg.safeArcs ?? []).some(([a, b]) => { const x = ((E.g.az % 360) + 360) % 360; return a <= b ? x >= a && x <= b : x >= a || x <= b; })) lines.push(['SAFE ARC: DO NOT FIRE', '#FF5C61']);
    lines.forEach(([s, col], i) => { c.fillStyle = 'rgba(0,0,0,0.45)'; const tw = c.measureText(s).width; c.fillRect(w - tw - 26 * dp, h - (36 + i * 24) * dp, tw + 14 * dp, 21 * dp); c.fillStyle = col; c.fillText(s, w - tw - 19 * dp, h - (20 + i * 24) * dp); });
    const heat = Math.min(1, E.g.heat / gunDef.heatLimit); c.fillStyle = 'rgba(0,0,0,0.45)'; c.fillRect(w - 146 * dp, h - (40 + lines.length * 24) * dp, 120 * dp, 8 * dp);
    c.fillStyle = heat > 0.9 ? '#FF5C61' : heat > 0.6 ? '#F2C94C' : '#9fe0a8'; c.fillRect(w - 146 * dp, h - (40 + lines.length * 24) * dp, 120 * dp * heat, 8 * dp);
  }

  let lastFrameMs = 0;
  const frame: FieldView['frame'] = (E, sol, frac, marks) => {
    const now = performance.now();
    if (E.tick !== lastTick) { prevAz = curAz; prevEl = curEl; lastTick = E.tick; }
    const k = Math.max(0, Math.min(1, frac));
    const t = Math.max(0, (E.tick - 1 + k) * E.dt);
    curAz = (prevAz + angDiff(E.g.az, prevAz) * k + 360) % 360; curEl = prevEl + (E.g.el - prevEl) * k;
    lastE = E; lastT = t;
    // When the fire-control system lays the gun itself, the aim follows the gun.
    if (fcsLocked(E)) { aim.az = curAz; aim.el = curEl; }
    yaw.quaternion.copy(yaw0).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -curAz * D2R));
    pitch.quaternion.copy(pitch0).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), curEl * D2R));
    if (radarN && radarSight) radarN.rotation.y = Math.sin(now * 0.0025) * 0.9;
    syncTargets(E, t, now); syncFire(E, t);
    if (precip) { precip.position.set(camera.position.x, camera.position.y - 8 - ((now / (wx === 'rain' ? 35 : 500)) % 10), camera.position.z); }
    placeCamera(E, sol, t);
    // Specks a constant ~4 px whatever the zoom (sprites without size attenuation scale with the view's height).
    const sk = (2 * Math.tan((camera.fov * D2R) / 2) * 5) / Math.max(1, host.clientHeight);
    for (const v of vis.values()) v.speck.scale.setScalar(sk);
    snd?.update(E, t, mode === 'gun' ? aim.az : curAz, mode === 'gun' ? aim.el : curEl);
    sun.target.position.set(camera.position.x, 0, camera.position.z); sun.position.copy(sunDir).multiplyScalar(80).add(sun.target.position);
    if (thermalOn) {
      renderer.setRenderTarget(rt); renderer.render(scene, camera); renderer.setRenderTarget(null);
      tiMat.uniforms.time.value = now / 1000; tiMat.uniforms.black.value = blackHot ? 1 : 0;
      renderer.render(tiScene, tiCam);
    } else renderer.render(scene, camera);
    drawHud(E, sol, t, marks);
    lastFrameMs = performance.now() - now;
  };
  void barrels;
  return {
    frame,
    setMode: (m) => { mode = m; ads = binos = false; if (m === 'ext' && document.pointerLockElement === cv) document.exitPointerLock(); tip.style.display = m === 'gun' && !locked ? '' : 'none'; },
    mode: () => mode,
    zoom: () => { if (mode === 'gun' && ads && thermalSight) tiNarrow = !tiNarrow; else if (mode === 'gun' && !ads) binos = !binos; },
    polarity: () => { blackHot = !blackHot; },
    info: () => ({ calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, ms: lastFrameMs }),
    rates: (E, sol) => {
      if (mode !== 'gun' || !locked || fcsLocked(E)) return null;
      // Barrel = aim + lead on a manual sight (the sight looks behind the barrel by the lead angle).
      let dAz = 0, dEl = 0;
      if (sol?.ok && gunDef.sight === 'manual') {
        const T = E.targets.find((x) => x.state === 'live' && Math.hypot(angDiff(losOf(targetPos(x, E.tick * E.dt, E.dt)).az, E.g.az), losOf(targetPos(x, E.tick * E.dt, E.dt)).el - E.g.el) < gunDef.sightFovDeg / 2);
        if (T) { const l = losOf(targetPos(T, E.tick * E.dt, E.dt)); dAz = angDiff(sol.az, l.az); dEl = sol.el - l.el; }
      }
      const rz = angDiff(aim.az + dAz, E.g.az) / (gunDef.slewDegS.az * E.dt), re = (aim.el + dEl - E.g.el) / (gunDef.slewDegS.el * E.dt);
      const q = (v: number) => Math.round(Math.max(-1, Math.min(1, v)) * 50) / 50;
      return [q(rz), q(re)];
    },
    centreTarget: () => centre(),
    look: (az, el, b = false, sight = false) => { aim.az = az; aim.el = el; binos = b; ads = sight; mode = 'gun'; },
    dispose: () => {
      document.removeEventListener('pointerlockchange', onLock);
      if (document.pointerLockElement === cv) document.exitPointerLock();
      snd?.dispose(); ro.disconnect(); rt.dispose(); tiMat.dispose(); renderer.dispose(); renderer.forceContextLoss(); pmrem.dispose();
      cv.remove(); hud.remove(); tip.remove();
    },
  };
}
/** True when the browser can draw WebGL (otherwise the field drill falls back to the 2D On Ground sight). */
export function hasWebGL(): boolean {
  try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch { return false; }
}
