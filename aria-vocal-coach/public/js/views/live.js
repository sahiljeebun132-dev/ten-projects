// A live lesson with the teacher. Claude picks each exercise; the app runs it with the mic and
// sends back the score and a picture of the pitch line; the teacher reacts, decides what's next,
// and finally wraps up with a recap and homework.
import { esc } from '../ui/dom.js';
import { practiceView } from './practice.js';
import { takeImage } from '../ui/takeImage.js';
import { noteName } from '../audio/notes.js';
import { swaraName } from '../audio/sargam.js';
import { ALL_LESSONS, lessonById } from '../data/curriculum.js';
import { exerciseById } from '../data/riyaaz.js';
import { state as store, riyaazSa, setSetting, styleById, tierInfo, nextLesson, isUnlocked, recordLesson } from '../store.js';
import { practiceFor, openExercise } from '../runners.js';
import { buildTeacherContext, teacherStatus, startLesson, lessonStep, takeForLesson, createSpeaker, createListener, DRILL_LABELS } from '../teacherTalk.js';

const LENGTHS = [10, 15, 20];
const FOCUSES = [
  ['', '✨ Let my teacher choose'],
  ['Singing in tune — my sur', '🎯 Sur — singing in tune'],
  ['Breath and long, steady notes', '🌬️ Breath & long notes'],
  ['High notes and the break between chest and head voice', '🕊️ High notes & the break'],
  ['Murkis, runs and agility', '⚡ Murkis & runs'],
];
const MAX_IMAGE = 380_000;

// ------------------------------------------------------------------ the lesson (outlives the screen)

/**
 * The lesson in progress, kept outside the view so leaving the screen doesn't lose it.
 * waiting: 'teacher' (a reply is streaming) | 'exercise' | 'student' | 'finished' | 'ended'
 *          | 'interrupted' (the screen was left mid-reply) | 'error'
 */
let current = null;
let view = null; // the mounted screen's hooks, or null
let abort = null;
let speaker = null;
const voice = () => (speaker ||= createSpeaker());
const voiceOn = () => voice().supported && store.settings.teacherVoice !== false;

function refLabel(ref) {
  if (ref.kind === 'riyaaz') {
    const ex = exerciseById(ref.id);
    return ex ? `${ex.icon} ${ex.title}` : ref.id;
  }
  if (ref.kind === 'lesson') {
    const l = lessonById(ref.id);
    return l ? `${l.icon} ${l.title}` : ref.id;
  }
  return `${styleById(ref.styleId)?.singer ?? ''} · ${DRILL_LABELS[ref.id] || ref.id}`;
}

function begin({ minutes, focus }) {
  const tier = tierInfo();
  const context = buildTeacherContext(store, {
    lessonsPassed: `${tier.passed}/${tier.total}`,
    nextLesson: nextLesson()?.title ?? null,
    unlockedLessons: ALL_LESSONS.filter((l) => l.kind !== 'range' && isUnlocked(l.id)).map((l) => l.id),
  });
  current = { id: null, minutes, focus, startedAt: Date.now(), turn: 0, log: [], waiting: 'teacher', action: null, takes: [], exNo: 0, busy: false, error: null, lastStep: null, recorded: false };
  talk({ start: { minutes, focus, context } });
}

/** Send the student's side of the turn: { result?, message? }. */
function send(fields) {
  if (!current?.id || current.busy) return;
  talk({ body: { id: current.id, turn: current.turn, ...fields } });
}

function retry() {
  const last = current?.lastStep;
  if (!last) return;
  // A start that was cut off: ask for the opening again (the server replays it if it already ran).
  if (last.start && current.id) talk({ body: { id: current.id, turn: 0 } });
  else talk(last);
}

async function talk(step) {
  const lesson = current;
  lesson.busy = true;
  lesson.error = null;
  lesson.lastStep = step;
  lesson.waiting = 'teacher';
  const entry = { role: 'teacher', text: '' };
  lesson.log.push(entry);
  view?.refresh();
  voice().reset();
  abort = new AbortController();
  const signal = abort.signal;
  let action = null;
  let done = null;
  const onLine = (msg) => {
    if (msg.type === 'lesson') lesson.id = msg.id;
    else if (msg.type === 'text') {
      entry.text += msg.text;
      if (lesson === current) view?.live(entry.text);
      if (voiceOn() && view) voice().feed(entry.text);
    } else if (msg.type === 'retry') {
      entry.text = '';
      voice().reset();
      if (lesson === current) view?.live('');
    } else if (msg.type === 'action') action = msg.action;
    else if (msg.type === 'done') done = msg;
  };
  const dropEntry = () => {
    const i = lesson.log.indexOf(entry);
    if (i >= 0 && (!entry.text.trim() || signal.aborted)) lesson.log.splice(i, 1);
  };
  try {
    if (step.start) await startLesson(step.start, { signal, onLine });
    else await lessonStep(step.body, { signal, onLine });
    if (!done) throw new Error('The teacher’s reply was cut off. Try again.');
    lesson.turn = done.turn ?? lesson.turn;
    lesson.action = action;
    lesson.waiting = done.waiting;
    dropEntry();
    if (done.waiting === 'exercise' && action) lesson.exNo += 1;
    if (done.waiting === 'finished' && action) finish(lesson, action);
    if (done.waiting === 'ended') {
      lesson.log.push({ role: 'info', text: done.stop === 'refusal' ? 'Your teacher can’t continue this lesson. Start a new one whenever you like.' : 'The lesson stopped unexpectedly. Start a new one whenever you like.' });
    }
    const extra = action?.type === 'exercise' ? action.cue : action?.type === 'finish' ? action.recap : '';
    if (voiceOn() && view) voice().feed(`${entry.text}\n${extra}`, true);
  } catch (err) {
    dropEntry();
    if (signal.aborted) lesson.waiting = 'interrupted';
    else if (err.status === 404) {
      lesson.waiting = 'ended';
      lesson.log.push({ role: 'info', text: err.message });
    } else {
      lesson.waiting = 'error';
      lesson.error = err.message;
    }
  } finally {
    lesson.busy = false;
    if (abort?.signal === signal) abort = null;
    if (lesson === current) view?.refresh();
  }
}

function finish(lesson, action) {
  lesson.recap = action;
  lesson.endedAt = Date.now();
  if (lesson.recorded) return;
  lesson.recorded = true;
  recordLesson({
    at: Date.now(),
    minutes: lesson.minutes,
    usedMin: Math.max(1, Math.round((lesson.endedAt - lesson.startedAt) / 60000)),
    focus: lesson.focus,
    recap: action.recap,
    homework: action.homework,
    takes: lesson.takes,
  });
}

/** Leave the lesson for good; keep a record if the student sang at least once. */
function leave() {
  abort?.abort();
  if (current && !current.recorded && current.takes.length) {
    current.recorded = true;
    recordLesson({ at: Date.now(), minutes: current.minutes, usedMin: Math.max(1, Math.round((Date.now() - current.startedAt) / 60000)), focus: current.focus, recap: null, homework: [], takes: current.takes });
  }
  current = null;
  speaker?.stop();
}

/** A take finished inside the lesson: summarise it, draw it, and hand it to the teacher. */
function tookTake({ p, result, frames, styleCmp, insights, seconds }) {
  if (!current) return;
  const take = takeForLesson(p, result, { styleCmp, insights, seconds });
  let image = null;
  try {
    image = takeImage({
      title: p.title,
      targets: p.targets,
      frames,
      tolerance: p.tolerance,
      labelFn: p.sa != null ? (m) => swaraName(m, p.sa) : noteName,
      tonicPc: p.sa != null ? ((p.sa % 12) + 12) % 12 : null,
    });
  } catch {
    image = null;
  }
  if (image && image.length > MAX_IMAGE) image = null;
  current.takes.push({ title: p.title, score: result.score });
  current.log.push({ role: 'take', title: p.title, score: result.score, stars: result.stars });
  send({ result: { status: 'done', take, ...(image ? { image } : {}) } });
}

// ------------------------------------------------------------------ the screen

export function liveView(root) {
  let stageKey = null;
  let stageCleanup = null;
  let stageTook = false; // the exercise on stage has been sung (its results stay up while the teacher talks)
  let clock = null;
  let listener = null;
  let listening = false;
  const hooks = { refresh: () => {}, live: () => {} };
  view = hooks;

  if (current) mountLesson();
  else mountSetup();

  // ---- before the lesson

  function mountSetup() {
    const sa = riyaazSa();
    const styles = Object.values(store.styles).slice(0, 3);
    const past = (store.teacher.lessons || []).slice(-3).reverse();
    const focuses = [...FOCUSES, ...styles.map((s) => [`Singing in ${s.singer}’s style`, `🎤 ${s.singer}’s style`])];
    let minutes = 15;
    let focus = '';
    root.innerHTML = `
      <a class="back" href="#/teacher">← Teacher</a>
      <h1 style="margin-top:14px">🎓 A lesson with your teacher</h1>
      <p class="muted">Your teacher leads a live lesson. It picks each exercise and listens to every take: it reads your scores and looks at a picture of your pitch line. Then it tells you what to change and decides what comes next, like a guru beside you.</p>
      <div class="card stack">
        <div><div class="small muted" style="margin-bottom:6px">How long?</div>
          <div class="seg" id="len" style="grid-template-columns:repeat(3,1fr)">${LENGTHS.map((m) => `<button data-v="${m}" class="${m === minutes ? 'on' : ''}">${m} min</button>`).join('')}</div></div>
        <div><div class="small muted" style="margin-bottom:6px">What should we work on?</div>
          <div class="chips" id="focus">${focuses.map(([v, l], i) => `<button class="chip ${i === 0 ? 'on' : ''}" data-v="${esc(v)}">${esc(l)}</button>`).join('')}</div>
          <input type="text" id="focus-text" maxlength="200" placeholder="Or tell your teacher in your own words…" aria-label="What you want to work on" style="margin-top:10px;width:100%" />
        </div>
        <ul class="ready-list">
          <li>${store.voice ? `✅ Your range: ${esc(noteName(store.voice.low))}–${esc(noteName(store.voice.high))}` : '⚠️ No range test yet. Your teacher needs your range to pitch every exercise for your voice.'}</li>
          ${store.voice ? `<li>${sa != null ? `✅ Your Sa: ${esc(noteName(sa))}` : '⚠️ No Sa yet. Riyaaz exercises need one, so your teacher will use lessons.'}</li>` : ''}
          <li>🎧 Headphones help: the mic won’t pick up the guide notes or the teacher’s voice.</li>
        </ul>
        ${store.voice ? '<button class="btn big block" id="go" disabled>▶ Start the lesson</button>' : '<a class="btn big block" href="#/range">🔎 First, the 1-minute range test</a>'}
        <div id="status" class="small dim">Checking whether your teacher is connected…</div>
      </div>
      ${past.length ? `<div class="section-title"><h2>📒 Your last lessons</h2></div><div class="stack">${past.map(pastCard).join('')}</div>` : ''}`;

    root.querySelector('#len').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      minutes = Number(b.dataset.v);
      root.querySelectorAll('#len button').forEach((x) => x.classList.toggle('on', x === b));
    });
    root.querySelector('#focus').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      focus = b.dataset.v;
      root.querySelectorAll('#focus .chip').forEach((x) => x.classList.toggle('on', x === b));
    });
    root.querySelectorAll('[data-hw]').forEach((b) =>
      b.addEventListener('click', () => {
        const [kind, styleId, id] = b.dataset.hw.split('|');
        openExercise({ kind, id, styleId });
      }),
    );
    const go = root.querySelector('#go');
    go?.addEventListener('click', () => {
      const own = root.querySelector('#focus-text').value.trim();
      begin({ minutes, focus: own || focus });
      mountLesson();
    });
    teacherStatus().then((s) => {
      if (view !== hooks || current) return;
      const status = root.querySelector('#status');
      if (s.available) {
        if (go) go.disabled = false;
        status.textContent = `Your teacher runs on Claude (${s.model}). A lesson uses about one Claude request per take, billed to your Anthropic account. Stop any time if something hurts.`;
      } else {
        status.innerHTML = `<div class="setup-card"><b>🔌 Connect your teacher to Claude first</b>
          <p class="small" style="margin:6px 0">Live lessons need a Claude API key (from console.anthropic.com). Start Aria with it in PowerShell:</p>
          <code>$env:ANTHROPIC_API_KEY = "sk-ant-…"; npm start</code></div>`;
      }
    });
  }

  function pastCard(l) {
    const avg = l.takes.length ? Math.round(l.takes.reduce((s, t) => s + t.score, 0) / l.takes.length) : null;
    return `<div class="card stack">
      <div class="row between"><b>${esc(new Date(l.at).toLocaleDateString())}${l.focus ? ` · ${esc(l.focus)}` : ''}</b>
        <span class="small muted">${l.usedMin ?? l.minutes} min · ${l.takes.length} take${l.takes.length === 1 ? '' : 's'}${avg != null ? ` · average ${avg}` : ''}</span></div>
      ${l.recap ? `<p class="small muted" style="margin:0">${esc(l.recap)}</p>` : ''}
      ${l.homework?.length ? `<div class="row">${l.homework.map((h) => `<button class="btn small ghost" data-hw="${esc(h.kind)}|${esc(h.styleId || '')}|${esc(h.id)}">${esc(refLabel(h))}</button>`).join('')}</div>` : ''}
    </div>`;
  }

  // ---- during the lesson

  function mountLesson() {
    root.innerHTML = `
      <div class="live-head card">
        <div class="stack" style="gap:4px;flex:1;min-width:0">
          <div class="small muted">🎓 Live lesson${current.focus ? ` · ${esc(current.focus)}` : ''}</div>
          <div class="row" style="gap:10px"><b id="clock"></b><div class="bar" style="flex:1"><span id="clock-bar"></span></div></div>
        </div>
        <div class="row" style="gap:8px">
          ${voice().supported ? `<label class="toggle small"><span>🔊</span><input type="checkbox" id="tts" ${voiceOn() ? 'checked' : ''} aria-label="Speak the teacher’s replies"></label>` : ''}
          <button class="btn ghost small" id="end">End lesson</button>
        </div>
      </div>
      <div class="live-log" id="log" aria-live="polite"></div>
      <div id="stage" class="live-stage"></div>
      <form class="chat-form" id="reply" style="margin-top:14px">
        <textarea id="reply-input" rows="2" maxlength="2000" aria-label="Talk to your teacher"></textarea>
        <div class="chat-actions">
          <button type="button" class="btn ghost hidden" id="mic" aria-label="Speak to your teacher">🎙️</button>
          <button class="btn" id="send">Send</button>
        </div>
      </form>`;
    const log = root.querySelector('#log');
    const stage = root.querySelector('#stage');
    const input = root.querySelector('#reply-input');
    const sendBtn = root.querySelector('#send');
    const endBtn = root.querySelector('#end');

    const textHtml = (t) => esc(t).replace(/\n/g, '<br>');
    const typing = '<span class="typing"><i></i><i></i><i></i></span>';
    const entryHtml = (e) => {
      if (e.role === 'teacher') return `<div class="msg teacher"><div class="t-avatar small" aria-hidden="true">🧑‍🏫</div><div class="msg-body">${textHtml(e.text) || typing}</div></div>`;
      if (e.role === 'student') return `<div class="msg user"><div class="msg-body">${textHtml(e.text)}</div></div>`;
      if (e.role === 'take') return `<div class="take-row">🎤 ${esc(e.title)} <b>${e.score}</b><span class="stars-mini">${'★'.repeat(e.stars)}${'☆'.repeat(3 - e.stars)}</span></div>`;
      if (e.role === 'skip') return `<div class="take-row dim">⏭️ ${esc(e.title)} skipped</div>`;
      return `<div class="take-row info">ℹ️ ${esc(e.text)}</div>`;
    };
    const renderLog = () => {
      log.innerHTML = current.log.map(entryHtml).join('');
      log.scrollTop = log.scrollHeight;
    };

    const updateClock = () => {
      const label = root.querySelector('#clock');
      if (!current || !label) return;
      const used = Math.floor(((current.endedAt || Date.now()) - current.startedAt) / 60000);
      label.textContent = `${used} / ${current.minutes} min`;
      root.querySelector('#clock-bar').style.width = `${Math.min(100, (used / current.minutes) * 100)}%`;
    };

    function syncReply() {
      const w = current.waiting;
      const open = ['exercise', 'student', 'finished'].includes(w) && !current.busy;
      input.disabled = !open;
      sendBtn.disabled = !open;
      root.querySelector('#mic').disabled = !open;
      input.placeholder =
        w === 'teacher' ? 'Your teacher is talking…' : w === 'exercise' ? 'Want to say something? Sending skips this exercise.' : w === 'student' ? 'Answer your teacher…' : w === 'finished' ? 'Ask a follow-up about this lesson…' : '';
      sendBtn.textContent = w === 'exercise' ? 'Skip & send' : 'Send';
      const over = ['finished', 'ended', 'error', 'interrupted'].includes(w);
      endBtn.textContent = over ? 'Leave lesson' : 'End lesson';
      endBtn.disabled = current.busy;
      if (w === 'student' && document.activeElement !== input) input.focus({ preventScroll: true });
    }

    function syncStage() {
      const w = current.waiting;
      const a = current.action;
      const key = w === 'exercise' && a?.type === 'exercise' ? `ex:${current.turn}` : ['finished', 'ended', 'error', 'interrupted'].includes(w) ? `${w}:${current.turn}` : null;
      if (key === stageKey) return;
      if (key === null) {
        // Keep a sung take's results up while the teacher talks; clear an exercise that was skipped.
        if (stageKey?.startsWith('ex:') && !stageTook) {
          stageCleanup?.();
          stageCleanup = null;
          stageKey = null;
          stage.innerHTML = '';
        }
        return;
      }
      stageKey = key;
      stageCleanup?.();
      stageCleanup = null;
      if (w === 'exercise') return mountExercise(a);
      if (w === 'finished') stage.innerHTML = recapHtml();
      else if (w === 'ended') stage.innerHTML = `<div class="card stack"><b>This lesson has ended.</b><div class="row"><button class="btn" data-new>🎓 New lesson</button><a class="btn ghost" href="#/teacher">Back to teacher</a></div></div>`;
      else if (w === 'interrupted') stage.innerHTML = `<div class="card stack"><b>⏸️ Your lesson is paused.</b><p class="small muted" style="margin:0">You left the screen while your teacher was talking.</p><div class="row"><button class="btn" data-retry>▶ Continue the lesson</button></div></div>`;
      else stage.innerHTML = `<div class="chat-error stack"><span>⚠️ ${esc(current.error || 'Something went wrong.')}</span><div class="row"><button class="btn small" data-retry>↻ Try again</button></div></div>`;
      stage.querySelector('[data-retry]')?.addEventListener('click', retry);
      stage.querySelector('[data-new]')?.addEventListener('click', () => {
        leave();
        teardown();
        mountSetup();
      });
      stage.querySelectorAll('[data-hw]').forEach((b) =>
        b.addEventListener('click', () => {
          const [kind, styleId, id] = b.dataset.hw.split('|');
          openExercise({ kind, id, styleId });
        }),
      );
    }

    function mountExercise(a) {
      const built = practiceFor(a);
      if (built.error) {
        current.log.push({ role: 'info', text: `Couldn’t open ${refLabel(a)}, so your teacher will pick another.` });
        stage.innerHTML = '';
        send({ result: { status: 'failed', note: built.error } });
        return;
      }
      stage.innerHTML = `
        <div class="card ex-card">
          <div class="row between"><span class="pill brand">Exercise ${current.exNo}</span><button class="btn ghost small" id="skip">Skip this one</button></div>
          <div class="cue-big">🎯 ${esc(a.cue)}</div>
          <div id="ex-host"></div>
        </div>`;
      const host = stage.querySelector('#ex-host');
      stageTook = false;
      stageCleanup = practiceView(host, [], {
        practice: { ...built.practice, backHref: '#/live' },
        embedded: true,
        onStart: () => voice().stop(),
        onTake: (t) => {
          stageTook = true;
          stage.querySelector('#skip')?.remove();
          tookTake(t);
        },
      });
      stage.querySelector('#skip').addEventListener('click', () => {
        current.log.push({ role: 'skip', title: built.practice.title });
        send({ result: { status: 'skipped' } });
      });
      stage.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function recapHtml() {
      const r = current.recap;
      const scores = current.takes.map((t) => t.score);
      const avg = scores.length ? Math.round(scores.reduce((s, x) => s + x, 0) / scores.length) : null;
      return `
        <div class="card gold-card stack">
          <div class="row between"><h2 style="margin:0">📒 Lesson recap</h2><span class="pill gold">${current.takes.length} take${current.takes.length === 1 ? '' : 's'}${avg != null ? ` · average ${avg} · best ${Math.max(...scores)}` : ''}</span></div>
          <p style="margin:0">${esc(r.recap)}</p>
          ${r.homework.length ? `<div><div class="small muted" style="margin-bottom:6px">Practise before next time</div><div class="row">${r.homework.map((h) => `<button class="btn small" data-hw="${esc(h.kind)}|${esc(h.styleId || '')}|${esc(h.id)}">${esc(refLabel(h))}</button>`).join('')}</div></div>` : ''}
          <div class="row"><button class="btn ghost" data-new>🎓 New lesson</button><a class="btn ghost" href="#/teacher">Back to teacher</a></div>
          <p class="small dim" style="margin:0">Questions? Ask below. Your teacher still remembers this lesson.</p>
        </div>`;
    }

    function teardown() {
      clearInterval(clock);
      stageCleanup?.();
      stageCleanup = null;
      stageKey = null;
      listener?.stop();
    }

    hooks.refresh = () => {
      if (!current) return;
      renderLog();
      syncStage();
      syncReply();
      updateClock();
    };
    hooks.live = (text) => {
      const last = log.lastElementChild;
      if (last?.classList.contains('teacher')) last.querySelector('.msg-body').innerHTML = textHtml(text) || typing;
      log.scrollTop = log.scrollHeight;
    };

    root.querySelector('#reply').addEventListener('submit', (e) => {
      e.preventDefault();
      say(input.value);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        say(input.value);
      }
    });
    function say(raw) {
      const text = raw.trim();
      if (!text || !current || current.busy) return;
      const w = current.waiting;
      if (!['exercise', 'student', 'finished'].includes(w)) return;
      input.value = '';
      current.log.push({ role: 'student', text });
      if (w === 'exercise') send({ result: { status: 'skipped', note: 'The student stopped the exercise to say something.' }, message: text });
      else send({ message: text });
    }
    endBtn.addEventListener('click', () => {
      if (!current || current.busy) return;
      const w = current.waiting;
      if (w === 'exercise' || w === 'student') {
        const text = 'I need to stop here. Please wrap up the lesson.';
        current.log.push({ role: 'student', text });
        send({ ...(w === 'exercise' ? { result: { status: 'skipped', note: 'The student ended the lesson.' } } : {}), message: text });
        return;
      }
      leave();
      teardown();
      mountSetup();
    });
    root.querySelector('#tts')?.addEventListener('change', (e) => {
      setSetting('teacherVoice', e.target.checked);
      if (!e.target.checked) voice().stop();
    });

    listener = createListener({
      onText: (t) => (input.value = t),
      onEnd: (finalText) => {
        listening = false;
        root.querySelector('#mic')?.classList.remove('on');
        if (finalText) say(finalText);
      },
    });
    if (listener) {
      const mic = root.querySelector('#mic');
      mic.classList.remove('hidden');
      mic.addEventListener('click', () => {
        if (listening) return listener.stop();
        voice().stop();
        listening = true;
        mic.classList.add('on');
        listener.start();
      });
    }

    clock = setInterval(updateClock, 10_000);
    hooks.refresh();
    hooks.teardown = teardown;
  }

  return () => {
    view = null;
    hooks.teardown?.();
    // Leaving mid-reply pauses the lesson; "Continue" picks it up (the server keeps it).
    if (current?.busy) abort?.abort();
    speaker?.stop();
  };
}

export function hasLiveLesson() {
  return Boolean(current) && !['finished', 'ended'].includes(current.waiting);
}
