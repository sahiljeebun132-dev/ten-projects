// The path from first note to mastery: 5 levels × 4 lessons.
// Each exercise is generated inside the singer's own comfortable range.
import { songById, fitShift, transpose } from './songs.js';

export const DEFAULT_RANGE = { low: 50, high: 69 }; // D3–A4: safe-ish middle until the range test is done

/** Lowest root such that the pattern fits, nudged a little above the floor of the range. */
function rootFor(range, lo, hi) {
  const room = range.high - range.low - (hi - lo);
  return range.low - lo + Math.max(0, Math.round(room * 0.25));
}

function addPhrase(list, phrase, t, role) {
  for (const n of phrase) {
    list.push({ midi: n.midi, glideTo: n.glideTo ?? null, start: t, dur: n.dur * 0.94, role });
    t += n.dur;
  }
  return t;
}

/**
 * Repeat a melodic pattern, moving up by `step` semitones each repetition.
 * mode: 'listen-repeat' (hear it, then sing it back), 'sing-along' (sing with the guide),
 *       'solo' (hear only the first note, then sing from memory)
 */
export function buildPattern({ range, offsets, beats, bpm, reps = 3, step = 2, mode = 'listen-repeat' }) {
  const b = 60 / bpm;
  const lo = Math.min(...offsets);
  const hi = Math.max(...offsets);
  const base = rootFor(range, lo, hi);
  const targets = [];
  let t = 0;
  for (let r = 0; r < reps; r++) {
    const root = base + r * step;
    if (r > 0 && root + hi > range.high + 1) break;
    const phrase = offsets.map((o, i) => ({ midi: root + o, dur: (beats?.[i] ?? (i === offsets.length - 1 ? 2 : 1)) * b }));
    if (mode === 'listen-repeat') {
      t = addPhrase(targets, phrase, t, 'listen');
      t += b;
      t = addPhrase(targets, phrase, t, 'sing');
    } else if (mode === 'solo') {
      t = addPhrase(targets, [{ midi: phrase[0].midi, dur: b }], t, 'listen');
      t += b;
      t = addPhrase(targets, phrase, t, 'sing');
    } else {
      t = addPhrase(targets, phrase, t, 'sing');
    }
    t += 2 * b;
  }
  return targets;
}

/** Long held notes (sustain / dynamics / vibrato drills). */
function buildHolds(range, { hold = 4, reps = 3, step = 2 } = {}) {
  const base = rootFor(range, 0, (reps - 1) * step + 2);
  const targets = [];
  let t = 0;
  for (let r = 0; r < reps; r++) {
    const midi = base + r * step;
    t = addPhrase(targets, [{ midi, dur: 1.4 }], t, 'listen');
    t += 0.5;
    t = addPhrase(targets, [{ midi, dur: hold }], t, 'sing');
    t += 1.6;
  }
  return targets;
}

/** Single-note pitch matching spread across the range. */
function buildMatch(range) {
  const span = range.high - range.low;
  const picks = [0.3, 0.55, 0.42, 0.72, 0.2].map((p) => Math.round(range.low + 1 + p * (span - 2)));
  const targets = [];
  let t = 0;
  for (const midi of picks) {
    t = addPhrase(targets, [{ midi, dur: 1.2 }], t, 'listen');
    t += 0.45;
    t = addPhrase(targets, [{ midi, dur: 1.9 }], t, 'sing');
    t += 1.1;
  }
  return targets;
}

/** Sirens: smooth glides up a fifth and back. */
function buildSirens(range) {
  const base = rootFor(range, 0, 9);
  const targets = [];
  let t = 0;
  for (const root of [base, base + 2]) {
    const phrase = [
      { midi: root, glideTo: root + 7, dur: 1.6 },
      { midi: root + 7, glideTo: root, dur: 1.6 },
    ];
    t = addPhrase(targets, phrase, t, 'listen');
    t += 0.6;
    t = addPhrase(targets, phrase, t, 'sing');
    t += 1.4;
  }
  return targets;
}

export function buildSong(songId, range) {
  const song = songById(songId);
  return transpose(song.notes, fitShift(song.notes, range)).map((n) => ({ ...n, role: 'sing' }));
}

export function buildWarmup(range) {
  const parts = [
    buildHolds(range, { hold: 3, reps: 1 }),
    buildSirens(range).slice(0, 4),
    buildPattern({ range, offsets: [0, 2, 4, 5, 7, 5, 4, 2, 0], bpm: 88, reps: 2, mode: 'listen-repeat' }),
  ];
  const out = [];
  let offset = 0;
  for (const p of parts) {
    for (const n of p) out.push({ ...n, start: n.start + offset });
    offset = Math.max(...out.map((n) => n.start + n.dur)) + 1.2;
  }
  return out;
}

const L = (id, data) => ({ id, ...data });

export const LEVELS = [
  {
    n: 1,
    name: 'Foundations',
    tier: 'Beginner',
    badge: '🌱',
    tolerance: 50,
    blurb: 'Find your voice, breathe right, and match your first notes.',
    lessons: [
      L('range', {
        kind: 'range',
        icon: '🔎',
        title: 'Find your voice',
        subtitle: 'A 1-minute range test so every exercise fits you',
        teach: {
          heading: 'Everyone has a natural range',
          points: [
            'Your range is the span from your lowest to highest comfortable note. Exercises outside it strain your voice — so we measure it first.',
            'Stand tall, shoulders relaxed, feet hip-width apart. Good posture gives your lungs room.',
            'Never push or strain. If a note hurts or crackles, that’s past your comfortable edge — stop there.',
          ],
        },
      }),
      L('sustain', {
        kind: 'exercise',
        icon: '🌬️',
        title: 'Breath & sustain',
        subtitle: 'Hold one note steady for 4 seconds',
        focus: 'stability',
        mode: 'listen-repeat',
        build: (r) => buildHolds(r, { hold: 4 }),
        teach: {
          heading: 'Singing is controlled breathing',
          points: [
            'Breathe low: put a hand on your belly — it should push out as you inhale, while your shoulders stay still.',
            'Let the air out slowly and evenly, like blowing through a straw. Steady air = steady pitch.',
            'Sing on an open “ah”. Keep the jaw loose and the tongue resting behind your bottom teeth.',
          ],
        },
      }),
      L('match', {
        kind: 'exercise',
        icon: '🎯',
        title: 'Match the note',
        subtitle: 'Hear a note, then sing it back',
        focus: 'pitch',
        mode: 'listen-repeat',
        build: buildMatch,
        teach: {
          heading: 'Pitch matching is a skill, not a gift',
          points: [
            '“Tone deaf” is very rare — most people just haven’t trained the link between ear and voice. That’s what this builds.',
            'Listen, then imagine the note in your head before you sing it. Humming it quietly first helps.',
            'Watch the line: if it’s below the bar, think “up”; above, think “down”. Small adjustments!',
          ],
        },
      }),
      L('sirens', {
        kind: 'exercise',
        icon: '🚨',
        title: 'Sirens',
        subtitle: 'Glide smoothly up and down',
        focus: 'pitch',
        mode: 'listen-repeat',
        build: buildSirens,
        teach: {
          heading: 'Glides connect your voice',
          points: [
            'Slide like a siren on “ooo” or a lip trill (brrr). No steps, no breaks — one smooth line.',
            'Sirens warm up the voice and smooth the “break” between chest and head voice.',
            'Keep the volume gentle. Light and easy beats loud and forced.',
          ],
        },
      }),
    ],
  },
  {
    n: 2,
    name: 'Pitch control',
    tier: 'Apprentice',
    badge: '🎯',
    tolerance: 45,
    blurb: 'Step through notes accurately and sing your first song.',
    lessons: [
      L('steps', {
        kind: 'exercise',
        icon: '🪜',
        title: 'Do-Re-Mi steps',
        subtitle: 'Three neighbouring notes, up and back',
        focus: 'pitch',
        mode: 'listen-repeat',
        bpm: 76,
        build: (r) => buildPattern({ range: r, offsets: [0, 2, 4, 2, 0], bpm: 76 }),
        teach: {
          heading: 'Small steps, exact landings',
          points: [
            'Most melodies move by step. Nailing small steps is the core of singing in tune.',
            'Sing “do-re-mi-re-do”. Each note should land cleanly — no sliding between them.',
            'Keep the same open vowel on every note so your tone stays even.',
          ],
        },
      }),
      L('five', {
        kind: 'exercise',
        icon: '🖐️',
        title: 'Five-note scale',
        subtitle: 'The classic singer’s warm-up',
        focus: 'pitch',
        mode: 'listen-repeat',
        bpm: 84,
        build: (r) => buildPattern({ range: r, offsets: [0, 2, 4, 5, 7, 5, 4, 2, 0], bpm: 84 }),
        teach: {
          heading: 'The scale every singer uses',
          points: [
            'Notes 4 and 5 are the trickiest: the step from 3 to 4 is only a half step — keep it small.',
            'As the scale climbs, keep your chin level. Reaching up with the head tightens the throat.',
            'Breathe before each repetition — never sing to the very last drop of air.',
          ],
        },
      }),
      L('thirds', {
        kind: 'exercise',
        icon: '🦘',
        title: 'Hopping thirds',
        subtitle: 'Skip notes and land cleanly',
        focus: 'pitch',
        mode: 'listen-repeat',
        bpm: 80,
        build: (r) => buildPattern({ range: r, offsets: [0, 4, 2, 5, 4, 7, 5, 2, 0], bpm: 80, reps: 2 }),
        teach: {
          heading: 'Hear the jump before you make it',
          points: [
            'A skip is harder than a step: your ear must “pre-hear” where you’re going.',
            'Think of the first two notes of “Kumbaya” or “Oh When the Saints” — that’s a third.',
            'Aim for the centre of each note. Don’t scoop up into it.',
          ],
        },
      }),
      L('song-twinkle', {
        kind: 'song',
        songId: 'twinkle',
        icon: '⭐',
        title: 'Song: Twinkle Twinkle',
        subtitle: 'Your first full song with the guide',
        focus: 'song',
        mode: 'sing-along',
        teach: {
          heading: 'Put it together',
          points: [
            'Songs combine everything: steps, skips, held notes and breathing.',
            'Breathe at the commas — after “star”, after “are”, and so on.',
            'Sing with the guide melody. Lyrics show under each note.',
          ],
        },
      }),
    ],
  },
  {
    n: 3,
    name: 'Scales & ear',
    tier: 'Intermediate',
    badge: '🎼',
    tolerance: 40,
    blurb: 'Full scales, arpeggios and big leaps — build your musical ear.',
    lessons: [
      L('scale', {
        kind: 'exercise',
        icon: '📈',
        title: 'The major scale',
        subtitle: 'A full octave, up and down',
        focus: 'pitch',
        mode: 'sing-along',
        bpm: 92,
        build: (r) => buildPattern({ range: r, offsets: [0, 2, 4, 5, 7, 9, 11, 12, 11, 9, 7, 5, 4, 2, 0], bpm: 92, reps: 2, mode: 'sing-along' }),
        teach: {
          heading: 'The ladder of Western music',
          points: [
            'Two half-steps hide in the scale: 3→4 and 7→8. Keep those extra small.',
            'Going down, singers tend to go flat. Think “up” even as you descend.',
            'One breath per direction if you can — top-up at the octave if you must.',
          ],
        },
      }),
      L('arpeggio', {
        kind: 'exercise',
        icon: '🏔️',
        title: 'Arpeggios',
        subtitle: 'Do-Mi-Sol-Do — the chord tones',
        focus: 'pitch',
        mode: 'sing-along',
        bpm: 88,
        build: (r) => buildPattern({ range: r, offsets: [0, 4, 7, 12, 7, 4, 0], bpm: 88, mode: 'sing-along' }),
        teach: {
          heading: 'Sing the chord, one note at a time',
          points: [
            'An arpeggio outlines a chord. Melodies lean on these notes constantly.',
            'The top note is the reach: support it with more air, not a tighter throat.',
            'Keep the vowel tall (“ah” with a slight “oh” shape) as you climb.',
          ],
        },
      }),
      L('leaps', {
        kind: 'exercise',
        icon: '🚀',
        title: 'Big leaps',
        subtitle: 'Fifths and the full octave',
        focus: 'pitch',
        mode: 'sing-along',
        bpm: 76,
        build: (r) => buildPattern({ range: r, offsets: [0, 7, 0, 12, 7, 0], bpm: 76, reps: 2, mode: 'sing-along' }),
        teach: {
          heading: 'Leap with confidence',
          points: [
            'A fifth sounds like the opening of “Twinkle Twinkle” (twin-kle → twin-kle). The octave is the jump in “Somewhere Over the Rainbow”.',
            'Commit to the target. Hesitant leaps land flat.',
            'Keep the larynx (Adam’s apple) relaxed — don’t let it jump up with the note.',
          ],
        },
      }),
      L('song-ode', {
        kind: 'song',
        songId: 'ode',
        icon: '🎼',
        title: 'Song: Ode to Joy',
        subtitle: 'Beethoven’s famous melody',
        focus: 'song',
        mode: 'sing-along',
        teach: {
          heading: 'Phrasing a longer song',
          points: [
            'Four phrases — breathe at the end of each.',
            'Watch the third phrase: it has quick note pairs and dips to a low note at the end.',
            'Sing through to the end of each phrase; don’t let the last note fade early.',
          ],
        },
      }),
    ],
  },
  {
    n: 4,
    name: 'Control & expression',
    tier: 'Advanced',
    badge: '🔥',
    tolerance: 35,
    blurb: 'Dynamics, vibrato and agility — sound like a real singer.',
    lessons: [
      L('crescendo', {
        kind: 'exercise',
        icon: '📶',
        title: 'Crescendo',
        subtitle: 'Grow from soft to strong on one note',
        focus: 'dynamics',
        mode: 'listen-repeat',
        build: (r) => buildHolds(r, { hold: 5 }),
        teach: {
          heading: 'Volume comes from air, not force',
          points: [
            'Start quietly and grow steadily louder over the whole note.',
            'Add volume with breath pressure from your core — never by squeezing the throat.',
            'The pitch must stay put while the volume rises. Louder tends to go sharp — watch the line.',
          ],
        },
      }),
      L('vibrato', {
        kind: 'exercise',
        icon: '🌊',
        title: 'Vibrato',
        subtitle: 'Let a natural pulse into long notes',
        focus: 'vibrato',
        mode: 'listen-repeat',
        build: (r) => buildHolds(r, { hold: 5 }),
        teach: {
          heading: 'Vibrato is relaxation, not wobbling',
          points: [
            'Natural vibrato is a gentle 5–7 pulses per second around the note.',
            'Hold a relaxed, supported note. Try a gentle “ha-ha-ha” pulse from the belly, then smooth it out.',
            'Never shake your jaw or head. If it feels forced, go back to a straight tone and stay relaxed.',
          ],
        },
      }),
      L('agility', {
        kind: 'exercise',
        icon: '⚡',
        title: 'Agility runs',
        subtitle: 'Quick, light, accurate notes',
        focus: 'agility',
        mode: 'sing-along',
        bpm: 100,
        build: (r) => buildPattern({ range: r, offsets: [0, 2, 4, 5, 7, 5, 4, 2, 0], beats: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 1.5], bpm: 100, step: 1, mode: 'sing-along' }),
        teach: {
          heading: 'Fast notes need a light voice',
          points: [
            'Keep the voice light and bright for runs — heavy voices can’t move fast.',
            'Try a soft “ha-ha-ha” articulation first, then connect it into a smooth “ah”.',
            'Accuracy first, speed second. Each note should still be audible.',
          ],
        },
      }),
      L('song-birthday', {
        kind: 'song',
        songId: 'birthday',
        icon: '🎂',
        title: 'Song: Happy Birthday',
        subtitle: 'Harder than it looks — that octave leap!',
        focus: 'song',
        mode: 'sing-along',
        teach: {
          heading: 'The song everyone sings out of tune',
          points: [
            'The third line jumps a full octave on “birth-day dear”. Prepare it with a good breath.',
            'The short “hap-py” pickup notes are quick — keep them light.',
            'Start low enough that the high note is comfortable (we’ve already set the key for you).',
          ],
        },
      }),
    ],
  },
  {
    n: 5,
    name: 'Mastery',
    tier: 'Master',
    badge: '👑',
    tolerance: 25,
    blurb: 'Tight tolerance, no guide, wide leaps. Prove it.',
    lessons: [
      L('chromatic', {
        kind: 'exercise',
        icon: '🔬',
        title: 'Chromatic precision',
        subtitle: 'Half-steps at a ±25¢ tolerance',
        focus: 'pitch',
        mode: 'sing-along',
        bpm: 80,
        build: (r) => buildPattern({ range: r, offsets: [0, 1, 2, 3, 4, 3, 2, 1, 0], bpm: 80, reps: 2, mode: 'sing-along' }),
        teach: {
          heading: 'The smallest steps in music',
          points: [
            'A half-step is tiny — about 6% in frequency. Masters place each one exactly.',
            'Think of each note as slightly “higher” than you expect; most singers compress half-steps.',
            'Stay relaxed: precision comes from the ear, not from tension.',
          ],
        },
      }),
      L('wide', {
        kind: 'exercise',
        icon: '🎢',
        title: 'Wide leaps — solo',
        subtitle: 'Sixths and sevenths, first note only',
        focus: 'pitch',
        mode: 'solo',
        bpm: 72,
        build: (r) => buildPattern({ range: r, offsets: [0, 9, 4, 11, 7, 12, 0], bpm: 72, reps: 2, mode: 'solo' }),
        teach: {
          heading: 'No guide — just your ear',
          points: [
            'You hear only the first note. Then you sing the pattern from the purple bars alone.',
            'A major sixth opens “My Bonnie Lies Over the Ocean”. A major seventh is one step short of the octave.',
            'Hear each target in your head before you leave the current note.',
          ],
        },
      }),
      L('runs', {
        kind: 'exercise',
        icon: '🌪️',
        title: 'Minor runs — solo',
        subtitle: 'A full natural-minor run from memory',
        focus: 'agility',
        mode: 'solo',
        bpm: 92,
        build: (r) => buildPattern({ range: r, offsets: [0, 2, 3, 5, 7, 8, 10, 12, 10, 8, 7, 5, 3, 2, 0], beats: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 1, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 2], bpm: 92, reps: 2, mode: 'solo' }),
        teach: {
          heading: 'The minor colour',
          points: [
            'The minor scale has a darker sound: the 3rd, 6th and 7th notes are lowered.',
            'Agility plus accuracy plus memory — the full skill set of a lead vocalist.',
            'Keep it light, keep it even, and breathe at the top if you need to.',
          ],
        },
      }),
      L('song-grace', {
        kind: 'song',
        songId: 'grace',
        icon: '🕊️',
        title: 'Final: Amazing Grace — solo',
        subtitle: 'The whole song, no guide melody',
        focus: 'song',
        mode: 'solo',
        teach: {
          heading: 'Your graduation song',
          points: [
            'You get the first note, then you’re on your own — just like singing on stage.',
            'Shape the long notes: “grace”, “sound”, “me” — sustain them with support to the end.',
            'Pass this with 3 stars and you have truly mastered the path. 👑',
          ],
        },
      }),
    ],
  },
];

export const ALL_LESSONS = LEVELS.flatMap((lv) => lv.lessons.map((l) => ({ ...l, level: lv.n })));

export function lessonById(id) {
  return ALL_LESSONS.find((l) => l.id === id);
}

export function levelOf(lessonId) {
  return LEVELS.find((lv) => lv.lessons.some((l) => l.id === lessonId));
}

/** Everything the practice screen needs for a lesson. */
export function lessonPractice(lesson, range) {
  const level = levelOf(lesson.id);
  const tolerance = level.tolerance;
  if (lesson.kind === 'song') {
    const song = songById(lesson.songId);
    let targets = buildSong(lesson.songId, range);
    if (lesson.mode === 'solo') {
      const first = targets[0];
      const b = 60 / song.bpm;
      targets = [{ midi: first.midi, start: 0, dur: b * 1.5, role: 'listen' }, ...targets.map((n) => ({ ...n, start: n.start + b * 3 }))];
    }
    return { title: lesson.title, targets, tolerance, bpm: song.bpm, focus: 'song', guideOnSing: lesson.mode !== 'solo' };
  }
  return {
    title: lesson.title,
    targets: lesson.build(range),
    tolerance,
    bpm: lesson.bpm ?? 80,
    focus: lesson.focus,
    guideOnSing: lesson.mode === 'sing-along',
  };
}
