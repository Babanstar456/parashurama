import threatsJson from '../../../config/threats.json';
import effectorsJson from '../../../config/effectors.json';
import doctrineJson from '../../../config/doctrine.json';
import trainingJson from '../../../config/training.json';

export type Motion = 'approachHover' | 'weave' | 'straight' | 'swarm' | 'orbit' | 'wander' | 'surveil';
export interface Threat {
  label: string; short: string; speed: number; alt: [number, number]; echo: string;
  rf: string; rfOn: boolean; gnss: boolean; friendly: boolean; hostile: boolean;
  /** Civil (non-military) drone: report and monitor, never engage (R9). */
  civil?: boolean;
  shape: 'quad' | 'wing' | 'bird'; motion: Motion;
  hoverRangeM?: [number, number]; orbitRadiusM?: [number, number];
  behaviour: string; behaviourHover?: string; deciding: string;
}
export interface ThreatsFile { version: string; order: string[]; echoRcs: Record<string, number>; threats: Record<string, Threat>; }
export type Affects = 'rf' | 'gnss' | 'all';
export interface Effector { label: string; key: string; range: number; min: number; delay: number; color: string; affects: Affects; stock?: number; areaRadiusM?: number; collateralUrban?: boolean; }
export interface EffectorsFile { version: string; order: string[]; effectors: Record<string, Effector>; }
export type DecisionClass = 'rfLinked' | 'gnssOnly' | 'autonomous';
export interface ConfidenceLevel { k: string; label: string; p: number; key: string; }
export interface DoctrineFile {
  version: string; rules: Record<string, string>; confidence: ConfidenceLevel[];
  detection: { points: number; fullWithinSec: number; zeroAtSec: number };
  identification: { points: number; correctBase: number; correctPerConfidence: number; wrongPerUnconfidence: number; friendFoeBonus: number };
  defeat: {
    points: number; preferred: Record<DecisionClass, string>; tables: Record<DecisionClass, Record<string, number>>;
    friendlyHold: number; friendlyEngaged: number; clutterHold: number; clutterEngaged: number; hostileHeldButNeutralised: number;
    /** Optional so older doctrine files stay valid; defaults 40 / 0. */
    civilHold?: number; civilEngaged?: number;
    modifiers: { urbanGun: number; lateEngagementSec: number; late: number; priority: number; priorityRatio: number };
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
}
export interface WeatherFx { label: string; radar: number; camera: number; noise: number; }
export interface Config { threats: ThreatsFile; effectors: EffectorsFile; doctrine: DoctrineFile; training: TrainingFile; }

export const defaultConfig: Config = {
  threats: threatsJson as unknown as ThreatsFile,
  effectors: effectorsJson as unknown as EffectorsFile,
  doctrine: doctrineJson as unknown as DoctrineFile,
  training: trainingJson as unknown as TrainingFile,
};

let current: Config = defaultConfig;
export const getConfig = (): Config => current;
/** Internal: switch the active config without validation. Use `useConfig` from validate.ts instead. */
export const _setConfig = (c: Config): void => { current = c; };
export const decisionClass = (t: Threat): DecisionClass => (t.rfOn ? 'rfLinked' : t.gnss ? 'gnssOnly' : 'autonomous');
export const isEffective = (t: Threat, e: Effector): boolean => e.affects === 'all' || (e.affects === 'rf' && t.rfOn) || (e.affects === 'gnss' && t.gnss);
const CLEAR: WeatherFx = { label: 'Clear', radar: 1, camera: 1, noise: 0 };
/** Sensor effects of a drill's weather (radar detection factor, camera range factor, image noise). */
export const weatherFx = (c: Config, w?: string): WeatherFx => (w && c.training.weather?.[w]) || CLEAR;
/** Camera identification range for a drill: time of day, then weather. */
export const cameraRange = (c: Config, time: 'day' | 'night', w?: string): number => c.training.sim.cameraRangeM[time] * weatherFx(c, w).camera;
export const ticks = (c: Config, s: number): number => Math.round(s / c.training.sim.dt);
export const confLabel = (c: Config, p: number): string => (c.doctrine.confidence.find((x) => Math.abs(x.p - p) < 0.01) ?? c.doctrine.confidence[0]).label;
