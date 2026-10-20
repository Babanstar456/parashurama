import { calStats, chainHash, classificationStats, observe, runSim, runTotal, scoreRun, sectorOf, ticks, type Action, type Config, type DrillConfig, type Spawn } from '@parashurama/engine';

export class BadRequest extends Error { status = 400; }
const int = (v: any, lo: number, hi: number, name: string) => { if (!Number.isInteger(v) || v < lo || v > hi) throw new BadRequest(`${name} must be an integer between ${lo} and ${hi}`); return v; };
const num = (v: any, lo: number, hi: number, name: string) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw new BadRequest(`${name} must be a number between ${lo} and ${hi}`); return v; };
const oneOf = <T extends string>(v: any, list: readonly T[], name: string): T => { if (!list.includes(v)) throw new BadRequest(`${name} must be one of: ${list.join(', ')}`); return v; };

export function cleanCfg(c: any): DrillConfig {
  if (!c || typeof c !== 'object') throw new BadRequest('cfg is required');
  const f = c.focus ?? {};
  return { seed: int(c.seed, 0, 2 ** 32 - 1, 'cfg.seed'), drill: int(c.drill, 0, 1e6, 'cfg.drill'), time: oneOf(c.time, ['day', 'night'] as const, 'cfg.time'),
    terrain: oneOf(c.terrain, ['urban', 'rural'] as const, 'cfg.terrain'), fault: oneOf(c.fault, ['none', 'radar', 'eo', 'rf'] as const, 'cfg.fault'),
    faultSector: num(c.faultSector, 0, 360, 'cfg.faultSector'), pattern: oneOf(c.pattern, ['mixed', 'swarm'] as const, 'cfg.pattern'),
    ...(c.weather != null ? { weather: oneOf(c.weather, ['clear', 'rain', 'fog', 'dust'] as const, 'cfg.weather') } : {}), difficulty: int(c.difficulty, 1, 6, 'cfg.difficulty'),
    focus: { sector: f.sector == null ? null : num(f.sector, 0, 360, 'cfg.focus.sector'), loiter: !!f.loiter, decoy: !!f.decoy },
    ...(c.roe != null ? { roe: oneOf(c.roe, ['free', 'tight', 'peacetime'] as const, 'cfg.roe') } : {}),
    ...(c.ewRestricted != null ? { ewRestricted: !!c.ewRestricted } : {}),
    ...(c.wcs != null ? { wcs: oneOf(c.wcs, ['hold', 'tight', 'free'] as const, 'cfg.wcs') } : {}),
    ...(c.killAssess != null ? { killAssess: !!c.killAssess } : {}),
    ...(c.safeArcs != null ? { safeArcs: (() => { if (!Array.isArray(c.safeArcs) || c.safeArcs.length > 4) throw new BadRequest('cfg.safeArcs must be a list of at most 4 arcs');
      return c.safeArcs.map((a: any, i: number) => [num(a?.[0], 0, 360, `cfg.safeArcs[${i}][0]`), num(a?.[1], 0, 360, `cfg.safeArcs[${i}][1]`)] as [number, number]); })() } : {}) };
}
export function cleanSpawns(s: any, C: Config): Spawn[] | undefined {
  if (s == null) return undefined;
  if (!Array.isArray(s) || s.length < 1 || s.length > 40) throw new BadRequest('spawns must be a list of 1–40 contacts');
  return s.map((x: any, i: number) => ({ type: oneOf(x.type, Object.keys(C.threats.threats), `spawns[${i}].type`), t: num(x.t, 0, C.training.sim.maxDrillSec, `spawns[${i}].t`),
    brg: num(x.brg, 0, 360, `spawns[${i}].brg`), ...(x.dist != null ? { dist: num(x.dist, 300, C.training.sim.radarRangeM, `spawns[${i}].dist`) } : {}) }));
}
function cleanActions(a: any, C: Config, maxTick: number): Action[] {
  if (!Array.isArray(a) || a.length > 5000) throw new BadRequest('actions must be a list of at most 5000 decisions');
  const cls = [...Object.keys(C.threats.threats), 'unknown'], effs = [...C.effectors.order, 'hold'], confs = C.doctrine.confidence.map((x) => x.p);
  let last = 0;
  return a.map((x: any, i: number) => {
    const o: Action = { tick: int(x.tick, 0, maxTick, `actions[${i}].tick`), k: oneOf(x.k, ['track', 'id', 'eng', 'req', 'bda'] as const, `actions[${i}].k`), cid: int(x.cid, 1, 10000, `actions[${i}].cid`) };
    if (o.tick < last) throw new BadRequest('actions must be in time order'); last = o.tick;
    if (o.k === 'id') { o.cls = oneOf(x.cls, cls, `actions[${i}].cls`); if (!confs.some((p) => Math.abs(p - x.conf) < 1e-9)) throw new BadRequest(`actions[${i}].conf is not a known confidence level`); o.conf = x.conf; }
    if (o.k === 'eng') o.eff = oneOf(x.eff, effs, `actions[${i}].eff`);
    if (o.k === 'bda') o.out = oneOf(x.out ?? 'destroyed', ['destroyed', 'noEffect'] as const, `actions[${i}].out`);
    return o;
  });
}
/** Re-run the drill on the server from its seed and decision log. The client's own score is never trusted. */
export async function verifyDrill(C: Config, p: any) {
  const maxTick = ticks(C, C.training.sim.maxDrillSec) + ticks(C, 5);
  const cfg = cleanCfg(p.cfg), spawns = cleanSpawns(p.spawns, C), actions = cleanActions(p.actions, C, maxTick);
  const endTick = int(p.endTick, 1, maxTick, 'endTick');
  const mode = oneOf(p.mode ?? 'scored', ['scored', 'template'] as const, 'mode');
  const E = runSim(cfg, { actions, until: endTick, spawns }, C);
  const sc = scoreRun(E), total = runTotal(sc);
  const flags: string[] = [];
  if (p.clientTotal != null && p.clientTotal !== total) flags.push('client-score-mismatch');
  const tracked = E.contacts.filter((c) => c.trackTick != null && c.firstPaint != null);
  const instant = tracked.filter((c) => (c.trackTick as number) - (c.firstPaint as number) < ticks(C, 0.4)).length;
  if (tracked.length >= 3 && instant / tracked.length >= 0.5) flags.push('superhuman-reaction-times');
  const thr = new Array(12).fill(0); E.contacts.filter((c) => C.threats.threats[c.type].hostile).forEach((c) => thr[sectorOf(c.brg0)]++);
  const attnIn = Array.isArray(p.attn) && p.attn.length === 12 && p.attn.every((v: any) => typeof v === 'number' && v >= 0) ? p.attn : new Array(12).fill(1);
  const at = attnIn.reduce((a: number, b: number) => a + b, 0) || 1;
  const record = { demo: false, date: Date.now(), cfg, total, obs: observe(E, sc), attn: attnIn.map((v: number) => v / at), thr, cal: calStats(sc, C), cls: classificationStats(sc, C),
    jamNoRF: sc.filter((s) => s.src === s.c && s.e0?.eff === 'jam' && !C.threats.threats[s.c.type].rfOn).length, endTick, mode, template: typeof p.template === 'string' ? p.template.slice(0, 80) : null };
  return { cfg, spawns, actions, endTick, mode, total, verified: !flags.includes('client-score-mismatch'), flags, chain: await chainHash(actions), record };
}
