// Riyaaz — daily practice the Hindustani way: a tanpura on your own Sa, sargam, kharaj,
// alankars, meend, taans — and safe, gradual work on the chest/head "break" so the voice
// opens up (awaaz khulna) instead of being forced. Pure: no DOM, no storage.
import { swaraName } from '../audio/sargam.js';
import { clamp } from '../audio/notes.js';

// Bilawal (major) scale degrees relative to Sa, two octaves each way.
const SCALE = [0, 2, 4, 5, 7, 9, 11];
const deg = (i) => SCALE[((i % 7) + 7) % 7] + 12 * Math.floor(i / 7);

/** A comfortable Sa from a measured range: room for mandra Pa below and taar Sa–Pa above. */
export function suggestSa(voice) {
  if (!voice) return null;
  return clamp(Math.round((voice.low + voice.high) / 2 - 8), voice.low + 3, voice.low + 7);
}

const BREAK_BY_TYPE = { Bass: 61, Baritone: 63, Tenor: 65, Alto: 64, 'Mezzo-soprano': 65, Soprano: 66 };

/** Where the chest → head-voice "break" (passaggio) usually sits for this voice. */
export function breakCenter(voice) {
  const c = BREAK_BY_TYPE[voice?.type] ?? 64;
  if (!voice) return c;
  return clamp(c, voice.low + 5, voice.high - 3);
}

// ---------------------------------------------------------------- target builders

function put(list, notes, t, role, sa) {
  for (const n of notes) {
    list.push({ midi: n.m, glideTo: n.to ?? null, start: t, dur: n.d * 0.94, role, lyric: swaraName(n.m, sa) });
    t += n.d;
  }
  return t;
}

/** Hear it, then sing it back. */
function echo(list, notes, t, sa, gap = 0.5, rest = 1.3) {
  t = put(list, notes, t, 'listen', sa);
  t = put(list, notes, t + gap, 'sing', sa);
  return t + rest;
}

/** Sing along with the guide. */
function along(list, notes, t, sa, rest = 1.2) {
  return put(list, notes, t, 'sing', sa) + rest;
}

const fitsIn = (c) => (m) => m >= c.low - 1 && m <= c.high + 1;

/** Ascending/descending groups of scale degrees (alankars), trimmed to the voice. */
function alankar(c, group, beat) {
  const ok = fitsIn(c);
  const notes = [];
  for (let i = 0; i + Math.max(...group) <= 7; i++) {
    const ms = group.map((g) => c.sa + deg(i + g));
    if (!ms.every(ok)) break;
    ms.forEach((m) => notes.push({ m, d: beat }));
  }
  for (let i = 7; i - Math.max(...group) >= 0; i--) {
    const ms = group.map((g) => c.sa + deg(i - g));
    if (!ms.every(ok)) continue;
    ms.forEach((m) => notes.push({ m, d: beat }));
  }
  notes.push({ m: c.sa, d: beat * 2 });
  return notes;
}

const HOLD_BY_STAGE = [5, 6, 8, 10, 12];
const BPM_BY_STAGE = [60, 68, 76, 84, 96];

export const EXERCISES = [
  {
    id: 'omkar',
    icon: '🕉️',
    title: 'Omkar',
    hindi: 'ओंकार',
    subtitle: 'Long “Om” on Sa — breath, calm and a steady sur',
    stage: 1,
    focus: 'stability',
    build(c) {
      const hold = HOLD_BY_STAGE[c.stage - 1];
      const out = [];
      let t = 0;
      for (let i = 0; i < 3; i++) t = echo(out, [{ m: c.sa, d: hold }], t, c.sa, 0.6, 2.2);
      return out;
    },
    teach: [
      'Sit straight, shoulders loose. Breathe in slowly through the nose — the belly should expand, not the chest.',
      'Sing “Ooo…” and close slowly into “mmm” on Sa, matching the tanpura. Feel the hum buzz in your lips and face.',
      'Keep it soft and even to the very end of the breath. Omkar settles the voice and trains the dum (breath).',
    ],
  },
  {
    id: 'sa-pa-sa',
    icon: '🎯',
    title: 'Sa–Pa–Sa sadhana',
    hindi: 'सा प सां',
    subtitle: 'Lock onto the three pillars of every raga',
    stage: 1,
    focus: 'stability',
    build(c) {
      const ok = fitsIn(c);
      const seq = [c.sa, c.sa + 7, c.sa + 12, c.sa + 7, c.sa].filter(ok);
      const out = [];
      let t = 0;
      for (const m of seq) t = echo(out, [{ m, d: 3.5 }], t, c.sa, 0.5, 1.2);
      return out;
    },
    teach: [
      'Sa and Pa never change in any raga — if these two are perfectly in sur, everything else follows.',
      'Sing on an open “aa” (aakar). Listen to the tanpura and let your note “melt” into it — no beating, no wobble.',
      'Taar Sa (Ṡa) is the octave: same note, higher. Reach it lightly, never by pushing.',
    ],
  },
  {
    id: 'swar',
    icon: '👂',
    title: 'Swar pehchaan',
    hindi: 'स्वर पहचान',
    subtitle: 'Hear a swara, sing it back — ear training',
    stage: 1,
    focus: 'pitch',
    build(c) {
      const ok = fitsIn(c);
      const pool = [2, 4, 5, 7, 9, 11, 12, -1, -3].map((o) => c.sa + o).filter(ok);
      let seed = c.seed ?? 7;
      const rand = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
      const out = [];
      let t = 0;
      for (let i = 0; i < 6; i++) {
        const m = pool[Math.floor(rand() * pool.length)];
        t = echo(out, [{ m: c.sa, d: 0.8 }, { m, d: 1.4 }], t, c.sa, 0.4, 1);
      }
      return out;
    },
    teach: [
      'You hear Sa, then a mystery swara. Sing both back.',
      'Before singing, “hear” the note in your head. Humming it quietly first is allowed.',
      'This is how the ear and voice learn to work together — the root of a sureela (melodious) voice.',
    ],
  },
  {
    id: 'aaroh',
    icon: '🪜',
    title: 'Aaroh – Avroh',
    hindi: 'आरोह अवरोह',
    subtitle: 'Sa Re Ga Ma Pa Dha Ni Sa — up and down with the guide',
    stage: 1,
    focus: 'pitch',
    mode: 'along',
    build(c) {
      const ok = fitsIn(c);
      const beat = 60 / BPM_BY_STAGE[c.stage - 1];
      const up = [];
      for (let i = 0; i <= 7 && ok(c.sa + deg(i)); i++) up.push(c.sa + deg(i));
      const seq = [...up, ...up.slice(0, -1).reverse()];
      const out = [];
      let t = 0;
      for (let r = 0; r < 2; r++) t = along(out, seq.map((m, i) => ({ m, d: i === seq.length - 1 ? beat * 2 : beat })), t, c.sa, 1.4);
      return out;
    },
    teach: [
      'Aaroh = going up, avroh = coming down. Each swara should land exactly — no sliding between them.',
      'Coming down, singers drift flat. Think “up” even as you descend.',
      'One breath up, one breath down. Speed grows as you advance through the stages.',
    ],
  },
  {
    id: 'dum',
    icon: '🌬️',
    title: 'Dum test',
    hindi: 'दम',
    subtitle: 'Hold Sa as long as you can — measures your breath',
    stage: 1,
    focus: 'stability',
    build(c) {
      const out = [];
      echo(out, [{ m: c.sa, d: 30 }], 0, c.sa, 0.6, 0);
      return out;
    },
    teach: [
      'One deep belly breath, then hold Sa softly and steadily for as long as it stays in sur.',
      'Don’t squeeze out the last drops — stop when the tone wobbles. Quality over length.',
      'Great singers hold 15–20 seconds. Your record is tracked on the golden-voice meter.',
    ],
  },
  {
    id: 'kharaj',
    icon: '🪨',
    title: 'Kharaj ka riyaaz',
    hindi: 'खरज',
    subtitle: 'Long, gentle notes in the lower octave — depth and body',
    stage: 2,
    focus: 'stability',
    build(c) {
      const offs = c.stage >= 4 ? [0, -1, -3, -5, -7, -5, -3, -1, 0] : [0, -1, -3, -5, -3, -1, 0];
      const seq = offs.map((o) => c.sa + o).filter((m) => m >= c.low - 1);
      const hold = c.stage >= 3 ? 4.5 : 3.5;
      const out = [];
      let t = 0;
      for (const m of seq) t = echo(out, [{ m, d: hold }], t, c.sa, 0.5, 1.2);
      return out;
    },
    teach: [
      'Kharaj (mandra saptak) riyaaz gives the voice weight, warmth and stability — a classic early-morning practice.',
      'Low notes need relaxation, not pressure: loose jaw, open throat, soft volume. Never growl or push down.',
      'Only go as low as stays clear. Your lower range grows naturally over weeks.',
    ],
  },
  {
    id: 'alankar-1',
    icon: '🔁',
    title: 'Alankar: SRG · RGM · GMP',
    hindi: 'अलंकार १',
    subtitle: 'Three-note groups up and down the saptak',
    stage: 2,
    focus: 'pitch',
    mode: 'along',
    build(c) {
      const out = [];
      along(out, alankar(c, [0, 1, 2], 60 / (BPM_BY_STAGE[c.stage - 1] + 8)), 0, c.sa);
      return out;
    },
    teach: [
      'Alankars (paltas) are patterns that train exact swaras and control.',
      'Sa Re Ga, Re Ga Ma, Ga Ma Pa … then down: Ṡa Ni Dha, Ni Dha Pa …',
      'Land each note cleanly — no scooping up into it.',
    ],
  },
  {
    id: 'meend',
    icon: '〰️',
    title: 'Meend',
    hindi: 'मींड',
    subtitle: 'Glide smoothly between swaras — the soul of Indian singing',
    stage: 2,
    focus: 'pitch',
    build(c) {
      const ok = fitsIn(c);
      const glides = [
        [c.sa, c.sa + 7, 1.6],
        [c.sa + 4, c.sa + 7, 1.2],
        [c.sa, c.sa + 12, 2],
      ].filter(([a, b]) => ok(a) && ok(b));
      const out = [];
      let t = 0;
      for (const [a, b, g] of glides) {
        t = echo(out, [{ m: a, d: 0.9 }, { m: a, to: b, d: g }, { m: b, d: 1 }, { m: b, to: a, d: g }, { m: a, d: 0.9 }], t, c.sa, 0.6, 1.4);
      }
      return out;
    },
    teach: [
      'A meend touches every pitch between two swaras — like a finger sliding along a sitar string.',
      'Keep the breath flowing and the volume even through the slide; don’t let it thin out at the top.',
      'This same skill smooths the jump between chest and head voice.',
    ],
  },
  {
    id: 'alankar-2',
    icon: '👣',
    title: 'Alankar: SR · RG · GM',
    hindi: 'अलंकार २',
    subtitle: 'Paired steps — faster, cleaner',
    stage: 3,
    focus: 'pitch',
    mode: 'along',
    build(c) {
      const out = [];
      along(out, alankar(c, [0, 1], 60 / (BPM_BY_STAGE[c.stage - 1] + 16)), 0, c.sa);
      return out;
    },
    teach: ['Sa Re, Re Ga, Ga Ma … each pair crisp and even.', 'Keep a light, bright tone — heavy voices can’t move quickly.', 'Breathe at the top (Ṡa) if you need to.'],
  },
  {
    id: 'alankar-3',
    icon: '🦘',
    title: 'Alankar: SG · RM · GP',
    hindi: 'अलंकार ३',
    subtitle: 'Skipping swaras — hear the jump first',
    stage: 3,
    focus: 'pitch',
    mode: 'along',
    build(c) {
      const out = [];
      along(out, alankar(c, [0, 2], 60 / (BPM_BY_STAGE[c.stage - 1] + 8)), 0, c.sa);
      return out;
    },
    teach: ['Sa Ga, Re Ma, Ga Pa … the skip must land exactly — pre-hear the target.', 'Most film melodies move like this. Master it and songs get easier.', 'Coming down: Ṡa Dha, Ni Pa, Dha Ma …'],
  },
  {
    id: 'bridge',
    icon: '🌉',
    title: 'Awaaz kholna — bridging the break',
    hindi: 'आवाज़ खोलना',
    subtitle: 'Cross the chest ↔ head “break” lightly until it disappears',
    stage: 3,
    focus: 'pitch',
    build(c) {
      // Snap the break to the nearest swara of the scale and work around it by scale steps.
      const center = c.breakAt ?? c.sa + 12;
      let ci = 0;
      for (let i = -14; i <= 21; i++) if (Math.abs(c.sa + deg(i) - center) < Math.abs(c.sa + deg(ci) - center)) ci = i;
      const at = (i) => c.sa + deg(i);
      const out = [];
      let t = 0;
      for (let r = 0; r < 2; r++) {
        t = echo(out, [{ m: at(ci - 3), d: 0.8 }, { m: at(ci - 3), to: at(ci + 2), d: 2 }, { m: at(ci + 2), d: 1 }, { m: at(ci + 2), to: at(ci - 3), d: 2 }, { m: at(ci - 3), d: 0.8 }], t, c.sa, 0.6, 1.4);
      }
      const beat = 60 / 72;
      for (const shift of [-1, 0]) {
        const pat = [-2, -1, 0, 1, 2, 1, 0, -1, -2].map((o) => at(ci + shift + o));
        t = along(out, pat.map((m, i) => ({ m, d: i === pat.length - 1 ? beat * 2 : beat })), t, c.sa, 1.4);
      }
      return out.filter((n) => n.midi >= c.low - 1 && (n.glideTo ?? n.midi) <= c.high + 1);
    },
    teach: [
      'The “break” (awaaz tootna) is where your voice flips from chest to head voice. Everyone has one.',
      'You do NOT fix it by shouting or forcing — that is how voices get damaged. You fix it by crossing it lightly, many times, until the two registers blend. That is how a voice “opens up”.',
      'Sing on “oo” or a lip trill, at half volume. Let the voice get lighter as it rises — never heavier.',
    ],
  },
  {
    id: 'taan',
    icon: '⚡',
    title: 'Taan',
    hindi: 'तान',
    subtitle: 'Fast runs through the saptak — agility',
    stage: 4,
    focus: 'agility',
    mode: 'along',
    build(c) {
      const ok = fitsIn(c);
      const beat = 60 / (c.stage >= 5 ? 120 : 104) / 2;
      const out = [];
      let t = 0;
      const runs = [
        [0, 1, 2, 3, 4, 5, 6, 7, 7, 6, 5, 4, 3, 2, 1, 0],
        [0, 1, 2, 1, 0, 1, 2, 3, 2, 1, 2, 3, 4, 3, 2, 1, 0],
      ];
      for (const run of runs) {
        const ms = run.map((i) => c.sa + deg(i));
        if (!ms.every(ok)) continue;
        for (let r = 0; r < 2; r++) t = along(out, ms.map((m, i) => ({ m, d: i === ms.length - 1 ? beat * 4 : beat })), t, c.sa, 1);
      }
      return out;
    },
    teach: ['Taans are fast, light runs. Keep the voice small and flexible — volume kills speed.', 'Try “aa-aa-aa” with a tiny pulse on each note at first, then smooth it out.', 'Accuracy first. Speed comes with days of riyaaz, not with force.'],
  },
  {
    id: 'taar',
    icon: '🏔️',
    title: 'Taar saptak',
    hindi: 'तार सप्तक',
    subtitle: 'Gently extend the top of your voice — one step at a time',
    stage: 4,
    focus: 'pitch',
    build(c) {
      const top = c.high + 1; // never more than a semitone past your measured top
      const seq = [];
      for (let i = 0; i <= 21; i++) {
        const m = c.sa + deg(i);
        if (m >= c.high - 5 && m <= top) seq.push(m);
      }
      const out = [];
      let t = 0;
      for (const m of [...seq, ...seq.slice(0, -1).reverse()]) t = echo(out, [{ m, d: 1.6 }], t, c.sa, 0.5, 1.1);
      return out;
    },
    teach: [
      'High notes come from lightness and breath support — never from squeezing the throat or lifting the chin.',
      'This drill goes at most one semitone past your measured top. Your range grows as the voice opens, week by week.',
      'If anything hurts, scratches or cracks repeatedly: stop for today. Pain is never part of riyaaz.',
    ],
  },
];

export function exerciseById(id) {
  return EXERCISES.find((e) => e.id === id);
}

export const STAGES = [
  { n: 1, name: 'Shuruaat', meaning: 'the beginning', icon: '🌱', tolerance: 50, need: { days: 4, avg: 60 }, plan: ['omkar', 'sa-pa-sa', 'aaroh', 'swar'] },
  { n: 2, name: 'Abhyaas', meaning: 'steady practice', icon: '🪔', tolerance: 45, need: { days: 7, avg: 65 }, plan: ['omkar', 'kharaj', 'aaroh', 'alankar-1', 'meend'] },
  { n: 3, name: 'Sadhana', meaning: 'devotion', icon: '🔥', tolerance: 40, need: { days: 10, avg: 70 }, plan: ['omkar', 'kharaj', 'alankar-2', 'alankar-3', 'meend', 'bridge'] },
  { n: 4, name: 'Tayyari', meaning: 'readiness', icon: '⚡', tolerance: 35, need: { days: 14, avg: 75 }, plan: ['kharaj', 'alankar-3', 'bridge', 'taan', 'taar', 'dum'] },
  { n: 5, name: 'Swarna', meaning: 'golden', icon: '✨', tolerance: 30, need: null, plan: ['omkar', 'kharaj', 'bridge', 'taan', 'taar', 'swar'] },
];

export function stageOf(n) {
  return STAGES[clamp(n, 1, STAGES.length) - 1];
}

/** Everything the practice screen needs to run one riyaaz exercise. */
export function riyaazPractice(id, { sa, low, high, stage = 1, voice = null, seed }) {
  const ex = exerciseById(id);
  const st = stageOf(stage);
  const ctx = { sa, low: low ?? sa - 7, high: high ?? sa + 17, stage: st.n, seed, breakAt: voice ? breakCenter(voice) : sa + 12 };
  return {
    title: `${ex.icon} ${ex.title}`,
    subtitle: ex.subtitle,
    targets: ex.build(ctx),
    tolerance: st.tolerance,
    bpm: BPM_BY_STAGE[st.n - 1],
    focus: ex.focus,
    guideOnSing: ex.mode === 'along',
    sa,
    tanpura: true,
    riyaaz: { id },
  };
}

export const today = (d = new Date()) => d.toISOString().slice(0, 10);

function daysBetween(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}

/** A day counts as a riyaaz day once 3 exercises were done. */
export function isRiyaazDay(day) {
  return Object.keys(day?.done || {}).length >= 3;
}

/** Progress inside the current stage and whether the singer is ready to move up. */
export function stageStatus(r, now = today()) {
  const st = stageOf(r.stage || 1);
  const since = r.stageSince || '0000-00-00';
  const days = Object.entries(r.days || {}).filter(([d, v]) => d >= since && d <= now && isRiyaazDay(v)).length;
  const recent = (r.log || []).filter((x) => x.day >= since).slice(-8);
  const avg = recent.length ? Math.round(recent.reduce((s, x) => s + x.score, 0) / recent.length) : 0;
  const ready = !!st.need && days >= st.need.days && recent.length >= 5 && avg >= st.need.avg;
  return { stage: st, days, avg, takes: recent.length, ready };
}

export const GOLD_TIERS = [
  { min: 0, name: 'Kachcha Sur', meaning: 'raw voice', icon: '🌱' },
  { min: 30, name: 'Abhyasi', meaning: 'practising', icon: '🪔' },
  { min: 50, name: 'Sadhak', meaning: 'dedicated', icon: '🔥' },
  { min: 70, name: 'Surila', meaning: 'melodious', icon: '🎶' },
  { min: 85, name: 'Swarna Swar', meaning: 'golden voice', icon: '✨' },
];

const GOLD_PARTS = [
  { key: 'sur', label: 'Sur', hint: 'pitch accuracy', w: 0.22 },
  { key: 'thehraav', label: 'Thehraav', hint: 'steadiness', w: 0.15 },
  { key: 'dum', label: 'Dum', hint: 'breath', w: 0.12 },
  { key: 'vistaar', label: 'Vistaar', hint: 'range', w: 0.12 },
  { key: 'kharaj', label: 'Kharaj', hint: 'low-note depth', w: 0.1 },
  { key: 'pul', label: 'Pul', hint: 'smooth break', w: 0.14 },
  { key: 'niyam', label: 'Niyam', hint: 'daily consistency', w: 0.15 },
];

/** Takes needed before a skill counts in full — one great take is not a golden voice. */
export const GOLD_EVIDENCE = 8;

/**
 * The golden-voice meter: 0–100 from seven parts of a trained voice. Skill parts fill up
 * with evidence (r.n = takes per part), so the meter tracks weeks of riyaaz, not one take.
 */
export function goldenVoice(r, voice, now = today()) {
  const earned = (key) => (r.ema?.[key] == null ? null : Math.round(r.ema[key] * Math.min(1, (r.n?.[key] || 0) / GOLD_EVIDENCE)));
  const reachLow = Math.min(voice?.low ?? Infinity, r.reach?.low ?? Infinity);
  const reachHigh = Math.max(voice?.high ?? -Infinity, r.reach?.high ?? -Infinity);
  const span = Number.isFinite(reachLow) && Number.isFinite(reachHigh) ? reachHigh - reachLow : null;
  const recentDays = Object.entries(r.days || {}).filter(([d, v]) => daysBetween(d, now) >= 0 && daysBetween(d, now) < 14 && isRiyaazDay(v)).length;
  const values = {
    sur: earned('sur'),
    thehraav: earned('thehraav'),
    dum: r.best?.dum ? clamp(Math.round((r.best.dum / 15) * 100), 0, 100) : null,
    vistaar: span != null ? clamp(Math.round(((span - 12) / 14) * 100), 0, 100) : null,
    kharaj: earned('kharaj'),
    pul: earned('pul'),
    niyam: clamp(Math.round((recentDays / 10) * 100), 0, 100),
  };
  const score = Math.round(GOLD_PARTS.reduce((s, p) => s + (values[p.key] ?? 0) * p.w, 0));
  let tier = GOLD_TIERS[0];
  for (const t of GOLD_TIERS) if (score >= t.min) tier = t;
  const nextTier = GOLD_TIERS.find((t) => t.min > score) || null;
  return { score, tier, nextTier, parts: GOLD_PARTS.map((p) => ({ ...p, value: values[p.key] })) };
}
