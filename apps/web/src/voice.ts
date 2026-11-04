// Push-to-talk radio (bottom-left mic, on every screen). Hold the mic button, or the ` key, to talk; release to stop.
// Speech goes live through the unit server to every other station on the same net: the whole unit ("UNIT" net), or
// the crew in a LAN crew drill ("CREW <code>"). Nothing is recorded. Offline (no unit server) the mic says so.
// Audio: the microphone is captured, cut to 16 kHz 16-bit mono and sent in ~0.12 s chunks; received chunks are queued
// per station and played through a band-pass filter, so it sounds like a radio. Callsigns are anonymous (no names).
import { api } from './online';
import { toast } from './toast';

const SR = 16000, CHUNK_S = 0.12, KEY = 'parashurama.station';
let online = false, net = 'unit', crewSeat: string | null = null, station = '';
let es: EventSource | null = null, ctx: AudioContext | null = null, out: AudioNode | null = null;
let stream: MediaStream | null = null, proc: ScriptProcessorNode | null = null, src: MediaStreamAudioSourceNode | null = null;
let talking = false, seq = 0, pend: Int16Array[] = [], pendN = 0, peers = 0, rx = 0, tx = 0;
const nextAt = new Map<string, number>(), speaking = new Map<string, number>();
let btn: HTMLButtonElement, info: HTMLElement;

/** Anonymous callsign for this browser ("Station 4F2"), kept between visits; the crew seat replaces it in a crew drill. */
function myStation(): string {
  let s = ''; try { s = localStorage.getItem(KEY) ?? ''; } catch { /* private mode */ }
  if (!/^Station [0-9A-F]{3}$/.test(s)) { s = `Station ${Math.floor(Math.random() * 4096).toString(16).toUpperCase().padStart(3, '0')}`; try { localStorage.setItem(KEY, s); } catch { /* ignore */ } }
  return s;
}
const callsign = () => crewSeat ?? station;
const netLabel = () => (net === 'unit' ? 'UNIT' : `CREW ${net.slice(5)}`);

function audio(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext();
    // Radio voice: band-pass 300 Hz–3.4 kHz and a little drive.
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 300;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3400;
    const g = ctx.createGain(); g.gain.value = 1.4;
    hp.connect(lp).connect(g).connect(ctx.destination); out = hp;
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}
const b64 = (a: Int16Array) => { const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s: string) => { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return new Int16Array(u.buffer); };

/** A short squelch click at the start and end of a transmission (receiving side). */
function click(c: AudioContext, at: number) {
  const n = Math.round(c.sampleRate * 0.04), buf = c.createBuffer(1, n, c.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * 0.25 * (1 - i / n);
  const s = c.createBufferSource(); s.buffer = buf; s.connect(out!); s.start(at);
}
function play(from: string, sr: number, pcm: Int16Array) {
  const c = audio(), buf = c.createBuffer(1, pcm.length, sr), d = buf.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) d[i] = pcm[i] / 32768;
  const s = c.createBufferSource(); s.buffer = buf; s.connect(out!);
  // A small jitter buffer per station: start 0.15 s behind, then play chunks back to back.
  const at = Math.max(c.currentTime + 0.15, nextAt.get(from) ?? 0);
  s.start(at); nextAt.set(from, at + buf.duration);
}

function listen() {
  es?.close(); es = null; peers = 0;
  if (!online) { render(); return; }
  es = new EventSource(`/api/voice/${net}/events?station=${encodeURIComponent(callsign())}`);
  es.addEventListener('peers', (e: MessageEvent) => { peers = JSON.parse(e.data).n; render(); });
  es.addEventListener('talk', (e: MessageEvent) => {
    const d = JSON.parse(e.data);
    if (d.on) speaking.set(d.from, Date.now()); else speaking.delete(d.from);
    if (ctx) click(ctx, Math.max(ctx.currentTime, nextAt.get(d.from) ?? 0));
    render();
  });
  es.addEventListener('audio', (e: MessageEvent) => { const d = JSON.parse(e.data); speaking.set(d.from, Date.now()); rx++; play(d.from, d.sr, unb64(d.pcm)); render(); });
  es.onerror = () => { peers = 0; render(); };
}

async function flush(force = false) {
  if (!pendN || (!force && pendN < SR * CHUNK_S)) return;
  const a = new Int16Array(pendN); let o = 0; for (const p of pend) { a.set(p, o); o += p.length; }
  pend = []; pendN = 0; tx++;
  api(`/api/voice/${net}`, { method: 'POST', body: JSON.stringify({ station: callsign(), seq: seq++, sr: SR, pcm: b64(a) }) }).catch(() => undefined);
}

async function start() {
  if (talking) return;
  if (!online) { toast('Radio needs the unit server: start the app with the server to talk to your crew.'); return; }
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) { toast('The microphone needs a secure page: open the unit server by its https:// address.'); return; }
  talking = true; render();
  try {
    const c = audio();
    stream ??= await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    if (!talking) return; // released while the permission prompt was up
    src = c.createMediaStreamSource(stream);
    proc = c.createScriptProcessor(4096, 1, 1);
    const k = c.sampleRate / SR;
    proc.onaudioprocess = (e) => {
      if (!talking) return;
      const x = e.inputBuffer.getChannelData(0), n = Math.floor(x.length / k), y = new Int16Array(n);
      // Cut to 16 kHz by averaging (a simple anti-alias filter), then to 16-bit.
      for (let i = 0; i < n; i++) { let s = 0, m = 0; for (let j = Math.floor(i * k); j < Math.floor((i + 1) * k); j++) { s += x[j]; m++; } y[i] = Math.max(-32768, Math.min(32767, Math.round((s / (m || 1)) * 32767))); }
      pend.push(y); pendN += n; void flush();
    };
    const mute = c.createGain(); mute.gain.value = 0;
    src.connect(proc).connect(mute).connect(c.destination);
    api(`/api/voice/${net}`, { method: 'POST', body: JSON.stringify({ station: callsign(), seq: seq++, on: true }) }).catch(() => undefined);
  } catch {
    talking = false; render();
    toast('Microphone blocked: allow the microphone for this page to use the radio.');
  }
}
function stop() {
  if (!talking) return;
  talking = false;
  void flush(true);
  proc?.disconnect(); src?.disconnect(); proc = null; src = null;
  if (online) api(`/api/voice/${net}`, { method: 'POST', body: JSON.stringify({ station: callsign(), seq: seq++, on: false }) }).catch(() => undefined);
  render();
}

function render() {
  if (!btn) return;
  const now = Date.now();
  for (const [k, t] of speaking) if (now - t > 1500) speaking.delete(k);
  const who = [...speaking.keys()];
  btn.classList.toggle('on', talking); btn.classList.toggle('off', !online); btn.classList.toggle('rx', !!who.length && !talking);
  btn.setAttribute('aria-pressed', String(talking));
  btn.title = online ? `Hold to talk on the ${netLabel()} net (or hold the \` key). You are ${callsign()}.` : 'Radio: needs the unit server';
  info.textContent = talking ? `TRANSMITTING · ${netLabel()}` : who.length ? `${who.join(', ')} talking` : online ? `${netLabel()} · ${peers ? `${Math.max(0, peers - 1)} other${peers === 2 ? '' : 's'} listening` : 'connecting…'}` : 'OFFLINE';
}

/** Switch nets: a crew drill puts this station on its crew's net under its seat name; leaving it returns to the unit net. */
export function setVoiceNet(crew: { code: string; seat: 'cr' | 'gun' | null } | null) {
  const n = crew ? `crew-${crew.code}` : 'unit', seat = crew?.seat === 'cr' ? 'Control Room' : crew?.seat === 'gun' ? 'Gun' : null;
  if (n === net && seat === crewSeat) return;
  stop(); net = n; crewSeat = seat; nextAt.clear(); speaking.clear(); listen();
}

export function initVoice(o: { online: boolean }) {
  online = o.online; station = myStation();
  const w = document.createElement('div'); w.id = 'radio';
  w.innerHTML = '<button id="micBtn" type="button" aria-label="Push to talk"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-3.1A7 7 0 0 0 19 11z"/></svg></button><span id="micInfo"></span>';
  document.body.appendChild(w);
  btn = w.querySelector('#micBtn')!; info = w.querySelector('#micInfo')!;
  btn.addEventListener('pointerdown', (e) => { e.preventDefault(); btn.setPointerCapture(e.pointerId); void start(); });
  btn.addEventListener('pointerup', stop); btn.addEventListener('pointercancel', stop); btn.addEventListener('lostpointercapture', stop);
  const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  addEventListener('keydown', (e) => { if (e.code !== 'Backquote' || typing(e.target)) return; e.preventDefault(); e.stopImmediatePropagation(); if (!e.repeat) void start(); }, true);
  addEventListener('keyup', (e) => { if (e.code !== 'Backquote') return; e.preventDefault(); e.stopImmediatePropagation(); stop(); }, true);
  addEventListener('blur', stop);
  setInterval(render, 700);
  listen(); render();
  (window as any).PARA_VOICE = { state: () => ({ online, net, station: callsign(), talking, peers, rx, tx }) };
}
