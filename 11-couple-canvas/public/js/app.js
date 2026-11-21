/* Scribble Us – client. Vanilla JS, no build step. */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const TOKEN_KEY = 'scribble.token';

  const COLORS = ['#2b2230', '#ff4f7b', '#ff9f1c', '#2ec4b6', '#3a86ff', '#8338ec'];
  const SIZES = [0.006, 0.012, 0.024]; // fraction of canvas width
  const ERASER_SIZE = 0.05;
  const ASPECT = 3 / 4; // every phone shares the same portrait page, letterboxed to fit
  const FLUSH_MS = 35;

  const PRESETS = [
    'You are my favourite notification',
    'Feed me 🍕',
    'Stop being cute, I am trying to work',
    'Brb, thinking about you',
    'Bring snacks home pls 🍫',
    'Miss you already 🥺',
    'Who is the best? You.',
    'Rate my drawing /10',
    'I just smiled at my phone like an idiot',
    'Nap together later? 😴'
  ];
  const NUDGE_EMOJI = { heart: ['💗', '💖', '💕', '❤️'], kiss: ['😘', '💋', '💗'], hug: ['🫂', '🤗', '💞'], poke: ['👉', '😜', '👈'] };
  const NUDGE_TEXT = { heart: 'sent you a heart', kiss: 'sent you a kiss', hug: 'sent you a hug', poke: 'poked you' };

  const state = {
    token: safeGet(TOKEN_KEY),
    socket: null,
    config: null,
    me: null,
    partner: null,
    strokes: [], // committed, in draw order
    remoteLive: new Map(), // key -> stroke being drawn by partner
    myLive: new Map(), // sid -> stroke I'm drawing (until server confirms)
    notes: new Map(),
    color: COLORS[0],
    sizeIdx: 1,
    erasing: false,
    nextSid: 1,
    partnerDrawingTimer: null,
    noteDraft: { emoji: '💌', color: '#ffe36e' }
  };

  /* ================================================== storage (may be blocked) */
  function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
  function safeSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } }

  /* ================================================== screens & feedback */
  function show(id) {
    for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== id;
    if (id === 'screen-main') requestAnimationFrame(layout);
  }

  let toastTimer;
  function toast(msg, ms = 2600) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  function burst(kind) {
    const pool = NUDGE_EMOJI[kind] || NUDGE_EMOJI.heart;
    const layer = $('#burst');
    for (let i = 0; i < 18; i++) {
      const s = document.createElement('span');
      s.textContent = pool[i % pool.length];
      s.style.left = `${Math.random() * 92}%`;
      s.style.animationDelay = `${Math.random() * 0.6}s`;
      s.style.setProperty('--drift', `${(Math.random() - 0.5) * 120}px`);
      layer.appendChild(s);
      setTimeout(() => s.remove(), 3000);
    }
  }

  const buzz = (pattern) => { try { navigator.vibrate && navigator.vibrate(pattern); } catch { /* not supported */ } };

  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    const res = await fetch(path, { ...opts, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong');
    return data;
  }

  /* ================================================== setup flow */
  function initSetup() {
    const nameInput = $('#name-input');
    nameInput.value = safeGet('scribble.name') || '';
    const err = (m) => { $('#setup-error').textContent = m || ''; };
    const getName = () => {
      const n = nameInput.value.trim();
      if (!n) { err('First, what should your partner call you?'); nameInput.focus(); return null; }
      safeSet('scribble.name', n);
      return n;
    };

    $('#btn-start').addEventListener('click', async (e) => {
      const name = getName(); if (!name) return;
      const btn = e.currentTarget; // currentTarget is null after an await
      btn.disabled = true; err();
      try {
        const { token } = await api('/api/pair', { method: 'POST', body: JSON.stringify({ name }) });
        signIn(token);
      } catch (ex) { err(ex.message); } finally { btn.disabled = false; }
    });

    $('#btn-have-code').addEventListener('click', () => {
      if (!getName()) return;
      err(); $('#choice').hidden = true; $('#join-form').hidden = false; $('#code-input').focus();
    });
    $('#btn-back').addEventListener('click', () => { err(); $('#choice').hidden = false; $('#join-form').hidden = true; });

    $('#code-input').addEventListener('input', (e) => {
      e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    });

    $('#join-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = getName(); if (!name) return;
      const btn = e.submitter; if (btn) btn.disabled = true; err();
      try {
        const { token } = await api('/api/join', { method: 'POST', body: JSON.stringify({ name, code: $('#code-input').value }) });
        signIn(token);
      } catch (ex) { err(ex.message); } finally { if (btn) btn.disabled = false; }
    });

    $('#btn-share').addEventListener('click', async () => {
      const code = $('#invite-code').textContent;
      const text = `Let's doodle together 💞 Open Scribble Us at ${location.origin} and enter my code: ${code}`;
      if (navigator.share) { try { await navigator.share({ title: 'Scribble Us', text }); return; } catch { /* cancelled */ } }
      copy(code);
    });
    $('#btn-copy').addEventListener('click', () => copy($('#invite-code').textContent));
    $('#btn-cancel-pair').addEventListener('click', unpair);
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast('Copied!'); } catch { toast('Copy failed – long-press the code instead'); }
  }

  function signIn(token) {
    state.token = token;
    safeSet(TOKEN_KEY, token);
    connect();
  }

  function signOut(msg) {
    if (state.socket) { state.socket.removeAllListeners(); state.socket.disconnect(); state.socket = null; }
    state.token = null;
    safeSet(TOKEN_KEY, null);
    state.strokes = []; state.notes.clear(); state.remoteLive.clear(); state.myLive.clear();
    $('#notes-layer').replaceChildren();
    $('#choice').hidden = false; $('#join-form').hidden = true;
    show('screen-setup');
    if (msg) toast(msg);
  }

  async function unpair() {
    if (!confirm('Unpair this phone? You can always pair again with a new code.')) return;
    try { await api('/api/me', { method: 'DELETE' }); } catch { /* already gone */ }
    $('#menu-dialog').close();
    signOut('Unpaired');
  }

  /* ================================================== realtime connection */
  function connect() {
    if (state.socket) state.socket.disconnect();
    const socket = io({ auth: { token: state.token }, transports: ['websocket', 'polling'] });
    state.socket = socket;

    socket.on('connect', () => socket.emit('visibility', { visible: !document.hidden }));
    socket.on('connect_error', (err) => {
      if (err.message === 'unauthorized') signOut('Your pairing was removed – start again.');
      else toast('Can’t reach the server – retrying…');
    });

    socket.on('state', (s) => {
      state.me = s.me;
      state.partner = s.partner;
      state.strokes = s.strokes;
      state.remoteLive.clear();
      state.notes.clear();
      $('#notes-layer').replaceChildren();
      for (const n of s.notes) addNote(n, false);
      $('#me-name').textContent = s.me.name;
      updatePushUi();
      if (!s.partner) {
        $('#invite-code').textContent = s.invite || '------';
        show('screen-wait');
      } else {
        renderPartner();
        show('screen-main');
        redraw();
      }
    });

    socket.on('partner:joined', (p) => {
      toast(`${p.name} joined! Start doodling 🎉`, 3500);
      buzz([60, 40, 60]);
      socket.disconnect().connect(); // reload a fresh snapshot
    });
    socket.on('partner:left', () => {
      toast('Your partner unpaired 💔');
      socket.disconnect().connect();
    });

    socket.on('presence', (p) => {
      if (!state.partner) return;
      Object.assign(state.partner, p);
      renderPartner();
    });

    // --- partner drawing live
    socket.on('stroke:start', (s) => {
      state.remoteLive.set(s.key, s);
      drawStrokeRange(s, 0);
      partnerIsDrawing(s.points[s.points.length - 1]);
    });
    socket.on('stroke:points', ({ key, points }) => {
      const s = state.remoteLive.get(key);
      if (!s) return;
      const from = s.points.length - 1;
      s.points.push(...points);
      drawStrokeRange(s, from);
      partnerIsDrawing(points[points.length - 1]);
    });
    socket.on('stroke:end', ({ key, id }) => {
      const s = state.remoteLive.get(key);
      if (!s) return;
      state.remoteLive.delete(key);
      state.strokes.push({ id, by: s.by, color: s.color, width: s.width, erase: s.erase, points: s.points });
      updateEmptyHint();
    });
    socket.on('stroke:removed', ({ id }) => {
      state.strokes = state.strokes.filter((s) => s.id !== id);
      redraw();
    });
    socket.on('canvas:cleared', ({ by }) => {
      state.strokes = []; state.remoteLive.clear();
      redraw();
      if (state.partner && by === state.partner.id) toast(`${state.partner.name} cleared the canvas 🧽`);
    });

    // --- notes & nudges
    socket.on('note:new', ({ note }) => {
      addNote(note, true);
      if (state.partner && note.by === state.partner.id) {
        buzz([90, 50, 90]);
        toast(`${note.emoji} New note from ${state.partner.name}`);
      }
    });
    socket.on('note:deleted', ({ id }) => removeNote(id));
    socket.on('nudge', ({ kind }) => {
      burst(kind);
      buzz([120, 60, 120, 60, 200]);
      if (state.partner) toast(`${state.partner.name} ${NUDGE_TEXT[kind] || NUDGE_TEXT.heart}`);
    });
  }

  document.addEventListener('visibilitychange', () => {
    if (state.socket && state.socket.connected) state.socket.emit('visibility', { visible: !document.hidden });
  });

  function renderPartner() {
    const p = state.partner;
    if (!p) return;
    $('#partner-name').textContent = p.name;
    $('#partner-avatar').textContent = [...p.name][0].toUpperCase();
    $('#partner-pen').textContent = [...p.name][0].toUpperCase();
    const st = $('#partner-status');
    const drawing = !!state.partnerDrawingTimer;
    st.className = 'who-status' + (p.active ? ' active' : p.online ? ' online' : '') + (drawing ? ' drawing' : '');
    st.lastElementChild.textContent = drawing ? 'drawing…' : p.active ? 'here now' : p.online ? 'app in background' : 'away';
  }

  /* ================================================== canvas */
  const canvas = $('#ink');
  const ctx = canvas.getContext('2d');
  let W = 0; let H = 0; let dpr = 1;

  function layout() {
    const stage = $('#stage');
    const sw = stage.clientWidth; const sh = stage.clientHeight;
    if (!sw || !sh) return;
    let w = sw; let h = sw / ASPECT;
    if (h > sh) { h = sh; w = sh * ASPECT; }
    const board = $('#board');
    board.style.width = `${Math.floor(w)}px`;
    board.style.height = `${Math.floor(h)}px`;
    dpr = Math.min(window.devicePixelRatio || 1, 3);
    W = Math.floor(w); H = Math.floor(h);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    redraw();
  }
  window.addEventListener('resize', layout);

  function strokeStyle(s) {
    ctx.globalCompositeOperation = s.erase ? 'destination-out' : 'source-over';
    ctx.strokeStyle = s.erase ? '#000' : s.color;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = Math.max(1, s.width * W);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }

  /** Draw segments of a stroke starting at point index `from` (0 = whole stroke). */
  function drawStrokeRange(s, from) {
    const pts = s.points;
    if (!pts.length || !W) return;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    strokeStyle(s);
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0][0] * W, pts[0][1] * H, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      const start = Math.max(0, from);
      ctx.moveTo(pts[start][0] * W, pts[start][1] * H);
      for (let i = start + 1; i < pts.length; i++) {
        // Midpoint smoothing for nicer curves.
        const [x0, y0] = pts[i - 1]; const [x1, y1] = pts[i];
        ctx.quadraticCurveTo(x0 * W, y0 * H, ((x0 + x1) / 2) * W, ((y0 + y1) / 2) * H);
      }
      ctx.lineTo(pts[pts.length - 1][0] * W, pts[pts.length - 1][1] * H);
      ctx.stroke();
    }
    ctx.restore();
  }

  function redraw() {
    if (!W) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const s of state.strokes) drawStrokeRange(s, 0);
    for (const s of state.remoteLive.values()) drawStrokeRange(s, 0);
    for (const s of state.myLive.values()) drawStrokeRange(s, 0);
    positionNotes();
    updateEmptyHint();
  }

  function updateEmptyHint() {
    $('#empty-hint').hidden = state.strokes.length + state.remoteLive.size + state.myLive.size + state.notes.size > 0;
  }

  function partnerIsDrawing(pt) {
    const pen = $('#partner-pen');
    if (pt) {
      pen.hidden = false;
      pen.classList.remove('fade');
      pen.style.left = `${pt[0] * W}px`;
      pen.style.top = `${pt[1] * H}px`;
    }
    const wasDrawing = !!state.partnerDrawingTimer;
    clearTimeout(state.partnerDrawingTimer);
    state.partnerDrawingTimer = setTimeout(() => {
      state.partnerDrawingTimer = null;
      pen.classList.add('fade');
      renderPartner();
    }, 1200);
    if (!wasDrawing) renderPartner();
  }

  // ---- my drawing (pointer events cover touch, pen and mouse)
  let active = null; // { pointerId, sid, stroke, pending: [] }
  let flushTimer = null;

  function toUnit(e) {
    const r = canvas.getBoundingClientRect();
    return [
      Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))
    ];
  }

  function flush() {
    flushTimer = null;
    if (!active || !active.pending.length || !state.socket) return;
    state.socket.emit('stroke:points', { sid: active.sid, points: active.pending.splice(0, 200) });
    if (active.pending.length) flushTimer = setTimeout(flush, FLUSH_MS);
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary || active || !state.socket) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const p = toUnit(e);
    const stroke = {
      color: state.color,
      width: state.erasing ? ERASER_SIZE : SIZES[state.sizeIdx],
      erase: state.erasing,
      points: [p]
    };
    const sid = state.nextSid++;
    active = { pointerId: e.pointerId, sid, stroke, pending: [] };
    state.myLive.set(sid, stroke);
    drawStrokeRange(stroke, 0);
    updateEmptyHint();
    state.socket.emit('stroke:start', { sid, color: stroke.color, width: stroke.width, erase: stroke.erase, points: [p] });
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!active || e.pointerId !== active.pointerId) return;
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    const s = active.stroke;
    const from = s.points.length - 1;
    for (const ev of (events.length ? events : [e])) {
      const p = toUnit(ev);
      const last = s.points[s.points.length - 1];
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 0.002) continue; // skip jitter
      if (s.points.length >= 3900) break;
      s.points.push(p);
      active.pending.push(p);
    }
    if (s.points.length - 1 > from) drawStrokeRange(s, from);
    if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
  });

  function endStroke(e) {
    if (!active || e.pointerId !== active.pointerId) return;
    clearTimeout(flushTimer);
    flushTimer = null;
    const { sid, stroke } = active;
    while (active.pending.length) state.socket.emit('stroke:points', { sid, points: active.pending.splice(0, 200) });
    active = null;
    state.socket.emit('stroke:end', { sid }, ({ id } = {}) => {
      state.myLive.delete(sid);
      if (id) state.strokes.push({ id, by: state.me.id, ...stroke });
    });
  }
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);

  /* ================================================== toolbar */
  function initTools() {
    const pal = document.querySelector('.palette');
    for (const c of COLORS) {
      const b = document.createElement('button');
      b.className = 'swatch';
      b.style.background = c;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-label', `Colour ${c}`);
      b.setAttribute('aria-checked', String(c === state.color));
      b.addEventListener('click', () => {
        state.color = c;
        state.erasing = false;
        $('#tool-eraser').setAttribute('aria-pressed', 'false');
        for (const s of pal.children) s.setAttribute('aria-checked', String(s === b));
      });
      pal.appendChild(b);
    }

    $('#tool-size').addEventListener('click', () => {
      state.sizeIdx = (state.sizeIdx + 1) % SIZES.length;
      $('#tool-size .size-dot').dataset.size = state.sizeIdx;
    });
    $('#tool-eraser').addEventListener('click', (e) => {
      state.erasing = !state.erasing;
      e.currentTarget.setAttribute('aria-pressed', String(state.erasing));
    });
    $('#tool-undo').addEventListener('click', () => state.socket && state.socket.emit('stroke:undo'));
    $('#tool-clear').addEventListener('click', () => {
      if (confirm('Clear the canvas for both of you?')) state.socket.emit('canvas:clear');
    });
    $('#tool-heart').addEventListener('click', () => sendNudge('heart'));
    $('#tool-note').addEventListener('click', openNoteDialog);
    $('#btn-menu').addEventListener('click', () => { updatePushUi(); $('#menu-dialog').showModal(); });
    $('#btn-unpair').addEventListener('click', unpair);
    $('#btn-push').addEventListener('click', togglePush);
    $('#btn-push-test').addEventListener('click', async () => {
      try {
        const { sent } = await api('/api/push/test', { method: 'POST' });
        toast(sent ? 'Sent! Check your notifications 🔔' : 'Could not send – try turning alerts off and on');
      } catch (ex) { toast(ex.message); }
    });
  }

  function sendNudge(kind) {
    if (!state.socket) return;
    state.socket.emit('nudge', { kind });
    burst(kind);
    buzz(30);
    toast(`Sent ${NUDGE_EMOJI[kind][0]}`);
  }

  /* ================================================== notes */
  function addNote(note, animate) {
    if (state.notes.has(note.id)) return;
    const el = document.createElement('div');
    el.className = 'note' + (animate ? ' pop' : '');
    el.style.background = note.color;
    el.style.setProperty('--rot', `${note.rot}deg`);
    el.style.transform = `rotate(${note.rot}deg)`;

    const emoji = document.createElement('span');
    emoji.className = 'note-emoji';
    emoji.textContent = note.emoji;
    const text = document.createElement('div');
    text.className = 'note-text';
    text.textContent = note.text; // textContent: never innerHTML for user text
    const from = document.createElement('div');
    from.className = 'note-from';
    const mine = state.me && note.by === state.me.id;
    from.textContent = mine ? '— you' : `— ${state.partner ? state.partner.name : 'them'}`;
    const x = document.createElement('button');
    x.className = 'note-x';
    x.setAttribute('aria-label', 'Remove note');
    x.textContent = '✕';
    x.addEventListener('click', () => state.socket && state.socket.emit('note:delete', { id: note.id }));

    el.append(emoji, text, from, x);
    $('#notes-layer').appendChild(el);
    state.notes.set(note.id, { note, el });
    positionNote(state.notes.get(note.id));
    updateEmptyHint();
  }

  function positionNote({ note, el }) {
    el.style.left = `${note.x * 100}%`;
    el.style.top = `${note.y * 100}%`;
  }
  function positionNotes() { for (const n of state.notes.values()) positionNote(n); }

  function removeNote(id) {
    const n = state.notes.get(id);
    if (!n) return;
    n.el.remove();
    state.notes.delete(id);
    updateEmptyHint();
  }

  function openNoteDialog() {
    const dlg = $('#note-dialog');
    $('#note-text').value = '';
    dlg.showModal();
    setTimeout(() => $('#note-text').focus(), 50);
  }

  function initNoteDialog() {
    const cfg = state.config;
    const presets = $('#note-presets');
    for (const p of PRESETS) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'chip'; b.textContent = p;
      b.addEventListener('click', () => { $('#note-text').value = p; });
      presets.appendChild(b);
    }
    const emojiRow = $('#note-emoji');
    for (const em of cfg.emoji) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'chip'; b.textContent = em;
      b.setAttribute('aria-pressed', String(em === state.noteDraft.emoji));
      b.addEventListener('click', () => {
        state.noteDraft.emoji = em;
        $('#note-preview .note-emoji').textContent = em;
        for (const c of emojiRow.children) c.setAttribute('aria-pressed', String(c === b));
      });
      emojiRow.appendChild(b);
    }
    const colorRow = $('#note-colors');
    for (const col of cfg.noteColors) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'chip color-chip'; b.style.background = col;
      b.setAttribute('aria-label', `Paper colour ${col}`);
      b.setAttribute('aria-pressed', String(col === state.noteDraft.color));
      b.addEventListener('click', () => {
        state.noteDraft.color = col;
        $('#note-preview').style.background = col;
        for (const c of colorRow.children) c.setAttribute('aria-pressed', String(c === b));
      });
      colorRow.appendChild(b);
    }
    for (const b of document.querySelectorAll('[data-nudge]')) {
      b.addEventListener('click', () => { $('#note-dialog').close(); sendNudge(b.dataset.nudge); });
    }

    $('#note-form').addEventListener('submit', (e) => {
      if (e.submitter && e.submitter.value !== 'send') return; // ✕ button
      const text = $('#note-text').value.trim();
      if (!text) { e.preventDefault(); toast('Write something first ✍️'); return; }
      state.socket.emit('note:send', { text, emoji: state.noteDraft.emoji, color: state.noteDraft.color }, (res) => {
        if (res && res.error) toast(res.error);
        else toast('Stuck on their screen 📌');
      });
    });
  }

  /* ================================================== background push */
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  function updatePushUi() {
    const btn = $('#btn-push');
    const on = !!(state.me && state.me.push) && pushSupported && Notification.permission === 'granted';
    btn.textContent = on ? 'On ✓' : 'Turn on';
    btn.classList.toggle('on', on);
    $('#btn-push-test').hidden = !on;
    $('#ios-hint').hidden = !(isIOS && !isStandalone);
    if (!pushSupported) {
      btn.disabled = true;
      $('#push-status').textContent = isIOS && !isStandalone
        ? 'Add Scribble Us to your home screen first (see below).'
        : 'This browser does not support background notifications.';
    } else if (Notification.permission === 'denied') {
      btn.disabled = true;
      $('#push-status').textContent = 'Notifications are blocked – allow them in your browser/phone settings.';
    }
  }

  function urlB64ToUint8Array(b64) {
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }

  async function togglePush() {
    if (!pushSupported) return;
    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    if (state.me.push && existing) {
      await existing.unsubscribe();
      await api('/api/push', { method: 'POST', body: JSON.stringify({ subscription: null }) });
      state.me.push = false;
      updatePushUi();
      toast('Background alerts off');
      return;
    }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { updatePushUi(); toast('Notifications were not allowed'); return; }
    try {
      const sub = existing || await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(state.config.vapidPublicKey)
      });
      await api('/api/push', { method: 'POST', body: JSON.stringify({ subscription: sub.toJSON() }) });
      state.me.push = true;
      updatePushUi();
      toast('Background alerts on 🔔');
    } catch (ex) {
      toast(ex.message || 'Could not turn on alerts');
    }
  }

  /* ================================================== boot */
  async function boot() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
    try {
      state.config = await api('/api/config');
    } catch {
      state.config = { emoji: ['💌'], noteColors: ['#ffe36e'], vapidPublicKey: null };
    }
    initSetup();
    initTools();
    initNoteDialog();
    if (state.token) connect();
    else show('screen-setup');
  }

  boot();
})();
