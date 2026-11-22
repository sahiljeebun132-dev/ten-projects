// Runs melody extraction off the main thread.
import { extractMelody } from './melody.js';
import { detectKey } from './key.js';
import { analyzeStyle, contourPoints } from './style.js';

self.onmessage = (e) => {
  const { left, right, sampleRate } = e.data;
  try {
    const out = extractMelody({
      left,
      right,
      sampleRate,
      onProgress: (p) => self.postMessage({ type: 'progress', p }),
    });
    const style = analyzeStyle(contourPoints(out.contour, out.hopSec, out.offsetSec));
    self.postMessage({ type: 'done', notes: out.notes, key: detectKey(out.notes), style });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err?.message || err) });
  }
};
