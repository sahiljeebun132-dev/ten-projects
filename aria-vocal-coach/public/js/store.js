// Progress, voice profile and settings — persisted in localStorage (this device only).
import { LEVELS, ALL_LESSONS, DEFAULT_RANGE } from './data/curriculum.js';
import { suggestSa, stageStatus, goldenVoice, today } from './data/riyaaz.js';

const KEY = 'aria.v1';

function defaults() {
  return {
    version: 1,
    voice: null, // { low, high, comfortLow, comfortHigh, type, measuredAt }
    lessons: {}, // id -> { best, stars, attempts }
    xp: 0,
    streak: { count: 0, last: null },
    skills: { pitch: null, stability: null, timing: null, agility: null },
    history: [],
    practiceSeconds: 0,
    // Riyaaz: your Sa, stage, daily log and the golden-voice ingredients.
    riyaaz: { sa: null, stage: 1, stageSince: null, days: {}, ema: {}, best: { dum: 0 }, reach: {}, log: [] },
    // What the AI teacher remembers: condensed takes, and your conversation with it.
    teacher: { takes: [], chat: [] },
    // Singer styles the teacher has learned: id -> { id, singer, songs, profile, trainedAt }
    styles: {},
    settings: { input: 'mic', guideVolume: 0.6, backingVolume: 0.8, speak: false, market: 'in', notation: 'sargam', tanpuraVolume: 0.35, teacherVoice: true },
  };
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const data = JSON.parse(raw);
    const d = defaults();
    return {
      ...d,
      ...data,
      settings: { ...d.settings, ...data.settings },
      skills: { ...d.skills, ...data.skills },
      riyaaz: { ...d.riyaaz, ...data.riyaaz },
      teacher: { ...d.teacher, ...data.teacher },
      styles: { ...data.styles },
    };
  } catch {
    return defaults();
  }
}

export const state = load();

export function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* storage full or blocked — progress just won't persist */
  }
}

export function setSetting(key, value) {
  state.settings[key] = value;
  save();
}

/** The range exercises are generated in. */
export function practiceRange() {
  return state.voice ? { low: state.voice.comfortLow, high: state.voice.comfortHigh } : DEFAULT_RANGE;
}

export function setVoice(voice) {
  state.voice = { ...voice, measuredAt: Date.now() };
  const prev = state.lessons.range;
  state.lessons.range = { best: 100, stars: 3, attempts: (prev?.attempts || 0) + 1 };
  if (!prev) state.xp += 50;
  touchStreak();
  save();
}

export function lessonProgress(id) {
  return state.lessons[id] || { best: 0, stars: 0, attempts: 0 };
}

export function isPassed(id) {
  return lessonProgress(id).stars >= 1;
}

/** A lesson unlocks when the lesson before it is passed (stars ≥ 1). */
export function isUnlocked(id) {
  const i = ALL_LESSONS.findIndex((l) => l.id === id);
  return i <= 0 || isPassed(ALL_LESSONS[i - 1].id);
}

export function nextLesson() {
  return ALL_LESSONS.find((l) => !isPassed(l.id) && isUnlocked(l.id)) || null;
}

export function currentLevel() {
  let lvl = LEVELS[0];
  for (const lv of LEVELS) if (isUnlocked(lv.lessons[0].id)) lvl = lv;
  return lvl;
}

export function tierInfo() {
  const passed = ALL_LESSONS.filter((l) => isPassed(l.id)).length;
  const mastered = ALL_LESSONS.every((l) => lessonProgress(l.id).stars === 3);
  const lv = currentLevel();
  return {
    passed,
    total: ALL_LESSONS.length,
    level: lv,
    title: mastered ? 'Grand Master' : lv.tier,
    badge: mastered ? '🏆' : lv.badge,
  };
}

function touchStreak() {
  const today = new Date().toISOString().slice(0, 10);
  const { last } = state.streak;
  if (last === today) return;
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  state.streak = { count: last === yesterday ? state.streak.count + 1 : 1, last };
  state.streak.last = today;
}

function ema(prev, value, a = 0.35) {
  return prev == null ? value : Math.round(prev + (value - prev) * a);
}

/** Record a scored take. Returns what changed so the UI can celebrate. */
export function recordAttempt(id, result, seconds = 0) {
  const prev = lessonProgress(id);
  const firstPass = prev.stars === 0 && result.stars >= 1;
  const xp = Math.round(result.score / 5) + (firstPass ? 40 : 0) + Math.max(0, result.stars - prev.stars) * 15;
  if (id) {
    state.lessons[id] = { best: Math.max(prev.best, result.score), stars: Math.max(prev.stars, result.stars), attempts: prev.attempts + 1 };
  }
  state.xp += xp;
  state.practiceSeconds += seconds;
  const s = state.skills;
  if (result.coverage > 20) {
    s.pitch = ema(s.pitch, result.accuracy);
    if (result.focus !== 'vibrato') s.stability = ema(s.stability, result.stability);
    if (result.notesHit > 0) s.timing = ema(s.timing, result.timing);
    if (result.focus === 'agility' || result.focus === 'song') s.agility = ema(s.agility, result.hitRate);
  }
  state.history.push({ id, at: Date.now(), score: result.score, accuracy: result.accuracy });
  if (state.history.length > 200) state.history.splice(0, state.history.length - 200);
  touchStreak();
  save();
  return { xp, firstPass, newBest: result.score > prev.best && prev.attempts > 0 };
}

export function resetProgress() {
  const { settings, styles } = state;
  Object.assign(state, defaults(), { settings, styles });
  save();
}

// ------------------------------------------------------------------ riyaaz

/** Your Sa (MIDI): chosen by you, else suggested from the range test, else null. */
export function riyaazSa() {
  return state.riyaaz.sa ?? suggestSa(state.voice);
}

export function setSa(midi) {
  state.riyaaz.sa = midi;
  save();
}

/** Full voice range used to keep riyaaz safe (never far beyond what you can sing). */
export function riyaazRange(sa = riyaazSa()) {
  return state.voice ? { low: state.voice.low, high: state.voice.high } : { low: sa - 7, high: sa + 17 };
}

const BREATH_EXERCISES = new Set(['omkar', 'dum', 'kharaj', 'sa-pa-sa']);

/** Log a riyaaz take; updates the golden-voice ingredients and may move you up a stage. */
export function recordRiyaaz(id, result, seconds = 0) {
  const r = state.riyaaz;
  const before = goldenVoice(r, state.voice);
  const day = today();
  const d = (r.days[day] ||= { done: {}, seconds: 0 });
  d.done[id] = Math.max(d.done[id] ?? 0, result.score);
  d.seconds += seconds;
  r.stageSince ||= day;
  r.log.push({ id, day, score: result.score });
  if (r.log.length > 80) r.log.splice(0, r.log.length - 80);
  const e = (r.ema ||= {});
  const cnt = (r.n ||= {});
  const feed = (key, value) => {
    e[key] = ema(e[key], value, 0.25);
    cnt[key] = (cnt[key] || 0) + 1;
  };
  if (result.coverage > 20) {
    feed('sur', result.accuracy);
    if (result.focus === 'stability' && result.stability > 0) feed('thehraav', result.stability);
    if (id === 'kharaj') feed('kharaj', result.score);
    if (id === 'bridge') feed('pul', result.score);
  }
  const prevDum = r.best.dum || 0;
  if (BREATH_EXERCISES.has(id)) r.best.dum = Math.max(prevDum, result.longestHold || 0);
  if ((id === 'kharaj' || id === 'taar') && state.voice) {
    for (const n of result.perNote) {
      if (!n.hit) continue;
      if (n.midi < state.voice.low) r.reach.low = Math.min(r.reach.low ?? Infinity, n.midi);
      if (n.midi > state.voice.high) r.reach.high = Math.max(r.reach.high ?? -Infinity, n.midi);
    }
  }
  const status = stageStatus(r, day);
  let advanced = false;
  if (status.ready) {
    r.stage += 1;
    r.stageSince = day;
    advanced = true;
  }
  touchStreak();
  save();
  return { before, after: goldenVoice(r, state.voice), advanced, stage: r.stage, dumRecord: r.best.dum > prevDum + 0.05 ? r.best.dum : null };
}

/** Riyaaz minutes today (for the "enough for today" nudge). */
export function riyaazMinutesToday() {
  return Math.round((state.riyaaz.days[today()]?.seconds || 0) / 60);
}

// ------------------------------------------------------------------ teacher & styles

export function recordTake(condensed) {
  state.teacher.takes.push(condensed);
  if (state.teacher.takes.length > 60) state.teacher.takes.splice(0, state.teacher.takes.length - 60);
  save();
}

export function saveStyle(style) {
  state.styles[style.id] = style;
  save();
}

export function deleteStyle(id) {
  delete state.styles[id];
  save();
}

/** A learned style by id (own keys only — never an inherited object property). */
export function styleById(id) {
  return typeof id === 'string' && Object.hasOwn(state.styles, id) ? state.styles[id] : null;
}

/** A trained style whose singer appears in an artist credit ("Mithoon & Arijit Singh"). */
export function styleForArtist(artist = '') {
  const a = artist.toLowerCase();
  return Object.values(state.styles).find((s) => a.includes(s.singer.toLowerCase())) || null;
}
