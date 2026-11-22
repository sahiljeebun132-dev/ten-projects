import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPitchDetector } from '../public/js/audio/pitch.js';
import { freqToMidi, midiToFreq, noteName, parseNote, foldToOctave } from '../public/js/audio/notes.js';

const SR = 48000;

function tone(freq, { harmonics = 1, n = 2048, amp = 0.5, phase = 0 } = {}) {
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let h = 1; h <= harmonics; h++) v += Math.sin((2 * Math.PI * freq * h * i) / SR + phase * h) / h;
    buf[i] = amp * v;
  }
  return buf;
}

test('note helpers round-trip', () => {
  assert.equal(noteName(69), 'A4');
  assert.equal(noteName(60), 'C4');
  assert.equal(parseNote('C4'), 60);
  assert.equal(parseNote('F#3'), 54);
  assert.equal(parseNote('Bb2'), 46);
  assert.ok(Math.abs(midiToFreq(69) - 440) < 1e-9);
  assert.ok(Math.abs(freqToMidi(261.6256) - 60) < 0.001);
  assert.equal(foldToOctave(-12.3).toFixed(1), '-0.3');
  assert.equal(foldToOctave(11.8).toFixed(1), '-0.2');
});

test('detects pure sine tones across the vocal range within 5 cents', () => {
  const detect = createPitchDetector({ sampleRate: SR });
  for (const midi of [41, 48, 57, 64, 69, 76, 81]) {
    const r = detect(tone(midiToFreq(midi)));
    const cents = (freqToMidi(r.freq) - midi) * 100;
    assert.ok(Math.abs(cents) < 5, `midi ${midi}: off by ${cents.toFixed(1)}¢`);
    assert.ok(r.clarity > 0.9);
  }
});

test('finds the fundamental of a harmonic-rich (voice-like) tone, not an overtone', () => {
  const detect = createPitchDetector({ sampleRate: SR });
  for (const f of [98, 146.8, 220, 330, 523.3]) {
    const r = detect(tone(f, { harmonics: 8, phase: 0.7 }));
    const cents = (freqToMidi(r.freq) - freqToMidi(f)) * 100;
    assert.ok(Math.abs(cents) < 8, `${f} Hz detected as ${r.freq.toFixed(1)} Hz`);
  }
});

test('reports silence and noise as unvoiced', () => {
  const detect = createPitchDetector({ sampleRate: SR });
  assert.equal(detect(new Float32Array(2048)).freq, 0);
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const noise = Float32Array.from({ length: 2048 }, () => 0.3 * rand());
  const r = detect(noise);
  assert.ok(r.freq === 0 || r.clarity < 0.8, 'noise should not look like a clear pitch');
});
