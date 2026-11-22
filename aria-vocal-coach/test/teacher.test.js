import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeStyle, aggregateStyles, compareStyle, styleDrills, signature, keyAdvice } from '../public/js/audio/style.js';
import { condense, diagnose, teacherNote, lessonPlan } from '../public/js/audio/teacher.js';

const HOP = 0.0116;

/** Build a pitch track from segments: [fn(x, dur) -> midi|null, dur]. */
function track(segments) {
  const pts = [];
  let t = 0;
  for (const [f, dur] of segments) {
    for (let x = 0; x < dur; x += HOP) {
      pts.push({ t, m: f(x, dur) });
      t += HOP;
    }
  }
  return pts;
}
const hold = (m) => [() => m, 1];
const rest = (d) => [() => null, d];

// An ornate singer: vibrato on long notes, quick murki turns, meend slides.
const ornate = () =>
  track([
    [(x) => 62 + 0.45 * Math.sin(2 * Math.PI * 5.5 * x), 1.5],
    [(x) => 62 + (x < 0.07 ? (2 * x) / 0.07 : x < 0.14 ? 2 - (2 * (x - 0.07)) / 0.07 : 0), 0.3],
    [(x) => 62 + (x < 0.07 ? (-1.5 * x) / 0.07 : x < 0.14 ? -1.5 + (1.5 * (x - 0.07)) / 0.07 : 0), 0.3],
    [(x, d) => 62 + (5 * x) / d, 0.4],
    [(x) => 67 + 0.45 * Math.sin(2 * Math.PI * 5.2 * x), 1.4],
    rest(0.5),
    [(x, d) => 67 - (4 * x) / d, 0.4],
    [(x) => 63 + 0.4 * Math.sin(2 * Math.PI * 5.8 * x), 1.3],
  ]);

// A plain singer: straight notes, clean steps, short phrases.
const plain = () => track([hold(60), hold(62), rest(0.4), hold(64), hold(62), rest(0.4), hold(60), hold(59)]);

test('style analysis hears vibrato, ornaments and slides', () => {
  const s = analyzeStyle(ornate());
  assert.ok(s.vibratoShare >= 0.6, `vibrato share ${s.vibratoShare}`);
  assert.ok(s.vibratoRate >= 4.5 && s.vibratoRate <= 6.5, `rate ${s.vibratoRate}`);
  assert.ok(s.counts.turns >= 2, `turns ${s.counts.turns}`);
  assert.ok(s.glideShare >= 0.5, `glides ${s.glideShare}`);
  const keys = signature(s).map((x) => x.key);
  assert.ok(keys.includes('vibrato') && keys.includes('meend'));
});

test('plain singing has no vibrato, ornaments or slides', () => {
  const s = analyzeStyle(plain());
  assert.equal(s.vibratoShare, 0);
  assert.equal(s.counts.turns, 0);
  assert.equal(s.glideShare, 0);
  assert.ok(s.noteRate > 0.5 && s.noteRate < 1.6);
});

test('breath per phrase is measured only when the breaths are audible', () => {
  // A singer with clear breaths: 3 s phrases, 1 s silences.
  const breathy = analyzeStyle(track([hold(60), hold(62), hold(64), rest(1), hold(62), hold(60), hold(62), rest(1), hold(64), hold(62), hold(60)]));
  assert.ok(breathy.phraseLen >= 2.5 && breathy.phraseLen <= 3.2, `phrase ${breathy.phraseLen}`);
  // A full mix: the melody track never goes silent, so breaths can't be seen.
  const mix = analyzeStyle(track([hold(60), hold(62), hold(64), hold(62), hold(60), hold(62), hold(64), hold(62), hold(60)]));
  assert.equal(mix.phraseLen, null);
  const prof = aggregateStyles([mix]);
  assert.equal(prof.phraseLen, null);
  assert.ok(!compareStyle(breathy, prof, 'X').rows.some((r) => r.key === 'phraseLen'), 'unmeasured metric is not compared');
});

test('too little singing gives no verdict', () => {
  assert.equal(analyzeStyle(track([hold(60)])), null);
  assert.equal(analyzeStyle([]), null);
});

test('pitch-tracker octave spikes are not mistaken for ornaments', () => {
  const pts = plain();
  for (let i = 40; i < pts.length; i += 97) if (pts[i].m != null) pts[i] = { ...pts[i], m: pts[i].m + 12 };
  assert.equal(analyzeStyle(pts).counts.turns, 0);
});

test('comparison scores a match, explains gaps and points to drills', () => {
  const prof = aggregateStyles([analyzeStyle(ornate()), analyzeStyle(ornate())]);
  const same = compareStyle(analyzeStyle(ornate()), prof, 'Test Singer');
  const diff = compareStyle(analyzeStyle(plain()), prof, 'Test Singer');
  assert.ok(same.match > diff.match + 20, `${same.match} vs ${diff.match}`);
  assert.ok(diff.tips.length >= 2);
  assert.ok(diff.tips.some((t) => t.drill === 'vibrato' || t.drill === 'meend'));
  assert.ok(diff.tips.every((t) => t.text.includes('Test Singer')));
  assert.ok(same.wins.length >= 3);
});

test('style drills fit the student’s range', () => {
  const prof = aggregateStyles([analyzeStyle(ornate())]);
  const range = { low: 50, high: 69 };
  const drills = styleDrills(prof, range, 'X');
  assert.equal(drills.length, 6);
  for (const d of drills) {
    assert.ok(d.targets.length > 0, d.id);
    for (const t of d.targets) for (const m of [t.midi, t.glideTo ?? t.midi]) assert.ok(m >= range.low - 1 && m <= range.high + 1, `${d.id}: ${m}`);
  }
  assert.match(keyAdvice(prof, range, 'X'), /X sings around/);
});

const take = (o = {}) => ({ score: 60, accuracy: 62, coverage: 80, stability: 70, timing: 80, hitRate: 70, meanSignedCents: 0, scoops: 0, notesTotal: 8, notesHit: 6, longestHold: 6, focus: 'pitch', stars: 1, ...o });

test('the teacher waits for a pattern before diagnosing', () => {
  assert.equal(diagnose([condense(take({ meanSignedCents: -30 }))]).enough, false);
  const d = diagnose([condense(take({ meanSignedCents: -30 })), condense(take({ meanSignedCents: -25 })), condense(take({ meanSignedCents: -28 }))]);
  assert.equal(d.enough, true);
  assert.equal(d.issues[0].key, 'flat');
  assert.ok(d.issues[0].assign.some((a) => a.kind === 'riyaaz'));
});

test('the teacher spots wobble, scoops and short breath', () => {
  const takes = [1, 2, 3].map(() => condense(take({ stability: 40, scoops: 4, notesTotal: 10, focus: 'stability', longestHold: 2.5, perNote: [{ dur: 30 }] })));
  const keys = diagnose(takes).issues.map((i) => i.key);
  for (const k of ['unsteady', 'scoops', 'breath']) assert.ok(keys.includes(k), k);
  const plan = lessonPlan(takes);
  assert.equal(plan.focus.length, 2);
});

test('breath is not judged on exercises that only asked for short notes', () => {
  // A 5-second Omkar can't show a 10-second breath — don't blame the singer for it.
  const takes = [1, 2, 3].map(() => condense(take({ focus: 'stability', longestHold: 4.5, perNote: [{ dur: 5 }] })));
  assert.ok(!diagnose(takes).issues.some((i) => i.key === 'breath'));
});

test('after a take the teacher praises, corrects and compares with last time', () => {
  const prev = [condense(take({ score: 55 }), { id: 'omkar' })];
  const note = teacherNote(take({ score: 82, accuracy: 85, stars: 2, meanSignedCents: -24 }), prev, { id: 'omkar' });
  assert.match(note.lines[0], /85% of that was in tune/);
  assert.ok(note.lines.some((l) => /27 points better/.test(l)));
  assert.ok(note.lines.some((l) => /flat/.test(l)));
  assert.equal(note.mood, 'happy');
  const silent = teacherNote(take({ coverage: 5 }), [], {});
  assert.match(silent.lines[0], /barely hear you/);
});
