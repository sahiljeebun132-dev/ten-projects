// Scrolling "piano roll": target notes slide right-to-left, your voice draws a live line.
import { noteName, isBlackKey } from '../audio/notes.js';

const GUTTER = 46;
const COLORS = { good: '#34d399', ok: '#fbbf24', bad: '#f87171', free: '#67e8f9' };

export class PitchCanvas {
  constructor(canvas, { past = 3, future = 5 } = {}) {
    this.c = canvas;
    this.g = canvas.getContext('2d');
    this.past = past;
    this.future = future;
    this.min = 52;
    this.max = 72;
    this.resize();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
  }

  destroy() {
    this.ro.disconnect();
  }

  resize() {
    const r = this.c.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = Math.max(50, r.width);
    this.h = Math.max(50, r.height);
    this.c.width = Math.round(this.w * dpr);
    this.c.height = Math.round(this.h * dpr);
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.last) this.draw(this.last);
  }

  fitTargets(targets, pad = 3) {
    const sing = targets.length ? targets : [{ midi: 60 }];
    let lo = Infinity;
    let hi = -Infinity;
    for (const t of sing) {
      lo = Math.min(lo, t.midi, t.glideTo ?? t.midi);
      hi = Math.max(hi, t.midi, t.glideTo ?? t.midi);
    }
    this.setView(lo - pad, hi + pad);
  }

  setView(lo, hi, minSpan = 12) {
    if (hi - lo < minSpan) {
      const c = (lo + hi) / 2;
      lo = c - minSpan / 2;
      hi = c + minSpan / 2;
    }
    this.min = lo;
    this.max = hi;
  }

  /** Free-sing mode: keep the voice in view by easing the window toward it. */
  follow(midi) {
    if (midi == null) return;
    const span = this.max - this.min;
    const margin = Math.min(3, span * 0.2);
    let shift = 0;
    if (midi < this.min + margin) shift = midi - (this.min + margin);
    else if (midi > this.max - margin) shift = midi - (this.max - margin);
    if (shift) {
      this.min += shift * 0.15;
      this.max += shift * 0.15;
    }
  }

  y(m) {
    const top = 12;
    const bottom = this.h - 14;
    return bottom - ((m - this.min) / (this.max - this.min)) * (bottom - top);
  }

  get laneH() {
    return (this.h - 26) / (this.max - this.min);
  }

  /**
   * @param {object} s
   * @param {number} s.now            current time on the exercise clock (s)
   * @param {Array}  [s.targets]      [{midi, start, dur, glideTo?, role, lyric?}]
   * @param {Array}  [s.trail]        [{t, m (plotted midi | null), col}]
   * @param {(i:number)=>boolean|undefined} [s.result]  per-target pass/fail once sung
   * @param {number} [s.tolerance]
   */
  draw(s) {
    this.last = s;
    const { g, w, h } = this;
    const { now, targets = [], trail = [], result, tolerance = 50 } = s;
    const pps = (w - GUTTER) / (this.past + this.future);
    const nowX = GUTTER + this.past * pps;
    const x = (t) => nowX + (t - now) * pps;
    const lane = this.laneH;

    // Background lanes.
    g.fillStyle = '#0c0c18';
    g.fillRect(0, 0, w, h);
    const lo = Math.floor(this.min);
    const hi = Math.ceil(this.max);
    g.font = '600 10px ui-sans-serif, system-ui, sans-serif';
    g.textBaseline = 'middle';
    for (let m = lo; m <= hi; m++) {
      const yc = this.y(m);
      if (isBlackKey(m)) {
        g.fillStyle = 'rgba(0,0,0,0.28)';
        g.fillRect(GUTTER, yc - lane / 2, w - GUTTER, lane);
      }
      if (m % 12 === 0) {
        g.fillStyle = 'rgba(255,255,255,0.07)';
        g.fillRect(GUTTER, yc + lane / 2 - 1, w - GUTTER, 1);
      }
      const label = lane >= 13 || m % 12 === 0 || (lane >= 8 && !isBlackKey(m));
      if (label) {
        g.fillStyle = m % 12 === 0 ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.38)';
        g.fillText(noteName(m), 8, yc);
      }
    }
    g.fillStyle = 'rgba(255,255,255,0.05)';
    g.fillRect(GUTTER - 1, 0, 1, h);

    // Targets.
    const barH = Math.max(6, Math.min(lane * 0.78, 26));
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      if (t.start + t.dur < now - this.past - 0.5 || t.start > now + this.future + 0.5) continue;
      const x1 = x(t.start);
      const x2 = x(t.start + t.dur);
      const activeNow = now >= t.start && now < t.start + t.dur;
      const listen = t.role === 'listen';
      const passed = t.start + t.dur < now;
      const res = passed && !listen ? result?.(i) : undefined;
      let fill;
      let stroke = null;
      if (listen) {
        fill = 'rgba(34,211,238,0.10)';
        stroke = 'rgba(34,211,238,0.65)';
      } else if (res === true) fill = 'rgba(52,211,153,0.55)';
      else if (res === false) fill = 'rgba(248,113,113,0.45)';
      else if (passed) fill = 'rgba(160,160,190,0.25)';
      else {
        const grad = g.createLinearGradient(x1, 0, x2, 0);
        grad.addColorStop(0, activeNow ? '#c084fc' : '#7c3aed');
        grad.addColorStop(1, activeNow ? '#f472b6' : '#a855f7');
        fill = grad;
      }
      g.save();
      if (activeNow && !listen) {
        g.shadowColor = 'rgba(236,72,153,0.8)';
        g.shadowBlur = 18;
      }
      if (t.glideTo != null) {
        g.lineCap = 'round';
        g.lineWidth = barH;
        g.strokeStyle = typeof fill === 'string' ? fill : '#a855f7';
        if (listen) g.setLineDash([6, 6]);
        g.beginPath();
        g.moveTo(x1 + barH / 2, this.y(t.midi));
        g.lineTo(x2 - barH / 2, this.y(t.glideTo));
        g.stroke();
      } else {
        const y = this.y(t.midi) - barH / 2;
        roundRect(g, x1, y, Math.max(4, x2 - x1), barH, Math.min(barH / 2, 9));
        g.fillStyle = fill;
        g.fill();
        if (stroke) {
          g.setLineDash([5, 4]);
          g.strokeStyle = stroke;
          g.lineWidth = 1.5;
          g.stroke();
        }
      }
      g.restore();

      // Tolerance band on the note being sung right now.
      if (activeNow && !listen && t.glideTo == null) {
        const band = (tolerance / 100) * lane;
        g.fillStyle = 'rgba(52,211,153,0.08)';
        g.fillRect(x1, this.y(t.midi) - band, x2 - x1, band * 2);
      }
      if (t.lyric && x2 - x1 > 14) {
        g.font = `${activeNow ? '700' : '500'} 12px ui-sans-serif, system-ui, sans-serif`;
        g.fillStyle = activeNow ? '#fff' : 'rgba(255,255,255,0.6)';
        g.textBaseline = 'top';
        g.fillText(t.lyric, x1 + 2, this.y(t.midi) + barH / 2 + 3);
        g.textBaseline = 'middle';
      }
      if (listen && x2 - x1 > 22 && t.glideTo == null) {
        g.font = '11px ui-sans-serif, system-ui, sans-serif';
        g.fillText('🎧', x1 + 4, this.y(t.midi));
      }
    }

    // Now line.
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(236,72,153,0)');
    grad.addColorStop(0.5, 'rgba(236,72,153,0.9)');
    grad.addColorStop(1, 'rgba(236,72,153,0)');
    g.fillStyle = grad;
    g.fillRect(nowX - 1, 0, 2, h);

    // Voice trail.
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.lineWidth = 3.5;
    let prev = null;
    for (const p of trail) {
      if (p.t < now - this.past || p.t > now + 0.05) {
        prev = null;
        continue;
      }
      if (p.m == null) {
        prev = null;
        continue;
      }
      const px = x(p.t);
      const py = this.y(this.wrapIntoView(p.m));
      if (prev && p.t - prev.t < 0.1 && Math.abs(py - prev.py) < lane * 3) {
        g.strokeStyle = COLORS[p.col] || COLORS.free;
        g.beginPath();
        g.moveTo(prev.px, prev.py);
        g.lineTo(px, py);
        g.stroke();
      }
      prev = { t: p.t, px, py };
    }

    // Current voice dot.
    const lastP = trail[trail.length - 1];
    if (lastP && lastP.m != null && now - lastP.t < 0.15) {
      const py = this.y(this.wrapIntoView(lastP.m));
      const col = COLORS[lastP.col] || COLORS.free;
      g.save();
      g.shadowColor = col;
      g.shadowBlur = 16;
      g.fillStyle = col;
      g.beginPath();
      g.arc(nowX, py, 6.5, 0, Math.PI * 2);
      g.fill();
      g.restore();
      g.fillStyle = '#fff';
      g.beginPath();
      g.arc(nowX, py, 2.5, 0, Math.PI * 2);
      g.fill();
    }
  }

  /** Voices outside the window (e.g. an octave below the guide) are folded back into view. */
  wrapIntoView(m) {
    while (m < this.min - 1 && m + 12 <= this.max + 1) m += 12;
    while (m > this.max + 1 && m - 12 >= this.min - 1) m -= 12;
    return Math.max(this.min - 0.5, Math.min(this.max + 0.5, m));
  }
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
