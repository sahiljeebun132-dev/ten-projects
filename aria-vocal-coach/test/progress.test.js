import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from '../server.js';
import { TEACHER_SYSTEM } from '../teacher-chat.js';
import { COMPARE_SYSTEM, validateCompare, compareMessages } from '../teacher-compare.js';
import {
  DAY,
  compactPitch,
  expandPitch,
  takeRecord,
  logEntry,
  worthKeeping,
  keepReasons,
  planPrune,
  pickThen,
  thenAndNow,
  monthlyNudge,
  weeklyTrend,
  progressSummary,
  takeSummary,
  weekOf,
} from '../public/js/progress.js';
import { buildTeacherContext } from '../public/js/teacherTalk.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const NOW = new Date(2026, 10, 20, 18, 0).getTime(); // a Friday evening

const result = (over = {}) => ({
  score: 70,
  stars: 2,
  focus: 'pitch',
  tolerance: 50,
  accuracy: 64,
  coverage: 80,
  stability: 58,
  timing: 72,
  longestHold: 2.4,
  meanSignedCents: -12,
  notesHit: 4,
  notesTotal: 5,
  scoops: 1,
  vibratoNotes: 0,
  perNote: [
    { midi: 50, hit: true, voicedFrac: 0.9, meanErr: -8.4 },
    { midi: 52, hit: false, voicedFrac: 0.1, meanErr: 40 },
  ],
  ...over,
});

let n = 0;
const take = (key, daysAgo, score, over = {}) => ({ id: `t${++n}`, key, title: key, at: NOW - daysAgo * DAY, stats: { score }, bytes: 100_000, starred: false, ...over });

// ------------------------------------------------------------------ what a take keeps

test('the pitch line is kept at 20 points a second, rounded, and draws back as frames', () => {
  const frames = [];
  for (let i = 0; i < 300; i++) frames.push({ t: -0.2 + i / 60, midi: i % 50 === 0 ? null : 50.123456, rms: 0.1 });
  const pitch = compactPitch(frames);
  assert.ok(pitch.length >= 80 && pitch.length <= 102, `${pitch.length} points for 5 s`);
  for (let i = 1; i < pitch.length; i++) assert.ok(pitch[i][0] - pitch[i - 1][0] >= 0.0499);
  assert.equal(pitch[1][1], 50.12);
  assert.equal(pitch[0][1], null, 'unvoiced frames stay unvoiced');
  assert.deepEqual(expandPitch(pitch)[1], { t: pitch[1][0], midi: 50.12 });
  assert.equal(compactPitch(frames, 0.05, 10).length, 10, 'capped');
  assert.deepEqual(expandPitch(null), []);
});

test('a take record keeps the numbers, the targets and the pitch line, and logs only meaningful skills', () => {
  const rec = takeRecord({
    id: 'a',
    key: 'omkar',
    title: 'Omkar',
    kind: 'riyaaz',
    at: NOW,
    sa: 50,
    targets: [{ midi: 50, start: 0, dur: 4, role: 'sing', lyric: 'Om' }],
    frames: [{ t: 0, midi: 50 }],
    result: result(),
    seconds: 12.34,
  });
  assert.equal(rec.stats.score, 70);
  assert.deepEqual(rec.stats.notes, [
    [50, 1, -8],
    [52, 0, null],
  ]);
  assert.deepEqual(rec.targets, [{ midi: 50, start: 0, dur: 4, role: 'sing' }]);
  assert.equal(rec.seconds, 12.3);
  assert.equal(rec.audio, null);
  assert.equal(rec.starred, false);

  assert.deepEqual(logEntry({ key: 'omkar', kind: 'riyaaz', at: NOW, result: result() }), { at: NOW, key: 'omkar', kind: 'riyaaz', score: 70, acc: 64, stab: 58, tim: 72 });
  const thin = logEntry({ key: 'x', kind: 'exercise', at: NOW, result: result({ coverage: 18, notesHit: 0 }) });
  assert.equal(thin.acc, null);
  assert.equal(thin.stab, null);
  assert.equal(thin.tim, null);
  assert.equal(logEntry({ key: 'v', kind: 'exercise', at: NOW, result: result({ focus: 'vibrato' }) }).stab, null, 'vibrato takes do not count as steadiness');
  assert.equal(worthKeeping(result({ coverage: 10 })), false);
  assert.equal(worthKeeping(result()), true);
});

// ------------------------------------------------------------------ what the library keeps

test('each exercise keeps its first, best, latest few and best of each week; starred always', () => {
  const t = [
    take('omkar', 100, 40), // first
    take('omkar', 60, 90), // best
    take('omkar', 59, 50), // same week as the best, lower: no reason
    take('omkar', 3, 60),
    take('omkar', 2, 61),
    take('omkar', 1, 62), // latest
    take('omkar', 250, 10, { key: 'sirens', starred: true }),
    take('omkar', 240, 20, { key: 'sirens' }),
  ];
  const r = keepReasons(t, {}, NOW);
  const has = (i, reason) => r.get(t[i].id).has(reason);
  assert.ok(has(0, 'first') && has(1, 'best') && has(5, 'latest'));
  assert.ok(has(3, 'recent') && has(4, 'recent') && has(5, 'recent'));
  assert.ok(has(1, 'week'));
  assert.equal(r.get(t[2].id).size, 0);
  assert.ok(has(6, 'starred') && has(6, 'first'));
  assert.ok(has(7, 'latest') && has(7, 'best'));
  assert.deepEqual(planPrune(t, {}, NOW), [t[2].id]);
});

test('over its caps the library gives up weekly snapshots first and never the latest or starred takes', () => {
  const t = [];
  for (let w = 0; w < 20; w++) t.push(take('aaroh', 140 - w * 7, 50 + w));
  t.push(take('aaroh', 200, 1, { key: 'dum', starred: true }));
  const doomed = planPrune(t, { maxTakes: 6 }, NOW);
  const left = t.filter((x) => !doomed.includes(x.id));
  assert.equal(left.length, 6);
  assert.ok(left.some((x) => x.key === 'dum'), 'starred stays');
  assert.ok(left.includes(t[19]), 'latest stays');
  assert.ok(left.includes(t[0]), 'first stays while weekly snapshots can go');
  assert.ok(!doomed.includes(t[18]) && !doomed.includes(t[17]), 'recent takes outlast weekly ones');

  const tight = planPrune(t, { maxTakes: 2 }, NOW);
  const kept = t.filter((x) => !tight.includes(x.id));
  assert.deepEqual(kept.map((x) => x.id).sort(), [t[19].id, t[20].id].sort(), 'only the latest and starred survive the tightest cap');

  const byBytes = planPrune(t, { maxBytes: 350_000 }, NOW);
  assert.ok(t.filter((x) => !byBytes.includes(x.id)).length <= 3, 'the byte cap is honoured too');
});

// ------------------------------------------------------------------ then & now

test('then & now sets an old enough take beside the latest one of each exercise', () => {
  const t = [take('omkar', 40, 45), take('omkar', 31, 50), take('omkar', 10, 58), take('omkar', 0, 66), take('omkar', 3, 70, { key: 'swar' }), take('omkar', 1, 72, { key: 'swar' })];
  const latest = t[3];
  assert.equal(pickThen(t, latest).id, t[0].id, 'Infinity: where you started');
  assert.equal(pickThen(t, latest, 30).id, t[1].id, 'closest to a month back');
  assert.equal(pickThen(t, t[2], 30).id, t[0].id, 'a month before the 10-days-ago take');
  assert.equal(pickThen(t, t[2], 7).id, t[1].id, 'at least a week older');
  assert.equal(pickThen(t.slice(4), t[5]), null, 'nothing a week older');
  const pairs = thenAndNow(t);
  assert.equal(pairs.length, 1);
  assert.deepEqual([pairs[0].then.id, pairs[0].now.id, pairs[0].days], [t[0].id, t[3].id, 40]);
});

test('the monthly moment needs a month between takes, a recent take, and a month since last shown', () => {
  const pairs = thenAndNow([take('omkar', 45, 40), take('omkar', 2, 70)]);
  assert.ok(monthlyNudge(pairs, null, NOW));
  assert.equal(monthlyNudge(pairs, NOW - 5 * DAY, NOW), null, 'shown five days ago');
  assert.ok(monthlyNudge(pairs, NOW - 30 * DAY, NOW));
  assert.equal(monthlyNudge(thenAndNow([take('omkar', 20, 40), take('omkar', 2, 70)]), null, NOW), null, 'only 18 days apart');
  assert.equal(monthlyNudge(thenAndNow([take('omkar', 80, 40), take('omkar', 30, 70)]), null, NOW), null, 'not sung lately');
});

// ------------------------------------------------------------------ weekly trends

test('weekly trends average each week and leave empty weeks empty', () => {
  const log = [
    { at: NOW - 1 * DAY, score: 70, acc: 60, stab: 50, tim: null },
    { at: NOW - 2 * DAY, score: 80, acc: 70, stab: null, tim: 90 },
    { at: NOW - 15 * DAY, score: 50, acc: 40, stab: 30, tim: 60 },
    { at: NOW - 200 * DAY, score: 10, acc: 10, stab: 10, tim: 10 },
  ];
  const trend = weeklyTrend(log, { weeks: 12, now: NOW });
  assert.equal(trend.length, 12);
  assert.equal(trend[11].week, weekOf(NOW));
  assert.deepEqual([trend[11].takes, trend[11].score, trend[11].inTune, trend[11].steadiness, trend[11].timing], [2, 75, 65, 50, 90]);
  assert.equal(trend[10].takes, 0);
  assert.equal(trend[10].inTune, null);
  assert.equal(trend[9].inTune, 40);
  assert.equal(trend.reduce((s, w) => s + w.takes, 0), 3, 'older takes fall outside the window');
  const weeks = new Set(trend.map((w) => w.week));
  assert.equal(weeks.size, 12, 'one entry per week');

  assert.equal(progressSummary([], NOW), null);
  const sum = progressSummary(log, NOW);
  assert.equal(sum.weeksPractisedOfLast8, 2);
  assert.deepEqual(sum.weekly.map((w) => w.weeksAgo), [2, 0]);
});

test('the teacher sees weekly progress in the practice data, and a stored take as a summary', () => {
  const state = { riyaaz: {}, voice: null, teacher: { takes: [], lessons: [] }, styles: {}, progress: { log: [{ at: Date.now(), key: 'omkar', score: 70, acc: 60, stab: 50, tim: 70 }] } };
  const ctx = buildTeacherContext(state);
  assert.equal(ctx.progress.weekly.at(-1).inTunePct, 60);
  assert.equal(buildTeacherContext({ ...state, progress: { log: [] } }).progress, undefined);
  assert.match(TEACHER_SYSTEM, /week-by-week averages/);

  const rec = takeRecord({ id: 'a', key: 'omkar', title: 'Omkar', kind: 'riyaaz', at: NOW - 3 * DAY, targets: [], frames: [], result: result(), seconds: 20 });
  const s = takeSummary(rec, NOW, (m) => `n${m}`);
  assert.equal(s.sungDaysAgo, 3);
  assert.equal(s.inTunePct, 64);
  assert.equal(s.notesHit, '4/5');
  assert.deepEqual(s.noteByNote[0], { note: 'n50', hit: true, avgCents: -8 });
});

// ------------------------------------------------------------------ the teacher compares

const side = (score, image = PNG) => ({ take: { score, inTunePct: score - 5 }, image });
const body = (over = {}) => ({ exercise: 'Omkar', daysApart: 31, then: side(48), now: side(71), context: { voice: 'Tenor' }, ...over });

test('a comparison needs both takes, real PNG pictures and sensible sizes', () => {
  assert.ok(!validateCompare(body()).error);
  assert.equal(validateCompare(body({ now: side(70, null) })).now.image, null, 'a take without a picture is fine');
  assert.match(validateCompare(body({ then: undefined })).error, /then take/);
  assert.match(validateCompare(body({ now: { take: 'x' } })).error, /now take/);
  assert.match(validateCompare(body({ then: side(40, 'aGVsbG8=') })).error, /PNG/);
  assert.match(validateCompare(body({ exercise: '' })).error, /Name the exercise/);
  assert.match(validateCompare(body({ exercise: 'x'.repeat(121) })).error, /Name the exercise/);
  assert.match(validateCompare(body({ daysApart: -1 })).error, /daysApart/);
  assert.match(validateCompare(body({ daysApart: 'soon' })).error, /daysApart/);
  assert.match(validateCompare(body({ then: { take: { notes: 'x'.repeat(7000) } } })).error, /too large/);
  assert.match(validateCompare(body({ context: [] })).error, /Context/);
  assert.match(validateCompare([]).error, /JSON object/);
});

test('the comparison prompt shares the teacher persona and puts each picture after its numbers', () => {
  assert.ok(COMPARE_SYSTEM.startsWith(TEACHER_SYSTEM.slice(0, 400)));
  assert.match(COMPARE_SYSTEM, /can't hear either/);
  assert.match(COMPARE_SYSTEM, /Voice health comes first/);
  const [msg] = compareMessages(validateCompare(body()));
  assert.equal(msg.role, 'user');
  const kinds = msg.content.map((b) => (b.type === 'image' ? 'image' : b.text.split('\n')[0]));
  assert.deepEqual(kinds, ['<practice_data>', '<comparison>', '<then_take>', 'image', '<now_take>', 'image', 'I’ve just listened to both takes. What has changed?']);
  assert.match(msg.content[1].text, /"daysApart":31/);
  assert.equal(compareMessages(validateCompare(body({ then: side(40, null), context: null }))).at(0).content.filter((b) => b.type === 'image').length, 1);
});

function fakeClient() {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        stream(params) {
          calls.push(JSON.parse(JSON.stringify(params)));
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Your long notes hold steady now. ' } };
              yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Next, the start of each note.' } };
            },
            async finalMessage() {
              return { stop_reason: 'end_turn', model: params.model, content: [], usage: { input_tokens: 900, output_tokens: 40 } };
            },
          };
        },
      },
    },
  };
}

function post(port, payload, headers = {}) {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const h = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers };
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/teacher/compare', headers: h }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          lines: /ndjson/.test(res.headers['content-type'] || '') ? text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [],
          json: /^application\/json/.test(res.headers['content-type'] || '') && text ? JSON.parse(text) : null,
        }),
      );
    });
    req.on('error', reject);
    req.end(data);
  });
}

async function withServer(fn, env = {}) {
  const client = fakeClient();
  const server = createServer({ env, teacherClient: client });
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  try {
    await fn({ port, client });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('the compare endpoint streams the teacher’s answer from both takes and their pictures', async () => {
  await withServer(async ({ port, client }) => {
    const r = await post(port, body());
    assert.equal(r.status, 200);
    assert.equal(
      r.lines
        .filter((l) => l.type === 'text')
        .map((l) => l.text)
        .join(''),
      'Your long notes hold steady now. Next, the start of each note.',
    );
    assert.equal(r.lines.at(-1).type, 'done');
    const call = client.calls[0];
    assert.equal(call.system[0].text, COMPARE_SYSTEM);
    assert.deepEqual(call.system[0].cache_control, { type: 'ephemeral' });
    assert.equal(call.messages.length, 1);
    assert.equal(call.messages[0].content.filter((b) => b.type === 'image').length, 2);
    const blocks = call.messages.flatMap((m) => m.content);
    assert.deepEqual([...new Set(blocks.map((b) => b.type))].sort(), ['image', 'text'], 'numbers and pictures only: no audio goes to Claude');
    assert.ok(blocks.filter((b) => b.type === 'image').every((b) => b.source.media_type === 'image/png'));
  });
});

test('the compare endpoint refuses other sites, bad bodies and oversized requests, and counts toward the daily cap', async () => {
  await withServer(
    async ({ port, client }) => {
      assert.equal((await post(port, body(), { origin: 'https://evil.example' })).status, 403);
      assert.equal((await post(port, body({ then: side(40, 'nope') }))).status, 400);
      assert.equal((await post(port, '{"exercise":')).status, 400);
      const huge = body({ now: { take: { pad: 'x'.repeat(600 * 1024) } } });
      assert.equal((await post(port, huge)).status, 413);
      assert.equal(client.calls.length, 0, 'none of those reached Claude');
      assert.equal((await post(port, body())).status, 200);
      const capped = await post(port, body());
      assert.equal(capped.status, 429);
      assert.match(capped.json.error, /limit/);
      assert.equal(client.calls.length, 1);
    },
    { ARIA_TEACHER_DAILY_CAP: '1' },
  );
});
