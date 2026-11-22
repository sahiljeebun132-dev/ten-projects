// Teacher-led lessons — server side. Claude runs a live lesson through two tools that the
// browser carries out: start_exercise puts an exercise on the student's screen (the app runs it
// with the microphone and sends back the scored take plus a picture of the pitch line), and
// finish_lesson closes the lesson with a recap and homework.
//
// The lesson transcript lives here, in memory, never in the browser. Each step from the browser
// only adds the student's side (a take result or what they said), so the page can't rewrite what
// the teacher said, and Claude's thinking blocks go back to the API exactly as they came — the
// history is append-only, as preserved thinking requires.
import { randomBytes } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { TEACHER_PERSONA, RIYAAZ_CATALOGUE, VOICE_HEALTH, DRILL_IDS } from './teacher-chat.js';
import { EXERCISES } from './public/js/data/riyaaz.js';
import { ALL_LESSONS } from './public/js/data/curriculum.js';

export const LESSON_MINUTES = [10, 15, 20];
const KINDS = ['riyaaz', 'lesson', 'drill'];
const STATUSES = ['done', 'skipped', 'failed'];
const LIMITS = { focus: 200, message: 2000, context: 16000, take: 8000, image: 200_000, note: 300, cue: 300, recap: 1500 };
export const MAX_TURNS = 40; // Claude calls per lesson; a 20-minute lesson needs about 12–20
const MAX_FIXES = 2; // times Claude may be told an exercise can't run before the app gives up
const LESSON_TTL_MS = 3 * 60 * 60_000;
const ABANDONED_MS = 30 * 60_000; // idle this long, a lesson may make room for a new one
const MAX_LESSONS = 12;
// Pictures stay in the transcript (it only grows), so each lesson gets a budget of base64 characters;
// past it, takes go to Claude without a picture. 12 lessons x 3 MB bounds the server's memory.
export const IMAGE_BUDGET = 3_000_000;
const ONE_AT_A_TIME = 'Not run: the app runs one exercise at a time. Ask for it again in your next turn if you still want it.';

const RUNNABLE_LESSONS = ALL_LESSONS.filter((l) => l.kind !== 'range');

export const LESSON_SYSTEM = `${TEACHER_PERSONA}

Teaching a live lesson
Right now you are teaching a live lesson. The student asked for one of a set length and is at their screen with the app open and the microphone ready. You lead, the way a guru leads a class: warm the voice up, work on the one or two things the practice data says matter most, and finish on something they can do well. The practice data at the start describes the student before today; the takes they sing today come back to you as tool results.

You teach through two tools. start_exercise puts one exercise on the student's screen; the app plays the guide notes, listens while they sing, and returns the scored take — score, percentage in tune, average cents sharp or flat, steadiness, timing, longest steady note, scoops and a note-by-note list — usually with a picture of their pitch line drawn over the target notes. Look at the picture for what the numbers hide: whether the voice slides up into notes, drifts flat as a long note goes on, wobbles, or smears a run. finish_lesson ends the lesson with a short recap and up to three exercises to practise before next time.

How the lesson goes
Open with one or two sentences — hello, what today's lesson will work on and why — then call start_exercise for a gentle warm-up such as omkar or sa-pa-sa. After every take, react to what actually happened in one to three short spoken sentences: something that went well, the one thing to change, and how to change it physically (breath, posture, jaw, listening to the tanpura, slowing down). Then choose the next step yourself and call start_exercise again in the same turn: repeat the exercise with that one change when the take shows something fixable, step back to something easier when they're struggling, or move on once they have it. The cue you pass is shown and read to the student right before they sing, so make it the single thing to focus on in that take.
Choose only exercises from the catalogue below that this student can do: riyaaz exercises listed in the practice data's riyaaz.unlockedExercises, and only when a Sa is set; lessons listed in lessons.unlocked; drills only with a style_id from learnedSingerStyles. If the app reports that an exercise couldn't run or was skipped, pick a different one.
Every student turn ends with a lesson clock. A take with your feedback takes one to two minutes, so a fifteen-minute lesson has room for about six to ten takes. When the time is nearly used, when scores fall across several takes, or when the student is tired or wants to stop, call finish_lesson instead of another exercise.
When the student says something, it appears as text after the take. Answer it briefly and carry on. If you need their answer before going on, end your turn without calling a tool and the app will wait for them.
In a lesson the tools replace the [[...]] button tags, so don't write tags. Don't mention the clock, the tools or how the app works; just teach.

Exercise catalogue
Riyaaz exercises (kind riyaaz), which use the student's Sa and tanpura:
${RIYAAZ_CATALOGUE}
Lessons (kind lesson), fitted to the student's range:
${RUNNABLE_LESSONS.map((l) => `- ${l.id}: ${l.title} — ${l.subtitle}`).join('\n')}
Drills (kind drill) built from a learned singer style, with that style's id as style_id: ${DRILL_IDS.join(', ')}.

${VOICE_HEALTH}`;

const REF_SCHEMA = {
  kind: { type: 'string', enum: KINDS, description: 'riyaaz, lesson or drill.' },
  id: { type: 'string', description: 'The riyaaz exercise id, lesson id or drill id from the catalogue.' },
  style_id: { type: 'string', description: 'Drills only: the id of a learned style from learnedSingerStyles in the practice data.' },
};

// Streamed requests define these tools, so their inputs stream eagerly; checkAction() validates
// every input before the app acts on it (the API doesn't, in eager mode).
export const LESSON_TOOLS = [
  {
    name: 'start_exercise',
    description:
      'Put one exercise on the student’s screen and wait while they sing it. Returns the scored take as JSON — or a skipped/failed status — usually with a PNG of their pitch line over the target notes. Call it once per turn.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: {
        ...REF_SCHEMA,
        cue: { type: 'string', description: 'The single thing to focus on in this take, shown and read to the student just before they sing. One short sentence.' },
      },
      required: ['kind', 'id', 'cue'],
      additionalProperties: false,
    },
  },
  {
    name: 'finish_lesson',
    description:
      'End the lesson: the app shows the student your recap and up to three exercises to practise before the next lesson. Call it when the planned time is nearly used, the voice is tired, or the student wants to stop.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: {
        recap: { type: 'string', description: 'Two to four short sentences: what you worked on, what improved (with numbers when you have them), and what to keep working on.' },
        homework: {
          type: 'array',
          maxItems: 3,
          description: 'Up to three exercises to practise before the next lesson.',
          items: { type: 'object', properties: REF_SCHEMA, required: ['kind', 'id'], additionalProperties: false },
        },
      },
      required: ['recap'],
      additionalProperties: false,
    },
  },
];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const short = (v) => String(v).slice(0, 40);

/** Validate a lesson-start body. Returns { minutes, focus, context } or { error }. */
export function validateLessonStart(body) {
  if (!isObj(body)) return { error: 'Send a JSON object.' };
  const minutes = Number(body.minutes);
  if (!LESSON_MINUTES.includes(minutes)) return { error: 'Pick a 10, 15 or 20-minute lesson.' };
  const focus = body.focus ?? '';
  if (typeof focus !== 'string' || focus.length > LIMITS.focus) return { error: `Keep what you want to work on under ${LIMITS.focus} characters.` };
  const context = body.context ?? null;
  if (context !== null && !isObj(context)) return { error: 'Context must be an object.' };
  if (context && JSON.stringify(context).length > LIMITS.context) return { error: 'Practice data is too large.' };
  const key = body.key ?? null;
  if (key !== null && (typeof key !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(key))) return { error: 'The lesson key must be 8–64 letters, digits or dashes.' };
  return { minutes, focus: focus.trim(), context, key };
}

/** A base64 PNG of a sensible size (the pitch picture). */
export function isPngBase64(s) {
  return typeof s === 'string' && s.length <= LIMITS.image && s.length % 4 === 0 && s.startsWith('iVBORw0KGgo') && /^[A-Za-z0-9+/]+={0,2}$/.test(s);
}

/** Validate a lesson-step body. Returns { id, turn, result, message } or { error }. */
export function validateLessonStep(body) {
  if (!isObj(body)) return { error: 'Send a JSON object.' };
  if (typeof body.id !== 'string' || !/^[a-f0-9]{32}$/.test(body.id)) return { error: 'Unknown lesson.' };
  if (!Number.isInteger(body.turn) || body.turn < 0) return { error: 'Say which turn you are answering.' };
  if (body.usedMin != null && (!Number.isInteger(body.usedMin) || body.usedMin < 0 || body.usedMin > 600)) return { error: 'usedMin must be whole minutes.' };
  let message = '';
  if (body.message != null) {
    if (typeof body.message !== 'string' || body.message.length > LIMITS.message) return { error: `Keep messages under ${LIMITS.message} characters.` };
    message = body.message.trim();
  }
  let result = null;
  if (body.result != null) {
    const r = body.result;
    if (!isObj(r) || !STATUSES.includes(r.status)) return { error: 'A take result needs a status of done, skipped or failed.' };
    if (r.take != null && (!isObj(r.take) || JSON.stringify(r.take).length > LIMITS.take)) return { error: 'The take summary is too large.' };
    if (r.note != null && (typeof r.note !== 'string' || r.note.length > LIMITS.note)) return { error: `Keep the note under ${LIMITS.note} characters.` };
    if (r.image != null && !isPngBase64(r.image)) return { error: 'The pitch picture must be a PNG under 150 KB.' };
    result = { status: r.status, take: r.take ?? null, note: r.note?.trim() || null, image: r.image ?? null };
  }
  return { id: body.id, turn: body.turn, result, message, usedMin: body.usedMin ?? null };
}

/** Check one exercise reference against the catalogue and what this student has unlocked. */
export function checkRef({ kind, id, styleId }, context) {
  const ctx = isObj(context) ? context : {};
  if (typeof id !== 'string' || !id) return { error: 'id is missing.' };
  if (kind === 'riyaaz') {
    const ex = EXERCISES.find((e) => e.id === id);
    if (!ex) return { error: `There is no riyaaz exercise "${short(id)}". Use an id from the catalogue.` };
    if (ctx.riyaaz?.sa === 'not set') return { error: 'The student has no Sa yet, so riyaaz exercises can’t run. Use a lesson instead.' };
    const unlocked = ctx.riyaaz?.unlockedExercises;
    if (Array.isArray(unlocked) && !unlocked.includes(ex.id)) return { error: `${ex.title} is above the student’s riyaaz stage. Pick an unlocked exercise.` };
    return { ref: { kind, id: ex.id } };
  }
  if (kind === 'lesson') {
    const l = RUNNABLE_LESSONS.find((x) => x.id === id);
    if (!l) return { error: `There is no lesson "${short(id)}" that can run here. Use an id from the catalogue.` };
    const unlocked = ctx.lessons?.unlocked;
    if (Array.isArray(unlocked) && !unlocked.includes(l.id)) return { error: `${l.title} is still locked for this student. Pick one from lessons.unlocked.` };
    return { ref: { kind, id: l.id } };
  }
  if (kind === 'drill') {
    if (!DRILL_IDS.includes(id)) return { error: `There is no drill "${short(id)}". Drills are ${DRILL_IDS.join(', ')}.` };
    const styles = Array.isArray(ctx.learnedSingerStyles) ? ctx.learnedSingerStyles : [];
    const style = styles.find((s) => isObj(s) && s.id === styleId);
    if (!style) return { error: 'Drills need the style_id of a learned style from the practice data.' };
    return { ref: { kind, id, styleId: style.id } };
  }
  return { error: 'kind must be riyaaz, lesson or drill.' };
}

/** Validate a tool call. Returns { action } for the browser, or { error } to send back to Claude. */
export function checkAction(block, context) {
  const input = isObj(block?.input) ? block.input : {};
  if (block?.name === 'start_exercise') {
    const ref = checkRef({ kind: input.kind, id: input.id, styleId: input.style_id }, context);
    if (ref.error) return ref;
    if (typeof input.cue !== 'string' || !input.cue.trim()) return { error: 'cue is missing: give the student one thing to focus on.' };
    if (input.cue.length > LIMITS.cue) return { error: 'Keep the cue to one short sentence.' };
    return { action: { type: 'exercise', ...ref.ref, cue: input.cue.trim() } };
  }
  if (block?.name === 'finish_lesson') {
    if (typeof input.recap !== 'string' || !input.recap.trim()) return { error: 'recap is missing.' };
    if (input.recap.length > LIMITS.recap) return { error: 'Keep the recap to a few sentences.' };
    const homework = (Array.isArray(input.homework) ? input.homework : [])
      .slice(0, 3)
      .map((h) => (isObj(h) ? checkRef({ kind: h.kind, id: h.id, styleId: h.style_id }, context).ref : null))
      .filter(Boolean);
    return { action: { type: 'finish', recap: input.recap.trim(), homework } };
  }
  return { error: `There is no tool called "${short(block?.name)}".` };
}

/**
 * The assistant turn as it must be echoed back. After a mid-output fallback, thinking, tool_use and
 * other model-internal blocks before the last fallback block are left out (text and the fallback
 * blocks themselves stay where they were). Anything else goes back unchanged.
 */
export function echoContent(content) {
  const blocks = JSON.parse(JSON.stringify(Array.isArray(content) ? content : []));
  let boundary = -1;
  blocks.forEach((b, i) => {
    if (b?.type === 'fallback') boundary = i;
  });
  if (boundary < 0) return blocks;
  return blocks.filter((b, i) => i >= boundary || b?.type === 'text' || b?.type === 'fallback');
}

export function clockText(usedMin, plannedMin) {
  return `[Lesson clock: ${usedMin} of ${plannedMin} minutes used]`;
}

/** The first student turn: practice data, the request, and the clock at zero. */
export function openingMessage({ minutes, focus, context }) {
  const content = [];
  if (context) content.push({ type: 'text', text: `<practice_data>\n${JSON.stringify(context)}\n</practice_data>` });
  content.push({ type: 'text', text: `Please teach me a ${minutes}-minute lesson now. ${focus ? `What I'd like to work on: ${focus}` : 'You choose what we work on.'}` });
  content.push({ type: 'text', text: clockText(0, minutes) });
  return { role: 'user', content };
}

/** Base64 picture characters already kept in a transcript. */
export function imageCharsIn(messages) {
  let n = 0;
  for (const m of messages || []) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b?.type !== 'tool_result' || !Array.isArray(b.content)) continue;
      for (const c of b.content) if (c?.type === 'image') n += c.source?.data?.length ?? 0;
    }
  }
  return n;
}

function exerciseResult(toolUseId, r, imageRoom) {
  const data = { status: r.status };
  if (r.take) data.take = r.take;
  const picture = Boolean(r.image) && r.status === 'done' && r.image.length <= imageRoom;
  data.note = r.note || (r.status === 'skipped' ? 'The student skipped this exercise.' : r.status === 'failed' ? 'The exercise could not run.' : undefined);
  if (r.image && r.status === 'done' && !picture) data.note = [data.note, 'No picture this time: the lesson has used its picture budget.'].filter(Boolean).join(' ');
  const blocks = [{ type: 'text', text: JSON.stringify(data) }];
  if (picture) blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: r.image } });
  return { type: 'tool_result', tool_use_id: toolUseId, content: blocks, ...(r.status === 'failed' ? { is_error: true } : {}) };
}

/**
 * The student's next turn: the result for the teacher's pending action, results the app owes for
 * any extra tool calls, what the student said, and the clock. Returns { message } or { error }.
 */
export function stepMessage(lesson, { result, message }, usedMin) {
  const content = [];
  const p = lesson.pending;
  if (p?.name === 'start_exercise') {
    if (!result) return { error: 'Send the result of the exercise your teacher set (done, skipped or failed).' };
    content.push(exerciseResult(p.toolUseId, result, IMAGE_BUDGET - imageCharsIn(lesson.messages)));
  } else if (p?.name === 'finish_lesson') {
    if (!message) return { error: 'The lesson is finished — send a message to ask a follow-up.' };
    content.push({ type: 'tool_result', tool_use_id: p.toolUseId, content: 'The app showed the student your recap and homework.' });
  } else if (!message) {
    return { error: 'Your teacher is waiting for your reply.' };
  }
  content.push(...lesson.owed);
  if (message) content.push({ type: 'text', text: message });
  content.push({ type: 'text', text: clockText(usedMin, lesson.minutes) });
  return { message: { role: 'user', content } };
}

export function lessonRequest(config, messages) {
  return {
    model: config.model,
    max_tokens: config.maxTokens,
    output_config: { effort: config.effort },
    // The system prompt and tools never change during a lesson: the marker caches both, and the
    // top-level marker moves the cache point forward as the lesson grows.
    system: [{ type: 'text', text: LESSON_SYSTEM, cache_control: { type: 'ephemeral' } }],
    tools: LESSON_TOOLS,
    messages,
    cache_control: { type: 'ephemeral' },
    // On a policy decline, the API re-runs the turn on a fallback model in the same stream.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
  };
}

/** One streamed Claude call; text deltas go to `send`. Re-issues once on a non-API failure, if the caps allow. */
async function streamOnce({ client, config, messages, signal, send, onRetry, allowCall }) {
  for (let attempt = 0; ; attempt++) {
    const stream = client.beta.messages.stream(lessonRequest(config, messages), { signal });
    try {
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') send({ type: 'text', text: event.delta.text });
      }
      return await stream.finalMessage();
    } catch (err) {
      // An unparseable eagerly-streamed tool input, or a stream dropped part-way, isn't an API
      // error: re-issue the turn once. API errors (including the user aborting) go up.
      if (err instanceof Anthropic.APIError || signal?.aborted || attempt >= 1 || !allowCall()) throw err;
      onRetry();
      send({ type: 'retry' });
    }
  }
}

function addUsage(total, u = {}) {
  total.input += u.input_tokens ?? 0;
  total.output += u.output_tokens ?? 0;
  total.cacheRead += u.cache_read_input_tokens ?? 0;
  total.cacheWrite += u.cache_creation_input_tokens ?? 0;
}

/**
 * Run the teacher's next turn on top of `userMessage`. Nothing is saved to the lesson unless the
 * turn completes, so an aborted or failed step can simply be sent again.
 * `allowCall()` is asked before every Claude call (daily and per-lesson caps).
 * Resolves to { waiting: 'exercise' | 'finished' | 'student' | 'ended', stop, model, usage }.
 */
export async function runLessonTurn({ client, config, lesson, userMessage, signal, send, allowCall }) {
  let messages = [...lesson.messages, userMessage];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let spoken = '';
  let done = { stop: 'end_turn', model: config.model, usage };
  const say = (line) => {
    if (line.type === 'text') spoken += line.text;
    send(line);
  };
  const commit = (history, { pending = null, owed = [], action = null, waiting }) => {
    lesson.messages = history;
    lesson.pending = pending;
    lesson.owed = owed;
    lesson.turn += 1;
    lesson.finished = waiting === 'finished';
    lesson.lastReply = { text: spoken, action, waiting };
    return { ...done, waiting };
  };

  for (let fix = 0, refusedTurn = null; ; fix++) {
    if (!allowCall()) {
      if (!refusedTurn) throw Object.assign(new Error('That’s the limit for today’s lessons — rest your voice and come back tomorrow.'), { status: 429 });
      // Out of calls while correcting a muddled tool call: keep what was said and owe Claude the errors.
      return commit(messages.slice(0, -1), { owed: refusedTurn, waiting: 'student' });
    }
    const final = await streamOnce({ client, config, messages, signal, send: say, onRetry: () => (spoken = ''), allowCall });
    addUsage(usage, final.usage);
    done = { stop: final.stop_reason, model: final.model, usage };

    // A refusal or a reply cut off at max_tokens can't carry the lesson on safely: end it.
    if (final.stop_reason === 'refusal' || final.stop_reason === 'max_tokens') return { ...done, waiting: 'ended' };

    const assistant = { role: 'assistant', content: echoContent(final.content) };
    const history = [...messages, assistant];
    const uses = assistant.content.filter((b) => b?.type === 'tool_use');
    if (!uses.length) return commit(history, { waiting: 'student' });

    const [first, ...rest] = uses;
    const notRun = rest.map((b) => ({ type: 'tool_result', tool_use_id: b.id, content: ONE_AT_A_TIME, is_error: true }));
    const checked = checkAction(first, lesson.context);
    if (!checked.error) {
      const waiting = checked.action.type === 'finish' ? 'finished' : 'exercise';
      const out = commit(history, { pending: { toolUseId: first.id, name: first.name }, owed: notRun, action: checked.action, waiting });
      send({ type: 'action', action: checked.action });
      return out;
    }
    refusedTurn = [{ type: 'tool_result', tool_use_id: first.id, content: checked.error, is_error: true }, ...notRun];
    // Still muddled after being corrected: keep what was said and let the student move things on.
    if (fix >= MAX_FIXES) return commit(history, { owed: refusedTurn, waiting: 'student' });
    // The browser drops this turn's text, so Claude is asked to say it all again with another exercise.
    spoken = '';
    send({ type: 'retry' });
    const redo = { ...refusedTurn[0], content: `${checked.error} The student hasn't seen or heard this turn, so give your whole reply again with an exercise that can run.` };
    messages = [...history, { role: 'user', content: [redo, ...notRun, { type: 'text', text: clockText(lesson.usedMin(), lesson.minutes) }] }];
  }
}

/**
 * In-memory lessons, keyed by an unguessable id (and by the browser's start key, so a retried start
 * finds its lesson). Idle lessons expire. When full, a finished or long-abandoned lesson makes room;
 * a lesson still under way is never evicted: the new start is refused instead.
 */
export function createLessonStore({ ttlMs = LESSON_TTL_MS, abandonedMs = ABANDONED_MS, max = MAX_LESSONS, now = Date.now } = {}) {
  const lessons = new Map();
  const byKey = new Map();
  const remove = (l) => {
    lessons.delete(l.id);
    if (l.key && byKey.get(l.key) === l) byKey.delete(l.key);
  };
  const sweep = () => {
    const t = now();
    for (const l of [...lessons.values()]) if (!l.busy && t - l.lastAt > ttlMs) remove(l);
  };
  return {
    create({ minutes, focus, context, key = null }) {
      sweep();
      if (lessons.size >= max) {
        const t = now();
        const spare = [...lessons.values()]
          .filter((l) => !l.busy && (l.finished || t - l.lastAt > abandonedMs))
          .sort((a, b) => Number(b.finished) - Number(a.finished) || a.lastAt - b.lastAt)[0];
        if (!spare) return null;
        remove(spare);
      }
      const startedAt = now();
      const lesson = {
        id: randomBytes(16).toString('hex'),
        key,
        startedAt,
        lastAt: startedAt,
        minutes,
        focus,
        context,
        opening: openingMessage({ minutes, focus, context }),
        messages: [],
        pending: null,
        owed: [],
        turn: 0,
        calls: 0,
        busy: false,
        finished: false,
        lastReply: null,
        reportedMin: null, // minutes the browser saw the student in the lesson (time away excluded)
        usedMin: () => lesson.reportedMin ?? Math.round((now() - startedAt) / 60_000),
      };
      lessons.set(lesson.id, lesson);
      if (key) byKey.set(key, lesson);
      return lesson;
    },
    get(id) {
      sweep();
      return lessons.get(id) || null;
    },
    byKey(key) {
      sweep();
      return (key && byKey.get(key)) || null;
    },
    get size() {
      return lessons.size;
    },
  };
}
