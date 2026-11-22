// Pitch <-> note helpers. MIDI numbers are used everywhere as the pitch unit
// (69 = A4 = 440 Hz); fractional MIDI values carry the cents offset.

export const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export function freqToMidi(freq) {
  return 69 + 12 * Math.log2(freq / 440);
}

export function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function noteName(midi, withOctave = true) {
  const r = Math.round(midi);
  const name = NOTE_NAMES[((r % 12) + 12) % 12];
  return withOctave ? name + (Math.floor(r / 12) - 1) : name;
}

/** Cents away from the nearest equal-tempered note, in [-50, 50]. */
export function centsOff(midi) {
  return (midi - Math.round(midi)) * 100;
}

/** Fold a pitch difference (semitones) into [-6, 6] so octave errors are ignored. */
export function foldToOctave(diff) {
  return diff - 12 * Math.round(diff / 12);
}

/** "C4", "F#3", "Bb2" -> MIDI number. */
export function parseNote(text) {
  const m = /^([A-Ga-g])([#b♯♭]?)(-?\d)$/.exec(String(text).trim());
  if (!m) throw new Error(`Bad note: ${text}`);
  let pc = LETTER_PC[m[1].toUpperCase()];
  if (m[2] === '#' || m[2] === '♯') pc += 1;
  if (m[2] === 'b' || m[2] === '♭') pc -= 1;
  return (Number(m[3]) + 1) * 12 + pc;
}

export function isBlackKey(midi) {
  const pc = ((Math.round(midi) % 12) + 12) % 12;
  return pc === 1 || pc === 3 || pc === 6 || pc === 8 || pc === 10;
}

export function median(values) {
  if (!values.length) return NaN;
  const s = Float64Array.from(values).sort();
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function percentile(values, p) {
  if (!values.length) return NaN;
  const s = Float64Array.from(values).sort();
  const idx = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return s[idx];
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
