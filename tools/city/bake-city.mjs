// Bake a medium-size snippet of the "Al Zahran" city from the PROJECT REALISM generator into a compact package for the
// urban drive drill (apps/web/public/city/). The generator is pure data (no three.js) and deterministic from its seed,
// so the same snippet comes out every time.
//   node tools/city/bake-city.mjs <path to Project-Reality> [x0 z0 x1 z1]      (default area −200 −200 200 200)
// Writes:
//   city.json   meta, roads, props, landmarks, and the engine's world (building boxes, walls, posts, road nodes, lanes)
//   city.bin    quantised static geometry (exterior faces), terrain mask (2 m) and heights (4 m)
//   tex/<id>/{diff,nor,arm}.jpg   the wall and ground textures used, resized (512 px, arm 256 px)
//   props.glb   the props kit cut down to the props used in the snippet;  vehicles/<id>.glb   parked cars and wrecks
// Coordinates in the package are three.js (x east, y up, z south). The engine frame is x east, y north: y = −z.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PR = path.resolve(process.argv[2] ?? '../Project-Reality');
const [ax0, az0, ax1, az1] = (process.argv.length >= 7 ? process.argv.slice(3, 7) : ['-200', '-200', '200', '200']).map(Number);
const OUT = path.resolve('apps/web/public/city');
const TMP = path.resolve('tools/city/.build');
fs.mkdirSync(TMP, { recursive: true }); fs.mkdirSync(OUT, { recursive: true });
const req = createRequire(path.join(PR, 'package.json'));

// ---------- run the generator ----------
const entry = path.join(TMP, 'entry.ts');
const src = path.join(PR, 'src/world').replace(/\\/g, '/');
fs.writeFileSync(entry, `export { generateCity, MASK_HALF, MASK_N, MASK_RES } from '${src}/citygen';
export { MATS, MAT_INDEX } from '${src}/sink';
export { groundH } from '${src}/terrain';\n`);
const esbuild = path.join(PR, 'node_modules/.bin', process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild');
execFileSync(esbuild, [entry, '--bundle', '--platform=node', '--format=esm', `--outfile=${path.join(TMP, 'citygen.mjs')}`, '--log-level=warning'], { stdio: 'inherit', shell: process.platform === 'win32' });
const G = await import(pathToFileURL(path.join(TMP, 'citygen.mjs')).href);
const area = { x0: ax0, z0: az0, x1: ax1, z1: az1 };
const city = G.generateCity(1337, { area });
const M = 40; // ground, roads and the mask reach a little past the area
const B = { x0: ax0 - M, z0: az0 - M, x1: ax1 + M, z1: az1 + M };
const inB = (x, z, m = 0) => x >= B.x0 - m && x <= B.x1 + m && z >= B.z0 - m && z <= B.z1 + m;
const matIds = Object.keys(G.MATS);

// ---------- static geometry: exterior faces (layers 0 and 2), welded and quantised ----------
const verts = new Map(); const vpos = [], vnrm = [], vcol = [], idx = [];
let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
const used = new Set();
const tris = [];
for (const b of city.sink.batches.values()) {
  if (b.layer !== 0 && b.layer !== 2) continue;
  for (let v = 0; v < b.n; v++) {
    const p = [b.pos[v * 3], b.pos[v * 3 + 1], b.pos[v * 3 + 2]];
    for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p[k]); mx[k] = Math.max(mx[k], p[k]); }
    tris.push([p, [b.nrm[v * 3], b.nrm[v * 3 + 1], b.nrm[v * 3 + 2]], [b.col[v * 3], b.col[v * 3 + 1], b.col[v * 3 + 2]], b.mi[v]]);
    used.add(matIds[b.mi[v]]);
  }
}
// Interior blockers: a dark box inside each intact building, so windows and doorways show a dark room, not the sky
// (the interiors themselves are not shipped).
const dark = [0.1, 0.095, 0.085], plMi = matIds.indexOf('plastered');
const quad = (p, n) => { for (const i of [0, 1, 2, 0, 2, 3]) tris.push([p[i], n, dark, plMi]); };
let blockers = 0;
for (const bi of city.buildings) {
  const s = bi.spec; if (s.damage > 0.25) continue;
  const t = s.t + 0.06, x0 = s.x0 + t, x1 = s.x1 - t, z0 = s.z0 + t, z1 = s.z1 - t, y0 = s.y0 + 0.02, y1 = bi.roofY - 0.08;
  if (x1 - x0 < 1 || z1 - z0 < 1 || y1 - y0 < 1) continue;
  quad([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0]);
  quad([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [1, 0, 0]);
  quad([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [0, 0, -1]);
  quad([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1]);
  blockers++;
}
used.add('plastered');
const span = mx.map((v, k) => Math.max(1e-3, v - mn[k]));
for (const [p, n, c, mi] of tris) {
  const q = p.map((v, k) => Math.round(((v - mn[k]) / span[k]) * 65535));
  const nn = n.map((v) => Math.round(v * 127)), cc = c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255));
  const key = `${q}|${nn}|${cc}|${mi}`;
  let i = verts.get(key);
  if (i == null) { i = vpos.length / 4; verts.set(key, i); vpos.push(q[0], q[1], q[2], 0); vnrm.push(nn[0], nn[1], nn[2], 0); vcol.push(cc[0], cc[1], cc[2], mi); }
  idx.push(i);
}

// ---------- terrain mask (2 m) and heights (4 m) over B ----------
const MR = 2, mw = Math.round((B.x1 - B.x0) / MR), mh = Math.round((B.z1 - B.z0) / MR), mask = new Uint8Array(mw * mh * 4);
for (let j = 0; j < mh; j++) for (let i = 0; i < mw; i++) {
  const x = B.x0 + (i + 0.5) * MR, z = B.z0 + (j + 0.5) * MR;
  const ii = Math.max(0, Math.min(G.MASK_N - 1, Math.floor((x + G.MASK_HALF) / G.MASK_RES))), jj = Math.max(0, Math.min(G.MASK_N - 1, Math.floor((z + G.MASK_HALF) / G.MASK_RES)));
  for (let k = 0; k < 4; k++) mask[(j * mw + i) * 4 + k] = city.mask[(jj * G.MASK_N + ii) * 4 + k];
}
const HR = 4, hw = Math.round((B.x1 - B.x0) / HR) + 1, hh = Math.round((B.z1 - B.z0) / HR) + 1, hgt = new Int16Array(hw * hh);
for (let j = 0; j < hh; j++) for (let i = 0; i < hw; i++) hgt[j * hw + i] = Math.round(G.groundH(B.x0 + i * HR, B.z0 + j * HR) * 100);

// ---------- binary ----------
const parts = [new Uint16Array(vpos), new Int8Array(vnrm), new Uint8Array(vcol), new Uint32Array(idx), mask, hgt];
const offs = []; let off = 0;
for (const a of parts) { off = Math.ceil(off / 4) * 4; offs.push(off); off += a.byteLength; }
const bin = Buffer.alloc(off);
parts.forEach((a, i) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).copy(bin, offs[i]));
fs.writeFileSync(path.join(OUT, 'city.bin'), bin);

// ---------- props ----------
const INTERIOR = /^(floor_cushions|sofa_old|armchair|rug_|coffee_table|tv_crt|side_table|curtain_|bed_double|mattress_|wardrobe|dresser|clothes_pile|prayer_mat|kitchen_|fridge_old|gas_stove|table_dining|water_cooler|cardboard_boxes|plastic_crates|shoes_rack|wall_shelf|ceiling_fan|bulb_hanging|picture_frame|broken_furniture|sandbag_window|bedsheet_window)/;
const props = city.props.filter((p) => !INTERIOR.test(p.id) && inB(p.x, p.z) && !/^grass/.test(p.id))
  .map((p) => [p.id, +p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2), +p.ry.toFixed(3), +(p.s ?? 1).toFixed(2), p.solid ? 1 : 0]);
const propIds = [...new Set(props.map((p) => p[0]))];
const vehIds = propIds.filter((id) => id.startsWith('veh:')).map((id) => id.slice(4));

// ---------- engine world (engine frame: x east, y north) ----------
const r1 = (v) => Math.round(v * 10) / 10;
const boxes = city.buildings.map((bi) => { const s = bi.spec; return [r1(s.x0), r1(-s.z1), r1(s.x1), r1(-s.z0), r1(bi.roofY + (s.parapet ?? 0) - s.y0)]; });
// Free-standing walls, fences and barriers that reach the vehicle's height (axis-aligned colliders, not building parts).
const walls = [];
for (const c of city.sink.colliders) {
  if (c.tag !== -1 || c.q) continue;
  const bot = c.c[1] - c.h[1], top = c.c[1] + c.h[1];
  if (bot > 1.2 || top < 0.7 || !inB(c.c[0], c.c[2]) || Math.max(c.h[0], c.h[2]) < 0.4) continue;
  walls.push([r1(c.c[0] - c.h[0]), r1(-(c.c[2] + c.h[2])), r1(c.c[0] + c.h[0]), r1(-(c.c[2] - c.h[2])), r1(top)]);
}
const PROP_R = [[/^veh:/, 2.4], [/^sandbag_bunker|^guard_tower/, 1.8], [/^market_stall|^jersey|^hesco/, 1.2], [/^cart_|^trash_|^tyres|^oil_drum|^generator/, 0.7], [/^street_light|^power_pole|^palm|^dead_tree|^antenna/, 0.3]];
const posts = props.filter((p) => p[6]).map((p) => [r1(p[1]), r1(-p[3]), (PROP_R.find(([re]) => re.test(p[0]))?.[1] ?? 0.5)]);
// Drivable road centre lines (the engine picks the patrol checkpoints and the civilian traffic lanes from them).
const roads = city.roads.filter((r) => ['boulevard', 'avenue', 'street', 'lane', 'market'].includes(r.kind) && r.x1 > B.x0 && r.x0 < B.x1 && r.z1 > B.z0 && r.z0 < B.z1)
  .map((r) => ({ kind: r.kind, x0: r1(Math.max(r.x0, B.x0)), z0: r1(Math.max(r.z0, B.z0)), x1: r1(Math.min(r.x1, B.x1)), z1: r1(Math.min(r.z1, B.z1)) }));
const lanes = [];
for (const r of roads) {
  if (r.kind === 'lane' || r.kind === 'market') continue;
  const w = r.x1 - r.x0, d = r.z1 - r.z0, ins = (x, z) => x >= ax0 + 10 && x <= ax1 - 10 && z >= az0 + 10 && z <= az1 - 10;
  // Engine frame segments [x0, y0, x1, y1, width], clipped to the area.
  if (w >= d) { const z = (r.z0 + r.z1) / 2, a = Math.max(r.x0, ax0 + 10), b = Math.min(r.x1, ax1 - 10); if (b - a > 40 && ins(a, z)) lanes.push([r1(a), r1(-z), r1(b), r1(-z), r1(d)]); }
  else { const x = (r.x0 + r.x1) / 2, a = Math.max(r.z0, az0 + 10), b = Math.min(r.z1, az1 - 10); if (b - a > 40 && ins(x, a)) lanes.push([r1(x), r1(-a), r1(x), r1(-b), r1(w)]); }
}
// Every drivable road's centre line inside the area (engine frame [x0, y0, x1, y1, width]): the patrol route network.
const net = [];
for (const r of roads) {
  const w = r.x1 - r.x0, d = r.z1 - r.z0, lo = (v, a) => Math.max(v, a + 8), hi = (v, a) => Math.min(v, a - 8);
  if (Math.min(w, d) < 6) continue;
  if (w >= d) { const z = (r.z0 + r.z1) / 2, a = lo(r.x0, ax0), b = hi(r.x1, ax1); if (b - a > 20 && z > az0 + 8 && z < az1 - 8) net.push([r1(a), r1(-z), r1(b), r1(-z), r1(d)]); }
  else { const x = (r.x0 + r.x1) / 2, a = lo(r.z0, az0), b = hi(r.z1, az1); if (b - a > 20 && x > ax0 + 8 && x < ax1 - 8) net.push([r1(x), r1(-a), r1(x), r1(-b), r1(w)]); }
}
const landmarks = city.landmarks.filter((l) => l.x >= ax0 && l.x <= ax1 && l.z >= az0 && l.z <= az1).map((l) => ({ name: l.name, x: r1(l.x), y: r1(-l.z) }));

const meta = {
  version: 1, source: 'PROJECT REALISM city generator (Al Zahran), seed 1337, cropped', area, bounds: B,
  geo: { verts: vpos.length / 4, indices: idx.length, min: mn, span, offs, mats: matIds.map((id) => ({ id, tex: G.MATS[id].tex, uv: G.MATS[id].uv })) },
  mask: { res: MR, w: mw, h: mh }, height: { res: HR, w: hw, h: hh },
  roads, props, propIds, vehicles: vehIds, landmarks,
  world: { half: Math.max(ax1 - ax0, az1 - az0) / 2, centre: [(ax0 + ax1) / 2, -(az0 + az1) / 2], boxes, walls, posts, lanes, roads: net, landmarks },
};
fs.writeFileSync(path.join(OUT, 'city.json'), JSON.stringify(meta));

// ---------- textures ----------
const sharp = req('sharp');
const texIds = [...new Set([...used].map((id) => G.MATS[id].tex)), 'dry_ground_01', 'dirt', 'gravelly_sand', 'dry_mud_field_001', 'asphalt_02', 'concrete_pavement'];
for (const id of texIds) {
  fs.mkdirSync(path.join(OUT, 'tex', id), { recursive: true });
  for (const [k, size] of [['diff', 512], ['nor', 512], ['arm', 256]]) {
    const f = path.join(PR, 'public/assets/tex', id, `${k}.jpg`);
    if (fs.existsSync(f)) await sharp(f).resize(size, size).jpeg({ quality: k === 'diff' ? 84 : 80 }).toFile(path.join(OUT, 'tex', id, `${k}.jpg`));
  }
}

// ---------- props kit subset and vehicles ----------
const { NodeIO } = await import(pathToFileURL(req.resolve('@gltf-transform/core')).href);
const { prune, dedup } = await import(pathToFileURL(req.resolve('@gltf-transform/functions')).href);
const io = new NodeIO();
const doc = await io.read(path.join(PR, 'public/models/props.glb'));
const keep = new Set(propIds);
for (const scene of doc.getRoot().listScenes()) for (const n of scene.listChildren()) if (!keep.has(n.getName())) n.dispose();
await doc.transform(dedup(), prune());
await io.write(path.join(OUT, 'props.glb'), doc);
fs.mkdirSync(path.join(OUT, 'vehicles'), { recursive: true });
for (const v of vehIds) fs.copyFileSync(path.join(PR, 'public/models/vehicles', `${v}.glb`), path.join(OUT, 'vehicles', `${v}.glb`));
// Credits travel with the package.
const credits = ['public/assets/CREDITS.txt', 'public/models/CREDITS.txt'].map((f) => path.join(PR, f)).filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
fs.writeFileSync(path.join(OUT, 'CREDITS.txt'), `City snippet baked from PROJECT REALISM (same authors), generator seed 1337, area ${JSON.stringify(area)}.\nTextures and props are CC0 (Poly Haven, ambientCG, Quaternius) as listed below.\n\n${credits}`);

console.log(`city: ${meta.geo.verts} verts, ${idx.length / 3} tris (${blockers} interior blockers), ${props.length} props of ${propIds.length} kinds, ${vehIds.length} vehicle models`);
console.log(`world: ${boxes.length} buildings, ${walls.length} walls, ${posts.length} posts, ${lanes.length} lanes, ${net.length} road lines, landmarks ${landmarks.map((l) => l.name).join(', ')}`);
console.log(`bin ${(bin.length / 1e6).toFixed(2)} MB, mats used: ${[...used].join(' ')}`);
