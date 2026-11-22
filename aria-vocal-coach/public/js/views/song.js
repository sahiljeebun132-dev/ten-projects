// Song detail: analyse the melody, show its key & range vs. your voice, start practice.
import { esc } from '../ui/dom.js';
import { songById, melodyRange, fitShift, transpose } from '../data/songs.js';
import { handoff, engine, ensureContext } from '../engine.js';
import { analyzeSong } from '../audio/analyze.js';
import { detectKey } from '../audio/key.js';
import { noteName, NOTE_NAMES } from '../audio/notes.js';
import { placeSa, shiftToSa, harmoniumScale } from '../audio/sargam.js';
import { state as store, practiceRange, riyaazSa, styleForArtist, styleById } from '../store.js';

export function songView(el, [rawKey]) {
  const key = rawKey || '';
  let cancelled = false;
  let previewStop = null;

  if (key.startsWith('builtin:')) {
    const song = songById(key.slice(8));
    if (!song) {
      location.hash = '#/songs';
      return;
    }
    renderDetail({ title: song.title, artist: song.artist, icon: song.icon, notes: song.notes, bpm: song.bpm, builtin: true, key: detectKey(song.notes) });
    return cleanup;
  }

  const entry = handoff.songs.get(key);
  if (!entry) {
    location.hash = '#/songs';
    return;
  }
  if (entry.analysis) renderAnalysed();
  else analyse();
  return cleanup;

  function cleanup() {
    cancelled = true;
    previewStop?.();
  }

  async function analyse() {
    el.innerHTML = `
      <a class="back" href="#/songs">← Songs</a>
      <div class="card center stack" style="margin-top:14px">
        ${header(entry)}
        <h2>🎧 Listening to the song…</h2>
        <p class="muted" id="stage">Downloading preview</p>
        <div class="bar" style="max-width:420px;margin:0 auto"><span id="prog" style="width:3%"></span></div>
        <p class="small dim">Finding the lead melody, its key and range. This takes a few seconds.</p>
      </div>`;
    const prog = el.querySelector('#prog');
    const stage = el.querySelector('#stage');
    try {
      let data;
      if (entry.source === 'web') {
        const res = await fetch(`/api/preview?url=${encodeURIComponent(entry.previewUrl)}`);
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not download the preview.');
        data = await res.arrayBuffer();
      } else {
        stage.textContent = 'Reading your file';
        data = await entry.file.arrayBuffer();
      }
      if (cancelled) return;
      stage.textContent = 'Extracting the melody';
      const analysis = await analyzeSong(data, (p) => {
        if (!cancelled) prog.style.width = `${Math.round(p * 100)}%`;
      });
      if (cancelled) return;
      if (analysis.notes.length < 4) throw new Error('I couldn’t find a clear melody in this track. Try a song with a strong lead vocal, or an a cappella recording.');
      entry.analysis = analysis;
      renderAnalysed();
    } catch (err) {
      if (cancelled) return;
      el.querySelector('.card').innerHTML = `${header(entry)}<h2>⚠️ ${esc(err.message)}</h2><div><a class="btn ghost" href="#/songs">Back to songs</a></div>`;
    }
  }

  function renderAnalysed() {
    const a = entry.analysis;
    renderDetail({ title: entry.title, artist: entry.artist, artwork: entry.artwork, notes: a.notes, key: a.key, buffer: a.buffer, bpm: 100, songKey: key });
  }

  function renderDetail(song) {
    const range = practiceRange();
    const [lo, hi] = melodyRange(song.notes);
    const shift = fitShift(song.notes, range);
    const mid = (lo + hi) / 2;
    const tonic = song.key?.tonic ?? null;
    const songSa = tonic != null ? placeSa(tonic, mid - 6) : null;
    const mySa = riyaazSa();
    const saShift = tonic != null && mySa != null ? shiftToSa(tonic, mid, mySa) : null;
    const styles = Object.values(store.styles);
    const autoStyle = styleForArtist(song.artist);
    const oct = 12 * Math.round(shift / 12);
    const fits = lo >= range.low - 1 && hi <= range.high + 1;
    const fitsOct = !fits && oct !== 0 && lo + oct >= range.low - 2 && hi + oct <= range.high + 2;
    const fitMsg = fits
      ? ['good', '✓ Fits your voice in the original key.']
      : fitsOct
        ? ['brand', `Sing it an octave ${oct < 0 ? 'lower' : 'higher'} than the original — I score the note, not the octave.`]
        : ['warn', `The melody (${noteName(lo)}–${noteName(hi)}) sits outside your comfortable range. “My key” moves it ${shift > 0 ? 'up' : 'down'} ${Math.abs(shift)} semitone${Math.abs(shift) === 1 ? '' : 's'}.`];
    const duration = Math.max(...song.notes.map((n) => n.start + n.dur));

    el.innerHTML = `
      <a class="back" href="#/songs">← Songs</a>
      <div class="card glow stack" style="margin-top:14px">
        ${header(song)}
        <div class="row">
          ${song.key ? `<span class="pill brand">🎼 Key: ${esc(song.key.name)}</span><span class="pill gold">Sa = ${esc(NOTE_NAMES[tonic])} · ${esc(harmoniumScale(tonic))}</span>` : ''}
          <span class="pill">Melody ${noteName(lo)} – ${noteName(hi)}</span>
          <span class="pill">${song.notes.length} notes · ${Math.round(duration)}s</span>
          <span class="pill">Your range ${noteName(range.low)} – ${noteName(range.high)}</span>
        </div>
        <svg class="melody-map" viewBox="0 0 1000 100" preserveAspectRatio="none" aria-label="Melody shape">${melodyMap(song.notes, duration)}</svg>
        <p class="pill ${fitMsg[0]}" style="white-space:normal;display:block;border-radius:12px;padding:10px 12px;margin:0">${esc(fitMsg[1])}</p>
        ${
          styles.length
            ? `<label class="field small">🧑‍🏫 Coach my style like
                <select id="style-sel"><option value="">— just pitch & timing —</option>${styles
                  .map((s) => `<option value="${esc(s.id)}" ${autoStyle?.id === s.id ? 'selected' : ''}>${esc(s.singer)}</option>`)
                  .join('')}</select></label>`
            : `<p class="small dim" style="margin:0">Tip: teach the <a href="#/teacher">AI teacher</a> this singer’s style and it will coach you on their technique, not just the notes.</p>`
        }
      </div>

      <div class="grid two" style="margin-top:14px">
        ${
          song.buffer
            ? `<div class="card stack">
                <h3>🎵 Sing with the original</h3>
                <p class="small muted" style="margin:0">The real track plays while I coach you onto the singer’s melody, in the song’s own key.</p>
                <label class="toggle small"><span>Add a guide melody on top</span><input type="checkbox" id="guide-on"></label>
                <button class="btn" id="orig">▶ Sing with the song</button>
              </div>`
            : ''
        }
        <div class="card stack">
          <h3>🎹 ${song.builtin ? 'Sing it' : 'Guide melody in my key'}</h3>
          <p class="small muted" style="margin:0">${song.builtin ? 'A guide melody in your key, with the lyrics under each note.' : `Just the melody, moved ${shift === 0 ? '(no change needed)' : `${shift > 0 ? 'up' : 'down'} ${Math.abs(shift)} semitone${Math.abs(shift) === 1 ? '' : 's'}`} to sit perfectly in your voice.`}</p>
          <button class="btn ${song.buffer ? 'ghost' : ''}" id="mykey">▶ ${song.builtin ? 'Sing with guide' : 'Sing in my key'}</button>
          ${song.builtin ? '<button class="btn ghost" id="solo">🎤 Sing solo (first note only)</button>' : ''}
        </div>
        ${
          saShift != null
            ? `<div class="card stack">
                <h3>🪔 In my Sa (${esc(noteName(mySa))})</h3>
                <p class="small muted" style="margin:0">The melody moved ${saShift === 0 ? '(already in your Sa)' : `${saShift > 0 ? 'up' : 'down'} ${Math.abs(saShift)} semitone${Math.abs(saShift) === 1 ? '' : 's'}`} so its Sa is your riyaaz Sa — with the tanpura and sargam, like a real riyaaz session.</p>
                <button class="btn ghost" id="mysa">▶ Sing in my Sa</button>
              </div>`
            : ''
        }
        <div class="card stack">
          <h3>👂 Listen first</h3>
          <p class="small muted" style="margin:0">Hear the ${song.builtin ? '' : 'detected '}melody played on its own${song.builtin ? '' : ' — a good check of what I heard'}.</p>
          <button class="btn ghost" id="hear">🔊 Play melody</button>
        </div>
      </div>`;

    const go = (practice) => {
      const sid = el.querySelector('#style-sel')?.value;
      const picked = styleById(sid);
      const style = picked ? { id: picked.id, singer: picked.singer } : null;
      handoff.practice = { tolerance: 50, focus: 'song', bpm: song.bpm || 100, backHref: location.hash, style, songKey: song.songKey || song.title, ...practice };
      location.hash = `#/practice/${Date.now()}`;
    };
    const saAfter = (s) => (songSa == null ? null : songSa + s);
    el.querySelector('#orig')?.addEventListener('click', () =>
      go({
        title: song.title,
        subtitle: `${song.artist} — original track`,
        targets: song.notes.map((n) => ({ ...n, role: 'sing' })),
        backing: song.buffer,
        guideOnSing: el.querySelector('#guide-on').checked,
        sa: songSa,
        tanpura: false,
      }),
    );
    el.querySelector('#mykey').addEventListener('click', () =>
      go({
        title: song.title,
        subtitle: shift ? `In your key (${shift > 0 ? '+' : ''}${shift} semitones)` : 'In your key',
        targets: transpose(song.notes, shift).map((n) => ({ ...n, role: 'sing' })),
        tolerance: song.builtin ? 45 : 50,
        guideOnSing: true,
        sa: saAfter(shift),
        tanpura: false,
      }),
    );
    el.querySelector('#mysa')?.addEventListener('click', () =>
      go({
        title: song.title,
        subtitle: `In your Sa (${noteName(mySa)})${saShift ? ` · ${saShift > 0 ? '+' : ''}${saShift} semitones` : ''}`,
        targets: transpose(song.notes, saShift).map((n) => ({ ...n, role: 'sing' })),
        tolerance: song.builtin ? 45 : 50,
        guideOnSing: true,
        sa: mySa,
        tanpura: true,
      }),
    );
    el.querySelector('#solo')?.addEventListener('click', () => {
      const notes = transpose(song.notes, shift);
      const b = 60 / song.bpm;
      go({
        title: `${song.title} — solo`,
        subtitle: 'You hear the first note, then it’s all you.',
        targets: [{ midi: notes[0].midi, start: 0, dur: b * 1.5, role: 'listen' }, ...notes.map((n) => ({ ...n, start: n.start + 3 * b, role: 'sing' }))],
        tolerance: 40,
        guideOnSing: false,
        sa: saAfter(shift),
        tanpura: false,
      });
    });
    el.querySelector('#hear').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      if (previewStop) {
        previewStop();
        return;
      }
      const ctx = await ensureContext();
      const t0 = ctx.currentTime + 0.1;
      const notes = song.builtin ? transpose(song.notes, shift) : song.notes;
      const first = notes[0]?.start ?? 0;
      for (const n of notes) if (n.start - first < 20) engine.guide.note(n.midi, t0 + n.start - first, n.dur);
      btn.textContent = '■ Stop';
      const timer = setTimeout(() => previewStop?.(), Math.min(20, duration - first + 0.5) * 1000);
      previewStop = () => {
        clearTimeout(timer);
        engine.guide.stopAll();
        btn.textContent = '🔊 Play melody';
        previewStop = null;
      };
    });
  }
}

function header(s) {
  const art = s.artwork ? `<img class="song-art" src="${esc(s.artwork)}" alt="" />` : `<div class="song-art">${s.icon || '🎵'}</div>`;
  return `<div class="song-hero">${art}<div><h1 style="margin:0">${esc(s.title)}</h1><div class="muted">${esc(s.artist || '')}</div></div></div>`;
}

function melodyMap(notes, duration) {
  if (!notes.length) return '';
  const lo = Math.min(...notes.map((n) => n.midi)) - 1;
  const hi = Math.max(...notes.map((n) => n.midi)) + 1;
  const y = (m) => 92 - ((m - lo) / (hi - lo)) * 84;
  return notes
    .map((n) => `<rect x="${((n.start / duration) * 1000).toFixed(1)}" y="${(y(n.midi) - 3).toFixed(1)}" width="${Math.max(2, (n.dur / duration) * 1000).toFixed(1)}" height="6" rx="3" fill="url(#mm)"/>`)
    .join('')
    .concat('<defs><linearGradient id="mm" x1="0" x2="1"><stop offset="0" stop-color="#a855f7"/><stop offset="1" stop-color="#ec4899"/></linearGradient></defs>');
}
