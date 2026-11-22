// The practice screen: live pitch canvas + coach cues, then scored results and the teacher's word.
import { engine, ensureAudio, ensureContext, handoff, speak } from '../engine.js';
import { PracticeSession } from '../audio/session.js';
import { buildInsights, CUE_SPEECH } from '../audio/coach.js';
import { noteName, centsOff } from '../audio/notes.js';
import { swaraName, swaraDevanagari, harmoniumScale } from '../audio/sargam.js';
import { analyzeStyle, compareStyle } from '../audio/style.js';
import { condense, teacherNote } from '../audio/teacher.js';
import { PitchCanvas } from '../ui/pitchCanvas.js';
import { esc, starsHtml, ringHtml, toast } from '../ui/dom.js';
import { state as store, setSetting, recordAttempt, recordRiyaaz, recordTake, styleById } from '../store.js';
import { ALL_LESSONS } from '../data/curriculum.js';
import { stageOf } from '../data/riyaaz.js';
import { goPractice, riyaazHandoff, nextRiyaaz, styleDrillHandoff } from '../runners.js';

export function practiceView(el) {
  const p = handoff.practice;
  if (!p) {
    location.hash = '#/learn';
    return;
  }
  const s = store.settings;
  const hasSa = p.sa != null;
  const sargam = () => hasSa && store.settings.notation === 'sargam';

  el.innerHTML = `
    <div class="practice-head">
      <a class="back" href="${esc(p.backHref || '#/learn')}">← Back</a>
      <div class="spacer"></div>
      ${hasSa ? `<span class="pill gold">Sa = ${esc(noteName(p.sa))} · ${esc(harmoniumScale(p.sa))}</span>` : ''}
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
        ${
          hasSa
            ? `<div class="stack" style="gap:8px">
                <label class="toggle small"><span>🪕 Tanpura on your Sa</span><input type="checkbox" id="tan-on" ${p.tanpura ? 'checked' : ''}></label>
                <label class="field">Tanpura volume <input type="range" id="tan-vol" min="0" max="1" step="0.05" value="${s.tanpuraVolume}"></label>
              </div>
              <div><div class="small muted" style="margin-bottom:6px">Note names</div>
                <div class="seg" id="nota"><button data-v="sargam" class="${s.notation === 'sargam' ? 'on' : ''}">Sa Re Ga</button><button data-v="western" class="${s.notation !== 'sargam' ? 'on' : ''}">C D E</button></div></div>`
            : ''
        }
        <p class="small dim" style="margin:0;align-self:center">🎧 Headphones = most accurate coaching. Purple bars are yours to sing; dashed cyan bars are “listen first”.${hasSa ? ' Lowercase swaras are komal, a dot below = mandra, above = taar.' : ''}</p>
      </div>
    </div>
    <div id="results"></div>`;

  const canvas = new PitchCanvas(el.querySelector('#roll'));
  canvas.fitTargets(p.targets);
  const applyNotation = () => {
    canvas.tonicPc = hasSa ? ((p.sa % 12) + 12) % 12 : 0;
    canvas.labelFn = sargam() ? (m) => swaraName(m, p.sa) : null;
  };
  applyNotation();
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

  // Tanpura + notation (only when the exercise has a Sa).
  const tanOn = el.querySelector('#tan-on');
  const startTanpura = () => {
    if (hasSa && tanOn?.checked && engine.guide && engine.guide.tanpuraSa !== p.sa) engine.guide.tanpura(p.sa);
  };
  tanOn?.addEventListener('change', async () => {
    if (tanOn.checked) {
      await ensureContext();
      startTanpura();
    } else {
      engine.guide?.stopTanpura();
    }
  });
  el.querySelector('#tan-vol')?.addEventListener('input', (e) => {
    setSetting('tanpuraVolume', Number(e.target.value));
    engine.guide?.setTanpuraVolume(Number(e.target.value));
  });
  el.querySelector('#nota')?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    setSetting('notation', b.dataset.v);
    el.querySelectorAll('#nota button').forEach((x) => x.classList.toggle('on', x === b));
    applyNotation();
    canvas.draw(canvas.last || idle);
  });

  ui.start.addEventListener('click', async () => {
    ui.start.disabled = true;
    const eng = await ensureAudio().catch((err) => {
      toast(err.message || 'Audio could not start', 'error');
      return null;
    });
    ui.start.disabled = false;
    if (!eng) return;
    startTanpura();
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

  const label = (m) => (sargam() ? swaraName(m, p.sa) : noteName(m));

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
      ui.you.textContent = label(m);
      const c = Math.round(centsOff(m));
      ui.youSub.textContent = `${sargam() ? `${noteName(m)} · ` : ''}${c > 0 ? '+' : ''}${c}¢`;
    } else {
      ui.you.textContent = '—';
      ui.youSub.textContent = u.frame.rms > 0.015 ? 'unclear tone' : ' ';
    }
    const tg = u.active?.tg;
    if (tg) {
      const tm = u.targetMidi ?? tg.midi;
      ui.tgt.textContent = label(tm);
      const what = tg.lyric && !sargam() ? `“${tg.lyric}”` : tg.role === 'listen' ? 'listen' : 'sing';
      ui.tgtSub.textContent = sargam() ? `${swaraDevanagari(tm, p.sa)} · ${noteName(tm)} · ${what}` : what;
    } else {
      ui.tgt.textContent = '—';
      ui.tgtSub.textContent = ' ';
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

    const prevTakes = store.teacher.takes.slice();
    const gained = recordAttempt(p.lessonId || null, result, seconds);
    const riy = p.riyaaz ? recordRiyaaz(p.riyaaz.id, result, seconds) : null;
    const insights = buildInsights(result);
    const passed = result.stars >= 1;
    const idx = p.lessonId ? ALL_LESSONS.findIndex((l) => l.id === p.lessonId) : -1;
    const next = idx >= 0 ? ALL_LESSONS[idx + 1] : null;
    const nextRx = p.riyaaz ? nextRiyaaz(p.riyaaz.id) : null;

    // Style comparison for song takes when a learned singer style is attached.
    let styleCmp = null;
    const styleRec = p.style ? styleById(p.style.id) : null;
    if (styleRec && finished && p.focus === 'song') {
      const mine = analyzeStyle(finished.frames.map((f) => ({ t: f.t, m: f.midi })));
      styleCmp = mine ? compareStyle(mine, styleRec.profile, styleRec.singer) : null;
    }

    const takeId = p.riyaaz?.id || p.lessonId || p.styleDrill || p.songKey || p.title;
    const note = teacherNote(result, prevTakes, {
      id: takeId,
      next: nextRx && passed ? `Next in today’s riyaaz: ${nextRx.title}.` : passed && next ? `Next lesson: ${next.title}.` : null,
    });
    recordTake(condense(result, { id: takeId, kind: p.riyaaz ? 'riyaaz' : p.lessonId ? 'lesson' : p.focus === 'song' ? 'song' : p.styleDrill ? 'style' : 'exercise', title: p.title, styleMatch: styleCmp?.match }));

    const icons = { tip: '💡', good: '✅', info: 'ℹ️' };
    const nm = (m) => (hasSa && store.settings.notation === 'sargam' ? swaraName(m, p.sa) : noteName(m));
    const strip = result.perNote
      .map((n) => `<span class="${n.hit ? 'hit' : 'miss'}" title="${esc(noteName(n.midi))}: ${n.voicedFrac > 0.3 ? `${Math.round(n.meanErr)}¢` : 'not sung'}">${esc(nm(n.midi))}</span>`)
      .join('');
    const showHold = p.riyaaz || p.focus === 'stability';

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
              ${showHold ? `<div class="metric"><b>${result.longestHold}s</b><span>Longest steady note</span></div>` : ''}
              ${p.focus === 'dynamics' ? `<div class="metric"><b>${result.dynamics}</b><span>Crescendo</span></div>` : ''}
              ${p.focus === 'vibrato' ? `<div class="metric"><b>${result.vibrato}</b><span>Vibrato</span></div>` : ''}
              ${styleCmp ? `<div class="metric"><b>${styleCmp.match}%</b><span>${esc(styleRec.singer)} style</span></div>` : ''}
            </div>
          </div>
        </div>
      </div>
      <div class="card teacher-card" style="margin-top:14px">
        <div class="teacher-say">
          <div class="t-avatar ${note.mood}" aria-hidden="true">🧑‍🏫</div>
          <div><b>Your teacher</b>${note.lines.map((l) => `<p>${esc(l)}</p>`).join('')}</div>
        </div>
      </div>
      ${riy ? riyaazBlock(riy) : ''}
      ${styleCmp ? styleBlock(styleCmp, styleRec) : ''}
      <div class="card" style="margin-top:14px">
        <h3>🧑‍🏫 Detailed feedback</h3>
        <ul class="insights">${insights.map((i) => `<li class="${i.type}"><span class="i-ico">${icons[i.type]}</span><span>${esc(i.text)}</span></li>`).join('')}</ul>
        <h3 style="margin-top:18px">Note by note</h3>
        <div class="note-strip">${strip}</div>
        <div id="take" style="margin-top:14px"></div>
      </div>
      <div class="controls">
        <button class="btn ghost" id="again">↻ Try again</button>
        ${nextRx ? `<button class="btn" id="next-rx">Next riyaaz: ${esc(nextRx.title)} →</button>` : ''}
        ${p.riyaaz && !nextRx ? '<a class="btn" href="#/riyaaz">✅ Today’s riyaaz done</a>' : ''}
        ${passed && next ? `<a class="btn" href="#/lesson/${esc(next.id)}">Next: ${esc(next.title)} →</a>` : ''}
        ${!p.lessonId ? `<a class="btn ghost" href="${esc(p.backHref || '#/home')}">Done</a>` : `<a class="btn ghost" href="#/learn">Lesson path</a>`}
      </div>`;
    box.querySelector('#again').addEventListener('click', () => {
      box.innerHTML = '';
      window.scrollTo({ top: 0, behavior: 'smooth' });
      ui.start.click();
    });
    box.querySelector('#next-rx')?.addEventListener('click', () => {
      const h = riyaazHandoff(nextRx.id);
      if (h) goPractice(h);
    });
    box.querySelectorAll('[data-drill]').forEach((b) =>
      b.addEventListener('click', () => {
        const h = styleDrillHandoff(p.style.id, b.dataset.drill);
        if (h) goPractice(h);
      }),
    );
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    speak(note.lines.slice(0, 2).join(' '), { force: true, minGap: 6 });
    if (riy?.advanced) toast(`${stageOf(riy.stage).icon} You reached riyaaz stage ${riy.stage}: ${stageOf(riy.stage).name}!`, 'good', 5000);
    else if (riy?.dumRecord) toast(`🌬️ New breath record: ${riy.dumRecord} s`, 'good');
    else if (gained.firstPass) toast(idx >= 0 && !next ? '👑 Path complete — you’re a Master!' : `🎉 Lesson passed! +${gained.xp} XP`, 'good');

    const url = finished?.takeReady ? await finished.takeReady : null;
    if (url && box.isConnected) {
      box.querySelector('#take').innerHTML = `<h3>🎧 Hear your take</h3><audio controls src="${esc(url)}" style="width:100%"></audio>`;
    }
  }

  return () => {
    session?.stop();
    engine.guide?.stopTanpura();
    canvas.destroy();
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  };
}

function riyaazBlock(riy) {
  const d = riy.after.score - riy.before.score;
  return `
    <div class="card gold-card" style="margin-top:14px">
      <div class="row between">
        <h3 style="margin:0">✨ Golden-voice meter</h3>
        <span class="pill gold">${esc(riy.after.tier.icon)} ${esc(riy.after.tier.name)}</span>
      </div>
      <div class="row" style="margin-top:8px;align-items:baseline">
        <b class="gold-num">${riy.after.score}</b><span class="muted">/ 100</span>
        ${d ? `<span class="pill ${d > 0 ? 'good' : 'warn'}">${d > 0 ? '+' : ''}${d}</span>` : ''}
        ${riy.after.nextTier ? `<span class="small muted">${riy.after.nextTier.min - riy.after.score} to ${esc(riy.after.nextTier.name)}</span>` : ''}
      </div>
      <div class="bar gold" style="margin-top:8px"><span style="width:${riy.after.score}%"></span></div>
    </div>`;
}

function styleBlock(cmp, style) {
  return `
    <div class="card" style="margin-top:14px">
      <div class="row between"><h3 style="margin:0">🎤 ${esc(style.singer)} style match</h3><span class="pill brand">${cmp.match}%</span></div>
      <table class="cmp">
        <thead><tr><th></th><th>You</th><th>${esc(style.singer)}</th></tr></thead>
        <tbody>${cmp.rows.map((r) => `<tr><td>${esc(r.label)}</td><td>${esc(r.you)}</td><td>${esc(r.them)}</td></tr>`).join('')}</tbody>
      </table>
      ${
        cmp.tips.length
          ? `<ul class="insights" style="margin-top:12px">${cmp.tips
              .map((t) => `<li class="tip"><span class="i-ico">🎯</span><span>${esc(t.text)}${t.drill ? `<br><button class="btn small ghost" style="margin-top:8px" data-drill="${esc(t.drill)}">Practise it →</button>` : ''}</span></li>`)
              .join('')}</ul>`
          : ''
      }
      ${cmp.wins.length ? `<p class="small" style="margin:10px 0 0;color:var(--good)">✅ ${esc(cmp.wins.slice(0, 2).join(' '))}</p>` : ''}
    </div>`;
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
