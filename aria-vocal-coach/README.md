# 🎤 Aria — live singing coach

Aria listens to your voice in real time and coaches you from your very first note to solo performance — even if you think you can't sing. It teaches the Western way (lessons) and the Indian way (riyaaz with a tanpura and sargam), and an AI teacher learns the style of singers you love and coaches you towards it.

## Run it

```bash
cd aria-vocal-coach
npm install        # one dependency: the official Anthropic SDK (for the talking teacher)
npm start          # → http://localhost:5190
npm test           # 75 tests: pitch, melody, scoring, coach, riyaaz, style learning, teacher, chat, live lessons, server security
```

Node 20+. Open the URL in Chrome/Edge and allow the microphone. **Headphones give the most accurate coaching** (the mic won't hear the guide tones or tanpura). No mic? Settings → **Demo voice** runs a simulated singer so you can try everything.

### Switch on the talking teacher (optional)

Everything except the chat and live lessons works offline. To talk to the teacher or take a live lesson, give Aria a Claude API key (from console.anthropic.com) when you start it:

```powershell
$env:ANTHROPIC_API_KEY = "sk-ant-..."; npm start
```

The key stays in the server process — the browser never sees it. Each question is a Claude API call billed to your Anthropic account; a live lesson makes about one call per take (a 15-minute lesson is typically 8–12 calls). Optional settings: `ARIA_TEACHER_MODEL` (default `claude-opus-5-5`), `ARIA_TEACHER_EFFORT` (`low` default — quick, conversational answers; `medium`/`high` think longer), `ARIA_TEACHER_MAX_TOKENS` (default 8000), `ARIA_TEACHER_DAILY_CAP` (questions per day, default 300).

## What it does

| Feature | How |
| --- | --- |
| **Find your voice** | 1-minute range test → your lowest/highest notes and voice type (Bass … Soprano). Every exercise and song is then pitched for *your* range, and your Sa is suggested from it. |
| **Live coaching** | Real-time pitch detection (YIN) shows your voice as a line over the target notes, plus cues: *Go higher ⬆ · Go lower ⬇ · Perfect — hold it · Steady it · A little louder · Beautiful vibrato*. Optional spoken cues. |
| **🎓 Live lessons** | Your teacher (Claude) leads a 10, 15 or 20-minute lesson. It picks each exercise and puts it on your screen with one thing to focus on, then listens to every take: it reads the score and a note-by-note list, and looks at a picture of your pitch line over the target notes. Then it says what went well and what to change, and decides what's next: repeat, step back or move on. It wraps up with a recap and homework, and remembers recent lessons next time. Leave mid-lesson and it waits for you to come back. Needs the range test first, so every exercise fits your voice. |
| **💬 Talking teacher** | Chat with your teacher (Claude) by typing or speaking; replies stream in and are read aloud. It sees your practice data — range, Sa, riyaaz stage, golden-voice meter, recent takes, the app's diagnosis and learned singer styles — and answers like a guru: explains why, plans your week, and drops exercise buttons (riyaaz, lessons, style drills) straight into the reply. After any take, **Ask the teacher about this take**. |
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
- `teacher-lesson.js` (server) — live lessons: Claude gets two tools, `start_exercise` and `finish_lesson`, which the browser carries out. Every tool call is checked against the exercise catalogue and what the student has unlocked; a bad call goes back to Claude to fix. The transcript stays on the server and only grows (Claude's thinking goes back unchanged). Every take adds the score, the note-by-note list and a PNG of the pitch line (`public/js/ui/takeImage.js`).
- `public/js/data/riyaaz.js` / `audio/sargam.js` — riyaaz exercises built around your Sa (always kept within your measured range ±1 semitone), stages, the golden-voice meter, sargam naming and harmonium scales.
- `public/js/audio/guide.js` — guide tones and the tanpura (Pa–Sa–Sa–Sa cycle with a jawari-like buzz).

## Honest limits

- **Two kinds of teacher.** The lesson plan, diagnosis, style learning and post-take feedback are on-device analysis — rules a voice teacher would use, no AI service involved. The **talking teacher** and **live lessons** are Claude: the server sends your question, the recent conversation and a compact summary of your practice data (numbers like scores and ranges — never audio) to Anthropic's API, and in a live lesson each take's numbers plus a picture of your pitch line. It can't hear you; it reasons from those measurements and the picture, and its answers are AI-generated.
- **It teaches technique, it doesn't clone voices.** Style profiles describe how someone sings; Aria never imitates or synthesises a real artist's voice.
- **Style from previews is approximate.** Profiles come from the melody extracted from 30-second mixed previews (or your files). Clear lead vocals work best; dense mixes add noise. Breath per phrase can't be seen inside a full mix (the backing hides the breaths), so it's left out rather than guessed — a cappella files give the fullest profile.
- **Voice safety.** Riyaaz never pushes more than a semitone past your measured range, and the app says plainly: never “break” the voice by shouting or forcing. Pain or hoarseness lasting two weeks needs an ENT doctor.
- Song search covers Apple's preview catalogue only (no YouTube downloading — that breaks YouTube's terms). Mic access needs `localhost` or HTTPS, so for a phone, host it behind HTTPS.

## Security

The server only serves `public/` (path-traversal safe), sends a strict CSP and security headers, and its audio proxy fetches **only** HTTPS Apple preview hosts (no redirects, size and type limits), so it can't be abused as an open proxy. The Claude key lives only in the server process. `/api/teacher/chat` and `/api/teacher/lesson/*` answer only same-origin JSON POSTs addressed to localhost (a Host allowlist blocks DNS rebinding; an exact Origin check and a JSON-only content type stop other websites from spending your key), with body caps (64 KB; 512 KB for a lesson step carrying the pitch PNG), strict validation, per-minute and daily limits (every Claude call in a lesson counts, max 40 per lesson); lesson transcripts stay in server memory under unguessable ids, so the browser only ever adds the student's side; practice data is sent as data in the user turn, never as instructions, and exercise buttons in replies are allowlisted. Search markets and chart shelves are fixed allowlists (own-key lookups, so `constructor` / `__proto__` can't slip through); chart and search results keep only Apple preview links. All song metadata and singer names are HTML-escaped before rendering.
