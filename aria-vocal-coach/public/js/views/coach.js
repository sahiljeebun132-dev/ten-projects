// Live coach: free singing with a tuner, steadiness meter and optional note to match.
import { engine, ensureAudio, ensureContext, speak } from '../engine.js';
import { LiveCoach, CUE_SPEECH } from '../audio/coach.js';
import { noteName, centsOff, isBlackKey } from '../audio/notes.js';
import { pitchError } from '../audio/scoring.js';
import { PitchCanvas } from '../ui/pitchCanvas.js';
import { esc, toast } from '../ui/dom.js';
import { practiceRange } from '../store.js';

const DEMO_TUNE = [0, 2, 4, 5, 7, 7, 9, 7, 5, 4, 2, 0];

export function coachView(el) {
  const range = practiceRange();
  const notes = [];
  for (let m = range.low; m <= range.high; m++) notes.push(m);

  el.innerHTML = `
    <h1>🎙️ Live coach</h1>
    <p class="muted">Sing anything and watch your pitch in real time — or pick a note below and I’ll coach you onto it.</p>
    <div class="grid two">
      <div class="card center stack">
        <div class="tuner-note" id="note">—</div>
        <div class="tuner-cents" id="cents">sing a note</div>
        <div><div class="meter"><div class="center"></div><div class="needle" id="needle" style="opacity:.25"></div></div>
        <div class="meter-labels"><span>−50¢</span><span>0</span><span>+50¢</span></div></div>
        <div class="cue rest" id="cue"><span class="cue-ico">🎤</span><span>Press “Start listening”</span></div>
        <div class="row" style="justify-content:center">
          <button class="btn big" id="toggle">🎤 Start listening</button>
        </div>
      </div>
      <div class="card stack">
        <h3>🎯 Match a note</h3>
        <p class="small muted" style="margin:0">Pick a target — tap it again to clear. Notes are from your range.</p>
        <div class="chips" id="chips">${notes.map((m) => `<button class="chip" data-m="${m}" ${isBlackKey(m) ? 'style="opacity:.7"' : ''}>${esc(noteName(m))}</button>`).join('')}</div>
        <div class="row">
          <button class="btn ghost small" id="play" disabled>🔊 Play target</button>
          <button class="btn ghost small" id="drone" disabled>🎹 Drone: off</button>
        </div>
        <div>
          <div class="row between small"><span>🧘 Steadiness</span><span id="steady-val" class="muted">–</span></div>
          <div class="bar cyan" style="margin-top:6px"><span id="steady" style="width:0%"></span></div>
        </div>
        <div class="row between small"><span>📏 Range this session</span><span id="span" class="muted">–</span></div>
      </div>
    </div>
    <div class="stage" style="margin-top:14px"><canvas id="roll"></canvas></div>`;

  const ui = {
    note: el.querySelector('#note'),
    cents: el.querySelector('#cents'),
    needle: el.querySelector('#needle'),
    cue: el.querySelector('#cue'),
    toggle: el.querySelector('#toggle'),
    play: el.querySelector('#play'),
    drone: el.querySelector('#drone'),
    steady: el.querySelector('#steady'),
    steadyVal: el.querySelector('#steady-val'),
    span: el.querySelector('#span'),
  };
  const canvas = new PitchCanvas(el.querySelector('#roll'), { past: 5, future: 1.5 });
  canvas.setView(range.low - 2, range.high + 2);
  canvas.draw({ now: 0 });

  const coach = new LiveCoach({ tolerance: 30 });
  const trail = [];
  const recent = [];
  let running = false;
  let raf = 0;
  let target = null;
  let stopDrone = null;
  let lo = Infinity;
  let hi = -Infinity;
  let lastCue = null;
  const t0 = performance.now() / 1000;

  function targetsFor(now) {
    return target == null ? [] : [{ midi: target, start: now - 10, dur: 20, role: 'sing' }];
  }

  ui.toggle.addEventListener('click', async () => {
    if (running) return stop();
    const eng = await ensureAudio().catch((e) => {
      toast(e.message, 'error');
      return null;
    });
    if (!eng) return;
    running = true;
    coach.reset();
    ui.toggle.textContent = '■ Stop';
    ui.toggle.classList.add('ghost');
    loop();
  });

  function stop() {
    running = false;
    cancelAnimationFrame(raf);
    engine.input?.setDemoTarget(null);
    ui.toggle.textContent = '🎤 Start listening';
    ui.toggle.classList.remove('ghost');
    setCue({ kind: 'rest', icon: '⏸️', text: 'Paused' });
  }

  el.querySelector('#chips').addEventListener('click', async (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const m = Number(chip.dataset.m);
    target = target === m ? null : m;
    el.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', Number(c.dataset.m) === target));
    ui.play.disabled = ui.drone.disabled = target == null;
    if (stopDrone) {
      stopDrone();
      stopDrone = null;
      ui.drone.textContent = '🎹 Drone: off';
    }
    coach.reset();
    if (target != null) {
      canvas.setView(Math.min(target - 6, range.low - 2), Math.max(target + 6, range.high + 2));
      const ctx = await ensureContext();
      engine.guide.note(target, ctx.currentTime + 0.02, 1.2);
    }
  });

  ui.play.addEventListener('click', async () => {
    if (target == null) return;
    const ctx = await ensureContext();
    engine.guide.note(target, ctx.currentTime + 0.02, 1.5);
  });

  ui.drone.addEventListener('click', async () => {
    if (target == null) return;
    if (stopDrone) {
      stopDrone();
      stopDrone = null;
      ui.drone.textContent = '🎹 Drone: off';
      return;
    }
    await ensureContext();
    stopDrone = engine.guide.drone(target);
    ui.drone.textContent = '🎹 Drone: on';
  });

  function setCue(cue) {
    if (!cue || (lastCue && cue.kind === lastCue.kind && cue.text === lastCue.text)) return;
    ui.cue.className = `cue ${cue.kind}`;
    ui.cue.innerHTML = `<span class="cue-ico">${cue.icon || ''}</span><span>${esc(cue.text)}</span>`;
    if (target != null && (!lastCue || cue.kind !== lastCue.kind) && CUE_SPEECH[cue.kind]) speak(CUE_SPEECH[cue.kind]);
    lastCue = cue;
  }

  function loop() {
    if (!running) return;
    const now = engine.ctx.currentTime;
    const demoT = performance.now() / 1000 - t0;
    engine.input.setDemoTarget(target ?? range.low + 3 + DEMO_TUNE[Math.floor(demoT / 0.9) % DEMO_TUNE.length]);
    const f = engine.input.read();
    const res = coach.update({ t: now, midi: f.midi, rms: f.rms }, target, target == null ? 'free' : 'sing');

    let plotted = f.midi;
    let col = 'free';
    if (f.midi != null) {
      lo = Math.min(lo, f.midi);
      hi = Math.max(hi, f.midi);
      ui.note.textContent = noteName(f.midi);
      const c = target != null ? Math.round(pitchError(f.midi, target).cents) : Math.round(centsOff(f.midi));
      ui.cents.textContent = target != null ? `${c > 0 ? '+' : ''}${c}¢ from ${noteName(target)}` : `${c > 0 ? '+' : ''}${c}¢`;
      ui.needle.style.left = `${Math.max(-50, Math.min(50, c)) + 50}%`;
      ui.needle.style.opacity = '1';
      if (target != null) {
        plotted = target + c / 100;
        col = Math.abs(c) <= 15 ? 'good' : Math.abs(c) <= 30 ? 'ok' : 'bad';
      } else {
        canvas.follow(f.midi);
      }
    } else {
      ui.needle.style.opacity = '0.25';
    }
    trail.push({ t: now, m: plotted, col });
    if (trail.length > 600) trail.shift();
    recent.push({ t: now, m: f.midi });
    while (recent.length && recent[0].t < now - 1) recent.shift();
    const v = recent.filter((r) => r.m != null).map((r) => r.m);
    if (v.length > 20) {
      const mean = v.reduce((s, x) => s + x, 0) / v.length;
      const std = Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / v.length) * 100;
      const steady = Math.max(0, Math.min(100, Math.round(100 - (std - 8) * 2)));
      ui.steady.style.width = `${steady}%`;
      ui.steadyVal.textContent = `${steady}`;
    }
    if (Number.isFinite(lo)) ui.span.textContent = `${noteName(lo)} – ${noteName(hi)}`;
    canvas.draw({ now, targets: targetsFor(now), trail, tolerance: 30 });
    setCue(res.cue);
    raf = requestAnimationFrame(loop);
  }

  return () => {
    stop();
    stopDrone?.();
    canvas.destroy();
  };
}
