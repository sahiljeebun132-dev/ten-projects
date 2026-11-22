// Aria — app shell: hash router + settings.
import { homeView } from './views/home.js';
import { learnView } from './views/learn.js';
import { lessonView } from './views/lesson.js';
import { practiceView } from './views/practice.js';
import { rangeView } from './views/range.js';
import { coachView } from './views/coach.js';
import { songsView } from './views/songs.js';
import { songView } from './views/song.js';
import { engine, updateInputPill } from './engine.js';
import { state as store, setSetting, resetProgress } from './store.js';
import { modal, toast } from './ui/dom.js';

const ROUTES = {
  home: homeView,
  learn: learnView,
  lesson: lessonView,
  practice: practiceView,
  range: rangeView,
  coach: coachView,
  songs: songsView,
  song: songView,
};
const TAB_FOR = { lesson: 'learn', practice: 'learn', range: 'home', song: 'songs' };

let cleanup = null;

function route() {
  try {
    cleanup?.();
  } catch (err) {
    console.error(err);
  }
  cleanup = null;
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  const name = ROUTES[parts[0]] ? parts[0] : 'home';
  const params = parts.slice(1).map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });
  const tab = TAB_FOR[name] || name;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  const el = document.getElementById('view');
  el.innerHTML = '';
  window.scrollTo(0, 0);
  try {
    cleanup = ROUTES[name](el, params) || null;
  } catch (err) {
    console.error(err);
    el.innerHTML = '<div class="card"><h2>Something went wrong</h2><p class="muted">Try going back home.</p><a class="btn" href="#/home">Home</a></div>';
  }
}

function openSettings() {
  const s = store.settings;
  const m = modal(`
    <h2>⚙️ Settings</h2>
    <div class="stack">
      <div>
        <div class="small muted" style="margin-bottom:6px">Voice input</div>
        <div class="seg" id="input-seg">
          <button data-v="mic" class="${s.input === 'mic' ? 'on' : ''}">🎤 Microphone</button>
          <button data-v="demo" class="${s.input === 'demo' ? 'on' : ''}">🤖 Demo voice</button>
        </div>
        <p class="small dim" style="margin:6px 0 0">The demo voice is a simulated singer — handy to try Aria without a mic.</p>
      </div>
      <label class="toggle"><span>🗣️ Spoken coaching<br><span class="small dim">Says “higher”, “lower”, “perfect” out loud. Best with headphones.</span></span><input type="checkbox" id="speak" ${s.speak ? 'checked' : ''}></label>
      <label class="field">Guide volume <input type="range" id="gv" min="0" max="1" step="0.05" value="${s.guideVolume}"></label>
      <label class="field">Song volume <input type="range" id="bv" min="0" max="1" step="0.05" value="${s.backingVolume}"></label>
      <hr style="border:0;border-top:1px solid var(--line);margin:4px 0">
      <p class="small dim" style="margin:0">Progress is saved in this browser only. Audio never leaves your device — song search just asks Apple’s public catalogue for previews.</p>
      <div class="row between"><button class="btn danger small" id="reset">Reset all progress</button><button class="btn small" id="done">Done</button></div>
    </div>`);
  m.el.querySelector('#input-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    setSetting('input', b.dataset.v);
    m.el.querySelectorAll('#input-seg button').forEach((x) => x.classList.toggle('on', x === b));
    engine.input?.detach(); // reconnects with the new source on next start
    updateInputPill();
  });
  m.el.querySelector('#speak').addEventListener('change', (e) => setSetting('speak', e.target.checked));
  m.el.querySelector('#gv').addEventListener('input', (e) => {
    setSetting('guideVolume', Number(e.target.value));
    engine.guide?.setVolume(Number(e.target.value));
  });
  m.el.querySelector('#bv').addEventListener('input', (e) => setSetting('backingVolume', Number(e.target.value)));
  m.el.querySelector('#done').addEventListener('click', () => {
    m.close();
    route();
  });
  m.el.querySelector('#reset').addEventListener('click', () => {
    if (!confirm('Reset all lessons, XP, streak and your saved voice range? This cannot be undone.')) return;
    resetProgress();
    m.close();
    toast('Progress reset', 'good');
    location.hash = '#/home';
    route();
  });
}

document.getElementById('settings-btn').addEventListener('click', openSettings);
document.getElementById('input-pill').addEventListener('click', openSettings);
window.addEventListener('hashchange', route);
updateInputPill();
route();
