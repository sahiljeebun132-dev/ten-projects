// The talking AI teacher — browser side: what the teacher gets to see (your practice data),
// the reply parser (exercise buttons), streaming from the server, and voice in / voice out.
import { noteName } from './audio/notes.js';
import { harmoniumScale, swaraName } from './audio/sargam.js';
import { EXERCISES, stageStatus, goldenVoice, suggestSa } from './data/riyaaz.js';
import { ALL_LESSONS } from './data/curriculum.js';
import { diagnose } from './audio/teacher.js';
import { signature } from './audio/style.js';

export const DRILL_LABELS = {
  murki: '🌀 Murki drill',
  meend: '〰️ Meend drill',
  vibrato: '🌊 Vibrato drill',
  flip: '🕊️ Falsetto-flip drill',
  runs: '⚡ Runs drill',
  breath: '🌬️ Breath drill',
};

const range = (lo, hi) => `${noteName(lo)}–${noteName(hi)}`;

/** Everything the teacher may know about the student — built from saved progress only. */
export function buildTeacherContext(state, { lessonsPassed = null, nextLesson = null, unlockedLessons = null, focusTake = null } = {}) {
  const r = state.riyaaz || {};
  const voice = state.voice;
  const sa = r.sa ?? suggestSa(voice);
  const st = stageStatus(r);
  const gold = goldenVoice(r, voice);
  const takes = (state.teacher?.takes || []).slice(-8);
  const d = diagnose(state.teacher?.takes || []);
  const ctx = {
    voice: voice ? { type: voice.type, fullRange: range(voice.low, voice.high), exerciseRange: range(voice.comfortLow, voice.comfortHigh) } : 'not measured yet (range test not taken)',
    riyaaz: {
      sa: sa != null ? `${noteName(sa)} (${harmoniumScale(sa)})` : 'not set',
      stage: `${st.stage.n} of 5 — ${st.stage.name} (${st.stage.meaning})`,
      riyaazDaysThisStage: st.days,
      recentAverageScore: st.avg || null,
      nextStageNeeds: st.stage.need ? `${st.stage.need.days} riyaaz days and an average of ${st.stage.need.avg}+` : 'final stage',
      unlockedExercises: EXERCISES.filter((e) => e.stage <= st.stage.n).map((e) => e.id),
      bestBreathHoldSec: r.best?.dum || null,
    },
    goldenVoice: { score: gold.score, tier: gold.tier.name, parts: Object.fromEntries(gold.parts.map((p) => [p.label, p.value])) },
    lessons: { passed: lessonsPassed, next: nextLesson, ...(unlockedLessons ? { unlocked: unlockedLessons } : {}) },
    recentTakes: takes.map((t) => ({
      what: t.title || t.id,
      kind: t.kind,
      daysAgo: Math.max(0, Math.round((Date.now() - t.at) / 86400000)),
      score: t.score,
      inTunePct: t.accuracy,
      avgCentsOff: t.cents,
      steadiness: t.stability,
      timing: t.timing,
      longestSteadyNoteSec: t.hold,
      scoops: t.scoops,
      notes: t.notes,
      ...(t.style != null ? { styleMatchPct: t.style } : {}),
    })),
    appDiagnosis: d.enough ? { issues: d.issues.map((i) => i.title), strengths: d.strengths } : 'not enough takes yet',
    learnedSingerStyles: Object.values(state.styles || {})
      .slice(0, 6)
      .map((s) => ({
        id: s.id,
        singer: s.singer,
        songsAnalysed: s.songs.length,
        traits: signature(s.profile).map((t) => t.text),
        typicalRange: range(s.profile.range.lo, s.profile.range.hi),
        vibratoOnLongNotes: s.profile.vibratoShare,
        ornamentsPerSec: s.profile.ornamentRate,
        slideShare: s.profile.glideShare,
        breathPerPhraseSec: s.profile.phraseLen,
      })),
  };
  const pastLessons = (state.teacher?.lessons || []).slice(-3);
  if (pastLessons.length) {
    ctx.recentLessons = pastLessons.map((l) => ({
      daysAgo: Math.max(0, Math.round((Date.now() - l.at) / 86400000)),
      minutes: l.usedMin ?? l.minutes,
      focus: l.focus || null,
      takes: l.takes.length,
      averageScore: l.takes.length ? Math.round(l.takes.reduce((s, t) => s + t.score, 0) / l.takes.length) : null,
      recap: l.recap || null,
    }));
  }
  if (focusTake) ctx.focusTake = focusTake;
  return ctx;
}

/**
 * What the teacher gets back after a take in a live lesson: the summary plus a note-by-note list
 * (in sargam when the exercise has a Sa) and how long the take ran.
 */
export function takeForLesson(p, result, { styleCmp = null, insights = [], seconds = null } = {}) {
  const label = (m) => (p.sa != null ? `${swaraName(m, p.sa)} (${noteName(m)})` : noteName(m));
  return {
    ...summarizeTake(p, result, { styleCmp, insights }),
    ...(seconds != null ? { durationSec: Math.round(seconds) } : {}),
    ...(p.sa != null ? { sa: noteName(p.sa) } : {}),
    noteByNote: result.perNote.slice(0, 40).map((n) => ({
      note: label(n.midi),
      hit: n.hit,
      avgCents: n.voicedFrac > 0.3 ? Math.round(n.meanErr) : null,
      ...(n.scoop ? { scoop: true } : {}),
    })),
  };
}

/** A compact, teacher-readable summary of one scored take (for "review my take"). */
export function summarizeTake(p, result, { styleCmp = null, insights = [] } = {}) {
  return {
    exercise: p.title,
    kind: p.riyaaz ? 'riyaaz' : p.lessonId ? 'lesson' : p.focus === 'song' ? 'song' : 'exercise',
    score: result.score,
    stars: result.stars,
    inTunePct: result.accuracy,
    notesHit: `${result.notesHit}/${result.notesTotal}`,
    avgCentsOff: result.meanSignedCents,
    steadiness: result.stability,
    timing: result.timing,
    longestSteadyNoteSec: result.longestHold,
    scoops: result.scoops,
    vibratoNotes: result.vibratoNotes,
    missedNotes: result.perNote.filter((n) => !n.hit).length,
    appTips: insights.slice(0, 4).map((i) => i.text),
    ...(styleCmp ? { styleMatch: { pct: styleCmp.match, tips: styleCmp.tips.map((t) => t.text) } } : {}),
  };
}

const TAG = /\[\[\s*(riyaaz|lesson|drill)\s*:\s*([\p{L}\p{N}-]+)(?:\s*:\s*([\p{L}\p{N}-]+))?\s*\]\]/giu;

/** The reply as it should be shown and spoken: tags removed (including a half-streamed one). */
export function visibleText(text) {
  return text
    .replace(TAG, '')
    .replace(/\[\[[^\]\n]{0,120}\]\]/gu, '') // malformed or unknown tags are never shown either
    .replace(/\[\[[^\]\n]*\]?$/u, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Turn exercise tags into buttons — only for exercises, lessons and drills that really exist. */
export function parseReply(text, styleIds = []) {
  const actions = [];
  const seen = new Set();
  for (const m of text.matchAll(TAG)) {
    const kind = m[1].toLowerCase();
    const a = m[2].toLowerCase();
    const b = m[3]?.toLowerCase();
    let act = null;
    if (kind === 'riyaaz' && !b) {
      const ex = EXERCISES.find((e) => e.id === a);
      if (ex) act = { kind, id: ex.id, stage: ex.stage, label: `${ex.icon} ${ex.title}` };
    } else if (kind === 'lesson' && !b) {
      const l = ALL_LESSONS.find((x) => x.id === a);
      if (l) act = { kind, id: l.id, label: `${l.icon} ${l.title}` };
    } else if (kind === 'drill' && b && Object.hasOwn(DRILL_LABELS, b)) {
      const sid = styleIds.find((s) => s.toLowerCase() === a);
      if (sid) act = { kind, styleId: sid, id: b, label: DRILL_LABELS[b] };
    }
    const key = act && `${act.kind}:${act.styleId || ''}:${act.id}`;
    if (act && !seen.has(key) && actions.length < 3) {
      seen.add(key);
      actions.push(act);
    }
  }
  return { text: visibleText(text), actions };
}

/** The last few turns, cleaned so they alternate student / teacher and start with the student. */
export function historyForRequest(chat, max = 12) {
  const merged = [];
  for (const m of chat) {
    if (!m?.content?.trim() || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role) prev.content = `${prev.content}\n\n${m.content}`.slice(-8000);
    else merged.push({ role: m.role, content: m.content.slice(0, m.role === 'user' ? 2000 : 8000) });
  }
  let out = merged.slice(-max);
  while (out.length && out[0].role !== 'user') out = out.slice(1);
  return out;
}

// ------------------------------------------------------------------ network

export async function teacherStatus() {
  try {
    const res = await fetch('/api/teacher/status');
    return res.ok ? await res.json() : { available: false };
  } catch {
    return { available: false };
  }
}

/** POST JSON and read the NDJSON reply line by line; an `error` line throws. */
async function postLines(url, body, { signal, onLine }) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw Object.assign(new Error(data.error || `The teacher is unavailable (${res.status}).`), { status: res.status });
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.type === 'error') throw new Error(msg.error);
      onLine(msg);
    }
  }
}

/** Stream a reply; calls onText(chunk) as text arrives. Resolves to { stop, model, usage }. */
export async function streamTeacher({ messages, context, onText, signal }) {
  let done = null;
  await postLines('/api/teacher/chat', { messages, context }, {
    signal,
    onLine: (msg) => {
      if (msg.type === 'text') onText(msg.text);
      else if (msg.type === 'done') done = msg;
    },
  });
  return done || { stop: 'unknown' };
}

/**
 * Teacher-led lessons. Both stream lines to onLine: { type: 'lesson', id } (start only),
 * 'text' chunks, 'retry' (drop this turn's text so far), 'action' (an exercise to run, or the
 * lesson's finish), then 'done' with { turn, waiting: 'exercise'|'student'|'finished'|'ended' }.
 */
export function startLesson({ minutes, focus, context }, { signal, onLine }) {
  return postLines('/api/teacher/lesson/start', { minutes, focus, context }, { signal, onLine });
}

/** The student's side of a lesson turn: { id, turn, result?: { status, take, image, note }, message? }. */
export function lessonStep(body, { signal, onLine }) {
  return postLines('/api/teacher/lesson/step', body, { signal, onLine });
}

// ------------------------------------------------------------------ voice out / voice in

/** Speaks the reply sentence by sentence while it streams in. */
export function createSpeaker() {
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
  let spoken = 0;
  let voice = null;
  const pick = () => {
    const vs = synth.getVoices();
    return vs.find((v) => /en[-_]IN/i.test(v.lang)) || vs.find((v) => /hi[-_]IN/i.test(v.lang)) || vs.find((v) => /^en[-_](GB|US)/i.test(v.lang)) || vs[0] || null;
  };
  const say = (text) => {
    const clean = text.replace(/[*_#>`•]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!clean) return;
    const u = new SpeechSynthesisUtterance(clean);
    voice ||= pick();
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    }
    u.rate = 1.02;
    synth.speak(u);
  };
  return {
    supported: Boolean(synth),
    reset() {
      spoken = 0;
      synth?.cancel();
    },
    /** Feed the visible text so far; speaks every newly completed sentence (or the rest, if final). */
    feed(text, final = false) {
      if (!synth) return;
      const rest = text.slice(spoken);
      const chunk = final ? rest : rest.match(/^[\s\S]*[.!?।](?=\s|$)/u)?.[0];
      if (!chunk) return;
      spoken += chunk.length;
      say(chunk);
    },
    stop() {
      synth?.cancel();
    },
  };
}

/** Browser speech recognition (Chrome/Edge send the audio to their speech service to transcribe). */
export function createListener({ onText, onEnd, lang = 'en-IN' }) {
  const Rec = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;
  if (!Rec) return null;
  let rec = null;
  return {
    start() {
      rec = new Rec();
      rec.lang = lang;
      rec.interimResults = true;
      rec.continuous = false;
      let finalText = '';
      rec.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
          else interim += e.results[i][0].transcript;
        }
        onText((finalText + interim).trim());
      };
      rec.onerror = () => onEnd?.('');
      rec.onend = () => onEnd?.(finalText.trim());
      rec.start();
    },
    stop() {
      rec?.stop();
    },
  };
}
