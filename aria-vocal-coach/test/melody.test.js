import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractMelody, segmentNotes } from '../public/js/audio/melody.js';
import { detectKey } from '../public/js/audio/key.js';
import { midiToFreq } from '../public/js/audio/notes.js';

const SR = 22050;

/** Render notes [{midi, start, dur}] as a harmonic "voice" with a soft attack. */
function render(notes, total, { harmonics = 6, amp = 0.3, vibrato = 0 } = {}) {
  const out = new Float32Array(Math.ceil(total * SR));
  for (const n of notes) {
    const i0 = Math.floor(n.start * SR);
    const i1 = Math.min(out.length, Math.floor((n.start + n.dur) * SR));
    let phase = 0;
    for (let i = i0; i < i1; i++) {
      const t = (i - i0) / SR;
      const env = Math.min(1, t / 0.03) * Math.min(1, (i1 - i) / SR / 0.03);
      const f = midiToFreq(n.midi + vibrato * Math.sin(2 * Math.PI * 5.5 * t));
      phase += (2 * Math.PI * f) / SR;
      let v = 0;
      for (let h = 1; h <= harmonics; h++) v += Math.sin(phase * h) / h;
      out[i] += amp * env * v;
    }
  }
  return out;
}

const VOICE = [
  { midi: 57, start: 0.1, dur: 0.5 },
  { midi: 60, start: 0.65, dur: 0.5 },
  { midi: 64, start: 1.2, dur: 0.5 },
  { midi: 62, start: 1.75, dur: 0.6 },
];

function assertMelody(found, expected) {
  const midis = found.filter((n) => n.dur > 0.15).map((n) => n.midi);
  assert.deepEqual(midis, expected.map((n) => n.midi), `got ${JSON.stringify(found)}`);
  for (const e of expected) {
    const f = found.find((n) => n.midi === e.midi);
    assert.ok(Math.abs(f.start - e.start) < 0.08, `note ${e.midi} starts at ${f.start.toFixed(3)}, expected ${e.start}`);
  }
}

test('extracts a clean mono melody', () => {
  const left = render(VOICE, 2.6);
  const { notes } = extractMelody({ left, sampleRate: SR });
  assertMelody(notes, VOICE);
});

test('pulls a centred voice out from a hard-panned accompaniment', () => {
  const voice = render(VOICE, 2.6, { vibrato: 0.25 });
  // Loud sustained chord, panned hard left (C3 + G3 + E4-ish clash).
  const band = render(
    [
      { midi: 48, start: 0, dur: 2.6 },
      { midi: 55, start: 0, dur: 2.6 },
      { midi: 67, start: 0, dur: 2.6 },
    ],
    2.6,
    { amp: 0.35 },
  );
  const left = voice.map((v, i) => v + band[i]);
  const right = Float32Array.from(voice);
  const { notes } = extractMelody({ left, right, sampleRate: SR });
  assertMelody(notes, VOICE);
});

test('segmentNotes splits a contour on pitch changes and merges tiny gaps', () => {
  const hop = 0.01;
  const contour = new Float32Array(100).fill(NaN);
  for (let i = 0; i < 30; i++) contour[i] = 60.1;
  for (let i = 30; i < 32; i++) contour[i] = NaN; // tiny gap, same pitch continues
  for (let i = 32; i < 50; i++) contour[i] = 59.9;
  for (let i = 50; i < 80; i++) contour[i] = 64;
  const notes = segmentNotes(contour, hop);
  assert.deepEqual(notes.map((n) => n.midi), [60, 64]);
  assert.ok(Math.abs(notes[1].start - 0.5) < 0.02);
});

test('detects the key of a melody', () => {
  const cMajor = [60, 62, 64, 65, 67, 69, 71, 72, 67, 64, 60].map((midi) => ({ midi, dur: 1 }));
  assert.equal(detectKey(cMajor).name, 'C major');
  const aMinor = [57, 59, 60, 62, 64, 65, 67, 69, 64, 60, 57, 57].map((midi) => ({ midi, dur: 1 }));
  assert.equal(detectKey(aMinor).name, 'A minor');
});
