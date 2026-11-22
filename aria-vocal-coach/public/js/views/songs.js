import { esc, toast } from '../ui/dom.js';
import { SONGS } from '../data/songs.js';
import { handoff } from '../engine.js';
import { state as store, setSetting } from '../store.js';

const CHARTS = [
  ['bollywood', '🎬 Bollywood Top 50'],
  ['indipop', '💖 Indian Pop'],
  ['sufi', '🕌 Sufi & Ghazals'],
  ['devotional', '🙏 Bhakti'],
  ['classical', '🎻 Classical'],
];
const SINGERS = ['Arijit Singh', 'Shreya Ghoshal', 'Kishore Kumar', 'Lata Mangeshkar', 'Mohammed Rafi', 'Atif Aslam', 'Sonu Nigam', 'Jubin Nautiyal', 'Asha Bhosle', 'Jagjit Singh', 'A. R. Rahman', 'Udit Narayan', 'Alka Yagnik', 'KK', 'Neha Kakkar', 'Nusrat Fateh Ali Khan'];

const memory = { q: '', results: [], label: '', shown: 20 };

export function songsView(el) {
  const market = () => (store.settings.market === 'us' ? 'us' : 'in');
  el.innerHTML = `
    <h1>🎵 Songs</h1>
    <p class="muted">Search almost any song — Hindi, Bollywood or international. Aria listens to the track, finds the sung melody and coaches you onto it.</p>

    <div class="section-title"><h2>🔍 Find any song</h2>
      <div class="seg" id="mkt" style="grid-template-columns:auto auto"><button data-v="in" class="${market() === 'in' ? 'on' : ''}">🇮🇳 Hindi &amp; India</button><button data-v="us" class="${market() === 'us' ? 'on' : ''}">🌍 Global</button></div>
    </div>
    <div class="card stack">
      <form class="search" id="search" role="search">
        <input type="search" id="q" maxlength="100" value="${esc(memory.q)}" autocomplete="off" aria-label="Search songs" />
        <button class="btn" type="submit">Search</button>
      </form>
      <div>
        <div class="small muted" style="margin-bottom:6px">🔥 Live Indian charts</div>
        <div class="chips">${CHARTS.map(([id, label]) => `<button class="chip" data-chart="${id}">${label}</button>`).join('')}</div>
      </div>
      <div>
        <div class="small muted" style="margin-bottom:6px">🎤 Singers</div>
        <div class="chips">${SINGERS.map((s) => `<button class="chip" data-artist="${esc(s)}">${esc(s)}</button>`).join('')}</div>
      </div>
      <p class="small dim" style="margin:0">Uses Apple’s free 30-second previews. Melody detection works best on songs with a clear lead vocal.</p>
      <div id="results"></div>
    </div>

    <div class="section-title"><h2>🎤 Your own audio</h2></div>
    <label class="file-drop">
      <input type="file" id="file" accept="audio/*" />
      <span style="font-size:1.8rem">📁</span>
      <span><b>Upload a song or a vocal recording</b><br><span class="small muted">MP3, WAV, M4A… analysed on your device — nothing is uploaded. Full songs work too, not just previews. A cappella tracks give the best results.</span></span>
    </label>

    <div class="section-title"><h2>⭐ Classics</h2><span class="small muted">Public domain · with lyrics</span></div>
    <div class="grid two">
      ${SONGS.map(
        (s) => `
        <a class="card song-row" href="#/song/builtin:${esc(s.id)}">
          <div class="song-art">${s.icon}</div>
          <div class="song-meta"><b>${esc(s.title)}</b><span>${esc(s.artist)}</span></div>
          <span class="pill ${s.difficulty === 'Easy' ? 'good' : s.difficulty === 'Hard' ? 'warn' : 'brand'}">${esc(s.difficulty)}</span>
        </a>`,
      ).join('')}
    </div>`;

  const q = el.querySelector('#q');
  const setPlaceholder = () => {
    q.placeholder = market() === 'in' ? 'Gaana ya singer — “Tum Hi Ho”, “Kishore Kumar”, or type in हिंदी' : 'Song or artist — e.g. “Someone Like You”';
  };
  setPlaceholder();

  const results = el.querySelector('#results');
  const renderResults = () => {
    if (!memory.results.length) {
      results.innerHTML = memory.label ? '<p class="muted">No previews found. Try the artist name too.</p>' : '';
      return;
    }
    const list = memory.results.slice(0, memory.shown);
    results.innerHTML = `
      <div class="small muted" style="margin:4px 0 6px">${esc(memory.label)} · ${memory.results.length} songs</div>
      ${list
        .map(
          (r, i) => `
        <button class="song-row" data-i="${i}">
          ${r.artwork ? `<img class="song-art" src="${esc(r.artwork)}" alt="" loading="lazy" />` : '<div class="song-art">🎵</div>'}
          <div class="song-meta"><b>${esc(r.title)}</b><span>${esc(r.artist)}${r.album ? ` · ${esc(r.album)}` : ''}</span></div>
          <span class="pill">Sing →</span>
        </button>`,
        )
        .join('')}
      ${memory.results.length > memory.shown ? '<div class="row" style="justify-content:center"><button class="btn ghost small" id="more">Show more</button></div>' : ''}`;
    results.querySelector('#more')?.addEventListener('click', () => {
      memory.shown += 20;
      renderResults();
    });
  };
  renderResults();

  async function load(url, label) {
    memory.label = label;
    memory.shown = 20;
    results.innerHTML = '<p class="muted"><span class="spinner"></span> Loading…</p>';
    try {
      const res = await fetch(url);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Search failed');
      memory.results = data.results;
      renderResults();
    } catch (err) {
      memory.results = [];
      results.innerHTML = `<p class="muted">⚠️ ${esc(err.message)}</p>`;
    }
  }
  const search = (text) => load(`/api/search?q=${encodeURIComponent(text)}&market=${market()}&limit=40`, `“${text}”`);

  el.querySelector('#mkt').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    setSetting('market', b.dataset.v);
    el.querySelectorAll('#mkt button').forEach((x) => x.classList.toggle('on', x === b));
    setPlaceholder();
  });
  el.querySelectorAll('[data-chart]').forEach((b) => b.addEventListener('click', () => load(`/api/charts?shelf=${b.dataset.chart}`, b.textContent)));
  el.querySelectorAll('[data-artist]').forEach((b) =>
    b.addEventListener('click', () => {
      memory.q = b.dataset.artist;
      q.value = memory.q;
      load(`/api/search?q=${encodeURIComponent(memory.q)}&market=in&limit=40`, b.dataset.artist);
    }),
  );

  results.addEventListener('click', (e) => {
    const row = e.target.closest('[data-i]');
    if (!row) return;
    const r = memory.results[Number(row.dataset.i)];
    const key = `web:${r.id}`;
    if (!handoff.songs.has(key)) handoff.songs.set(key, { source: 'web', ...r });
    location.hash = `#/song/${encodeURIComponent(key)}`;
  });

  el.querySelector('#search').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = q.value.trim();
    if (!text) return;
    memory.q = text;
    search(text);
  });

  el.querySelector('#file').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 60 * 1024 * 1024) return toast('That file is over 60 MB — try a shorter clip.', 'error');
    const key = `file:${Date.now()}`;
    handoff.songs.set(key, { source: 'file', file, title: file.name.replace(/\.[^.]+$/, ''), artist: 'Your audio' });
    location.hash = `#/song/${encodeURIComponent(key)}`;
  });
}
