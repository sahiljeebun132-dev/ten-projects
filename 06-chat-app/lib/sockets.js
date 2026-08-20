'use strict';

const db = require('./db');
const {
  LIMITS,
  validateMessage,
  validateRoomName,
  isAllowedReaction,
  cleanText,
  dmKey,
  clampLimit,
  createRateLimiter
} = require('./sanitise');

/* --------------------------------------------------------------- helpers */

const roomChannel = (name) => `room:${name}`;
const dmChannel = (key) => key;                       // dm keys are already namespaced
const userChannel = (nick) => `user:${String(nick).toLowerCase()}`;

/** Nicknames currently connected (any socket). nickLower -> {nickname, sockets:Set} */
const online = new Map();

/** typing state: target -> Map(nickname -> timeoutHandle) */
const typing = new Map();

const TYPING_TTL = 6000;

function addOnline(socket) {
  const nick = socket.data.user.nickname;
  const key = nick.toLowerCase();
  let entry = online.get(key);
  if (!entry) {
    entry = { nickname: nick, sockets: new Set() };
    online.set(key, entry);
  }
  entry.sockets.add(socket.id);
  return entry.sockets.size === 1; // true => this user just came online
}

function removeOnline(socket) {
  const nick = socket.data.user && socket.data.user.nickname;
  if (!nick) return false;
  const key = nick.toLowerCase();
  const entry = online.get(key);
  if (!entry) return false;
  entry.sockets.delete(socket.id);
  if (entry.sockets.size === 0) {
    online.delete(key);
    return true; // user fully offline
  }
  return false;
}

function isOnline(nick) {
  return online.has(String(nick).toLowerCase());
}

function onlineList() {
  const nicks = [...online.values()].map((e) => e.nickname);
  const seen = db.getLastSeen(nicks);
  return nicks
    .map((n) => ({ nickname: n, lastSeen: seen[n] || null, online: true }))
    .sort((a, b) => a.nickname.localeCompare(b.nickname));
}

/** Distinct nicknames present in a socket.io channel. */
function occupants(io, channel) {
  const ids = io.sockets.adapter.rooms.get(channel);
  if (!ids) return [];
  const set = new Map();
  for (const id of ids) {
    const s = io.sockets.sockets.get(id);
    if (s && s.data.user) set.set(s.data.user.nickname.toLowerCase(), s.data.user.nickname);
  }
  return [...set.values()].sort((a, b) => a.localeCompare(b));
}

function broadcastMembers(io, roomName) {
  const members = occupants(io, roomChannel(roomName));
  const seen = db.getLastSeen(members);
  io.to(roomChannel(roomName)).emit('room:members', {
    room: roomName,
    members: members.map((n) => ({ nickname: n, lastSeen: seen[n] || null, online: true }))
  });
}

function broadcastPresence(io) {
  io.emit('presence:online', { users: onlineList() });
}

function broadcastRooms(io) {
  const rooms = db.listRooms();
  const counts = db.memberCounts();
  io.emit('rooms:updated', {
    rooms: rooms.map((r) => ({
      name: r.name,
      topic: r.topic,
      isDefault: !!r.is_default,
      members: counts[r.id] || 0
    }))
  });
}

function roomsForUser(io, userId) {
  const counts = db.memberCounts();
  return db.listMemberships(userId).map((r) => ({
    name: r.name,
    topic: r.topic,
    isDefault: !!r.is_default,
    members: counts[r.id] || 0,
    unread: db.countUnread(r.id, r.last_read_at),
    online: occupants(io, roomChannel(r.name)).length
  }));
}

function allRooms() {
  const counts = db.memberCounts();
  return db.listRooms().map((r) => ({
    name: r.name,
    topic: r.topic,
    isDefault: !!r.is_default,
    members: counts[r.id] || 0
  }));
}

function clearTyping(io, target, nickname) {
  const map = typing.get(target);
  if (!map || !map.has(nickname)) return;
  clearTimeout(map.get(nickname));
  map.delete(nickname);
  if (map.size === 0) typing.delete(target);
  emitTyping(io, target);
}

function emitTyping(io, target) {
  const map = typing.get(target);
  const users = map ? [...map.keys()] : [];
  io.to(target).emit('typing:update', { target, users });
}

function markTyping(io, target, nickname) {
  let map = typing.get(target);
  if (!map) {
    map = new Map();
    typing.set(target, map);
  }
  const existing = map.get(nickname);
  if (existing) clearTimeout(existing);
  map.set(nickname, setTimeout(() => clearTyping(io, target, nickname), TYPING_TTL));
  emitTyping(io, target);
}

/** Persist + broadcast a `system` message into a room. */
function systemMessage(io, room, text) {
  const msg = db.insertMessage({
    roomId: room.id,
    userId: null,
    nickname: 'system',
    body: text,
    kind: 'system'
  });
  io.to(roomChannel(room.name)).emit('message:new', { target: `#${room.name}`, message: msg });
  return msg;
}

/** Wrap an ack callback so a missing/!function callback never throws. */
const ack = (cb) => (payload) => {
  if (typeof cb === 'function') cb(payload);
  return payload;
};

/**
 * Handle `/me` and `/shrug` slash commands.
 * Returns { body, kind } or { error }.
 */
function applySlashCommands(raw) {
  const text = raw;
  if (/^\/me\s+/i.test(text)) {
    const rest = cleanText(text.replace(/^\/me\s+/i, ''));
    if (!rest) return { error: 'Usage: /me <action>' };
    return { body: rest, kind: 'me' };
  }
  if (/^\/shrug\b/i.test(text)) {
    const rest = cleanText(text.replace(/^\/shrug\b/i, ''));
    const shrug = '¯\\_(ツ)_/¯';
    return { body: rest ? `${rest} ${shrug}` : shrug, kind: 'chat' };
  }
  if (/^\//.test(text) && !/^\/\//.test(text)) {
    const cmd = text.split(/\s+/)[0];
    return { error: `Unknown command ${cmd}. Try /me or /shrug.` };
  }
  return { body: text, kind: 'chat' };
}

/* ------------------------------------------------------------------ main */

function register(io) {
  io.use((socket, next) => {
    const session = socket.request.session;
    if (!session || !session.user) {
      return next(new Error('NOT_AUTHENTICATED'));
    }
    const user = db.getUserById(session.user.id);
    if (!user) return next(new Error('NOT_AUTHENTICATED'));
    socket.data.user = { id: user.id, nickname: user.nickname, isGuest: !!user.is_guest };
    next();
  });

  io.on('connection', (socket) => {
    const user = socket.data.user;
    const limitMessages = createRateLimiter({ capacity: 10, refillPerSec: 4 });
    const limitActions = createRateLimiter({ capacity: 30, refillPerSec: 10 });
    const limitTyping = createRateLimiter({ capacity: 20, refillPerSec: 8 });

    socket.data.openDms = new Set();

    const firstConnection = addOnline(socket);
    db.touchLastSeen(user.id);
    socket.join(userChannel(user.nickname));

    socket.emit('session:ready', {
      user,
      rooms: roomsForUser(io, user.id),
      allRooms: allRooms(),
      online: onlineList(),
      limits: LIMITS
    });

    if (firstConnection) broadcastPresence(io);
    else socket.emit('presence:online', { users: onlineList() });

    /* --------------------------------------------------------- room list */

    socket.on('room:list', (payload, cb) => {
      ack(cb)({ ok: true, rooms: roomsForUser(io, user.id), allRooms: allRooms() });
    });

    /* --------------------------------------------------------- presence */

    // Pull-style presence, so a client that missed a broadcast (or just
    // reconnected) can resynchronise without waiting for the next event.
    socket.on('presence:list', (payload = {}, cb) => {
      if (!limitActions()) return ack(cb)({ ok: false, error: 'Slow down.' });
      const check = payload && payload.room ? validateRoomName(payload.room) : null;
      const out = { ok: true, users: onlineList() };
      if (check && check.ok) {
        const room = db.getRoomByName(check.value);
        if (room) {
          const members = occupants(io, roomChannel(room.name));
          const seen = db.getLastSeen(members);
          out.room = room.name;
          out.members = members.map((n) => ({ nickname: n, lastSeen: seen[n] || null, online: true }));
        }
      }
      ack(cb)(out);
    });

    /* ------------------------------------------------------------- join */

    socket.on('room:join', (payload = {}, cb) => {
      if (!limitActions()) return ack(cb)({ ok: false, error: 'Slow down.' });
      const check = validateRoomName(payload.room);
      if (!check.ok) return ack(cb)({ ok: false, error: check.error });
      const room = db.getRoomByName(check.value);
      if (!room) return ack(cb)({ ok: false, error: 'No such room.' });

      const channel = roomChannel(room.name);
      const alreadyHere = occupants(io, channel).some((n) => n.toLowerCase() === user.nickname.toLowerCase());
      const wasMember = db.listMemberships(user.id).some((m) => m.id === room.id);

      db.joinRoom(user.id, room.id);
      socket.join(channel);
      db.markRead(user.id, room.id);

      const history = db.getRoomHistory(room.id, { limit: clampLimit(payload.limit) });

      ack(cb)({
        ok: true,
        room: { name: room.name, topic: room.topic, isDefault: !!room.is_default },
        messages: history.messages,
        hasMore: history.hasMore,
        members: occupants(io, channel).map((n) => ({ nickname: n, online: true }))
      });

      if (!alreadyHere) {
        systemMessage(io, room, `${user.nickname} joined ${'#' + room.name}`);
      }
      broadcastMembers(io, room.name);
      if (!wasMember) broadcastRooms(io);
    });

    /* ------------------------------------------------------------ leave */

    socket.on('room:leave', (payload = {}, cb) => {
      if (!limitActions()) return ack(cb)({ ok: false, error: 'Slow down.' });
      const check = validateRoomName(payload.room);
      if (!check.ok) return ack(cb)({ ok: false, error: check.error });
      const room = db.getRoomByName(check.value);
      if (!room) return ack(cb)({ ok: false, error: 'No such room.' });

      socket.leave(roomChannel(room.name));
      db.leaveRoom(user.id, room.id);
      clearTyping(io, roomChannel(room.name), user.nickname);
      ack(cb)({ ok: true, room: room.name });

      systemMessage(io, room, `${user.nickname} left ${'#' + room.name}`);
      broadcastMembers(io, room.name);
      broadcastRooms(io);
    });

    /* ----------------------------------------------------------- create */

    socket.on('room:create', (payload = {}, cb) => {
      if (!limitActions(3)) return ack(cb)({ ok: false, error: 'Slow down.' });
      const check = validateRoomName(payload.name);
      if (!check.ok) return ack(cb)({ ok: false, error: check.error });
      const topic = cleanText(payload.topic || '').slice(0, LIMITS.TOPIC_MAX);
      const created = db.createRoom(check.value, { topic, createdBy: user.id });
      if (!created.ok) return ack(cb)({ ok: false, error: created.error });

      db.joinRoom(user.id, created.room.id);
      socket.join(roomChannel(created.room.name));
      ack(cb)({ ok: true, room: { name: created.room.name, topic: created.room.topic, isDefault: false } });

      io.emit('room:created', {
        room: { name: created.room.name, topic: created.room.topic, isDefault: false, members: 1 },
        by: user.nickname
      });
      systemMessage(io, created.room, `${user.nickname} created ${'#' + created.room.name}`);
      broadcastMembers(io, created.room.name);
      broadcastRooms(io);
    });

    /* ---------------------------------------------------------- history */

    socket.on('room:history', (payload = {}, cb) => {
      if (!limitActions()) return ack(cb)({ ok: false, error: 'Slow down.' });
      const check = validateRoomName(payload.room);
      if (!check.ok) return ack(cb)({ ok: false, error: check.error });
      const room = db.getRoomByName(check.value);
      if (!room) return ack(cb)({ ok: false, error: 'No such room.' });
      const before = Number.parseInt(payload.before, 10) || null;
      const history = db.getRoomHistory(room.id, { before, limit: payload.limit });
      ack(cb)({ ok: true, room: room.name, ...history });
    });

    socket.on('room:read', (payload = {}, cb) => {
      const check = validateRoomName(payload.room);
      if (!check.ok) return ack(cb)({ ok: false, error: check.error });
      const room = db.getRoomByName(check.value);
      if (!room) return ack(cb)({ ok: false, error: 'No such room.' });
      db.markRead(user.id, room.id);
      ack(cb)({ ok: true });
    });

    /* --------------------------------------------------------------- DM */

    socket.on('dm:open', (payload = {}, cb) => {
      if (!limitActions()) return ack(cb)({ ok: false, error: 'Slow down.' });
      const to = cleanText(payload.to || '');
      if (!to) return ack(cb)({ ok: false, error: 'Missing recipient.' });
      if (to.toLowerCase() === user.nickname.toLowerCase()) {
        return ack(cb)({ ok: false, error: 'You cannot DM yourself.' });
      }
      const peer = db.findUserByNickname(to);
      if (!peer) return ack(cb)({ ok: false, error: 'No such user.' });

      const key = dmKey(user.nickname, peer.nickname);
      socket.join(dmChannel(key));
      socket.data.openDms.add(key);
      const history = db.getDmHistory(key, { limit: clampLimit(payload.limit) });
      ack(cb)({
        ok: true,
        dm: { key, peer: peer.nickname, online: isOnline(peer.nickname), lastSeen: peer.last_seen_at },
        messages: history.messages,
        hasMore: history.hasMore
      });
    });

    socket.on('dm:history', (payload = {}, cb) => {
      if (!limitActions()) return ack(cb)({ ok: false, error: 'Slow down.' });
      const to = cleanText(payload.to || '');
      const peer = db.findUserByNickname(to);
      if (!peer) return ack(cb)({ ok: false, error: 'No such user.' });
      const key = dmKey(user.nickname, peer.nickname);
      const before = Number.parseInt(payload.before, 10) || null;
      const history = db.getDmHistory(key, { before, limit: payload.limit });
      ack(cb)({ ok: true, dm: key, ...history });
    });

    /* ---------------------------------------------------------- message */

    socket.on('message:send', (payload = {}, cb) => {
      if (!limitMessages()) {
        return ack(cb)({ ok: false, error: 'You are sending messages too quickly.', code: 'RATE_LIMIT' });
      }
      const clientId = typeof payload.clientId === 'string' ? payload.clientId.slice(0, 64) : null;
      const parsed = applySlashCommands(cleanText(payload.body || ''));
      if (parsed.error) return ack(cb)({ ok: false, error: parsed.error, clientId });

      const check = validateMessage(parsed.body);
      if (!check.ok) return ack(cb)({ ok: false, error: check.error, clientId });

      const replyToId = Number.parseInt(payload.replyTo, 10) || null;

      // Direct message
      if (payload.to) {
        const peer = db.findUserByNickname(cleanText(payload.to));
        if (!peer) return ack(cb)({ ok: false, error: 'No such user.', clientId });
        if (peer.id === user.id) return ack(cb)({ ok: false, error: 'You cannot DM yourself.', clientId });
        const key = dmKey(user.nickname, peer.nickname);
        const msg = db.insertMessage({
          dmKeyValue: key,
          userId: user.id,
          nickname: user.nickname,
          body: check.value,
          kind: parsed.kind,
          replyToId
        });
        socket.join(dmChannel(key));
        clearTyping(io, dmChannel(key), user.nickname);
        // Deliver to both participants' personal channels so an unopened DM
        // still pops up on the recipient's side.
        io.to(userChannel(user.nickname)).to(userChannel(peer.nickname)).emit('message:new', {
          target: key,
          dm: { key, peer: peer.nickname, from: user.nickname },
          message: msg
        });
        return ack(cb)({ ok: true, message: msg, clientId, target: key });
      }

      // Room message
      const roomCheck = validateRoomName(payload.room);
      if (!roomCheck.ok) return ack(cb)({ ok: false, error: roomCheck.error, clientId });
      const room = db.getRoomByName(roomCheck.value);
      if (!room) return ack(cb)({ ok: false, error: 'No such room.', clientId });

      const channel = roomChannel(room.name);
      if (!socket.rooms.has(channel)) {
        // Auto-join on send (covers reconnect races) but keep membership honest.
        db.joinRoom(user.id, room.id);
        socket.join(channel);
        broadcastMembers(io, room.name);
      }

      const msg = db.insertMessage({
        roomId: room.id,
        userId: user.id,
        nickname: user.nickname,
        body: check.value,
        kind: parsed.kind,
        replyToId
      });
      clearTyping(io, channel, user.nickname);
      db.markRead(user.id, room.id);
      io.to(channel).emit('message:new', { target: `#${room.name}`, message: msg });
      return ack(cb)({ ok: true, message: msg, clientId, target: `#${room.name}` });
    });

    /* -------------------------------------------------- edit / delete */

    function targetOf(msg) {
      return msg.dmKey ? msg.dmKey : `#${msg.room}`;
    }

    function channelOf(msg) {
      return msg.dmKey ? dmChannel(msg.dmKey) : roomChannel(msg.room);
    }

    socket.on('message:edit', (payload = {}, cb) => {
      if (!limitActions(2)) return ack(cb)({ ok: false, error: 'Slow down.' });
      const id = Number.parseInt(payload.id, 10);
      if (!id) return ack(cb)({ ok: false, error: 'Missing message id.' });
      const check = validateMessage(cleanText(payload.body || ''));
      if (!check.ok) return ack(cb)({ ok: false, error: check.error });
      const res = db.editMessage(id, user.id, check.value);
      if (!res.ok) return ack(cb)({ ok: false, error: res.error });
      io.to(channelOf(res.message)).emit('message:updated', {
        target: targetOf(res.message),
        message: res.message
      });
      if (res.message.dmKey) {
        io.to(userChannel(user.nickname)).emit('message:updated', {
          target: targetOf(res.message), message: res.message
        });
      }
      ack(cb)({ ok: true, message: res.message });
    });

    socket.on('message:delete', (payload = {}, cb) => {
      if (!limitActions(2)) return ack(cb)({ ok: false, error: 'Slow down.' });
      const id = Number.parseInt(payload.id, 10);
      if (!id) return ack(cb)({ ok: false, error: 'Missing message id.' });
      const res = db.deleteMessage(id, user.id);
      if (!res.ok) return ack(cb)({ ok: false, error: res.error });
      io.to(channelOf(res.message)).emit('message:updated', {
        target: targetOf(res.message),
        message: res.message
      });
      ack(cb)({ ok: true, message: res.message });
    });

    socket.on('message:react', (payload = {}, cb) => {
      if (!limitActions()) return ack(cb)({ ok: false, error: 'Slow down.' });
      const id = Number.parseInt(payload.id, 10);
      if (!id) return ack(cb)({ ok: false, error: 'Missing message id.' });
      if (!isAllowedReaction(payload.emoji)) return ack(cb)({ ok: false, error: 'Unsupported reaction.' });
      const res = db.toggleReaction(id, user.id, user.nickname, payload.emoji);
      if (!res.ok) return ack(cb)({ ok: false, error: res.error });
      io.to(channelOf(res.message)).emit('message:updated', {
        target: targetOf(res.message),
        message: res.message
      });
      ack(cb)({ ok: true, message: res.message });
    });

    /* ----------------------------------------------------------- typing */

    function typingTarget(payload) {
      if (payload && payload.to) {
        const peer = db.findUserByNickname(cleanText(payload.to));
        if (!peer) return null;
        return dmChannel(dmKey(user.nickname, peer.nickname));
      }
      const check = validateRoomName(payload && payload.room);
      if (!check.ok) return null;
      const room = db.getRoomByName(check.value);
      return room ? roomChannel(room.name) : null;
    }

    socket.on('typing:start', (payload = {}) => {
      if (!limitTyping()) return;
      const target = typingTarget(payload);
      if (target) markTyping(io, target, user.nickname);
    });

    socket.on('typing:stop', (payload = {}) => {
      if (!limitTyping()) return;
      const target = typingTarget(payload);
      if (target) clearTyping(io, target, user.nickname);
    });

    /* ------------------------------------------------------- disconnect */

    // socket.rooms is emptied *before* the `disconnect` event fires, so the
    // channel list has to be captured during `disconnecting`.
    socket.on('disconnecting', () => {
      socket.data.lastRooms = [...socket.rooms]
        .filter((c) => c.startsWith('room:'))
        .map((c) => c.slice('room:'.length));
      for (const c of socket.rooms) clearTyping(io, c, user.nickname);
    });

    socket.on('disconnect', () => {
      const nowTs = Date.now();
      db.touchLastSeen(user.id, nowTs);

      const roomNames = socket.data.lastRooms || [];
      const wentOffline = removeOnline(socket);

      // Recompute occupancy on the next tick, once this socket is fully gone.
      setImmediate(() => {
        for (const name of roomNames) {
          const room = db.getRoomByName(name);
          if (room && wentOffline) {
            const stillHere = occupants(io, roomChannel(name))
              .some((n) => n.toLowerCase() === user.nickname.toLowerCase());
            if (!stillHere) systemMessage(io, room, `${user.nickname} left ${'#' + name}`);
          }
          broadcastMembers(io, name);
        }
        if (wentOffline) broadcastPresence(io);
      });
    });
  });
}

module.exports = { register, isOnline, onlineList, applySlashCommands };
