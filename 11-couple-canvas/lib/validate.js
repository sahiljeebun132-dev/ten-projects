'use strict';

/** Input validation shared by REST routes and socket handlers. Never trust the client. */

const LIMITS = {
  NAME_MAX: 24,
  NOTE_MAX: 140,
  POINTS_PER_STROKE: 4000,
  POINTS_PER_MESSAGE: 200
};

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;

// Emoji choices for notes are a fixed set, so nothing odd can be injected through them.
const NOTE_EMOJI = ['💌', '😘', '🥺', '😂', '🍕', '🔥', '🌸', '⭐', '🫶', '😴', '🙈', '🍫'];
const NOTE_COLORS = ['#ffe36e', '#ffb3c7', '#b8f2c9', '#b9dcff', '#e3c8ff'];

function cleanText(value, max) {
  if (typeof value !== 'string') return null;
  // Strip control characters (keep newlines), collapse runs of blank lines, trim.
  const s = value.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '').replace(/\n{3,}/g, '\n\n').trim();
  if (!s || [...s].length > max) return null;
  return s;
}

const validateName = (v) => {
  const s = cleanText(v, LIMITS.NAME_MAX);
  return s && !s.includes('\n') ? s : null;
};

const validateCode = (v) => {
  if (typeof v !== 'string') return null;
  const s = v.toUpperCase().replace(/[\s-]/g, '');
  return CODE_RE.test(s) ? s : null;
};

const isUnit = (n) => typeof n === 'number' && Number.isFinite(n) && n >= -0.05 && n <= 1.05;
const round4 = (n) => Math.round(n * 10000) / 10000;

/** Points arrive as [[x, y], ...] in canvas-relative 0..1 space. */
function validatePoints(pts, max = LIMITS.POINTS_PER_MESSAGE) {
  if (!Array.isArray(pts) || pts.length === 0 || pts.length > max) return null;
  const out = [];
  for (const p of pts) {
    if (!Array.isArray(p) || p.length !== 2 || !isUnit(p[0]) || !isUnit(p[1])) return null;
    out.push([round4(p[0]), round4(p[1])]);
  }
  return out;
}

function validateStrokeStart(d) {
  if (!d || typeof d !== 'object') return null;
  const width = Number(d.width);
  if (!Number.isFinite(width) || width < 0.002 || width > 0.12) return null;
  const erase = d.erase === true;
  const color = erase ? '#000000' : (COLOR_RE.test(d.color) ? d.color.toLowerCase() : null);
  if (!color) return null;
  const points = validatePoints(d.points);
  if (!points) return null;
  return { color, width: round4(width), erase, points };
}

function validateNote(d) {
  if (!d || typeof d !== 'object') return null;
  const text = cleanText(d.text, LIMITS.NOTE_MAX);
  if (!text) return null;
  const emoji = NOTE_EMOJI.includes(d.emoji) ? d.emoji : NOTE_EMOJI[0];
  const color = NOTE_COLORS.includes(d.color) ? d.color : NOTE_COLORS[0];
  return { text, emoji, color };
}

// Push endpoints are URLs the server will POST to, so only accept real push services
// (otherwise a client could make the server send requests to arbitrary hosts).
const PUSH_HOST_SUFFIXES = [
  '.googleapis.com', // Chrome / Android / Edge (FCM)
  '.mozilla.com', // Firefox
  '.push.apple.com', // Safari / iOS home-screen apps
  '.notify.windows.com' // Edge on Windows (WNS)
];

function validatePushSubscription(sub) {
  if (!sub || typeof sub !== 'object' || typeof sub.endpoint !== 'string' || sub.endpoint.length > 1000) return null;
  let url;
  try { url = new URL(sub.endpoint); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  if (!PUSH_HOST_SUFFIXES.some((s) => host.endsWith(s))) return null;
  const k = sub.keys || {};
  if (typeof k.p256dh !== 'string' || typeof k.auth !== 'string') return null;
  if (k.p256dh.length > 200 || k.auth.length > 100) return null;
  return { endpoint: sub.endpoint, keys: { p256dh: k.p256dh, auth: k.auth } };
}

module.exports = {
  LIMITS, NOTE_EMOJI, NOTE_COLORS,
  validateName, validateCode, validatePoints, validateStrokeStart, validateNote, validatePushSubscription
};
