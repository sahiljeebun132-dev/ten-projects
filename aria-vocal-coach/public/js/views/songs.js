import { esc, toast } from '../ui/dom.js';
import { SONGS } from '../data/songs.js';
import { handoff } from '../engine.js';

const memory = { q: '', results: [] };

export function songsView(el) {
  el.innerHTML = `
    <h1>🎵 Songs</h1>
    <p class="muted">Sing classics with a guide, or search almost any song — Aria listens to the track, finds the sung melody and coaches you onto it.</p>

    <div class="section-title"><h2>🔍 Find any song</h2></div>
    <div class="card stack">
      <form class="search" id="search" role="search">
        <input type="search" id="q" placeholder="Song or artist — e.g. “Someone Like You”" maxlength="100" value="${esc(memory.q)}" autocomplete="off" aria-label="Search songs" />
        <button class="btn" type="submit">Search</button>
      </form>
      <p class="small dim" style="margin:0">Uses Apple’s free 30-second song previews. Melody detection works best on songs with a clear lead vocal.</p>
      <div id="results"></div>
    </div>

    <div class="section-title"><h2>🎤 Your own audio</h2></div>
    <label class="file-drop">
      <input type="file" id="file" accept="audio/*" />
      <span style="font-size:1.8rem">📁</span>
      <span><b>Upload a song or a vocal recording</b><br><span class="small muted">MP3, WAV, M4A… analysed on your device — nothing is uploaded. A cappella tracks give the best results.</span></span>
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

  const results = el.querySelector('#results');
  const renderResults = () => {
    if (!memory.results.length) {
      results.innerHTML = memory.q ? '<p class="muted">No previews found for that search. Try the artist name too.</p>' : '';
      return;
    }
    results.innerHTML = memory.results
      .map(
        (r, i) => `
        <button class="song-row" data-i="${i}">
          ${r.artwork ? `<img class="song-art" src="${esc(r.artwork)}" alt="" loading="lazy" />` : '<div class="song-art">🎵</div>'}
          <div class="song-meta"><b>${esc(r.title)}</b><span>${esc(r.artist)}${r.album ? ` · ${esc(r.album)}` : ''}</span></div>
          <span class="pill">Sing →</span>
        </button>`,
      )
      .join('');
  };
  renderResults();

  results.addEventListener('click', (e) => {
    const row = e.target.closest('[data-i]');
    if (!row) return;
    const r = memory.results[Number(row.dataset.i)];
    const key = `web:${r.id}`;
    if (!handoff.songs.has(key)) handoff.songs.set(key, { source: 'web', ...r });
    location.hash = `#/song/${encodeURIComponent(key)}`;
  });

  el.querySelector('#search').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = el.querySelector('#q').value.trim();
    if (!q) return;
    memory.q = q;
    results.innerHTML = '<p class="muted"><span class="spinner"></span> Searching…</p>';
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Search failed');
      memory.results = data.results;
      renderResults();
    } catch (err) {
      results.innerHTML = `<p class="muted">⚠️ ${esc(err.message)}</p>`;
    }
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
