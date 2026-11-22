// Guide tones: a soft electric-piano-ish synth for reference notes, plus count-in clicks.
import { midiToFreq } from './notes.js';

export class Guide {
  constructor(ctx) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.6;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);
    this.live = new Set();
  }

  setVolume(v) {
    this.master.gain.setTargetAtTime(Math.max(0, Math.min(1, v)), this.ctx.currentTime, 0.05);
  }

  track(node, stopAt) {
    this.live.add(node);
    node.onended = () => this.live.delete(node);
    node.start(Math.max(this.ctx.currentTime, stopAt.start));
    node.stop(stopAt.stop);
  }

  note(midi, when, dur, { vel = 0.32, glideTo = null } = {}) {
    const ctx = this.ctx;
    const t0 = Math.max(ctx.currentTime, when);
    const end = t0 + Math.max(0.08, dur);
    const env = ctx.createGain();
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 2600;
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(vel, t0 + 0.015);
    env.gain.exponentialRampToValueAtTime(vel * 0.6, t0 + 0.3);
    env.gain.setValueAtTime(vel * 0.6, Math.max(t0 + 0.3, end - 0.06));
    env.gain.linearRampToValueAtTime(0.0001, end + 0.08);
    filt.connect(env).connect(this.master);

    const voices = [
      ['triangle', 1, 1],
      ['sine', 2, 0.35],
      ['sine', 1, 0.5],
    ];
    for (const [type, mult, gain] of voices) {
      const o = ctx.createOscillator();
      o.type = type;
      const g = ctx.createGain();
      g.gain.value = gain;
      o.frequency.setValueAtTime(midiToFreq(midi) * mult, t0);
      if (glideTo != null) o.frequency.exponentialRampToValueAtTime(midiToFreq(glideTo) * mult, end);
      o.connect(g).connect(filt);
      this.track(o, { start: t0, stop: end + 0.12 });
    }
  }

  click(when, accent = false) {
    const ctx = this.ctx;
    const t0 = Math.max(ctx.currentTime, when);
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = accent ? 1760 : 1320;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(accent ? 0.22 : 0.14, t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.05);
    o.connect(g).connect(this.master);
    this.track(o, { start: t0, stop: t0 + 0.07 });
  }

  /** Continuous soft reference tone; returns a stop() function. */
  drone(midi) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, ctx.currentTime);
    g.gain.linearRampToValueAtTime(0.18, ctx.currentTime + 0.3);
    g.connect(this.master);
    const oscs = [1, 2].map((mult, i) => {
      const o = ctx.createOscillator();
      o.type = i ? 'sine' : 'triangle';
      o.frequency.value = midiToFreq(midi) * mult;
      const og = ctx.createGain();
      og.gain.value = i ? 0.3 : 1;
      o.connect(og).connect(g);
      o.start();
      this.live.add(o);
      return o;
    });
    return () => {
      const t = ctx.currentTime;
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(g.gain.value, t);
      g.gain.linearRampToValueAtTime(0, t + 0.2);
      oscs.forEach((o) => {
        o.stop(t + 0.25);
        this.live.delete(o);
      });
    };
  }

  stopAll() {
    const t = this.ctx.currentTime;
    for (const n of this.live) {
      try {
        n.stop(t);
      } catch {
        /* not started yet or already stopped */
      }
    }
    this.live.clear();
  }
}
