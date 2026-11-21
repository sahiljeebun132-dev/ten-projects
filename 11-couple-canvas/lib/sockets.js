'use strict';

/**
 * Real-time layer. Each pair shares a Socket.IO room. Strokes are streamed point-by-point
 * while you draw (so your partner watches the line appear), then committed to SQLite.
 *
 * Client -> server                      Server -> partner (and/or both)
 *   stroke:start {sid,color,width,erase,points}   stroke:start {key,by,...}
 *   stroke:points {sid, points}                   stroke:points {key, points}
 *   stroke:end {sid}                              stroke:end {key, id}
 *   stroke:undo                                   stroke:removed {id}
 *   canvas:clear                                  canvas:cleared {by}
 *   note:send {text,emoji,color}                  note:new {note}       (both)
 *   note:delete {id}                              note:deleted {id}     (both)
 *   nudge {kind}                                  nudge {kind, from}
 *   visibility {visible}                          presence {online, active}
 */

const db = require('./db');
const push = require('./push');
const { validateStrokeStart, validatePoints, validateNote, LIMITS } = require('./validate');

const DOODLE_PUSH_EVERY_MS = 3 * 60 * 1000;
const NUDGES = { heart: '💗 sent you a heart', poke: '👉 poked you', kiss: '😘 sent you a kiss', hug: '🫂 sent you a hug' };

/** Tiny token bucket so one client can't flood the other phone or the database. */
function bucket(capacity, refillPerSec) {
  let tokens = capacity;
  let last = Date.now();
  return () => {
    const now = Date.now();
    tokens = Math.min(capacity, tokens + ((now - last) / 1000) * refillPerSec);
    last = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

function attach(io) {
  /** memberId -> Map<socketId, {visible:boolean}> */
  const live = new Map();
  /** memberId -> timestamp of last "is doodling" push */
  const lastDoodlePush = new Map();

  const isOnline = (memberId) => (live.get(memberId)?.size || 0) > 0;
  const isActive = (memberId) => [...(live.get(memberId)?.values() || [])].some((s) => s.visible);

  function sendPresence(member) {
    const partner = db.partnerOf(member);
    if (!partner) return;
    // Tell each side about the *other* one.
    io.to(`m:${partner.id}`).emit('presence', { online: isOnline(member.id), active: isActive(member.id) });
    io.to(`m:${member.id}`).emit('presence', { online: isOnline(partner.id), active: isActive(partner.id) });
  }

  // Authenticate the handshake with the device token from POST /api/pair or /api/join.
  io.use((socket, next) => {
    const member = db.memberByToken(socket.handshake.auth && socket.handshake.auth.token);
    if (!member) return next(new Error('unauthorized'));
    socket.data.memberId = member.id;
    socket.data.pairId = member.pair_id;
    next();
  });

  io.on('connection', (socket) => {
    const { memberId, pairId } = socket.data;
    const room = `p:${pairId}`;
    // Re-read the member each time we need fresh push_sub / partner info.
    const me = () => db.memberById(memberId);

    socket.join(room);
    socket.join(`m:${memberId}`);
    if (!live.has(memberId)) live.set(memberId, new Map());
    live.get(memberId).set(socket.id, { visible: true });

    const allow = {
      points: bucket(120, 60),
      stroke: bucket(30, 8),
      note: bucket(6, 0.2),
      nudge: bucket(8, 0.5),
      clear: bucket(3, 0.1)
    };

    /** Partner is "away" when none of their screens are open – that's when we push. */
    function pushPartner(payload) {
      const partner = db.partnerOf(me());
      if (partner && !isActive(partner.id)) push.notify(partner, payload);
    }

    // Initial snapshot.
    const member = me();
    const partner = db.partnerOf(member);
    socket.emit('state', {
      me: { id: member.id, name: member.name, push: !!member.push_sub },
      partner: partner ? { id: partner.id, name: partner.name, online: isOnline(partner.id), active: isActive(partner.id) } : null,
      invite: partner ? null : (db.inviteFor(pairId) || db.refreshInvite(pairId)),
      strokes: db.strokesFor(pairId),
      notes: db.notesFor(pairId)
    });
    sendPresence(member);

    /* -------------------------------------------- live drawing */
    /** sid (client stroke id) -> in-progress stroke being streamed */
    const drawing = new Map();

    socket.on('stroke:start', (d) => {
      if (!allow.stroke()) return;
      const s = validateStrokeStart(d);
      const sid = Number.isInteger(d?.sid) ? d.sid : null;
      if (!s || sid === null || drawing.size > 4) return;
      drawing.set(sid, s);
      socket.to(room).emit('stroke:start', { key: `${memberId}:${sid}`, by: memberId, ...s });
    });

    socket.on('stroke:points', (d) => {
      if (!allow.points()) return;
      const s = drawing.get(d?.sid);
      const pts = validatePoints(d?.points);
      if (!s || !pts || s.points.length + pts.length > LIMITS.POINTS_PER_STROKE) return;
      s.points.push(...pts);
      socket.to(room).emit('stroke:points', { key: `${memberId}:${d.sid}`, points: pts });
    });

    socket.on('stroke:end', (d, ack) => {
      const s = drawing.get(d?.sid);
      if (!s) return;
      drawing.delete(d.sid);
      const id = db.addStroke(pairId, memberId, s);
      socket.to(room).emit('stroke:end', { key: `${memberId}:${d.sid}`, id });
      if (typeof ack === 'function') ack({ id });

      const last = lastDoodlePush.get(memberId) || 0;
      if (!s.erase && Date.now() - last > DOODLE_PUSH_EVERY_MS) {
        const partnerNow = db.partnerOf(me());
        if (partnerNow && !isActive(partnerNow.id)) {
          lastDoodlePush.set(memberId, Date.now());
          push.notify(partnerNow, { title: me().name, body: '✏️ is doodling on your canvas', tag: 'doodle' });
        }
      }
    });

    socket.on('stroke:undo', () => {
      if (!allow.stroke()) return;
      const id = db.undoLast(pairId, memberId);
      if (id) io.to(room).emit('stroke:removed', { id });
    });

    socket.on('canvas:clear', () => {
      if (!allow.clear()) return;
      db.clearCanvas(pairId);
      io.to(room).emit('canvas:cleared', { by: memberId });
    });

    /* -------------------------------------------- notes & nudges */
    socket.on('note:send', (d, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      if (!allow.note()) return reply({ error: 'Slow down a little 🙂' });
      const n = validateNote(d);
      if (!n) return reply({ error: 'Notes need 1–140 characters.' });
      const note = db.addNote(pairId, memberId, n);
      io.to(room).emit('note:new', { note });
      reply({ ok: true, id: note.id });
      pushPartner({ title: me().name, body: `${note.emoji} ${note.text}`, tag: `note-${note.id}` });
    });

    socket.on('note:delete', (d) => {
      const id = Number(d?.id);
      if (Number.isInteger(id) && db.deleteNote(pairId, id)) io.to(room).emit('note:deleted', { id });
    });

    socket.on('nudge', (d) => {
      if (!allow.nudge()) return;
      const kind = Object.hasOwn(NUDGES, d?.kind) ? d.kind : 'heart';
      socket.to(room).emit('nudge', { kind, from: memberId });
      pushPartner({ title: me().name, body: NUDGES[kind], tag: 'nudge' });
    });

    /* -------------------------------------------- presence */
    socket.on('visibility', (d) => {
      const entry = live.get(memberId)?.get(socket.id);
      if (!entry) return;
      entry.visible = d?.visible === true;
      sendPresence(me());
    });

    socket.on('disconnect', () => {
      const set = live.get(memberId);
      if (set) {
        set.delete(socket.id);
        if (set.size === 0) live.delete(memberId);
      }
      const m = me();
      if (!m) return; // they unpaired – nothing left to save or announce
      // A half-drawn line still counts: commit what we received.
      for (const [sid, s] of drawing) {
        if (s.points.length > 1) {
          const id = db.addStroke(pairId, memberId, s);
          socket.to(room).emit('stroke:end', { key: `${memberId}:${sid}`, id });
        }
      }
      sendPresence(m);
    });
  });

  /** Called by REST when someone unpairs, so their open sockets close. */
  return {
    kick(memberId) {
      io.in(`m:${memberId}`).disconnectSockets(true);
    }
  };
}

module.exports = { attach };
