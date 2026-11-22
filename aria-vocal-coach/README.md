# 🎤 Aria — live singing coach

Aria listens to your voice in real time and coaches you from your very first note to solo performance — even if you think you can't sing. It teaches the Western way (lessons) and the Indian way (riyaaz with a tanpura and sargam), and an AI teacher learns the style of singers you love and coaches you towards it.

## Run it

```bash
cd aria-vocal-coach
npm start          # → http://localhost:5190
npm test           # 41 tests: pitch, melody, scoring, coach, riyaaz, style learning, teacher, server security
```

No dependencies — just Node 20+. Open the URL in Chrome/Edge and allow the microphone. **Headphones give the most accurate coaching** (the mic won't hear the guide tones or tanpura). No mic? Settings → **Demo voice** runs a simulated singer so you can try everything.

## What it does

| Feature | How |
| --- | --- |
| **Find your voice** | 1-minute range test → your lowest/highest notes and voice type (Bass … Soprano). Every exercise and song is then pitched for *your* range, and your Sa is suggested from it. |
| **Live coaching** | Real-time pitch detection (YIN) shows your voice as a line over the target notes, plus cues: *Go higher ⬆ · Go lower ⬇ · Perfect — hold it · Steady it · A little louder · Beautiful vibrato*. Optional spoken cues. |
| **🧑‍🏫 AI vocal teacher** | Remembers every take, spots habits across takes (flat/sharp, wobble, scoops, late entries, short breath, blurry runs) and gives you a lesson plan with exercises to fix them. After each take: one praise, one fix, one next step — and how you did against your last try. |
| **Learn a singer's style** | Type a singer (Arijit Singh, Justin Bieber, anyone) or give it your own recordings. Aria analyses their songs and measures *how* they sing — vibrato rate and use, murkis/riffs, meend (slides), scoops, breath per phrase, note speed, high-note use — into a style profile. Then: style drills built from that profile, a style-match score when you sing, and tips in their terms. |
| **🪔 Riyaaz** | Daily practice the Hindustani way: an electronic tanpura on *your* Sa, sargam notation (Sa Re Ga, komal/tivra, mandra/taar marks), Omkar, Sa–Pa–Sa, Swar pehchaan, Aaroh–Avroh, Dum test, Kharaj, Alankars, Meend, Taan, Taar saptak — and **Awaaz kholna**, gentle work across the chest ↔ head “break”. 5 stages (Shuruaat → Swarna) that unlock with riyaaz days and your sur. |
| **✨ Golden-voice meter** | Seven parts of a trained voice — Sur, Thehraav, Dum, Vistaar, Kharaj, Pul (smooth break), Niyam (consistency) — that fill up with weeks of practice, not one good take. |
| **Beginner → Master path** | 5 levels × 4 lessons: breath, pitch matching, sirens, scales, intervals, arpeggios, crescendo, vibrato, agility runs, chromatic precision and solo songs. |
| **Songs — Hindi & world** | Search Apple's India or global catalogue (Devanagari works too), browse live Indian charts (Bollywood, Indian Pop, Sufi & Ghazals, Bhakti, Classical) or tap a singer. Aria extracts the sung melody from the track, detects its key and Sa, and coaches you: with the original, in your key, or **in your Sa** with the tanpura. Upload full songs or a cappella files too. |
| **Progress** | XP, streaks, skill bars, unlockable lessons and riyaaz stages, learned styles — saved in the browser. |

## How the audio works

- `public/js/audio/pitch.js` — YIN fundamental-frequency detector (±5¢ on test tones).
- `public/js/audio/melody.js` — melody extraction from mixed audio: centre-channel weighting, harmonic-summation salience, Viterbi pitch tracking, note segmentation. Runs in a Web Worker.
- `public/js/audio/style.js` — vocal style analysis from any pitch track (held notes, vibrato, ornament turns, slides, scoops, phrasing), profile aggregation, comparison and style drills.
- `public/js/audio/teacher.js` — the teacher's reasoning: condensed take memory, diagnosis across takes, lesson plans, post-take feedback.
- `public/js/data/riyaaz.js` / `audio/sargam.js` — riyaaz exercises built around your Sa (always kept within your measured range ±1 semitone), stages, the golden-voice meter, sargam naming and harmonium scales.
- `public/js/audio/guide.js` — guide tones and the tanpura (Pa–Sa–Sa–Sa cycle with a jawari-like buzz).

## Honest limits

- **The AI teacher is analysis, not a chatbot.** It measures your singing and the singers you choose, and reasons over those measurements with rules a voice teacher would use. It runs entirely on your device; no language model or API key is involved.
- **It teaches technique, it doesn't clone voices.** Style profiles describe how someone sings; Aria never imitates or synthesises a real artist's voice.
- **Style from previews is approximate.** Profiles come from the melody extracted from 30-second mixed previews (or your files). Clear lead vocals work best; dense mixes add noise. Breath per phrase can't be seen inside a full mix (the backing hides the breaths), so it's left out rather than guessed — a cappella files give the fullest profile.
- **Voice safety.** Riyaaz never pushes more than a semitone past your measured range, and the app says plainly: never “break” the voice by shouting or forcing. Pain or hoarseness lasting two weeks needs an ENT doctor.
- Song search covers Apple's preview catalogue only (no YouTube downloading — that breaks YouTube's terms). Mic access needs `localhost` or HTTPS, so for a phone, host it behind HTTPS.

## Security

The server only serves `public/` (path-traversal safe), sends a strict CSP and security headers, and its audio proxy fetches **only** HTTPS Apple preview hosts (no redirects, size and type limits), so it can't be abused as an open proxy. Search markets and chart shelves are fixed allowlists (own-key lookups, so `constructor` / `__proto__` can't slip through); chart and search results keep only Apple preview links. All song metadata and singer names are HTML-escaped before rendering.
