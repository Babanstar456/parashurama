import threatsJson from '../../../config/threats.json';
import effectorsJson from '../../../config/effectors.json';
import doctrineJson from '../../../config/doctrine.json';
import trainingJson from '../../../config/training.json';
import gunsJson from '../../../config/guns.json';

export type Motion = 'approachHover' | 'weave' | 'straight' | 'swarm' | 'orbit' | 'wander' | 'surveil';
export interface Threat {
  label: string; short: string; speed: number; alt: [number, number]; echo: string;
  rf: string; rfOn: boolean; gnss: boolean; friendly: boolean; hostile: boolean;
  /** Civil (non-military) drone: report and monitor, never engage (R9). */
  civil?: boolean;
  /** Carries a droppable payload: after a kill, mark the crash site for EOD (R15). */
  payload?: boolean;
  shape: 'quad' | 'wing' | 'bird'; motion: Motion;
  hoverRangeM?: [number, number]; orbitRadiusM?: [number, number];
  behaviour: string; behaviourHover?: string; deciding: string;
  /** Optional acoustic signature (training values): what is heard, and from how far in open, quiet conditions. */
  acoustic?: { sig: string; rangeM: number };
}
export interface ThreatsFile { version: string; order: string[]; echoRcs: Record<string, number>; threats: Record<string, Threat>; }
export type Affects = 'rf' | 'gnss' | 'all';
export interface Effector { label: string; key: string; range: number; min: number; delay: number; color: string; affects: Affects; stock?: number; areaRadiusM?: number; collateralUrban?: boolean; /** Chance of a hit (0–1); missing = 1. */ pk?: number; /** Emits/jams radio or GNSS, so it causes EW collateral (R11). */ ewCollateral?: boolean; }
export interface EffectorsFile { version: string; order: string[]; effectors: Record<string, Effector>; }
export type DecisionClass = 'rfLinked' | 'gnssOnly' | 'autonomous';
export interface ConfidenceLevel { k: string; label: string; p: number; key: string; }
export interface DoctrineFile {
  version: string; rules: Record<string, string>; confidence: ConfidenceLevel[];
  detection: { points: number; fullWithinSec: number; zeroAtSec: number };
  identification: { points: number; correctBase: number; correctPerConfidence: number; wrongPerUnconfidence: number; friendFoeBonus: number; /** Points for declaring Unknown; missing = 10. */ unknown?: number };
  /** Optional ROE profiles; a profile missing here means no clearance is needed. */
  roe?: Partial<Record<'tight' | 'peacetime', { needsClearance: string[]; clearanceSec: number }>>;
  defeat: {
    points: number; preferred: Record<DecisionClass, string>; tables: Record<DecisionClass, Record<string, number>>;
    friendlyHold: number; friendlyEngaged: number; clutterHold: number; clutterEngaged: number; hostileHeldButNeutralised: number;
    /** Optional so older doctrine files stay valid; defaults 40 / 0. */
    civilHold?: number; civilEngaged?: number;
    modifiers: { urbanGun: number; lateEngagementSec: number; late: number; priority: number; priorityRatio: number; /** R10; missing = -10. */ missNotReengaged?: number; /** R12; missing = -40. */ unauthorised?: number; /** R11; missing = -10. */ ewRestricted?: number;
      /** R13; missing = -20. */ wcs?: number; /** WEAPONS HOLD self-defence window (s); missing = 20. */ selfDefenceSec?: number; /** R14; missing = -20. */ safeArc?: number;
      /** R15; missing = -5. */ killAssess?: number; /** R15 time allowed (s); missing = 10. */ killAssessSec?: number };
  };
}
export interface TrainingFile {
  version: string;
  sim: { dt: number; sweepSec: number; radarRangeM: number; assetRadiusM: number; maxDrillSec: number; cameraRangeM: { day: number; night: number }; radarFaultHalfWidthDeg: number; radarFaultFactor: number; warmStartSec: number };
  clues: { friendlyCheckSec: number; rfSec: number; behaviourSec: number };
  expert: { trackDelaySec: number; identifyDelaySec: number };
  learning: { pInit: number; learn: number; forget: number; slip: number; guess: number; maxObsPerDrill: number };
  certification: { passMark: number; certifiedMastery: number; developingMastery: number };
  scenario: { hostilePool: string[]; swarmType: string; friendlyType: string; clutterType: string; focusType: string; /** Optional: one civil drone in urban drills. */ civilType?: string };
  /** Optional so older instructor-saved configs stay valid; missing = every weather behaves as clear. */
  weather?: Record<string, WeatherFx>;
  /** Optional acoustic sensor; missing = none fitted (drills before v0.7 look and replay the same). */
  acoustic?: AcousticFx;
}
export interface WeatherFx { label: string; radar: number; camera: number; noise: number; /** Hearing-range factor; missing = 1. */ acoustic?: number; }
/** Acoustic sensor: seconds to recognise a sound once heard, and hearing-range factors (background noise by terrain; quieter nights). */
export interface AcousticFx { clueSec: number; urban: number; rural: number; night: number; }
/** Gun detachment data (config/guns.json). Training values from public nominal figures, not equipment specifications. */
export interface Ammo { label: string; massKg: number; caliberM: number; mv: number; mvSd: number; mvPerDegC: number; tracerSec: number; selfDestructSec: number; sdFailP: number; cdMach: [number, number][];
  /** Optional proximity fuze: a pass within this distance (m) is a hit. Missing = contact fuze only. */ proxM?: number; }
export interface Gun {
  label: string; short: string; sight: 'manual' | 'radar' | 'eo'; barrels: number; rpmPerBarrel: number; beltRounds: number; ammo: string;
  slewDegS: { az: number; el: number }; elevDeg: [number, number]; effRangeM: number; dispMil: number;
  heatPerRound: number; coolPerSec: number; heatLimit: number; stoppageP: number; sightFovDeg: number;
  /** Optional reload drill, in order; missing = one-step load. */ reload?: { id: string; label: string; sec: number }[];
  radar?: FcsSensor;
  /** Electro-optical fire control (sight 'eo'): thermal imager, laser rangefinder, auto-tracker. */ eo?: FcsSensor;
  /** Optional 3D model id for the field drill; missing = the gun id. */ model?: string;
}
export interface FcsSensor { acquireRangeM: number; lockSec: number; trackNoiseMil: number; faultP: number; }
/** Field-drill detection model (guns.json detect). */
export interface DetectModel { note?: string; visualM: Record<string, number>; night: number; urban: number; sensorBySize: Record<string, number>; spotWithinSec: number; idWithinSec: number; }
export interface GunsFile {
  version: string; note?: string; ammo: Record<string, Ammo>; guns: Record<string, Gun>;
  targets: { hitRadiusM: Record<string, number>; hitsToKill: Record<string, number>; engageRangeM?: Record<string, number> };
  manualSight: { speedStepMs: number; courseStepDeg: number; rangeStepM: number };
  procedure: { ackSec: number; loadSec: number; layWithinSec: number; firstBurstWithinSec: number; burstMin: number; burstMax: number; safeWithinSec: number; stoppageClearSec: number; barrelChangeSec: number;
    /** Optional: seconds to man the gun under each Air Defence Warning (missing = 0), and to report a kill. */
    standToSec?: Record<'white' | 'yellow' | 'red', number>; killReportSec?: number };
  met: { stdTempC: number; stdPressureHpa: number; latitudeDeg: number };
  /** Words of command (placeholders until the unit's exact drill wording is loaded). */
  orders?: Record<OrderWord, string> & { note?: string };
  /** Optional live-fire drill procedure (pre-firing checks, range sweep). Missing = none. */
  /** Optional UAV ground-control-station strike drill (training model). */
  uav?: { note?: string; label: string; speed: number; altM: number; turnDegS: number;
    munition: { label: string; massKg: number; caliberM: number; cdMach: [number, number][]; lethalRadiusM: number };
    corridorHalfWidthM: number; gimbalFovDeg: number; gimbalSlewDegS: number; clearanceSec: number; takeoffSec: number; landSec: number; checks: { id: string; label: string }[] };
  /** Optional detection model for the field drill; missing = built-in defaults (detectOf). */
  detect?: DetectModel;
  lfx?: { note?: string; gunChecks: { id: string; label: string }[]; rangeChecks: { id: string; label: string }[]; checkSec: number; uxoSearchSec: number };
}
export type OrderWord = 'rangeClear' | 'alert' | 'target' | 'method' | 'engage' | 'hold' | 'cease' | 'unload' | 'ack' | 'ready' | 'onTarget' | 'stoppage' | 'reportSafe' | 'killDestroyed' | 'killNoEffect' | 'rangeGreen';
/** guns is optional so configs saved before the gun mode stay valid; use gunsOf() to read it. */
export interface Config { threats: ThreatsFile; effectors: EffectorsFile; doctrine: DoctrineFile; training: TrainingFile; guns?: GunsFile; }

export const defaultConfig: Config = {
  threats: threatsJson as unknown as ThreatsFile,
  effectors: effectorsJson as unknown as EffectorsFile,
  doctrine: doctrineJson as unknown as DoctrineFile,
  training: trainingJson as unknown as TrainingFile,
  guns: gunsJson as unknown as GunsFile,
};

let current: Config = defaultConfig;
export const getConfig = (): Config => current;
/** Internal: switch the active config without validation. Use `useConfig` from validate.ts instead. */
export const _setConfig = (c: Config): void => { current = c; };
/** Gun data of a config, falling back to the shipped guns.json for older configs. */
export const gunsOf = (c: Config): GunsFile => c.guns ?? (gunsJson as unknown as GunsFile);
/** Detection model of a config, falling back to the shipped values for older guns files. */
export const detectOf = (G: GunsFile): DetectModel => G.detect ?? (gunsJson as unknown as GunsFile).detect!;
/** A gun's fire-control sensor (radar or electro-optical), if it has one. */
export const fcsOf = (g: Gun): FcsSensor | undefined => (g.sight === 'eo' ? g.eo : g.sight === 'radar' ? g.radar : undefined);
export const decisionClass = (t: Threat): DecisionClass => (t.rfOn ? 'rfLinked' : t.gnss ? 'gnssOnly' : 'autonomous');
export const isEffective = (t: Threat, e: Effector): boolean => e.affects === 'all' || (e.affects === 'rf' && t.rfOn) || (e.affects === 'gnss' && t.gnss);
const CLEAR: WeatherFx = { label: 'Clear', radar: 1, camera: 1, noise: 0 };
/** Sensor effects of a drill's weather (radar detection factor, camera range factor, image noise). */
export const weatherFx = (c: Config, w?: string): WeatherFx => (w && c.training.weather?.[w]) || CLEAR;
/** Camera identification range for a drill: time of day, then weather. */
export const cameraRange = (c: Config, time: 'day' | 'night', w?: string): number => c.training.sim.cameraRangeM[time] * weatherFx(c, w).camera;
/** Hearing range (m) for a threat type in a drill, or null when no acoustic sensor is fitted or the type has no signature. */
export const acousticRange = (c: Config, type: string, d: { time: 'day' | 'night'; terrain: 'urban' | 'rural'; weather?: string }): number | null => {
  const A = c.training.acoustic, s = c.threats.threats[type]?.acoustic;
  if (!A || !s) return null;
  return s.rangeM * A[d.terrain] * (d.time === 'night' ? A.night : 1) * (weatherFx(c, d.weather).acoustic ?? 1);
};
export const ticks = (c: Config, s: number): number => Math.round(s / c.training.sim.dt);
export const confLabel = (c: Config, p: number): string => (c.doctrine.confidence.find((x) => Math.abs(x.p - p) < 0.01) ?? c.doctrine.confidence[0]).label;
