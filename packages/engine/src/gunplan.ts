import { getConfig, gunsOf, type Config } from './config';
import { defaultGunCfg, type Adw, type GunDrillConfig, type Wcs } from './gun';
import { GUN_SKILLS, gunMastery, type GunGame, type GunRecord } from './gunscore';
import { clamp, mulberry } from './util';

/**
 * Adaptive planner for the gun games (rule-based, like the radar drill's enemy AI): find the weakest gun skill for the
 * chosen game and build the next drill around it. Randomised from the history, so drills cannot be learned by rote.
 */
export interface GunPlan { cfg: GunDrillConfig; focus: string; why: string; }
const WHY: Record<string, string> = {
  gReady: 'Making ready was slow: this drill starts at a lower Air Defence Warning, so you must man the gun first.',
  gReact: 'Reaction to the fire order was slow: targets arrive closer together.',
  gLead: 'Your ballistic solution needs work: a manual sight (ZU-23-2) and crossing targets.',
  gAcc: 'Burst accuracy needs work: the manual sight, so you must set the lead yourself.',
  gDisc: 'Fire discipline: a safe arc and a friendly or civil aircraft to test your clearance and arcs.',
  gSafe: 'Making safe and reporting: stoppages are on, so expect the immediate-action drill.',
  gReload: 'Reloading was slow or out of order: a manual gun with short belts and more targets, so you will reload under pressure.',
  fOrders: 'Alert and fire-order sequence: the detachment starts stood down, so alert it first.',
  fWcs: 'Weapon Control Status: WEAPONS HOLD with safe arcs.',
  fPriority: 'Priority and range: more targets at once.',
  fClose: 'Cease and Hold fire: friendly and civil aircraft cross the line of fire.',
  vDetect: 'Detection was slow: night, bad weather or a failed sensor, so you must search the sky yourself.',
  vIdent: 'Identification needs work: more birds, civil drones and a friendly UAV mixed in with the threats.',
  vDecide: 'Engagement decisions: Weapons TIGHT with friendly and civil traffic, so fire only on what you have identified as hostile.',
  vShoot: 'Laying and shooting: the manual-sight ZU-23-2 against fast, crossing targets.',
  vDrill: 'Gun drill: stoppages on and the detachment stood down, so man the gun, load and clear stoppages under pressure.',
};
export function planGun(H: GunRecord[], game: GunGame, C: Config = getConfig()): GunPlan {
  const mine = H.filter((h) => h.game === game), m = gunMastery(mine, C);
  const skills = GUN_SKILLS.filter((s) => s[2] === game).map((s) => s[0]);
  const r = mulberry(9973 + mine.length * 131 + Math.round(mine.reduce((a, h) => a + h.total, 0)));
  const focus = skills.reduce((a, b) => (m[a] <= m[b] ? a : b));
  const recent = mine.slice(-3), avg = recent.length ? recent.reduce((a, h) => a + h.total, 0) / recent.length : 70;
  const difficulty = clamp(Math.round(2 + (avg - 50) / 15), 1, 6);
  const seed = 1000 + mine.length * 7919 + Math.floor(r() * 1e6);
  let gun = r() < 0.5 ? 'zu23' : 'zsu234', adw: Adw = 'red', wcs: Wcs = 'tight', safeArcs: [number, number][] | undefined, stoppages = r() < 0.6;
  const time = r() < 0.3 ? 'night' : 'day', terrain = r() < 0.5 ? 'urban' : 'rural';
  if (focus === 'gReady' || focus === 'fOrders') adw = r() < 0.5 ? 'yellow' : 'white';
  if (focus === 'gLead' || focus === 'gAcc' || focus === 'gReload') gun = 'zu23';
  if (focus === 'gDisc' || focus === 'fWcs') { const a = Math.floor(r() * 360); safeArcs = [[a, (a + 50) % 360]]; }
  if (focus === 'fWcs') wcs = 'hold';
  if (focus === 'gSafe') stoppages = true;
  // Field drill (3D): all three guns, weather and sensor faults; it draws on its own stream so the other games are unchanged.
  let field: Partial<GunDrillConfig> = {};
  if (game === 'field') {
    const f = mulberry(seed + 4111), guns = ['zu23', 'zsu234', 'l70'].filter((k) => gunsOf(C).guns[k]);
    gun = focus === 'vShoot' ? 'zu23' : guns[Math.floor(f() * guns.length)];
    // At night the thermal-sight or radar gun is tasked: a manual-sight gun cannot see small drones in the dark.
    if (gun === 'zu23' && time === 'night') gun = guns.includes('l70') ? 'l70' : 'zsu234';
    const wx = ['clear', 'clear', 'rain', 'fog', 'dust'] as const, weather = focus === 'vDetect' ? wx[2 + Math.floor(f() * 3)] : wx[Math.floor(f() * wx.length)];
    const radarFault = gun !== 'zu23' && (focus === 'vDetect' ? f() < 0.6 : f() < 0.15);
    if (focus === 'vDecide') wcs = 'tight';
    if (focus === 'vDrill') { stoppages = true; adw = 'yellow'; }
    field = { selfId: true, weather, ...(radarFault ? { radarFault } : {}), ...(focus === 'vDetect' && gun !== 'zu23' && f() < 0.5 ? { time: 'night' as const } : {}) };
  }
  const cfg = defaultGunCfg({
    seed, gun, difficulty: focus === 'fPriority' || focus === 'gReact' || focus === 'gReload' ? clamp(difficulty + 1, 1, 6) : focus === 'gDisc' || focus === 'fClose' || focus === 'vIdent' || focus === 'vDecide' ? Math.max(3, difficulty) : difficulty,
    time, terrain, adw, wcs, stoppages, ...(safeArcs ? { safeArcs } : {}), ...field,
    met: { tempC: Math.round(10 + r() * 32), pressureHpa: Math.round(985 + r() * 35), wind: [Math.round((r() - 0.5) * 16), Math.round((r() - 0.5) * 16), 0], latitudeDeg: 26 },
  });
  return { cfg, focus, why: mine.length ? WHY[focus] : 'First drill: a standard engagement to set your baseline.' };
}
