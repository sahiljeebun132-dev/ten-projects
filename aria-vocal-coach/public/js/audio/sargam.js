// Indian (Hindustani) note names relative to the singer's Sa.
// Lowercase = komal (flat) swara, Ma′ = tivra Ma. A dot below = mandra (lower) saptak,
// a dot above = taar (upper) saptak — the way sargam is written by hand.

export const SWARAS = ['Sa', 're', 'Re', 'ga', 'Ga', 'Ma', 'Ma′', 'Pa', 'dha', 'Dha', 'ni', 'Ni'];
export const SWARAS_DEVANAGARI = ['सा', 'रे॒', 'रे', 'ग॒', 'ग', 'म', 'म॑', 'प', 'ध॒', 'ध', 'नि॒', 'नि'];
const HARMONIUM = ['Safed 1', 'Kali 1', 'Safed 2', 'Kali 2', 'Safed 3', 'Safed 4', 'Kali 3', 'Safed 5', 'Kali 4', 'Safed 6', 'Kali 5', 'Safed 7'];

// Offsets of the shuddha swaras from Sa (Bilawal thaat), plus mandra/taar shortcuts.
export const S = { S: 0, r: 1, R: 2, g: 3, G: 4, M: 5, m: 6, P: 7, d: 8, D: 9, n: 10, N: 11 };

const mod = (n, m) => ((n % m) + m) % m;

/** Pitch class (0–11 from Sa) and saptak (-1 mandra, 0 madhya, +1 taar …) of a MIDI note. */
export function swaraOf(midi, sa) {
  const rel = Math.round(midi) - Math.round(sa);
  return { pc: mod(rel, 12), octave: Math.floor(rel / 12) };
}

const MARKS = { '-2': '̤', '-1': '̣', 1: '̇', 2: '̈' };

/** "Sa", "Ṇi" (mandra Ni), "Ṡa" (taar Sa), "re" (komal Re) … */
export function swaraName(midi, sa, { octave = true } = {}) {
  const { pc, octave: o } = swaraOf(midi, sa);
  const name = SWARAS[pc];
  if (!octave || o === 0) return name;
  const mark = MARKS[Math.max(-2, Math.min(2, o))];
  return name[0] + mark + name.slice(1);
}

export function swaraDevanagari(midi, sa) {
  return SWARAS_DEVANAGARI[swaraOf(midi, sa).pc];
}

export function saptakName(octave) {
  if (octave <= -2) return 'ati-mandra';
  if (octave === -1) return 'mandra';
  if (octave === 0) return 'madhya';
  if (octave === 1) return 'taar';
  return 'ati-taar';
}

/** Harmonium "scale" name singers use for their Sa: C = Safed 1, C♯ = Kali 1 … */
export function harmoniumScale(midi) {
  return HARMONIUM[mod(Math.round(midi), 12)];
}

/** The MIDI note with pitch class `pc` nearest to `center`. */
export function placeSa(pc, center) {
  return pc + 12 * Math.round((center - pc) / 12);
}

/**
 * Semitone shift that moves a song (tonic pitch class `tonicPc`, melody centre `mid`)
 * onto the singer's Sa, choosing the octave that sits best in the voice.
 */
export function shiftToSa(tonicPc, mid, sa) {
  const base = mod(mod(sa, 12) - tonicPc + 6, 12) - 6; // -6..5
  let best = base;
  for (const k of [-2, -1, 0, 1, 2]) {
    const s = base + 12 * k;
    if (Math.abs(mid + s - (sa + 6)) < Math.abs(mid + best - (sa + 6))) best = s;
  }
  return best;
}
