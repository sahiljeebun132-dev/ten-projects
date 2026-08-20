# Inkwell — a small blogging platform

A complete, server-rendered blogging platform: markdown posts with cover images and
tags, a public feed with pagination and full-text search, an RSS feed, comments with
spam protection, and a role-aware dashboard for authors and administrators.

No build step, no front-end framework, no external services — one Node process and one
SQLite file.

---

## Features

**Authoring**
- Markdown posts rendered with `marked` and sanitised with `DOMPurify` before storage
- Draft / published toggle, per-post slug (auto-generated, collision-safe)
- Cover image upload (JPEG/PNG/GIF/WebP, 2 MB cap, random server-side filenames)
- Tags (many-to-many), auto excerpts, reading-time estimate, view counter
- Dashboard at `/dashboard`: authors see their own posts, admins see everything —
  status badges, view/comment counts and quick actions (edit, publish, delete)

**Public site**
- Paginated home feed, single post pages, tag archives, author archives
- Full-text search over title and body (SQLite FTS5, porter stemming, ranked results)
- RSS 2.0 feed at `/rss.xml`
- Responsive CSS with automatic light/dark themes, no JS required to read or comment

**Comments**
- Name + body on published posts, stored in SQLite
- Hidden honeypot field plus a per-IP rate limit for basic spam control
- Admins can delete any comment from the post page or the dashboard

**Accounts**
- Register / login / logout, bcrypt password hashing, `httpOnly` + `sameSite=lax` cookies
- Roles: `admin` (everything) and `author` (own posts only)
- The first account created on an empty database becomes the admin

## Stack

| Layer | Choice |
| --- | --- |
| Runtime | Node.js 18+ |
| Web framework | Express 4 |
| Database | SQLite via `better-sqlite3` (synchronous, WAL, FTS5) |
| Views | EJS with layout partials |
| Sessions | `express-session` (MemoryStore in dev — swap for a persistent store in prod) |
| Passwords | `bcryptjs` |
| Markdown | `marked` + `dompurify` / `jsdom` |
| Uploads | `multer` (disk storage, mime + size validated) |
| Misc | `dotenv`, `method-override`; `nodemon` for development |

---

## Setup

```bash
npm install
cp .env.example .env          # then edit SESSION_SECRET
npm run seed                  # creates the schema, demo users and 5 sample posts
npm start                     # http://localhost:3000

npm run dev                   # same, with nodemon reload
```

`npm run seed` is safe to re-run: it clears posts, tags and comments, then re-inserts the
samples. Existing user accounts are kept.

### Default credentials

| Role | Email | Password |
| --- | --- | --- |
| admin | `admin@example.com` | `admin123` |
| author | `author@example.com` | `author123` |

> **⚠ Change these before exposing the site to anyone.** They are demo credentials
> published in this repository — treat them as already compromised. Either log in and
> replace them, or delete the database file and register your own first account (the
> first account on an empty database is automatically an admin).

### Environment

`.env.example` documents every variable:

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `SESSION_SECRET` | random per boot | **Required** when `NODE_ENV=production` — the server refuses to start without it |
| `NODE_ENV` | `development` | `production` enables `secure` cookies and hides stack traces |
| `SITE_TITLE` | `Inkwell` | Shown in the header, `<title>` and RSS |
| `SITE_DESCRIPTION` | see `.env.example` | Meta description and RSS channel description |
| `POSTS_PER_PAGE` | `5` | Feed / archive / search page size |
| `DB_FILE` | `db/blog.sqlite` | SQLite file location |

---

## Routes

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/` | public | Paginated feed of published posts (`?page=`) |
| GET | `/posts/:slug` | public | Single post; drafts visible to their author and admins |
| POST | `/posts/:slug/comments` | public | Add a comment (CSRF + honeypot + rate limit) |
| GET | `/tags` | public | All tags with published-post counts |
| GET | `/tags/:slug` | public | Tag archive (`?page=`) |
| GET | `/authors/:slug` | public | Author archive (`?page=`) |
| GET | `/search?q=` | public | Full-text search over title + body (`?page=`) |
| GET | `/rss.xml` | public | RSS 2.0 feed of the 20 newest published posts |
| GET / POST | `/register` | guest | Create an account (first account becomes admin) |
| GET / POST | `/login` | guest | Sign in (rate limited: 5 attempts / 15 min / IP+email) |
| POST | `/logout` | any | Destroy the session |
| GET | `/dashboard` | author | Post table + stats; admins additionally see recent comments |
| GET | `/dashboard/posts/new` | author | New post form |
| POST | `/dashboard/posts` | author | Create a post (multipart, optional cover) |
| GET | `/dashboard/posts/:id/edit` | owner/admin | Edit form |
| PUT | `/dashboard/posts/:id` | owner/admin | Update a post (`?_method=PUT`) |
| POST | `/dashboard/posts/:id/toggle` | owner/admin | Publish ⇄ draft |
| DELETE | `/dashboard/posts/:id` | owner/admin | Delete a post (`?_method=DELETE`) |
| DELETE | `/comments/:id` | admin | Delete a comment (`?_method=DELETE`) |

---

## Database schema

Defined in [`db/schema.sql`](db/schema.sql) and applied automatically on boot when the
tables are missing. Every statement is `IF NOT EXISTS`, so re-running is harmless.

| Table | Columns (abridged) | Notes |
| --- | --- | --- |
| `users` | `id`, `name`, `email` UNIQUE, `password_hash`, `role`, `bio`, `created_at` | `role` is a `CHECK` constraint: `admin` \| `author` |
| `posts` | `id`, `author_id` → `users`, `title`, `slug` UNIQUE, `excerpt`, `body_md`, `body_html`, `cover_image`, `status`, `views`, `reading_time`, `created_at`, `updated_at`, `published_at` | `status` is `draft` \| `published`; `body_html` stores the already-sanitised render |
| `tags` | `id`, `name`, `slug` UNIQUE | Orphan tags are pruned after post edits/deletes |
| `post_tags` | `post_id`, `tag_id` (composite PK) | Many-to-many join, `ON DELETE CASCADE` |
| `comments` | `id`, `post_id` → `posts`, `author_name`, `body`, `created_at` | Cascades when a post is deleted |
| `posts_fts` | `title`, `body` | FTS5 external-content index over `posts`, kept in sync by insert/update/delete triggers |

Foreign keys are enforced (`PRAGMA foreign_keys = ON`) and the database runs in WAL mode.

---

## Security notes

- **SQL injection** — every query is a prepared statement with bound parameters
  (`models/*.js`). No string interpolation of user input into SQL anywhere, including
  the FTS `MATCH` expression, which is rebuilt from tokens extracted server-side.
- **XSS** — EJS `<%= %>` escaping everywhere; the only raw output (`<%- post.body_html %>`)
  is markdown that was rendered *and then* run through DOMPurify with a tag/attribute
  allow-list before being stored. `javascript:` URLs, inline handlers, `<script>`,
  `<style>` and `<iframe>` are all removed.
- **CSRF** — a 32-byte per-session token (`middleware/csrf.js`) is embedded in every
  POST/PUT/DELETE form and compared with `crypto.timingSafeEqual`. Multipart routes
  parse the upload first and then re-run the check (the ordering `csurf` documents),
  so file-upload forms are covered too; a request that fails the check has its
  half-written upload deleted.
- **Sessions** — cookies are `httpOnly`, `sameSite=lax`, `secure` in production, signed
  with `SESSION_SECRET`, and the session ID is regenerated on login and registration to
  prevent fixation.
- **Passwords** — bcrypt with 10 rounds; hashes never leave the model layer and are not
  stored in the session.
- **Brute force** — in-memory fixed-window limiter (`middleware/rateLimit.js`):
  5 login attempts per IP+email per 15 minutes, 10 comments per IP per 10 minutes.
  Single-process only; use Redis behind multiple instances.
- **Uploads** — mime type *and* extension allow-listed, 2 MB / 1 file cap, random
  server-generated filenames (the client filename is discarded), stored outside the
  view path and served with `X-Content-Type-Options: nosniff`.
- **Authorisation** — authors can only read and mutate their own posts; comment
  moderation is admin-only. Checks live in middleware, not in templates.
- **Headers** — `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` and a
  Content-Security-Policy that forbids inline scripts and styles (all behaviour lives
  in `public/js/main.js`). `x-powered-by` is disabled.
- **Known limitations** — the default session store is in-memory (fine for one process,
  not for a cluster) and the rate limiter resets on restart.

---

## Project layout

```
server.js              app wiring: security headers, session, middleware order, routes
db/
  schema.sql           tables, indexes, FTS5 index + sync triggers
  index.js             connection, PRAGMAs, boot-time migration
  seed.js              demo admin/author, 5 posts, tags, comments
models/                user.js, post.js, tag.js, comment.js — all prepared statements
middleware/            auth.js, csrf.js, rateLimit.js, upload.js, flash.js, errors.js
routes/                public.js, auth.js, dashboard.js, comments.js
lib/content.js         markdown render + sanitise, excerpt, reading time, slugify
views/                 EJS templates + partials (head, footer, post-card, pagination)
public/                css/style.css, js/main.js, uploads/
```

## Licence

MIT.
