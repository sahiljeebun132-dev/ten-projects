'use strict';

const { marked } = require('marked');
const createDOMPurify = require('dompurify');
const { JSDOM } = require('jsdom');

const window = new JSDOM('').window;
const DOMPurify = createDOMPurify(window);

marked.setOptions({ gfm: true, breaks: false, headerIds: false, mangle: false });

// Conservative allow-list: markdown output only, no scripts / styles / iframes.
const SANITIZE_CONFIG = {
  ALLOWED_TAGS: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'strong', 'em', 'del', 's',
    'blockquote', 'ul', 'ol', 'li', 'a', 'img', 'code', 'pre', 'table', 'thead',
    'tbody', 'tfoot', 'tr', 'th', 'td', 'sup', 'sub'
  ],
  ALLOWED_ATTR: ['href', 'title', 'alt', 'src', 'class', 'colspan', 'rowspan'],
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|\/|#)/i,
  FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'input'],
  FORBID_ATTR: ['style', 'onerror', 'onload', 'onclick']
};

/** Render markdown to sanitised HTML. Never returns unsanitised markup. */
function renderMarkdown(md) {
  const html = marked.parse(String(md || ''));
  return DOMPurify.sanitize(html, SANITIZE_CONFIG);
}

/** Strip markdown syntax down to readable plain text (for excerpts / RSS). */
function toPlainText(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
        .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Build an excerpt of at most `max` characters, cut on a word boundary. */
function buildExcerpt(md, max = 200) {
  const text = toPlainText(md);
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 60 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

/** Reading-time estimate in whole minutes (200 wpm, minimum 1). */
function readingTime(md) {
  const words = toPlainText(md).split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

/** URL-safe slug. Falls back to a timestamp when the input has no usable chars. */
function slugify(input) {
  const slug = String(input || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  return slug || `post-${Date.now()}`;
}

module.exports = { renderMarkdown, toPlainText, buildExcerpt, readingTime, slugify };
