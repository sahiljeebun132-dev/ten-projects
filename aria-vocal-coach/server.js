// Aria local server: serves the app, proxies song search / 30-second previews from Apple's
// public iTunes Search API (no key needed), and runs the talking AI teacher through Claude.
//
// Security notes:
//  - /api/preview only fetches https URLs on Apple's preview hosts (allowlist), with
//    redirects disabled, a size cap and a content-type check — it is not an open proxy.
//  - Static files are resolved inside ./public only (no path traversal).
//  - Binds to 127.0.0.1 by default; browsers only allow the microphone on localhost/https.
//  - The Claude API key never leaves this process. /api/teacher/chat accepts only same-origin
//    JSON POSTs addressed to localhost (Host allowlist stops DNS rebinding; the exact Origin
//    check stops other websites from spending your key), with size, rate and daily caps.

import http from 'node:http';
import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { teacherConfig, credentialsConfigured, validateChat, streamTeacherReply } from './teacher-chat.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 5190;
const HOST = process.env.HOST || '127.0.0.1';
const MAX_PREVIEW_BYTES = 10 * 1024 * 1024;
const APPLE_HOST = /^(?:[a-z0-9-]+\.)*(?:itunes\.apple\.com|mzstatic\.com)$/i;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://*.mzstatic.com",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; '),
};

// --- tiny per-IP rate limiter for the API ---------------------------------
const hits = new Map();
function rateLimited(ip, limit = 90, windowMs = 60_000) {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || now > entry.reset) {
    hits.set(ip, { count: 1, reset: now + windowMs });
    if (hits.size > 5000) for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
    return false;
  }
  entry.count++;
  return entry.count > limit;
}

function send(res, status, body, headers = {}) {
  const buf = Buffer.from(body);
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Length': buf.length, ...headers });
  res.end(buf);
}

function json(res, status, data) {
  send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
}

export function isAllowedAppleUrl(value) {
  let u;
  try {
    u = value instanceof URL ? value : new URL(String(value));
  } catch {
    return false;
  }
  return (
    u.protocol === 'https:' &&
    APPLE_HOST.test(u.hostname) &&
    !u.username &&
    !u.password &&
    (u.port === '' || u.port === '443')
  );
}

function artwork(url) {
  if (typeof url !== 'string' || !isAllowedAppleUrl(url)) return '';
  return url.replace(/\/\d+x\d+bb\./, '/300x300bb.');
}

// Apple storefronts we search. 'in' (India) has the deepest Hindi / Bollywood catalogue.
export const MARKETS = { in: 'IN', us: 'US', gb: 'GB' };
// Indian chart shelves -> iTunes genre ids (India storefront top-songs feed).
export const CHARTS = { bollywood: 1263, indipop: 1185, sufi: 1268, devotional: 1267, classical: 1269, indian: 1262 };
const CHART_TTL_MS = 30 * 60_000;
const chartCache = new Map();

function lookup(table, key) {
  return typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : null;
}

/** GET JSON from Apple, retrying once on a network blip or 5xx. Returns { status, data }. */
async function appleJson(url) {
  let last = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json' } });
      if (r.ok) return { status: r.status, data: await r.json() };
      last = { status: r.status, data: null };
      if (r.status < 500) return last;
    } catch {
      last = { status: 0, data: null };
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return last;
}

async function handleSearch(url, res) {
  const q = (url.searchParams.get('q') || '').trim();
  if (!q || q.length > 100) return json(res, 400, { error: 'Search for 1–100 characters.' });
  const country = lookup(MARKETS, (url.searchParams.get('market') || 'us').toLowerCase());
  if (!country) return json(res, 400, { error: 'Unknown market.' });
  const limit = Math.min(50, Math.max(5, Number(url.searchParams.get('limit')) || 25));
  const api = new URL('https://itunes.apple.com/search');
  api.search = new URLSearchParams({ term: q, media: 'music', entity: 'song', limit: String(limit), country }).toString();
  const { status, data } = await appleJson(api);
  if (!data) return json(res, 502, { error: status ? `Song search failed (${status}).` : 'Could not reach the song search service. Are you online?' });
  const results = (Array.isArray(data?.results) ? data.results : [])
    .filter((x) => typeof x.previewUrl === 'string' && isAllowedAppleUrl(x.previewUrl))
    .slice(0, limit)
    .map((x) => ({
      id: String(x.trackId ?? ''),
      title: String(x.trackName ?? 'Untitled').slice(0, 200),
      artist: String(x.artistName ?? '').slice(0, 200),
      album: String(x.collectionName ?? '').slice(0, 200),
      genre: String(x.primaryGenreName ?? '').slice(0, 60),
      artwork: artwork(x.artworkUrl100),
      previewUrl: x.previewUrl,
      durationMs: Number(x.trackTimeMillis) || 0,
    }));
  json(res, 200, { results });
}

/** Map one entry of Apple's legacy RSS top-songs feed to our song shape. */
export function chartEntry(e) {
  const links = [].concat(e?.link || []);
  const enclosure = links.find((l) => l?.attributes?.rel === 'enclosure');
  const previewUrl = enclosure?.attributes?.href;
  if (typeof previewUrl !== 'string' || !isAllowedAppleUrl(previewUrl)) return null;
  const images = [].concat(e?.['im:image'] || []);
  return {
    id: String(e?.id?.attributes?.['im:id'] ?? '').slice(0, 40),
    title: String(e?.['im:name']?.label ?? 'Untitled').slice(0, 200),
    artist: String(e?.['im:artist']?.label ?? '').slice(0, 200),
    album: String(e?.['im:collection']?.['im:name']?.label ?? '').slice(0, 200),
    genre: String(e?.category?.attributes?.label ?? '').slice(0, 60),
    artwork: artwork(images[images.length - 1]?.label),
    previewUrl,
    durationMs: 0,
  };
}

async function handleCharts(url, res) {
  const shelf = url.searchParams.get('shelf') || '';
  const genre = lookup(CHARTS, shelf);
  if (!genre) return json(res, 400, { error: 'Unknown chart.' });
  const cached = chartCache.get(shelf);
  if (cached && Date.now() - cached.at < CHART_TTL_MS) return json(res, 200, { results: cached.results });
  const { status, data } = await appleJson(`https://itunes.apple.com/in/rss/topsongs/limit=50/genre=${genre}/json`);
  if (!data) return json(res, 502, { error: status ? `Chart unavailable (${status}).` : 'Could not reach the charts. Are you online?' });
  const results = [].concat(data?.feed?.entry || []).map(chartEntry).filter(Boolean).slice(0, 50);
  chartCache.set(shelf, { at: Date.now(), results });
  json(res, 200, { results });
}

async function handlePreview(url, req, res) {
  const raw = url.searchParams.get('url') || '';
  if (!isAllowedAppleUrl(raw)) return json(res, 403, { error: 'Only Apple preview URLs are allowed.' });
  let upstream;
  try {
    upstream = await fetch(raw, { redirect: 'error', signal: AbortSignal.timeout(20000) });
  } catch {
    return json(res, 502, { error: 'Could not download the preview.' });
  }
  if (!upstream.ok || !upstream.body) return json(res, 502, { error: `Preview unavailable (${upstream.status}).` });
  const length = Number(upstream.headers.get('content-length') || 0);
  if (length > MAX_PREVIEW_BYTES) return json(res, 413, { error: 'Preview too large.' });
  const type = (upstream.headers.get('content-type') || '').toLowerCase();
  if (!/^(audio|video)\//.test(type) && type !== 'application/octet-stream') {
    return json(res, 415, { error: 'Preview is not audio.' });
  }
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': /^(audio|video)\//.test(type) ? type : 'audio/mp4',
    'Cache-Control': 'private, max-age=3600',
    ...(length ? { 'Content-Length': length } : {}),
  });
  if (req.method === 'HEAD') return res.end();
  let total = 0;
  try {
    for await (const chunk of upstream.body) {
      total += chunk.length;
      if (total > MAX_PREVIEW_BYTES) {
        res.destroy();
        return;
      }
      res.write(chunk);
    }
    res.end();
  } catch {
    res.destroy();
  }
}

async function handleStatic(url, req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return send(res, 400, 'Bad request');
  }
  if (pathname.includes('\0')) return send(res, 400, 'Bad request');
  if (pathname === '/') pathname = '/index.html';
  const file = path.resolve(PUBLIC_DIR, '.' + pathname);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  let info;
  try {
    info = await stat(file);
  } catch {
    return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
  if (!info.isFile()) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

// ---------------------------------------------------------------- AI teacher

const MAX_CHAT_BODY = 64 * 1024;
const chatHits = new Map();

/** Reject anything that isn't the app itself, on this machine, talking to us. */
export function localSameOrigin(req) {
  const host = String(req.headers.host || '').toLowerCase();
  const port = req.socket.localPort;
  if (![`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`].includes(host)) return 'The teacher only answers on localhost.';
  if (req.headers.origin !== `http://${host}`) return 'Cross-site requests are not allowed.';
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin') return 'Cross-site requests are not allowed.';
  return null;
}

async function readJsonBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const err = new Error('Request too large.');
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const err = new Error('Request body is not valid JSON.');
    err.status = 400;
    throw err;
  }
}

function teacherErrorMessage(err) {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return 'Claude rejected the API key. Check ANTHROPIC_API_KEY and restart Aria.';
  }
  if (err instanceof Anthropic.RateLimitError) return 'Claude is busy (rate limit). Try again in a minute.';
  if (err instanceof Anthropic.APIConnectionError) return 'I couldn’t reach Claude — are you online?';
  if (err instanceof Anthropic.BadRequestError) return `Claude couldn’t take that request (${err.message.slice(0, 160)}).`;
  if (err instanceof Anthropic.APIError) return `Claude had a problem (${err.status ?? 'error'}). Try again.`;
  if (/auth|credential|api key/i.test(String(err?.message))) return 'No Claude credentials found. Set ANTHROPIC_API_KEY and restart Aria.';
  return 'Something went wrong talking to the teacher.';
}

function makeTeacher({ env, teacherClient }) {
  const config = teacherConfig(env);
  let client = teacherClient || null;
  const day = { date: '', count: 0 };
  const available = () => Boolean(teacherClient) || credentialsConfigured(env);
  const getClient = () => (client ||= new Anthropic());

  async function status(res) {
    json(res, 200, { available: available(), model: config.model });
  }

  async function chat(req, res) {
    const blocked = localSameOrigin(req);
    if (blocked) return json(res, 403, { error: blocked });
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'Send JSON.' });
    if (!available()) return json(res, 503, { error: 'The AI teacher isn’t connected. Set ANTHROPIC_API_KEY and restart Aria.' });
    const ip = req.socket.remoteAddress || 'unknown';
    if (rateLimitedIn(chatHits, ip, 15)) return json(res, 429, { error: 'Let’s slow down a little — a few seconds between questions.' });
    const today = new Date().toISOString().slice(0, 10);
    if (day.date !== today) Object.assign(day, { date: today, count: 0 });
    if (day.count >= config.dailyCap) return json(res, 429, { error: 'That’s today’s conversation limit — rest your voice and come back tomorrow.' });

    let body;
    try {
      body = await readJsonBody(req, MAX_CHAT_BODY);
    } catch (err) {
      return json(res, err.status || 400, { error: err.message });
    }
    const v = validateChat(body);
    if (v.error) return json(res, 400, { error: v.error });
    day.count++;

    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
    const line = (obj) => !res.writableEnded && res.write(`${JSON.stringify(obj)}\n`);
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    try {
      const out = await streamTeacherReply({ client: getClient(), config, messages: v.messages, context: v.context, signal: abort.signal, send: line });
      line({ type: 'done', stop: out.stop, model: out.model, usage: out.usage });
    } catch (err) {
      if (!(err instanceof Anthropic.APIUserAbortError) && !abort.signal.aborted) line({ type: 'error', error: teacherErrorMessage(err) });
    }
    res.end();
  }

  return { status, chat };
}

function rateLimitedIn(map, key, limit, windowMs = 60_000) {
  const now = Date.now();
  const entry = map.get(key);
  if (!entry || now > entry.reset) {
    map.set(key, { count: 1, reset: now + windowMs });
    return false;
  }
  entry.count++;
  return entry.count > limit;
}

/**
 * @param {object} [options]
 * @param {object} [options.env]            environment to read settings/credentials from
 * @param {object} [options.teacherClient]  an Anthropic-compatible client (tests inject a fake)
 */
export function createServer({ env = process.env, teacherClient = null } = {}) {
  const teacher = makeTeacher({ env, teacherClient });
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      if (url.pathname === '/api/teacher/chat') {
        if (req.method !== 'POST') return send(res, 405, 'Method not allowed', { Allow: 'POST' });
        return await teacher.chat(req, res);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return send(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
      }
      if (url.pathname.startsWith('/api/')) {
        if (rateLimited(req.socket.remoteAddress || 'unknown')) return json(res, 429, { error: 'Too many requests — slow down a little.' });
        if (url.pathname === '/api/teacher/status') return await teacher.status(res);
        if (url.pathname === '/api/search') return await handleSearch(url, res);
        if (url.pathname === '/api/charts') return await handleCharts(url, res);
        if (url.pathname === '/api/preview') return await handlePreview(url, req, res);
        return json(res, 404, { error: 'Unknown API route.' });
      }
      return await handleStatic(url, req, res);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) json(res, 500, { error: 'Server error.' });
      else res.destroy();
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createServer().listen(PORT, HOST, () => {
    console.log(`🎤 Aria vocal coach running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  });
}
