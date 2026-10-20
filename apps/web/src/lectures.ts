// Classroom library: training videos (MP4 / WebM / Ogg) and notes (PDF, images, text précis) for self-study between drills.
// Online (unit server): instructors upload once and every trainee can watch; files stream with range requests.
// Offline (single file, static hosting): lectures are stored in this browser's IndexedDB and stay on this device.
import { app, hooks } from './app';
import { $ } from './dom';
import { api } from './online';
import { toast } from './toast';

export const TOPICS = ['Basics', 'Threat recognition', 'Sensors', 'Effectors', 'Doctrine and ROE', 'Exercises', 'Control Room', 'On Ground (gun)', 'UAV GCS', 'Live-fire safety', 'Other'];
const VIDEO = ['video/mp4', 'video/webm', 'video/ogg'], NOTES = ['application/pdf', 'image/png', 'image/jpeg', 'text/plain', 'text/markdown'];
const TYPES = [...VIDEO, ...NOTES];
const isVideo = (m: string) => VIDEO.includes(m);
/** Some systems give .md files no type: treat them as Markdown text. */
const typeOf = (f: File) => f.type || (/\.md$/i.test(f.name) ? 'text/markdown' : /\.txt$/i.test(f.name) ? 'text/plain' : '');
interface Lecture { id: number; title: string; topic: string; description: string; mime: string; size: number; duration: number | null; created: number; author?: string | null; }
interface Store {
  where: string; list(): Promise<Lecture[]>; src(l: Lecture): Promise<string>;
  add(f: File, meta: { title: string; topic: string; description: string; duration: number | null }, progress: (p: number) => void): Promise<void>;
  remove(id: number): Promise<void>;
}
let ctx: { online: boolean; user: any | null };
let store: Store;
let filter = 'All', playing: { id: number; url: string; local: boolean } | null = null;

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const mb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(n >= 104857600 ? 0 : 1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const mins = (s: number | null) => (s == null ? '' : s < 60 ? `${Math.round(s)} s` : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`);
const key = (id: number) => `${ctx.online ? 's' : 'l'}:${id}`;
const watched = (): string[] => (app.DB.settings.watched ??= []);
function markWatched(id: number) { const w = watched(); if (!w.includes(key(id))) { w.push(key(id)); app.saveDB(); } }

// ---------- unit server ----------
const serverStore: Store = {
  where: 'Saved on the unit server for everyone in the unit.',
  list: async () => (await api('/api/lectures')).lectures,
  src: async (l) => `/api/lectures/${l.id}/video`,
  add: (f, m, progress) => new Promise((resolve, reject) => {
    // XHR, not fetch, so a large upload can show progress.
    const q = new URLSearchParams({ title: m.title, topic: m.topic, description: m.description, ...(m.duration != null ? { duration: String(Math.round(m.duration * 10) / 10) } : {}) });
    const x = new XMLHttpRequest(); x.open('POST', `/api/lectures?${q}`); x.setRequestHeader('content-type', f.type);
    x.upload.onprogress = (e) => e.lengthComputable && progress(e.loaded / e.total);
    x.onload = () => (x.status < 300 ? resolve() : reject(new Error((() => { try { return JSON.parse(x.responseText).error; } catch { return x.statusText; } })())));
    x.onerror = () => reject(new Error('Network error during upload'));
    x.send(f);
  }),
  remove: async (id) => { await api(`/api/lectures/${id}`, { method: 'DELETE' }); },
};

// ---------- this browser (IndexedDB) ----------
const idb = (): Promise<IDBDatabase> => new Promise((res, rej) => {
  const r = indexedDB.open('parashurama-lectures', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('lectures', { keyPath: 'id', autoIncrement: true });
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await idb();
  return new Promise((res, rej) => { const t = d.transaction('lectures', mode), q = fn(t.objectStore('lectures')); t.oncomplete = () => { d.close(); res(q.result); }; t.onerror = t.onabort = () => { d.close(); rej(t.error ?? q.error); }; });
}
const localStore: Store = {
  where: 'Offline mode: saved in this browser on this device only.',
  list: async () => ((await tx('readonly', (s) => s.getAll())) as any[]).map(({ blob, ...l }) => l).sort((a, b) => a.topic.localeCompare(b.topic) || a.created - b.created),
  src: async (l) => URL.createObjectURL(((await tx('readonly', (s) => s.get(l.id))) as any).blob),
  add: async (f, m, progress) => {
    try { await navigator.storage?.persist?.(); } catch { /* best effort: ask the browser not to evict lectures */ }
    progress(0.5);
    await tx('readwrite', (s) => s.add({ ...m, mime: f.type, size: f.size, created: Date.now(), blob: f }));
    progress(1);
  },
  remove: async (id) => { await tx('readwrite', (s) => s.delete(id)); },
};

/** Video length from the file's metadata (null if the browser cannot read it). */
function durationOf(f: File): Promise<number | null> {
  return new Promise((res) => {
    const v = document.createElement('video'), url = URL.createObjectURL(f);
    const done = (d: number | null) => { URL.revokeObjectURL(url); res(d != null && Number.isFinite(d) ? d : null); };
    v.preload = 'metadata'; v.onloadedmetadata = () => done(v.duration); v.onerror = () => done(null);
    setTimeout(() => done(null), 4000); v.src = url;
  });
}
const canEdit = () => (ctx.online ? ['instructor', 'admin'].includes(ctx.user?.role) : true);

function stopPlayer() { if (playing?.local) URL.revokeObjectURL(playing.url); playing = null; }
export function closeLectures() { stopPlayer(); $('#lectures')?.remove(); }

async function render() {
  const o = $('#lectures'); if (!o) return;
  let list: Lecture[] = [];
  try { list = await store.list(); } catch (e: any) { $('#lecList').innerHTML = `<p class="bad">Could not load lectures: ${esc(e.message)}</p>`; return; }
  const w = new Set(watched());
  const topics = ['All', ...TOPICS.filter((t) => list.some((l) => l.topic === t))];
  if (!topics.includes(filter)) filter = 'All';
  $('#lecTopics').innerHTML = topics.length > 2 ? topics.map((t) => `<button class="lecChip ${t === filter ? 'on' : ''}" data-topic="${esc(t)}">${esc(t)}</button>`).join('') : '';
  const shown = list.filter((l) => filter === 'All' || l.topic === filter);
  $('#lecCount').textContent = list.length ? `${list.length} lecture${list.length > 1 ? 's' : ''} · ${list.filter((l) => w.has(key(l.id))).length} watched` : '';
  $('#lecList').innerHTML = !list.length
    ? `<div class="lecEmpty"><b>No lectures yet.</b><span>${canEdit() ? 'Add a training video or notes below.' : 'Your instructor has not added any lectures yet.'}</span></div>`
    : shown.map((l) => `<div class="lecItem ${playing?.id === l.id ? 'on' : ''}">
        <button class="lecPlay" data-play="${l.id}" aria-label="Play ${esc(l.title)}"><i aria-hidden="true">${w.has(key(l.id)) ? '✓' : isVideo(l.mime) ? '▶' : '📄'}</i>
          <span><b>${esc(l.title)}</b><small>${esc(l.topic)}${isVideo(l.mime) ? '' : ` · ${l.mime === 'application/pdf' ? 'PDF notes' : l.mime.startsWith('image/') ? 'Image' : 'Text notes'}`}${l.duration != null ? ' · ' + mins(l.duration) : ''} · ${mb(l.size)}${l.author ? ' · ' + esc(l.author) : ''}</small>${l.description ? `<em>${esc(l.description)}</em>` : ''}</span></button>
        ${canEdit() ? `<button class="smallBtn lecDel" data-del="${l.id}" aria-label="Delete ${esc(l.title)}">Delete</button>` : ''}</div>`).join('');
}

async function play(id: number) {
  const l = (await store.list()).find((x) => x.id === id); if (!l) return;
  stopPlayer();
  const url = await store.src(l);
  playing = { id, url, local: !ctx.online };
  const now = `<div class="lecNow"><b>${esc(l.title)}</b><span>${esc(l.topic)}${l.description ? ' · ' + esc(l.description) : ''}</span></div>`;
  if (!isVideo(l.mime)) {
    // Notes: images and text shown here; PDFs open in a new tab (the server forbids embedding pages in frames).
    if (l.mime.startsWith('image/')) $('#lecPlayer').innerHTML = `<img class="lecImg" alt="${esc(l.title)}" src="${esc(url)}">${now}`;
    else if (l.mime === 'application/pdf') $('#lecPlayer').innerHTML = `<div class="lecPdf"><a class="smallBtn solid" href="${esc(url)}" target="_blank" rel="noopener">Open the PDF notes ↗</a></div>${now}`;
    else { $('#lecPlayer').innerHTML = `<pre class="lecText">Loading…</pre>${now}`; try { ($('#lecPlayer .lecText') as HTMLElement).textContent = await (await fetch(url)).text(); } catch { toast('Could not open these notes'); } }
    markWatched(id); render(); $('#lecPlayer').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); return;
  }
  $('#lecPlayer').innerHTML = `<video controls autoplay playsinline preload="metadata" src="${esc(url)}"></video>${now}`;
  const v = $('#lecPlayer video') as HTMLVideoElement;
  v.onerror = () => toast('This browser cannot play this video. Try MP4 (H.264) or WebM.');
  v.ontimeupdate = () => { if (v.duration && v.currentTime / v.duration > 0.9) markWatched(id); };
  v.onended = () => { markWatched(id); render(); };
  render();
  $('#lecPlayer').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

export async function openLectures() {
  closeLectures();
  const o = document.createElement('div'); o.className = 'overlay'; o.id = 'lectures';
  o.innerHTML = `<div class="sheet lecSheet" role="dialog" aria-label="Classroom library">
    <div class="sheetHead"><h2>Classroom library</h2><span class="lecCount" id="lecCount"></span><button class="smallBtn" id="lecClose">Close</button></div>
    <p class="note" style="padding:0 0 8px">${store.where} Videos and notes from your instructors, by course: study them between drills.</p>
    <div class="lecPlayer" id="lecPlayer"></div>
    <div class="lecTopics" id="lecTopics"></div>
    <div class="lecList" id="lecList"><p class="note">Loading…</p></div>
    ${canEdit() ? `<form class="card lecAdd" id="lecAdd"><div class="cardHead"><h3>Add a lecture or notes</h3><span>Video (MP4, WebM, Ogg) or notes (PDF, PNG, JPEG, text)</span></div>
      <div class="edForm"><div class="row">
        <label>File<input type="file" id="lecFile" accept="${TYPES.join(',')},.md,.txt" required></label>
        <label>Title<input id="lecTitle" maxlength="120" required placeholder="e.g. Reading the RF clue"></label>
        <label>Topic<select id="lecTopic">${TOPICS.map((t) => `<option>${esc(t)}</option>`).join('')}</select></label></div>
        <label>Description (optional)<input id="lecDesc" maxlength="1000" placeholder="What the trainee will learn"></label>
        <div class="edActions"><button class="solid" type="submit" id="lecSave">Add lecture</button><progress id="lecProg" max="1" value="0" hidden></progress><span class="edMsg" id="lecMsg"></span></div></div></form>` : ''}
  </div>`;
  document.body.appendChild(o);
  $('#lecClose').onclick = closeLectures;
  // Keep the app's shortcuts (Enter = begin drill, M, L, V…) from firing while the library is open or someone is typing.
  o.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') closeLectures(); });
  o.addEventListener('click', async (e: any) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.topic) { filter = b.dataset.topic; render(); }
    if (b.dataset.play) play(+b.dataset.play);
    if (b.dataset.del) {
      if (!confirm('Delete this lecture for everyone? This cannot be undone.')) return;
      try { if (playing?.id === +b.dataset.del) { stopPlayer(); $('#lecPlayer').innerHTML = ''; } await store.remove(+b.dataset.del); toast('Lecture deleted'); render(); }
      catch (err: any) { toast(err.message || 'Could not delete the lecture'); }
    }
  });
  const form = $('#lecAdd') as HTMLFormElement | null;
  if (form) form.onsubmit = async (e) => {
    e.preventDefault();
    const f = ($('#lecFile') as HTMLInputElement).files?.[0], title = ($('#lecTitle') as HTMLInputElement).value.trim();
    const msg = $('#lecMsg'), prog = $('#lecProg') as HTMLProgressElement, btn = $('#lecSave') as HTMLButtonElement;
    if (!f || !title) { msg.innerHTML = '<b class="bad">Choose a file and give it a title.</b>'; return; }
    const mime = typeOf(f);
    if (!TYPES.includes(mime)) { msg.innerHTML = '<b class="bad">Use a video (MP4, WebM, Ogg) or notes (PDF, PNG, JPEG, text).</b>'; return; }
    const file = mime === f.type ? f : new File([f], f.name, { type: mime });
    btn.disabled = true; prog.hidden = false; prog.value = 0; msg.textContent = 'Uploading…';
    try {
      await store.add(file, { title, topic: ($('#lecTopic') as HTMLSelectElement).value, description: ($('#lecDesc') as HTMLInputElement).value.trim(), duration: isVideo(mime) ? await durationOf(file) : null }, (p) => (prog.value = p));
      form.reset(); msg.innerHTML = '<b class="good">Lecture added ✓</b>'; render();
    } catch (err: any) {
      msg.innerHTML = `<b class="bad">Not added:</b> ${esc(err?.name === 'QuotaExceededError' ? 'this browser has no room left for the video. Free up space or use the unit server.' : err?.message || 'unknown error')}`;
    } finally { btn.disabled = false; prog.hidden = true; }
  };
  render();
}

export function initLectures(c: { online: boolean; user: any | null }) {
  ctx = c; store = c.online ? serverStore : localStore;
  hooks.openLectures = openLectures;
  if (new URLSearchParams(location.search).has('lectures')) openLectures();
}
