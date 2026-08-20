'use strict';

const Users = require('../models/user');

/** Hydrate req.user / res.locals.currentUser from the session on every request. */
function loadUser(req, res, next) {
  const sessionUser = req.session && req.session.user;
  req.user = null;
  if (sessionUser) {
    const fresh = Users.findById(sessionUser.id);
    if (fresh) {
      req.user = Users.toSession(fresh);
    } else {
      delete req.session.user; // account removed while the session lived on
    }
  }
  res.locals.currentUser = req.user;
  next();
}

/** Require any signed-in user; remembers where they were heading. */
function requireAuth(req, res, next) {
  if (req.user) return next();
  if (req.method === 'GET') req.session.returnTo = req.originalUrl;
  req.session.flash = { type: 'error', message: 'Please sign in to continue.' };
  return res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  const err = new Error('Administrators only');
  err.status = 403;
  return next(err);
}

/** Redirect already-authenticated users away from login/register. */
function requireGuest(req, res, next) {
  if (req.user) return res.redirect('/dashboard');
  return next();
}

/** Allow the resource owner or an admin. `getOwnerId` receives the request. */
function requireOwnerOrAdmin(getOwnerId) {
  return (req, res, next) => {
    if (!req.user) return requireAuth(req, res, next);
    if (req.user.role === 'admin') return next();
    if (Number(getOwnerId(req)) === Number(req.user.id)) return next();
    const err = new Error('You do not have permission to do that');
    err.status = 403;
    return next(err);
  };
}

module.exports = { loadUser, requireAuth, requireAdmin, requireGuest, requireOwnerOrAdmin };
