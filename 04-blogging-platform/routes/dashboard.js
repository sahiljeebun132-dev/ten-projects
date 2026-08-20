'use strict';

const express = require('express');
const Posts = require('../models/post');
const Tags = require('../models/tag');
const Comments = require('../models/comment');
const { requireAuth } = require('../middleware/auth');
const { coverUpload, removeUpload } = require('../middleware/upload');
const { verifyCsrf } = require('../middleware/csrf');
const { slugify } = require('../lib/content');

const router = express.Router();

router.use(requireAuth);

/** Load a post and make sure the current user may touch it. */
function loadOwnedPost(req, res, next) {
  const id = Number.parseInt(req.params.id, 10);
  const post = Number.isFinite(id) ? Posts.findById(id) : null;
  if (!post) {
    const err = new Error('Post not found');
    err.status = 404;
    return next(err);
  }
  if (req.user.role !== 'admin' && post.author_id !== req.user.id) {
    const err = new Error('You can only manage your own posts');
    err.status = 403;
    return next(err);
  }
  req.post = post;
  return next();
}

/** Normalise + validate the post form body. */
function readPostForm(req) {
  const values = {
    title: String(req.body.title || '').trim().slice(0, 200),
    slug: String(req.body.slug || '').trim().slice(0, 80),
    excerpt: String(req.body.excerpt || '').trim().slice(0, 300),
    body_md: String(req.body.body_md || ''),
    tags: String(req.body.tags || '').slice(0, 200),
    status: req.body.status === 'published' ? 'published' : 'draft'
  };

  const errors = [];
  if (values.title.length < 3) errors.push('Title must be at least 3 characters long.');
  if (values.body_md.trim().length < 10) errors.push('Post body must be at least 10 characters long.');
  if (values.body_md.length > 200000) errors.push('Post body is too long (200,000 character limit).');
  if (values.slug && !/^[a-z0-9-]+$/i.test(values.slug)) {
    errors.push('Slug may only contain letters, numbers and hyphens.');
  }
  return { values, errors };
}

/* Dashboard index ---------------------------------------------------------- */
router.get('/', (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const scope = isAdmin ? {} : { authorId: req.user.id };
  res.render('dashboard/index', {
    title: 'Dashboard',
    isAdmin,
    posts: Posts.listForDashboard(scope),
    stats: Posts.stats(scope),
    recentComments: isAdmin ? Comments.recent(10) : []
  });
});

/* New post ----------------------------------------------------------------- */
router.get('/posts/new', (req, res) => {
  res.render('dashboard/post-form', {
    title: 'New post',
    isEdit: false,
    errors: [],
    values: { status: 'draft' }
  });
});

// coverUpload parses the multipart body; verifyCsrf then checks the parsed token.
router.post('/posts', coverUpload, verifyCsrf, (req, res) => {
  const { values, errors } = readPostForm(req);

  if (errors.length) {
    if (req.file) removeUpload(`/uploads/${req.file.filename}`);
    return res.status(400).render('dashboard/post-form', {
      title: 'New post', isEdit: false, errors, values
    });
  }

  const tagRows = Tags.parseAndUpsert(values.tags);
  const post = Posts.create({
    author_id: req.user.id,
    title: values.title,
    slug: values.slug || values.title,
    excerpt: values.excerpt,
    body_md: values.body_md,
    status: values.status,
    cover_image: req.file ? `/uploads/${req.file.filename}` : null,
    tagIds: tagRows.map((t) => t.id)
  });

  req.flash('success', `“${post.title}” was created.`);
  return res.redirect('/dashboard');
});

/* Edit post ---------------------------------------------------------------- */
router.get('/posts/:id/edit', loadOwnedPost, (req, res) => {
  const post = req.post;
  res.render('dashboard/post-form', {
    title: `Edit: ${post.title}`,
    isEdit: true,
    errors: [],
    values: {
      id: post.id,
      title: post.title,
      slug: post.slug,
      excerpt: post.excerpt,
      body_md: post.body_md,
      status: post.status,
      cover_image: post.cover_image,
      tags: post.tags.map((t) => t.name).join(', ')
    }
  });
});

router.put('/posts/:id', coverUpload, verifyCsrf, loadOwnedPost, (req, res) => {
  const { values, errors } = readPostForm(req);
  values.id = req.post.id;
  values.cover_image = req.post.cover_image;

  if (errors.length) {
    if (req.file) removeUpload(`/uploads/${req.file.filename}`);
    return res.status(400).render('dashboard/post-form', {
      title: `Edit: ${req.post.title}`, isEdit: true, errors, values
    });
  }

  let coverImage = req.post.cover_image;
  if (req.file) {
    coverImage = `/uploads/${req.file.filename}`;
    removeUpload(req.post.cover_image);
  } else if (req.body.remove_cover === '1') {
    coverImage = null;
    removeUpload(req.post.cover_image);
  }

  const tagRows = Tags.parseAndUpsert(values.tags);
  const updated = Posts.update(req.post.id, {
    title: values.title,
    slug: values.slug || slugify(values.title),
    excerpt: values.excerpt,
    body_md: values.body_md,
    status: values.status,
    cover_image: coverImage,
    tagIds: tagRows.map((t) => t.id)
  });
  Tags.pruneOrphans();

  req.flash('success', `“${updated.title}” was saved.`);
  return res.redirect('/dashboard');
});

/* Publish / unpublish ------------------------------------------------------ */
router.post('/posts/:id/toggle', loadOwnedPost, (req, res) => {
  const status = Posts.toggleStatus(req.post.id);
  req.flash('success', `“${req.post.title}” is now a ${status === 'published' ? 'published post' : 'draft'}.`);
  res.redirect('/dashboard');
});

/* Delete ------------------------------------------------------------------- */
router.delete('/posts/:id', loadOwnedPost, (req, res) => {
  removeUpload(req.post.cover_image);
  Posts.remove(req.post.id);
  Tags.pruneOrphans();
  req.flash('success', `“${req.post.title}” was deleted.`);
  res.redirect('/dashboard');
});

module.exports = router;
