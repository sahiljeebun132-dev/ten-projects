// A still picture of one take, for the teacher to look at: the target notes as bars and the
// student's pitch as a line coloured by how close it was. Returns base64 PNG (no data: prefix).
import { noteName } from '../audio/notes.js';

const W = 760;
const H = 320;
const PAD = { left: 64, right: 14, top: 40, bottom: 34 };
const COL = { bg: '#0b0b14', grid: 'rgba(255,255,255,0.07)', tonic: 'rgba(250,204,21,0.28)', text: '#cbd5e1', dim: '#7c8599', sing: 'rgba(168,85,247,0.55)', listen: '#22d3ee', good: '#34d399', ok: '#fbbf24', bad: '#f87171', free: '#94a3b8' };

/** The target pitch at time t (gliding targets move linearly), or null between notes. */
function targetAt(targets, t) {
  let best = null;
  for (const tg of targets) {
    if (t < tg.start || t >= tg.start + tg.dur) continue;
    if (best && best.role !== 'listen' && tg.role === 'listen') continue;
    best = tg;
  }
  if (!best) return null;
  if (best.glideTo == null) return best.midi;
  const k = Math.min(1, Math.max(0, (t - best.start) / best.dur));
  return best.midi + (best.glideTo - best.midi) * k;
}

/**
 * @param {object} o
 * @param {string} o.title
 * @param {Array}  o.targets   [{ midi, start, dur, glideTo?, role }]
 * @param {Array}  o.frames    [{ t, midi }] — midi null when unvoiced
 * @param {number} [o.tolerance] cents counted as in tune
 * @param {(m:number)=>string} [o.labelFn] lane labels (sargam when there's a Sa)
 * @param {number} [o.tonicPc] pitch class to highlight (the Sa)
 */
export function takeImage({ title, targets, frames, tolerance = 50, labelFn = noteName, tonicPc = null }) {
  if (typeof document === 'undefined' || !targets?.length) return null;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  if (!g) return null;

  let lo = Infinity;
  let hi = -Infinity;
  for (const t of targets) {
    lo = Math.min(lo, t.midi, t.glideTo ?? t.midi);
    hi = Math.max(hi, t.midi, t.glideTo ?? t.midi);
  }
  lo -= 3;
  hi += 3;
  if (hi - lo < 10) {
    const mid = (lo + hi) / 2;
    lo = mid - 5;
    hi = mid + 5;
  }
  const t0 = Math.max(0, Math.min(...targets.map((t) => t.start)) - 0.6);
  const t1 = Math.max(...targets.map((t) => t.start + t.dur)) + 0.6;
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const x = (t) => PAD.left + ((t - t0) / (t1 - t0)) * plotW;
  const y = (m) => PAD.top + ((hi - m) / (hi - lo)) * plotH;
  const lane = plotH / (hi - lo);

  g.fillStyle = COL.bg;
  g.fillRect(0, 0, W, H);
  g.font = '13px system-ui, sans-serif';
  g.textBaseline = 'middle';

  // Title and legend.
  g.fillStyle = COL.text;
  g.font = 'bold 14px system-ui, sans-serif';
  g.fillText(String(title || 'Take').slice(0, 48), PAD.left, 16);
  g.font = '12px system-ui, sans-serif';
  const legend = [
    [COL.sing, 'target (sing)'],
    [COL.listen, 'listen'],
    [COL.good, `voice ±${tolerance}¢`],
    [COL.ok, 'close'],
    [COL.bad, 'off'],
  ];
  let lx = W - PAD.right;
  for (let i = legend.length - 1; i >= 0; i--) {
    const [col, text] = legend[i];
    const w = g.measureText(text).width;
    lx -= w;
    g.fillStyle = COL.dim;
    g.fillText(text, lx, 16);
    lx -= 16;
    g.fillStyle = col;
    g.fillRect(lx, 11, 11, 10);
    lx -= 12;
  }

  // Note lanes, labelled.
  const every = hi - lo > 18 ? 2 : 1;
  for (let m = Math.ceil(lo); m <= Math.floor(hi); m++) {
    const tonic = tonicPc != null && ((m % 12) + 12) % 12 === tonicPc;
    g.strokeStyle = tonic ? COL.tonic : COL.grid;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(PAD.left, y(m));
    g.lineTo(W - PAD.right, y(m));
    g.stroke();
    if (tonic || m % every === 0) {
      g.fillStyle = tonic ? '#facc15' : COL.dim;
      g.textAlign = 'right';
      g.fillText(labelFn(m), PAD.left - 8, y(m));
      g.textAlign = 'left';
    }
  }

  // Time axis.
  const span = t1 - t0;
  const step = span > 40 ? 10 : span > 16 ? 5 : span > 8 ? 2 : 1;
  g.fillStyle = COL.dim;
  g.textAlign = 'center';
  for (let s = Math.ceil(t0 / step) * step; s <= t1; s += step) {
    g.fillText(`${s}s`, x(s), H - PAD.bottom + 18);
  }
  g.textAlign = 'left';

  // Target notes.
  const barH = Math.max(6, Math.min(16, lane * 0.7));
  for (const t of targets) {
    const x1 = x(t.start);
    const x2 = x(t.start + t.dur);
    if (t.glideTo != null) {
      g.strokeStyle = t.role === 'listen' ? COL.listen : COL.sing;
      g.lineWidth = barH;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(x1, y(t.midi));
      g.lineTo(x2, y(t.glideTo));
      g.stroke();
      g.lineCap = 'butt';
    } else if (t.role === 'listen') {
      g.strokeStyle = COL.listen;
      g.lineWidth = 1.5;
      g.setLineDash([5, 4]);
      g.strokeRect(x1, y(t.midi) - barH / 2, Math.max(2, x2 - x1), barH);
      g.setLineDash([]);
    } else {
      g.fillStyle = COL.sing;
      g.fillRect(x1, y(t.midi) - barH / 2, Math.max(2, x2 - x1), barH);
    }
  }

  // The voice: segments between voiced frames, coloured by distance from the target.
  g.lineWidth = 2.4;
  g.lineJoin = 'round';
  let prev = null;
  for (const f of frames || []) {
    if (f.midi == null || f.t < t0 || f.t > t1) {
      prev = null;
      continue;
    }
    const m = Math.min(hi, Math.max(lo, f.midi));
    const tm = targetAt(targets, f.t);
    let col = COL.free;
    if (tm != null) {
      const cents = Math.abs(f.midi - tm) * 100;
      col = cents <= tolerance ? COL.good : cents <= tolerance * 2 ? COL.ok : COL.bad;
    }
    if (prev && f.t - prev.t < 0.12) {
      g.strokeStyle = col;
      g.beginPath();
      g.moveTo(x(prev.t), y(prev.m));
      g.lineTo(x(f.t), y(m));
      g.stroke();
    }
    prev = { t: f.t, m };
  }

  return c.toDataURL('image/png').split(',')[1] || null;
}
