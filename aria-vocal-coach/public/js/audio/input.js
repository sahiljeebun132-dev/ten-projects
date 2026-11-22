// Voice input: microphone (or a simulated "demo singer") -> analyser -> YIN pitch.
import { createPitchDetector } from './pitch.js';
import { freqToMidi, midiToFreq, median } from './notes.js';

const FFT_SIZE = 2048;
const MIN_CLARITY = 0.8;

export class VoiceInput {
  constructor(ctx) {
    this.ctx = ctx;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = FFT_SIZE;
    this.analyser.smoothingTimeConstant = 0;
    this.buf = new Float32Array(FFT_SIZE);
    this.detect = createPitchDetector({ sampleRate: ctx.sampleRate, bufferSize: FFT_SIZE });
    // Keep the analyser pulled by the graph without making it audible.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    this.analyser.connect(sink).connect(ctx.destination);
    this.kind = null; // 'mic' | 'demo'
    this.recent = [];
    this.stream = null;
    this.source = null;
    this.demo = null;
  }

  async useMic() {
    if (this.kind === 'mic' && this.stream?.active) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw Object.assign(new Error('This browser has no microphone access. Open the app on http://localhost or https.'), { code: 'unsupported' });
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
    this.detach();
    this.stream = stream;
    this.source = this.ctx.createMediaStreamSource(stream);
    this.source.connect(this.analyser);
    this.kind = 'mic';
  }

  useDemo() {
    if (this.kind === 'demo') return;
    this.detach();
    this.demo = new DemoSinger(this.ctx);
    this.demo.output.connect(this.analyser);
    this.kind = 'demo';
  }

  detach() {
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.demo?.dispose();
    this.source = this.stream = this.demo = null;
    this.kind = null;
    this.recent = [];
  }

  /** Where the simulated singer should aim (MIDI) — ignored for the real mic. */
  setDemoTarget(midi) {
    this.demo?.setTarget(midi);
  }

  /** Seconds between a sound being heard by the singer and us analysing their reply. */
  get latency() {
    if (this.kind !== 'mic') return FFT_SIZE / 2 / this.ctx.sampleRate;
    return (this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0) + 0.05;
  }

  read() {
    this.demo?.tick(this.ctx.currentTime);
    this.analyser.getFloatTimeDomainData(this.buf);
    const r = this.detect(this.buf);
    const raw = r.freq > 0 && r.clarity >= MIN_CLARITY ? freqToMidi(r.freq) : null;
    // 3-frame median removes one-frame octave glitches and dropouts.
    this.recent.push(raw);
    if (this.recent.length > 3) this.recent.shift();
    const voiced = this.recent.filter((m) => m != null);
    const midi = raw != null && voiced.length >= 2 ? median(voiced) : raw != null && this.recent.length < 3 ? raw : null;
    return { t: this.ctx.currentTime, midi, rms: r.rms, clarity: r.clarity };
  }
}

/** A synthetic singer that follows the target like a decent (imperfect) human. */
class DemoSinger {
  constructor(ctx) {
    this.ctx = ctx;
    this.osc = ctx.createOscillator();
    this.osc.type = 'sawtooth';
    const formant = ctx.createBiquadFilter();
    formant.type = 'lowpass';
    formant.frequency.value = 1800;
    formant.Q.value = 0.8;
    this.env = ctx.createGain();
    this.env.gain.value = 0;
    this.osc.connect(formant).connect(this.env);
    this.output = this.env;
    // Let the user hear the demo singer quietly.
    this.monitor = ctx.createGain();
    this.monitor.gain.value = 0.12;
    this.env.connect(this.monitor).connect(ctx.destination);
    this.osc.start();
    this.cur = null;
    this.target = null;
    this.noteStart = 0;
    this.drift = 0;
    this.bias = -0.06; // sings a touch flat, like many beginners
    this.lastT = ctx.currentTime;
  }

  setTarget(midi) {
    if (midi === this.target) return;
    // Fall silent immediately — the analysis loop (and tick()) may be stopping.
    if (midi == null) this.env.gain.setTargetAtTime(0, this.ctx.currentTime, 0.03);
    const jump = midi == null || this.target == null || Math.abs(midi - this.target) > 0.5;
    if (jump) {
      this.noteStart = this.ctx.currentTime;
      if (midi != null && this.cur == null) this.cur = midi - 0.5; // small scoop in
    }
    this.target = midi;
  }

  tick(t) {
    const dt = Math.min(0.1, Math.max(0, t - this.lastT));
    this.lastT = t;
    if (this.target == null) {
      this.env.gain.setTargetAtTime(0, t, 0.03);
      if (t - this.noteStart > 0.15) this.cur = null;
      return;
    }
    this.env.gain.setTargetAtTime(0.32, t, 0.02);
    this.drift = Math.max(-0.2, Math.min(0.2, this.drift * 0.985 + (Math.random() - 0.5) * 0.03));
    const aim = this.target + this.bias + this.drift;
    this.cur = this.cur == null ? aim : this.cur + (aim - this.cur) * (1 - Math.exp(-dt / 0.07));
    const held = t - this.noteStart;
    const vib = held > 0.55 ? 0.22 * Math.sin(2 * Math.PI * 5.4 * held) * Math.min(1, (held - 0.55) / 0.5) : 0;
    this.osc.frequency.setTargetAtTime(midiToFreq(this.cur + vib), t, 0.012);
  }

  dispose() {
    try {
      this.osc.stop();
    } catch {
      /* already stopped */
    }
    this.env.disconnect();
    this.monitor.disconnect();
  }
}
