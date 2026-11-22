// Progress you can hear — the pure parts: what to keep from each take, which recordings stay in
// the library, week-by-week trends, and which old take to set beside a new one. No DOM or storage
// here, so it runs (and is tested) in Node; takes.js stores the records in the browser.

export const DAY = 86_400_000;
export const LIMITS = {
  maxTakes: 400,
  maxBytes: 80 * 1024 * 1024,
  recentPerExercise: 3,
  weeks: 26, // the best take of each week is kept this far back
  logSize: 2000,
  pitchPoints: 4000, // 20 per second: 200 seconds of pitch line
  targets: 400,
  notes: 60,
};
export const THEN_MIN_DAYS = 7; // an older take this far back is worth hearing beside today's
export const MONTH_DAYS = 28;
export const MIN_COVERAGE = 15; // below this the student barely sang: nothing to keep or chart

const round = (v, d = 0) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

/** Monday of the week (local time) a timestamp falls in, as 'YYYY-MM-DD'. */
export function weekOf(at) {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The pitch line at 20 points a second: [[t, midi | null], ...]. */
export function compactPitch(frames, step = 0.05, max = LIMITS.pitchPoints) {
  const out = [];
  let next = -Infinity;
  for (const f of frames || []) {
    if (!Number.isFinite(f?.t) || f.t < next) continue;
    next = f.t + step;
    out.push([round(f.t, 3), Number.isFinite(f.midi) ? round(f.midi, 2) : null]);
    if (out.length >= max) break;
  }
  return out;
}

/** Back to the frame shape the pitch picture draws. */
export function expandPitch(pitch) {
  return (Array.isArray(pitch) ? pitch : []).map(([t, midi]) => ({ t, midi }));
}

function compactTargets(targets) {
  return (targets || []).slice(0, LIMITS.targets).map((t) => ({
    midi: t.midi,
    start: round(t.start, 3),
    dur: round(t.dur, 3),
    role: t.role === 'listen' ? 'listen' : 'sing',
    ...(t.glideTo != null ? { glideTo: t.glideTo } : {}),
  }));
}

/** The numbers worth keeping from a scored take. */
export function takeStats(result) {
  return {
    score: result.score,
    stars: result.stars,
    focus: result.focus,
    tolerance: result.tolerance,
    accuracy: result.accuracy,
    coverage: result.coverage,
    stability: result.stability,
    timing: result.timing,
    longestHold: result.longestHold,
    meanSignedCents: result.meanSignedCents,
    notesHit: result.notesHit,
    notesTotal: result.notesTotal,
    scoops: result.scoops,
    vibratoNotes: result.vibratoNotes,
    // [midi, hit, average cents or null] per note, for the note-by-note list
    notes: (result.perNote || []).slice(0, LIMITS.notes).map((n) => [n.midi, n.hit ? 1 : 0, n.voicedFrac > 0.3 ? Math.round(n.meanErr) : null]),
  };
}

/** Whether a take is worth keeping and charting (the student actually sang). */
export const worthKeeping = (result) => Number(result?.coverage) >= MIN_COVERAGE;

/**
 * One take as the library keeps it (the audio Blob is added by the caller, or null for the demo voice).
 * `key` groups takes of the same exercise or song.
 */
export function takeRecord({ id, key, title, kind, at, sa = null, targets, frames, result, seconds = null }) {
  return {
    id,
    key: String(key).slice(0, 200),
    title: String(title || key).slice(0, 120),
    kind,
    at,
    sa: Number.isFinite(sa) ? sa : null,
    seconds: round(seconds, 1),
    stats: takeStats(result),
    targets: compactTargets(targets),
    pitch: compactPitch(frames),
    audio: null,
    mime: null,
    bytes: 0,
    starred: false,
  };
}

/** The small, always-kept log entry behind the weekly charts. */
export function logEntry({ key, kind, at, result }) {
  const sang = Number(result.coverage) > 20;
  return {
    at,
    key: String(key).slice(0, 200),
    kind,
    score: result.score,
    acc: sang ? result.accuracy : null,
    stab: sang && result.focus !== 'vibrato' && result.stability > 0 ? result.stability : null,
    tim: result.notesHit > 0 ? result.timing : null,
  };
}

/**
 * Why each recording deserves its place. Per exercise: the first one (where you started), the
 * best, the latest few, and the best of each week for half a year; starred ones always.
 * Returns Map(id -> Set of 'first' | 'best' | 'latest' | 'recent' | 'week' | 'starred').
 */
export function keepReasons(takes, { recentPerExercise = LIMITS.recentPerExercise, weeks = LIMITS.weeks } = {}, now = Date.now()) {
  const reasons = new Map(takes.map((t) => [t.id, new Set()]));
  const groups = new Map();
  for (const t of takes) {
    if (!groups.has(t.key)) groups.set(t.key, []);
    groups.get(t.key).push(t);
  }
  const since = now - weeks * 7 * DAY;
  for (const g of groups.values()) {
    g.sort((a, b) => a.at - b.at);
    reasons.get(g[0].id).add('first');
    reasons.get(g[g.length - 1].id).add('latest');
    for (const t of g.slice(-recentPerExercise)) reasons.get(t.id).add('recent');
    const best = g.reduce((b, t) => (scoreOf(t) >= scoreOf(b) ? t : b));
    reasons.get(best.id).add('best');
    const byWeek = new Map();
    for (const t of g) {
      if (t.at < since) continue;
      const w = weekOf(t.at);
      const b = byWeek.get(w);
      if (!b || scoreOf(t) >= scoreOf(b)) byWeek.set(w, t);
    }
    for (const t of byWeek.values()) reasons.get(t.id).add('week');
  }
  for (const t of takes) if (t.starred) reasons.get(t.id).add('starred');
  return reasons;
}

const scoreOf = (t) => t.stats?.score ?? t.score ?? 0;

/**
 * Which recordings to delete: every one without a reason to stay, then — only while the library is
 * over its caps — weekly snapshots, then extra recent takes, then anything but each exercise's
 * latest take and starred ones, oldest first within each tier.
 * takes: [{ id, key, at, stats: { score }, bytes, starred }]
 */
export function planPrune(takes, opts = {}, now = Date.now()) {
  const { maxTakes, maxBytes, recentPerExercise, weeks } = { ...LIMITS, ...opts };
  const reasons = keepReasons(takes, { recentPerExercise, weeks }, now);
  const doomed = [];
  const kept = new Set();
  let bytes = 0;
  for (const t of takes) {
    if (reasons.get(t.id).size) {
      kept.add(t);
      bytes += t.bytes || 0;
    } else doomed.push(t.id);
  }
  const over = () => kept.size > maxTakes || bytes > maxBytes;
  const has = (t, ...rs) => rs.some((r) => reasons.get(t.id).has(r));
  const tiers = [
    (t) => !has(t, 'first', 'best', 'latest', 'recent', 'starred'),
    (t) => !has(t, 'first', 'best', 'latest', 'starred'),
    (t) => !has(t, 'latest', 'starred'),
  ];
  for (const inTier of tiers) {
    if (!over()) break;
    const candidates = [...kept].filter(inTier).sort((a, b) => a.at - b.at);
    for (const t of candidates) {
      if (!over()) break;
      kept.delete(t);
      bytes -= t.bytes || 0;
      doomed.push(t.id);
    }
  }
  return doomed;
}

/**
 * An older take of the same exercise to hear beside `latest`: at least THEN_MIN_DAYS before it,
 * and the one closest to `aimDays` back (Infinity = the oldest, where you started).
 */
export function pickThen(group, latest, aimDays = Infinity) {
  const cutoff = latest.at - THEN_MIN_DAYS * DAY;
  const older = group.filter((t) => t.id !== latest.id && t.key === latest.key && t.at <= cutoff);
  if (!older.length) return null;
  if (aimDays === Infinity) return older.reduce((a, b) => (b.at < a.at ? b : a));
  const aim = latest.at - aimDays * DAY;
  return older.reduce((a, b) => (Math.abs(b.at - aim) < Math.abs(a.at - aim) ? b : a));
}

/** For each exercise with an old enough take: { key, title, then, now, days }, most recently sung first. */
export function thenAndNow(takes, aimDays = Infinity) {
  const groups = new Map();
  for (const t of takes) {
    if (!groups.has(t.key)) groups.set(t.key, []);
    groups.get(t.key).push(t);
  }
  const pairs = [];
  for (const g of groups.values()) {
    const latest = g.reduce((a, b) => (b.at > a.at ? b : a));
    const then = pickThen(g, latest, aimDays);
    if (then) pairs.push({ key: latest.key, title: latest.title, then, now: latest, days: Math.round((latest.at - then.at) / DAY) });
  }
  return pairs.sort((a, b) => b.now.at - a.now.at);
}

/**
 * The monthly "hear how far you've come" moment: a pair at least a month apart, sung recently,
 * and not shown in the last month. Returns the pair or null.
 */
export function monthlyNudge(pairs, seenAt, now = Date.now()) {
  if (seenAt != null && now - seenAt < MONTH_DAYS * DAY) return null;
  return pairs.find((p) => p.days >= MONTH_DAYS && now - p.now.at <= 14 * DAY) || null;
}

const mean = (xs) => {
  const v = xs.filter((x) => Number.isFinite(x));
  return v.length ? Math.round(v.reduce((s, x) => s + x, 0) / v.length) : null;
};

/**
 * Week-by-week averages for the last `weeks` weeks, oldest first:
 * [{ week, takes, score, inTune, steadiness, timing }] (null where there were no takes).
 */
export function weeklyTrend(log, { weeks = 12, now = Date.now() } = {}) {
  const byWeek = new Map();
  for (const e of log || []) {
    const w = weekOf(e.at);
    if (!byWeek.has(w)) byWeek.set(w, []);
    byWeek.get(w).push(e);
  }
  const out = [];
  const d = new Date(now);
  for (let i = weeks - 1; i >= 0; i--) {
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate() - i * 7);
    const week = weekOf(day.getTime());
    const es = byWeek.get(week) || [];
    out.push({
      week,
      takes: es.length,
      score: mean(es.map((e) => e.score)),
      inTune: mean(es.map((e) => e.acc)),
      steadiness: mean(es.map((e) => e.stab)),
      timing: mean(es.map((e) => e.tim)),
    });
  }
  return out;
}

/** What the teacher gets to know about the student's progress (small: it rides on every request). */
export function progressSummary(log, now = Date.now()) {
  const trend = weeklyTrend(log, { weeks: 8, now });
  const active = trend.filter((w) => w.takes);
  if (!active.length) return null;
  return {
    weeksPractisedOfLast8: active.length,
    weekly: trend
      .map((w, i) => ({ weeksAgo: trend.length - 1 - i, takes: w.takes, avgScore: w.score, inTunePct: w.inTune, steadiness: w.steadiness }))
      .filter((w) => w.takes),
  };
}

/** One stored take as the teacher reads it when comparing then and now. */
export function takeSummary(rec, now = Date.now(), label = (m) => String(m)) {
  const s = rec.stats || {};
  return {
    sungDaysAgo: Math.max(0, Math.round((now - rec.at) / DAY)),
    score: s.score,
    inTunePct: s.accuracy,
    notesHit: `${s.notesHit}/${s.notesTotal}`,
    avgCentsOff: s.meanSignedCents,
    steadiness: s.stability,
    timing: s.timing,
    longestSteadyNoteSec: s.longestHold,
    scoops: s.scoops,
    vibratoNotes: s.vibratoNotes,
    ...(rec.seconds != null ? { durationSec: Math.round(rec.seconds) } : {}),
    noteByNote: (s.notes || []).slice(0, 40).map(([m, hit, cents]) => ({ note: label(m), hit: Boolean(hit), avgCents: cents })),
  };
}
