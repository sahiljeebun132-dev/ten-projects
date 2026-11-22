// The coach: real-time cues while you sing, and teaching feedback afterwards.
import { median } from './notes.js';
import { pitchError, measureVibrato, isVibrato } from './scoring.js';

const MIN_HOLD = 0.4; // seconds a cue stays up before it may change (prevents flicker)

export const CUE_SPEECH = {
  up: 'Higher',
  'much-up': 'Much higher',
  down: 'Lower',
  'much-down': 'Much lower',
  good: 'Perfect',
  sing: 'Sing',
  steady: 'Steady',
  louder: 'Louder',
};

export class LiveCoach {
  constructor({ tolerance = 50 } = {}) {
    this.tolerance = tolerance;
    this.reset();
  }

  reset() {
    this.buf = [];
    this.cue = null;
    this.cueSince = -Infinity;
    this.lastVoiced = -Infinity;
    this.targetSince = null;
    this.lastTarget = null;
  }

  /**
   * frame: { t, midi|null, rms }
   * target: target MIDI (number) while the singer should be singing, else null
   * phase: 'sing' | 'listen' | 'rest' | 'free'
   */
  update(frame, target, phase = 'sing') {
    const { t } = frame;
    const err = frame.midi != null && target != null ? pitchError(frame.midi, target).cents : null;
    this.buf.push({ t, midi: frame.midi, rms: frame.rms ?? 0, cents: err });
    while (this.buf.length && this.buf[0].t < t - 1.2) this.buf.shift();
    if (frame.midi != null) this.lastVoiced = t;
    if (target !== this.lastTarget) {
      if (target == null || this.lastTarget == null || Math.abs(target - this.lastTarget) > 0.5) this.targetSince = t;
      this.lastTarget = target;
    }

    const next = this.decide(t, target, phase);
    if (!this.cue || next.kind !== this.cue.kind) {
      if (!this.cue || t - this.cueSince >= MIN_HOLD || next.urgent) {
        this.cue = next;
        this.cueSince = t;
      }
    } else {
      this.cue = next; // same kind: refresh text
    }
    return { cue: this.cue, cents: err };
  }

  decide(t, target, phase) {
    if (phase === 'listen') return { kind: 'listen', text: 'Listen…', icon: '🎧' };
    if (phase === 'rest') return { kind: 'rest', text: 'Breathe in…', icon: '🌬️' };
    if (phase === 'free' && target == null) return this.freeCue(t);
    if (target == null) return { kind: 'rest', text: 'Get ready…', icon: '⏳' };

    const recent = this.buf.filter((b) => b.t >= t - 0.25);
    const voiced = recent.filter((b) => b.midi != null);
    const sinceTarget = this.targetSince == null ? 0 : t - this.targetSince;

    if (voiced.length < recent.length * 0.4) {
      if (sinceTarget < 0.3 || t - this.lastVoiced < 0.3) return this.cue || { kind: 'sing', text: 'Sing now!', icon: '🎤' };
      const loudish = recent.some((b) => b.rms > 0.02);
      return loudish
        ? { kind: 'sing', text: 'Clearer tone — open “ah”', icon: '🎤' }
        : { kind: 'sing', text: 'Sing now!', icon: '🎤' };
    }

    const err = median(voiced.map((b) => b.cents));
    const tol = this.tolerance;
    const rms = median(voiced.map((b) => b.rms));
    if (err < -tol) {
      return err < -150
        ? { kind: 'much-up', text: 'Much higher', icon: '⏫', urgent: true }
        : { kind: 'up', text: 'Go higher', icon: '⬆️' };
    }
    if (err > tol) {
      return err > 150
        ? { kind: 'much-down', text: 'Much lower', icon: '⏬', urgent: true }
        : { kind: 'down', text: 'Go lower', icon: '⬇️' };
    }
    if (rms > 0.45) return { kind: 'softer', text: 'Ease off — don’t push', icon: '🫧' };
    if (rms < 0.012) return { kind: 'louder', text: 'A little louder', icon: '🔊' };
    if (err < -Math.min(18, tol * 0.5)) return { kind: 'nudge-up', text: 'Close — a touch higher', icon: '↗️' };
    if (err > Math.min(18, tol * 0.5)) return { kind: 'nudge-down', text: 'Close — a touch lower', icon: '↘️' };

    const held = this.buf.filter((b) => b.t >= t - 0.9 && b.cents != null);
    if (held.length > 30) {
      const vib = measureVibrato(held);
      if (isVibrato(vib)) return { kind: 'vibrato', text: 'Beautiful vibrato ✨', icon: '🌊' };
      const c = held.map((b) => b.cents);
      const mean = c.reduce((s, x) => s + x, 0) / c.length;
      const std = Math.sqrt(c.reduce((s, x) => s + (x - mean) ** 2, 0) / c.length);
      if (std > 30) return { kind: 'steady', text: 'Steady it — even breath', icon: '🎯' };
    }
    return { kind: 'good', text: 'Perfect — hold it!', icon: '✅' };
  }

  freeCue(t) {
    const recent = this.buf.filter((b) => b.t >= t - 0.6 && b.midi != null);
    if (recent.length < 8) return { kind: 'sing', text: 'Sing any note — I’m listening', icon: '🎤' };
    const m = recent.map((b) => b.midi);
    const mean = m.reduce((s, x) => s + x, 0) / m.length;
    const std = Math.sqrt(m.reduce((s, x) => s + (x - mean) ** 2, 0) / m.length) * 100;
    if (std < 15) return { kind: 'good', text: 'Rock steady', icon: '✅' };
    if (std < 35) return { kind: 'steady', text: 'Nice — keep it even', icon: '🎯' };
    return { kind: 'free', text: 'Moving pitch', icon: '〰️' };
  }
}

/** Turn a scored take into specific, teachable feedback. */
export function buildInsights(r) {
  const tips = [];
  const wins = [];
  const flat = r.meanSignedCents;

  if (r.notesTotal === 0) return [{ type: 'tip', text: 'Nothing to score yet — sing along with the purple notes.' }];

  if (r.coverage < 50) {
    tips.push('I heard a lot of silence. Sing out on a confident “ah” and move a little closer to the mic — I can only coach what I hear.');
  }
  if (r.coverage >= 30) {
    if (flat < -15) {
      tips.push(`You lean flat (about ${Math.abs(flat)}¢ low). Lift the soft palate — like the start of a yawn — and keep the air moving right to the end of each note.`);
    } else if (flat > 15) {
      tips.push(`You lean sharp (about ${flat}¢ high). That usually means pushing. Relax your jaw, use less pressure and let each note settle.`);
    } else if (r.accuracy >= 65) {
      wins.push('Your pitch centre is spot-on — no flat or sharp habit.');
    }
  }
  if (r.notesTotal >= 3 && r.scoops / r.notesTotal >= 0.3) {
    tips.push('You scoop up into notes. Hear the pitch in your head first, then start right on it — a tiny “h” before the vowel helps.');
  }
  if (r.focus !== 'vibrato' && r.coverage >= 40) {
    if (r.stability < 60) {
      tips.push('Notes are wobbling. Breathe low into your belly and let the air out slowly and evenly, like blowing through a straw.');
    } else if (r.stability >= 80) {
      wins.push('Rock-solid sustain — great breath control.');
    }
  }
  if (r.notesHit > 0 && r.timing < 60) {
    tips.push('You come in a little late. Breathe in on the beat before each phrase so you’re ready to sing on time.');
  } else if (r.timing >= 85 && r.notesHit >= 3) {
    wins.push('Great timing — you land on the beat.');
  }

  // Register comparison: are high or low notes the weak spot?
  const scored = r.perNote.filter((n) => n.voicedFrac > 0.4);
  if (scored.length >= 6) {
    const sorted = [...scored].sort((a, b) => a.midi - b.midi);
    const k = Math.max(2, Math.floor(sorted.length / 3));
    const lowAbs = avgOf(sorted.slice(0, k).map((n) => n.meanAbs));
    const highAbs = avgOf(sorted.slice(-k).map((n) => n.meanAbs));
    if (highAbs - lowAbs > 15) {
      tips.push('Your higher notes drift. Don’t reach up with your chin — keep it level and add breath support as the line rises.');
    } else if (lowAbs - highAbs > 15) {
      tips.push('Low notes get fuzzy. Relax, let your throat open, and don’t force volume down there.');
    }
  }

  const info = [];
  if (r.octaveMode !== 0 && r.coverage > 30) {
    info.push(`You sang an octave ${r.octaveMode < 0 ? 'lower' : 'higher'} than the guide — totally fine; I score the note, not the octave.`);
  }
  if (r.focus === 'dynamics') {
    if (r.bestCrescendo < 1.3) tips.push('Grow the volume more: start soft and finish strong by adding air — not by squeezing your throat.');
    else wins.push('Lovely crescendo — the volume grew with good support.');
  }
  if (r.focus === 'vibrato') {
    if (r.vibratoNotes === 0) tips.push('No vibrato yet. Hold a relaxed note and let a gentle pulse appear — never shake it from your throat or jaw.');
    else wins.push('Vibrato detected — free and natural. Keep it relaxed.');
  }
  if (r.score >= 90) wins.unshift('Outstanding — you’ve mastered this one!');
  else if (r.score >= 60 && tips.length === 0) wins.push('Solid work. Repeat it to push for three stars.');

  return [
    ...tips.slice(0, 3).map((text) => ({ type: 'tip', text })),
    ...wins.slice(0, 3).map((text) => ({ type: 'good', text })),
    ...info.map((text) => ({ type: 'info', text })),
  ];
}

function avgOf(a) {
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
}
