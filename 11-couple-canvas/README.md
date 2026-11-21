# 11 · Scribble Us 💞

A tiny shared canvas for two phones. **Draw on yours and it appears live on your
partner's.** Leave silly sticky notes, send hearts and kisses, and get a notification
when they've left you something, even while the app is closed.

Stack: **Node + Express + Socket.IO + SQLite + Web Push**, with a vanilla-JS installable
web app (PWA). One codebase runs on iPhone, Android and desktop, with no app store and no
paid keys.

## Features

| | |
|---|---|
| ✏️ **Live mirrored drawing** | Every stroke streams point by point (~30 updates/s). Your partner watches the line appear as you draw, with a little pen marker showing where you are. |
| 📐 **Same picture on every phone** | Both phones share a 3:4 portrait "page" with coordinates stored as 0–1 fractions, so a doodle lands in the same spot whatever the screen size. |
| 📝 **Sticky notes** | Up to 140 characters, a sticker (🍕😘🥺…), a paper colour and ready-made funny lines. They pop onto the partner's canvas with a buzz. Either of you can peel one off. |
| 💗 **Nudges** | Heart / kiss / hug / poke: a burst of floating emoji plus vibration on their phone. |
| 🔔 **Background alerts** | While their app is closed or in the background, notes, nudges and "is doodling" (at most every 3 min) arrive as **push notifications**. |
| 🟢 **Presence** | Shows whether they're *here now*, have the *app in the background*, are *away*, or are *drawing…* |
| 🧽 Tools | 6 colours, 3 brush sizes, eraser, undo (your own lines only), clear for both. |
| 💾 Saved | The canvas and notes live in SQLite and come back after a reload or reconnect. |
| 🔗 **Private pairing** | One person gets a 6-character code and the other types it in. The code works **once**: a third person can't join. |

## Run it

```bash
cd 11-couple-canvas
npm install
npm start            # http://localhost:3000
npm run smoke        # 37-check end-to-end test (two simulated phones)
```

To try it on one computer, open `http://localhost:3000` in two browser windows (one of
them private, so each gets its own pairing). Tap **Start a new pair** in one window and
enter the code in the other.

## Putting it on two real phones

Phones only allow service workers, home-screen install and push notifications over
**HTTPS** (plain `http://localhost` is the one exception), so the server needs a public
HTTPS address:

- **Quick test:** run `npm start`, then expose it with a tunnel such as
  `npx localtunnel --port 3000` or `cloudflared tunnel --url http://localhost:3000`,
  and open the `https://…` URL on both phones.
- **To keep it:** deploy to any Node host that supports WebSockets and a persistent
  disk (Render, Railway, Fly.io, a small VPS). Put `data/` on the persistent disk, or
  set `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` so push keys survive redeploys.

Then on each phone:

1. Open the URL and pair up.
2. **Install it**
   - **iPhone (iOS 16.4+):** Safari → Share → **Add to Home Screen**, then open it *from
     the home screen*. iOS only allows web push for installed apps.
   - **Android:** Chrome menu → **Install app** (or accept the install banner).
3. Tap **⋯ → Background alerts → Turn on**, then *Send me a test notification* to check
   it works.

## What "runs in the background" means here

| Works ✅ | Needs a native app ❌ |
|---|---|
| Notifications for new notes, nudges and doodles while the app is closed | Drawing appearing *directly on the lock screen or home screen* |
| Tapping a notification opens straight onto the shared canvas | A live home-screen widget showing the latest doodle |
| Real-time drawing whenever both have the app open | Drawing over other apps |

The right-hand column is what apps like Locket do with iOS WidgetKit and Android App
Widgets. Web apps can't reach those, so they need a native build. A natural next step is
an **Expo / React Native** client that reuses this same server and adds a home-screen
widget showing the latest canvas.

## How it works

```
phone A ──websocket──▶  server  ──websocket──▶ phone B      (both apps open)
                         │
                         └──web push (VAPID)──▶ phone B     (B's app closed / backgrounded)
```

- **`server.js`**: REST for pairing (`/api/pair`, `/api/join`), push subscriptions,
  unpairing, plus security headers and a strict Content-Security-Policy.
- **`lib/sockets.js`**: one Socket.IO room per couple. The server rebuilds each stroke
  from the streamed points, then commits it, so the client is never trusted to send a
  whole stroke at once. Token-bucket rate limits on every event.
- **`lib/push.js`**: standard Web Push with VAPID. Keys are generated on first boot.
  Dead subscriptions are cleaned up automatically.
- **`lib/db.js`**: SQLite (`pairs`, `members`, `strokes`, `notes`). Each canvas is
  capped at 3,000 strokes and 60 notes.
- **`public/sw.js`**: service worker for offline loading, showing push notifications,
  and focusing the app when a notification is tapped.

## Security & privacy notes

- Each phone gets a random 256-bit token. The server stores only its **SHA-256 hash**.
- Invite codes are single-use and expire after 24 h. The join endpoint is rate-limited
  per IP to stop code guessing.
- All input is validated server-side: coordinates, colours, widths, note length.
  Stickers and paper colours come from fixed lists. Notes are rendered with
  `textContent`, never as HTML.
- **Push endpoints are restricted to real push services** (Google, Mozilla, Apple,
  Microsoft), so a client can't make the server send requests to arbitrary hosts.
- **Unpair** removes your phone. When both partners have unpaired, the canvas and
  notes are deleted.
- `data/` (database + VAPID private key) is git-ignored. There are no user accounts or
  passwords: losing the phone's local storage means pairing again.

This is a portfolio project, not an audited production service. If you run it publicly,
put it behind HTTPS and add backups for `data/`.
