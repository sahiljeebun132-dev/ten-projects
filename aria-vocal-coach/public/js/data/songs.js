// Built-in public-domain melodies (written in C; transposed to each singer's range).
// Token format: "<note>:<beats>" (beats default 1), "r:<beats>" for rests.
// Lyrics: one token per note, "_" = held syllable (no new word).
import { parseNote } from '../audio/notes.js';

function seq(tokens, lyrics, bpm) {
  const beat = 60 / bpm;
  const words = lyrics ? lyrics.split(/\s+/).filter(Boolean) : [];
  const notes = [];
  let t = 0;
  let w = 0;
  for (const tok of tokens.split(/\s+/).filter(Boolean)) {
    const [n, b = '1'] = tok.split(':');
    const dur = Number(b) * beat;
    if (n !== 'r') {
      const word = words[w++] ?? '';
      notes.push({ midi: parseNote(n), start: t, dur: dur * 0.94, lyric: word === '_' ? '' : word });
    }
    t += dur;
  }
  if (words.length && w !== words.length) console.warn(`Lyric count mismatch (${w} notes, ${words.length} words)`, lyrics.slice(0, 30));
  return notes;
}

export const SONGS = [
  {
    id: 'twinkle',
    title: 'Twinkle Twinkle Little Star',
    artist: 'Traditional',
    difficulty: 'Easy',
    icon: '⭐',
    bpm: 92,
    notes: seq(
      'C4 C4 G4 G4 A4 A4 G4:2 F4 F4 E4 E4 D4 D4 C4:2 G4 G4 F4 F4 E4 E4 D4:2 G4 G4 F4 F4 E4 E4 D4:2 C4 C4 G4 G4 A4 A4 G4:2 F4 F4 E4 E4 D4 D4 C4:2',
      'Twin- kle twin- kle lit- tle star, How I won- der what you are. Up a- bove the world so high, Like a dia- mond in the sky. Twin- kle twin- kle lit- tle star, How I won- der what you are.',
      92,
    ),
  },
  {
    id: 'frere',
    title: 'Frère Jacques (Are You Sleeping)',
    artist: 'Traditional',
    difficulty: 'Easy',
    icon: '🔔',
    bpm: 100,
    notes: seq(
      'C4 D4 E4 C4 C4 D4 E4 C4 E4 F4 G4:2 E4 F4 G4:2 G4:0.5 A4:0.5 G4:0.5 F4:0.5 E4 C4 G4:0.5 A4:0.5 G4:0.5 F4:0.5 E4 C4 C4 G3 C4:2 C4 G3 C4:2',
      'Are you sleep- ing, are you sleep- ing, Broth- er John, Broth- er John? Morn- ing bells are ring- ing, morn- ing bells are ring- ing, Ding dang dong, ding dang dong.',
      100,
    ),
  },
  {
    id: 'ode',
    title: 'Ode to Joy (Joyful, Joyful)',
    artist: 'Beethoven · words H. van Dyke',
    difficulty: 'Medium',
    icon: '🎼',
    bpm: 104,
    notes: seq(
      'E4 E4 F4 G4 G4 F4 E4 D4 C4 C4 D4 E4 E4:1.5 D4:0.5 D4:2 ' +
        'E4 E4 F4 G4 G4 F4 E4 D4 C4 C4 D4 E4 D4:1.5 C4:0.5 C4:2 ' +
        'D4 D4 E4 C4 D4 E4:0.5 F4:0.5 E4 C4 D4 E4:0.5 F4:0.5 E4 D4 C4 D4 G3:2 ' +
        'E4 E4 F4 G4 G4 F4 E4 D4 C4 C4 D4 E4 D4:1.5 C4:0.5 C4:2',
      'Joy- ful, joy- ful, we a- dore Thee, God of glo- ry, Lord of love; ' +
        'Hearts un- fold like flow’rs be- fore Thee, O- p’ning to the sun a- bove. ' +
        'Melt the clouds of sin and _ sad- ness; Drive the _ dark of doubt a- way; ' +
        'Giv- er of im- mor- tal glad- ness, Fill us with the light of day!',
      104,
    ),
  },
  {
    id: 'birthday',
    title: 'Happy Birthday',
    artist: 'Traditional',
    difficulty: 'Medium',
    icon: '🎂',
    bpm: 100,
    notes: seq(
      'G3:0.75 G3:0.25 A3 G3 C4 B3:2 G3:0.75 G3:0.25 A3 G3 D4 C4:2 G3:0.75 G3:0.25 G4 E4 C4 B3 A3:2 F4:0.75 F4:0.25 E4 C4 D4 C4:2',
      'Hap- py birth- day to you, Hap- py birth- day to you, Hap- py birth- day dear sing- er, Hap- py birth- day to you!',
      100,
    ),
  },
  {
    id: 'grace',
    title: 'Amazing Grace',
    artist: 'John Newton · traditional tune',
    difficulty: 'Hard',
    icon: '🕊️',
    bpm: 88,
    notes: seq(
      'G3 C4:2 E4:0.5 C4:0.5 E4:2 D4 C4:2 A3 G3:2 G3 C4:2 E4:0.5 C4:0.5 E4:2 D4 G4:5 ' +
        'E4 G4:2 E4:0.5 G4:0.5 E4:2 D4 C4:2 A3 G3:2 G3 C4:2 E4:0.5 C4:0.5 E4:2 D4 C4:3',
      'A- maz- ing _ grace how sweet the sound that saved a _ wretch like me. ' +
        'I once was _ lost but now am found, was blind but _ now I see.',
      88,
    ),
  },
];

export function songById(id) {
  return SONGS.find((s) => s.id === id);
}

/** Range of a note list as [low, high] MIDI using robust percentiles. */
export function melodyRange(notes) {
  const m = notes.map((n) => n.midi).sort((a, b) => a - b);
  if (!m.length) return [60, 60];
  const lo = m[Math.floor(m.length * 0.05)];
  const hi = m[Math.min(m.length - 1, Math.ceil(m.length * 0.95) - 1)];
  return [lo, hi];
}

/** Semitone shift that centres a melody inside the singer's comfortable range. */
export function fitShift(notes, range) {
  const [lo, hi] = melodyRange(notes);
  return Math.round((range.low + range.high) / 2 - (lo + hi) / 2);
}

export function transpose(notes, shift) {
  return notes.map((n) => ({ ...n, midi: n.midi + shift }));
}
