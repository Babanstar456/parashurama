// Sound for the 3D field drill (Web Audio, generated; no files needed).
//   ZU-23-2: each round is scheduled at its own time at the real cyclic rate (two 2A14 barrels, ~2,000 rounds a minute
//   each), built from a supersonic crack, the chest-thump of the charge, breech clatter, then outdoor reverb and a
//   slap-back echo; links and cases ring after the burst. Other guns use the same chain with their own rate and weight.
//   A real recording can replace the synthesis: put a single-shot file at public/audio/<gun>_shot.wav (or .ogg/.mp3).
//   Drones buzz from their direction (3D panning) once inside their acoustic range, like the detachment hears them.
import { getConfig, losOf, targetPos, type GunEngine } from '@parashurama/engine';
import { app } from './app';

interface Voice { crack: number; body: number; thumpHz: number; bodyLp: number; clatter: number; gain: number; }
const VOICES: Record<string, Voice> = {
  zu23: { crack: 0.9, body: 1.0, thumpHz: 95, bodyLp: 900, clatter: 0.35, gain: 0.55 },
  zsu234: { crack: 0.7, body: 0.9, thumpHz: 85, bodyLp: 800, clatter: 0.2, gain: 0.5 },
  l70: { crack: 1.0, body: 1.4, thumpHz: 55, bodyLp: 500, clatter: 0.5, gain: 0.8 },
};

export interface FieldAudio {
  /** New rounds from this tick: schedule one shot per round, spread over the tick. */ rounds: (n: number, dt: number) => void;
  /** A burst ended: links and cases. */ burstEnd: () => void;
  /** The loader: 'start' = clip in, 'done' = rammer home, gun ready. */ loader: (kind: 'start' | 'done') => void;
  /** Explosion or airburst at a distance (m): delayed by the speed of sound. */ boom: (distM: number, big: boolean) => void;
  /** Listener orientation and the drones' buzz. */ update: (E: GunEngine, t: number, az: number, el: number) => void;
  dispose: () => void;
}

export function fieldAudio(gun: string): FieldAudio | null {
  if ((app.DB.settings?.sound ?? 'sound') === 'off') return null;
  let ac: AudioContext;
  try { ac = new AudioContext(); } catch { return null; }
  const v = VOICES[gun] ?? VOICES.zu23, sr = ac.sampleRate;
  const resume = () => { if (ac.state === 'suspended') void ac.resume(); };
  addEventListener('pointerdown', resume); addEventListener('keydown', resume);
  // Master: compressor (a gun is loud; keep it from clipping), dry + reverb + slap-back echo off the buildings or treeline.
  const master = ac.createGain(); master.gain.value = 0.9;
  const comp = ac.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 6; comp.attack.value = 0.002; comp.release.value = 0.12;
  master.connect(comp).connect(ac.destination);
  const bus = ac.createGain(); bus.connect(master);
  const ir = ac.createBuffer(2, sr * 1.6, sr);
  for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 3.2) * (i < sr * 0.012 ? 0 : 1); }
  const verb = ac.createConvolver(); verb.buffer = ir; const verbG = ac.createGain(); verbG.gain.value = 0.32;
  bus.connect(verb).connect(verbG).connect(master);
  const echo = ac.createDelay(1); echo.delayTime.value = 0.38; const echoLp = ac.createBiquadFilter(); echoLp.type = 'lowpass'; echoLp.frequency.value = 1400;
  const echoG = ac.createGain(); echoG.gain.value = 0.22; bus.connect(echo).connect(echoLp).connect(echoG).connect(master);
  // Noise for the shot layers.
  const noise = ac.createBuffer(1, sr * 0.6, sr); { const d = noise.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
  // Recorded samples (CC0, public/audio/CREDITS.txt) where present: the gun's shot, the L70's boom, the loader's clanks.
  const S: Record<string, AudioBuffer | undefined> = {};
  const want = [`${gun}_shot`, ...(gun === 'l70' ? ['l70_boom', 'load_clip', 'load_ram', 'load_ram2', 'cases'] : [])];
  if (location.protocol !== 'file:') for (const n of want) {
    void fetch(`${import.meta.env.BASE_URL}audio/${n}.wav`).then((r) => (r.ok && !(r.headers.get('content-type') ?? '').includes('html') ? r.arrayBuffer() : null))
      .then((b) => (b ? ac.decodeAudioData(b) : null)).then((s) => { if (s) S[n] = s; }).catch(() => undefined);
  }
  const play = (n: string, t: number, gain: number, rate = 1, lp = 0) => {
    const b = S[n]; if (!b) return false;
    const s = ac.createBufferSource(), e = ac.createGain(); s.buffer = b; s.playbackRate.value = rate; e.gain.value = gain;
    if (lp) { const f = ac.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp; s.connect(f).connect(e); } else s.connect(e);
    e.connect(bus); s.start(t); return true;
  };
  const nz = (t: number, dur: number, type: BiquadFilterType, f: number, q: number, g: number, decay: number, out: AudioNode = bus) => {
    const s = ac.createBufferSource(); s.buffer = noise; s.playbackRate.value = 0.9 + Math.random() * 0.2;
    const fl = ac.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q;
    const e = ac.createGain(); e.gain.setValueAtTime(g, t); e.gain.exponentialRampToValueAtTime(0.0008, t + decay);
    s.connect(fl).connect(e).connect(out); s.start(t, Math.random() * 0.3, dur);
  };
  function shot(t: number, k: number) {
    const g = v.gain * (0.85 + Math.random() * 0.3);
    if (play(`${gun}_shot`, t, g * 1.3, 0.97 + Math.random() * 0.06)) {
      if (gun === 'l70') play('l70_boom', t, g * 0.55, 0.9 + Math.random() * 0.05, 900);  // the 40 mm's weight
      return;
    }
    nz(t, 0.012, 'highpass', 2200, 0.7, 0.9 * v.crack * g, 0.012);                     // supersonic crack
    nz(t, 0.09, 'lowpass', v.bodyLp, 0.8, 1.2 * v.body * g, 0.075);                   // muzzle blast
    const o = ac.createOscillator(), og = ac.createGain();                              // chest thump
    o.type = 'sine'; o.frequency.setValueAtTime(v.thumpHz * 1.6, t); o.frequency.exponentialRampToValueAtTime(v.thumpHz * 0.5, t + 0.09);
    og.gain.setValueAtTime(0.9 * g, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.11); o.connect(og).connect(bus); o.start(t); o.stop(t + 0.13);
    nz(t + 0.006 + (k % 2) * 0.002, 0.02, 'bandpass', 3200 + Math.random() * 900, 5, v.clatter * g, 0.02);  // bolt / breech clatter
  }
  let last = 0, firing = false;
  const dronesBus = ac.createGain(); dronesBus.gain.value = 0.5; dronesBus.connect(master);
  const buzz = new Map<number, { o: OscillatorNode; o2: OscillatorNode; lfo: OscillatorNode; g: GainNode; p: PannerNode }>();
  const L = ac.listener;
  return {
    rounds: (n, dt) => {
      resume();
      const now = ac.currentTime + 0.03, start = Math.max(now, last);
      for (let i = 0; i < n; i++) shot(start + (i / n) * dt, i);
      last = start + dt; firing = n > 0;
    },
    loader: (kind) => {
      resume();
      const t = ac.currentTime + 0.02;
      if (kind === 'start') { if (!play('load_clip', t, 0.9)) nz(t, 0.08, 'bandpass', 1800, 4, 0.5, 0.08); play('load_ram2', t + 0.9, 0.7); }
      else if (!play('load_ram', t, 1.0)) { nz(t, 0.12, 'bandpass', 900, 3, 0.7, 0.15); nz(t + 0.05, 0.05, 'bandpass', 3000, 5, 0.3, 0.05); }
    },
    burstEnd: () => {
      if (!firing) return; firing = false;
      const t = Math.max(ac.currentTime, last) + 0.05;
      if (play('cases', t + 0.15, 0.6)) return;
      for (let i = 0; i < 9; i++) { // links and fired cases falling on the platform
        const o = ac.createOscillator(), g = ac.createGain(), at = t + Math.random() * 0.9;
        o.type = 'triangle'; o.frequency.value = 2400 + Math.random() * 2600; g.gain.setValueAtTime(0.05, at); g.gain.exponentialRampToValueAtTime(0.0005, at + 0.12);
        o.connect(g).connect(bus); o.start(at); o.stop(at + 0.14);
      }
    },
    boom: (d, big) => {
      const t = ac.currentTime + Math.min(12, d / 343), g = Math.min(1, 220 / Math.max(80, d)) * (big ? 1 : 0.45);
      nz(t, 0.5, 'lowpass', big ? 380 : 700, 0.7, g, big ? 0.9 : 0.35, master);
      nz(t, 0.05, 'highpass', 1500, 0.7, g * 0.4, 0.05, master);
    },
    update: (E, t, az, el) => {
      // Listener at the gun, facing the aim (three.js-style axes: x east, y up, z south).
      const a = (az * Math.PI) / 180, e = (el * Math.PI) / 180, fx = Math.sin(a) * Math.cos(e), fy = Math.sin(e), fz = -Math.cos(a) * Math.cos(e);
      if (L.forwardX) { L.forwardX.value = fx; L.forwardY.value = fy; L.forwardZ.value = fz; L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0; }
      else L.setOrientation(fx, fy, fz, 0, 1, 0);
      const T = getConfig().threats.threats;
      for (const tg of E.targets) {
        const ty = T[tg.type], range = tg.state === 'live' ? losOf(targetPos(tg, t, E.dt)).range : Infinity;
        const hear = ty?.acoustic && range < ty.acoustic.rangeM * 1.3;
        let b = buzz.get(tg.id);
        if (!hear) { if (b) { b.g.gain.setTargetAtTime(0, ac.currentTime, 0.2); const x = b; setTimeout(() => { try { x.o.stop(); x.o2.stop(); x.lfo.stop(); } catch { /* stopped */ } }, 800); buzz.delete(tg.id); } continue; }
        if (!b) {
          // Multirotors whine (a few hundred Hz, wavering with throttle); propeller planes drone lower; jets roar.
          const quad = ty.shape === 'quad', jet = tg.type === 'jetOwa', bird = tg.type === 'bird';
          if (bird) continue;
          const o = ac.createOscillator(), o2 = ac.createOscillator(), lfo = ac.createOscillator(), lg = ac.createGain(), g = ac.createGain(), p = ac.createPanner(), f = ac.createBiquadFilter();
          o.type = 'sawtooth'; o2.type = 'sawtooth';
          const base = jet ? 140 : quad ? (tg.type === 'dropper' ? 120 : 210 + Math.random() * 60) : 95 + Math.random() * 20;
          o.frequency.value = base; o2.frequency.value = base * 1.012;
          lfo.frequency.value = quad ? 2.5 : 0.6; lg.gain.value = base * (quad ? 0.06 : 0.02); lfo.connect(lg); lg.connect(o.frequency); lg.connect(o2.frequency);
          f.type = 'lowpass'; f.frequency.value = jet ? 2500 : 1800;
          p.panningModel = 'HRTF'; p.distanceModel = 'inverse'; p.refDistance = 60; p.rolloffFactor = 1.2;
          g.gain.value = 0; o.connect(f); o2.connect(f); f.connect(g).connect(p).connect(dronesBus);
          o.start(); o2.start(); lfo.start();
          b = { o, o2, lfo, g, p }; buzz.set(tg.id, b);
          g.gain.setTargetAtTime(jet ? 0.25 : 0.12, ac.currentTime, 0.5);
        }
        const q = targetPos(tg, t, E.dt);
        if (b.p.positionX) { b.p.positionX.value = q[0]; b.p.positionY.value = q[2]; b.p.positionZ.value = -q[1]; } else b.p.setPosition(q[0], q[2], -q[1]);
      }
    },
    dispose: () => {
      removeEventListener('pointerdown', resume); removeEventListener('keydown', resume);
      for (const b of buzz.values()) { try { b.o.stop(); b.o2.stop(); b.lfo.stop(); } catch { /* stopped */ } }
      void ac.close();
    },
  };
}
