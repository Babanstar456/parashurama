// Download the 3D field drill's CC0 assets from Poly Haven (polyhaven.com, all CC0: no attribution required) into
// apps/web/public/assets/ (what the app loads) and tools/blender/src-assets/ (scans only the Blender build needs). Re-runnable: files already present are skipped. Usage: node scripts/fetch-assets.mjs
// The drill works without them (it falls back to plain materials), so a unit can also ship a build without assets.
import { mkdir, writeFile, stat, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'web', 'public', 'assets');
const API = 'https://api.polyhaven.com';
/** HDRI skies by drill condition (resolution). */
const HDRIS = {
  day: ['kloofendal_48d_partly_cloudy_puresky', '2k'], overcast: ['kloofendal_overcast_puresky', '2k'],
  fog: ['kloofendal_misty_morning_puresky', '1k'], dust: ['mud_road_puresky', '1k'], night: ['kloppenheim_02_puresky', '2k'],
};
/** PBR textures the app loads (1k): diffuse, OpenGL normal, AO/rough/metal. */
const TEXTURES = ['red_laterite_soil_stones', 'dry_ground_01', 'sparse_grass', 'worn_asphalt', 'concrete_pavement', 'plastered_wall_03', 'excavated_soil_wall', 'rough_concrete'];
/** Props the app loads at the gun position (glTF, 1k textures). */
const MODELS = ['concrete_road_barrier', 'wooden_military_crate', 'ammo_box', 'metal_jerrycan_green', 'vintage_radio_transceiver'];
/** Raw scans used only by the Blender build (tools/blender/env.py); kept out of the app so the deployment stays small. */
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'blender', 'src-assets');
const SRC_MODELS = ['shrub_01', 'shrub_02', 'boulder_01'];

const exists = async (p) => { try { return (await stat(p)).size > 0; } catch { return false; } };
async function get(url, to) {
  if (await exists(to)) return 0;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  const b = Buffer.from(await r.arrayBuffer());
  await mkdir(dirname(to), { recursive: true }); await writeFile(to, b);
  return b.length;
}
const files = async (id) => (await fetch(`${API}/files/${id}`)).json();
let bytes = 0;
const credits = [];
for (const [cond, [id, res]] of Object.entries(HDRIS)) {
  const f = await files(id);
  bytes += await get(f.hdri[res].hdr.url, join(OUT, 'hdri', `${cond}.hdr`));
  credits.push(`hdri/${cond}.hdr  ←  ${id} (${res})`);
}
for (const id of TEXTURES) {
  const f = await files(id), pick = (k) => f[k]?.['1k']?.jpg?.url;
  const maps = { diff: pick('Diffuse'), nor: pick('nor_gl'), arm: pick('arm') ?? pick('Rough') };
  for (const [k, u] of Object.entries(maps)) if (u) bytes += await get(u, join(OUT, 'tex', id, `${k}.jpg`));
  credits.push(`tex/${id}/  ←  ${id}`);
}
for (const [ids, root] of [[MODELS, OUT], [SRC_MODELS, SRC]]) for (const id of ids) {
  const f = await files(id), g = f.gltf['1k'].gltf;
  bytes += await get(g.url, join(root, 'models', id, `${id}.gltf`));
  for (const [rel, v] of Object.entries(g.include ?? {})) bytes += await get(v.url, join(root, 'models', id, rel));
  credits.push(`${root === SRC ? 'tools/blender/src-assets/' : ''}models/${id}/  ←  ${id}`);
}
// Leaf atlas from ambientCG (CC0) for the tree foliage (tools/blender/env.py renders canopy clumps from it).
const LEAF = 'LeafSet013', leafDir = join(SRC, 'tex', 'leafset');
if (!(await exists(join(leafDir, 'color.jpg')))) {
  const zip = join(OUT, `${LEAF}.zip`), tmp = join(OUT, '_leaf');
  bytes += await get(`https://ambientcg.com/get?file=${LEAF}_1K-JPG.zip`, zip);
  await mkdir(tmp, { recursive: true });
  try { execFileSync('unzip', ['-o', '-q', zip, '-d', tmp]); } catch { execFileSync('tar', ['-xf', zip, '-C', tmp]); }
  await mkdir(leafDir, { recursive: true });
  const { copyFile } = await import('node:fs/promises');
  await copyFile(join(tmp, `${LEAF}_1K-JPG_Color.jpg`), join(leafDir, 'color.jpg'));
  await copyFile(join(tmp, `${LEAF}_1K-JPG_Opacity.jpg`), join(leafDir, 'opacity.jpg'));
  await rm(tmp, { recursive: true, force: true }); await rm(zip, { force: true });
}
credits.push(`tools/blender/src-assets/tex/leafset/  ←  ambientCG ${LEAF} (https://ambientcg.com, CC0 1.0)`);
await writeFile(join(OUT, 'CREDITS.txt'), `Assets from Poly Haven (https://polyhaven.com) and ambientCG (https://ambientcg.com), licensed CC0 1.0 (public domain). No attribution is required; listed for traceability.\n\n${credits.join('\n')}\n`);
console.log(`Assets ready in ${OUT} (${(bytes / 1e6).toFixed(1)} MB downloaded this run).`);
