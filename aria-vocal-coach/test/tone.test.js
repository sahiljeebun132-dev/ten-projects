import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToneAnalyzer, summarizeTone, describeTone, trustTone, usualTone, clarityOf, ringOf, TONE_FFT } from '../public/js/audio/tone.js';
import { scoreTake } from '../public/js/audio/scoring.js';
import { buildInsights } from '../public/js/audio/coach.js';
import { condense, diagnose, teacherNote } from '../public/js/audio/teacher.js';
import { logEntry, takeRecord, takeSummary, weeklyTrend } from '../public/js/progress.js';
import { summarizeTake } from '../public/js/teacherTalk.js';
import { TEACHER_SYSTEM } from '../teacher-chat.js';
import { LESSON_SYSTEM } from '../teacher-lesson.js';
import { COMPARE_SYSTEM } from '../teacher-compare.js';

const SR = 48000;
const analyze = createToneAnalyzer({ sampleRate: SR });

/** A voice-like tone: harmonics falling at `tilt` dB per octave, with optional noise, ring and vibrato. */
function voice({ f0 = 220, tilt = -6, h1 = 0, ring = 0, noise = 0, vibrato = 0, t0 = 0, seed = 3 } = {}) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const x = new Float32Array(TONE_FFT);
  const amps = [];
  for (let k = 1; k * f0 < 7000; k++) {
    let a = 10 ** ((tilt * Math.log2(k)) / 20);
    if (k === 1) a *= 10 ** (h1 / 20);
    if (k * f0 > 2300 && k * f0 < 3700) a *= 10 ** (ring / 20);
    amps.push(a);
  }
  let ph = 0;
  for (let i = 0; i < x.length; i++) {
    const t = t0 + i / SR;
    ph += (2 * Math.PI * f0 * 2 ** ((vibrato / 2400) * Math.sin(2 * Math.PI * 5.5 * t))) / SR;
    let v = 0;
    for (let k = 0; k < amps.length; k++) v += amps[k] * Math.sin((k + 1) * ph);
    x[i] = 0.1 * v + noise * rnd();
  }
  return x;
}

// ------------------------------------------------------------------ per frame

test('clarity falls as air (noise) gets into the voice', () => {
  const clean = analyze(voice(), 220);
  const airy = analyze(voice({ noise: 0.03 }), 220);
  const breathy = analyze(voice({ noise: 0.08 }), 220);
  assert.ok(clean.hnr > airy.hnr && airy.hnr > breathy.hnr, JSON.stringify([clean, airy, breathy]));
  assert.ok(clarityOf(clean.hnr) >= 90);
  assert.ok(clarityOf(breathy.hnr) < 40);
});

test('vibrato and low voices do not read as breathy', () => {
  for (const [f0, vibrato] of [
    [220, 100],
    [98, 0],
    [98, 100],
    [520, 150],
  ]) {
    const readings = [0, 0.03, 0.06, 0.09].map((t0) => analyze(voice({ f0, vibrato, t0 }), f0 * 2 ** ((vibrato / 2400) * Math.sin(2 * Math.PI * 5.5 * (t0 + (TONE_FFT - 1024) / SR)))));
    const best = Math.max(...readings.map((r) => clarityOf(r.hnr)));
    assert.ok(best >= 70, `f0 ${f0} vibrato ${vibrato}: clarity ${best}`);
  }
});

test('H1–H2 separates an airy source from a pressed one, and ring follows 2–4 kHz energy', () => {
  const airy = analyze(voice({ h1: 10, tilt: -9 }), 220);
  const pressed = analyze(voice({ h1: -10, tilt: -4 }), 220);
  assert.ok(airy.h1h2 > 8, `airy ${airy.h1h2}`);
  assert.ok(pressed.h1h2 < -4, `pressed ${pressed.h1h2}`);
  const dull = analyze(voice({ tilt: -12 }), 220);
  const ringing = analyze(voice({ tilt: -12, ring: 18 }), 220);
  assert.ok(ringing.spr > dull.spr + 10, `${dull.spr} -> ${ringing.spr}`);
  assert.ok(ringOf(ringing.spr) > ringOf(dull.spr));
});

test('the analyser refuses frames it cannot read', () => {
  assert.equal(analyze(voice(), 0), null);
  assert.equal(analyze(new Float32Array(1000), 220), null);
  assert.equal(analyze(voice({ f0: 40 }), 30), null, 'too few periods in the window');
  assert.throws(() => createToneAnalyzer({}), /sampleRate/);
});

// ------------------------------------------------------------------ per take

const TARGETS = [
  { midi: 50, start: 0, dur: 1, role: 'listen' },
  { midi: 50, start: 1.2, dur: 3, role: 'sing' },
];
/** Frames at 30 per second over the take; `tone(t)` gives each sung frame's reading. */
function frames(tone, { quietRms = 0.002, singRms = 0.1, listenTone = null } = {}) {
  const out = [];
  for (let t = -0.2; t < 4.4; t += 1 / 30) {
    const singing = t >= 1.2 && t < 4.2;
    const listening = t >= 0 && t < 1;
    if (singing) out.push({ t, midi: 50, rms: singRms, tone: tone(t) });
    else if (listening && listenTone) out.push({ t, midi: 50, rms: 0.05, tone: listenTone });
    else out.push({ t, midi: null, rms: quietRms });
  }
  return out;
}
const steady = (hnr = 20, h1h2 = 3, spr = -24) => () => ({ hnr, h1h2, spr });

test('a take’s tone is the median of its sung frames, without onsets or listen notes', () => {
  const tone = summarizeTone(frames(steady(), { listenTone: { hnr: -5, h1h2: 20, spr: -60 } }), TARGETS);
  assert.equal(tone.hnr, 20);
  assert.equal(tone.clarity, clarityOf(20));
  assert.equal(tone.ring, ringOf(-24));
  assert.equal(tone.reliable, true);
  assert.equal(tone.backing, false);
  assert.ok(tone.frames < 90 && tone.frames > 80, `${tone.frames} frames: onset skipped`);
  assert.deepEqual([tone.sound, tone.colour], ['clear', 'warm']);
  assert.equal(tone.headline, 'Clear and warm');
  assert.equal(summarizeTone(frames(steady()).slice(0, 50), TARGETS), null, 'too little sung');
  assert.equal(summarizeTone(frames(() => null), TARGETS), null, 'no tone on any frame');
});

test('flags: breathy, pressed, airier at the end of long notes, a noisy room, the song playing', () => {
  const breathy = summarizeTone(frames(steady(9, 10, -30)), TARGETS);
  assert.ok(breathy.breathy && !breathy.pressed);
  assert.equal(breathy.sound, 'breathy');
  const pressed = summarizeTone(frames(steady(22, -7, -15)), TARGETS);
  assert.ok(pressed.pressed && !pressed.breathy);
  assert.match(pressed.headline, /Pressed/);
  const fading = summarizeTone(frames((t) => ({ hnr: t < 2.7 ? 22 : 12, h1h2: 3, spr: -24 })), TARGETS);
  assert.equal(fading.fades, true);
  assert.equal(fading.fade, 10);
  const noisy = summarizeTone(frames(steady(), { quietRms: 0.04 }), TARGETS);
  assert.equal(noisy.reliable, false);
  assert.ok(noisy.snr < 15);
  assert.equal(trustTone(noisy), false);
  const song = summarizeTone(frames(steady()), TARGETS, { backing: true });
  assert.equal(song.backing, true);
  assert.equal(trustTone(song), false);
  assert.equal(trustTone(summarizeTone(frames(steady()), TARGETS)), true);
  assert.equal(describeTone(null), null);
});

test('your usual tone comes from fair readings in the log', () => {
  assert.equal(usualTone([{ clar: 60, ring: 40 }]), null, 'too few');
  const log = [{ clar: 60, ring: 40 }, { clar: null, ring: null }, { clar: 70, ring: 50 }, { clar: 80, ring: 30 }];
  assert.deepEqual(usualTone(log), { clarity: 70, ring: 40, takes: 3 });
});

// ------------------------------------------------------------------ scoring, coaching and the teacher

const pitchFrames = (tone) => frames(tone).map((f) => ({ ...f, midi: f.midi }));

test('scoreTake reports tone beside the score without changing it', () => {
  const withTone = scoreTake(pitchFrames(steady()), TARGETS);
  const without = scoreTake(pitchFrames(() => null), TARGETS);
  assert.equal(withTone.score, without.score);
  assert.equal(without.tone, null);
  assert.equal(withTone.tone.clarity, clarityOf(20));
  assert.equal(scoreTake(pitchFrames(steady()), TARGETS, { backing: true }).tone.backing, true);
});

test('coaching tips and the on-device teacher use only fair tone readings', () => {
  const breathy = scoreTake(pitchFrames(steady(8, 10, -28)), TARGETS, { focus: 'stability' });
  assert.ok(buildInsights(breathy).some((i) => /breathy/i.test(i.text)));
  const rough = scoreTake(frames(steady(8, 10, -28), { quietRms: 0.05 }), TARGETS, { focus: 'stability' });
  assert.ok(!buildInsights(rough).some((i) => /breathy/i.test(i.text)), 'a rough reading gives no tone tip');
  const clear = scoreTake(pitchFrames(steady(24, 2, -15)), TARGETS, { focus: 'stability' });
  assert.ok(!buildInsights(clear).some((i) => i.type === 'tip' && /tone/i.test(i.text)));
  // With fewer pitch wins to show, the tone win makes the list.
  const plain = { ...clear, score: 55, accuracy: 50, stability: 50 };
  assert.ok(buildInsights(plain).some((i) => i.type === 'good' && /ringing/i.test(i.text)));

  assert.equal(condense(breathy).clarity, breathy.tone.clarity);
  assert.equal(condense(rough).clarity, null);
  const d = diagnose([1, 2, 3].map(() => condense(breathy)));
  const issue = d.issues.find((i) => i.key === 'breathy');
  assert.ok(issue, JSON.stringify(d.issues.map((i) => i.key)));
  assert.equal(issue.assign[0].id, 'omkar');
  const pressed = scoreTake(pitchFrames(steady(22, -7, -15)), TARGETS, { focus: 'stability' });
  assert.ok(diagnose([1, 2, 3].map(() => condense(pressed))).issues.some((i) => i.key === 'pressed'));
  assert.ok(!diagnose([1, 2, 3].map(() => condense(rough))).issues.some((i) => i.key === 'breathy'));
  assert.ok(diagnose([1, 2, 3].map(() => condense(clear))).strengths.some((s) => /tone is clear/.test(s)));

  const note = teacherNote({ ...breathy, accuracy: 90, meanSignedCents: 0, scoops: 0, stability: 85, timing: 90 }, []);
  assert.ok(note.lines.some((l) => /breathy/.test(l)), note.lines.join(' | '));
});

test('tone reaches the weekly log, the saved take and what the teacher reads', () => {
  const fair = scoreTake(pitchFrames(steady()), TARGETS);
  const rough = scoreTake(frames(steady(), { quietRms: 0.05 }), TARGETS);
  const e = logEntry({ key: 'omkar', kind: 'riyaaz', at: Date.now(), result: fair });
  assert.deepEqual([e.clar, e.ring], [fair.tone.clarity, fair.tone.ring]);
  assert.equal(logEntry({ key: 'omkar', kind: 'riyaaz', at: Date.now(), result: rough }).clar, null);
  assert.equal(weeklyTrend([e]).at(-1).clarity, fair.tone.clarity);

  const rec = takeRecord({ id: 'a', key: 'omkar', title: 'Omkar', kind: 'riyaaz', at: Date.now(), targets: TARGETS, frames: [], result: rough });
  assert.equal(rec.stats.tone.reliable, false);
  const sum = takeSummary(rec);
  assert.equal(sum.tone.clarity, rough.tone.clarity);
  assert.match(sum.tone.roughReading, /noisy/);
  const forChat = summarizeTake({ title: 'Omkar' }, fair, {});
  assert.equal(forChat.tone.clarity, fair.tone.clarity);
  assert.equal(forChat.tone.roughReading, undefined);
});

test('the prompts explain tone readings and how far to trust them', () => {
  assert.match(TEACHER_SYSTEM, /clarity \(0–100, from the harmonics-to-noise ratio/);
  assert.match(TEACHER_SYSTEM, /compare a reading with the student's own earlier ones/);
  assert.ok(LESSON_SYSTEM.includes('tone colour reading'));
  assert.match(COMPARE_SYSTEM, /fair tone reading/);
});
