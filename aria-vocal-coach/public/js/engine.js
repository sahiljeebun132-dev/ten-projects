// Shared audio engine (created on the first user gesture) + app-wide transient state.
import { VoiceInput } from './audio/input.js';
import { Guide } from './audio/guide.js';
import { state as store, setSetting } from './store.js';
import { modal } from './ui/dom.js';

export const engine = { ctx: null, input: null, guide: null };

/** Data handed from a lesson/song screen to the practice screen. */
export const handoff = { practice: null, songs: new Map() };

export function updateInputPill() {
  const pill = document.getElementById('input-pill');
  if (!pill) return;
  const demo = store.settings.input === 'demo';
  pill.textContent = demo ? '🤖 Demo voice' : '🎤 Microphone';
  pill.className = `pill ${demo ? 'cyan' : 'brand'}`;
}

/** Audio output only (guide tones / previews) — no microphone. Call from a click handler. */
export async function ensureContext() {
  if (!engine.ctx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    engine.ctx = new Ctx({ latencyHint: 'interactive' });
    engine.input = new VoiceInput(engine.ctx);
    engine.guide = new Guide(engine.ctx);
  }
  if (engine.ctx.state !== 'running') await engine.ctx.resume();
  engine.guide.setVolume(store.settings.guideVolume);
  engine.guide.setTanpuraVolume(store.settings.tanpuraVolume);
  return engine.ctx;
}

/**
 * Start audio and connect the chosen voice input. Must be called from a click handler.
 * Resolves to the engine, or null if the user cancelled after a mic error.
 */
export async function ensureAudio() {
  await ensureContext();
  if (store.settings.input === 'demo') {
    engine.input.useDemo();
    return engine;
  }
  try {
    await engine.input.useMic();
    return engine;
  } catch (err) {
    const choice = await micErrorDialog(err);
    if (choice === 'mic') return engine;
    if (choice !== 'demo') return null;
    setSetting('input', 'demo');
    updateInputPill();
    engine.input.useDemo();
    return engine;
  }
}

/** Resolves 'mic' (retry worked), 'demo' (switch to demo voice) or 'cancel'. */
function micErrorDialog(err) {
  const denied = err?.name === 'NotAllowedError' || err?.name === 'SecurityError';
  const missing = err?.name === 'NotFoundError' || err?.name === 'OverconstrainedError';
  const why = denied
    ? 'Microphone permission was blocked. Click the 🔒 / mic icon in the address bar and allow the microphone, then try again.'
    : missing
      ? 'No microphone was found. Plug in a mic or headset and try again.'
      : err?.message || 'The microphone could not be started.';
  return new Promise((resolve) => {
    let picked = false;
    const m = modal(
      `<h2>🎤 Microphone needed</h2>
       <p class="muted">${why}</p>
       <p class="small dim">Tip: headphones give the most accurate coaching — the mic won’t hear the guide tones.</p>
       <div class="row" style="margin-top:16px">
         <button class="btn" data-act="retry">Try again</button>
         <button class="btn ghost" data-act="demo">Use the demo voice</button>
       </div>`,
      { onClose: () => !picked && resolve('cancel') },
    );
    m.el.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      picked = true;
      m.close();
      if (act === 'demo') return resolve('demo');
      try {
        await engine.input.useMic();
        resolve('mic');
      } catch (e2) {
        resolve(await micErrorDialog(e2));
      }
    });
  });
}

let speakUntil = 0;
/** Optional spoken coaching (Settings → Spoken coaching). */
export function speak(text, { force = false, minGap = 2.2 } = {}) {
  if (!store.settings.speak || !('speechSynthesis' in window)) return;
  const now = performance.now() / 1000;
  if (!force && now < speakUntil) return;
  speakUntil = now + minGap;
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.08;
  u.volume = 0.9;
  if (force) speechSynthesis.cancel();
  speechSynthesis.speak(u);
}
