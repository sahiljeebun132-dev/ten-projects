'use strict';
/** Tiny session flash-message helper (avoids another dependency). */
function flash(req, res, next) {
  if (!req.session.flash) req.session.flash = [];

  req.flash = (type, message) => {
    req.session.flash.push({ type, message });
  };

  const messages = req.session.flash;
  req.session.flash = [];
  res.locals.flash = messages;
  next();
}
module.exports = flash;
