// The AI vocal teacher: today's diagnosis + homework, and "learn a singer's style" training.
import { esc, toast } from '../ui/dom.js';
import { handoff } from '../engine.js';
import { analyzeSong } from '../audio/analyze.js';
import { aggregateStyles, signature, keyAdvice, styleDrills } from '../audio/style.js';
import { lessonPlan } from '../audio/teacher.js';
import { noteName } from '../audio/notes.js';
import { state as store, save, saveStyle, deleteStyle, practiceRange, riyaazSa, setSetting, styleById, tierInfo, nextLesson } from '../store.js';
import { goPractice, riyaazHandoff, styleDrillHandoff, openExercise } from '../runners.js';
import { buildTeacherContext, parseReply, visibleText, historyForRequest, teacherStatus, streamTeacher, createSpeaker, createListener } from '../teacherTalk.js';
import { hasLiveLesson } from './live.js';

const QUICK_QUESTIONS = [
  'Plan my riyaaz for this week',
  'Why do I go flat or sharp?',
  'How do I sing like Arijit Singh?',
  'My voice cracks on high notes — what do I do?',
  'Review my recent takes',
];

const SINGERS = ['Arijit Singh', 'Justin Bieber', 'Shreya Ghoshal', 'Atif Aslam', 'Kishore Kumar', 'Lata Mangeshkar', 'Sonu Nigam', 'Ed Sheeran', 'Ariana Grande', 'Jubin Nautiyal', 'Adele', 'Mohammed Rafi'];
const SKIP = /instrumental|karaoke|remix|lo-?fi|slowed|reverb|8d|mashup|cover|reprise|beats|ringtone/i;

const titleCase = (s) => s.trim().replace(/\s+/g, ' ').replace(/\b\p{L}/gu, (c) => c.toUpperCase());
const slug = (s) => s.toLowerCase().trim().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'singer';

export function teacherView(root, params = []) {
  let cancelled = false;
  let training = false;
  root.innerHTML = `
    <h1>🧑‍🏫 Your AI vocal teacher</h1>
    <p class="muted">Talk to me about your singing — I read every take you sing, remember your habits and plan your lessons, like a real guru. Teach me a singer you love and I’ll coach you towards their technique.</p>
    <a class="card live-cta" href="#/live">
      <span class="q-ico">🎓</span>
      <span><b>${hasLiveLesson() ? 'Continue your live lesson' : 'Take a live lesson with me'}</b><br><span class="small muted">10–20 minutes. I choose each exercise, listen to every take, tell you what to change and decide what’s next.</span></span>
      <span class="btn small">${hasLiveLesson() ? 'Continue →' : 'Start →'}</span>
    </a>
    <div id="chat-root"></div>
    <div id="rest"></div>`;
  const el = root.querySelector('#rest');
  const chat = mountChat(root.querySelector('#chat-root'), { autoAsk: params[0] === 'ask' });

  function render() {
    const plan = lessonPlan(store.teacher.takes);
    const styles = Object.values(store.styles).sort((a, b) => b.trainedAt - a.trainedAt);
    const market = store.settings.market === 'us' ? 'us' : 'in';

    el.innerHTML = `
      <div class="section-title"><h2>📋 Today’s lesson plan</h2></div>
      <div class="card stack">
        <p class="muted" style="margin:0">${esc(plan.intro)}</p>
        ${plan.focus
          .map(
            (f, i) => `
          <div class="focus-item">
            <div class="row between"><b>${i === 0 ? '🎯' : '📌'} ${esc(f.title)}</b><span class="pill warn">${f.severity >= 0.6 ? 'Main focus' : 'Work on it'}</span></div>
            <p class="small muted" style="margin:6px 0 8px">${esc(f.why)}</p>
            <div class="row">${f.assign.map((a) => `<button class="btn small ${a.kind === 'riyaaz' ? '' : 'ghost'}" data-assign="${esc(a.kind)}:${esc(a.id)}">${a.kind === 'riyaaz' ? '🪔' : '🎓'} ${esc(a.label)}</button>`).join('')}</div>
          </div>`,
          )
          .join('')}
        ${plan.strengths.length ? `<div class="small" style="color:var(--good)">${plan.strengths.map((s) => `✅ ${esc(s)}`).join('<br>')}</div>` : ''}
        ${!plan.diagnosis.enough ? '<div class="row"><a class="btn" href="#/riyaaz">🪔 Start with riyaaz</a><a class="btn ghost" href="#/learn">🎓 Lessons</a><a class="btn ghost" href="#/songs">🎵 Sing a song</a></div>' : ''}
      </div>

      <div class="section-title"><h2>🎓 Learn a singer’s style</h2></div>
      <div class="card stack">
        <p class="muted" style="margin:0">Give me a singer — I’ll listen to their songs, measure <b>how</b> they sing (vibrato, murkis &amp; riffs, meend, breath, high notes) and build a style profile. Then I coach you towards it, phrase by phrase.</p>
        <form class="search" id="train-form">
          <input type="text" id="singer" placeholder="Singer — e.g. Arijit Singh, Justin Bieber" maxlength="60" autocomplete="off" aria-label="Singer name" />
          <select id="count" aria-label="Songs to learn from"><option value="5">5 songs</option><option value="8" selected>8 songs</option><option value="12">12 songs</option></select>
          <button class="btn" type="submit" id="train-btn">Train</button>
        </form>
        <div class="row small"><span class="muted">Catalogue:</span>
          <div class="seg" id="mkt" style="grid-template-columns:auto auto"><button data-v="in" class="${market === 'in' ? 'on' : ''}">🇮🇳 India</button><button data-v="us" class="${market === 'us' ? 'on' : ''}">🌍 Global</button></div>
        </div>
        <div class="chips">${SINGERS.map((s) => `<button class="chip" data-singer="${esc(s)}">${esc(s)}</button>`).join('')}</div>
        <label class="file-drop" style="margin-top:4px">
          <input type="file" id="files" accept="audio/*" multiple />
          <span style="font-size:1.6rem">📁</span>
          <span><b>Or train on your own recordings</b><br><span class="small muted">Type the singer above, then pick their songs (MP3/M4A/WAV). Analysed on your device — nothing is uploaded. A cappella or clear-vocal tracks teach best.</span></span>
        </label>
        <div id="train-status"></div>
        <p class="small dim" style="margin:0">I learn <em>technique</em> from the melody — I don’t copy, clone or imitate anyone’s voice. Your voice stays yours; you just learn their tricks.</p>
      </div>

      ${
        styles.length
          ? `<div class="section-title"><h2>🎤 Styles I’ve learned</h2></div>
             <div class="stack">${styles.map(styleCard).join('')}</div>`
          : ''
      }`;

    // Assignments.
    el.querySelectorAll('[data-assign]').forEach((b) =>
      b.addEventListener('click', () => {
        const [kind, id] = b.dataset.assign.split(':');
        if (kind === 'lesson') {
          location.hash = `#/lesson/${id}`;
          return;
        }
        if (riyaazSa() == null) {
          toast('First set your Sa on the Riyaaz page.', 'info');
          location.hash = '#/riyaaz';
          return;
        }
        goPractice(riyaazHandoff(id));
      }),
    );

    // Training.
    el.querySelector('#mkt').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      setSetting('market', b.dataset.v);
      el.querySelectorAll('#mkt button').forEach((x) => x.classList.toggle('on', x === b));
    });
    const singerInput = el.querySelector('#singer');
    el.querySelectorAll('[data-singer]').forEach((b) =>
      b.addEventListener('click', () => {
        singerInput.value = b.dataset.singer;
        train({ singer: b.dataset.singer });
      }),
    );
    el.querySelector('#train-form').addEventListener('submit', (e) => {
      e.preventDefault();
      if (singerInput.value.trim()) train({ singer: singerInput.value });
    });
    el.querySelector('#files').addEventListener('change', (e) => {
      const files = [...(e.target.files || [])].filter((f) => f.size <= 60 * 1024 * 1024);
      if (!files.length) return;
      if (!singerInput.value.trim()) {
        toast('Type the singer’s name first, then choose the files.', 'error');
        e.target.value = '';
        return;
      }
      train({ singer: singerInput.value, files });
    });

    // Style cards.
    el.querySelectorAll('[data-drill]').forEach((b) =>
      b.addEventListener('click', () => {
        const [sid, did] = b.dataset.drill.split('|');
        const h = styleDrillHandoff(sid, did);
        if (h) goPractice(h);
      }),
    );
    el.querySelectorAll('[data-sing]').forEach((b) =>
      b.addEventListener('click', () => {
        const [sid, idx] = b.dataset.sing.split('|');
        const song = styleById(sid)?.songs[Number(idx)];
        if (!song) return;
        const key = `web:${song.id}`;
        if (!handoff.songs.has(key)) handoff.songs.set(key, { source: 'web', ...song });
        location.hash = `#/song/${encodeURIComponent(key)}`;
      }),
    );
    el.querySelectorAll('[data-del]').forEach((b) =>
      b.addEventListener('click', () => {
        const s = styleById(b.dataset.del);
        if (s && confirm(`Forget ${s.singer}’s style?`)) {
          deleteStyle(s.id);
          render();
        }
      }),
    );
    el.querySelectorAll('[data-retrain]').forEach((b) =>
      b.addEventListener('click', () => {
        const s = styleById(b.dataset.retrain);
        if (s) train({ singer: s.singer });
      }),
    );
  }

  function styleCard(s) {
    const p = s.profile;
    const traits = signature(p);
    const drills = styleDrills(p, practiceRange(), s.singer);
    return `
      <div class="card style-card stack">
        <div class="row between">
          <div><h3 style="margin:0">${esc(s.singer)}</h3><div class="small muted">Learned from ${p.songs} song${p.songs === 1 ? '' : 's'} · ${Math.round(p.voicedSec)} s of singing · ${new Date(s.trainedAt).toLocaleDateString()}</div></div>
          <div class="row" style="gap:6px"><button class="btn ghost small" data-retrain="${esc(s.id)}">↻ Retrain</button><button class="btn ghost small" data-del="${esc(s.id)}" aria-label="Forget this style">🗑️</button></div>
        </div>
        <ul class="trait-list">${(traits.length ? traits : [{ icon: '🎯', text: 'A clean, direct style — few ornaments, steady notes.' }]).map((t) => `<li>${t.icon} ${esc(t.text)}</li>`).join('')}</ul>
        <div class="row small"><span class="pill">Range ${esc(noteName(p.range.lo))} – ${esc(noteName(p.range.hi))}</span><span class="pill">Sits around ${esc(noteName(p.range.med))}</span></div>
        <p class="small muted" style="margin:0">💡 ${esc(keyAdvice(p, practiceRange(), s.singer))}</p>
        <div><div class="small muted" style="margin-bottom:6px">Style drills (most characteristic first)</div>
          <div class="chips">${drills.map((d) => `<button class="chip" data-drill="${esc(s.id)}|${esc(d.id)}">${d.icon} ${esc(d.title)}</button>`).join('')}</div></div>
        ${
          s.songs.some((x) => x.previewUrl)
            ? `<div><div class="small muted" style="margin-bottom:6px">Sing their songs — I’ll score you on ${esc(s.singer)}’s style</div>
               <div class="chips">${s.songs
                 .map((x, i) => (x.previewUrl ? `<button class="chip" data-sing="${esc(s.id)}|${i}">🎵 ${esc(x.title.replace(/\s*\(.*?\)\s*/g, ' ').trim())}</button>` : ''))
                 .join('')}</div></div>`
            : ''
        }
      </div>`;
  }

  async function train({ singer, files = null }) {
    if (training) return toast('Already learning — one singer at a time.', 'info');
    const name = titleCase(singer);
    const statusEl = el.querySelector('#train-status');
    const btn = el.querySelector('#train-btn');
    const count = Number(el.querySelector('#count')?.value) || 8;
    training = true;
    btn.disabled = true;
    const status = (html) => statusEl.isConnected && (statusEl.innerHTML = html);
    try {
      let sources;
      if (files) {
        sources = files.slice(0, 20).map((f, i) => ({ kind: 'file', file: f, id: `file-${Date.now()}-${i}`, title: f.name.replace(/\.[^.]+$/, ''), artist: name }));
      } else {
        status(`<p class="muted"><span class="spinner"></span> Finding ${esc(name)}’s songs…</p>`);
        const market = store.settings.market === 'us' ? 'us' : 'in';
        const res = await fetch(`/api/search?q=${encodeURIComponent(name)}&market=${market}&limit=50`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Song search failed.');
        const lower = name.toLowerCase();
        const seen = new Set();
        const unique = (r) => {
          const k = r.title.toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').trim();
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        };
        sources = data.results.filter((r) => r.artist.toLowerCase().includes(lower) && !SKIP.test(r.title)).filter(unique);
        if (sources.length < 3) sources = data.results.filter((r) => !SKIP.test(r.title)).filter(unique);
        sources = sources.slice(0, count).map((r) => ({ kind: 'web', ...r }));
        if (!sources.length) throw new Error(`I couldn’t find songs by ${name}. Check the spelling, or switch the catalogue.`);
      }

      const styles = [];
      const songs = [];
      for (let i = 0; i < sources.length; i++) {
        if (cancelled) return;
        const src = sources[i];
        const bar = (p) => status(`
          <p class="muted" style="margin:0 0 6px">🎧 Listening to ${i + 1} of ${sources.length}: <b>${esc(src.title)}</b></p>
          <div class="bar"><span style="width:${Math.round(((i + p) / sources.length) * 100)}%"></span></div>
          <p class="small dim" style="margin:6px 0 0">${styles.length} song${styles.length === 1 ? '' : 's'} learned so far</p>`);
        bar(0);
        try {
          let audio;
          if (src.kind === 'web') {
            const r = await fetch(`/api/preview?url=${encodeURIComponent(src.previewUrl)}`);
            if (!r.ok) throw new Error('preview unavailable');
            audio = await r.arrayBuffer();
          } else {
            audio = await src.file.arrayBuffer();
          }
          const analysis = await analyzeSong(audio, bar);
          if (!analysis.style || analysis.style.voicedSec < 4) continue;
          styles.push(analysis.style);
          const meta = { id: src.id, title: src.title, artist: src.artist, artwork: src.artwork || '', previewUrl: src.previewUrl || '', key: analysis.key?.name || '' };
          songs.push(meta);
          // Keep the analysis for this session so singing the song later is instant.
          if (src.kind === 'web') handoff.songs.set(`web:${src.id}`, { source: 'web', ...meta, durationMs: src.durationMs || 0, analysis });
        } catch {
          /* skip songs that fail to download or decode */
        }
      }
      if (cancelled) return;
      if (styles.length < 2) throw new Error(`I couldn’t hear enough clear singing in those tracks to learn ${name}’s style. Try songs with a strong lead vocal.`);
      const profile = aggregateStyles(styles);
      saveStyle({ id: slug(name), singer: name, songs, profile, trainedAt: Date.now(), source: files ? 'files' : store.settings.market });
      toast(`🎓 Learned ${name}’s style from ${styles.length} songs`, 'good');
      render();
      el.querySelector('.style-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (err) {
      status(`<p class="muted">⚠️ ${esc(err.message)}</p>`);
    } finally {
      training = false;
      if (btn.isConnected) btn.disabled = false;
    }
  }

  render();
  return () => {
    cancelled = true;
    chat.destroy();
  };
}

// ------------------------------------------------------------------ the conversation

function mountChat(host, { autoAsk = false } = {}) {
  const speaker = createSpeaker();
  let busy = false;
  let abort = null;
  let listening = false;
  let available = null;
  const history = (store.teacher.chat ||= []);

  host.innerHTML = `
    <div class="card teacher-card chat-card">
      <div class="row between">
        <h2 style="margin:0">💬 Talk to your teacher</h2>
        <div class="row" style="gap:10px">
          ${speaker.supported ? `<label class="toggle small"><span>🔊 Speak replies</span><input type="checkbox" id="tts" ${store.settings.teacherVoice !== false ? 'checked' : ''}></label>` : ''}
          <button class="btn ghost small" id="new-chat" title="Start a fresh conversation">🧹 New chat</button>
        </div>
      </div>
      <div class="chat-log" id="chat-log" aria-live="polite"></div>
      <div class="chips" id="quick">${QUICK_QUESTIONS.map((q) => `<button class="chip" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>
      <form class="chat-form" id="chat-form">
        <textarea id="chat-input" rows="2" maxlength="2000" placeholder="Ask anything — “Why do I go flat on high notes?”, “Plan my riyaaz this week”…" aria-label="Your question"></textarea>
        <div class="chat-actions">
          <button type="button" class="btn ghost hidden" id="mic" title="Speak your question (uses your browser’s speech service)" aria-label="Speak your question">🎙️</button>
          <button class="btn" id="send">Send</button>
        </div>
      </form>
      <p class="small dim" style="margin:0" id="chat-note">Checking whether the teacher is connected…</p>
    </div>`;
  const log = host.querySelector('#chat-log');
  const input = host.querySelector('#chat-input');
  const sendBtn = host.querySelector('#send');
  const note = host.querySelector('#chat-note');
  const tts = () => speaker.supported && host.querySelector('#tts')?.checked;

  const styleIds = () => Object.keys(store.styles);
  const persist = () => {
    if (history.length > 40) history.splice(0, history.length - 40);
    save();
  };

  function bubble(role, html, actions = []) {
    return `<div class="msg ${role}">
      ${role === 'teacher' ? '<div class="t-avatar small" aria-hidden="true">🧑‍🏫</div>' : ''}
      <div class="msg-body">${html}${
        actions.length
          ? `<div class="msg-actions">${actions
              .map((a) => `<button class="btn small" data-act="${esc(a.kind)}|${esc(a.styleId || '')}|${esc(a.id)}">${esc(a.kind === 'drill' ? `${styleById(a.styleId)?.singer || ''} · ${a.label}` : a.label)}</button>`)
              .join('')}</div>`
          : ''
      }</div>
    </div>`;
  }
  const textHtml = (t) => esc(t).replace(/\n/g, '<br>');

  function renderLog(extra = '') {
    let html = '';
    if (!history.length) {
      const plan = lessonPlan(store.teacher.takes);
      html += bubble('teacher', `<b>${esc(plan.hello)}</b><br>${textHtml(plan.intro)}${available ? '<br>Ask me anything about your voice, your riyaaz or a song you love.' : ''}`);
    }
    for (const m of history) {
      if (m.role === 'user') html += bubble('user', textHtml(m.content));
      else {
        const r = parseReply(m.content, styleIds());
        html += bubble('teacher', textHtml(r.text), r.actions);
      }
    }
    log.innerHTML = html + extra;
    log.scrollTop = log.scrollHeight;
  }

  function setEnabled(on) {
    input.disabled = !on;
    sendBtn.disabled = !on || busy;
    host.querySelectorAll('#quick .chip').forEach((c) => (c.disabled = !on || busy));
  }

  async function ask(text, { focusTake = null } = {}) {
    text = text.trim();
    if (!text || busy || !available) return;
    busy = true;
    setEnabled(true);
    speaker.reset();
    input.value = '';
    history.push({ role: 'user', content: text });
    renderLog(bubble('teacher', '<span class="typing"><i></i><i></i><i></i></span>'));
    const live = log.lastElementChild.querySelector('.msg-body');
    let raw = '';
    abort = new AbortController();
    const tier = tierInfo();
    const next = nextLesson();
    const context = buildTeacherContext(store, { lessonsPassed: `${tier.passed}/${tier.total}`, nextLesson: next?.title ?? null, focusTake });
    try {
      const out = await streamTeacher({
        messages: historyForRequest(history),
        context,
        signal: abort.signal,
        onText: (chunk) => {
          raw += chunk;
          const shown = visibleText(raw);
          live.innerHTML = textHtml(shown) || '<span class="typing"><i></i><i></i><i></i></span>';
          log.scrollTop = log.scrollHeight;
          if (tts()) speaker.feed(shown);
        },
      });
      if (out.stop === 'refusal') {
        speaker.reset();
        raw = 'I can’t help with that one. Let’s get back to your singing — what would you like to work on?';
      } else if (out.stop === 'max_tokens') {
        raw += ' …';
      }
      if (!raw.trim()) raw = 'Hmm, I lost my words there. Could you ask me again?';
      history.push({ role: 'assistant', content: raw });
      persist();
      if (tts()) speaker.feed(visibleText(raw), true);
      busy = false;
      renderLog();
    } catch (err) {
      busy = false;
      if (abort.signal.aborted) return;
      history.pop(); // the question wasn't answered — don't keep it in the conversation
      persist();
      renderLog(`${bubble('user', textHtml(text))}<div class="chat-error">⚠️ ${esc(err.message)}</div>`);
      input.value = text;
    } finally {
      abort = null;
      setEnabled(available);
    }
  }

  // Events.
  host.querySelector('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    ask(input.value);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      ask(input.value);
    }
  });
  host.querySelector('#quick').addEventListener('click', (e) => {
    const q = e.target.closest('[data-q]')?.dataset.q;
    if (q) ask(q);
  });
  host.querySelector('#tts')?.addEventListener('change', (e) => {
    setSetting('teacherVoice', e.target.checked);
    if (!e.target.checked) speaker.stop();
  });
  host.querySelector('#new-chat').addEventListener('click', () => {
    abort?.abort();
    speaker.reset();
    history.length = 0;
    persist();
    renderLog();
  });
  log.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const [kind, styleId, id] = b.dataset.act.split('|');
    speaker.stop();
    openExercise({ kind, id, styleId });
  });

  const listener = createListener({
    onText: (t) => (input.value = t),
    onEnd: (finalText) => {
      listening = false;
      host.querySelector('#mic').classList.remove('on');
      if (finalText) ask(finalText);
    },
  });
  if (listener) {
    const mic = host.querySelector('#mic');
    mic.classList.remove('hidden');
    mic.addEventListener('click', () => {
      if (listening) return listener.stop();
      speaker.stop();
      listening = true;
      mic.classList.add('on');
      listener.start();
    });
  }

  renderLog();
  setEnabled(false);
  teacherStatus().then((s) => {
    if (!host.isConnected) return;
    available = !!s.available;
    if (available) {
      note.textContent = `Your teacher runs on Claude (${s.model}) and reads your saved practice data. Answers are AI-generated — always stop if anything hurts.`;
      setEnabled(true);
      renderLog();
      const focus = handoff.teacherFocus;
      if (autoAsk && focus) {
        handoff.teacherFocus = null;
        ask('Can you review the take I just sang?', { focusTake: focus });
      }
    } else {
      note.textContent = '';
      renderLog(`<div class="setup-card">
        <b>🔌 Connect me to Claude to start talking</b>
        <p class="small" style="margin:6px 0">I’m the part of Aria that can really converse — explain, plan and answer your questions. I need a Claude API key (from console.anthropic.com). Start Aria with it in PowerShell:</p>
        <code>$env:ANTHROPIC_API_KEY = "sk-ant-…"; npm start</code>
        <p class="small dim" style="margin:6px 0 0">The key stays on your computer — Aria’s server talks to Claude, your browser never sees it. Each question costs a small amount on your Anthropic account. Until then, the lesson plan below still works.</p>
      </div>`);
    }
  });

  return {
    destroy() {
      abort?.abort();
      speaker.stop();
      listener?.cancel();
    },
  };
}
