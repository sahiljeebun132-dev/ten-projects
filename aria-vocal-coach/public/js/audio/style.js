// Vocal STYLE analysis — not whether the notes are right, but HOW someone sings them:
// vibrato, ornaments (murkis / harkats / riffs), slides (meend), scoops, breath per phrase,
// note speed and use of the high range. Works on any pitch track: the melody extracted from
// a recording, or a singer's live take. Pure — shared by the app, the worker and the tests.
//
// This is what the AI teacher "learns" from a singer's songs: a measured style profile.
import { median, percentile, clamp, noteName } from './notes.js';
import { measureVibrato, isVibrato } from './scoring.js';

const PHRASE_GAP = 0.25; // silence that ends a phrase (a breath)
const TURN_SEMIS = 0.9; // smallest pitch swing that counts as an ornament turn

const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

/** Split voiced points into phrases, drop pitch-tracker spikes, light median smoothing. */
function phrasesOf(points) {
  const raw = [];
  let cur = null;
  let last = -Infinity;
  for (const p of points) {
    if (p.m == null || !Number.isFinite(p.m)) continue;
    if (!cur || p.t - last > PHRASE_GAP) raw.push((cur = []));
    cur.push({ t: p.t, m: p.m });
    last = p.t;
  }
  const out = [];
  for (const ph of raw) {
    if (ph.length < 6 || ph[ph.length - 1].t - ph[0].t < 0.2) continue;
    const kept = ph.filter((p, i) => {
      const win = ph.slice(Math.max(0, i - 3), i + 4).map((q) => q.m);
      return Math.abs(p.m - median(win)) <= 4; // octave jumps / glitches
    });
    if (kept.length < 6) continue;
    out.push(kept.map((p, i) => (i === 0 || i === kept.length - 1 ? p : { t: p.t, m: median([kept[i - 1].m, p.m, kept[i + 1].m]) })));
  }
  return out;
}

function movingAvg(ph, half) {
  const ma = new Array(ph.length);
  let lo = 0;
  let hi = -1;
  let sum = 0;
  for (let i = 0; i < ph.length; i++) {
    while (hi + 1 < ph.length && ph[hi + 1].t <= ph[i].t + half) sum += ph[++hi].m;
    while (ph[lo].t < ph[i].t - half) sum -= ph[lo++].m;
    ma[i] = sum / (hi - lo + 1);
  }
  return ma;
}

/** Held notes: stretches where the averaged pitch barely moves (vibrato averages out). */
function heldRuns(ph) {
  const ma = movingAvg(ph, 0.13);
  const n = ph.length;
  const flags = new Array(n);
  let a = 0;
  let b = 0;
  for (let i = 0; i < n; i++) {
    while (a < i && ph[a].t < ph[i].t - 0.06) a++;
    while (b < n - 1 && ph[b].t < ph[i].t + 0.06) b++;
    flags[i] = Math.abs(ma[b] - ma[a]) < 0.35;
  }
  const runs = [];
  let s = -1;
  for (let i = 0; i <= n; i++) {
    if (i < n && flags[i]) {
      if (s < 0) s = i;
    } else if (s >= 0) {
      const e = i - 1;
      const run = { s, e, start: ph[s].t, end: ph[e].t, med: median(ph.slice(s, e + 1).map((p) => p.m)) };
      const prev = runs[runs.length - 1];
      if (prev && Math.abs(prev.med - run.med) < 0.5 && run.start - prev.end < 0.08) {
        prev.e = e;
        prev.end = run.end;
        prev.med = median(ph.slice(prev.s, e + 1).map((p) => p.m));
      } else {
        runs.push(run);
      }
      s = -1;
    }
  }
  // The moving average smears note edges; snap each run back to where the raw pitch
  // actually sits on the note, so a clean step isn't mistaken for a slide.
  for (let k = 0; k < runs.length; k++) {
    const r = runs[k];
    const floor = k > 0 ? runs[k - 1].e + 1 : 0;
    const ceil = k < runs.length - 1 ? runs[k + 1].s - 1 : n - 1;
    while (r.s > floor && Math.abs(ph[r.s - 1].m - r.med) < 0.45) r.s--;
    while (r.e < ceil && Math.abs(ph[r.e + 1].m - r.med) < 0.45) r.e++;
    r.start = ph[r.s].t;
    r.end = ph[r.e].t;
  }
  return runs.filter((r) => r.end - r.start >= 0.1).map((r) => ({ ...r, dur: r.end - r.start }));
}

/** Zig-zag swing points (indices) with hysteresis `th` semitones. */
function swings(ph, th) {
  const out = [0];
  let dir = 0;
  let cand = 0;
  for (let i = 1; i < ph.length; i++) {
    const m = ph[i].m;
    if (dir === 0) {
      if (m - ph[0].m >= th) [dir, cand] = [1, i];
      else if (ph[0].m - m >= th) [dir, cand] = [-1, i];
    } else if (dir === 1) {
      if (m > ph[cand].m) cand = i;
      else if (ph[cand].m - m >= th) {
        out.push(cand);
        [dir, cand] = [-1, i];
      }
    } else if (m < ph[cand].m) cand = i;
    else if (m - ph[cand].m >= th) {
      out.push(cand);
      [dir, cand] = [1, i];
    }
  }
  if (dir !== 0) out.push(cand);
  return out;
}

/**
 * @param {Array<{t:number, m:number|null}>} points  pitch track (MIDI, null = silence), sorted by t
 * @returns {object|null} style metrics, or null if there is too little singing to judge
 */
export function analyzeStyle(points) {
  const phrases = phrasesOf(points);
  const voicedSec = phrases.reduce((s, ph) => s + (ph[ph.length - 1].t - ph[0].t), 0);
  if (voicedSec < 2) return null;

  const all = [];
  const longs = [];
  const turnDurs = [];
  const glideSizes = [];
  const glideDurs = [];
  let notes = 0;
  let turns = 0;
  let transitions = 0;
  let glides = 0;
  let scoops = 0;
  let scoopChecks = 0;

  for (const ph of phrases) {
    for (const p of ph) all.push(p.m);
    const runs = heldRuns(ph);
    notes += runs.length;
    const insideHeld = (i) => runs.some((r) => r.dur >= 0.35 && i >= r.s && i <= r.e);

    // Vibrato on long notes.
    for (const r of runs) {
      if (r.dur < 0.8) continue;
      const v = measureVibrato(ph.slice(r.s, r.e + 1).map((p) => ({ t: p.t, cents: p.m * 100 })));
      longs.push(v);
    }

    // Ornament turns: a quick there-and-back excursion of ≥ TURN_SEMIS — the voice flicks
    // away from a pitch and returns to (about) the same pitch within a quarter second.
    const z = swings(ph, TURN_SEMIS);
    for (let k = 1; k < z.length; k++) {
      const i1 = z[k];
      if (insideHeld(i1)) continue;
      const peak = ph[i1].m;
      const away = (i) => Math.abs(ph[i].m - peak) >= TURN_SEMIS;
      let a = i1;
      while (a > 0 && !away(a)) a--;
      let b = i1;
      while (b < ph.length - 1 && !away(b)) b++;
      if (!away(a) || !away(b)) continue;
      const sameSide = Math.sign(ph[a].m - peak) === Math.sign(ph[b].m - peak);
      const width = ph[b].t - ph[a].t;
      if (sameSide && width <= 0.3 && Math.abs(ph[b].m - ph[a].m) <= 0.7) {
        turns++;
        turnDurs.push(width);
      }
    }

    // Slides (meend) vs. clean steps between held notes; scoops into notes.
    for (let k = 0; k < runs.length; k++) {
      const r = runs[k];
      const prev = runs[k - 1];
      if (prev) {
        const interval = Math.abs(r.med - prev.med);
        const gap = r.start - prev.end;
        if (interval >= 1.5 && gap <= 0.9) {
          transitions++;
          const seg = ph.slice(prev.e, r.s + 1);
          let maxGap = 0;
          for (let i = 1; i < seg.length; i++) maxGap = Math.max(maxGap, seg[i].t - seg[i - 1].t);
          const lo = Math.min(prev.med, r.med);
          const hi = Math.max(prev.med, r.med);
          const monotone = seg.every((p) => p.m >= lo - 0.8 && p.m <= hi + 0.8);
          // A slide spends real time on the pitches in between; a step jumps across them.
          const dt = seg.length > 1 ? (seg[seg.length - 1].t - seg[0].t) / (seg.length - 1) : 0;
          const between = seg.filter((p) => p.m > lo + 0.25 * interval && p.m < hi - 0.25 * interval).length * dt;
          if (gap >= 0.12 && maxGap <= 0.06 && monotone && between >= 0.08) {
            glides++;
            glideSizes.push(interval);
            glideDurs.push(gap);
          }
        }
      }
      if (r.dur >= 0.15) {
        const lead = ph.filter((p) => p.t >= r.start - 0.2 && p.t < r.start);
        if (lead.length >= 3) {
          scoopChecks++;
          const minM = Math.min(...lead.map((p) => p.m));
          const fromNote = prev && r.start - prev.end < 0.2 && r.med - prev.med >= 0.6;
          if (!fromNote && r.med - minM >= 0.6 && lead[lead.length - 1].m - lead[0].m >= 0.4) scoops++;
        }
      }
    }
  }

  const med = median(all);
  const vib = longs.filter(isVibrato);
  const phraseLens = phrases.map((ph) => ph[ph.length - 1].t - ph[0].t).filter((d) => d >= 0.3);
  // In a full mix the backing fills the singer's breaths, so "phrases" run on for many
  // seconds. Nobody averages 8 s+ per breath in a song — if we see that, the breaths were
  // hidden and phrasing can't be measured: say so (null) instead of inventing a number.
  const avgPhrase = mean(phraseLens);
  const breathVisible = phraseLens.length >= 2 && avgPhrase <= 8;
  return {
    voicedSec: r1(voicedSec),
    phraseLen: breathVisible ? r2(avgPhrase) : null,
    range: { lo: r1(percentile(all, 5)), hi: r1(percentile(all, 95)), med: r1(med) },
    vibratoShare: longs.length ? r2(vib.length / longs.length) : 0,
    vibratoRate: vib.length ? r1(median(vib.map((v) => v.rate))) : 0,
    vibratoDepth: vib.length ? Math.round(median(vib.map((v) => v.depth))) : 0,
    ornamentRate: r2(turns / voicedSec),
    turnDur: turnDurs.length ? Math.round(median(turnDurs) * 1000) / 1000 : 0,
    glideShare: transitions ? r2(glides / transitions) : 0,
    glideInterval: glideSizes.length ? r1(median(glideSizes)) : 0,
    glideDur: glideDurs.length ? r2(median(glideDurs)) : 0,
    scoopShare: scoopChecks ? r2(scoops / scoopChecks) : 0,
    noteRate: r2(notes / voicedSec),
    topShare: r2(all.filter((m) => m >= med + 7).length / all.length),
    counts: { longNotes: longs.length, vibratoNotes: vib.length, transitions, scoopChecks, notes, turns },
  };
}

/** Pitch track points from a melody contour (Float32Array of MIDI, NaN = unvoiced). */
export function contourPoints(contour, hopSec, offsetSec = 0) {
  const pts = new Array(contour.length);
  for (let i = 0; i < contour.length; i++) pts[i] = { t: offsetSec + i * hopSec, m: Number.isNaN(contour[i]) ? null : contour[i] };
  return pts;
}

/** Combine per-song styles into one singer profile (each metric weighted by its evidence). */
export function aggregateStyles(styles) {
  const list = styles.filter(Boolean);
  if (!list.length) return null;
  const wmean = (key, weight) => {
    let s = 0;
    let w = 0;
    for (const x of list) {
      const wt = weight(x);
      s += x[key] * wt;
      w += wt;
    }
    return w ? s / w : 0;
  };
  const byTime = (x) => x.voicedSec;
  const sum = (k) => list.reduce((s, x) => s + (x.counts?.[k] || 0), 0);
  const withBreath = list.filter((x) => x.phraseLen != null);
  const breathSec = withBreath.reduce((s, x) => s + x.voicedSec, 0);
  return {
    songs: list.length,
    voicedSec: r1(list.reduce((s, x) => s + x.voicedSec, 0)),
    phraseLen: withBreath.length ? r2(withBreath.reduce((s, x) => s + x.phraseLen * x.voicedSec, 0) / breathSec) : null,
    range: { lo: r1(median(list.map((x) => x.range.lo))), hi: r1(median(list.map((x) => x.range.hi))), med: r1(median(list.map((x) => x.range.med))) },
    vibratoShare: r2(wmean('vibratoShare', (x) => x.counts.longNotes)),
    vibratoRate: r1(wmean('vibratoRate', (x) => x.counts.vibratoNotes)),
    vibratoDepth: Math.round(wmean('vibratoDepth', (x) => x.counts.vibratoNotes)),
    ornamentRate: r2(wmean('ornamentRate', byTime)),
    turnDur: Math.round(wmean('turnDur', (x) => x.counts.turns) * 1000) / 1000,
    glideShare: r2(wmean('glideShare', (x) => x.counts.transitions)),
    glideInterval: r1(wmean('glideInterval', (x) => x.counts.transitions * x.glideShare)),
    glideDur: r2(wmean('glideDur', (x) => x.counts.transitions * x.glideShare)),
    scoopShare: r2(wmean('scoopShare', (x) => x.counts.scoopChecks)),
    noteRate: r2(wmean('noteRate', byTime)),
    topShare: r2(wmean('topShare', byTime)),
    counts: { longNotes: sum('longNotes'), vibratoNotes: sum('vibratoNotes'), transitions: sum('transitions'), scoopChecks: sum('scoopChecks'), notes: sum('notes'), turns: sum('turns') },
  };
}

const pct = (x) => `${Math.round(x * 100)}%`;

/** The style traits shown on a singer's card, strongest first. */
export function signature(p) {
  const traits = [
    { key: 'ornaments', on: p.ornamentRate >= 0.35, strength: p.ornamentRate / 0.8, icon: '🌀', text: `Ornaments — ${p.ornamentRate.toFixed(1)} quick turns per second (murkis / riffs)` },
    { key: 'vibrato', on: p.vibratoShare >= 0.3, strength: p.vibratoShare / 0.6, icon: '🌊', text: `Vibrato on ${pct(p.vibratoShare)} of long notes${p.vibratoRate ? ` at ~${p.vibratoRate} Hz` : ''}` },
    { key: 'meend', on: p.glideShare >= 0.3, strength: p.glideShare / 0.6, icon: '〰️', text: `Slides between notes (meend) on ${pct(p.glideShare)} of jumps` },
    { key: 'scoop', on: p.scoopShare >= 0.25, strength: p.scoopShare / 0.5, icon: '↗️', text: `Eases up into ${pct(p.scoopShare)} of notes from below` },
    { key: 'high', on: p.topShare >= 0.08, strength: p.topShare / 0.2, icon: '🕊️', text: `Uses the high range (head voice / falsetto) ${pct(p.topShare)} of the time` },
    { key: 'agile', on: p.noteRate >= 3, strength: p.noteRate / 5, icon: '⚡', text: `Agile — ${p.noteRate.toFixed(1)} notes per second` },
    { key: 'breath', on: p.phraseLen != null && p.phraseLen >= 3, strength: (p.phraseLen ?? 0) / 5, icon: '🌬️', text: `Long lines — ${(p.phraseLen ?? 0).toFixed(1)} s per breath` },
  ];
  return traits.filter((t) => t.on).sort((a, b) => b.strength - a.strength);
}

const METRICS = [
  { key: 'vibratoShare', scale: 0.6, label: 'Vibrato use', fmt: pct },
  { key: 'ornamentRate', scale: 0.8, label: 'Ornaments', fmt: (v) => `${v.toFixed(1)}/s` },
  { key: 'glideShare', scale: 0.5, label: 'Slides (meend)', fmt: pct },
  { key: 'scoopShare', scale: 0.4, label: 'Scoops', fmt: pct },
  { key: 'phraseLen', scale: 3, label: 'Breath per phrase', fmt: (v) => `${v.toFixed(1)} s` },
  { key: 'noteRate', scale: 3, label: 'Note speed', fmt: (v) => `${v.toFixed(1)}/s` },
  { key: 'topShare', scale: 0.25, label: 'High range', fmt: pct },
];

function tipFor(key, u, p, singer) {
  const more = u[key] > p[key];
  switch (key) {
    case 'vibratoShare':
      return more
        ? { text: `You put vibrato on ${pct(u[key])} of long notes; ${singer} keeps most notes straighter (${pct(p[key])}) and saves it for phrase endings. Start each long note straight, add the pulse only at the end.`, drill: 'vibrato' }
        : { text: `${singer} lets ${pct(p[key])} of long notes bloom into vibrato${p.vibratoRate ? ` (~${p.vibratoRate} pulses a second)` : ''}; yours stayed mostly straight (${pct(u[key])}). Hold the note steady, then relax the second half into a gentle pulse.`, drill: 'vibrato' };
    case 'ornamentRate':
      return more
        ? { text: `You decorate more than ${singer} (${u[key].toFixed(1)} vs ${p[key].toFixed(1)} turns a second). Their line is cleaner — sing the plain melody and keep ornaments for key words.`, drill: null }
        : { text: `${singer} decorates lines with quick turns — about ${p[key].toFixed(1)} a second (murkis / riffs). You sang the notes plainly. The Murki drill trains those light, quick turns.`, drill: 'murki' };
    case 'glideShare':
      return more
        ? { text: `You slide into ${pct(u[key])} of big jumps; ${singer} lands most of them directly (${pct(p[key])}). Aim straight for the target note.`, drill: null }
        : { text: `${singer} slides through the notes in between (meend) on ${pct(p[key])} of jumps; you stepped (${pct(u[key])}). Practise the Meend drill — glide, don't jump.`, drill: 'meend' };
    case 'scoopShare':
      return more
        ? { text: `You scoop up into ${pct(u[key])} of notes; ${singer} hits them cleanly (${pct(p[key])}). Hear the note first, then start right on it.`, drill: null }
        : { text: `${singer} eases up into ${pct(p[key])} of notes from just below — a soft, expressive entry. Try starting a touch under the note and gliding up, lightly.`, drill: 'meend' };
    case 'phraseLen':
      return more
        ? null
        : { text: `${singer} sings about ${p[key].toFixed(1)} s on one breath; your phrases average ${u[key].toFixed(1)} s. Breathe low into the belly before each line, and build stamina with the breath drill.`, drill: 'breath' };
    case 'noteRate':
      return more ? null : { text: `${singer} moves faster — ${p[key].toFixed(1)} notes a second against your ${u[key].toFixed(1)}. The Runs drill builds quick, light note changes.`, drill: 'runs' };
    case 'topShare':
      return more
        ? null
        : { text: `${singer} spends ${pct(p[key])} of the time up in their high range (head voice / falsetto); you stayed low (${pct(u[key])}). The Falsetto-flip drill makes the top light and easy.`, drill: 'flip' };
    default:
      return null;
  }
}

/** Compare a singer's take with a learned profile: a match score, teacher tips and wins. */
export function compareStyle(user, profile, singer = 'this singer') {
  if (!user || !profile) return null;
  // Skip anything that couldn't be measured on either side (e.g. breaths inside a full mix).
  const rows = METRICS.filter((m) => user[m.key] != null && profile[m.key] != null).map((m) => {
    const diff = Math.abs(user[m.key] - profile[m.key]);
    return { ...m, you: user[m.key], them: profile[m.key], nd: clamp(diff / m.scale, 0, 1) };
  });
  const match = Math.round(100 * (1 - mean(rows.map((r) => r.nd))));
  const tips = rows
    .filter((r) => r.nd >= 0.25)
    .sort((a, b) => b.nd - a.nd)
    .map((r) => tipFor(r.key, user, profile, singer))
    .filter(Boolean)
    .slice(0, 3);
  const wins = rows.filter((r) => r.nd < 0.15).map((r) => `Your ${r.label.toLowerCase()} is right in ${singer}'s style.`);
  return { match, tips, wins, rows: rows.map(({ key, label, you, them, fmt }) => ({ key, label, you: fmt(you), them: fmt(them) })) };
}

/** Semitones to move a singer's songs so their usual pitch sits in your voice. */
export function keyAdvice(profile, range, singer) {
  const shift = Math.round((range.low + range.high) / 2 - profile.range.med);
  if (Math.abs(shift) <= 1) return `${singer} sings around ${noteName(profile.range.med)} — right in your range. Sing their songs in the original key.`;
  const oct = Math.abs(shift) >= 9 ? ' (about an octave — normal between male and female voices)' : '';
  return `${singer} sings around ${noteName(profile.range.med)}. For your voice, sing their songs ${Math.abs(shift)} semitones ${shift < 0 ? 'lower' : 'higher'}${oct} — use “My key”.`;
}

// ----------------------------------------------------------------------------- drills

function put(list, notes, t, role) {
  for (const n of notes) {
    list.push({ midi: n.m, glideTo: n.to ?? null, start: t, dur: n.d * 0.94, role });
    t += n.d;
  }
  return t;
}

function listenRepeat(list, notes, t, gap = 0.5, rest = 1.4) {
  t = put(list, notes, t, 'listen');
  t = put(list, notes, t + gap, 'sing');
  return t + rest;
}

/**
 * Exercises built from what makes this singer distinctive, pitched for the user's range.
 * Each returns { id, icon, title, subtitle, focus, tolerance, bpm, guideOnSing, targets, why }.
 */
export function styleDrills(p, range, singer) {
  const lo = range.low;
  const hi = range.high;
  const span = hi - lo;
  const mid = Math.round(lo + span * 0.4);
  const drills = [];

  // Murki: a held note decorated with a quick turn above and below.
  {
    const d = clamp(p.turnDur || 0.14, 0.09, 0.22);
    const targets = [];
    let t = 0;
    for (const root of [mid - 2, mid, mid + 2].filter((m) => m - 1 >= lo && m + 2 <= hi)) {
      t = listenRepeat(targets, [{ m: root, d: 0.7 }, { m: root + 2, d }, { m: root, d }, { m: root - 1, d }, { m: root, d: 1.3 }], t);
    }
    drills.push({ id: 'murki', icon: '🌀', title: 'Murki drill', subtitle: `Quick turns at ${singer}'s speed (${Math.round(d * 1000)} ms a note)`, focus: 'agility', tolerance: 50, bpm: 80, guideOnSing: false, targets, why: 'ornaments' });
  }

  // Meend: slide through every pitch between two notes.
  {
    const size = clamp(Math.round(p.glideInterval || 4), 2, Math.min(7, span - 2));
    const g = clamp((p.glideDur || 0.3) * 2.2, 0.55, 1.4);
    const targets = [];
    let t = 0;
    for (const root of [mid - 2, mid + 1].filter((m) => m >= lo && m + size <= hi)) {
      t = listenRepeat(targets, [{ m: root, d: 0.8 }, { m: root, to: root + size, d: g }, { m: root + size, d: 1 }, { m: root + size, to: root, d: g }, { m: root, d: 0.9 }], t, 0.6, 1.5);
    }
    drills.push({ id: 'meend', icon: '〰️', title: 'Meend (slide) drill', subtitle: `Glides of ${size} semitones, like ${singer}`, focus: 'pitch', tolerance: 50, bpm: 70, guideOnSing: false, targets, why: 'meend' });
  }

  // Vibrato: long notes; relax into the singer's pulse.
  {
    const targets = [];
    let t = 0;
    for (const m of [mid - 2, mid, mid + 2].filter((x) => x >= lo && x <= hi)) t = listenRepeat(targets, [{ m, d: 4 }], t, 0.5, 1.6);
    drills.push({ id: 'vibrato', icon: '🌊', title: 'Vibrato drill', subtitle: p.vibratoRate ? `Let long notes pulse ~${p.vibratoRate} times a second` : 'Let long notes relax into a pulse', focus: 'vibrato', tolerance: 45, bpm: 70, guideOnSing: false, targets, why: 'vibrato' });
  }

  // Falsetto flip: chest note, light flip up, back down.
  {
    const jump = span >= 14 ? 12 : Math.max(5, span - 3);
    const base = clamp(hi - jump - 1, lo, hi - jump);
    const targets = [];
    let t = 0;
    for (const b of [base - 1, base].filter((x) => x >= lo)) {
      t = listenRepeat(targets, [{ m: b, d: 0.9 }, { m: b, to: b + jump, d: 0.5 }, { m: b + jump, d: 1.3 }, { m: b + jump, to: b, d: 0.7 }, { m: b, d: 0.8 }], t, 0.6, 1.6);
    }
    drills.push({ id: 'flip', icon: '🕊️', title: 'Falsetto-flip drill', subtitle: 'Chest note → light flip up → back, without a crack', focus: 'pitch', tolerance: 50, bpm: 70, guideOnSing: false, targets, why: 'high' });
  }

  // Runs: descending minor-pentatonic runs at the singer's note speed.
  {
    const offs = span >= 13 ? [12, 10, 7, 5, 3, 0] : [7, 5, 3, 0];
    const d = clamp(1 / Math.max(2, p.noteRate || 3), 0.13, 0.32);
    const top = offs[0];
    const targets = [];
    let t = 0;
    for (const root of [lo + 1, lo + 3, lo + 2].filter((r) => r + top <= hi)) {
      t = listenRepeat(targets, offs.map((o, i) => ({ m: root + o, d: i === offs.length - 1 ? 1.2 : d })), t, 0.6, 1.5);
    }
    drills.push({ id: 'runs', icon: '⚡', title: 'Runs drill', subtitle: `Riffs at ${singer}'s speed (${Math.round(d * 1000)} ms a note)`, focus: 'agility', tolerance: 50, bpm: 90, guideOnSing: false, targets, why: 'agile' });
  }

  // Breath: phrase-length holds.
  {
    const hold = clamp(Math.round((p.phraseLen || 3) + 1.5), 4, 10);
    const targets = [];
    let t = 0;
    for (const m of [mid, mid + 2].filter((x) => x <= hi)) t = listenRepeat(targets, [{ m, d: hold }], t, 0.5, 2);
    const why = p.phraseLen != null ? `longer than ${singer}'s average line` : 'build the breath long phrases need';
    drills.push({ id: 'breath', icon: '🌬️', title: 'Breath drill', subtitle: `Hold ${hold} s — ${why}`, focus: 'stability', tolerance: 50, bpm: 70, guideOnSing: false, targets, why: 'breath' });
  }

  // Most characteristic first.
  const order = signature(p).map((s) => s.key);
  const rank = (d) => {
    const i = order.indexOf(d.why);
    return i < 0 ? 99 : i;
  };
  return drills.sort((a, b) => rank(a) - rank(b));
}
