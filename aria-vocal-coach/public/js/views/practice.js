// The practice screen: live pitch canvas + coach cues, then scored results.
import { engine, ensureAudio, handoff, speak } from '../engine.js';
import { PracticeSession } from '../audio/session.js';
import { buildInsights, CUE_SPEECH } from '../audio/coach.js';
import { noteName, centsOff } from '../audio/notes.js';
import { PitchCanvas } from '../ui/pitchCanvas.js';
import { esc, starsHtml, ringHtml, toast } from '../ui/dom.js';
import { state as store, setSetting, recordAttempt } from '../store.js';
import { ALL_LESSONS } from '../data/curriculum.js';

export function practiceView(el) {
  const p = handoff.practice;
  if (!p) {
    location.hash = '#/learn';
    return;
  }
  const s = store.settings;
  el.innerHTML = `
    <div class="practice-head">
      <a class="back" href="${esc(p.backHref || '#/learn')}">← Back</a>
      <div class="spacer"></div>
      <span class="pill">±${p.tolerance}¢ tolerance</span>
    </div>
    <h1 style="margin-bottom:2px">${esc(p.title)}</h1>
    <p class="muted">${esc(p.subtitle || modeText(p))}</p>

    <div id="play-area">
      <div class="stage">
        <canvas id="roll" aria-label="Pitch display: target notes and your voice"></canvas>
        <div class="stage-overlay"><div id="countdown"></div></div>
        <span id="phase" class="pill phase-pill hidden"></span>
        <div id="progress" class="progress-line"></div>
      </div>

      <div class="hud">
        <div class="card readout"><div class="lbl">You</div><div class="note" id="you">—</div><div class="sub" id="you-sub">&nbsp;</div></div>
        <div class="cue rest" id="cue"><span class="cue-ico">🎤</span><span>Press start, then sing along</span></div>
        <div class="card readout"><div class="lbl">Target</div><div class="note" id="tgt">—</div><div class="sub" id="tgt-sub">&nbsp;</div></div>
      </div>

      <div class="meter" aria-hidden="true"><div class="center"></div><div class="needle" id="needle" style="opacity:.25"></div></div>
      <div class="meter-labels"><span>⬇ too low</span><span>in tune</span><span>too high ⬆</span></div>

      <div class="controls">
        <button class="btn big" id="start">▶ Start</button>
        <button class="btn ghost hidden" id="stop">■ Stop</button>
      </div>
      <div class="card sliders">
        <label class="field">Guide volume <input type="range" id="guide-vol" min="0" max="1" step="0.05" value="${s.guideVolume}"></label>
        ${p.backing ? `<label class="field">Song volume <input type="range" id="back-vol" min="0" max="1" step="0.05" value="${s.backingVolume}"></label>` : ''}
        <p class="small dim" style="margin:0;align-self:center">🎧 Headphones = most accurate coaching. Purple bars are yours to sing; dashed cyan bars are “listen first”.</p>
      </div>
    </div>
    <div id="results"></div>`;

  const canvas = new PitchCanvas(el.querySelector('#roll'));
  canvas.fitTargets(p.targets);
  const idle = { now: -1, targets: p.targets, tolerance: p.tolerance };
  canvas.draw(idle);

  const ui = {
    you: el.querySelector('#you'),
    youSub: el.querySelector('#you-sub'),
    tgt: el.querySelector('#tgt'),
    tgtSub: el.querySelector('#tgt-sub'),
    cue: el.querySelector('#cue'),
    needle: el.querySelector('#needle'),
    countdown: el.querySelector('#countdown'),
    phase: el.querySelector('#phase'),
    progress: el.querySelector('#progress'),
    start: el.querySelector('#start'),
    stop: el.querySelector('#stop'),
  };
  let session = null;
  let lastCueKind = null;
  let lastCount = null;
  let startedAt = 0;

  el.querySelector('#guide-vol').addEventListener('input', (e) => {
    setSetting('guideVolume', Number(e.target.value));
    engine.guide?.setVolume(Number(e.target.value));
  });
  el.querySelector('#back-vol')?.addEventListener('input', (e) => {
    setSetting('backingVolume', Number(e.target.value));
    session?.setBackingVolume(Number(e.target.value));
  });

  ui.start.addEventListener('click', async () => {
    ui.start.disabled = true;
    const eng = await ensureAudio().catch((err) => {
      toast(err.message || 'Audio could not start', 'error');
      return null;
    });
    ui.start.disabled = false;
    if (!eng) return;
    el.querySelector('#results').innerHTML = '';
    el.querySelector('#play-area').classList.remove('hidden');
    session = new PracticeSession({
      engine: eng,
      targets: p.targets,
      tolerance: p.tolerance,
      bpm: p.bpm,
      focus: p.focus,
      guideOnSing: p.guideOnSing,
      backing: p.backing || null,
      backingVolume: store.settings.backingVolume,
      onUpdate: render,
      onEnd: showResults,
    });
    ui.start.classList.add('hidden');
    ui.stop.classList.remove('hidden');
    startedAt = performance.now();
    speak(p.focus === 'song' ? 'Here we go' : 'Listen, then sing', { force: true });
    await session.start();
  });

  ui.stop.addEventListener('click', () => {
    session?.stop();
    session = null;
    resetControls();
    ui.countdown.innerHTML = '';
    setCue({ kind: 'rest', icon: '⏸️', text: 'Stopped — press start to try again' });
  });

  function resetControls() {
    ui.start.classList.remove('hidden');
    ui.start.textContent = '↻ Try again';
    ui.stop.classList.add('hidden');
    ui.phase.classList.add('hidden');
  }

  function setCue(cue) {
    if (!cue) return;
    if (cue.kind !== lastCueKind || ui.cue.dataset.text !== cue.text) {
      ui.cue.className = `cue ${cue.kind}`;
      ui.cue.dataset.text = cue.text;
      ui.cue.innerHTML = `<span class="cue-ico">${cue.icon || ''}</span><span>${esc(cue.text)}</span>`;
      if (cue.kind !== lastCueKind && CUE_SPEECH[cue.kind]) speak(CUE_SPEECH[cue.kind]);
      lastCueKind = cue.kind;
    }
  }

  function render(u) {
    canvas.draw({ now: u.t, targets: p.targets, trail: session.trail, result: (i) => session.noteResult(i), tolerance: p.tolerance });
    ui.progress.style.width = `${u.progress * 100}%`;
    if (u.countdown !== lastCount) {
      ui.countdown.innerHTML = u.countdown ? `<div class="countdown">${u.countdown}</div>` : '';
      lastCount = u.countdown;
    }
    if (u.countdown) {
      setCue({ kind: 'rest', icon: '⏳', text: 'Get ready…' });
      return;
    }
    ui.phase.classList.remove('hidden');
    ui.phase.textContent = u.phase === 'listen' ? '🎧 Listen' : u.phase === 'sing' ? '🎤 Your turn' : '🌬️ Breathe';
    ui.phase.className = `pill phase-pill ${u.phase === 'listen' ? 'cyan' : u.phase === 'sing' ? 'brand' : ''}`;

    const m = u.frame.midi;
    if (m != null) {
      ui.you.textContent = noteName(m);
      const c = Math.round(centsOff(m));
      ui.youSub.textContent = `${c > 0 ? '+' : ''}${c}¢`;
    } else {
      ui.you.textContent = '—';
      ui.youSub.textContent = u.frame.rms > 0.015 ? 'unclear tone' : ' ';
    }
    const tg = u.active?.tg;
    if (tg) {
      ui.tgt.textContent = noteName(u.targetMidi ?? tg.midi);
      ui.tgtSub.textContent = tg.lyric ? `“${tg.lyric}”` : tg.role === 'listen' ? 'listen' : 'sing';
    } else {
      ui.tgt.textContent = '—';
      ui.tgtSub.textContent = ' ';
    }
    if (u.cents != null) {
      const pos = Math.max(-100, Math.min(100, u.cents)) / 2 + 50; // ±100¢ across the meter
      ui.needle.style.left = `${pos}%`;
      ui.needle.style.opacity = '1';
    } else {
      ui.needle.style.opacity = '0.25';
    }
    setCue(u.cue);
  }

  async function showResults(result) {
    const seconds = (performance.now() - startedAt) / 1000;
    const finished = session;
    session = null;
    resetControls();
    ui.countdown.innerHTML = '';
    setCue({ kind: result.stars ? 'good' : 'sing', icon: result.stars ? '🎉' : '💪', text: result.stars ? 'Nice work!' : 'Keep going — you’ve got this' });

    const gained = recordAttempt(p.lessonId || null, result, seconds);
    const insights = buildInsights(result);
    const passed = result.stars >= 1;
    const idx = p.lessonId ? ALL_LESSONS.findIndex((l) => l.id === p.lessonId) : -1;
    const next = idx >= 0 ? ALL_LESSONS[idx + 1] : null;
    const icons = { tip: '💡', good: '✅', info: 'ℹ️' };
    const strip = result.perNote
      .map((n) => `<span class="${n.hit ? 'hit' : 'miss'}" title="${esc(noteName(n.midi))}: ${n.voicedFrac > 0.3 ? `${Math.round(n.meanErr)}¢` : 'not sung'}">${esc(noteName(n.midi))}</span>`)
      .join('');

    const box = el.querySelector('#results');
    box.innerHTML = `
      <div class="card glow" style="margin-top:18px">
        <div class="results">
          ${ringHtml(result.score)}
          <div class="stack">
            <div>
              <div class="row">${starsHtml(result.stars)} <span class="pill ${passed ? 'good' : 'warn'}">${passed ? 'Passed' : '60 to pass'}</span>
                <span class="pill brand">+${gained.xp} XP</span>${gained.newBest ? '<span class="pill good">New best!</span>' : ''}</div>
              <h2 style="margin-top:10px">${esc(headline(result.score))}</h2>
            </div>
            <div class="metrics">
              <div class="metric"><b>${result.accuracy}%</b><span>In tune</span></div>
              <div class="metric"><b>${result.notesHit}/${result.notesTotal}</b><span>Notes hit</span></div>
              <div class="metric"><b>${result.stability}</b><span>Steadiness</span></div>
              <div class="metric"><b>${result.timing}</b><span>Timing</span></div>
              ${p.focus === 'dynamics' ? `<div class="metric"><b>${result.dynamics}</b><span>Crescendo</span></div>` : ''}
              ${p.focus === 'vibrato' ? `<div class="metric"><b>${result.vibrato}</b><span>Vibrato</span></div>` : ''}
            </div>
          </div>
        </div>
      </div>
      <div class="card" style="margin-top:14px">
        <h3>🧑‍🏫 Coach’s feedback</h3>
        <ul class="insights">${insights.map((i) => `<li class="${i.type}"><span class="i-ico">${icons[i.type]}</span><span>${esc(i.text)}</span></li>`).join('')}</ul>
        <h3 style="margin-top:18px">Note by note</h3>
        <div class="note-strip">${strip}</div>
        <div id="take" style="margin-top:14px"></div>
      </div>
      <div class="controls">
        <button class="btn ghost" id="again">↻ Try again</button>
        ${passed && next ? `<a class="btn" href="#/lesson/${esc(next.id)}">Next: ${esc(next.title)} →</a>` : ''}
        ${!p.lessonId ? `<a class="btn ghost" href="${esc(p.backHref || '#/home')}">Done</a>` : `<a class="btn ghost" href="#/learn">Lesson path</a>`}
      </div>`;
    box.querySelector('#again').addEventListener('click', () => {
      box.innerHTML = '';
      window.scrollTo({ top: 0, behavior: 'smooth' });
      ui.start.click();
    });
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    speak(insights[0]?.text || headline(result.score), { force: true });
    if (gained.firstPass) toast(idx >= 0 && !next ? '👑 Path complete — you’re a Master!' : `🎉 Lesson passed! +${gained.xp} XP`, 'good');

    const url = finished?.takeReady ? await finished.takeReady : null;
    if (url && box.isConnected) {
      box.querySelector('#take').innerHTML = `<h3>🎧 Hear your take</h3><audio controls src="${esc(url)}" style="width:100%"></audio>`;
    }
  }

  return () => {
    session?.stop();
    canvas.destroy();
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  };
}

function modeText(p) {
  if (p.backing) return 'Sing with the original track — match the singer’s melody.';
  const listen = p.targets.some((t) => t.role === 'listen');
  if (listen && !p.guideOnSing) return 'Listen to the cyan notes, then sing the purple ones back.';
  return 'Sing along with the guide melody.';
}

function headline(score) {
  if (score >= 95) return 'Flawless. You’re a natural. 👑';
  if (score >= 90) return 'Outstanding — three stars!';
  if (score >= 75) return 'Great singing — almost perfect.';
  if (score >= 60) return 'Passed! Solid progress.';
  if (score >= 40) return 'Getting there — use the tips below.';
  return 'Every singer starts here. Try again!';
}
