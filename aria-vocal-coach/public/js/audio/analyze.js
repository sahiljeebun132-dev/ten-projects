// Decode song audio and extract its sung melody (in a worker).

const ANALYSIS_RATE = 22050;

/**
 * @param {ArrayBuffer} data  encoded audio (m4a / mp3 / wav / ogg ...)
 * @param {(p:number)=>void} onProgress
 * @returns {Promise<{buffer: AudioBuffer, notes: Array, key: object|null}>}
 */
export async function analyzeSong(data, onProgress = () => {}) {
  const decodeCtx = new OfflineAudioContext(2, 1, 44100);
  let buffer;
  try {
    buffer = await decodeCtx.decodeAudioData(data.slice(0));
  } catch {
    throw new Error('This browser could not decode that audio file. Try an MP3 or WAV.');
  }
  onProgress(0.05);

  // Resample to a light analysis rate and strip rumble below the vocal range.
  const frames = Math.ceil(buffer.duration * ANALYSIS_RATE);
  const stereo = buffer.numberOfChannels > 1;
  const off = new OfflineAudioContext(stereo ? 2 : 1, frames, ANALYSIS_RATE);
  const src = off.createBufferSource();
  src.buffer = buffer;
  const hp = off.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 70;
  src.connect(hp).connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  const left = rendered.getChannelData(0).slice();
  const right = stereo ? rendered.getChannelData(1).slice() : null;
  onProgress(0.1);

  const result = await new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./melody-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') onProgress(0.1 + m.p * 0.9);
      else {
        worker.terminate();
        if (m.type === 'done') resolve(m);
        else reject(new Error(m.message || 'Melody analysis failed.'));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || 'Melody analysis failed.'));
    };
    const transfer = [left.buffer];
    if (right) transfer.push(right.buffer);
    worker.postMessage({ left, right, sampleRate: ANALYSIS_RATE }, transfer);
  });

  return { buffer, notes: result.notes, key: result.key };
}
