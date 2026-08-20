# Chat — a real-time chat application

Rooms, direct messages, presence and persistent history, built on **Express 4 +
Socket.IO 4 + SQLite**. The front end is plain hand-written HTML/CSS/JS — no
framework, no bundler, no build step, and the Socket.IO client is served by the
app itself from `/socket.io/socket.io.js` (nothing is fetched from a CDN).

```
npm install
cp .env.example .env      # then edit SESSION_SECRET
npm start                 # http://localhost:3000
```

---

## Features

**Sign-in**
- Nickname-only sign-in creates a **guest**; nickname + password creates a
  **registered account** (bcrypt, cost 10).
- Signing in again with a registered nickname requires the password. A guest
  nickname cannot be claimed with a password (and vice-versa).
- One `express-session` middleware instance is shared by the HTTP routes *and*
  the Socket.IO handshake, so a socket is authenticated by the same cookie the
  browser already holds. Unauthenticated sockets are refused with
  `NOT_AUTHENTICATED`.

**Rooms**
- `#general`, `#random` and `#dev` are seeded on first boot and auto-joined at
  sign-in.
- Create / join / leave rooms. Room names are validated and normalised
  (`#My Room` → `my-room`; lowercase, `a-z0-9-_`, 2–32 chars).
- The sidebar shows every room, member counts, and **unread badges** driven by
  a per-membership `last_read_at` watermark.

**Messaging**
- Real-time send/receive with acknowledgements.
- History is persisted in SQLite and **paginated on scroll-back** — reaching the
  top of the pane (or pressing *Load older messages*) fetches the previous page
  using an exclusive `before` message-id cursor.
- Messages are grouped under **Today / Yesterday / date** dividers; your own
  messages are right-aligned in an accent bubble, everyone else's on the left.
- **Link auto-detection**: text is HTML-escaped *first*, then `http(s)://` and
  `www.` URLs are turned into anchors with `target="_blank"` and
  `rel="noopener noreferrer nofollow"`. `javascript:` URLs are never linked.
- **Emoji picker** with a hand-written 50-emoji set, inserted at the caret.
- Slash commands: `/me <action>` renders an italic action line, `/shrug`
  appends `¯\_(ツ)_/¯`. Unknown commands are rejected with a hint.

**Presence**
- Per-room online member list plus a global "Online" list with **last-seen**
  timestamps for people who have gone.
- Join / leave **system messages** are persisted and broadcast.
- **Typing indicators**, debounced client-side (throttled `typing:start`,
  1.5 s idle `typing:stop`) and expiring server-side after 6 s. Rendered as
  "X is typing…", "X and Y are typing…", "3 people are typing…".

**Direct messages**
- Click anyone in the Online list to open a 1:1 conversation. DMs are stored
  against a deterministic `dm:<nickA>|<nickB>` key and delivered to both
  participants' personal channels, so an unopened DM still appears in the
  recipient's sidebar.

**Editing, deleting, reacting, replying**
- Edit or delete your own messages (Up-arrow in an empty composer edits your
  last message). Both actions broadcast a `message:updated` event; deletes leave
  a tombstone rather than removing the row.
- Reactions 👍 ❤️ 😂, toggled per user, with hover tooltips listing who reacted.
- Reply-to-quote: replies embed a clickable excerpt that jumps to the original.

**Notifications**
- Unread count in the browser tab title.
- Optional Notification API permission (opt-in via the 🔔 button).
- Sound toggle — the beep is **synthesised with WebAudio** (two short sine
  blips, a higher pair for DMs); there are no audio files.

**Robustness & security**
- All user content is escaped before it reaches the DOM. `innerHTML` is only
  ever assigned strings that have already been through `escapeHtml()`.
- Server-side length limits (2000-char messages, 24-char nicknames, 32-char room
  names, 140-char topics) and room-name validation — the client's rules are a
  UX nicety, the server re-checks everything.
- **Per-socket token-bucket rate limiting**: 10 messages burst / 4 per second,
  with separate buckets for actions and typing events. Rejections come back as
  `{ ok: false, code: 'RATE_LIMIT' }`.
- **Reconnect handling**: a "Reconnecting…" banner, automatic re-join of the
  active conversation, and a **resend queue** — messages typed while offline are
  shown as pending bubbles and flushed once the socket is back.

**Layout**
- Sidebar + chat pane on desktop; below 780 px the sidebar becomes a slide-over
  drawer with a scrim. Light/dark theme, remembered in `localStorage` and
  seeded from `prefers-color-scheme`.

---

## Architecture

```
browser                                    server
───────                                    ──────
index.html ─┬─ util.js    escape/linkify   server.js      Express app + HTTP server
            ├─ sound.js   WebAudio + tab   │  ├─ express-session ──┐  shared instance
            ├─ render.js  DOM building     │  ├─ /api/*  routes    │
            └─ app.js     state + socket   │  └─ static  public/   │
                  │                        │                       │
   HTTP  POST /api/login  ─────────────────┤  sets chat.sid cookie │
                  │                        │                       │
   WS    io()  ───────────────────────────▶│  io.engine.use(session)
         cookie replayed on handshake      │  socket.request.session.user
                  │                        │        │
                  │                        │   lib/sockets.js  event handlers,
                  │                        │        │          presence + typing maps
                  ▼                        │        ▼
        message:new / message:updated ◀────┤   lib/db.js ──▶ better-sqlite3 (WAL)
        presence:online / typing:update    │   lib/sanitise.js  limits + validation
```

**HTTP flow.** The browser `POST`s `/api/login`. The server validates the
nickname, runs bcrypt (registering the account on first use), writes
`req.session.user` and returns a `chat.sid` cookie. Static assets and the
Socket.IO client bundle are served from the same origin.

**WebSocket flow.** `io()` opens a handshake that replays the `chat.sid`
cookie. `io.engine.use(sessionMiddleware)` — the *same* middleware object used
by Express — populates `socket.request.session`, and a Socket.IO middleware
rejects the connection if there is no session user. From then on every event is
attributed to `socket.data.user` and the client never sends its own identity.

Rooms map to Socket.IO channels: `room:<name>` for rooms, `dm:<a>|<b>` for DM
threads, and `user:<nickname>` as each user's personal delivery channel.

### File layout

| Path | Purpose |
| --- | --- |
| `server.js` | Express app, session middleware, HTTP API, Socket.IO server, graceful shutdown |
| `lib/db.js` | better-sqlite3 access layer: users, rooms, memberships, messages, reactions |
| `lib/sockets.js` | Every socket event handler, presence/typing state, broadcast helpers |
| `lib/sanitise.js` | Escaping, validation, limits, DM keys, token-bucket rate limiter |
| `db/schema.sql` | Schema, applied idempotently at boot |
| `db/seed.js` | Seeds `#general` / `#random` / `#dev` (`npm run seed`) |
| `public/index.html` | App shell: sign-in overlay, sidebar, chat pane, modal |
| `public/css/style.css` | Themed, responsive stylesheet (CSS custom properties) |
| `public/js/util.js` | `escapeHtml`, `linkify`, date/relative formatting, debounce/throttle, emoji set |
| `public/js/sound.js` | WebAudio beep, Notification API, tab-title unread badge |
| `public/js/render.js` | Builds message / room / user DOM nodes |
| `public/js/app.js` | Client state machine, socket wiring, all UI behaviour |
| `test/smoke.js` | Two-client end-to-end test (`npm run smoke`) |

---

## Socket event reference

Every client→server event accepts an optional acknowledgement callback. Failed
acks are always `{ ok: false, error: string }` (sometimes with a `code`).

`target` is `#<room>` for room conversations and `dm:<nickA>|<nickB>` for DMs
(lowercased, sorted). Handlers are rate-limited per socket.

### Client → Server

| Event | Payload | Ack |
| --- | --- | --- |
| `room:list` | `{}` | `{ ok, rooms: RoomSummary[], allRooms: Room[] }` |
| `room:join` | `{ room, limit? }` | `{ ok, room: {name,topic,isDefault}, messages: Message[], hasMore, members: User[] }` |
| `room:leave` | `{ room }` | `{ ok, room }` |
| `room:create` | `{ name, topic? }` | `{ ok, room }` |
| `room:history` | `{ room, before?, limit? }` | `{ ok, room, messages: Message[], hasMore }` |
| `room:read` | `{ room }` | `{ ok }` — moves the unread watermark |
| `presence:list` | `{ room? }` | `{ ok, users: User[], room?, members?: User[] }` |
| `dm:open` | `{ to, limit? }` | `{ ok, dm: {key,peer,online,lastSeen}, messages, hasMore }` |
| `dm:history` | `{ to, before?, limit? }` | `{ ok, dm, messages, hasMore }` |
| `message:send` | `{ room \| to, body, replyTo?, clientId? }` | `{ ok, message, clientId, target }` / `{ ok:false, error, code?: 'RATE_LIMIT' }` |
| `message:edit` | `{ id, body }` | `{ ok, message }` |
| `message:delete` | `{ id }` | `{ ok, message }` |
| `message:react` | `{ id, emoji }` | `{ ok, message }` — toggles; emoji must be 👍 ❤️ 😂 |
| `typing:start` | `{ room \| to }` | *(none)* |
| `typing:stop` | `{ room \| to }` | *(none)* |

### Server → Client

| Event | Payload | When |
| --- | --- | --- |
| `session:ready` | `{ user, rooms: RoomSummary[], allRooms: Room[], online: User[], limits }` | Immediately after a socket authenticates (also after every reconnect) |
| `rooms:updated` | `{ rooms: Room[] }` | A room is created, joined for the first time, or left |
| `room:created` | `{ room, by }` | Someone creates a room |
| `room:members` | `{ room, members: User[] }` | Room occupancy changes |
| `presence:online` | `{ users: User[] }` | A user's first socket connects or last socket disconnects |
| `typing:update` | `{ target, users: string[] }` | Typing state changes (target is the raw channel: `room:general` or `dm:a\|b`) |
| `message:new` | `{ target, message, dm? }` | A message (or persisted system message) is created |
| `message:updated` | `{ target, message }` | A message is edited, deleted or reacted to |

Connection is refused with the error message `NOT_AUTHENTICATED` when the
handshake carries no valid session.

### Payload shapes

```jsonc
// Message
{
  "id": 42, "roomId": 1, "room": "general", "dmKey": null,
  "userId": 7, "nickname": "ada",
  "body": "hello",                 // "" when deleted
  "kind": "chat",                  // "chat" | "me" | "system"
  "createdAt": 1787243149025, "editedAt": null, "deleted": false,
  "replyTo": { "id": 41, "nickname": "bob", "body": "…", "deleted": false },
  "reactions": { "👍": ["bob", "cy"] }
}

// Room / RoomSummary (RoomSummary adds unread + online for the current user)
{ "name": "general", "topic": "…", "isDefault": true, "members": 3, "unread": 2, "online": 2 }

// User
{ "nickname": "bob", "online": true, "lastSeen": 1787243149025 }
```

---

## Database schema

SQLite in WAL mode at `db/chat.sqlite` (override with `DB_PATH`). The schema is
applied idempotently on every boot, so there is no separate migration step.

| Table | Columns | Notes |
| --- | --- | --- |
| `users` | `id`, `nickname` (unique, `NOCASE`), `password_hash`, `is_guest`, `created_at`, `last_seen_at` | `password_hash` is `NULL` for guests |
| `rooms` | `id`, `name` (unique, `NOCASE`), `topic`, `is_default`, `created_by`, `created_at` | Stored without the leading `#` |
| `memberships` | `user_id`, `room_id`, `joined_at`, `last_read_at` | PK `(user_id, room_id)`; `last_read_at` drives unread badges |
| `messages` | `id`, `room_id`, `dm_key`, `user_id`, `nickname`, `body`, `kind`, `reply_to_id`, `created_at`, `edited_at`, `deleted_at` | Exactly one of `room_id` / `dm_key` is set; deletes are soft |
| `reactions` | `message_id`, `user_id`, `nickname`, `emoji`, `created_at` | PK `(message_id, user_id, emoji)` — one row per reaction |

Indexes: `(room_id, id DESC)` and `(dm_key, id DESC)` make the reverse-cursor
history queries cheap, plus `(message_id)` on reactions.

The denormalised `nickname` column on `messages` and `reactions` keeps history
readable if a user row is ever removed (`user_id` is `ON DELETE SET NULL`).

---

## Setup

```bash
npm install
cp .env.example .env
npm start
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP + WebSocket port |
| `SESSION_SECRET` | insecure dev default (warns) | Signs the `chat.sid` cookie |
| `DB_PATH` | `db/chat.sqlite` | SQLite file location |
| `NODE_ENV` | `development` | `production` enables secure cookies + static caching |

Other scripts: `npm run seed` (re-seed default rooms), `npm run smoke` (tests).

> The session store is the in-memory default, which is fine for a single
> process. Behind more than one worker you would swap in a shared store and a
> Socket.IO adapter (e.g. Redis).

## Testing with two browser windows

1. `npm start`.
2. Open `http://localhost:3000` in a normal window, sign in as `ada` with a
   password.
3. Open the same URL in a **private/incognito** window (a second profile also
   works — it needs its own cookie jar) and sign in as `bob` with no password,
   as a guest.
4. Put the windows side by side and try:
   - Type in one — the other shows "ada is typing…".
   - Send a message — it appears instantly in both, right-aligned for the
     sender, left-aligned for the receiver.
   - Hover a message → react 👍, reply ↩, or edit ✎ / delete 🗑 your own.
   - Click `bob` in the Online list to open a DM.
   - `+` in the sidebar creates a room; the other window sees it appear.
   - Send `/me waves` and `/shrug`.
   - Focus one window and send from the other — the background tab's title
     gains an unread count, the sidebar badge increments, and a beep plays.
   - Stop the server (`Ctrl-C`): both windows show "Reconnecting…". Type a
     message — it queues as a faded bubble. Restart with `npm start` and the
     queued message is sent automatically.
   - Paste `https://example.com` — it becomes a safe external link. Paste
     `<img src=x onerror=alert(1)>` — it renders as literal text.

## Automated test

```bash
npm run smoke                                    # boots its own server + scratch DB
SMOKE_URL=http://localhost:3000 npm run smoke    # or test a server you already run
```

`test/smoke.js` signs in two users over HTTP, connects two real
`socket.io-client` sockets with their session cookies, and runs 43 assertions
covering auth, session sharing, room lifecycle, two-way delivery, replies,
slash commands, validation and length limits, reactions, edit/delete
authorisation, typing, presence and last-seen, DM isolation, history
pagination and ordering, history persistence across a full disconnect and
reconnect, join/leave system messages, and rate limiting. It cleans up its
scratch database and exits non-zero on the first failure.
