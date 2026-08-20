'use strict';

/** Wrap an async route handler so rejected promises reach the error handler. */
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function notFound(req, res, next) {
  const err = new Error('Page not found');
  err.status = 404;
  next(err);
}

function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  const status = err.status || 500;

  // A rejected request may already have written an upload to disk — drop it.
  if (req.file && req.file.filename) {
    require('./upload').removeUpload('/uploads/' + req.file.filename);
  }
  const isProd = process.env.NODE_ENV === 'production';

  if (status >= 500) console.error(err);

  const message = status >= 500 && isProd ? 'Something went wrong on our end.' : err.message;

  if (res.headersSent) return;

  res.status(status);
  if (req.accepts('html')) {
    return res.render('error', {
      title: `${status} — ${status === 404 ? 'Not found' : 'Error'}`,
      status,
      message,
      stack: isProd ? null : err.stack
    });
  }
  return res.json({ error: message, status });
}

module.exports = { asyncHandler, notFound, errorHandler };
