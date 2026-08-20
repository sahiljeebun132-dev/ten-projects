'use strict';

/**
 * End-to-end smoke test.
 *
 * Boots a real server on a scratch database, connects TWO socket.io clients
 * with real session cookies, and exercises the full feature set:
 * rooms, messaging, history persistence across reconnect, pagination,
 * typing, presence, DMs, reactions, edit/delete, slash commands,
 * validation and rate limiting.
 *
 *   npm run smoke                                   # boots its own server
 *   SMOKE_URL=http://localhost:4006 npm run smoke   # test a running server
 *
 * Exits non-zero on the first failure.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { io } = require('socket.io-client');

const ESC = '\x1b';
const C = { ok: ESC + '[32m', bad: ESC + '[31m', off: ESC + '[0m' };

const EXTERNAL = process.env.SMOKE_URL || null;
const PORT = Number(process.env.SMOKE_PORT || 4310);
const BASE = EXTERNAL || `http://127.0.0.1:${PORT}`;
const TMP_DB = path.join(__dirname, '..', 'db', 'smoke-test.sqlite');

let child = null;
let passed = 0;
const sockets = [];

/* ------------------------------------------------------------ helpers */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => process.stdout.write(msg + '\n');

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    log(`  ${C.ok}PASS${C.off} ${name}`);
  } catch (err) {
    log(`  ${C.bad}FAIL${C.off} ${name}`);
    log(`       ${err && err.message}`);
    throw err;
  }
}

/** Wait for `event` on `socket`, optionally matching a predicate. */
function waitFor(socket, event, predicate, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timed out after ${timeout}ms waiting for "${event}"`));
    }, timeout);
    function handler(payload) {
      if (predicate && !predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    }
    socket.on(event, handler);
  });
}

/** Promise wrapper around socket.emit with acknowledgement. */
function ask(socket, event, payload, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ack timeout for "${event}"`)), timeout);
    socket.emit(event, payload, (res) => { clearTimeout(timer); resolve(res); });
  });
}

async function waitForServer(tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch (_) { /* not up yet */ }
    await sleep(200);
  }
  throw new Error(`server at ${BASE} never became healthy`);
}

/** Sign in over HTTP and return the session cookie. */
async function login(nickname, password) {
  const res = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname, password: password || '' })
  });
  const body = await res.json();
  if (!body.ok) throw new Error(`login failed for ${nickname}: ${body.error}`);
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
  const cookie = raw.filter(Boolean).map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error('no session cookie returned');
  return { cookie, user: body.user };
}

/** Connect a socket.io client carrying `cookie`; resolves once session:ready fires. */
function connect(cookie) {
  return new Promise((resolve, reject) => {
    const socket = io(BASE, {
      extraHeaders: { Cookie: cookie },
      transports: ['polling', 'websocket'],
      reconnection: false,
      timeout: 6000
    });
    sockets.push(socket);
    const timer = setTimeout(() => reject(new Error('socket never became ready')), 8000);
    socket.on('connect_error', (err) => { clearTimeout(timer); reject(err); });
    socket.once('session:ready', (data) => {
      clearTimeout(timer);
      socket.ready = data;
      resolve(socket);
    });
  });
}


/* --------------------------------------------------------------- main */

async function main() {
  if (!EXTERNAL) {
    for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, SESSION_SECRET: 'smoke-test-secret' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', () => {});
    child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  }

  await waitForServer();
  log(`\nSmoke test against ${BASE}\n`);

  /* --------------------------------------------------------- HTTP layer */
  log('HTTP');

  await test('GET / serves the app shell', async () => {
    const res = await fetch(`${BASE}/`);
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('/socket.io/socket.io.js'), 'index.html must load the local socket.io client');
  });

  await test('GET /socket.io/socket.io.js is served by our own server', async () => {
    const res = await fetch(`${BASE}/socket.io/socket.io.js`);
    assert.strictEqual(res.status, 200);
    const js = await res.text();
    assert.ok(js.length > 1000, 'client bundle looks empty');
  });

  await test('unauthenticated /api/me is 401', async () => {
    const res = await fetch(`${BASE}/api/me`);
    assert.strictEqual(res.status, 401);
  });

  await test('login rejects an invalid nickname', async () => {
    const res = await fetch(`${BASE}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: 'a' })
    });
    assert.strictEqual(res.status, 400);
  });

  const nickA = 'alice_' + Math.random().toString(36).slice(2, 6);
  const nickB = 'bob_' + Math.random().toString(36).slice(2, 6);

  const a = await login(nickA, 'hunter22');   // registered (bcrypt password)
  const b = await login(nickB);               // guest

  await test('a registered user must supply the right password', async () => {
    const res = await fetch(`${BASE}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: nickA, password: 'wrong-one' })
    });
    const body = await res.json();
    assert.strictEqual(body.ok, false);
    assert.strictEqual(body.code, 'BAD_CREDENTIALS');
  });

  await test('a registered user cannot sign in without a password', async () => {
    const res = await fetch(`${BASE}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: nickA })
    });
    const body = await res.json();
    assert.strictEqual(body.code, 'PASSWORD_REQUIRED');
  });

  /* ------------------------------------------------------------ sockets */
  log('\nSockets - shared session');

  await test('a socket without a session cookie is rejected', async () => {
    const err = await new Promise((resolve) => {
      const s = io(BASE, { transports: ['websocket'], reconnection: false, timeout: 4000 });
      sockets.push(s);
      s.on('connect_error', (e) => resolve(e));
      s.on('connect', () => resolve(null));
      setTimeout(() => resolve(new Error('timeout')), 5000);
    });
    assert.ok(err, 'connection should not have succeeded');
    assert.match(String(err.message), /NOT_AUTHENTICATED|timeout/);
  });

  const A = await connect(a.cookie);
  const B = await connect(b.cookie);

  await test('session:ready carries the signed-in user and the seeded rooms', () => {
    assert.strictEqual(A.ready.user.nickname, a.user.nickname);
    const names = A.ready.rooms.map((r) => r.name).sort();
    assert.deepStrictEqual(names, ['dev', 'general', 'random']);
    assert.strictEqual(A.ready.user.isGuest, false);
    assert.strictEqual(B.ready.user.isGuest, true);
  });

  /* --------------------------------------------------------------- rooms */
  log('\nRooms');

  await test('both clients join #general', async () => {
    const ra = await ask(A, 'room:join', { room: 'general' });
    const rb = await ask(B, 'room:join', { room: 'general' });
    assert.ok(ra.ok && rb.ok, 'join failed');
    assert.strictEqual(ra.room.name, 'general');
    assert.ok(Array.isArray(ra.messages));
  });

  await test('room:members lists both nicknames', async () => {
    const wait = waitFor(A, 'room:members', (d) => {
      const names = d.members.map((m) => m.nickname);
      return d.room === 'general' && names.includes(nickA) && names.includes(nickB);
    });
    await ask(B, 'room:join', { room: 'general' });
    const ev = await wait;
    assert.strictEqual(ev.room, 'general');
  });

  await test('presence:list reports both users as online', async () => {
    const res = await ask(A, 'presence:list', { room: 'general' });
    assert.ok(res.ok);
    const nicks = res.users.map((u) => u.nickname);
    assert.ok(nicks.includes(nickA) && nicks.includes(nickB), `got ${nicks.join(',')}`);
    const members = res.members.map((m) => m.nickname);
    assert.ok(members.includes(nickA) && members.includes(nickB), 'room members incomplete');
  });

  await test('presence:online is broadcast when someone connects and disconnects', async () => {
    const nickC = 'carol_' + Math.random().toString(36).slice(2, 6);
    const c = await login(nickC);

    const arrived = waitFor(A, 'presence:online', (d) => d.users.some((u) => u.nickname === nickC));
    const C3 = await connect(c.cookie);
    await arrived;

    const departed = waitFor(A, 'presence:online', (d) => !d.users.some((u) => u.nickname === nickC));
    C3.disconnect();
    await departed;
  });

  await test('last-seen is recorded for an offline user', async () => {
    const res = await ask(A, 'presence:list', {});
    assert.ok(res.users.every((u) => u.online === true));
    const dm = await ask(A, 'dm:open', { to: nickB });
    assert.ok(dm.ok);
    assert.strictEqual(typeof dm.dm.lastSeen, 'number');
  });

  await test('invalid room names are rejected', async () => {
    assert.strictEqual((await ask(A, 'room:join', { room: '## bad name!!' })).ok, false);
    assert.strictEqual((await ask(A, 'room:create', { name: 'x' })).ok, false);
    assert.strictEqual((await ask(A, 'room:create', { name: 'a'.repeat(40) })).ok, false);
  });

  await test('a new room can be created and is announced to everyone', async () => {
    const announced = waitFor(B, 'room:created', (d) => d.room.name === 'smoke-room');
    const res = await ask(A, 'room:create', { name: '#Smoke Room', topic: 'temporary' });
    assert.ok(res.ok, res.error);
    assert.strictEqual(res.room.name, 'smoke-room');
    await announced;
  });

  await test('creating a duplicate room fails', async () => {
    assert.strictEqual((await ask(A, 'room:create', { name: 'general' })).ok, false);
  });

  /* ------------------------------------------------------------ messages */
  log('\nMessaging');

  let firstId = null;

  await test('a message sent by A is received by BOTH clients', async () => {
    const gotA = waitFor(A, 'message:new', (d) => d.message.body === 'hello from A');
    const gotB = waitFor(B, 'message:new', (d) => d.message.body === 'hello from A');
    const res = await ask(A, 'message:send', { room: 'general', body: 'hello from A', clientId: 'c1' });
    assert.ok(res.ok, res.error);
    assert.strictEqual(res.clientId, 'c1');
    const [ea, eb] = await Promise.all([gotA, gotB]);
    assert.strictEqual(ea.target, '#general');
    assert.strictEqual(eb.message.nickname, nickA);
    firstId = ea.message.id;
  });

  await test("a reply from B quotes A's message for both clients", async () => {
    const gotA = waitFor(A, 'message:new', (d) => d.message.body === 'hi A');
    await ask(B, 'message:send', { room: 'general', body: 'hi A', replyTo: firstId });
    const ev = await gotA;
    assert.ok(ev.message.replyTo, 'replyTo missing');
    assert.strictEqual(ev.message.replyTo.id, firstId);
    assert.strictEqual(ev.message.replyTo.nickname, nickA);
  });

  await test('/me renders as an action message', async () => {
    const got = waitFor(B, 'message:new', (d) => d.message.kind === 'me');
    await ask(A, 'message:send', { room: 'general', body: '/me waves' });
    const ev = await got;
    assert.strictEqual(ev.message.body, 'waves');
  });

  await test('/shrug appends the shrug glyph', async () => {
    const shrug = '¯\\_(ツ)_/¯';
    const got = waitFor(B, 'message:new', (d) => d.message.body.indexOf(shrug) !== -1);
    await ask(A, 'message:send', { room: 'general', body: '/shrug oh well' });
    const ev = await got;
    assert.ok(ev.message.body.startsWith('oh well'));
  });

  await test('unknown slash commands are rejected', async () => {
    const res = await ask(A, 'message:send', { room: 'general', body: '/nope' });
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /Unknown command/);
  });

  await test('over-long messages are rejected server-side', async () => {
    const res = await ask(A, 'message:send', { room: 'general', body: 'x'.repeat(2500) });
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /at most/);
  });

  await test('empty / whitespace-only messages are rejected', async () => {
    assert.strictEqual((await ask(A, 'message:send', { room: 'general', body: '   ' })).ok, false);
  });

  await test('messages to a non-existent room are rejected', async () => {
    assert.strictEqual((await ask(A, 'message:send', { room: 'nowhere', body: 'hi' })).ok, false);
  });

  await test('markup is stored verbatim (escaping happens at render time)', async () => {
    const evil = '<img src=x onerror=alert(1)> & <b>bold</b>';
    const got = waitFor(B, 'message:new', (d) => d.message.body === evil);
    const res = await ask(A, 'message:send', { room: 'general', body: evil });
    assert.ok(res.ok);
    const ev = await got;
    assert.strictEqual(ev.message.body, evil);
  });

  /* --------------------------------------------------- reactions & edit */
  log('\nReactions, edit, delete');

  const THUMB = '\u{1F44D}';

  await test("B reacting to A's message updates both clients", async () => {
    const got = waitFor(A, 'message:updated', (d) => d.message.id === firstId && d.message.reactions[THUMB]);
    const res = await ask(B, 'message:react', { id: firstId, emoji: THUMB });
    assert.ok(res.ok, res.error);
    const ev = await got;
    assert.deepStrictEqual(ev.message.reactions[THUMB], [nickB]);
  });

  await test('reacting again toggles the reaction off', async () => {
    const got = waitFor(A, 'message:updated', (d) => d.message.id === firstId && !d.message.reactions[THUMB]);
    await ask(B, 'message:react', { id: firstId, emoji: THUMB });
    await got;
  });

  await test('unsupported reaction emoji are rejected', async () => {
    assert.strictEqual((await ask(B, 'message:react', { id: firstId, emoji: '\u{1F480}' })).ok, false);
  });

  await test('A can edit its own message; B sees the update', async () => {
    const got = waitFor(B, 'message:updated', (d) => d.message.id === firstId && d.message.body === 'hello from A (edited)');
    const res = await ask(A, 'message:edit', { id: firstId, body: 'hello from A (edited)' });
    assert.ok(res.ok, res.error);
    const ev = await got;
    assert.ok(ev.message.editedAt, 'editedAt not set');
  });

  await test("B cannot edit or delete A's message", async () => {
    const edit = await ask(B, 'message:edit', { id: firstId, body: 'hijacked' });
    assert.strictEqual(edit.ok, false);
    assert.match(edit.error, /your own/);
    assert.strictEqual((await ask(B, 'message:delete', { id: firstId })).ok, false);
  });

  /* ------------------------------------------------------------ typing */
  log('\nTyping & presence');

  await test('typing:start from A reaches B', async () => {
    const got = waitFor(B, 'typing:update', (d) => d.users.indexOf(nickA) !== -1);
    A.emit('typing:start', { room: 'general' });
    const ev = await got;
    assert.ok(ev.target.indexOf('general') !== -1);
  });

  await test('typing:stop from A clears the indicator for B', async () => {
    const got = waitFor(B, 'typing:update', (d) => d.users.length === 0);
    A.emit('typing:stop', { room: 'general' });
    await got;
  });

  await test("sending a message clears the sender's typing state", async () => {
    A.emit('typing:start', { room: 'general' });
    await waitFor(B, 'typing:update', (d) => d.users.indexOf(nickA) !== -1);
    const cleared = waitFor(B, 'typing:update', (d) => d.users.indexOf(nickA) === -1);
    await ask(A, 'message:send', { room: 'general', body: 'done typing' });
    await cleared;
  });

  /* ---------------------------------------------------------------- DMs */
  log('\nDirect messages');

  await test('A opens a DM with B and both receive the message', async () => {
    const open = await ask(A, 'dm:open', { to: nickB });
    assert.ok(open.ok, open.error);
    assert.strictEqual(open.dm.peer, nickB);
    assert.strictEqual(open.dm.online, true);

    const gotB = waitFor(B, 'message:new', (d) => d.message.body === 'psst, private');
    const res = await ask(A, 'message:send', { to: nickB, body: 'psst, private' });
    assert.ok(res.ok, res.error);
    const ev = await gotB;
    assert.ok(ev.target.startsWith('dm:'));
    assert.strictEqual(ev.dm.from, nickA);
  });

  await test('a DM is NOT delivered into the room channel', async () => {
    const dm = await ask(A, 'dm:history', { to: nickB });
    assert.ok(dm.ok);
    assert.ok(dm.messages.some((m) => m.body === 'psst, private'));
    const room = await ask(A, 'room:history', { room: 'general', limit: 100 });
    assert.ok(!room.messages.some((m) => m.body === 'psst, private'), 'DM leaked into the room');
  });

  await test('DMs to yourself and to unknown users are rejected', async () => {
    assert.strictEqual((await ask(A, 'dm:open', { to: nickA })).ok, false);
    assert.strictEqual((await ask(A, 'dm:open', { to: 'nobody-here' })).ok, false);
  });

  /* -------------------------------------------------------- pagination */
  log('\nHistory & pagination');

  await test('history paginates with a `before` cursor', async () => {
    const page1 = await ask(A, 'room:history', { room: 'general', limit: 3 });
    assert.ok(page1.ok);
    assert.strictEqual(page1.messages.length, 3);
    assert.strictEqual(page1.hasMore, true, 'expected more pages');

    const page2 = await ask(A, 'room:history', { room: 'general', limit: 3, before: page1.messages[0].id });
    assert.ok(page2.messages.length > 0);
    const ids1 = page1.messages.map((m) => m.id);
    const ids2 = page2.messages.map((m) => m.id);
    assert.ok(Math.max(...ids2) < Math.min(...ids1), 'page 2 must be strictly older');
  });

  await test('history is ordered oldest to newest', async () => {
    const res = await ask(A, 'room:history', { room: 'general', limit: 20 });
    const ids = res.messages.map((m) => m.id);
    assert.deepStrictEqual(ids, ids.slice().sort((x, y) => x - y));
  });

  /* --------------------------------------------------------- reconnect */
  log('\nReconnect & persistence');

  let A2 = null;

  await test('history survives a full disconnect + reconnect', async () => {
    const sawLeave = waitFor(B, 'message:new', (d) => d.message.kind === 'system' && /left/.test(d.message.body), 8000);
    A.disconnect();
    await sawLeave;

    A2 = await connect(a.cookie);
    const joined = await ask(A2, 'room:join', { room: 'general' });
    assert.ok(joined.ok);
    const bodies = joined.messages.map((m) => m.body);
    assert.ok(bodies.includes('hello from A (edited)'), 'edited message missing after reconnect');
    assert.ok(bodies.includes('hi A'), "B's reply missing after reconnect");

    const dm = await ask(A2, 'dm:history', { to: nickB });
    assert.ok(dm.messages.some((m) => m.body === 'psst, private'), 'DM history lost');

    const gotB = waitFor(B, 'message:new', (d) => d.message.body === 'back online');
    await ask(A2, 'message:send', { room: 'general', body: 'back online' });
    await gotB;
  });

  await test('join / leave broadcast system messages', async () => {
    const gotJoin = waitFor(A2, 'message:new', (d) => d.message.kind === 'system' && /joined/.test(d.message.body), 8000);
    await ask(A2, 'room:join', { room: 'smoke-room' });
    await ask(B, 'room:join', { room: 'smoke-room' });
    await gotJoin;

    const gotLeave = waitFor(A2, 'message:new',
      (d) => d.message.kind === 'system' && d.message.body.indexOf(nickB) === 0 && /left/.test(d.message.body), 8000);
    await ask(B, 'room:leave', { room: 'smoke-room' });
    await gotLeave;
  });

  await test('A deletes its own message and both clients see the tombstone', async () => {
    const got = waitFor(B, 'message:updated', (d) => d.message.id === firstId && d.message.deleted);
    const res = await ask(A2, 'message:delete', { id: firstId });
    assert.ok(res.ok, res.error);
    const ev = await got;
    assert.strictEqual(ev.message.body, '');
    assert.strictEqual(ev.message.deleted, true);
  });

  /* -------------------------------------------------------- rate limit */
  log('\nRate limiting');

  await test('a burst of messages is throttled per socket', async () => {
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) => ask(A2, 'message:send', { room: 'general', body: 'burst ' + i }))
    );
    const rejected = results.filter((r) => !r.ok);
    assert.ok(rejected.length > 0, 'rate limiter never fired');
    assert.ok(rejected.some((r) => r.code === 'RATE_LIMIT'), 'expected a RATE_LIMIT code');
    assert.ok(results.filter((r) => r.ok).length > 0, 'everything was rejected');
  });

  await test('the token bucket refills after a pause', async () => {
    await sleep(1200);
    const res = await ask(A2, 'message:send', { room: 'general', body: 'after the pause' });
    assert.ok(res.ok, res.error);
  });

  log(`\n${C.ok}${passed} checks passed.${C.off}\n`);
}

function cleanup() {
  for (const s of sockets) { try { s.close(); } catch (_) {} }
  if (child) { try { child.kill('SIGTERM'); } catch (_) {} }
  if (!EXTERNAL) {
    setTimeout(() => {
      for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) {
        try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {}
      }
    }, 300);
  }
}

main()
  .then(() => { cleanup(); setTimeout(() => process.exit(0), 600); })
  .catch((err) => {
    log(`\n${C.bad}Smoke test failed:${C.off} ` + ((err && err.stack) || err) + '\n');
    cleanup();
    setTimeout(() => process.exit(1), 600);
  });
