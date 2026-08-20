'use strict';

/**
 * Shared sanitising / validation helpers.
 * The server NEVER trusts the client: every limit here is re-checked server-side
 * even though the front end applies the same rules for a nicer UX.
 */

const LIMITS = {
  MESSAGE_MAX: 2000,
  NICK_MIN: 2,
  NICK_MAX: 24,
  PASSWORD_MIN: 4,
  PASSWORD_MAX: 128,
  ROOM_MIN: 2,
  ROOM_MAX: 32,
  TOPIC_MAX: 140,
  HISTORY_PAGE_MAX: 100,
  HISTORY_PAGE_DEFAULT: 30
};

const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;'
};

/** Escape a string for safe interpolation into HTML text/attribute context. */
function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"'`]/g, (ch) => HTML_ESCAPES[ch]);
}

/** Strip control characters (keeping \n and \t) and trim. */
function cleanText(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Validate + normalise a nickname. Returns { ok, value, error }. */
function validateNickname(raw) {
  const value = cleanText(raw).replace(/\s+/g, ' ');
  if (value.length < LIMITS.NICK_MIN) {
    return { ok: false, error: `Nickname must be at least ${LIMITS.NICK_MIN} characters.` };
  }
  if (value.length > LIMITS.NICK_MAX) {
    return { ok: false, error: `Nickname must be at most ${LIMITS.NICK_MAX} characters.` };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]*$/.test(value)) {
    return { ok: false, error: 'Nickname may only contain letters, numbers, spaces, _ . and -' };
  }
  return { ok: true, value };
}

/**
 * Validate + normalise a room name. A leading '#' is accepted and stripped;
 * rooms are stored without it and rendered with it.
 */
function validateRoomName(raw) {
  let value = cleanText(raw).replace(/^#+/, '').toLowerCase();
  value = value.replace(/\s+/g, '-');
  if (value.length < LIMITS.ROOM_MIN) {
    return { ok: false, error: `Room name must be at least ${LIMITS.ROOM_MIN} characters.` };
  }
  if (value.length > LIMITS.ROOM_MAX) {
    return { ok: false, error: `Room name must be at most ${LIMITS.ROOM_MAX} characters.` };
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(value)) {
    return { ok: false, error: 'Room names may only contain lowercase letters, numbers, - and _' };
  }
  return { ok: true, value };
}

/** Validate a message body. */
function validateMessage(raw) {
  const value = cleanText(raw);
  if (!value) return { ok: false, error: 'Message is empty.' };
  if (value.length > LIMITS.MESSAGE_MAX) {
    return { ok: false, error: `Message must be at most ${LIMITS.MESSAGE_MAX} characters.` };
  }
  return { ok: true, value };
}

/** Deterministic key for a DM conversation between two nicknames. */
function dmKey(nickA, nickB) {
  const pair = [String(nickA).toLowerCase(), String(nickB).toLowerCase()].sort();
  return `dm:${pair[0]}|${pair[1]}`;
}

/** Clamp a pagination limit into a safe range. */
function clampLimit(raw, fallback = LIMITS.HISTORY_PAGE_DEFAULT) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, LIMITS.HISTORY_PAGE_MAX);
}

const ALLOWED_REACTIONS = ['\u{1F44D}', '❤️', '\u{1F602}'];

function isAllowedReaction(emoji) {
  return ALLOWED_REACTIONS.includes(emoji);
}

/**
 * Token-bucket rate limiter, one instance per socket.
 * `capacity` tokens, refilled at `refillPerSec` tokens/second.
 */
function createRateLimiter({ capacity = 10, refillPerSec = 4 } = {}) {
  let tokens = capacity;
  let last = Date.now();
  return function take(cost = 1) {
    const now = Date.now();
    tokens = Math.min(capacity, tokens + ((now - last) / 1000) * refillPerSec);
    last = now;
    if (tokens < cost) return false;
    tokens -= cost;
    return true;
  };
}

module.exports = {
  LIMITS,
  ALLOWED_REACTIONS,
  escapeHtml,
  cleanText,
  validateNickname,
  validateRoomName,
  validateMessage,
  isAllowedReaction,
  dmKey,
  clampLimit,
  createRateLimiter
};
