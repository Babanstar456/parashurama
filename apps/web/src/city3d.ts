// The urban drive drill's town: a medium-size snippet of the PROJECT REALISM city "Al Zahran" (baked by
// tools/city/bake-city.mjs into public/city/). Static buildings draw with one texture-array material (every wall and
// roof texture is a layer, each vertex carries its layer), the ground is splatted from the generator's mask, props and
// parked cars are instanced, and a ring of plain blocks beyond the snippet fills the skyline.
// Coordinates: three.js (x east, y up, z south); the engine's frame is x east, y north (y = −z).
import * as THREE from 'three';
import type { PatrolWorld } from '@parashurama/engine';
import { gltf } from './field3d';

const BASE = import.meta.env.BASE_URL;
export interface CityMeta {
  area: { x0: number; z0: number; x1: number; z1: number }; bounds: { x0: number; z0: number; x1: number; z1: number };
  geo: { verts: number; indices: number; min: number[]; span: number[]; offs: number[]; mats: { id: string; tex: string; uv: number }[] };
  mask: { res: number; w: number; h: number }; height: { res: number; w: number; h: number };
  roads: { kind: string; x0: number; z0: number; x1: number; z1: number }[];
  props: [string, number, number, number, number, number, number][]; propIds: string[]; vehicles: string[];
  landmarks: { name: string; x: number; y: number }[]; world: PatrolWorld;
}
export interface City { meta: CityMeta; root: THREE.Group; heightAt: (x: number, z: number) => number; dispose: () => void; }

let metaP: Promise<{ meta: CityMeta; bin: ArrayBuffer } | null> | null = null;
/** The city package (cached): null when it is missing (offline single-file copy). */
export function loadCityData(): Promise<{ meta: CityMeta; bin: ArrayBuffer } | null> {
  if (location.protocol === 'file:') return Promise.resolve(null);
  metaP ??= Promise.all([fetch(`${BASE}city/city.json`).then((r) => (r.ok ? r.json() : null)), fetch(`${BASE}city/city.bin`).then((r) => (r.ok ? r.arrayBuffer() : null))])
    .then(([meta, bin]) => (meta && bin ? { meta, bin } : null)).catch(() => null);
  return metaP;
}

async function pixels(url: string, size: number): Promise<Uint8ClampedArray | null> {
  try {
    const r = await fetch(url); if (!r.ok) return null;
    const bmp = await createImageBitmap(await r.blob());
    const c = document.createElement('canvas'); c.width = c.height = size;
    const x = c.getContext('2d', { willReadFrequently: true })!; x.drawImage(bmp, 0, 0, size, size); bmp.close?.();
    return x.getImageData(0, 0, size, size).data;
  } catch { return null; }
}
async function arrayTex(texIds: string[], kind: 'diff' | 'nor' | 'arm', size: number, fb: [number, number, number]): Promise<THREE.DataArrayTexture> {
  const n = texIds.length, data = new Uint8Array(size * size * 4 * n);
  const px = await Promise.all(texIds.map((id) => pixels(`${BASE}city/tex/${id}/${kind}.jpg`, size)));
  px.forEach((p, i) => { if (p) data.set(p, i * size * size * 4); else for (let k = 0; k < size * size; k++) data.set([...fb, 255], (i * size * size + k) * 4); });
  const t = new THREE.DataArrayTexture(data, size, size, n);
  t.format = THREE.RGBAFormat; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true; t.anisotropy = 4; if (kind === 'diff') t.colorSpace = THREE.SRGBColorSpace; t.needsUpdate = true;
  return t;
}
/** One material for every static city surface (port of PROJECT REALISM's citymat.ts): texture arrays, anti-tiling. */
function cityMaterial(diff: THREE.DataArrayTexture, nor: THREE.DataArrayTexture, arm: THREE.DataArrayTexture): THREE.MeshStandardMaterial {
  const dummy = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); dummy.needsUpdate = true;
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, map: dummy, normalMap: dummy, roughnessMap: dummy });
  m.normalScale.set(0.9, 0.9);
  m.onBeforeCompile = (sh) => {
    sh.uniforms.tDiff = { value: diff }; sh.uniforms.tNor = { value: nor }; sh.uniforms.tArm = { value: arm };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float mi;\nflat varying float vMi;\nvarying vec3 vCityW;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvMi = mi;\nvCityW = position;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
flat varying float vMi; varying vec3 vCityW;
uniform highp sampler2DArray tDiff, tNor, tArm;
float cHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float cNoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(cHash(i), cHash(i + vec2(1, 0)), f.x), mix(cHash(i + vec2(0, 1)), cHash(i + vec2(1, 1)), f.x), f.y); }`)
      .replace('#include <map_fragment>', `{
  vec2 uv2 = mat2(0.8, -0.6, 0.6, 0.8) * vMapUv * 0.61 + vec2(0.37, 0.71);
  float b = smoothstep(0.35, 0.65, cNoise(vCityW.xz * 0.11 + vCityW.y * vec2(0.07, -0.05)));
  vec4 tc = mix(texture(tDiff, vec3(vMapUv, vMi)), texture(tDiff, vec3(uv2, vMi)), b * 0.55);
  float macro = mix(0.9, 1.07, cNoise(vCityW.xz * 0.045 + vec2(vCityW.y * 0.03, 3.1)));
  diffuseColor *= vec4(tc.rgb * macro, 1.0);
}`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = roughness * texture(tArm, vec3(vRoughnessMapUv, vMi)).g;')
      .replace('vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;', 'vec3 mapN = texture(tNor, vec3(vNormalMapUv, vMi)).xyz * 2.0 - 1.0;');
  };
  m.customProgramCacheKey = () => 'city-array';
  return m;
}
const loader = new THREE.TextureLoader();
function ctex(id: string, kind: string, srgb = true): THREE.Texture {
  const t = loader.load(`${BASE}city/tex/${id}/${kind}.jpg`, undefined, undefined, () => undefined);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4; if (srgb) t.colorSpace = THREE.SRGBColorSpace; return t;
}

export async function buildCity(scene: THREE.Scene, lite: boolean, shadows: boolean): Promise<City | null> {
  const data = await loadCityData(); if (!data) return null;
  const { meta: M, bin } = data, G = M.geo, root = new THREE.Group(); root.name = 'city'; scene.add(root);
  const disposables: { dispose: () => void }[] = [];
  // ---------- static buildings: decode, compute the planar UVs exactly as the generator does, split into 100 m chunks ----------
  const nV = G.verts, q = new Uint16Array(bin, G.offs[0], nV * 4), nn = new Int8Array(bin, G.offs[1], nV * 4), cc = new Uint8Array(bin, G.offs[2], nV * 4), ix = new Uint32Array(bin, G.offs[3], G.indices);
  const pos = new Float32Array(nV * 3), nrm = new Float32Array(nV * 3), uv = new Float32Array(nV * 2), col = new Float32Array(nV * 3), mi = new Float32Array(nV);
  for (let v = 0; v < nV; v++) {
    const x = G.min[0] + (q[v * 4] / 65535) * G.span[0], y = G.min[1] + (q[v * 4 + 1] / 65535) * G.span[1], z = G.min[2] + (q[v * 4 + 2] / 65535) * G.span[2];
    const nx = nn[v * 4] / 127, ny = nn[v * 4 + 1] / 127, nz = nn[v * 4 + 2] / 127, m = cc[v * 4 + 3], s = 1 / (G.mats[m]?.uv ?? 2.5);
    pos.set([x, y, z], v * 3); nrm.set([nx, ny, nz], v * 3); col.set([cc[v * 4] / 255, cc[v * 4 + 1] / 255, cc[v * 4 + 2] / 255], v * 3); mi[v] = m;
    if (Math.abs(ny) > 0.7) uv.set([x * s, -z * s], v * 2);
    else if (Math.abs(nx) > 0.7) uv.set([(nx > 0 ? -z : z) * s, y * s], v * 2);
    else uv.set([(nz > 0 ? x : -x) * s, y * s], v * 2);
  }
  const attrs = { position: new THREE.BufferAttribute(pos, 3), normal: new THREE.BufferAttribute(nrm, 3), uv: new THREE.BufferAttribute(uv, 2), color: new THREE.BufferAttribute(col, 3), mi: new THREE.BufferAttribute(mi, 1) };
  const texIds = G.mats.map((m) => m.tex), size = lite ? 256 : 512;
  const [diff, nor, arm] = await Promise.all([arrayTex(texIds, 'diff', size, [180, 170, 150]), arrayTex(texIds, 'nor', size, [128, 128, 255]), arrayTex(texIds, 'arm', 256, [255, 230, 0])]);
  const mat = cityMaterial(diff, nor, arm); disposables.push(diff, nor, arm, mat);
  const CH = 100, chunks = new Map<string, number[]>();
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3, cx = (pos[a] + pos[ix[t + 1] * 3] + pos[ix[t + 2] * 3]) / 3, cz = (pos[a + 2] + pos[ix[t + 1] * 3 + 2] + pos[ix[t + 2] * 3 + 2]) / 3;
    const k = `${Math.floor(cx / CH)},${Math.floor(cz / CH)}`;
    (chunks.get(k) ?? chunks.set(k, []).get(k)!).push(ix[t], ix[t + 1], ix[t + 2]);
  }
  for (const list of chunks.values()) {
    const g = new THREE.BufferGeometry();
    for (const [k, a] of Object.entries(attrs)) g.setAttribute(k, a);
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(list), 1)); g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, mat); mesh.castShadow = shadows; mesh.receiveShadow = true; mesh.matrixAutoUpdate = false; root.add(mesh); disposables.push(g);
  }
  // ---------- ground: heights (4 m) and the mask splat (2 m): base dry ground, R dirt tracks, G gravel/rubble, B fields, A damp ----------
  const B = M.bounds, H = M.height, hgt = new Int16Array(bin, G.offs[5], H.w * H.h);
  const heightAt = (x: number, z: number) => {
    const fx = clamp((x - B.x0) / H.res, 0, H.w - 1.001), fz = clamp((z - B.z0) / H.res, 0, H.h - 1.001), i = Math.floor(fx), j = Math.floor(fz), u = fx - i, w = fz - j;
    const h = (a: number, b: number) => hgt[b * H.w + a] / 100;
    return (h(i, j) * (1 - u) + h(i + 1, j) * u) * (1 - w) + (h(i, j + 1) * (1 - u) + h(i + 1, j + 1) * u) * w;
  };
  {
    const gg = new THREE.PlaneGeometry(B.x1 - B.x0, B.z1 - B.z0, H.w - 1, H.h - 1); gg.rotateX(-Math.PI / 2); gg.translate((B.x0 + B.x1) / 2, 0, (B.z0 + B.z1) / 2);
    const p = gg.attributes.position as THREE.BufferAttribute; for (let i = 0; i < p.count; i++) p.setY(i, heightAt(p.getX(i), p.getZ(i)) - 0.02); gg.computeVertexNormals();
    const mk = new THREE.DataTexture(new Uint8Array(bin, G.offs[4], M.mask.w * M.mask.h * 4).slice(), M.mask.w, M.mask.h, THREE.RGBAFormat);
    mk.magFilter = mk.minFilter = THREE.LinearFilter; mk.needsUpdate = true;
    const m = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, map: ctex('dry_ground_01', 'diff'), normalMap: ctex('dry_ground_01', 'nor', false) });
    const tD = ctex('dirt', 'diff'), tG = ctex('gravelly_sand', 'diff'), tF = ctex('dry_mud_field_001', 'diff');
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, { uMask: { value: mk }, uDirt: { value: tD }, uGravel: { value: tG }, uField: { value: tF }, uB: { value: new THREE.Vector4(B.x0, B.z0, B.x1 - B.x0, B.z1 - B.z0) } });
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWPos;').replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
varying vec3 vWPos; uniform sampler2D uMask, uDirt, uGravel, uField; uniform vec4 uB;
float hh(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(hh(i), hh(i+vec2(1,0)), f.x), mix(hh(i+vec2(0,1)), hh(i+vec2(1,1)), f.x), f.y); }`)
        .replace('#include <map_fragment>', `
vec2 wuv = vWPos.xz; vec4 mk = texture2D(uMask, (wuv - uB.xy) / uB.zw);
float n1 = vn(wuv * 0.035), n2 = vn(wuv * 0.21);
vec3 col = mix(texture2D(map, wuv / 7.0).rgb, texture2D(map, wuv / 23.0 + 0.37).rgb, 0.45) * mix(0.86, 1.08, n1);
col = mix(col, texture2D(uDirt, wuv / 4.0).rgb * vec3(1.02, 0.97, 0.9), smoothstep(0.15, 0.75, mk.r + (n2 - 0.5) * 0.35));
col = mix(col, texture2D(uGravel, wuv / 3.5).rgb, smoothstep(0.2, 0.8, mk.g + (n2 - 0.5) * 0.3));
col = mix(col, texture2D(uField, wuv / 6.0).rgb * vec3(0.95, 0.95, 0.85), smoothstep(0.2, 0.8, mk.b + (n1 - 0.5) * 0.4));
col *= mix(1.0, 0.72, mk.a);
diffuseColor.rgb *= col;`)
        .replace('vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;', 'vec3 mapN = texture2D( normalMap, vWPos.xz / 7.0 ).xyz * 2.0 - 1.0;');
    };
    m.customProgramCacheKey = () => 'city-ground';
    const ground = new THREE.Mesh(gg, m); ground.receiveShadow = true; root.add(ground); disposables.push(gg, m, mk);
    // Beyond the snippet: open ground to the horizon (a little lower, so it never shows through the town).
    const far = new THREE.Mesh(new THREE.RingGeometry(Math.hypot(B.x1 - B.x0, B.z1 - B.z0) * 0.45, 7000, 64, 4).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xa08d70, roughness: 1, map: ctex('dry_ground_01', 'diff') }));
    (far.material as THREE.MeshStandardMaterial).map!.repeat.set(400, 400); far.position.set((B.x0 + B.x1) / 2, -0.15, (B.z0 + B.z1) / 2); far.receiveShadow = true; root.add(far);
    const under = new THREE.Mesh(new THREE.PlaneGeometry(B.x1 - B.x0 + 60, B.z1 - B.z0 + 60).rotateX(-Math.PI / 2), (far.material as THREE.Material)); under.position.set((B.x0 + B.x1) / 2, -0.4, (B.z0 + B.z1) / 2); root.add(under);
  }
  // ---------- roads: asphalt on the boulevard, avenue and streets (the lanes and alleys are packed earth in the mask) ----------
  {
    const P: number[] = [], U: number[] = [], s = 1 / 6, lift = 0.06, step = 8;
    for (const r of M.roads) {
      if (!['boulevard', 'avenue', 'street'].includes(r.kind)) continue;
      const nx = Math.max(1, Math.ceil((r.x1 - r.x0) / step)), nz = Math.max(1, Math.ceil((r.z1 - r.z0) / step));
      for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
        const ax = r.x0 + (r.x1 - r.x0) * i / nx, bx = r.x0 + (r.x1 - r.x0) * (i + 1) / nx, az = r.z0 + (r.z1 - r.z0) * j / nz, bz = r.z0 + (r.z1 - r.z0) * (j + 1) / nz;
        for (const [x, z] of [[ax, az], [ax, bz], [bx, bz], [ax, az], [bx, bz], [bx, az]]) { P.push(x, heightAt(x, z) + lift, z); U.push(x * s, -z * s); }
      }
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2)); g.computeVertexNormals();
    const m = new THREE.MeshStandardMaterial({ color: 0xd8d2c8, roughness: 0.95, map: ctex('asphalt_02', 'diff'), normalMap: ctex('asphalt_02', 'nor', false), roughnessMap: ctex('asphalt_02', 'arm', false), polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const mesh = new THREE.Mesh(g, m); mesh.receiveShadow = true; root.add(mesh); disposables.push(g, m);
    // Dashed lane markings either side of the boulevard's central reservation.
    const bl = M.roads.find((r) => r.kind === 'boulevard');
    if (bl) {
      const zc = (bl.z0 + bl.z1) / 2, mk: number[] = [];
      for (const dz of [-6.5, 6.5]) for (let x = bl.x0; x < bl.x1 - 4; x += 9) { const y = heightAt(x, zc + dz) + lift + 0.01, z = zc + dz; mk.push(x, y, z - 0.07, x, y, z + 0.07, x + 4, y, z + 0.07, x, y, z - 0.07, x + 4, y, z + 0.07, x + 4, y, z - 0.07); }
      const gm = new THREE.BufferGeometry(); gm.setAttribute('position', new THREE.Float32BufferAttribute(mk, 3)); gm.computeVertexNormals();
      root.add(new THREE.Mesh(gm, new THREE.MeshStandardMaterial({ color: 0xbdb7a8, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 })));
    }
  }
  // ---------- props and parked vehicles (instanced) ----------
  const kit = await gltf('city/props.glb');
  const vehs = new Map<string, THREE.Group | null>();
  await Promise.all(M.vehicles.map(async (v) => vehs.set(v, await gltf(`city/vehicles/${v}.glb`))));
  const byId = new Map<string, CityMeta['props']>();
  for (const p of M.props) (byId.get(p[0]) ?? byId.set(p[0], []).get(p[0])!).push(p);
  const m4 = new THREE.Matrix4(), qq = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), sc = new THREE.Vector3(), tr = new THREE.Vector3();
  for (const [id, list] of byId) {
    const src = id.startsWith('veh:') ? vehs.get(id.slice(4)) : kit?.getObjectByName(id);
    if (!src) continue;
    src.updateMatrixWorld(true);
    const inv = src.matrixWorld.clone().invert();
    src.traverse((o) => {
      const mesh = o as THREE.Mesh; if (!mesh.isMesh) return;
      const local = inv.clone().multiply(mesh.matrixWorld), im = new THREE.InstancedMesh(mesh.geometry, mesh.material, list.length);
      list.forEach((p, i) => { qq.setFromAxisAngle(up, p[4]); sc.setScalar(p[5]); tr.set(p[1], p[2], p[3]); im.setMatrixAt(i, m4.compose(tr, qq, sc).multiply(local)); });
      im.instanceMatrix.needsUpdate = true; im.computeBoundingSphere(); im.castShadow = shadows && !/^(grass|weeds|litter)/.test(id); im.receiveShadow = true; root.add(im);
    });
  }
  // ---------- skyline: plain blocks beyond the snippet (same wall and roof textures), so the town does not end at a cliff ----------
  {
    const A = M.area, cx = (A.x0 + A.x1) / 2, cz = (A.z0 + A.z1) / 2, half = Math.max(A.x1 - A.x0, A.z1 - A.z0) / 2 + 70;
    let sd = 99173; const r = () => ((sd = (sd * 16807) % 2147483647) / 2147483647);
    const ids = G.mats.map((m) => m.id), wallMi = ['plaster_a', 'plaster_b', 'clay', 'plastered', 'sandstone', 'concrete', 'block'].map((k) => ids.indexOf(k)).filter((i) => i >= 0), roofMi = Math.max(0, ids.indexOf('roof'));
    const P: number[] = [], N: number[] = [], UV: number[] = [], C: number[] = [], MI: number[] = [];
    const face = (pts: number[][], n: number[], m: number, k: number) => {
      const s2 = 1 / (G.mats[m]?.uv ?? 2.5);
      for (const i of [0, 1, 2, 0, 2, 3]) {
        const [x, y, z] = pts[i]; P.push(x, y, z); N.push(n[0], n[1], n[2]); C.push(k, k * 0.97, k * 0.92); MI.push(m);
        if (n[1] > 0.7) UV.push(x * s2, -z * s2); else if (Math.abs(n[0]) > 0.7) UV.push((n[0] > 0 ? -z : z) * s2, y * s2); else UV.push((n[2] > 0 ? x : -x) * s2, y * s2);
      }
    };
    for (let i = 0; i < (lite ? 600 : 1400); i++) {
      const x = cx + (r() - 0.5) * 2600, z = cz + (r() - 0.5) * 2600;
      if (Math.max(Math.abs(x - cx), Math.abs(z - cz)) < half || Math.hypot(x - cx, z - cz) > 1350) continue;
      const w = (9 + r() * 14) / 2, d = (9 + r() * 14) / 2, h = 3.1 * (1 + Math.floor(r() * (r() < 0.15 ? 6 : 3))) + 0.6, m = wallMi[Math.floor(r() * wallMi.length)] ?? 0, k = 0.8 + r() * 0.22;
      const x0 = x - w, x1 = x + w, z0 = z - d, z1 = z + d, y0 = -0.3;
      face([[x0, y0, z0], [x0, y0, z1], [x0, h, z1], [x0, h, z0]], [-1, 0, 0], m, k * 0.8);
      face([[x1, y0, z1], [x1, y0, z0], [x1, h, z0], [x1, h, z1]], [1, 0, 0], m, k * 0.8);
      face([[x1, y0, z0], [x0, y0, z0], [x0, h, z0], [x1, h, z0]], [0, 0, -1], m, k);
      face([[x0, y0, z1], [x1, y0, z1], [x1, h, z1], [x0, h, z1]], [0, 0, 1], m, k);
      face([[x0, h, z1], [x1, h, z1], [x1, h, z0], [x0, h, z0]], [0, 1, 0], roofMi, k * 0.95);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3)); g.setAttribute('mi', new THREE.Float32BufferAttribute(MI, 1)); g.computeBoundingSphere();
    const sk = new THREE.Mesh(g, mat); sk.receiveShadow = true; root.add(sk); disposables.push(g);
  }
  return { meta: M, root, heightAt, dispose: () => { scene.remove(root); for (const d of disposables) d.dispose(); } };
}
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
