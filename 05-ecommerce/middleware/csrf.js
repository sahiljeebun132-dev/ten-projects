'use strict';
/**
 * Small synchroniser-token CSRF guard.
 * A per-session secret token is required on every state-changing request.
 */
const crypto = require('crypto');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function csrf(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  const token = req.session.csrfToken;

  req.csrfToken = () => token;
  res.locals.csrfToken = token;

  if (SAFE_METHODS.has(req.method)) return next();

  const sent =
    (req.body && (req.body._csrf || req.body.csrfToken)) ||
    req.get('x-csrf-token') ||
    req.get('x-xsrf-token');

  const a = Buffer.from(String(sent || ''));
  const b = Buffer.from(token);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!ok) {
    res.status(403);
    return res.render('error', {
      title: 'Session expired',
      status: 403,
      message: 'That form could not be verified (invalid CSRF token). Please go back, reload the page and try again.'
    });
  }
  return next();
}

module.exports = csrf;
