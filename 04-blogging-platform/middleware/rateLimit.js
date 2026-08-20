'use strict';

/**
 * Tiny in-memory fixed-window rate limiter.
 * Good enough for a single-process app; swap for Redis when scaling out.
 */
function createRateLimiter({ windowMs = 15 * 60 * 1000, max = 5, message = 'Too many attempts. Please try again later.', keyGenerator } = {}) {
  const hits = new Map();

  // Drop expired buckets every minute so the map cannot grow unbounded.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, 60 * 1000);
  if (sweeper.unref) sweeper.unref();

  const defaultKey = (req) => `${req.ip}:${String((req.body && req.body.email) || '').toLowerCase()}`;

  function middleware(req, res, next) {
    const key = (keyGenerator || defaultKey)(req);
    const now = Date.now();
    let entry = hits.get(key);

    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }

    entry.count += 1;
    const remaining = Math.max(0, max - entry.count);
    res.set('X-RateLimit-Limit', String(max));
    res.set('X-RateLimit-Remaining', String(remaining));

    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      res.status(429);
      req.rateLimited = { retryAfter, message };
      return next(Object.assign(new Error(message), { status: 429, rateLimit: true, retryAfter }));
    }
    return next();
  }

  /** Clear the counter for a key — call after a successful login. */
  middleware.reset = (req) => hits.delete((keyGenerator || defaultKey)(req));
  middleware.hits = hits;
  return middleware;
}

module.exports = { createRateLimiter };
