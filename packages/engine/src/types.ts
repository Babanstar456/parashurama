import type { Config } from './config';

export type TimeOfDay = 'day' | 'night';
export type Terrain = 'urban' | 'rural';
export type Fault = 'none' | 'radar' | 'eo' | 'rf';
export type Pattern = 'mixed' | 'swarm';
/** Weather: degrades radar and camera. Optional so drills recorded before weather existed replay exactly ('clear'). */
export type Weather = 'clear' | 'rain' | 'fog' | 'dust';
/** Rules of engagement: free (default, today's behaviour), tight (kinetic needs clearance), peacetime (everything needs clearance). */
export type Roe = 'free' | 'tight' | 'peacetime';

/** Everything needed to regenerate a drill exactly. */
export interface DrillConfig {
  seed: number; drill: number; time: TimeOfDay; terrain: Terrain; fault: Fault; faultSector: number;
  pattern: Pattern; weather?: Weather; difficulty: number; focus: { sector: number | null; loiter: boolean; decoy: boolean };
  /** Optional; missing = 'free'. */
  roe?: Roe;
  /** Optional: jamming/spoofing here disrupts own and civil systems (R11). Missing = false. */
  ewRestricted?: boolean;
}
export type ActionKind = 'track' | 'id' | 'eng' | 'req';
/** A trainee (or expert) decision, stamped with the tick it applies on. */
export interface Action { tick: number; k: ActionKind; cid: number; cls?: string; conf?: number; eff?: string; }
export interface Engagement { tick: number; eff: string; effective: boolean; range: number; tti: number; priorityMiss?: boolean; /** The effector could work but this shot missed (pk < 1). */ miss?: boolean;
  /** Set only under a restrictive ROE: was this engagement cleared? */ cleared?: boolean; }
export type ContactState = 'live' | 'neutralised' | 'leaked';
export interface Contact {
  id: number; type: string; x: number; y: number; alt: number; v: number; hdg: number; wob: number;
  state: ContactState; born: number; firstPaint: number | null; lastPaint: number;
  trackTick: number | null; idTick: number | null; idCls: string | null; idConf: number | null;
  engs: Engagement[]; effectAt: number | null; effectBy: string | null; endTick: number | null;
  brg0: number; hover: boolean; area: boolean; areaFrom: number | null;
  orbit: boolean; oc: number; orad: number; hoverR: number; areaCredit?: boolean;
  /** Clearance requested at / granted at (ticks); set only when a clearance request is made. */
  clrReq?: number | null; clrAt?: number | null;
}
/** A threat entering the drill: type, time (s), bearing (deg) and optional start distance (m, scripted drills). */
export interface Spawn { type: string; t: number; brg: number; dist?: number; }
export interface Engine {
  C: Config; cfg: DrillConfig; tick: number; spawns: Spawn[]; next: number;
  contacts: Contact[]; stock: Record<string, number>; nid: number;
}
