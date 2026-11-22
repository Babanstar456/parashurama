// Recognition trainer: the "recognize → classify" skill on its own, as fast repetitions. A drone appears for about 1.5 s
// through the naked eye, binoculars, a TV camera or a thermal imager, at a random bearing, height, heading and distance
// (sized so it is 14–70 px across, as on a real search), by day or night. The trainee names it. Each answer records the
// type, the answer and the reaction time; the next drone favours the types this trainee confuses, and the exposure gets
// shorter as accuracy rises. 20 drones a session; results per type and the top confusions. Works offline.
import * as THREE from 'three';
import { mulberry } from '@parashurama/engine';
import { TYPES, ORDER } from './cfg';
import { gltf, hdr, pbr } from './field3d';

type View = 'eye' | 'binos' | 'tv' | 'thermal';
interface Trial { type: string; view: View; night: boolean; px: number; ans: string | null; rtMs: number | null; }
interface Stat { n: number; ok: number; }
export interface RecogRecord { date: number; total: number; n: number; rtMs: number; confusions: [string, string, number][]; }
const STATS = 'parashurama.recogStats', HIST = 'parashurama.recogH', N = 20;
const VIEW_FOV: Record<View, number> = { eye: 40, binos: 7.5, tv: 5, thermal: 6 };
const VIEW_LABEL: Record<View, string> = { eye: 'Naked eye', binos: 'Binoculars 7×', tv: 'TV camera', thermal: 'Thermal imager' };
const load = <T>(k: string, d: T): T => { try { return JSON.parse(localStorage.getItem(k) || '') ?? d; } catch { return d; } };
const store = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } };
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export const recogHistory = (): RecogRecord[] => load<RecogRecord[]>(HIST, []);

let open = false, onClose: (() => void) | null = null, raf = 0, keyH: ((e: KeyboardEvent) => void) | null = null;

export async function openRecog(back?: () => void) {
  if (open) return; open = true; onClose = back ?? null;
  const el = document.createElement('div'); el.id = 'recogApp'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Recognition trainer');
  el.innerHTML = `<div class="rcBar"><b>RECOGNITION TRAINER</b><span id="rcProg"></span><span id="rcView"></span><button class="smallBtn" id="rcQuit">End</button></div>
    <div class="rcMain"><div class="rcStage" id="rcStage"><div class="rcMsg" id="rcMsg">Loading the drone library…</div><div class="rcFrame" id="rcFrame"></div></div>
    <aside class="rcSide"><h4>What is it?</h4><div class="rcAns" id="rcAns"></div><p class="rcHelp">Press the number key or click. Be quick: speed counts too.</p></aside></div>`;
  document.body.appendChild(el); document.body.classList.add('recogOn');
  (el.querySelector('#rcQuit') as HTMLElement).onclick = () => close();
  const stage = el.querySelector('#rcStage') as HTMLElement, msg = el.querySelector('#rcMsg') as HTMLElement, frame = el.querySelector('#rcFrame') as HTMLElement;

  // ---------- scene ----------
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(1.5, devicePixelRatio)); renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping;
  stage.prepend(renderer.domElement);
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(40, 1, 0.1, 30000);
  const [daySky, nightSky, lib, fpv, swarm, male] = await Promise.all([hdr('day'), hdr('night'), gltf('models/drones.glb'), gltf('models/drone_fpv.glb'), gltf('models/drone_swarm.glb'), gltf('models/drone_male.glb')]);
  if (!open) { renderer.dispose(); return; }
  const pmrem = new THREE.PMREMGenerator(renderer), envDay = daySky ? pmrem.fromEquirectangular(daySky).texture : null, envNight = nightSky ? pmrem.fromEquirectangular(nightSky).texture : null;
  const sun = new THREE.DirectionalLight(0xfff0d8, 2.4); sun.position.set(-300, 500, -200); scene.add(sun);
  const hemi = new THREE.HemisphereLight(0xdfe9f2, 0x5b5a48, 0.6); scene.add(hemi);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(40000, 40000).rotateX(-Math.PI / 2), pbr('red_laterite_soil_stones', 4000)); ground.position.y = -2; scene.add(ground);
  const better: Record<string, THREE.Group | null> = { fpv, swarm, male };
  const types = ORDER.filter((k) => better[k]?.getObjectByName(`drone_${k}`) || lib?.getObjectByName(`drone_${k}`));
  const proto = new Map<string, { obj: THREE.Object3D; span: number }>();
  for (const k of types) {
    const src = (better[k]?.getObjectByName(`drone_${k}`) ?? lib!.getObjectByName(`drone_${k}`))!.clone(true);
    src.position.set(0, 0, 0); src.traverse((o) => { const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined; if (m) (o as THREE.Mesh).material = m.clone(); });
    const s = new THREE.Box3().setFromObject(src).getSize(new THREE.Vector3());
    proto.set(k, { obj: src, span: Math.max(s.x, s.z, 0.2) });
  }
  if (!types.length) { msg.textContent = 'The drone models could not be loaded (the offline single-file copy has no 3D models).'; return; }

  // ---------- adaptive choice ----------
  const stats = load<Record<string, Stat>>(STATS, {}), rng = mulberry((Date.now() & 0xffffff) ^ 0x5eed);
  const weight = (k: string) => { const s = stats[k] ?? { n: 0, ok: 0 }; return 0.15 + (1 - (s.ok + 1) / (s.n + 2)); };
  const pick = (): string => { const w = types.map(weight), tot = w.reduce((a, b) => a + b, 0); let r = rng() * tot; for (let i = 0; i < types.length; i++) { r -= w[i]; if (r <= 0) return types[i]; } return types[types.length - 1]; };
  const trials: Trial[] = [];
  let exposureMs = 1500, cur: { t: Trial; obj: THREE.Object3D; shownAt: number; phase: 'show' | 'wait' | 'feedback' } | null = null;

  // ---------- answers ----------
  const ans = el.querySelector('#rcAns') as HTMLElement;
  ans.innerHTML = types.map((k, i) => `<button data-k="${k}">${i < 10 ? `<kbd>${(i + 1) % 10}</kbd>` : ''}${esc(TYPES[k].short)}</button>`).join('');
  ans.querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.onclick = () => answer(b.dataset.k!)));
  /** Answers count only while a drone is up: grey the buttons out before Start, during feedback and after the last one. */
  const setAns = (on: boolean) => ans.classList.toggle('off', !on);
  setAns(false);
  keyH = (e: KeyboardEvent) => {
    if (!open) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    const d = '1234567890'.indexOf(e.key); if (d >= 0 && d < types.length) { e.preventDefault(); e.stopImmediatePropagation(); answer(types[d]); }
  };
  addEventListener('keydown', keyH, true);

  const resize = () => { const w = stage.clientWidth, h = stage.clientHeight; if (!w || !h) return; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); };
  const ro = new ResizeObserver(resize); ro.observe(stage); resize();

  function setLook(view: View, night: boolean) {
    const hot = view === 'thermal';
    scene.background = hot ? new THREE.Color(0x060606) : night ? nightSky ?? new THREE.Color(0x060a12) : daySky ?? new THREE.Color(0x9fb6c8);
    scene.environment = hot ? null : night ? envNight : envDay;
    scene.fog = new THREE.Fog(hot ? 0x050505 : night ? 0x0a0f18 : 0xb7c6d2, 2500, 14000);
    sun.intensity = hot ? 0 : night ? 0.25 : 2.4; hemi.intensity = hot ? 1.0 : night ? 0.15 : 0.6;
    renderer.toneMappingExposure = night && !hot ? 0.45 : 0.8; scene.backgroundIntensity = night && !hot ? 0.35 : 1;
    (ground.material as THREE.MeshStandardMaterial).color.setHex(hot ? 0x202020 : 0xffffff);
    renderer.domElement.style.filter = view === 'tv' ? 'grayscale(1) contrast(1.35)' : hot ? 'grayscale(1) contrast(1.25) blur(0.4px)' : '';
    frame.className = `rcFrame ${view}`;
    frame.innerHTML = view === 'eye' ? '' : view === 'binos' ? '<svg viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice"><defs><mask id="rcBin"><rect width="1600" height="900" fill="white"/><circle cx="620" cy="450" r="330" fill="black"/><circle cx="980" cy="450" r="330" fill="black"/></mask></defs><rect width="1600" height="900" fill="black" mask="url(#rcBin)"/></svg>' : `<span>${view === 'tv' ? 'TV  DAY' : 'TI  WHT-HOT'}</span><em></em>`;
  }

  function next() {
    if (cur) scene.remove(cur.obj);
    if (trials.length >= N) { results(); return; }
    const type = pick(), night = rng() < 0.3, views: View[] = night ? ['thermal', 'thermal', 'tv', 'binos'] : ['eye', 'binos', 'binos', 'tv', 'thermal'];
    const view = views[Math.floor(rng() * views.length)], px = 14 + rng() * 56, P = proto.get(type)!;
    camera.fov = VIEW_FOV[view]; camera.updateProjectionMatrix();
    const pxPerRad = stage.clientHeight / (2 * Math.tan((camera.fov * Math.PI) / 360)), dist = Math.min(9000, (P.span * pxPerRad) / px);
    const az = rng() * Math.PI * 2, elv = (2 + rng() * 14) * (Math.PI / 180);
    camera.position.set(0, 2, 0);
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(elv), Math.sin(elv), -Math.cos(az) * Math.cos(elv));
    // Off the centre a little (it is a search, not a bullseye).
    const off = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize().multiplyScalar((rng() - 0.5) * 0.5 * Math.tan((camera.fov * Math.PI) / 360) * 2 * dist * camera.aspect * 0.6);
    const obj = P.obj.clone(true); obj.position.copy(dir.clone().multiplyScalar(dist)).add(off).add(new THREE.Vector3(0, 2 + (rng() - 0.5) * dist * 0.02, 0));
    obj.rotation.set((rng() - 0.5) * 0.3, rng() * Math.PI * 2, (rng() - 0.5) * 0.3);
    obj.traverse((o) => { const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined; if (m?.emissive) { m.emissive.setHex(view === 'thermal' ? 0xffffff : 0); m.emissiveIntensity = view === 'thermal' ? 3 : 1; } });
    scene.add(obj); camera.lookAt(dir.clone().multiplyScalar(1000).add(new THREE.Vector3(0, 2, 0)));
    setLook(view, night);
    const t: Trial = { type, view, night, px: Math.round(px), ans: null, rtMs: null };
    trials.push(t); cur = { t, obj, shownAt: performance.now(), phase: 'show' };
    msg.textContent = ''; msg.className = 'rcMsg';
    (el.querySelector('#rcProg') as HTMLElement).textContent = `Drone ${trials.length} of ${N}`;
    (el.querySelector('#rcView') as HTMLElement).textContent = `${VIEW_LABEL[view]}${night ? ' · night' : ''}`;
    setAns(true);
  }

  function answer(k: string) {
    if (!cur || cur.phase === 'feedback') return;
    const t = cur.t; t.ans = k; t.rtMs = Math.round(performance.now() - cur.shownAt);
    const ok = k === t.type, s = (stats[t.type] ??= { n: 0, ok: 0 }); s.n++; if (ok) s.ok++; store(STATS, stats);
    // Exposure follows this session's accuracy: shorter when it is easy, longer when it is not.
    const done = trials.filter((x) => x.ans), acc = done.filter((x) => x.ans === x.type).length / done.length;
    if (done.length >= 6) exposureMs = acc > 0.85 ? 1000 : acc < 0.5 ? 2000 : 1500;
    cur.phase = 'feedback'; cur.obj.visible = true; setAns(false);
    msg.className = `rcMsg ${ok ? 'ok' : 'bad'}`;
    msg.innerHTML = ok ? `✓ ${esc(TYPES[t.type].label)} <small>${(t.rtMs / 1000).toFixed(1)} s</small>` : `✗ It was <b>${esc(TYPES[t.type].label)}</b><small>you said ${esc(TYPES[k].short)}</small>`;
    ans.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.classList.toggle('right', b.dataset.k === t.type));
    setTimeout(() => { ans.querySelectorAll('button').forEach((b) => b.classList.remove('right')); if (open && cur?.t === t) next(); }, ok ? 900 : 1900);
  }

  function results() {
    cancelAnimationFrame(raf); cur = null; setAns(false);
    const ok = trials.filter((t) => t.ans === t.type).length, acc = Math.round((ok / trials.length) * 100);
    const rts = trials.filter((t) => t.rtMs != null).map((t) => t.rtMs!), rt = rts.length ? Math.round(rts.reduce((a, b) => a + b, 0) / rts.length) : 0;
    const conf = new Map<string, number>(); for (const t of trials) if (t.ans && t.ans !== t.type) conf.set(`${t.type}>${t.ans}`, (conf.get(`${t.type}>${t.ans}`) ?? 0) + 1);
    const top = [...conf].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => { const [a, b] = k.split('>'); return [a, b, n] as [string, string, number]; });
    const H = recogHistory(); H.push({ date: Date.now(), total: acc, n: trials.length, rtMs: rt, confusions: top }); store(HIST, H.slice(-200));
    const per = [...new Set(trials.map((t) => t.type))].map((k) => { const ts = trials.filter((t) => t.type === k), c = ts.filter((t) => t.ans === k).length; return { k, n: ts.length, c }; }).sort((a, b) => a.c / a.n - b.c / b.n);
    stage.querySelector('canvas')!.style.visibility = 'hidden'; frame.innerHTML = ''; frame.className = 'rcFrame';
    msg.className = 'rcMsg rcRes';
    msg.innerHTML = `<b class="${acc >= 75 ? 'ok' : 'bad'}">${acc}%</b><span>${ok} of ${trials.length} named correctly · average ${(rt / 1000).toFixed(1)} s</span>
      ${top.length ? `<h4>Mixed up most</h4><ul>${top.map(([a, b, n]) => `<li><b>${esc(TYPES[a].short)}</b> called <b>${esc(TYPES[b].short)}</b> ×${n}</li>`).join('')}</ul><p>These come up more often next time.</p>` : '<p>No mix-ups this time.</p>'}
      <h4>By type</h4><div class="rcPer">${per.map((p) => `<span class="${p.c === p.n ? 'ok' : p.c ? '' : 'bad'}">${esc(TYPES[p.k].short)} ${p.c}/${p.n}</span>`).join('')}</div>
      <div class="rcBtns"><button class="smallBtn solid" id="rcAgain">Again</button><button class="smallBtn" id="rcBack">Back</button></div>`;
    (msg.querySelector('#rcAgain') as HTMLElement).onclick = () => { close(false); void openRecog(onClose ?? undefined); };
    (msg.querySelector('#rcBack') as HTMLElement).onclick = () => close();
  }

  const loop = (now: number) => {
    if (!open) return;
    if (cur) {
      const age = now - cur.shownAt;
      if (cur.phase === 'show' && age > exposureMs) { cur.phase = 'wait'; cur.obj.visible = false; msg.textContent = 'What was it?'; msg.className = 'rcMsg ask'; }
      cur.obj.traverse((o) => { if (/^prop/.test(o.name)) o.rotateY(1.7); });
    }
    renderer.render(scene, camera); raf = requestAnimationFrame(loop);
  };
  disposeFns = [() => { ro.disconnect(); renderer.dispose(); pmrem.dispose(); renderer.forceContextLoss(); }];
  msg.innerHTML = '<b>Name each drone</b><span>It shows for about 1.5 s. 20 drones.</span><div class="rcBtns"><button class="smallBtn solid" id="rcGo">Start</button></div>';
  (msg.querySelector('#rcGo') as HTMLElement).onclick = () => next();
  raf = requestAnimationFrame(loop);
}
let disposeFns: (() => void)[] = [];
export function closeRecog() { close(); }
function close(back = true) {
  if (!open) return; open = false; cancelAnimationFrame(raf);
  if (keyH) removeEventListener('keydown', keyH, true); keyH = null;
  disposeFns.forEach((f) => f()); disposeFns = [];
  document.getElementById('recogApp')?.remove(); document.body.classList.remove('recogOn');
  if (back) onClose?.();
}
