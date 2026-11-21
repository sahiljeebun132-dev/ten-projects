'use strict';
/**
 * End-to-end smoke test: boots the real server on a random port with a throwaway DB,
 * then plays two phones ("Alex" and "Sam") against it over HTTP + Socket.IO.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scribble-test-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.DATA_DIR = tmp;

const { io: ioClient } = require('socket.io-client');
const { server } = require('../server');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log('  ✓', msg); };

function once(sock, event, ms = 2000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    sock.once(event, (d) => { clearTimeout(t); resolve(d); });
  });
}
const nothing = (sock, event, ms = 300) => new Promise((resolve) => {
  let got = false;
  const h = () => { got = true; };
  sock.on(event, h);
  setTimeout(() => { sock.off(event, h); resolve(!got); }, ms);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (p, body, token, method = 'POST') => {
    const res = await fetch(base + p, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: res.status, body: await res.json().catch(() => ({})), headers: res.headers };
  };
  const connect = (token) => {
    const s = ioClient(base, { auth: { token }, transports: ['websocket'], forceNew: true, reconnection: false });
    return s;
  };

  console.log('pairing');
  const cfg = await fetch(base + '/api/config').then((r) => r.json());
  ok(typeof cfg.vapidPublicKey === 'string' && cfg.vapidPublicKey.length > 40, 'config exposes a VAPID public key');
  const home = await fetch(base + '/');
  ok(home.headers.get('content-security-policy')?.includes("script-src 'self'"), 'pages are served with a strict CSP');

  ok((await post('/api/pair', { name: '' })).status === 400, 'empty name is rejected');
  const a = await post('/api/pair', { name: 'Alex' });
  ok(a.status === 201 && /^[A-Z2-9]{6}$/.test(a.body.inviteCode), 'Alex creates a pair and gets a 6-char code');

  const alex = connect(a.body.token);
  const s0 = await once(alex, 'state');
  ok(s0.partner === null && s0.invite === a.body.inviteCode, 'before pairing, Alex sees the invite code and no partner');

  ok((await post('/api/join', { name: 'Sam', code: 'ZZZZZZ' })).status === 400, 'a wrong code is rejected');
  const joinedEvt = once(alex, 'partner:joined');
  const b = await post('/api/join', { name: 'Sam', code: a.body.inviteCode.toLowerCase() });
  ok(b.status === 201 && b.body.token, 'Sam joins with the code (case-insensitive)');
  const sam = connect(b.body.token);
  const sState = await once(sam, 'state');
  ok(sState.partner && sState.partner.name === 'Alex', 'Sam sees Alex as partner');
  ok((await joinedEvt).name === 'Sam', 'Alex is told Sam joined');
  ok((await post('/api/join', { name: 'Eve', code: a.body.inviteCode })).status === 400, 'the code is single-use: a third person cannot join');

  // Alex reconnects for a fresh snapshot, like the real client does.
  alex.disconnect();
  const alex2 = connect(a.body.token);
  const aState = await once(alex2, 'state');
  ok(aState.partner && aState.partner.name === 'Sam', 'Alex now sees Sam as partner');
  ok(await nothing(sam, 'partner:joined', 400), 'reconnecting does not re-announce the join (no reconnect loop)');

  console.log('live drawing');
  const startEvt = once(sam, 'stroke:start');
  alex2.emit('stroke:start', { sid: 1, color: '#FF4F7B', width: 0.012, erase: false, points: [[0.1, 0.1]] });
  const st = await startEvt;
  ok(st.color === '#ff4f7b' && st.points.length === 1, 'Sam sees Alex start a line instantly');
  const ptsEvt = once(sam, 'stroke:points');
  alex2.emit('stroke:points', { sid: 1, points: [[0.2, 0.2], [0.3, 0.25]] });
  ok((await ptsEvt).points.length === 2, 'points stream to Sam while Alex is still drawing');
  const endEvt = once(sam, 'stroke:end');
  const ack = await new Promise((r) => alex2.emit('stroke:end', { sid: 1 }, r));
  const end = await endEvt;
  ok(Number.isInteger(ack.id) && end.id === ack.id, 'stroke is committed and both agree on its id');

  alex2.emit('stroke:start', { sid: 2, color: 'red; background:url(x)', width: 0.01, points: [[0.1, 0.1]] });
  ok(await nothing(sam, 'stroke:start'), 'a stroke with an invalid colour is dropped');
  alex2.emit('stroke:start', { sid: 3, color: '#000000', width: 0.01, points: [[5, 5]] });
  ok(await nothing(sam, 'stroke:start'), 'out-of-canvas coordinates are dropped');
  alex2.emit('stroke:points', { sid: 999, points: [[0.1, 0.1]] });
  ok(await nothing(sam, 'stroke:points'), 'points for an unknown stroke are dropped');

  // Persistence: a fresh connection sees the committed stroke.
  const peek = connect(b.body.token);
  const pState = await once(peek, 'state');
  ok(pState.strokes.length === 1 && pState.strokes[0].points.length === 3, 'the canvas is saved and restored on reconnect');
  peek.disconnect();

  const remEvt = once(alex2, 'stroke:removed');
  sam.emit('stroke:undo');
  ok(await nothing(alex2, 'stroke:removed', 300), "Sam's undo cannot remove Alex's line");
  alex2.emit('stroke:undo');
  ok((await remEvt).id === ack.id, 'Alex can undo his own last line');

  alex2.emit('stroke:start', { sid: 4, color: '#3a86ff', width: 0.02, points: [[0.5, 0.5]] });
  alex2.emit('stroke:end', { sid: 4 });
  await sleep(100);
  const clrEvt = once(alex2, 'canvas:cleared');
  sam.emit('canvas:clear');
  ok((await clrEvt).by === sState.me.id, 'clear wipes the canvas for both phones');

  console.log('notes & nudges');
  const noteEvt = once(alex2, 'note:new');
  const nAck = await new Promise((r) => sam.emit('note:send', { text: '<img src=x onerror=alert(1)> feed me', emoji: '🍕', color: '#ffb3c7' }, r));
  const n = (await noteEvt).note;
  ok(nAck.ok && n.text.startsWith('<img'), 'notes arrive verbatim (the client renders them with textContent)');
  ok(n.emoji === '🍕' && n.color === '#ffb3c7' && n.x >= 0 && n.x <= 1, 'note keeps its sticker, paper colour and a position');
  const bad = await new Promise((r) => sam.emit('note:send', { text: 'x'.repeat(141) }, r));
  ok(bad.error, 'notes over 140 characters are refused');
  const forced = await new Promise((r) => sam.emit('note:send', { text: 'hi', emoji: '<script>', color: 'javascript:' }, r));
  ok(forced.ok, 'unknown sticker/colour fall back to safe defaults');
  const delEvt = once(sam, 'note:deleted');
  alex2.emit('note:delete', { id: n.id });
  ok((await delEvt).id === n.id, 'either partner can peel a note off');

  const nudgeEvt = once(sam, 'nudge');
  alex2.emit('nudge', { kind: 'kiss' });
  ok((await nudgeEvt).kind === 'kiss', 'nudges (heart/kiss/hug/poke) reach the partner');

  console.log('presence');
  const presEvt = once(sam, 'presence');
  alex2.emit('visibility', { visible: false });
  const pres = await presEvt;
  ok(pres.online === true && pres.active === false, 'Sam sees when Alex puts the app in the background');

  console.log('push subscriptions');
  const goodSub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'BOr'.padEnd(87, 'x'), auth: 'abcdefghijklmnopqrstuv' } };
  ok((await post('/api/push', { subscription: goodSub }, b.body.token)).status === 200, 'a real push-service subscription is accepted');
  const ssrf = { ...goodSub, endpoint: 'https://169.254.169.254/latest/meta-data' };
  ok((await post('/api/push', { subscription: ssrf }, b.body.token)).status === 400, 'subscriptions pointing anywhere but a push service are refused');
  ok((await post('/api/push', { subscription: goodSub })).status === 401, 'push endpoints require a device token');
  const bad1 = connect('not-a-real-token-at-all-nope');
  const err = await once(bad1, 'connect_error');
  ok(err.message === 'unauthorized', 'sockets with a bad token are refused');

  console.log('unpairing');
  const leftEvt = once(sam, 'partner:left');
  ok((await post('/api/me', undefined, a.body.token, 'DELETE')).status === 200, 'Alex unpairs');
  await leftEvt;
  ok(true, 'Sam is told Alex left');
  ok((await post('/api/push', { subscription: null }, a.body.token)).status === 401, "Alex's old token no longer works");
  ok((await post('/api/me', undefined, b.body.token, 'DELETE')).status === 200, 'Sam unpairs, deleting the pair');

  sam.disconnect();
  console.log(`\n${passed} checks passed`);
}

main()
  .then(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(0); })
  .catch((e) => { console.error('\n✗ FAILED:', e); process.exit(1); });
