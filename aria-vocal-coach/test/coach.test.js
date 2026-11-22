import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreTake } from '../public/js/audio/scoring.js';
import { LiveCoach, buildInsights } from '../public/js/audio/coach.js';

const FPS = 60;
const targets = [
  { midi: 60, start: 0, dur: 1, role: 'listen' },
  { midi: 60, start: 1.2, dur: 1, role: 'sing' },
  { midi: 64, start: 2.2, dur: 1, role: 'sing' },
  { midi: 67, start: 3.2, dur: 1.6, role: 'sing' },
];

/** Simulate a singer: offsetCents error, optional octave shift and delay. */
function sing(ts, { cents = 0, octave = 0, delay = 0.05, wobble = 0, rms = 0.1 } = {}) {
  const frames = [];
  for (let t = 0; t <= 5; t += 1 / FPS) {
    const tg = ts.find((x) => x.role === 'sing' && t >= x.start + delay && t < x.start + x.dur);
    const w = wobble ? wobble * Math.sin(t * 2 * Math.PI * 1.3) : 0;
    frames.push({ t, midi: tg ? tg.midi + 12 * octave + (cents + w) / 100 : null, rms: tg ? rms : 0.001 });
  }
  return frames;
}

test('a perfect take scores near 100 with three stars', () => {
  const r = scoreTake(sing(targets), targets);
  assert.ok(r.score >= 95, `score ${r.score}`);
  assert.equal(r.stars, 3);
  assert.equal(r.notesHit, 3);
  assert.equal(r.notesTotal, 3, 'listen notes are not scored');
});

test('singing 100 cents flat fails and the coach says you lean flat', () => {
  const r = scoreTake(sing(targets, { cents: -100 }), targets);
  assert.ok(r.score < 40, `score ${r.score}`);
  assert.ok(r.meanSignedCents < -90);
  const insights = buildInsights(r);
  assert.ok(insights.some((i) => i.type === 'tip' && /flat/.test(i.text)), JSON.stringify(insights));
});

test('an octave-lower singer is still scored as in tune', () => {
  const r = scoreTake(sing(targets, { octave: -1 }), targets);
  assert.ok(r.score >= 95, `score ${r.score}`);
  assert.equal(r.octaveMode, -1);
  assert.ok(buildInsights(r).some((i) => /octave lower/.test(i.text)));
});

test('a wobbly voice loses stability points', () => {
  const steady = scoreTake(sing(targets), targets, { focus: 'stability' });
  const wobbly = scoreTake(sing(targets, { wobble: 45 }), targets, { focus: 'stability' });
  assert.ok(wobbly.stability < steady.stability - 30, `${wobbly.stability} vs ${steady.stability}`);
});

test('live coach tells you to go higher, lower, or hold', () => {
  const run = (cents) => {
    const coach = new LiveCoach({ tolerance: 40 });
    let out;
    for (let t = 0; t < 1; t += 1 / FPS) out = coach.update({ t, midi: 60 + cents / 100, rms: 0.1 }, 60, 'sing');
    return out.cue.kind;
  };
  assert.equal(run(-80), 'up');
  assert.equal(run(-200), 'much-up');
  assert.equal(run(80), 'down');
  assert.equal(run(4), 'good');
  assert.equal(run(-25), 'nudge-up');
});

test('live coach prompts you to sing when silent and listen during demos', () => {
  const coach = new LiveCoach();
  let out;
  for (let t = 0; t < 1; t += 1 / FPS) out = coach.update({ t, midi: null, rms: 0 }, 60, 'sing');
  assert.equal(out.cue.kind, 'sing');
  const c2 = new LiveCoach();
  assert.equal(c2.update({ t: 0, midi: null, rms: 0 }, null, 'listen').cue.kind, 'listen');
});
