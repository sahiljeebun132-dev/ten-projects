// Progress, voice profile and settings — persisted in localStorage (this device only).
import { LEVELS, ALL_LESSONS, DEFAULT_RANGE } from './data/curriculum.js';

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
    settings: { input: 'mic', guideVolume: 0.6, backingVolume: 0.8, speak: false },
  };
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const data = JSON.parse(raw);
    const d = defaults();
    return { ...d, ...data, settings: { ...d.settings, ...data.settings }, skills: { ...d.skills, ...data.skills } };
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
  const settings = state.settings;
  Object.assign(state, defaults(), { settings });
  save();
}
