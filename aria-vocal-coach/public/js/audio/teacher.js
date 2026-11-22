// The AI vocal teacher's reasoning: remember every take, spot patterns across takes the way a
// real teacher does, assign the right exercise, and talk to the student after each take.
// Pure — the app stores the condensed takes; tests drive it directly.

import { trustTone } from './tone.js';

const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

/** What the teacher remembers about one take. */
export function condense(result, meta = {}) {
  return {
    at: meta.at ?? Date.now(),
    id: meta.id ?? null,
    kind: meta.kind ?? 'exercise', // 'lesson' | 'riyaaz' | 'song' | 'style' | 'exercise'
    title: meta.title ?? '',
    focus: result.focus,
    score: result.score,
    accuracy: result.accuracy,
    coverage: result.coverage,
    stability: result.stability,
    timing: result.timing,
    hitRate: result.hitRate,
    cents: result.meanSignedCents,
    scoops: result.scoops,
    notes: result.notesTotal,
    hold: result.longestHold ?? 0,
    // The longest note the exercise asked for — breath is only judged where it allowed a long hold.
    maxNote: Math.round(Math.max(0, ...(result.perNote || []).map((n) => n.dur)) * 10) / 10,
    style: meta.styleMatch ?? null,
    // Tone colour, only from a fair reading (null otherwise).
    clarity: trustTone(result.tone) ? result.tone.clarity : null,
    ring: trustTone(result.tone) ? result.tone.ring : null,
    pressed: trustTone(result.tone) ? result.tone.pressed : null,
  };
}

const ASSIGN = {
  flat: [
    { kind: 'riyaaz', id: 'sa-pa-sa', label: 'Sa–Pa–Sa sadhana with the tanpura' },
    { kind: 'riyaaz', id: 'swar', label: 'Swar pehchaan (ear training)' },
  ],
  sharp: [
    { kind: 'riyaaz', id: 'sa-pa-sa', label: 'Sa–Pa–Sa sadhana with the tanpura' },
    { kind: 'lesson', id: 'match', label: 'Match the note' },
  ],
  pitch: [
    { kind: 'riyaaz', id: 'swar', label: 'Swar pehchaan (ear training)' },
    { kind: 'lesson', id: 'steps', label: 'Do-Re-Mi steps' },
  ],
  unsteady: [
    { kind: 'riyaaz', id: 'omkar', label: 'Omkar — long, calm notes' },
    { kind: 'lesson', id: 'sustain', label: 'Breath & sustain' },
  ],
  scoops: [
    { kind: 'riyaaz', id: 'alankar-1', label: 'Alankar SRG · RGM — land each note' },
    { kind: 'lesson', id: 'thirds', label: 'Hopping thirds' },
  ],
  timing: [{ kind: 'lesson', id: 'steps', label: 'Do-Re-Mi steps — come in on the beat' }],
  breath: [
    { kind: 'riyaaz', id: 'omkar', label: 'Omkar — breath control' },
    { kind: 'riyaaz', id: 'dum', label: 'Dum test — track your breath' },
  ],
  agility: [
    { kind: 'riyaaz', id: 'taan', label: 'Taan — fast runs' },
    { kind: 'lesson', id: 'agility', label: 'Agility runs' },
  ],
  breathy: [
    { kind: 'riyaaz', id: 'omkar', label: 'Omkar — hum the M until your lips buzz' },
    { kind: 'lesson', id: 'sustain', label: 'Breath & sustain — a clean, steady tone' },
  ],
  pressed: [
    { kind: 'lesson', id: 'sirens', label: 'Sirens — glide without squeezing' },
    { kind: 'riyaaz', id: 'omkar', label: 'Omkar — a relaxed, easy tone' },
  ],
};

/**
 * Patterns across recent takes, worst first. Needs a few takes before it judges anything —
 * one bad take is a bad take, three is a habit.
 */
export function diagnose(takes) {
  const t = takes.filter((x) => x.coverage > 25).slice(-12);
  if (t.length < 2) return { enough: false, issues: [], strengths: [], takes: t.length };
  const issues = [];
  const add = (key, severity, title, why) => severity > 0 && issues.push({ key, severity: Math.min(1, severity), title, why, assign: ASSIGN[key] });

  const cents = avg(t.map((x) => x.cents));
  if (cents < -12) add('flat', -cents / 40, 'You sing a little flat', `Over your last ${t.length} takes you sit about ${Math.round(-cents)}¢ under the note. That usually means the breath stops supporting the tone — or the note wasn’t clear in your head before you sang it.`);
  if (cents > 12) add('sharp', cents / 40, 'You push sharp', `You average ${Math.round(cents)}¢ above the note. Sharpness comes from tension and pushing; sing a little softer and let the note settle.`);

  const acc = avg(t.map((x) => x.accuracy));
  if (acc < 60 && Math.abs(cents) <= 12) add('pitch', (60 - acc) / 60, 'Notes miss on both sides', `Only ${Math.round(acc)}% of your singing lands inside the target. Your errors go both high and low, which is an ear–voice link problem — very trainable.`);

  const steady = t.filter((x) => x.stability > 0);
  const stab = avg(steady.map((x) => x.stability));
  if (steady.length >= 2 && stab < 65) add('unsteady', (65 - stab) / 65, 'Held notes wobble', `Your steadiness averages ${Math.round(stab)}/100. Wobbly long notes come from uneven breath — the fix is slow, calm sustain work.`);

  const notes = t.reduce((s, x) => s + (x.notes || 0), 0);
  const scoops = t.reduce((s, x) => s + (x.scoops || 0), 0);
  if (notes >= 10 && scoops / notes > 0.2) add('scoops', (scoops / notes - 0.2) * 3, 'You scoop into notes', `About ${Math.round((scoops / notes) * 100)}% of your notes start low and slide up. A little is style; this much sounds unsure. Aim for the centre of each note from the first moment.`);

  const timed = t.filter((x) => x.timing > 0);
  const tim = avg(timed.map((x) => x.timing));
  if (timed.length >= 2 && tim < 60) add('timing', (60 - tim) / 60, 'You come in late', `Your timing averages ${Math.round(tim)}/100 — notes start after the beat. Breathe before the note, not on it.`);

  const holds = t.filter((x) => x.focus === 'stability' && x.hold > 0 && (x.maxNote ?? 0) >= 8);
  const hold = holds.length ? Math.max(...holds.map((x) => x.hold)) : null;
  if (hold != null && hold < 5) add('breath', (5 - hold) / 5, 'Short breath (dum)', `Your longest steady note is ${hold.toFixed(1)} s. Singers need 8–15 s. Breath grows quickly with daily Omkar.`);

  const agile = t.filter((x) => x.focus === 'agility');
  const ag = avg(agile.map((x) => x.hitRate));
  if (agile.length && ag < 60) add('agility', (60 - ag) / 60, 'Fast passages blur', `In quick runs you hit ${Math.round(ag)}% of the notes. Keep the voice lighter and slower until every note is clear.`);

  const toned = t.filter((x) => Number.isFinite(x.clarity));
  const clar = avg(toned.map((x) => x.clarity));
  const pressedShare = toned.length ? toned.filter((x) => x.pressed).length / toned.length : 0;
  if (toned.length >= 3 && pressedShare >= 0.5) add('pressed', 0.4 + pressedShare / 2, 'Pressed tone', `In ${Math.round(pressedShare * 100)}% of your recent takes your tone sounded squeezed: the first harmonic is weak against the second, a sign of a tight throat. Sing with less effort and let more air flow.`);
  else if (toned.length >= 3 && clar < 45) add('breathy', (45 - clar) / 45, 'Breathy tone', `Your tone clarity averages ${Math.round(clar)}/100 over ${toned.length} takes: more air than sound gets into your voice. Buzzy humming teaches the folds to close cleanly.`);

  const strengths = [];
  if (toned.length >= 3 && clar >= 75 && pressedShare < 0.5) strengths.push(`Your tone is clear (${Math.round(clar)}/100) — very little air in the sound.`);
  if (acc >= 80) strengths.push(`Your sur is strong — ${Math.round(acc)}% of your singing is in tune.`);
  if (steady.length >= 2 && stab >= 80) strengths.push(`Your held notes are steady (${Math.round(stab)}/100).`);
  if (Math.abs(cents) <= 6 && acc >= 60) strengths.push('You sit right in the centre of the notes — not flat, not sharp.');
  if (hold != null && hold >= 10) strengths.push(`Great breath — you held a note for ${hold.toFixed(1)} s.`);
  if (timed.length >= 2 && tim >= 85) strengths.push('Your timing is sharp.');

  issues.sort((a, b) => b.severity - a.severity);
  return { enough: true, issues, strengths, takes: t.length };
}

function trend(takes) {
  const t = takes.filter((x) => x.coverage > 25);
  if (t.length < 6) return null;
  const old = avg(t.slice(-12, -6).map((x) => x.accuracy));
  const now = avg(t.slice(-6).map((x) => x.accuracy));
  return Math.round(now - old);
}

/** Today's lesson plan from the teacher. */
export function lessonPlan(takes, { name = '' } = {}) {
  const d = diagnose(takes);
  const hour = new Date().getHours();
  const hello = `${hour < 12 ? 'Good morning' : hour < 18 ? 'Namaste' : 'Good evening'}${name ? `, ${name}` : ''}!`;
  if (!d.enough) {
    return {
      hello,
      intro: 'Sing a few takes — a lesson, a riyaaz exercise or a song — and I’ll listen for patterns. After three takes I’ll know what to work on with you.',
      focus: [],
      strengths: [],
      diagnosis: d,
    };
  }
  const tr = trend(takes);
  const intro =
    d.issues.length === 0
      ? 'I’ve been listening — honestly, your fundamentals are in good shape. Let’s keep polishing and build style.'
      : `I’ve listened to your last ${d.takes} takes. ${tr != null && tr > 2 ? `Your accuracy is up ${tr} points — the work is paying off. ` : tr != null && tr < -2 ? 'You’ve dipped a little lately — normal, voices have off days. ' : ''}Here’s what we work on today.`;
  return { hello, intro, focus: d.issues.slice(0, 2), strengths: d.strengths.slice(0, 2), diagnosis: d };
}

const PRAISE = {
  accuracy: (r) => `${r.accuracy}% of that was in tune — good ear.`,
  stability: (r) => `Your held notes were steady (${r.stability}/100) — that’s real control.`,
  timing: (r) => `You came in right on time.`,
  hold: (r) => `You held one note for ${r.longestHold} s — good dum.`,
  hits: (r) => `You hit ${r.notesHit} of ${r.notesTotal} notes.`,
};

/** What the teacher says right after a take: one praise, one fix, one next step. */
export function teacherNote(result, prevTakes = [], meta = {}) {
  const lines = [];
  const same = prevTakes.filter((x) => x.id && x.id === meta.id);
  const last = same[same.length - 1];

  if (result.coverage < 20) {
    return {
      mood: 'listen',
      lines: ['I could barely hear you on that one. Sing out a little more — and if you’re using a mic, check it’s picking you up.', 'Try again; I’m listening.'],
    };
  }

  // Praise the strongest thing first.
  const cands = [
    ['accuracy', result.accuracy >= 70 ? result.accuracy : 0],
    ['stability', result.stability >= 70 ? result.stability : 0],
    ['timing', result.timing >= 85 ? result.timing - 10 : 0],
    ['hold', result.longestHold >= 8 ? 70 + result.longestHold : 0],
    ['hits', result.notesTotal >= 4 && result.notesHit / result.notesTotal >= 0.7 ? 65 : 0],
  ].sort((a, b) => b[1] - a[1]);
  if (cands[0][1] > 0) lines.push(`${result.score >= 75 ? 'Bahut badhiya! ' : 'Achha. '}${PRAISE[cands[0][0]](result)}`);
  else lines.push('Thank you — every take teaches me more about your voice.');

  if (last) {
    const delta = result.score - last.score;
    if (delta >= 5) lines.push(`That’s ${delta} points better than your last try at this. 📈`);
    else if (delta <= -8) lines.push(`A bit below your last try (${last.score}). Tired voices drift — take a sip of water and a breath.`);
  }

  // One fix — the most important one.
  let fix = null;
  if (Math.abs(result.meanSignedCents) > 15) {
    fix = result.meanSignedCents < 0
      ? `You sat ${Math.abs(result.meanSignedCents)}¢ flat. Keep the breath flowing all the way to the end of each note, and think the note slightly higher.`
      : `You were ${result.meanSignedCents}¢ sharp. Relax the throat and sing a touch softer — pushing drives the pitch up.`;
  } else if (result.scoops >= 2 && result.notesTotal && result.scoops / result.notesTotal > 0.2) {
    fix = `You scooped into ${result.scoops} notes. Hear each note in your head first, then start exactly on it.`;
  } else if (result.stability && result.stability < 60) {
    fix = 'Your long notes wavered. Breathe low and let the air out slowly and evenly — like blowing through a straw.';
  } else if (result.timing && result.timing < 60) {
    fix = 'You came in late on several notes. Take your breath before the note arrives, not when it starts.';
  } else if (result.accuracy < 60) {
    fix = 'Several notes missed. Slow down: listen to each target, hum it, then sing it.';
  } else if (trustTone(result.tone) && result.tone.pressed) {
    fix = 'Your tone sounded squeezed. Drop the shoulders, loosen the jaw and let more air flow.';
  } else if (trustTone(result.tone) && result.tone.breathy) {
    fix = 'Your tone was breathy. Hum “mm” until your lips buzz, then open to “ah” and keep the buzz.';
  }
  if (fix) lines.push(fix);

  // One next step.
  if (meta.next) lines.push(meta.next);
  else if (result.stars >= 2) lines.push('Ready for the next step whenever you are.');
  else if (result.stars === 1) lines.push('Passed. One more go for a cleaner take? Repetition is riyaaz.');
  else lines.push('Let’s do it again — slower in your mind, steady in your breath.');

  return { mood: result.score >= 75 ? 'happy' : result.score >= 50 ? 'ok' : 'encourage', lines };
}
