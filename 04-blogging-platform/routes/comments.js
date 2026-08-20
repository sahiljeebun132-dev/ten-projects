'use strict';

const express = require('express');
const Posts = require('../models/post');
const Comments = require('../models/comment');
const { requireAdmin } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/rateLimit');

const router = express.Router();

// 10 comments per IP per 10 minutes.
const commentLimiter = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 10,
  message: 'You are commenting too quickly. Please try again in a few minutes.',
  keyGenerator: (req) => `comment:${req.ip}`
});

/* Create a comment on a published post ------------------------------------ */
router.post('/posts/:slug/comments', commentLimiter, (req, res, next) => {
  const post = Posts.findBySlug(req.params.slug, { publishedOnly: true });
  if (!post) return next();

  const back = `/posts/${post.slug}#comments`;

  // Honeypot: bots fill every field they can see, humans never see this one.
  if (String(req.body.website || '').trim() !== '') {
    req.flash('success', 'Thanks! Your comment has been received.');
    return res.redirect(back);
  }

  const authorName = String(req.body.author_name || '').trim();
  const body = String(req.body.body || '').trim();

  if (authorName.length < 2 || body.length < 2) {
    req.session.commentDraft = { author_name: authorName, body };
    req.flash('error', 'Please provide both a name and a comment.');
    return res.redirect(back);
  }
  if (body.length > Comments.MAX_BODY) {
    req.session.commentDraft = { author_name: authorName, body: body.slice(0, Comments.MAX_BODY) };
    req.flash('error', `Comments are limited to ${Comments.MAX_BODY} characters.`);
    return res.redirect(back);
  }

  Comments.create({ post_id: post.id, author_name: authorName, body });
  req.flash('success', 'Thanks! Your comment has been posted.');
  return res.redirect(back);
});

/* Admin comment moderation -------------------------------------------------- */
router.delete('/comments/:id', requireAdmin, (req, res, next) => {
  const id = Number.parseInt(req.params.id, 10);
  const comment = Number.isFinite(id) ? Comments.findById(id) : null;
  if (!comment) return next();

  const post = Posts.findById(comment.post_id);
  Comments.remove(comment.id);
  req.flash('success', 'Comment deleted.');

  const referer = req.get('referer') || '';
  if (referer.includes('/dashboard')) return res.redirect('/dashboard');
  return res.redirect(post ? `/posts/${post.slug}#comments` : '/');
});

module.exports = router;
