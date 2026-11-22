import { esc, starsHtml } from '../ui/dom.js';
import { lessonById, levelOf, lessonPractice } from '../data/curriculum.js';
import { isUnlocked, lessonProgress, practiceRange, state as store } from '../store.js';
import { noteName } from '../audio/notes.js';
import { PitchCanvas } from '../ui/pitchCanvas.js';
import { handoff } from '../engine.js';

const MODE = {
  'listen-repeat': ['🎧→🎤', 'Listen & repeat', 'Hear each phrase (cyan), then sing it back (purple).'],
  'sing-along': ['🎤🎹', 'Sing along', 'Sing together with the guide melody.'],
  solo: ['🎤', 'Solo', 'You hear only the first note — then it’s all you.'],
};

export function lessonView(el, [id]) {
  const lesson = lessonById(id);
  if (!lesson) {
    location.hash = '#/learn';
    return;
  }
  if (lesson.kind === 'range') {
    location.hash = '#/range';
    return;
  }
  if (!isUnlocked(id)) {
    el.innerHTML = `<a class="back" href="#/learn">← Lesson path</a><div class="card" style="margin-top:14px"><h2>🔒 Locked</h2><p class="muted">Pass the previous lesson to unlock “${esc(lesson.title)}”.</p></div>`;
    return;
  }
  const level = levelOf(id);
  const pr = lessonProgress(id);
  const range = practiceRange();
  const practice = lessonPractice(lesson, range);
  const mode = MODE[lesson.mode] || MODE['sing-along'];
  const sing = practice.targets.filter((t) => t.role !== 'listen');
  const lo = Math.min(...sing.map((t) => Math.min(t.midi, t.glideTo ?? t.midi)));
  const hi = Math.max(...sing.map((t) => Math.max(t.midi, t.glideTo ?? t.midi)));
  const length = Math.round(Math.max(...practice.targets.map((t) => t.start + t.dur)));

  el.innerHTML = `
    <a class="back" href="#/learn">← Lesson path</a>
    <div class="row" style="margin:14px 0 4px">
      <span class="pill brand">Level ${level.n} · ${esc(level.tier)}</span>
      ${pr.attempts ? `${starsHtml(pr.stars)}<span class="small dim">best ${pr.best} · ${pr.attempts} tries</span>` : ''}
    </div>
    <h1>${lesson.icon} ${esc(lesson.title)}</h1>
    <p class="muted">${esc(lesson.subtitle)}</p>

    <div class="grid two" style="margin-top:16px">
      <div class="card teach">
        <h3>🧑‍🏫 ${esc(lesson.teach.heading)}</h3>
        <ul>${lesson.teach.points.map((pt) => `<li>${esc(pt)}</li>`).join('')}</ul>
      </div>
      <div class="card stack">
        <h3>What you’ll do</h3>
        <div class="row"><span class="pill cyan">${mode[0]} ${mode[1]}</span><span class="pill">${sing.length} notes</span><span class="pill">~${length}s</span></div>
        <p class="small muted" style="margin:0">${mode[2]} Notes: ${noteName(lo)}–${noteName(hi)}${store.voice ? ' (fitted to your range)' : ''}. Stay within ±${practice.tolerance}¢ to count as in tune.</p>
        ${!store.voice ? `<p class="small" style="margin:0">💡 <a href="#/range">Take the range test</a> so exercises match your voice.</p>` : ''}
        <div class="stage"><canvas id="preview" style="height:150px"></canvas></div>
        <button class="btn big block" id="go">▶ Start lesson</button>
      </div>
    </div>`;

  const canvas = new PitchCanvas(el.querySelector('#preview'), { past: 0.5, future: Math.min(14, length + 1) });
  canvas.fitTargets(practice.targets, 2);
  canvas.draw({ now: 0, targets: practice.targets, tolerance: practice.tolerance });

  el.querySelector('#go').addEventListener('click', () => {
    handoff.practice = { ...practice, lessonId: id, subtitle: mode[2], backHref: `#/lesson/${id}` };
    location.hash = '#/practice';
  });
  return () => canvas.destroy();
}
