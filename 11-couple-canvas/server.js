'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const db = require('./lib/db');
const push = require('./lib/push');
const sockets = require('./lib/sockets');
const { validateName, validateCode, validatePushSubscription, NOTE_EMOJI, NOTE_COLORS } = require('./lib/validate');

const PORT = Number.parseInt(process.env.PORT, 10) || 3000;

db.open();
push.init(process.env.DATA_DIR || path.join(__dirname, 'data'));

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 64 * 1024 });
const live = sockets.attach(io);

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '16kb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
      "connect-src 'self' ws: wss:; manifest-src 'self'; worker-src 'self'; " +
      "base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
  );
  next();
});

/* ------------------------------------------------------------- helpers */

/** Very small fixed-window limiter, keyed by IP, for the pairing endpoints. */
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => hits.clear(), windowMs).unref();
  return (req, res, next) => {
    const n = (hits.get(req.ip) || 0) + 1;
    hits.set(req.ip, n);
    if (n > max) return res.status(429).json({ error: 'Too many tries – wait a few minutes.' });
    next();
  };
}

function auth(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const member = db.memberByToken(token);
  if (!member) return res.status(401).json({ error: 'Not signed in.' });
  req.member = member;
  next();
}

/* ------------------------------------------------------------- API */

app.get('/api/config', (req, res) => {
  res.json({ vapidPublicKey: push.getPublicKey(), emoji: NOTE_EMOJI, noteColors: NOTE_COLORS });
});

app.post('/api/pair', rateLimit({ windowMs: 10 * 60 * 1000, max: 20 }), (req, res) => {
  const name = validateName(req.body?.name);
  if (!name) return res.status(400).json({ error: 'Pick a name (1–24 characters).' });
  const { token, inviteCode } = db.createPair(name);
  res.status(201).json({ token, inviteCode });
});

app.post('/api/join', rateLimit({ windowMs: 10 * 60 * 1000, max: 15 }), (req, res) => {
  const name = validateName(req.body?.name);
  const code = validateCode(req.body?.code);
  if (!name) return res.status(400).json({ error: 'Pick a name (1–24 characters).' });
  if (!code) return res.status(400).json({ error: 'Codes are 6 letters/numbers.' });
  const result = db.joinPair(code, name);
  if (result.error) return res.status(400).json({ error: result.error });
  // Announced exactly once, here – the waiting partner's phone switches to the canvas.
  io.to(`p:${result.pairId}`).emit('partner:joined', { name });
  res.status(201).json({ token: result.token });
});

app.post('/api/push', auth, (req, res) => {
  if (req.body?.subscription === null) {
    db.setPushSubscription(req.member.id, null);
    return res.json({ ok: true });
  }
  const sub = validatePushSubscription(req.body?.subscription);
  if (!sub) return res.status(400).json({ error: 'That push subscription was not accepted.' });
  db.setPushSubscription(req.member.id, sub);
  res.json({ ok: true });
});

/** A test notification to yourself, so you can check background alerts work. */
app.post('/api/push/test', auth, rateLimit({ windowMs: 60 * 1000, max: 3 }), async (req, res) => {
  const sent = await push.notify(req.member, { title: 'Scribble Us', body: '🔔 Notifications are working!', tag: 'test' });
  res.json({ sent });
});

/** Unpair: removes you; when both have left, the canvas and notes are deleted too. */
app.delete('/api/me', auth, (req, res) => {
  const partner = db.partnerOf(req.member);
  db.leave(req.member);
  live.kick(req.member.id);
  if (partner) io.to(`m:${partner.id}`).emit('partner:left');
  res.json({ ok: true });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

/* ------------------------------------------------------------- static PWA */

app.get('/sw.js', (req, res, next) => {
  // Service workers must not be cached aggressively, or updates never land.
  res.setHeader('Cache-Control', 'no-cache');
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

if (require.main === module) {
  server.listen(PORT, () => console.log(`Scribble Us running on http://localhost:${PORT}`));
}

module.exports = { app, server, io };
