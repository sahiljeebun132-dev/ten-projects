// Then & now — server side. The student plays an old take and a recent one of the same exercise
// in the app; the app sends both takes' numbers and pitch pictures (never the audio), and Claude,
// as the teacher, says what has changed between them.
import { TEACHER_PERSONA, VOICE_HEALTH } from './teacher-chat.js';
import { isPngBase64 } from './teacher-lesson.js';

const LIMITS = { exercise: 120, take: 6000, context: 16000, days: 3650 };

export const COMPARE_SYSTEM = `${TEACHER_PERSONA}

Then and now
Right now the student is comparing two recordings of the same exercise in the app: an older take ("then") and a recent one ("now"). They can play both and hear the difference for themselves; you can't hear either. For each take you get its numbers — score, percentage in tune, average cents sharp or flat, steadiness, timing, longest steady note, scoops, a note-by-note list and, for newer takes, a tone colour reading — and usually a picture of the pitch line drawn over the target notes: purple bars are notes to sing, dashed cyan bars are notes to listen to, and the voice line is green where it was in tune, amber where it was close and red where it was off.
Tell them what has changed, the way a teacher would after hearing both. Start with the clearest improvement and point at where it shows — which notes, the starts of notes, the long notes, the fast passages — then name the one thing that hasn't moved yet and what to practise for it. Use the pictures for what the numbers hide: sliding up into notes, drifting flat as a long note goes on, wobble, smeared runs. The two takes may be in a different key or Sa if the student re-tested their range; compare how well each was sung, not the notes themselves. When both takes have a fair tone reading, say whether the sound itself has changed (clearer, less airy, more ring, less squeezed); one take often has no tone reading because it predates the feature. If the newer take is worse, say so kindly and suggest a likely reason (a tired voice, a rushed take, a harder day) rather than pretending it's better.
Keep it under 120 words, spoken and plain, with no headings, lists or markdown. Don't write [[...]] tags.

${VOICE_HEALTH}`;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Validate a compare body. Returns { exercise, daysApart, then, now, context } or { error }. */
export function validateCompare(body) {
  if (!isObj(body)) return { error: 'Send a JSON object.' };
  const exercise = typeof body.exercise === 'string' ? body.exercise.trim() : '';
  if (!exercise || exercise.length > LIMITS.exercise) return { error: `Name the exercise in 1–${LIMITS.exercise} characters.` };
  const daysApart = Number(body.daysApart);
  if (!Number.isFinite(daysApart) || daysApart < 0 || daysApart > LIMITS.days) return { error: `daysApart must be a number from 0 to ${LIMITS.days}.` };
  const sides = {};
  for (const side of ['then', 'now']) {
    const s = body[side];
    if (!isObj(s) || !isObj(s.take)) return { error: `Send the ${side} take.` };
    if (JSON.stringify(s.take).length > LIMITS.take) return { error: `The ${side} take is too large.` };
    if (s.image != null && !isPngBase64(s.image)) return { error: `The ${side} picture must be a PNG under 150 KB.` };
    sides[side] = { take: s.take, image: s.image ?? null };
  }
  const context = body.context ?? null;
  if (context !== null && !isObj(context)) return { error: 'Context must be an object.' };
  if (context && JSON.stringify(context).length > LIMITS.context) return { error: 'Practice data is too large.' };
  return { exercise, daysApart: Math.round(daysApart), then: sides.then, now: sides.now, context };
}

/** The one student turn: practice data, then each take's numbers followed by its picture. */
export function compareMessages({ exercise, daysApart, then, now, context }) {
  const content = [];
  if (context) content.push({ type: 'text', text: `<practice_data>\n${JSON.stringify(context)}\n</practice_data>` });
  content.push({ type: 'text', text: `<comparison>\n${JSON.stringify({ exercise, daysApart })}\n</comparison>` });
  for (const [label, s] of [
    ['then', then],
    ['now', now],
  ]) {
    content.push({ type: 'text', text: `<${label}_take>\n${JSON.stringify(s.take)}\n</${label}_take>` });
    if (s.image) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: s.image } });
  }
  content.push({ type: 'text', text: 'I’ve just listened to both takes. What has changed?' });
  return [{ role: 'user', content }];
}
