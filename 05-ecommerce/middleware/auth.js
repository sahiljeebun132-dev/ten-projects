'use strict';

function requireLogin(req, res, next) {
  if (req.session && req.session.user) return next();
  const target = req.originalUrl && req.method === 'GET' ? req.originalUrl : '/account';
  req.session.returnTo = target;
  req.flash('error', 'Please sign in to continue.');
  return res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'admin') return next();
  if (req.session && req.session.user) {
    res.status(403);
    return res.render('error', {
      title: 'Not allowed',
      status: 403,
      message: 'That area is for demo admin accounts only.'
    });
  }
  req.session.returnTo = '/admin';
  req.flash('error', 'Sign in with the demo admin account to reach the admin area.');
  return res.redirect('/login');
}

function redirectIfLoggedIn(req, res, next) {
  if (req.session && req.session.user) return res.redirect('/account');
  return next();
}

module.exports = { requireLogin, requireAdmin, redirectIfLoggedIn };
