// Scores a sung take against target notes. Pure — shared by the app and tests.
//
// frames:  [{ t, midi|null, rms }]   (t in seconds on the exercise clock, sorted)
// targets: [{ midi, start, dur, glideTo?, role: 'sing'|'listen' }]

import { foldToOctave, median, clamp } from './notes.js';

export function targetMidiAt(target, t) {
  if (target.glideTo == null) return target.midi;
  const k = clamp((t - target.start) / target.dur, 0, 1);
  return target.midi + (target.glideTo - target.midi) * k;
}

/** Signed error in cents (octave-folded) plus the octave the singer used. */
export function pitchError(sungMidi, targetMidi) {
  const diff = sungMidi - targetMidi;
  return { cents: foldToOctave(diff) * 100, octave: Math.round(diff / 12) };
}

/** Vibrato rate (Hz) and peak-to-peak depth (cents) from an error series. */
export function measureVibrato(points) {
  if (points.length < 20) return { rate: 0, depth: 0 };
  const dur = points[points.length - 1].t - points[0].t;
  if (dur < 0.8) return { rate: 0, depth: 0 };
  // Detrend with a ~0.3 s moving average.
  const det = points.map((p) => {
    let s = 0;
    let c = 0;
    for (const q of points) {
      if (Math.abs(q.t - p.t) <= 0.15) {
        s += q.cents;
        c++;
      }
    }
    return p.cents - s / c;
  });
  let crossings = 0;
  for (let i = 1; i < det.length; i++) if ((det[i - 1] < 0) !== (det[i] < 0)) crossings++;
  const rms = Math.sqrt(det.reduce((s, x) => s + x * x, 0) / det.length);
  return { rate: crossings / 2 / dur, depth: 2 * Math.SQRT2 * rms };
}

export function isVibrato({ rate, depth }) {
  return rate >= 4 && rate <= 8.5 && depth >= 18 && depth <= 160;
}

const WEIGHTS = {
  pitch: { accuracy: 0.55, coverage: 0.15, stability: 0.15, timing: 0.15 },
  stability: { accuracy: 0.4, stability: 0.4, coverage: 0.2 },
  agility: { hitRate: 0.45, accuracy: 0.35, timing: 0.2 },
  dynamics: { accuracy: 0.45, dynamics: 0.35, coverage: 0.2 },
  vibrato: { accuracy: 0.45, vibrato: 0.35, coverage: 0.2 },
  song: { accuracy: 0.5, hitRate: 0.2, timing: 0.15, coverage: 0.15 },
};

export function starsFor(score) {
  return score >= 90 ? 3 : score >= 75 ? 2 : score >= 60 ? 1 : 0;
}

export function scoreTake(frames, targets, { tolerance = 50, attack = 0.12, release = 0.04, focus = 'pitch' } = {}) {
  const sing = targets.map((t, i) => ({ ...t, index: i })).filter((t) => t.role !== 'listen');
  const perNote = [];
  let totalFrames = 0;
  let totalVoiced = 0;
  let totalInTune = 0;
  const allErr = [];
  const octaves = [];
  let fi = 0;

  for (const tg of sing) {
    const att = Math.min(attack, tg.dur * 0.25);
    const w0 = tg.start + att;
    const w1 = tg.start + tg.dur - Math.min(release, tg.dur * 0.15);
    while (fi < frames.length && frames[fi].t < tg.start) fi++;
    const errs = [];
    const early = [];
    const rmsSeries = [];
    let total = 0;
    let voiced = 0;
    let inTune = 0;
    let onset = null;
    for (let k = fi; k < frames.length && frames[k].t <= w1; k++) {
      const fr = frames[k];
      const tm = targetMidiAt(tg, fr.t);
      if (fr.t < w0) {
        if (fr.midi != null) early.push(pitchError(fr.midi, tm).cents);
        continue;
      }
      total++;
      if (fr.midi == null) continue;
      voiced++;
      const e = pitchError(fr.midi, tm);
      errs.push({ t: fr.t, cents: e.cents });
      rmsSeries.push(fr.rms ?? 0);
      octaves.push(e.octave);
      if (Math.abs(e.cents) <= tolerance) {
        inTune++;
        if (onset == null) onset = fr.t - tg.start;
      }
    }
    const cents = errs.map((e) => e.cents);
    const meanErr = cents.length ? cents.reduce((s, x) => s + x, 0) / cents.length : 0;
    const meanAbs = cents.length ? cents.reduce((s, x) => s + Math.abs(x), 0) / cents.length : 0;
    const std = cents.length > 1 ? Math.sqrt(cents.reduce((s, x) => s + (x - meanErr) ** 2, 0) / cents.length) : 0;
    const third = Math.max(1, Math.floor(rmsSeries.length * 0.3));
    const rmsStart = rmsSeries.length ? avg(rmsSeries.slice(0, third)) : 0;
    const rmsEnd = rmsSeries.length ? avg(rmsSeries.slice(-third)) : 0;
    const vib = tg.dur >= 1.5 ? measureVibrato(errs) : { rate: 0, depth: 0 };
    perNote.push({
      index: tg.index,
      midi: tg.midi,
      start: tg.start,
      dur: tg.dur,
      total,
      voicedFrac: total ? voiced / total : 0,
      inTuneFrac: total ? inTune / total : 0,
      meanErr,
      meanAbs,
      std,
      onset,
      hit: total > 0 && inTune / total >= 0.4,
      scoop: early.length >= 2 && avg(early) < -45 && meanErr > -25,
      crescendo: rmsStart > 0 ? rmsEnd / rmsStart : 0,
      vibrato: vib,
    });
    totalFrames += total;
    totalVoiced += voiced;
    totalInTune += inTune;
    allErr.push(...cents);
  }

  const accuracy = totalFrames ? (totalInTune / totalFrames) * 100 : 0;
  const coverage = totalFrames ? (totalVoiced / totalFrames) * 100 : 0;
  const meanSignedCents = allErr.length ? allErr.reduce((s, x) => s + x, 0) / allErr.length : 0;
  const steadyNotes = perNote.filter((n) => n.total >= 10 && n.voicedFrac > 0.5);
  const vibratoNotes = perNote.filter((n) => isVibrato(n.vibrato));
  const avgStd = steadyNotes.length ? avg(steadyNotes.map((n) => n.std)) : 60;
  const stability = steadyNotes.length ? clamp(100 - (avgStd - 10) * 2.2, 0, 100) : 0;
  const hits = perNote.filter((n) => n.hit);
  const hitRate = perNote.length ? (hits.length / perNote.length) * 100 : 0;
  const onsets = hits.map((n) => n.onset).filter((x) => x != null);
  const medOnset = onsets.length ? median(onsets) : null;
  const timing = medOnset == null ? 0 : clamp(100 - Math.max(0, medOnset - 0.1) * 200, 0, 100);
  const longNotes = perNote.filter((n) => n.dur >= 1.5 && n.voicedFrac > 0.4);
  const bestCresc = longNotes.length ? Math.max(...longNotes.map((n) => n.crescendo)) : 0;
  const dynamics = clamp((bestCresc - 1) * 100, 0, 100);
  const vibrato = longNotes.length
    ? Math.max(...longNotes.map((n) => (isVibrato(n.vibrato) ? 100 : clamp(n.vibrato.depth / 18, 0, 1) * clamp(n.vibrato.rate / 4, 0, 1) * 60)))
    : 0;

  const metrics = { accuracy, coverage, stability, timing, hitRate, dynamics, vibrato };
  const weights = WEIGHTS[focus] || WEIGHTS.pitch;
  let raw = 0;
  for (const [k, w] of Object.entries(weights)) raw += metrics[k] * w;
  // A gentle curve so near-misses still feel like progress.
  const score = Math.round(100 * Math.pow(clamp(raw, 0, 100) / 100, 0.85));

  const octaveMode = octaves.length ? Math.round(median(octaves)) : 0;
  return {
    score,
    stars: starsFor(score),
    focus,
    tolerance,
    ...roundAll(metrics),
    meanSignedCents: Math.round(meanSignedCents),
    avgStd: Math.round(avgStd),
    notesHit: hits.length,
    notesTotal: perNote.length,
    scoops: perNote.filter((n) => n.scoop).length,
    vibratoNotes: vibratoNotes.length,
    bestCrescendo: Math.round(bestCresc * 100) / 100,
    octaveMode,
    perNote,
  };
}

function avg(a) {
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
}

function roundAll(o) {
  const r = {};
  for (const [k, v] of Object.entries(o)) r[k] = Math.round(v);
  return r;
}
