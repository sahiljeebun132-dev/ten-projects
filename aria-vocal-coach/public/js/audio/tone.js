// Tone colour — what the voice sounds like, not which note it hits. Pure, so it runs in the
// browser and in Node tests. Three classic voice-quality measures, per sung frame:
//
//   hnr   harmonics-to-noise ratio (dB), from the autocorrelation at the pitch period: how much of
//         the sound is clean, repeating tone and how much is air or rasp. Low = breathy.
//   h1h2  the first harmonic minus the second (dB). High = airy (the folds don't close fully);
//         low or negative = pressed (squeezed) phonation.
//   spr   singing power ratio (dB): the strongest peak at 2–4 kHz minus the strongest at 0–2 kHz.
//         Higher = more "ring" (the singer's formant): a brighter sound that carries.
//
// A take's tone is the median over its steady sung frames, turned into 0–100 readings. Microphones
// and rooms colour these numbers, so the app compares a reading with the singer's own earlier ones.
import { createFFT } from './fft.js';
import { median, percentile, clamp } from './notes.js';

export const TONE_FFT = 4096; // ~85 ms at 48 kHz: enough resolution to separate H1 and H2 of low voices
const HNR_PERIODS = 3; // the autocorrelation spans three periods: short enough that vibrato barely moves
const LAG_SEARCH = 0.03; // and finds the period itself within ±3% of the frame's pitch (vibrato moves it)
const MIN_FRAMES = 12; // analysed sung frames a take needs before it gets a tone reading
const MIN_SNR = 15; // dB between the singing and the quiet between notes, for a trustworthy reading

const round1 = (v) => Math.round(v * 10) / 10;

/** 0–100 clarity from HNR: 3 dB (very breathy) → 0, 23 dB (clean tone) → 100. */
export const clarityOf = (hnr) => Math.round(clamp((hnr - 3) / 20, 0, 1) * 100);
/** 0–100 ring from the singing power ratio: −40 dB (dull) → 0, −10 dB (ringing) → 100. */
export const ringOf = (spr) => Math.round(clamp((spr + 40) / 30, 0, 1) * 100);

/**
 * Per-frame analyser. analyze(buf, f0) takes the newest `size` samples (Float32Array, at least
 * `size` long) and the frame's pitch in Hz; returns { hnr, h1h2, spr } or null.
 */
export function createToneAnalyzer({ sampleRate, size = TONE_FFT } = {}) {
  if (!sampleRate) throw new Error('sampleRate is required');
  const fft = createFFT(size);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const win = new Float64Array(size);
  const mag = new Float64Array(size / 2);
  for (let i = 0; i < size; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
  const binHz = sampleRate / size;

  const peakDb = (lo, hi) => {
    const a = Math.max(1, Math.floor(lo / binHz));
    const b = Math.min(size / 2 - 1, Math.ceil(hi / binHz));
    let m = 0;
    for (let k = a; k <= b; k++) if (mag[k] > m) m = mag[k];
    return 20 * Math.log10(Math.max(m, 1e-12));
  };

  return function analyze(buf, f0) {
    if (!(f0 > 0) || !buf || buf.length < size) return null;
    const x = buf.length === size ? buf : buf.subarray(buf.length - size);
    const period = sampleRate / f0;
    // The newest HNR_PERIODS periods (plus the lag): within them vibrato moves the pitch very little.
    const span = Math.min(size, Math.ceil(period * (HNR_PERIODS + 1 + LAG_SEARCH)) + 4);
    if (span - Math.ceil(period * (1 + LAG_SEARCH)) < period * 2) return null; // two periods to correlate
    const off = size - span;

    // 1. HNR: the best normalised correlation at lags near the period.
    let best = 0;
    const reach = Math.max(2, Math.ceil(period * LAG_SEARCH));
    for (let T = Math.max(2, Math.floor(period) - reach); T <= Math.ceil(period) + reach; T++) {
      let xy = 0;
      let xx = 0;
      let yy = 0;
      for (let i = off; i < size - T; i++) {
        const a = x[i];
        const b = x[i + T];
        xy += a * b;
        xx += a * a;
        yy += b * b;
      }
      const r = xx > 0 && yy > 0 ? xy / Math.sqrt(xx * yy) : 0;
      if (r > best) best = r;
    }
    const r = Math.min(best, 0.9999);
    const hnr = r <= 0 ? -10 : clamp(10 * Math.log10(r / (1 - r)), -10, 40);

    // 2. The spectrum: the first two harmonics, and the 2–4 kHz band against 0–2 kHz.
    for (let i = 0; i < size; i++) {
      re[i] = x[i] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < size / 2; k++) mag[k] = Math.hypot(re[k], im[k]);
    const w = Math.max(binHz, f0 * 0.25);
    const h1h2 = peakDb(f0 - w, f0 + w) - peakDb(2 * f0 - w, 2 * f0 + w);
    const spr = peakDb(2000, 4000) - peakDb(50, 2000);
    return { hnr: round1(hnr), h1h2: round1(h1h2), spr: round1(spr) };
  };
}

/** Words for a tone reading: { sound, colour, headline }. */
export function describeTone(t) {
  if (!t) return null;
  const sound = t.pressed ? 'pressed' : t.clarity >= 70 ? 'clear' : t.clarity >= 45 ? 'a little airy' : 'breathy';
  const colour = t.ring >= 60 ? 'bright' : t.ring >= 35 ? 'warm' : 'dark';
  const headline = t.pressed
    ? 'Pressed: the sound is squeezed in the throat'
    : `${sound[0].toUpperCase()}${sound.slice(1)} and ${colour}`;
  return { sound, colour, headline };
}

/**
 * A take's tone from its frames ({ t, midi, rms, tone?: { hnr, h1h2, spr } }) inside the notes to
 * sing, skipping each note's first moment (the onset). Returns null when too little was analysed.
 *
 * reliable: false when the quiet between notes was loud next to the singing (room noise, or the
 * guide or song leaking from speakers into the mic). backing: the take played the original song,
 * which the mic hears too unless the singer wore headphones.
 */
export function summarizeTone(frames, targets, { attack = 0.15, backing = false } = {}) {
  const sing = (targets || []).filter((t) => t.role !== 'listen');
  const pts = [];
  const fades = [];
  for (const tg of sing) {
    const w0 = tg.start + Math.min(attack, tg.dur * 0.25);
    const w1 = tg.start + tg.dur;
    const inNote = (frames || []).filter((f) => f.t >= w0 && f.t < w1 && f.midi != null && f.tone);
    pts.push(...inNote);
    // Long notes: does the tone get breathier as the note goes on (running out of air)?
    if (tg.dur >= 1.5 && inNote.length >= 10) {
      const mid = tg.start + tg.dur / 2;
      const a = inNote.filter((f) => f.t < mid).map((f) => f.tone.hnr);
      const b = inNote.filter((f) => f.t >= mid).map((f) => f.tone.hnr);
      if (a.length >= 4 && b.length >= 4) fades.push(median(a) - median(b));
    }
  }
  if (pts.length < MIN_FRAMES) return null;

  const hnr = round1(median(pts.map((f) => f.tone.hnr)));
  const h1h2 = round1(median(pts.map((f) => f.tone.h1h2)));
  const spr = round1(median(pts.map((f) => f.tone.spr)));
  // Room check: the quietest moments between notes, against the singing.
  const quiet = (frames || []).filter((f) => f.midi == null && f.rms > 0).map((f) => f.rms);
  const noise = quiet.length >= 10 ? percentile(quiet, 20) : null;
  const voiced = median(pts.map((f) => f.rms || 0));
  const snr = noise > 0 && voiced > 0 ? Math.round(20 * Math.log10(voiced / noise)) : null;

  const clarity = clarityOf(hnr);
  const ring = ringOf(spr);
  const pressed = h1h2 <= -4 && clarity >= 55;
  const breathy = !pressed && (clarity < 45 || (clarity < 60 && h1h2 >= 8));
  const fade = fades.length ? round1(median(fades)) : null;
  const tone = {
    frames: pts.length,
    reliable: snr == null || snr >= MIN_SNR,
    snr,
    backing: Boolean(backing),
    hnr,
    h1h2,
    spr,
    clarity,
    ring,
    pressed,
    breathy,
    fade,
    fades: fade != null && fade >= 4,
  };
  const words = describeTone(tone);
  return { ...tone, sound: words.sound, colour: words.colour, headline: words.headline };
}

/** Whether a reading is fair to compare and teach from (not rough, not mixed with the song). */
export const trustTone = (t) => Boolean(t && t.reliable && !t.backing);

/** The usual clarity and ring from past log entries ({ clar, ring }), or null with too few. */
export function usualTone(log, { last = 20, min = 3 } = {}) {
  const es = (log || []).filter((e) => Number.isFinite(e.clar) && Number.isFinite(e.ring)).slice(-last);
  if (es.length < min) return null;
  return { clarity: Math.round(median(es.map((e) => e.clar))), ring: Math.round(median(es.map((e) => e.ring))), takes: es.length };
}
