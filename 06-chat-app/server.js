'use strict';

require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const session = require('express-session');
const { Server } = require('socket.io');

const db = require('./lib/db');
const { seed } = require('./db/seed');
const sockets = require('./lib/sockets');
const { LIMITS, validateNickname } = require('./lib/sanitise');

const PORT = Number.parseInt(process.env.PORT, 10) || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-insecure-secret-change-me';

if (!process.env.SESSION_SECRET) {
  console.warn('[warn] SESSION_SECRET is not set — using an insecure development default.');
}

/* --------------------------------------------------------------- startup */

db.open();
seed({ quiet: true });

const app = express();
const server = http.createServer(app);

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: false, limit: '32kb' }));

// One session middleware instance, shared by Express routes AND Socket.IO
// (via io.engine.use) so a socket sees exactly the same req.session.
const sessionMiddleware = session({
  name: 'chat.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production' && process.env.TRUST_TLS !== 'false',
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
});

app.use(sessionMiddleware);

// Small security headers (no external deps).
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

/* ---------------------------------------------------------------- routes */

app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), now: Date.now() });
});

app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ ok: false, error: 'Not signed in.' });
  const user = db.getUserById(req.session.user.id);
  if (!user) {
    req.session.destroy(() => {});
    return res.status(401).json({ ok: false, error: 'Not signed in.' });
  }
  res.json({ ok: true, user: { id: user.id, nickname: user.nickname, isGuest: !!user.is_guest } });
});

app.post('/api/login', (req, res) => {
  const check = validateNickname(req.body && req.body.nickname);
  if (!check.ok) return res.status(400).json({ ok: false, error: check.error });

  const password = typeof (req.body && req.body.password) === 'string' ? req.body.password : '';
  const result = db.authenticate(check.value, password);
  if (!result.ok) {
    const status = result.code === 'PASSWORD_REQUIRED' ? 401 : 400;
    return res.status(status).json({ ok: false, error: result.error, code: result.code });
  }

  db.joinDefaultRooms(result.user.id);
  db.touchLastSeen(result.user.id);

  req.session.user = { id: result.user.id, nickname: result.user.nickname };
  req.session.save((err) => {
    if (err) return res.status(500).json({ ok: false, error: 'Could not start session.' });
    res.json({
      ok: true,
      user: {
        id: result.user.id,
        nickname: result.user.nickname,
        isGuest: !!result.user.is_guest
      },
      created: !!result.created
    });
  });
});

app.post('/api/logout', (req, res) => {
  if (req.session.user) db.touchLastSeen(req.session.user.id);
  req.session.destroy(() => {
    res.clearCookie('chat.sid');
    res.json({ ok: true });
  });
});

app.get('/api/rooms', (req, res) => {
  if (!req.session.user) return res.status(401).json({ ok: false, error: 'Not signed in.' });
  const counts = db.memberCounts();
  res.json({
    ok: true,
    rooms: db.listRooms().map((r) => ({
      name: r.name, topic: r.topic, isDefault: !!r.is_default, members: counts[r.id] || 0
    }))
  });
});

app.get('/api/limits', (req, res) => res.json({ ok: true, limits: LIMITS }));

app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0
}));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ ok: false, error: 'Not found.' });
  res.status(404).sendFile(path.join(__dirname, 'public', 'index.html'));
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[http]', err);
  res.status(500).json({ ok: false, error: 'Server error.' });
});

/* -------------------------------------------------------------- socket.io */

const io = new Server(server, {
  serveClient: true,
  pingTimeout: 20000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e5,
  cors: { origin: false }
});

// Share the *same* session middleware with the websocket handshake.
io.engine.use(sessionMiddleware);

sockets.register(io);

/* ------------------------------------------------------------------ boot */

function shutdown(signal) {
  console.log(`\n[server] ${signal} received, shutting down…`);
  io.close(() => {});
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`[server] chat listening on http://localhost:${PORT}`);
    console.log(`[server] database: ${db.DB_PATH}`);
  });
}

module.exports = { app, server, io };
