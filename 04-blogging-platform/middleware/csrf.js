'use strict';

const crypto = require('crypto');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Lazily create a per-session CSRF secret and expose it to every view. */
function csrfToken(req, res, next) {
  if (!req.session) return next(new Error('csrfToken middleware requires a session'));
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;
  return next();
}

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

const isMultipart = (req) => /^multipart\/form-data/i.test(req.get('content-type') || '');

/**
 * Reject any state-changing request whose `_csrf` token (body, query or the
 * `x-csrf-token` header) does not match the token stored in the session.
 *
 * Multipart requests are skipped here because their body has not been parsed
 * yet — those routes re-run this middleware immediately after multer, which is
 * the same ordering rule the classic `csurf` middleware documents.
 */
function verifyCsrf(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  if (req.csrfVerified) return next();

  if (isMultipart(req) && !req.multipartParsed) {
    req.csrfDeferred = true; // must be verified again after the upload parser
    return next();
  }

  const sent =
    (req.body && req.body._csrf) ||
    (req.query && req.query._csrf) ||
    req.get('x-csrf-token') ||
    req.get('x-xsrf-token');

  if (timingSafeEqual(sent, req.session && req.session.csrfToken)) {
    req.csrfVerified = true;
    req.csrfDeferred = false;
    return next();
  }

  const err = new Error('Invalid or missing CSRF token. Please reload the page and try again.');
  err.status = 403;
  return next(err);
}

module.exports = { csrfToken, verifyCsrf, isMultipart };
