'use strict';

/**
 * Minimal one-shot flash messages stored on the session.
 * Usage: req.flash('success', 'Saved') then read `flash` in any view.
 */
function flash(req, res, next) {
  req.flash = (type, message) => {
    req.session.flash = { type, message };
  };

  res.locals.flash = req.session ? req.session.flash || null : null;
  if (req.session) delete req.session.flash;
  next();
}

module.exports = { flash };
