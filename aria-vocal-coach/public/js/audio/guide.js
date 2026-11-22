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
    // The tanpura has its own bus so it keeps droning when guide notes are stopped.
    this.tanBus = ctx.createGain();
    this.tanBus.gain.value = 0.35;
    this.tanBus.connect(comp);
    this.tan = null;
    this.live = new Set();
  }

  setVolume(v) {
    this.master.gain.setTargetAtTime(Math.max(0, Math.min(1, v)), this.ctx.currentTime, 0.05);
  }

  setTanpuraVolume(v) {
    this.tanBus.gain.setTargetAtTime(Math.max(0, Math.min(1, v)), this.ctx.currentTime, 0.05);
  }

  get tanpuraSa() {
    return this.tan?.sa ?? null;
  }

  /**
   * An electronic tanpura tuned to `sa` (MIDI): strings Pa (mandra) – Sa – Sa – Sa (kharaj),
   * plucked in the classic cycle. Pass first: 5 for Ma-tuned ragas. Calling again retunes.
   */
  tanpura(sa, { first = 7 } = {}) {
    this.stopTanpura();
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0, ctx.currentTime);
    out.gain.linearRampToValueAtTime(1, ctx.currentTime + 1.2);
    out.connect(this.tanBus);
    const strings = [sa - 12 + first, sa, sa, sa - 12];
    const offsets = [0, 1.15, 1.9, 2.65];
    const cycle = 4.6;
    const nodes = new Set();
    let next = ctx.currentTime + 0.1;
    const schedule = () => {
      while (next < ctx.currentTime + 1.2) {
        strings.forEach((m, i) => this.pluck(m, next + offsets[i], out, nodes, i === 3 ? 0.26 : 0.2));
        next += cycle;
      }
    };
    schedule();
    const timer = setInterval(schedule, 300);
    this.tan = { sa, out, nodes, timer };
    return () => this.stopTanpura();
  }

  stopTanpura() {
    if (!this.tan) return;
    const { out, nodes, timer } = this.tan;
    this.tan = null;
    clearInterval(timer);
    const t = this.ctx.currentTime;
    out.gain.cancelScheduledValues(t);
    out.gain.setValueAtTime(out.gain.value, t);
    out.gain.linearRampToValueAtTime(0, t + 0.6);
    for (const n of nodes) {
      try {
        n.stop(t + 0.7);
      } catch {
        /* already stopped */
      }
    }
    setTimeout(() => out.disconnect(), 900);
  }

  /** One tanpura string: buzzy (jawari-like) bright attack that mellows over ~4 s. */
  pluck(midi, when, out, nodes, vel) {
    const ctx = this.ctx;
    const f = midiToFreq(midi);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, when);
    env.gain.exponentialRampToValueAtTime(vel, when + 0.02);
    env.gain.exponentialRampToValueAtTime(vel * 0.45, when + 1.2);
    env.gain.exponentialRampToValueAtTime(0.0001, when + 4.4);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 3;
    lp.frequency.setValueAtTime(Math.min(9000, f * 16), when);
    lp.frequency.exponentialRampToValueAtTime(Math.min(6000, f * 5), when + 2.5);
    const buzz = ctx.createBiquadFilter();
    buzz.type = 'peaking';
    buzz.frequency.value = Math.min(5000, f * 9);
    buzz.Q.value = 4;
    buzz.gain.value = 9;
    lp.connect(buzz).connect(env).connect(out);
    for (const [type, mult, detune, gain] of [
      ['sawtooth', 1, 0, 0.5],
      ['sawtooth', 1, 6, 0.35],
      ['sine', 2, -3, 0.25],
    ]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f * mult;
      o.detune.value = detune;
      const g = ctx.createGain();
      g.gain.value = gain;
      o.connect(g).connect(lp);
      o.start(when);
      o.stop(when + 4.5);
      nodes.add(o);
      o.onended = () => nodes.delete(o);
    }
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
