import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, isAllowedAppleUrl } from '../server.js';

let server;
let base;

before(async () => {
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((r) => server.close(r)));

test('preview allowlist accepts Apple preview hosts only', () => {
  assert.ok(isAllowedAppleUrl('https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview/x.m4a'));
  assert.ok(isAllowedAppleUrl('https://is1-ssl.mzstatic.com/image/thumb/a.jpg'));
  for (const bad of [
    'http://audio-ssl.itunes.apple.com/x.m4a', // not https
    'https://itunes.apple.com.evil.com/x.m4a', // suffix trick
    'https://evilitunes.apple.com.attacker.net/',
    'https://user:pw@audio-ssl.itunes.apple.com/x',
    'https://audio-ssl.itunes.apple.com:8443/x',
    'https://169.254.169.254/latest/meta-data',
    'file:///etc/passwd',
    'not a url',
  ]) {
    assert.equal(isAllowedAppleUrl(bad), false, bad);
  }
});

test('serves the app with security headers', async () => {
  const r = await fetch(base + '/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
});

test('blocks path traversal out of /public', async () => {
  for (const p of ['/../server.js', '/%2e%2e/server.js', '/%2e%2e%2fpackage.json', '/js/../../server.js']) {
    const r = await fetch(base + p);
    assert.ok([403, 404].includes(r.status), `${p} -> ${r.status}`);
    assert.doesNotMatch(await r.text(), /createServer/);
  }
});

test('preview proxy refuses non-Apple URLs (no open proxy / SSRF)', async () => {
  for (const u of ['http://127.0.0.1:22/', 'https://example.com/a.mp3', 'https://169.254.169.254/']) {
    const r = await fetch(`${base}/api/preview?url=${encodeURIComponent(u)}`);
    assert.equal(r.status, 403, u);
  }
});

test('search validates its input and rejects other methods', async () => {
  assert.equal((await fetch(`${base}/api/search?q=`)).status, 400);
  assert.equal((await fetch(`${base}/api/search?q=${'a'.repeat(101)}`)).status, 400);
  assert.equal((await fetch(`${base}/`, { method: 'POST' })).status, 405);
});
