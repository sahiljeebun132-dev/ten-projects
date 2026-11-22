// YIN fundamental-frequency estimator (de Cheveigné & Kawahara, 2002).
// Pure function factory so it runs in the browser and in Node tests alike.

export function createPitchDetector({
  sampleRate,
  bufferSize = 2048,
  minFreq = 65, // C2 — low enough for basses
  maxFreq = 1100, // C#6 — high enough for sopranos
  threshold = 0.12,
  silence = 0.006, // RMS below this is treated as silence
} = {}) {
  if (!sampleRate) throw new Error('sampleRate is required');
  const tauMaxCap = Math.min(Math.floor(sampleRate / minFreq), Math.floor(bufferSize / 2));
  const tauMin = Math.max(2, Math.floor(sampleRate / maxFreq));
  const diff = new Float32Array(tauMaxCap + 2);
  const cmnd = new Float32Array(tauMaxCap + 2);

  return function detect(buf) {
    const n = buf.length;
    let sumSq = 0;
    for (let i = 0; i < n; i++) sumSq += buf[i] * buf[i];
    const rms = Math.sqrt(sumSq / n);
    if (rms < silence) return { freq: 0, clarity: 0, rms };

    const tauMax = Math.min(tauMaxCap, Math.floor(n / 2));
    const w = n - tauMax;

    // 1. Difference function.
    for (let tau = 1; tau <= tauMax; tau++) {
      let s = 0;
      for (let i = 0; i < w; i++) {
        const d = buf[i] - buf[i + tau];
        s += d * d;
      }
      diff[tau] = s;
    }

    // 2. Cumulative mean normalised difference.
    cmnd[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= tauMax; tau++) {
      running += diff[tau];
      cmnd[tau] = running > 0 ? (diff[tau] * tau) / running : 1;
    }

    // 3. Absolute threshold: first dip under the threshold, then its local minimum.
    let tau = -1;
    for (let t = tauMin; t <= tauMax; t++) {
      if (cmnd[t] < threshold) {
        while (t + 1 <= tauMax && cmnd[t + 1] < cmnd[t]) t++;
        tau = t;
        break;
      }
    }
    if (tau < 0) {
      let best = tauMin;
      for (let t = tauMin + 1; t <= tauMax; t++) if (cmnd[t] < cmnd[best]) best = t;
      if (cmnd[best] > 0.3) return { freq: 0, clarity: Math.max(0, 1 - cmnd[best]), rms };
      tau = best;
    }

    // 4. Parabolic interpolation for sub-sample accuracy.
    let better = tau;
    if (tau > 1 && tau < tauMax) {
      const a = cmnd[tau - 1];
      const b = cmnd[tau];
      const c = cmnd[tau + 1];
      const denom = a - 2 * b + c;
      if (denom !== 0) better = tau + (0.5 * (a - c)) / denom;
    }
    return { freq: sampleRate / better, clarity: Math.max(0, 1 - cmnd[tau]), rms };
  };
}
