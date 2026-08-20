'use strict';

const express = require('express');
const Posts = require('../models/post');
const Tags = require('../models/tag');
const Users = require('../models/user');
const Comments = require('../models/comment');
const { toPlainText } = require('../lib/content');

const router = express.Router();
const PER_PAGE = Number(process.env.POSTS_PER_PAGE || 5);

const pageParam = (req) => {
  const n = Number.parseInt(req.query.page, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
};

/* Home feed --------------------------------------------------------------- */
router.get('/', (req, res) => {
  const result = Posts.listPublished({ page: pageParam(req), perPage: PER_PAGE });
  res.render('home', {
    title: null,
    heading: res.app.locals.siteTitle,
    subheading: res.app.locals.siteDescription,
    popularTags: Tags.withPublishedCounts(12),
    ...result
  });
});

/* Tag index + tag archive -------------------------------------------------- */
router.get('/tags', (req, res) => {
  res.render('tags', { title: 'Tags', tags: Tags.withPublishedCounts(200) });
});

router.get('/tags/:slug', (req, res, next) => {
  const tag = Tags.findBySlug(req.params.slug);
  if (!tag) return next();
  const result = Posts.listPublished({ page: pageParam(req), perPage: PER_PAGE, tagId: tag.id });
  return res.render('tag', { title: `#${tag.name}`, tag, ...result });
});

/* Author archive ----------------------------------------------------------- */
router.get('/authors/:slug', (req, res, next) => {
  const author = Users.findBySlug(req.params.slug);
  if (!author) return next();
  const result = Posts.listPublished({ page: pageParam(req), perPage: PER_PAGE, authorId: author.id });
  return res.render('author', { title: author.name, author, ...result });
});

/* Full-text search --------------------------------------------------------- */
router.get('/search', (req, res) => {
  const q = String(req.query.q || '').slice(0, 80);
  const result = Posts.search(q, { page: pageParam(req), perPage: PER_PAGE });
  res.render('search', { title: q ? `Search: ${q}` : 'Search', ...result });
});

/* Single post -------------------------------------------------------------- */
router.get('/posts/:slug', (req, res, next) => {
  const post = Posts.findBySlug(req.params.slug);
  if (!post) return next();

  const user = req.user;
  const isOwner = user && (user.role === 'admin' || user.id === post.author_id);
  if (post.status !== 'published' && !isOwner) return next();

  // Count one view per session per post so refreshes do not inflate the counter.
  if (post.status === 'published') {
    req.session.viewed = req.session.viewed || {};
    if (!req.session.viewed[post.id]) {
      req.session.viewed[post.id] = true;
      Posts.incrementViews(post.id);
      post.views += 1;
    }
  }

  const commentDraft = req.session.commentDraft || null;
  delete req.session.commentDraft;

  return res.render('post', {
    title: post.title,
    post,
    comments: Comments.listForPost(post.id),
    canEdit: Boolean(isOwner),
    commentDraft
  });
});

/* RSS 2.0 feed ------------------------------------------------------------- */
const xmlEscape = (value) =>
  String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

router.get('/rss.xml', (req, res) => {
  const posts = Posts.latestPublished(20);
  const base = `${req.protocol}://${req.get('host')}`;
  const site = res.app.locals.siteTitle;
  const now = new Date().toUTCString();

  const items = posts
    .map((post) => {
      const url = `${base}/posts/${post.slug}`;
      const date = new Date(`${(post.published_at || post.created_at).replace(' ', 'T')}Z`);
      const pubDate = Number.isNaN(date.getTime()) ? now : date.toUTCString();
      const categories = (post.tags || [])
        .map((tag) => `      <category>${xmlEscape(tag.name)}</category>`)
        .join('\n');
      return `    <item>
      <title>${xmlEscape(post.title)}</title>
      <link>${xmlEscape(url)}</link>
      <guid isPermaLink="true">${xmlEscape(url)}</guid>
      <pubDate>${pubDate}</pubDate>
      <dc:creator>${xmlEscape(post.author_name)}</dc:creator>
      <description>${xmlEscape(post.excerpt || toPlainText(post.body_md).slice(0, 300))}</description>
${categories}
    </item>`;
    })
    .join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>${xmlEscape(site)}</title>
    <link>${xmlEscape(base)}/</link>
    <description>${xmlEscape(res.app.locals.siteDescription)}</description>
    <language>en</language>
    <lastBuildDate>${now}</lastBuildDate>
    <atom:link href="${xmlEscape(base)}/rss.xml" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>
`;

  res.type('application/rss+xml; charset=utf-8').send(xml);
});

module.exports = router;
