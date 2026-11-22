// "Find your voice": measure comfortable, lowest and highest notes, classify the voice.
import { engine, ensureAudio } from '../engine.js';
import { noteName, median } from '../audio/notes.js';
import { PitchCanvas } from '../ui/pitchCanvas.js';
import { esc, toast } from '../ui/dom.js';
import { setVoice, state as store } from '../store.js';

const VOICE_TYPES = [
  ['Bass', 40, 64],
  ['Baritone', 45, 69],
  ['Tenor', 48, 72],
  ['Alto', 53, 77],
  ['Mezzo-soprano', 57, 81],
  ['Soprano', 60, 84],
];

export function classifyVoice(low, high) {
  let best = VOICE_TYPES[0];
  let bestD = Infinity;
  for (const vt of VOICE_TYPES) {
    const d = Math.abs(low - vt[1]) + Math.abs(high - vt[2]);
    if (d < bestD) {
      best = vt;
      bestD = d;
    }
  }
  return best[0];
}

export function comfortRange(low, high) {
  let a = low + 2;
  let b = high - 2;
  if (b - a < 12) {
    const c = (low + high) / 2;
    a = Math.round(c - 6);
    b = Math.round(c + 6);
  }
  return { comfortLow: a, comfortHigh: b };
}

const STEPS = [
  { id: 'comfy', title: 'Sing a comfortable “ahh”', hint: 'Like a relaxed sigh, in the middle of your voice. Hold it for 2 seconds.', icon: '😌' },
  { id: 'low', title: 'Slide down to your lowest note', hint: 'Glide slowly downward on “ahh” and hold the lowest note that still feels clear — no growling.', icon: '⬇️' },
  { id: 'high', title: 'Slide up to your highest note', hint: 'Glide slowly upward — light and easy, falsetto counts. Hold the highest note that doesn’t strain.', icon: '⬆️' },
];

export function rangeView(el) {
  let step = -1;
  let raf = 0;
  let stepStart = 0;
  let running = false;
  const trail = [];
  const recent = [];
  let comfy = [];
  let lowest = Infinity;
  let highest = -Infinity;
  let comfyNote = null;

  el.innerHTML = `
    <a class="back" href="#/home">← Home</a>
    <h1 style="margin-top:14px">🔎 Find your voice</h1>
    <p class="muted">One minute, three steps. Then every exercise and song is pitched for you.</p>
    <div class="steps" id="steps">${STEPS.map(() => '<span></span>').join('')}</div>
    <div class="card glow center stack" id="panel"></div>
    <div class="stage" style="margin-top:14px"><canvas id="roll"></canvas></div>`;

  const panel = el.querySelector('#panel');
  const canvas = new PitchCanvas(el.querySelector('#roll'), { past: 6, future: 0.6 });
  canvas.setView(48, 66);
  canvas.draw({ now: 0, trail });

  function setDots() {
    el.querySelectorAll('#steps span').forEach((s, i) => s.classList.toggle('on', i <= step));
  }

  function intro() {
    panel.innerHTML = `
      <div style="font-size:3rem">🎙️</div>
      <h2>Ready when you are</h2>
      <p class="muted">Find a quiet spot. Stand tall, relax your shoulders and take a deep belly breath.<br>Never strain — comfortable notes only.</p>
      <div><button class="btn big" id="begin">Start the range test</button></div>`;
    panel.querySelector('#begin').addEventListener('click', begin);
  }

  async function begin() {
    const eng = await ensureAudio().catch((e) => {
      toast(e.message, 'error');
      return null;
    });
    if (!eng) return;
    running = true;
    goto(0);
    loop();
  }

  function goto(i) {
    step = i;
    stepStart = engine.ctx.currentTime;
    recent.length = 0;
    setDots();
    if (i >= STEPS.length) return finish();
    const s = STEPS[i];
    panel.innerHTML = `
      <div style="font-size:2.6rem">${s.icon}</div>
      <div class="small muted">Step ${i + 1} of 3</div>
      <h2>${esc(s.title)}</h2>
      <p class="muted">${esc(s.hint)}</p>
      <div class="tuner-note" id="live">—</div>
      <div class="muted" id="found">${i === 0 ? 'Listening…' : '&nbsp;'}</div>
      <div class="row" style="justify-content:center">
        ${i > 0 ? '<button class="btn" id="next" disabled>That’s it →</button>' : ''}
        <button class="btn ghost small" id="redo">Redo step</button>
      </div>`;
    panel.querySelector('#next')?.addEventListener('click', () => goto(step + 1));
    panel.querySelector('#redo').addEventListener('click', () => {
      if (step === 0) comfy = [];
      if (step === 1) lowest = Infinity;
      if (step === 2) highest = -Infinity;
      goto(step);
    });
  }

  /** Scripted demo singer so the test can be tried without a mic. */
  function demoTarget(elapsed) {
    if (step === 0) return 57;
    if (step === 1) return Math.max(44, 57 - elapsed * 2.2);
    if (step === 2) return Math.min(71, 57 + elapsed * 2.2);
    return null;
  }

  function loop() {
    if (!running) return;
    const t = engine.ctx.currentTime;
    const elapsed = t - stepStart;
    engine.input.setDemoTarget(step >= 0 && step < 3 ? demoTarget(elapsed) : null);
    const f = engine.input.read();
    trail.push({ t, m: f.midi, col: 'free' });
    if (trail.length > 500) trail.shift();
    canvas.follow(f.midi);
    canvas.draw({ now: t, trail });

    recent.push({ t, m: f.midi });
    while (recent.length && recent[0].t < t - 0.35) recent.shift();
    const voiced = recent.filter((r) => r.m != null);
    const stable = recent.length > 8 && voiced.length === recent.length && Math.max(...voiced.map((v) => v.m)) - Math.min(...voiced.map((v) => v.m)) < 0.8;
    const live = panel.querySelector('#live');
    if (live) live.textContent = f.midi != null ? noteName(f.midi) : '—';
    const found = panel.querySelector('#found');
    const next = panel.querySelector('#next');

    if (stable && step >= 0 && step < 3) {
      const m = median(voiced.map((v) => v.m));
      if (step === 0) {
        comfy.push(m);
        if (comfy.length > 70) {
          comfyNote = Math.round(median(comfy));
          found.innerHTML = `✓ Your comfortable note: <b>${noteName(comfyNote)}</b>`;
          comfy = [];
          setTimeout(() => step === 0 && running && goto(1), 900);
        }
      } else if (step === 1 && m < lowest) {
        lowest = m;
      } else if (step === 2 && m > highest) {
        highest = m;
      }
    }
    if (step === 1 && Number.isFinite(lowest)) {
      found.innerHTML = `Lowest so far: <b>${noteName(lowest)}</b>`;
      next.disabled = false;
      if (elapsed > 14) goto(2);
    }
    if (step === 2 && Number.isFinite(highest)) {
      found.innerHTML = `Highest so far: <b>${noteName(highest)}</b>`;
      next.disabled = false;
      if (elapsed > 14) goto(3);
    }
    raf = requestAnimationFrame(loop);
  }

  function finish() {
    running = false;
    cancelAnimationFrame(raf);
    engine.input.setDemoTarget(null);
    let low = Math.round(lowest);
    let high = Math.round(highest);
    if (!Number.isFinite(low) || !Number.isFinite(high) || high - low < 5) {
      panel.innerHTML = `
        <div style="font-size:2.6rem">🤔</div>
        <h2>Let’s try that again</h2>
        <p class="muted">I only caught a very small range${Number.isFinite(low) && Number.isFinite(high) ? ` (${noteName(low)}–${noteName(high)})` : ''}. Slide further down and up, and hold each end for a moment so I can lock on.</p>
        <div><button class="btn" id="again">Restart test</button></div>`;
      panel.querySelector('#again').addEventListener('click', () => {
        lowest = Infinity;
        highest = -Infinity;
        running = true;
        goto(0);
        loop();
      });
      return;
    }
    if (comfyNote != null) {
      low = Math.min(low, comfyNote - 3);
      high = Math.max(high, comfyNote + 3);
    }
    const type = classifyVoice(low, high);
    const comfort = comfortRange(low, high);
    const span = high - low;
    const pos = (m) => ((m - 36) / (88 - 36)) * 100;
    panel.innerHTML = `
      <div style="font-size:2.6rem">🎉</div>
      <h2>You sound like a <span class="grad-text">${esc(type)}</span></h2>
      <p class="muted">Range <b>${noteName(low)} – ${noteName(high)}</b> (${span} semitones${span >= 24 ? ' — over two octaves!' : span >= 12 ? ' — more than an octave' : ''}).
        Exercises will use <b>${noteName(comfort.comfortLow)} – ${noteName(comfort.comfortHigh)}</b>.</p>
      <div class="range-viz">
        <div class="span" style="left:${pos(low)}%;width:${pos(high) - pos(low)}%"></div>
        ${[48, 60, 72, 84].map((m) => `<span class="tick" style="left:${pos(m)}%"></span><span class="lbl" style="left:${pos(m)}%">${noteName(m)}</span>`).join('')}
      </div>
      <p class="small dim">Your range grows with practice — re-test every few weeks.</p>
      <div class="row" style="justify-content:center">
        <button class="btn big" id="save">Save & start learning</button>
        <button class="btn ghost" id="retry">Retake</button>
      </div>`;
    panel.querySelector('#save').addEventListener('click', () => {
      setVoice({ low, high, type, ...comfort });
      toast(`Saved — welcome, ${type}! +50 XP`, 'good');
      location.hash = '#/learn';
    });
    panel.querySelector('#retry').addEventListener('click', () => {
      lowest = Infinity;
      highest = -Infinity;
      running = true;
      goto(0);
      loop();
    });
  }

  if (store.voice) {
    panel.innerHTML = `
      <div style="font-size:2.6rem">🎙️</div>
      <h2>Current voice: ${esc(store.voice.type)}</h2>
      <p class="muted">${noteName(store.voice.low)} – ${noteName(store.voice.high)}. Retake the test any time — ranges grow with practice.</p>
      <div><button class="btn big" id="begin">Retake range test</button></div>`;
    panel.querySelector('#begin').addEventListener('click', begin);
  } else {
    intro();
  }

  return () => {
    running = false;
    cancelAnimationFrame(raf);
    engine.input?.setDemoTarget(null);
    canvas.destroy();
  };
}
