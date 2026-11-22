// A single practice run: count-in, guide/backing playback, live coaching, scoring.
import { LiveCoach } from './coach.js';
import { scoreTake, targetMidiAt, pitchError } from './scoring.js';

export class PracticeSession {
  /**
   * @param {object} o
   * @param {{ctx: AudioContext, input: import('./input.js').VoiceInput, guide: import('./guide.js').Guide}} o.engine
   * @param {Array} o.targets   [{midi, start, dur, glideTo?, role, lyric?}]
   * @param {boolean} o.guideOnSing  play the guide on 'sing' notes too (sing-along)
   * @param {AudioBuffer} [o.backing]  original song audio, aligned with target times
   */
  constructor({ engine, targets, tolerance = 50, bpm = 80, focus = 'pitch', guideOnSing = false, backing = null, backingVolume = 0.8, record = true, onUpdate, onEnd }) {
    Object.assign(this, { engine, targets, tolerance, bpm, focus, guideOnSing, backing, backingVolume, record, onUpdate, onEnd });
    this.frames = [];
    this.trail = [];
    this.noteLive = targets.map(() => ({ frames: 0, inTune: 0 }));
    this.running = false;
    this.takeUrl = null;
    this.takeBlob = null;
  }

  get duration() {
    const lastEnd = Math.max(0, ...this.targets.map((t) => t.start + t.dur));
    return this.backing ? Math.max(lastEnd + 0.5, Math.min(this.backing.duration, lastEnd + 4)) : lastEnd + 0.8;
  }

  async start() {
    const { ctx, guide, input } = this.engine;
    this.coach = new LiveCoach({ tolerance: this.tolerance });
    const beat = 60 / this.bpm;
    const lead = this.backing ? 1.6 : 4 * beat + 0.15;
    this.t0 = ctx.currentTime + lead;
    this.beat = beat;
    this.endAt = this.duration;

    if (!this.backing) for (let i = 0; i < 4; i++) guide.click(this.t0 - (4 - i) * beat, i === 0);
    for (const t of this.targets) {
      if (t.role === 'listen' || this.guideOnSing) {
        guide.note(t.midi, this.t0 + t.start, t.dur, { glideTo: t.glideTo ?? null, vel: t.role === 'listen' ? 0.34 : 0.22 });
      }
    }
    if (this.backing) {
      this.backingGain = ctx.createGain();
      this.backingGain.gain.value = this.backingVolume;
      this.backingSrc = ctx.createBufferSource();
      this.backingSrc.buffer = this.backing;
      this.backingSrc.connect(this.backingGain).connect(ctx.destination);
      this.backingSrc.start(this.t0);
    }
    if (this.record && input.kind === 'mic' && input.stream && window.MediaRecorder) {
      try {
        // A voice needs far less than the default bitrate; small takes let Aria keep months of them.
        try {
          this.recorder = new MediaRecorder(input.stream, { audioBitsPerSecond: 48_000 });
        } catch {
          this.recorder = new MediaRecorder(input.stream);
        }
        const chunks = [];
        this.recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
        this.takeReady = new Promise((resolve) => {
          this.recorder.onstop = () => {
            this.takeBlob = chunks.length ? new Blob(chunks, { type: this.recorder.mimeType }) : null;
            this.takeUrl = this.takeBlob ? URL.createObjectURL(this.takeBlob) : null;
            resolve(this.takeUrl);
          };
        });
        this.recordTimer = setTimeout(() => this.recorder?.state === 'inactive' && this.recorder.start(), lead * 1000);
      } catch {
        this.recorder = null;
      }
    }
    this.running = true;
    this.loop();
  }

  setGuideVolume(v) {
    this.engine.guide.setVolume(v);
  }

  setBackingVolume(v) {
    if (this.backingGain) this.backingGain.gain.setTargetAtTime(v, this.engine.ctx.currentTime, 0.05);
  }

  /** The 'sing' or 'listen' target active at time t (exercise clock). */
  targetAt(t) {
    for (let i = 0; i < this.targets.length; i++) {
      const tg = this.targets[i];
      if (t >= tg.start && t < tg.start + tg.dur) return { tg, i };
    }
    return null;
  }

  loop = () => {
    if (!this.running) return;
    const { ctx, input } = this.engine;
    const songT = ctx.currentTime - this.t0;

    // The demo singer aims at whatever should be sung right now.
    const nowTarget = this.targetAt(songT);
    input.setDemoTarget(nowTarget && nowTarget.tg.role !== 'listen' ? targetMidiAt(nowTarget.tg, songT) : null);

    const f = input.read();
    const t = songT - input.latency;
    const active = this.targetAt(t);
    const phase = active ? (active.tg.role === 'listen' ? 'listen' : 'sing') : t < 0 ? 'rest' : 'rest';
    const tgtMidi = active && phase === 'sing' ? targetMidiAt(active.tg, t) : null;
    const res = this.coach.update({ t, midi: f.midi, rms: f.rms }, tgtMidi, phase);

    let plotted = f.midi;
    let col = 'free';
    if (f.midi != null && tgtMidi != null) {
      const e = pitchError(f.midi, tgtMidi);
      plotted = tgtMidi + e.cents / 100; // fold octave errors onto the target lane
      const a = Math.abs(e.cents);
      col = a <= this.tolerance * 0.5 ? 'good' : a <= this.tolerance ? 'ok' : 'bad';
      const nl = this.noteLive[active.i];
      nl.frames++;
      if (a <= this.tolerance) nl.inTune++;
    } else if (active && phase === 'sing') {
      this.noteLive[active.i].frames++;
    }
    if (songT > -0.3) {
      this.frames.push({ t, midi: f.midi, rms: f.rms, ...(f.tone ? { tone: f.tone } : {}) });
      this.trail.push({ t, m: plotted, col });
      if (this.trail.length > 600) this.trail.splice(0, this.trail.length - 600);
    }

    this.onUpdate?.({
      songT,
      t,
      frame: f,
      active,
      phase,
      targetMidi: tgtMidi,
      cents: res.cents,
      cue: res.cue,
      countdown: songT < 0 ? Math.ceil(-songT / (this.backing ? 0.5 : this.beat)) : null,
      progress: Math.max(0, Math.min(1, songT / this.endAt)),
    });

    if (songT >= this.endAt) this.finish();
    else this.raf = requestAnimationFrame(this.loop);
  };

  /** Live per-note result for colouring passed notes on the canvas. */
  noteResult(i) {
    const n = this.noteLive[i];
    if (!n || n.frames < 3) return undefined;
    return n.inTune / n.frames >= 0.4;
  }

  halt() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.recordTimer);
    this.engine.guide.stopAll();
    this.engine.input.setDemoTarget(null);
    try {
      this.backingSrc?.stop();
    } catch {
      /* not started */
    }
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
  }

  stop() {
    this.halt();
  }

  finish() {
    this.halt();
    const result = scoreTake(this.frames, this.targets, { tolerance: this.tolerance, focus: this.focus, backing: Boolean(this.backing) });
    this.onEnd?.(result);
  }
}
