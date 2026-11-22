# 🎤 Aria — live singing coach

Aria listens to your voice in real time and coaches you from your very first note to solo performance — even if you think you can't sing.

## Run it

```bash
cd aria-vocal-coach
npm start          # → http://localhost:5190
npm test           # 19 tests: pitch detection, melody extraction, scoring, coach, server security
```

No dependencies — just Node 20+. Open the URL in Chrome/Edge and allow the microphone. **Headphones give the most accurate coaching** (the mic won't hear the guide tones). No mic? Settings → **Demo voice** runs a simulated singer so you can try everything.

## What it does

| Feature | How |
| --- | --- |
| **Find your voice** | 1-minute range test → your lowest/highest notes and voice type (Bass … Soprano). Every exercise and song is then pitched for *your* range. |
| **Live coaching** | Real-time pitch detection (YIN) shows your voice as a line over the target notes, plus cues: *Go higher ⬆ · Go lower ⬇ · Perfect — hold it · Steady it · A little louder · Beautiful vibrato*. Optional spoken cues. |
| **Beginner → Master path** | 5 levels × 4 lessons: breath & sustain, pitch matching, sirens, scales, intervals, arpeggios, crescendo, vibrato, agility runs, chromatic precision, and solo (no-guide) songs. Each lesson teaches the technique first; tolerance tightens from ±50¢ to ±25¢. |
| **Feedback after every take** | Score, stars, note-by-note hits, and specific teaching tips — e.g. "you lean flat", "you scoop into notes", "high notes drift", "you come in late". Hear your recorded take back. |
| **Songs from the web** | Search almost any song (Apple's free 30-second previews). Aria extracts the sung melody from the mixed track, detects its key and range, and coaches you onto the singer's notes — with the original track, or as a guide melody transposed into your key. |
| **Your own audio** | Upload any song or a cappella recording — analysed locally, nothing uploaded. |
| **Progress** | XP, daily streak, skill bars (pitch, steadiness, timing, agility), unlockable lessons — saved in the browser. |

## How the audio works

- `public/js/audio/pitch.js` — YIN fundamental-frequency detector (±5¢ on test tones).
- `public/js/audio/melody.js` — melody extraction from mixed audio: centre-channel weighting (lead vocals are usually panned centre), harmonic-summation salience, Viterbi pitch tracking, note segmentation. Runs in a Web Worker.
- `public/js/audio/scoring.js` / `coach.js` — octave-tolerant scoring (sing a song an octave lower and still get credit), stability, timing, scoops, vibrato and crescendo detection, and the rules behind the live cues and tips.

**Limits:** melody extraction from full mixes is best-effort — clear lead vocals work well; dense mixes or instrumental leads can confuse it. Song search only covers Apple's preview catalogue (no YouTube downloading — that breaks YouTube's terms). Mic access needs `localhost` or HTTPS, so for a phone, host it behind HTTPS.

## Security

The server only serves `public/` (path-traversal safe), sends a strict CSP and security headers, and its audio proxy fetches **only** HTTPS Apple preview hosts (no redirects, size and type limits), so it can't be abused as an open proxy. All song metadata is HTML-escaped before rendering.
