import { test } from 'node:test';
import assert from 'node:assert/strict';
import { swaraName, harmoniumScale, shiftToSa, placeSa } from '../public/js/audio/sargam.js';
import { EXERCISES, STAGES, riyaazPractice, suggestSa, breakCenter, stageStatus, goldenVoice } from '../public/js/data/riyaaz.js';
import { scoreTake } from '../public/js/audio/scoring.js';

test('sargam names: komal, tivra and saptak marks', () => {
  const sa = 50; // D3
  assert.equal(swaraName(50, sa), 'Sa');
  assert.equal(swaraName(51, sa), 're'); // komal Re
  assert.equal(swaraName(52, sa), 'Re');
  assert.equal(swaraName(56, sa), 'Ma′'); // tivra Ma
  assert.equal(swaraName(57, sa), 'Pa');
  assert.equal(swaraName(49, sa), 'Ṇi'); // mandra Ni
  assert.equal(swaraName(62, sa), 'Ṡa'); // taar Sa
  assert.equal(swaraName(62, sa, { octave: false }), 'Sa');
  assert.equal(harmoniumScale(49), 'Kali 1');
  assert.equal(harmoniumScale(48), 'Safed 1');
  assert.equal(placeSa(2, 49), 50);
});

test('shiftToSa moves a song onto the singer’s Sa in a singable octave', () => {
  // Song in A (tonic 9), melody centred on E4 (64); singer Sa = D3 (50).
  const s = shiftToSa(9, 64, 50);
  assert.equal(((9 + s) % 12 + 12) % 12, 2, 'tonic lands on D');
  assert.ok(Math.abs(64 + s - 56) <= 6, 'melody centred near Sa + 6');
});

test('suggested Sa leaves room for mandra Pa below and taar Sa above', () => {
  for (const [low, high] of [[44, 71], [48, 72], [57, 81], [40, 64]]) {
    const sa = suggestSa({ low, high });
    assert.ok(sa - 5 >= low - 2, `mandra Pa reachable for ${low}-${high}`);
    assert.ok(sa + 12 <= high, `taar Sa reachable for ${low}-${high}`);
  }
  assert.equal(suggestSa(null), null);
});

test('every riyaaz exercise stays inside the voice (±1 semitone) at every stage', () => {
  const voice = { low: 45, high: 68, type: 'Baritone' };
  const sa = suggestSa(voice);
  for (const st of STAGES) {
    for (const ex of EXERCISES) {
      const p = riyaazPractice(ex.id, { sa, low: voice.low, high: voice.high, stage: st.n, voice, seed: 11 });
      assert.ok(p.targets.length > 0, `${ex.id} @${st.n} has notes`);
      for (const t of p.targets) {
        for (const m of [t.midi, t.glideTo ?? t.midi]) {
          assert.ok(m >= voice.low - 1 && m <= voice.high + 1, `${ex.id} @${st.n}: ${m} outside ${voice.low}-${voice.high}`);
        }
        assert.ok(t.dur > 0 && t.start >= 0);
        assert.equal(typeof t.lyric, 'string');
      }
      for (let i = 1; i < p.targets.length; i++) assert.ok(p.targets[i].start >= p.targets[i - 1].start, `${ex.id} sorted`);
      assert.equal(p.sa, sa);
      assert.equal(p.tolerance, st.tolerance);
    }
  }
});

test('plans only use exercises unlocked at that stage', () => {
  for (const st of STAGES) {
    for (const id of st.plan) {
      const ex = EXERCISES.find((e) => e.id === id);
      assert.ok(ex, id);
      assert.ok(ex.stage <= st.n, `${id} is not unlocked at stage ${st.n}`);
    }
  }
});

test('break centre is clamped inside the singer’s range', () => {
  assert.equal(breakCenter({ low: 44, high: 71, type: 'Baritone' }), 63);
  const c = breakCenter({ low: 40, high: 60, type: 'Tenor' });
  assert.ok(c <= 57 && c >= 45);
});

test('stage advances only with enough riyaaz days and a good average', () => {
  const days = {};
  for (const d of ['2026-11-01', '2026-11-02', '2026-11-03']) days[d] = { done: { omkar: 70, aaroh: 70, swar: 70 } };
  const log = Array.from({ length: 6 }, () => ({ id: 'omkar', day: '2026-11-03', score: 72 }));
  const r = { stage: 1, stageSince: '2026-11-01', days, log };
  assert.equal(stageStatus(r, '2026-11-03').ready, false, '3 of 4 days');
  days['2026-11-04'] = { done: { omkar: 70, aaroh: 70, swar: 70 } };
  assert.equal(stageStatus(r, '2026-11-04').ready, true);
  r.log = log.map((x) => ({ ...x, score: 40 }));
  assert.equal(stageStatus(r, '2026-11-04').ready, false, 'average too low');
  days['2026-11-05'] = { done: { omkar: 70 } }; // only one exercise — not a riyaaz day
  assert.equal(stageStatus({ ...r, log }, '2026-11-05').days, 4);
});

test('golden-voice meter rises with practice and has tiers', () => {
  const voice = { low: 44, high: 71 };
  const empty = goldenVoice({ days: {}, ema: {}, best: {}, reach: {} }, null, '2026-11-20');
  assert.equal(empty.score, 0);
  assert.equal(empty.tier.name, 'Kachcha Sur');
  const days = {};
  for (let i = 1; i <= 10; i++) days[`2026-11-${String(i + 9).padStart(2, '0')}`] = { done: { a: 1, b: 1, c: 1 } };
  const skills = { sur: 95, thehraav: 92, kharaj: 90, pul: 88 };
  const strong = goldenVoice({ days, ema: skills, n: { sur: 30, thehraav: 20, kharaj: 12, pul: 10 }, best: { dum: 16 }, reach: {} }, voice, '2026-11-20');
  assert.ok(strong.score >= 85, `score ${strong.score}`);
  assert.equal(strong.tier.name, 'Swarna Swar');
  assert.equal(strong.nextTier, null);
  // The same skill levels from a single take each don't make a golden voice.
  const once = goldenVoice({ days: {}, ema: skills, n: { sur: 1, thehraav: 1, kharaj: 1, pul: 1 }, best: {}, reach: {} }, voice, '2026-11-20');
  assert.ok(once.score < 30, `one take scored ${once.score}`);
});

test('longest steady hold is measured, forgiving tiny dropouts', () => {
  const targets = [{ midi: 60, start: 0, dur: 10, role: 'sing' }];
  const frames = [];
  for (let t = 0; t < 10; t += 0.016) frames.push({ t, midi: t > 4 && t < 4.08 ? null : t < 7 ? 60.1 : 63, rms: 0.1 });
  const r = scoreTake(frames, targets, { tolerance: 50, focus: 'stability' });
  assert.ok(r.longestHold >= 6.5 && r.longestHold <= 7.1, `hold ${r.longestHold}`);
});
