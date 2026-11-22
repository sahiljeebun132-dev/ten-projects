// Predominant-melody extraction from (mixed) song audio.
//
// Pipeline (a lightweight take on salience-based melody extraction):
//   1. STFT of left/right. Each bin is weighted by how centre-panned it is —
//      lead vocals are almost always mixed to the centre, many instruments are not.
//   2. Spectral peaks -> harmonic-summation salience over a 10-cent pitch grid.
//   3. Top candidates per frame -> Viterbi path with a pitch-jump penalty.
//   4. Median smoothing, then segmentation into discrete notes.
//
// Pure JS with no DOM access: runs inside a Web Worker and in Node tests.

import { createFFT } from './fft.js';
import { freqToMidi, median, percentile } from './notes.js';

const MIN_MIDI = 43; // G2
const MAX_MIDI = 84; // C6
const STEP = 0.1; // salience grid resolution in semitones
const N_BINS = Math.round((MAX_MIDI - MIN_MIDI) / STEP) + 1;
const HARMONICS = 10;
const HARMONIC_DECAY = 0.8;
const MAX_PEAKS = 30;
const CANDIDATES = 5;

export function extractMelody({ left, right = null, sampleRate, frameSize = 2048, hop = 256, onProgress } = {}) {
  if (!left || !sampleRate) throw new Error('left channel and sampleRate are required');
  const n = frameSize;
  const half = n >> 1;
  const fft = createFFT(n);
  const win = new Float64Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));

  const reL = new Float64Array(n);
  const imL = new Float64Array(n);
  const reR = new Float64Array(n);
  const imR = new Float64Array(n);
  const mag = new Float64Array(half);
  const sal = new Float64Array(N_BINS);

  const len = left.length;
  const numFrames = len >= n ? Math.floor((len - n) / hop) + 1 : 0;
  const kMin = Math.max(1, Math.ceil((55 * n) / sampleRate));
  const kMax = Math.min(half - 2, Math.floor((5000 * n) / sampleRate));
  const kE0 = Math.ceil((100 * n) / sampleRate);
  const kE1 = Math.floor((3000 * n) / sampleRate);

  const candMidi = new Float32Array(numFrames * CANDIDATES).fill(NaN);
  const candSal = new Float32Array(numFrames * CANDIDATES);
  const frameMax = new Float32Array(numFrames);
  const frameEnergy = new Float32Array(numFrames);
  const peakF = new Float64Array(512);
  const peakA = new Float64Array(512);
  const harmW = Array.from({ length: HARMONICS }, (_, h) => Math.pow(HARMONIC_DECAY, h));

  for (let f = 0; f < numFrames; f++) {
    const off = f * hop;
    for (let i = 0; i < n; i++) {
      reL[i] = left[off + i] * win[i];
      imL[i] = 0;
    }
    fft(reL, imL);
    if (right) {
      for (let i = 0; i < n; i++) {
        reR[i] = right[off + i] * win[i];
        imR[i] = 0;
      }
      fft(reR, imR);
    }

    // Centre-weighted magnitude spectrum.
    let energy = 0;
    let maxMag = 0;
    for (let k = kMin - 1; k <= kMax + 1; k++) {
      let m;
      if (right) {
        const mr = (reL[k] + reR[k]) * 0.5;
        const mi = (imL[k] + imR[k]) * 0.5;
        const mid = Math.hypot(mr, mi);
        const side = Math.hypot(reL[k] - reR[k], imL[k] - imR[k]);
        const w = Math.max(0, 1 - side / (2 * mid + 1e-12));
        m = mid * w * w;
      } else {
        m = Math.hypot(reL[k], imL[k]);
      }
      if (k >= kE0 && k <= kE1) energy += m * m;
      m = Math.sqrt(m); // dynamic-range compression
      mag[k] = m;
      if (k >= kMin && k <= kMax && m > maxMag) maxMag = m;
    }
    frameEnergy[f] = energy;

    // Spectral peaks with parabolic interpolation (on log magnitude).
    let np = 0;
    const floor = maxMag * 0.1;
    for (let k = kMin; k <= kMax; k++) {
      const b = mag[k];
      if (b > floor && b > mag[k - 1] && b >= mag[k + 1] && np < peakF.length) {
        const la = Math.log(mag[k - 1] + 1e-12);
        const lb = Math.log(b + 1e-12);
        const lc = Math.log(mag[k + 1] + 1e-12);
        const denom = la - 2 * lb + lc;
        const delta = denom !== 0 ? (0.5 * (la - lc)) / denom : 0;
        peakF[np] = ((k + delta) * sampleRate) / n;
        peakA[np] = b;
        np++;
      }
    }
    // Keep only the strongest peaks.
    let order = Array.from({ length: np }, (_, i) => i);
    if (np > MAX_PEAKS) order = order.sort((a, b) => peakA[b] - peakA[a]).slice(0, MAX_PEAKS);

    // Harmonic summation salience.
    sal.fill(0);
    for (const p of order) {
      const pf = peakF[p];
      const pa = peakA[p];
      for (let h = 1; h <= HARMONICS; h++) {
        const m0 = freqToMidi(pf / h);
        if (m0 < MIN_MIDI - 1) break;
        if (m0 > MAX_MIDI + 1) continue;
        const c = (m0 - MIN_MIDI) / STEP;
        const b0 = Math.max(0, Math.ceil(c - 1 / STEP));
        const b1 = Math.min(N_BINS - 1, Math.floor(c + 1 / STEP));
        const wh = pa * harmW[h - 1];
        for (let b = b0; b <= b1; b++) {
          const d = Math.abs(b - c) * STEP;
          const cw = Math.cos((Math.PI * d) / 2);
          sal[b] += wh * cw * cw;
        }
      }
    }

    // Top local maxima of the salience function.
    let fMax = 0;
    for (let j = 0; j < CANDIDATES; j++) {
      let best = -1;
      let bestV = 0;
      for (let b = 1; b < N_BINS - 1; b++) {
        const v = sal[b];
        if (v > bestV && v >= sal[b - 1] && v >= sal[b + 1]) {
          best = b;
          bestV = v;
        }
      }
      if (best < 0) break;
      candMidi[f * CANDIDATES + j] = MIN_MIDI + best * STEP;
      candSal[f * CANDIDATES + j] = bestV;
      if (j === 0) fMax = bestV;
      // Suppress ±0.6 semitone around the chosen peak before looking for the next.
      const r = Math.round(0.6 / STEP);
      for (let b = Math.max(0, best - r); b <= Math.min(N_BINS - 1, best + r); b++) sal[b] = 0;
    }
    frameMax[f] = fMax;

    if (onProgress && f % 200 === 0) onProgress(f / numFrames);
  }

  // Voicing: frames whose salience and energy are a reasonable fraction of the loud parts.
  const salRef = percentile(Array.from(frameMax), 80) || 0;
  const energyRef = percentile(Array.from(frameEnergy), 90) || 0;
  const voiced = new Uint8Array(numFrames);
  for (let f = 0; f < numFrames; f++) {
    voiced[f] = frameMax[f] > 0 && frameMax[f] >= 0.3 * salRef && frameEnergy[f] >= 0.02 * energyRef ? 1 : 0;
  }

  // Viterbi over candidates, within each voiced run.
  const contour = new Float32Array(numFrames).fill(NaN);
  const back = new Int8Array(numFrames * CANDIDATES);
  const score = new Float64Array(CANDIDATES);
  const next = new Float64Array(CANDIDATES);
  let f = 0;
  while (f < numFrames) {
    if (!voiced[f] || Number.isNaN(candMidi[f * CANDIDATES])) {
      f++;
      continue;
    }
    const start = f;
    for (let j = 0; j < CANDIDATES; j++) score[j] = emission(f, j);
    f++;
    while (f < numFrames && voiced[f] && !Number.isNaN(candMidi[f * CANDIDATES])) {
      for (let j = 0; j < CANDIDATES; j++) {
        const mj = candMidi[f * CANDIDATES + j];
        if (Number.isNaN(mj)) {
          next[j] = -Infinity;
          continue;
        }
        let best = -Infinity;
        let arg = 0;
        for (let i = 0; i < CANDIDATES; i++) {
          if (score[i] === -Infinity) continue;
          const mi = candMidi[(f - 1) * CANDIDATES + i];
          const v = score[i] - jumpPenalty(mj - mi);
          if (v > best) {
            best = v;
            arg = i;
          }
        }
        next[j] = best + emission(f, j);
        back[f * CANDIDATES + j] = arg;
      }
      score.set(next);
      f++;
    }
    // Backtrack this run.
    let j = 0;
    for (let k = 1; k < CANDIDATES; k++) if (score[k] > score[j]) j = k;
    for (let g = f - 1; g >= start; g--) {
      contour[g] = candMidi[g * CANDIDATES + j];
      j = back[g * CANDIDATES + j];
    }
  }

  function emission(fr, j) {
    const m = candMidi[fr * CANDIDATES + j];
    if (Number.isNaN(m)) return -Infinity;
    return Math.log(candSal[fr * CANDIDATES + j] / (frameMax[fr] + 1e-12) + 1e-9);
  }

  const smooth = medianSmooth(contour, 5);
  const hopSec = hop / sampleRate;
  const offsetSec = n / 2 / sampleRate;
  const notes = segmentNotes(smooth, hopSec, offsetSec);
  if (onProgress) onProgress(1);
  return { contour: smooth, hopSec, offsetSec, notes };
}

function jumpPenalty(d) {
  const a = Math.abs(d);
  return 0.08 * Math.min(a, 24) + (a > 0.7 ? 0.35 : 0);
}

function medianSmooth(src, size) {
  const out = new Float32Array(src.length).fill(NaN);
  const h = size >> 1;
  for (let i = 0; i < src.length; i++) {
    if (Number.isNaN(src[i])) continue;
    const win = [];
    for (let k = i - h; k <= i + h; k++) if (k >= 0 && k < src.length && !Number.isNaN(src[k])) win.push(src[k]);
    out[i] = median(win);
  }
  return out;
}

/** Turn a per-frame pitch contour into discrete notes {midi, start, dur}. */
export function segmentNotes(contour, hopSec, offsetSec = 0, { minDur = 0.09, splitSemis = 0.75, splitFrames = 4, gapFrames = 3 } = {}) {
  const notes = [];
  let cur = null; // { startFrame, endFrame, pitches }
  let devRun = 0;
  let gapRun = 0;

  const close = () => {
    if (!cur) return;
    const dur = (cur.endFrame - cur.startFrame + 1) * hopSec;
    if (dur >= minDur) {
      notes.push({ midi: Math.round(median(cur.pitches)), start: offsetSec + cur.startFrame * hopSec, dur });
    }
    cur = null;
  };

  for (let i = 0; i < contour.length; i++) {
    const m = contour[i];
    if (Number.isNaN(m)) {
      gapRun++;
      if (gapRun >= gapFrames) close();
      continue;
    }
    gapRun = 0;
    if (!cur) {
      cur = { startFrame: i, endFrame: i, pitches: [m] };
      devRun = 0;
      continue;
    }
    const ref = median(cur.pitches.slice(-12));
    if (Math.abs(m - ref) > splitSemis) {
      devRun++;
      if (devRun >= splitFrames) {
        // The last few frames belong to the new note.
        const keep = cur.pitches.length - (devRun - 1);
        const newStart = cur.endFrame - (devRun - 2);
        const tail = cur.pitches.slice(keep);
        cur.pitches = cur.pitches.slice(0, keep);
        cur.endFrame = newStart - 1;
        close();
        cur = { startFrame: newStart, endFrame: i, pitches: [...tail, m] };
        devRun = 0;
        continue;
      }
    } else {
      devRun = 0;
    }
    cur.pitches.push(m);
    cur.endFrame = i;
  }
  close();

  // Merge same-pitch notes separated by tiny gaps.
  const merged = [];
  for (const nt of notes) {
    const prev = merged[merged.length - 1];
    if (prev && prev.midi === nt.midi && nt.start - (prev.start + prev.dur) < 0.06) {
      prev.dur = nt.start + nt.dur - prev.start;
    } else {
      merged.push({ ...nt });
    }
  }
  return merged;
}
