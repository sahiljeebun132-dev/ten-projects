// Runs melody extraction off the main thread.
import { extractMelody } from './melody.js';
import { detectKey } from './key.js';

self.onmessage = (e) => {
  const { left, right, sampleRate } = e.data;
  try {
    const out = extractMelody({
      left,
      right,
      sampleRate,
      onProgress: (p) => self.postMessage({ type: 'progress', p }),
    });
    self.postMessage({ type: 'done', notes: out.notes, key: detectKey(out.notes) });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err?.message || err) });
  }
};
