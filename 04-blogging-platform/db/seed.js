'use strict';

/**
 * Seed the database with a demo admin, a demo author, five posts, tags and
 * comments. Safe to re-run: existing posts/tags/comments are cleared first,
 * user accounts are reused.
 *
 *   npm run seed
 */

require('dotenv').config({ quiet: true });

const { db, DB_FILE } = require('./index');
const Users = require('../models/user');
const Posts = require('../models/post');
const Tags = require('../models/tag');
const Comments = require('../models/comment');

const ADMIN = { name: 'Ada Admin', email: 'admin@example.com', password: 'admin123', role: 'admin',
  bio: 'Runs this blog and keeps the comment section civil.' };
const AUTHOR = { name: 'Ben Author', email: 'author@example.com', password: 'author123', role: 'author',
  bio: 'Writes about databases, small tools and the joy of plain HTML.' };

const SAMPLE_POSTS = [
  {
    title: 'Why SQLite is a perfectly good production database',
    tags: 'sqlite, databases, architecture',
    author: 'admin',
    daysAgo: 21,
    body: `SQLite has a reputation as a "toy" database, and it is completely undeserved.
It is the most widely deployed database engine in the world, it is fully ACID, and for
the read-heavy workload of a typical blog it is *faster* than a networked database
simply because there is no network.

## What you actually get

- Single-file storage that you can copy, back up or ship with a Docker image.
- Write-ahead logging (WAL) so readers never block on a writer.
- Real foreign keys, transactions, window functions and full-text search.

\`\`\`sql
PRAGMA journal_mode = WAL;
SELECT title, views FROM posts WHERE status = 'published' ORDER BY views DESC LIMIT 5;
\`\`\`

## When to reach for something else

If you need many concurrent writers across several machines, or a managed failover
story, then Postgres is the right call. Until then, the honest answer is that a
single well-indexed SQLite file will happily serve more traffic than your blog will
ever see.

> The best database is the one you never have to think about at 3am.`
  },
  {
    title: 'Rendering markdown safely: marked plus DOMPurify',
    tags: 'security, markdown, javascript',
    author: 'admin',
    daysAgo: 16,
    body: `Markdown renderers happily pass raw HTML through to the output. That is a feature
for trusted authors and a cross-site-scripting hole for everyone else, so the rendered
HTML has to be sanitised before it is stored or displayed.

## The pipeline

1. \`marked.parse()\` turns the markdown into HTML.
2. \`DOMPurify.sanitize()\` strips anything that is not on the allow-list.
3. The clean HTML is written to \`posts.body_html\` so rendering a page is a single read.

\`\`\`js
const html = marked.parse(bodyMarkdown);
const safe = DOMPurify.sanitize(html, { ALLOWED_TAGS: [...], ALLOWED_ATTR: [...] });
\`\`\`

Note the ordering: sanitise **after** rendering, never before. Sanitising markdown
source is meaningless because the dangerous constructs only appear once the HTML has
been generated. Test it with \`<img src=x onerror=alert(1)>\` and a
\`javascript:\` link — both should come out inert.`
  },
  {
    title: 'A CSRF token in forty lines of Express middleware',
    tags: 'security, express, javascript',
    author: 'author',
    daysAgo: 11,
    body: `You do not need a library to protect a session-based app from cross-site request
forgery. You need a random per-session token, a hidden field in every form, and a
constant-time comparison on unsafe methods.

## The middleware

\`\`\`js
function csrfToken(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;
  next();
}
\`\`\`

The verification half rejects any POST, PUT, PATCH or DELETE whose token does not
match the session. Use \`crypto.timingSafeEqual\` rather than \`===\` so the comparison
does not leak the token one byte at a time.

## The multipart gotcha

File uploads are parsed by multer, so at the point the global check runs the body is
still an unread stream. The fix is boring: run the token check again immediately after
the upload parser on those routes.`
  },
  {
    title: 'Pagination, reading time and other small touches',
    tags: 'design, ux, express',
    author: 'author',
    daysAgo: 6,
    body: `The difference between a blog that feels finished and one that does not is a
handful of details that each take about ten minutes.

## Reading time

Word count divided by 200, rounded, minimum one. It does not have to be accurate — it
has to set an expectation before someone commits to a page of text.

## Pagination that survives bad input

Clamp the requested page between 1 and the number of pages you actually have. A
\`?page=99999\` should quietly show the last page rather than an empty screen, and
\`?page=-4\` should not produce a negative SQL offset.

## Excerpts

Strip the markdown, cut on a word boundary, add an ellipsis. Never cut mid-word and
never dump raw markdown syntax into a preview card.`
  },
  {
    title: 'Full-text search with SQLite FTS5',
    tags: 'sqlite, search, databases',
    author: 'admin',
    daysAgo: 2,
    body: `Searching with \`LIKE '%term%'\` works until it does not: no ranking, no stemming and
a full table scan every time. SQLite ships FTS5, which gives you all three for the cost
of one virtual table and three triggers.

## External content tables

\`\`\`sql
CREATE VIRTUAL TABLE posts_fts USING fts5(
  title, body, content='posts', content_rowid='id', tokenize='porter unicode61'
);
\`\`\`

Because the index stores no copy of the text, it stays small; triggers on insert,
update and delete keep it in step with the \`posts\` table.

## Ranking

Ordering by the built-in \`rank\` column puts the best matches first, and the porter
tokenizer means a search for *database* also finds *databases*. Always build the MATCH
expression from tokens you have extracted yourself — never interpolate raw user input
into FTS syntax.`
  }
];

const SAMPLE_COMMENTS = [
  { post: 0, name: 'Marta',  body: 'We moved a small internal tool from Postgres to SQLite last year and the ops burden basically vanished. Fully agree.' },
  { post: 0, name: 'Devon',  body: 'Curious how you handle backups — litestream, or just copying the file?' },
  { post: 1, name: 'Priya',  body: 'The "sanitise after rendering, never before" line should be printed on a poster.' },
  { post: 2, name: 'Sam',    body: 'The multipart gotcha cost me an afternoon once. Thanks for writing it down.' },
  { post: 4, name: 'Yusuf',  body: 'FTS5 with the porter tokenizer is such an underrated feature. Great write-up.' },
  { post: 4, name: 'Elena',  body: 'Does the trigger approach slow down bulk imports much?' }
];

const daysAgoStamp = (days) =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');

function ensureUser(spec) {
  const existing = Users.findByEmail(spec.email);
  if (existing) return existing;
  return Users.create(spec);
}

function run() {
  console.log(`\nSeeding ${DB_FILE} …`);

  const admin = ensureUser(ADMIN);
  const author = ensureUser(AUTHOR);

  // Clear content so repeated seeds stay deterministic (users are kept).
  db.exec('DELETE FROM comments; DELETE FROM post_tags; DELETE FROM posts; DELETE FROM tags;');

  const created = [];
  SAMPLE_POSTS.forEach((sample) => {
    const tagRows = Tags.parseAndUpsert(sample.tags);
    const post = Posts.create({
      author_id: sample.author === 'admin' ? admin.id : author.id,
      title: sample.title,
      body_md: sample.body,
      status: 'published',
      tagIds: tagRows.map((t) => t.id)
    });

    const stamp = daysAgoStamp(sample.daysAgo);
    db.prepare('UPDATE posts SET created_at = ?, updated_at = ?, published_at = ?, views = ? WHERE id = ?')
      .run(stamp, stamp, stamp, 40 + Math.floor(Math.random() * 400), post.id);

    created.push(post);
  });

  SAMPLE_COMMENTS.forEach((c) => {
    const post = created[c.post];
    if (post) Comments.create({ post_id: post.id, author_name: c.name, body: c.body });
  });

  const counts = {
    users: Users.count(),
    posts: created.length,
    tags: db.prepare('SELECT COUNT(*) AS n FROM tags').get().n,
    comments: Comments.count()
  };

  console.log(`  users: ${counts.users}  posts: ${counts.posts}  tags: ${counts.tags}  comments: ${counts.comments}`);
  console.log('\n  Default accounts');
  console.log(`    admin   ${ADMIN.email}   password: ${ADMIN.password}`);
  console.log(`    author  ${AUTHOR.email}  password: ${AUTHOR.password}`);
  console.log('\n  ⚠  CHANGE THESE CREDENTIALS before deploying anywhere public.');
  console.log('     They are demo credentials committed to a public repo — treat them as compromised.\n');
}

run();
