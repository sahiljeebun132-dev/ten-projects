import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import Anthropic from '@anthropic-ai/sdk';
import { createServer } from '../server.js';
import {
  LESSON_SYSTEM,
  LESSON_TOOLS,
  validateLessonStart,
  validateLessonStep,
  checkAction,
  echoContent,
  isPngBase64,
  createLessonStore,
  runLessonTurn,
  stepMessage,
  imageCharsIn,
  IMAGE_BUDGET,
} from '../teacher-lesson.js';
import { teacherConfig, TEACHER_SYSTEM } from '../teacher-chat.js';
import { EXERCISES } from '../public/js/data/riyaaz.js';
import { ALL_LESSONS } from '../public/js/data/curriculum.js';
import { buildTeacherContext, takeForLesson } from '../public/js/teacherTalk.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const CONTEXT = {
  riyaaz: { sa: 'D3 (Safed 2)', unlockedExercises: ['omkar', 'sa-pa-sa', 'swar', 'aaroh', 'dum'] },
  lessons: { passed: '3/20', next: 'Steps', unlocked: ['sustain', 'match', 'sirens', 'steps'] },
  learnedSingerStyles: [{ id: 'arijit-singh', singer: 'Arijit Singh' }],
};

/** A stand-in for the Anthropic client that plays scripted assistant turns, one per call. */
function scriptedClient(turns) {
  const calls = [];
  let i = 0;
  return {
    calls,
    beta: {
      messages: {
        stream(params, opts) {
          calls.push({ params: JSON.parse(JSON.stringify(params)), opts });
          const turn = turns[Math.min(i++, turns.length - 1)];
          return {
            async *[Symbol.asyncIterator]() {
              if (turn.iteratorError) throw turn.iteratorError;
              yield { type: 'message_start', message: { model: params.model } };
              for (const text of turn.text || []) yield { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } };
            },
            async finalMessage() {
              return {
                stop_reason: turn.stop ?? 'end_turn',
                model: params.model,
                content: turn.content ?? [{ type: 'text', text: (turn.text || []).join('') }],
                usage: { input_tokens: 1200, output_tokens: 60, cache_read_input_tokens: 900, cache_creation_input_tokens: 100 },
              };
            },
          };
        },
      },
    },
  };
}

const exerciseTurn = (input = { kind: 'riyaaz', id: 'omkar', cue: 'Keep the Om steady on one breath.' }, { id = 'toolu_1', text = ['Namaste! ', 'Let’s warm up with Omkar.'] } = {}) => ({
  text,
  stop: 'tool_use',
  content: [
    { type: 'thinking', thinking: '', signature: `sig-${id}` },
    { type: 'text', text: text.join('') },
    { type: 'tool_use', id, name: 'start_exercise', input },
  ],
});
const finishTurn = (id = 'toolu_9') => ({
  text: ['Lovely work today.'],
  stop: 'tool_use',
  content: [
    { type: 'text', text: 'Lovely work today.' },
    { type: 'tool_use', id, name: 'finish_lesson', input: { recap: 'We steadied your Sa.', homework: [{ kind: 'riyaaz', id: 'omkar' }, { kind: 'riyaaz', id: 'nope' }] } },
  ],
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function post(port, path, body, headers = {}) {
  const data = JSON.stringify(body);
  const h = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers };
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path, headers: h }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        let lines = [];
        let json = null;
        if (/ndjson/.test(res.headers['content-type'] || '')) lines = text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
        else json = text ? JSON.parse(text) : null;
        resolve({ status: res.statusCode, lines, json });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

async function withServer(turns, fn, env = {}) {
  const client = scriptedClient(turns);
  const server = createServer({ env, teacherClient: client });
  const port = await listen(server);
  try {
    await fn({ port, client, start: (body = {}) => post(port, '/api/teacher/lesson/start', { minutes: 15, context: CONTEXT, ...body }), step: (body) => post(port, '/api/teacher/lesson/step', body) });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const doneLine = (r) => r.lines.find((l) => l.type === 'done');
const actionLine = (r) => r.lines.find((l) => l.type === 'action')?.action;

// ------------------------------------------------------------------ prompt and tools

test('the lesson prompt teaches through the tools and lists only exercises that can run', () => {
  for (const e of EXERCISES) assert.ok(LESSON_SYSTEM.includes(`- ${e.id}: `), e.id);
  for (const l of ALL_LESSONS) assert.equal(LESSON_SYSTEM.includes(`\n- ${l.id}: `), l.kind !== 'range', l.id);
  assert.match(LESSON_SYSTEM, /start_exercise/);
  assert.match(LESSON_SYSTEM, /finish_lesson/);
  assert.match(LESSON_SYSTEM, /Voice health comes first/);
  assert.match(LESSON_SYSTEM, /don't write tags/);
  assert.ok(LESSON_SYSTEM.startsWith(TEACHER_SYSTEM.slice(0, 400)), 'shares the teacher persona');
  assert.deepEqual(LESSON_TOOLS.map((t) => t.name), ['start_exercise', 'finish_lesson']);
  for (const t of LESSON_TOOLS) {
    assert.equal(t.eager_input_streaming, true);
    assert.equal(t.input_schema.additionalProperties, false);
  }
  assert.deepEqual(LESSON_TOOLS[0].input_schema.required, ['kind', 'id', 'cue']);
});

// ------------------------------------------------------------------ validation

test('lesson starts need a sensible length, focus and context', () => {
  assert.deepEqual(validateLessonStart({ minutes: 15, focus: '  breath ', context: { a: 1 } }), { minutes: 15, focus: 'breath', context: { a: 1 }, key: null });
  assert.equal(validateLessonStart({ minutes: 10, key: '3f2a9c1e-77aa-4b1c-9d0e-123456789abc' }).key, '3f2a9c1e-77aa-4b1c-9d0e-123456789abc');
  assert.match(validateLessonStart({ minutes: 10, key: 'no spaces allowed' }).error, /key/);
  assert.match(validateLessonStart({ minutes: 45 }).error, /10, 15 or 20/);
  assert.match(validateLessonStart({ minutes: 10, focus: 'x'.repeat(201) }).error, /under 200/);
  assert.match(validateLessonStart({ minutes: 10, context: [] }).error, /object/);
  assert.match(validateLessonStart([]).error, /JSON object/);
});

test('lesson steps are checked: id, turn, result status, picture and sizes', () => {
  const id = 'a'.repeat(32);
  assert.deepEqual(validateLessonStep({ id, turn: 2, message: ' hi ' }), { id, turn: 2, result: null, message: 'hi', usedMin: null });
  assert.equal(validateLessonStep({ id, turn: 2, message: 'hi', usedMin: 7 }).usedMin, 7);
  assert.match(validateLessonStep({ id, turn: 2, message: 'hi', usedMin: 1.5 }).error, /usedMin/);
  assert.match(validateLessonStep({ id: 'nope', turn: 1 }).error, /Unknown lesson/);
  assert.match(validateLessonStep({ id, turn: -1 }).error, /turn/);
  assert.match(validateLessonStep({ id, turn: 1, result: { status: 'great' } }).error, /done, skipped or failed/);
  assert.match(validateLessonStep({ id, turn: 1, result: { status: 'done', image: 'R0lGODlhAQABAAAAACw=' } }).error, /PNG/);
  assert.match(validateLessonStep({ id, turn: 1, result: { status: 'done', take: { x: 'y'.repeat(9000) } } }).error, /too large/);
  const ok = validateLessonStep({ id, turn: 1, result: { status: 'done', take: { score: 80 }, image: PNG } });
  assert.equal(ok.result.image, PNG);
  assert.ok(isPngBase64(PNG));
  assert.ok(!isPngBase64(PNG.slice(0, -1)));
});

test('tool calls are checked against the catalogue and what this student has unlocked', () => {
  const ex = (input) => checkAction({ name: 'start_exercise', input }, CONTEXT);
  assert.deepEqual(ex({ kind: 'riyaaz', id: 'omkar', cue: ' Steady. ' }).action, { type: 'exercise', kind: 'riyaaz', id: 'omkar', cue: 'Steady.' });
  assert.match(ex({ kind: 'riyaaz', id: 'taan', cue: 'Go' }).error, /above the student’s riyaaz stage/);
  assert.match(ex({ kind: 'riyaaz', id: 'made-up', cue: 'Go' }).error, /no riyaaz exercise/);
  assert.match(checkAction({ name: 'start_exercise', input: { kind: 'riyaaz', id: 'omkar', cue: 'Go' } }, { riyaaz: { sa: 'not set' } }).error, /no Sa/);
  assert.equal(ex({ kind: 'lesson', id: 'sirens', cue: 'Slide' }).action.id, 'sirens');
  assert.match(ex({ kind: 'lesson', id: 'vibrato', cue: 'Go' }).error, /locked/);
  assert.match(ex({ kind: 'lesson', id: 'range', cue: 'Go' }).error, /no lesson "range"/);
  assert.deepEqual(ex({ kind: 'drill', id: 'murki', style_id: 'arijit-singh', cue: 'Light turns' }).action, { type: 'exercise', kind: 'drill', id: 'murki', styleId: 'arijit-singh', cue: 'Light turns' });
  assert.match(ex({ kind: 'drill', id: 'murki', style_id: 'someone-else', cue: 'Go' }).error, /style_id/);
  assert.match(ex({ kind: 'riyaaz', id: 'omkar' }).error, /cue is missing/);
  assert.match(ex({ kind: 'song', id: 'x', cue: 'Go' }).error, /kind must be/);
  const fin = checkAction({ name: 'finish_lesson', input: { recap: 'Good.', homework: [{ kind: 'riyaaz', id: 'omkar' }, { kind: 'riyaaz', id: 'zzz' }, 'junk'] } }, CONTEXT);
  assert.deepEqual(fin.action, { type: 'finish', recap: 'Good.', homework: [{ kind: 'riyaaz', id: 'omkar' }] });
  assert.match(checkAction({ name: 'finish_lesson', input: {} }, CONTEXT).error, /recap/);
  assert.match(checkAction({ name: 'rm_rf', input: {} }, CONTEXT).error, /no tool/);
});

test('after a mid-output fallback, blocks before the boundary are echoed as the API requires', () => {
  const plain = [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: 'Hi' }];
  assert.deepEqual(echoContent(plain), plain);
  assert.notEqual(echoContent(plain)[0], plain[0], 'a copy, not the same objects');
  const fallen = [
    { type: 'thinking', thinking: '', signature: 'a' },
    { type: 'text', text: 'Part one. ' },
    { type: 'tool_use', id: 't0', name: 'start_exercise', input: {} },
    { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' } },
    { type: 'thinking', thinking: '', signature: 'b' },
    { type: 'tool_use', id: 't1', name: 'start_exercise', input: { kind: 'riyaaz' } },
  ];
  assert.deepEqual(
    echoContent(fallen).map((b) => b.type + (b.signature || b.id || '')),
    ['text', 'fallback', 'thinkingb', 'tool_uset1'],
  );
});

// ------------------------------------------------------------------ the lesson loop, end to end

test('a lesson starts, runs an exercise, hears the take and picture, and finishes', async () => {
  await withServer([exerciseTurn(), exerciseTurn({ kind: 'lesson', id: 'sirens', cue: 'Slide slowly.' }, { id: 'toolu_2', text: ['Good Om! Now sirens.'] }), finishTurn()], async ({ client, start, step }) => {
    const r1 = await start({ focus: 'breath' });
    assert.equal(r1.status, 200);
    const id = r1.lines[0].id;
    assert.equal(r1.lines[0].type, 'lesson');
    assert.match(id, /^[a-f0-9]{32}$/);
    assert.equal(r1.lines.filter((l) => l.type === 'text').map((l) => l.text).join(''), 'Namaste! Let’s warm up with Omkar.');
    assert.deepEqual(actionLine(r1), { type: 'exercise', kind: 'riyaaz', id: 'omkar', cue: 'Keep the Om steady on one breath.' });
    assert.equal(doneLine(r1).waiting, 'exercise');
    assert.equal(doneLine(r1).turn, 1);

    // The first request: frozen prompt + tools, cache markers, fallbacks, practice data in turn one.
    const p1 = client.calls[0].params;
    assert.equal(p1.model, 'claude-opus-5-5');
    assert.equal(p1.system[0].text, LESSON_SYSTEM);
    assert.deepEqual(p1.system[0].cache_control, { type: 'ephemeral' });
    assert.deepEqual(p1.cache_control, { type: 'ephemeral' });
    assert.deepEqual(p1.tools, JSON.parse(JSON.stringify(LESSON_TOOLS)));
    assert.deepEqual(p1.betas, ['server-side-fallback-2026-07-01']);
    assert.equal(p1.fallbacks, 'default');
    assert.equal(p1.thinking, undefined);
    assert.equal(p1.messages.length, 1);
    assert.match(p1.messages[0].content[0].text, /^<practice_data>\n\{"riyaaz"/);
    assert.match(p1.messages[0].content[1].text, /15-minute lesson.*breath/);
    assert.equal(p1.messages[0].content[2].text, '[Lesson clock: 0 of 15 minutes used]');

    const take = { exercise: 'Omkar', score: 74, noteByNote: [{ note: 'Sa (D3)', hit: true, avgCents: -12 }] };
    const r2 = await step({ id, turn: 1, result: { status: 'done', take, image: PNG } });
    assert.equal(r2.status, 200);
    assert.deepEqual(actionLine(r2), { type: 'exercise', kind: 'lesson', id: 'sirens', cue: 'Slide slowly.' });
    assert.equal(doneLine(r2).turn, 2);

    // The second request replays history exactly and appends the take as a tool result.
    const p2 = client.calls[1].params;
    assert.deepEqual(p2.messages[0], p1.messages[0], 'turn one unchanged');
    assert.deepEqual(p2.messages[1], { role: 'assistant', content: exerciseTurn().content }, 'teacher turn echoed verbatim, thinking signature included');
    const [result, clock] = p2.messages[2].content;
    assert.equal(result.type, 'tool_result');
    assert.equal(result.tool_use_id, 'toolu_1');
    assert.deepEqual(JSON.parse(result.content[0].text), { status: 'done', take });
    assert.deepEqual(result.content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } });
    assert.equal(result.is_error, undefined);
    assert.match(clock.text, /^\[Lesson clock: \d+ of 15 minutes used\]$/);
    assert.equal(p2.system[0].text, p1.system[0].text);
    assert.deepEqual(p2.tools, p1.tools);

    const r3 = await step({ id, turn: 2, result: { status: 'skipped' } });
    assert.deepEqual(actionLine(r3), { type: 'finish', recap: 'We steadied your Sa.', homework: [{ kind: 'riyaaz', id: 'omkar' }] });
    assert.equal(doneLine(r3).waiting, 'finished');
    assert.deepEqual(JSON.parse(client.calls[2].params.messages[4].content[0].content[0].text), { status: 'skipped', note: 'The student skipped this exercise.' });
  });
});

test('an exercise that can’t run is sent back to Claude, and the browser only sees the corrected one', async () => {
  const bad = exerciseTurn({ kind: 'riyaaz', id: 'taan', cue: 'Fast!' }, { id: 'toolu_bad', text: ['Let’s try taans. '] });
  await withServer([bad, exerciseTurn(undefined, { id: 'toolu_ok', text: ['Actually, Omkar first.'] })], async ({ client, start }) => {
    const r = await start();
    assert.deepEqual(actionLine(r), { type: 'exercise', kind: 'riyaaz', id: 'omkar', cue: 'Keep the Om steady on one breath.' });
    assert.equal(r.lines.filter((l) => l.type === 'action').length, 1);
    assert.equal(client.calls.length, 2);
    const fixMsg = client.calls[1].params.messages[2];
    assert.equal(fixMsg.role, 'user');
    assert.equal(fixMsg.content[0].tool_use_id, 'toolu_bad');
    assert.equal(fixMsg.content[0].is_error, true);
    assert.match(fixMsg.content[0].content, /above the student’s riyaaz stage/);
    assert.match(fixMsg.content[0].content, /hasn't seen or heard this turn/);
    // The browser is told to drop the rejected turn's text before the corrected one streams.
    const kinds = r.lines.map((l) => l.type);
    assert.ok(kinds.indexOf('retry') > kinds.indexOf('text') && kinds.indexOf('retry') < kinds.lastIndexOf('text'));
  });
});

test('extra tool calls in one turn are answered “not run”; a question waits for the student', async () => {
  const two = {
    text: ['Two at once.'],
    stop: 'tool_use',
    content: [
      { type: 'text', text: 'Two at once.' },
      { type: 'tool_use', id: 'toolu_a', name: 'start_exercise', input: { kind: 'riyaaz', id: 'omkar', cue: 'Om' } },
      { type: 'tool_use', id: 'toolu_b', name: 'start_exercise', input: { kind: 'riyaaz', id: 'dum', cue: 'Hold' } },
    ],
  };
  const question = { text: ['How did that feel — any strain?'], stop: 'end_turn' };
  await withServer([two, question, exerciseTurn(undefined, { id: 'toolu_c' })], async ({ client, start, step }) => {
    const r1 = await start();
    const id = r1.lines[0].id;
    assert.equal(actionLine(r1).id, 'omkar');
    const r2 = await step({ id, turn: 1, result: { status: 'done', take: { score: 60 } } });
    assert.equal(doneLine(r2).waiting, 'student');
    const results = client.calls[1].params.messages[2].content.filter((b) => b.type === 'tool_result');
    assert.deepEqual(results.map((b) => b.tool_use_id), ['toolu_a', 'toolu_b']);
    assert.match(results[1].content, /Not run/);

    const noReply = await step({ id, turn: 2 });
    assert.equal(noReply.status, 400);
    assert.match(noReply.json.error, /waiting for your reply/);
    const r3 = await step({ id, turn: 2, message: 'No strain, just a bit breathy.' });
    assert.equal(doneLine(r3).waiting, 'exercise');
    const said = client.calls[2].params.messages[4].content;
    assert.deepEqual(said[0], { type: 'text', text: 'No strain, just a bit breathy.' });
    assert.match(said[1].text, /Lesson clock/);
  });
});

test('a missed reply is replayed for free; stale or unknown steps are refused', async () => {
  await withServer([exerciseTurn(), exerciseTurn(undefined, { id: 'toolu_2', text: ['Again, softer.'] })], async ({ client, start, step }) => {
    const id = (await start()).lines[0].id;
    await step({ id, turn: 1, result: { status: 'done', take: { score: 50 } } });
    assert.equal(client.calls.length, 2);
    const replay = await step({ id, turn: 1, result: { status: 'done', take: { score: 50 } } });
    assert.equal(replay.status, 200);
    assert.equal(client.calls.length, 2, 'no new Claude call');
    assert.equal(replay.lines.find((l) => l.type === 'text').text, 'Again, softer.');
    assert.equal(actionLine(replay).id, 'omkar');
    assert.equal(doneLine(replay).stop, 'replay');
    assert.equal((await step({ id, turn: 0, message: 'hi' })).status, 409);
    assert.equal((await step({ id: 'f'.repeat(32), turn: 1, message: 'hi' })).status, 404);
    const noResult = await step({ id, turn: 2, message: 'skip it' });
    assert.equal(noResult.status, 400);
    assert.match(noResult.json.error, /result of the exercise/);
  });
});

test('lesson endpoints refuse other websites, other hosts and missing credentials', async () => {
  await withServer([exerciseTurn()], async ({ port, client }) => {
    const evil = await post(port, '/api/teacher/lesson/start', { minutes: 15 }, { origin: 'https://evil.example' });
    assert.equal(evil.status, 403);
    const rebind = await post(port, '/api/teacher/lesson/step', { id: 'a'.repeat(32), turn: 1 }, { host: 'attacker.example:80', origin: 'http://attacker.example:80' });
    assert.equal(rebind.status, 403);
    assert.equal(client.calls.length, 0);
  });
  const server = createServer({ env: {} });
  const port = await listen(server);
  try {
    const r = await post(port, '/api/teacher/lesson/start', { minutes: 15 }, {});
    assert.equal(r.status, 503, 'no credentials in this env → not connected');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('a refusal ends the lesson without saving the turn', async () => {
  await withServer([exerciseTurn(), { text: [], stop: 'refusal', content: [] }], async ({ start, step }) => {
    const id = (await start()).lines[0].id;
    const r = await step({ id, turn: 1, result: { status: 'done', take: { score: 70 } } });
    assert.equal(doneLine(r).waiting, 'ended');
    assert.equal(doneLine(r).turn, 1, 'nothing committed');
  });
});

test('the daily cap counts every Claude call in a lesson', async () => {
  await withServer(
    [exerciseTurn(), exerciseTurn(undefined, { id: 'toolu_2' })],
    async ({ start, step }) => {
      const id = (await start()).lines[0].id;
      const r = await step({ id, turn: 1, result: { status: 'done', take: { score: 70 } } });
      assert.equal(r.status, 429);
      assert.match(r.json.error, /limit/);
    },
    { ARIA_TEACHER_DAILY_CAP: '1' },
  );
});

// ------------------------------------------------------------------ the turn runner on its own

test('an aborted or failed turn saves nothing, so the same step can be sent again', async () => {
  const store = createLessonStore();
  const lesson = store.create({ minutes: 10, focus: '', context: CONTEXT });
  const config = teacherConfig({});
  const abortErr = new Anthropic.APIUserAbortError();
  const client = scriptedClient([{ iteratorError: abortErr }]);
  await assert.rejects(runLessonTurn({ client, config, lesson, userMessage: lesson.opening, send: () => {}, allowCall: () => true }), Anthropic.APIUserAbortError);
  assert.equal(lesson.turn, 0);
  assert.deepEqual(lesson.messages, []);
});

test('an unparseable tool input (not an API error) re-issues the turn once and says so', async () => {
  const store = createLessonStore();
  const lesson = store.create({ minutes: 10, focus: '', context: CONTEXT });
  const client = scriptedClient([{ iteratorError: new Error('Unable to parse tool parameter JSON') }, exerciseTurn()]);
  const lines = [];
  const out = await runLessonTurn({ client, config: teacherConfig({}), lesson, userMessage: lesson.opening, send: (l) => lines.push(l), allowCall: () => true });
  assert.equal(out.waiting, 'exercise');
  assert.equal(client.calls.length, 2);
  assert.ok(lines.some((l) => l.type === 'retry'));
  assert.equal(lesson.lastReply.text, 'Namaste! Let’s warm up with Omkar.');
});

test('a step message owes results for every tool call and ends with the clock', () => {
  const lesson = { minutes: 15, pending: { toolUseId: 't1', name: 'start_exercise' }, owed: [{ type: 'tool_result', tool_use_id: 't2', content: 'Not run', is_error: true }] };
  const { message } = stepMessage(lesson, { result: { status: 'failed', note: 'Locked.' }, message: 'Hmm' }, 4);
  assert.deepEqual(message.content.map((b) => b.type), ['tool_result', 'tool_result', 'text', 'text']);
  assert.equal(message.content[0].is_error, true);
  assert.deepEqual(JSON.parse(message.content[0].content[0].text), { status: 'failed', note: 'Locked.' });
  assert.equal(message.content[3].text, '[Lesson clock: 4 of 15 minutes used]');
  assert.match(stepMessage({ ...lesson, pending: { toolUseId: 'f', name: 'finish_lesson' } }, { result: null, message: '' }, 1).error, /follow-up/);
});

test('lessons under way are never evicted; finished or abandoned ones make room; idle ones expire', () => {
  let t = 0;
  const store = createLessonStore({ ttlMs: 10_000, abandonedMs: 1000, max: 2, now: () => t });
  const a = store.create({ minutes: 10, focus: '', context: null, key: 'key-aaaaaaaa' });
  const b = store.create({ minutes: 10, focus: '', context: null });
  assert.equal(store.create({ minutes: 10, focus: '', context: null }), null, 'full of active lessons: refuse');
  b.finished = true;
  const c = store.create({ minutes: 10, focus: '', context: null });
  assert.equal(store.get(b.id), null, 'the finished lesson made room');
  assert.ok(store.get(a.id) && store.get(c.id));
  assert.equal(store.byKey('key-aaaaaaaa'), a);
  t = 5000;
  c.lastAt = 4900;
  store.create({ minutes: 10, focus: '', context: null });
  assert.equal(store.get(a.id), null, 'abandoned for longer than abandonedMs');
  assert.equal(store.byKey('key-aaaaaaaa'), null);
  t = 100_000;
  assert.equal(store.get(c.id), null, 'expired');
  assert.equal(store.size, 0);
});

test('a retried start with the same key finds its lesson instead of opening another', async () => {
  await withServer([exerciseTurn()], async ({ client, start }) => {
    const key = 'b1946ac9-2d5f-4f6e-8c1a-0123456789ab';
    const first = await start({ key });
    const again = await start({ key });
    assert.equal(again.status, 200);
    assert.equal(again.lines[0].type, 'lesson');
    assert.equal(again.lines[0].id, first.lines[0].id);
    assert.equal(client.calls.length, 1, 'the opening is replayed, not re-asked');
    assert.equal(actionLine(again).id, 'omkar');
    assert.equal(doneLine(again).stop, 'replay');
  });
});

test('at the daily cap a missed reply can still be replayed, but nothing new reaches Claude', async () => {
  await withServer(
    [exerciseTurn()],
    async ({ client, start, step }) => {
      const id = (await start()).lines[0].id;
      const replay = await step({ id, turn: 0, message: 'hi' });
      assert.equal(replay.status, 200);
      assert.equal(doneLine(replay).stop, 'replay');
      const more = await step({ id, turn: 1, result: { status: 'done', take: { score: 70 } } });
      assert.equal(more.status, 429);
      assert.equal(client.calls.length, 1);
    },
    { ARIA_TEACHER_DAILY_CAP: '1' },
  );
});

test('the clock uses the minutes the browser saw the student in the lesson', async () => {
  await withServer([exerciseTurn(), exerciseTurn(undefined, { id: 'toolu_2' })], async ({ client, start, step }) => {
    const id = (await start()).lines[0].id;
    await step({ id, turn: 1, usedMin: 7, result: { status: 'done', take: { score: 70 } } });
    const blocks = client.calls[1].params.messages[2].content;
    assert.equal(blocks[blocks.length - 1].text, '[Lesson clock: 7 of 15 minutes used]');
  });
});

test('a stream retry is a Claude call too: it is refused once the caps are reached', async () => {
  const store = createLessonStore();
  const lesson = store.create({ minutes: 10, focus: '', context: CONTEXT });
  const client = scriptedClient([{ iteratorError: new Error('Unable to parse tool parameter JSON') }, exerciseTurn()]);
  let allowed = 1;
  await assert.rejects(
    runLessonTurn({ client, config: teacherConfig({}), lesson, userMessage: lesson.opening, send: () => {}, allowCall: () => allowed-- > 0 }),
    /Unable to parse/,
  );
  assert.equal(client.calls.length, 1);
  assert.equal(lesson.turn, 0);
});

test('pictures stop once a lesson has used its picture budget', () => {
  const big = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(IMAGE_BUDGET) } }] }] };
  assert.equal(imageCharsIn([big]), IMAGE_BUDGET);
  const lesson = { minutes: 15, messages: [big], pending: { toolUseId: 't1', name: 'start_exercise' }, owed: [] };
  const { message } = stepMessage(lesson, { result: { status: 'done', take: { score: 80 }, image: PNG } }, 3);
  const result = message.content[0];
  assert.equal(result.content.length, 1, 'text only');
  assert.match(JSON.parse(result.content[0].text).note, /picture budget/);
  const roomy = stepMessage({ ...lesson, messages: [] }, { result: { status: 'done', take: { score: 80 }, image: PNG } }, 3).message;
  assert.equal(roomy.content[0].content[1].type, 'image');
});

// ------------------------------------------------------------------ browser side

test('the teacher gets a note-by-note take, in sargam when there is a Sa', () => {
  const p = { title: '🕉️ Omkar', riyaaz: { id: 'omkar' }, sa: 50 };
  const result = {
    score: 72, stars: 1, accuracy: 70, notesHit: 1, notesTotal: 2, meanSignedCents: -8, stability: 80, timing: 90, longestHold: 4.2, scoops: 1, vibratoNotes: 0,
    perNote: [
      { midi: 50, hit: true, voicedFrac: 0.9, meanErr: -11.6, scoop: true },
      { midi: 57, hit: false, voicedFrac: 0.1, meanErr: 0 },
    ],
  };
  const t = takeForLesson(p, result, { seconds: 31.4 });
  assert.equal(t.kind, 'riyaaz');
  assert.equal(t.durationSec, 31);
  assert.equal(t.sa, 'D3');
  assert.deepEqual(t.noteByNote, [
    { note: 'Sa (D3)', hit: true, avgCents: -12, scoop: true },
    { note: 'Pa (A3)', hit: false, avgCents: null },
  ]);
});

test('lesson context lists unlocked lessons and recaps of recent lessons', () => {
  const state = {
    voice: null,
    riyaaz: { sa: null, stage: 1, days: {}, ema: {}, best: { dum: 0 }, reach: {}, log: [] },
    teacher: { takes: [], lessons: [{ at: Date.now() - 86400000, minutes: 15, usedMin: 14, focus: 'breath', recap: 'Longer Sa.', homework: [], takes: [{ title: 'Omkar', score: 60 }, { title: 'Dum', score: 80 }] }] },
    styles: {},
  };
  const ctx = buildTeacherContext(state, { unlockedLessons: ['sustain', 'match'] });
  assert.deepEqual(ctx.lessons.unlocked, ['sustain', 'match']);
  assert.deepEqual(ctx.recentLessons, [{ daysAgo: 1, minutes: 14, focus: 'breath', takes: 2, averageScore: 70, recap: 'Longer Sa.' }]);
  assert.equal(buildTeacherContext({ ...state, teacher: { takes: [] } }).recentLessons, undefined);
});
