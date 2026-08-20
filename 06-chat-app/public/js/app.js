/* Main client controller: auth, socket wiring, conversation state, UI. */
(function (global) {
  'use strict';

  var U = global.Util;
  var R = global.Render;
  var S = global.Sound;

  var $ = function (id) { return document.getElementById(id); };

  /* ------------------------------------------------------------- state */

  var state = {
    me: null,
    socket: null,
    connected: false,
    target: null,          // { type:'room'|'dm', id:'#general'|'dm:a|b', label, peer }
    rooms: [],             // rooms I am a member of
    allRooms: [],
    dms: [],               // [{ peer, key }]
    online: [],
    members: [],
    convs: Object.create(null),  // targetId -> conversation
    typing: Object.create(null), // targetId -> [nicks]
    outbox: [],
    replyTo: null,
    editing: null
  };

  function conv(id) {
    if (!state.convs[id]) {
      state.convs[id] = { id: id, messages: [], hasMore: false, unread: 0, loaded: false };
    }
    return state.convs[id];
  }

  var roomTarget = function (name) { return '#' + name; };

  /* ------------------------------------------------------------ toasts */

  function toast(text, kind) {
    var wrap = $('toasts');
    var node = R.el('div', 'toast' + (kind ? ' toast--' + kind : ''), text);
    wrap.appendChild(node);
    setTimeout(function () { node.classList.add('is-out'); }, 3200);
    setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 3800);
  }

  /* ------------------------------------------------------------- theme */

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('chat.theme', theme);
    $('toggle-theme').textContent = theme === 'dark' ? '◐' : '◑';
  }

  applyTheme(localStorage.getItem('chat.theme') ||
    (global.matchMedia && global.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));

  /* -------------------------------------------------------- sign in/out */

  function showSignin(message) {
    $('app').hidden = true;
    $('signin').hidden = false;
    var err = $('signin-error');
    if (message) { err.textContent = message; err.hidden = false; } else { err.hidden = true; }
    setTimeout(function () { $('signin-nick').focus(); }, 30);
  }

  function showApp() {
    $('signin').hidden = true;
    $('app').hidden = false;
  }

  function api(path, body) {
    return fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: body ? JSON.stringify(body) : undefined
    }).then(function (res) {
      return res.json().catch(function () { return { ok: false, error: 'Bad server response.' }; })
        .then(function (data) { data.status = res.status; return data; });
    });
  }

  $('signin-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var nickname = $('signin-nick').value.trim();
    var password = $('signin-pass').value;
    $('signin-submit').disabled = true;
    api('/api/login', { nickname: nickname, password: password }).then(function (res) {
      $('signin-submit').disabled = false;
      if (!res.ok) { showSignin(res.error || 'Could not sign in.'); return; }
      $('signin-pass').value = '';
      start(res.user);
    }).catch(function () {
      $('signin-submit').disabled = false;
      showSignin('Network error. Is the server running?');
    });
  });

  $('logout').addEventListener('click', function () {
    api('/api/logout', {}).then(function () {
      if (state.socket) state.socket.disconnect();
      location.reload();
    });
  });

  /* ------------------------------------------------------------ sidebar */

  function openSidebar(open) {
    document.body.classList.toggle('sidebar-open', open);
    $('scrim').hidden = !open;
  }
  $('open-sidebar').addEventListener('click', function () { openSidebar(true); });
  $('close-sidebar').addEventListener('click', function () { openSidebar(false); });
  $('scrim').addEventListener('click', function () { openSidebar(false); });

  $('toggle-theme').addEventListener('click', function () {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });

  function paintSoundButton() {
    var on = S.isEnabled();
    $('toggle-sound').textContent = on ? '🔊' : '🔈';
    $('toggle-sound').setAttribute('aria-pressed', on ? 'true' : 'false');
    $('toggle-sound').title = on ? 'Sound on — click to mute' : 'Sound muted — click to unmute';
  }
  paintSoundButton();
  $('toggle-sound').addEventListener('click', function () { S.setEnabled(!S.isEnabled()); paintSoundButton(); });

  function paintNotifyButton() {
    var p = S.notifyPermission();
    var btn = $('toggle-notify');
    btn.textContent = p === 'granted' ? '🔔' : '🔕';
    btn.title = p === 'granted' ? 'Desktop notifications enabled'
      : p === 'denied' ? 'Desktop notifications blocked by the browser'
      : 'Enable desktop notifications';
  }
  paintNotifyButton();
  $('toggle-notify').addEventListener('click', function () {
    S.requestNotify().then(function (p) {
      paintNotifyButton();
      if (p === 'granted') toast('Desktop notifications enabled.');
      else if (p === 'denied') toast('Your browser blocked notifications.', 'warn');
      else if (p === 'unsupported') toast('This browser has no Notification API.', 'warn');
    });
  });

  /* -------------------------------------------------------- room lists */

  function renderRooms() {
    var list = $('room-list');
    list.innerHTML = '';
    var joined = {};
    state.rooms.forEach(function (r) {
      joined[r.name] = true;
      var id = roomTarget(r.name);
      list.appendChild(R.roomItem(r, {
        active: state.target && state.target.id === id,
        unread: conv(id).unread
      }));
    });
    // Rooms that exist but I have not joined
    var others = state.allRooms.filter(function (r) { return !joined[r.name]; });
    if (others.length) {
      var head = R.el('li', 'list__sep', 'Other rooms');
      list.appendChild(head);
      others.forEach(function (r) {
        list.appendChild(R.roomItem(r, { active: false, unread: 0 }));
      });
    }
  }

  function renderDms() {
    var list = $('dm-list');
    list.innerHTML = '';
    state.dms.forEach(function (d) {
      var isOnline = state.online.some(function (u) {
        return u.nickname.toLowerCase() === d.peer.toLowerCase();
      });
      list.appendChild(R.dmItem(d.peer, {
        active: state.target && state.target.id === d.key,
        online: isOnline,
        unread: conv(d.key).unread
      }));
    });
    $('dm-empty').hidden = state.dms.length > 0;
  }

  function renderOnline() {
    var list = $('online-list');
    list.innerHTML = '';
    state.online.forEach(function (u) {
      list.appendChild(R.userItem(u, { isMe: state.me && u.nickname.toLowerCase() === state.me.nickname.toLowerCase() }));
    });
    $('online-count').textContent = String(state.online.length);
  }

  $('room-list').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-room]');
    if (!btn) return;
    selectRoom(btn.dataset.room);
    openSidebar(false);
  });

  $('dm-list').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-dm]');
    if (!btn) return;
    selectDm(btn.dataset.dm);
    openSidebar(false);
  });

  $('online-list').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-user]');
    if (!btn) return;
    var nick = btn.dataset.user;
    if (state.me && nick.toLowerCase() === state.me.nickname.toLowerCase()) {
      toast('That is you.');
      return;
    }
    selectDm(nick);
    openSidebar(false);
  });

  /* ------------------------------------------------------- modal (room) */

  function openModal() {
    $('modal').hidden = false;
    $('modal-error').hidden = true;
    $('modal-name').value = '';
    $('modal-topic').value = '';
    setTimeout(function () { $('modal-name').focus(); }, 30);
  }
  function closeModal() { $('modal').hidden = true; }

  $('new-room').addEventListener('click', openModal);
  $('modal-cancel').addEventListener('click', closeModal);
  $('modal').addEventListener('click', function (e) { if (e.target === $('modal')) closeModal(); });
  $('modal-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var name = $('modal-name').value;
    var topic = $('modal-topic').value;
    state.socket.emit('room:create', { name: name, topic: topic }, function (res) {
      if (!res || !res.ok) {
        var err = $('modal-error');
        err.textContent = (res && res.error) || 'Could not create the room.';
        err.hidden = false;
        return;
      }
      closeModal();
      selectRoom(res.room.name);
    });
  });

  /* ---------------------------------------------------------- messages */

  var listEl = function () { return $('message-list'); };
  var scrollEl = function () { return $('messages'); };

  function atBottom(slack) {
    var s = scrollEl();
    return s.scrollHeight - s.scrollTop - s.clientHeight < (slack || 80);
  }

  function scrollToBottom(smooth) {
    var s = scrollEl();
    if (typeof s.scrollTo === 'function') {
      s.scrollTo({ top: s.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    } else {
      s.scrollTop = s.scrollHeight;
    }
    $('jump-latest').hidden = true;
  }

  /** Rebuild the whole message list for the active conversation. */
  function renderMessages() {
    var c = conv(state.target.id);
    var list = listEl();
    list.innerHTML = '';
    var lastDay = null;
    c.messages.forEach(function (m) {
      var day = U.dayKey(m.createdAt);
      if (day !== lastDay) {
        list.appendChild(R.dayDivider(m.createdAt));
        lastDay = day;
      }
      list.appendChild(R.messageEl(m, state.me.nickname));
    });
    state.outbox.filter(function (p) { return p.target === state.target.id; }).forEach(function (p) {
      list.appendChild(pendingEl(p));
    });
    $('load-older-wrap').hidden = !c.hasMore;
  }

  function pendingEl(pending) {
    var node = R.el('div', 'msg msg--own msg--pending');
    node.dataset.clientId = pending.clientId;
    node.appendChild(R.avatar(state.me.nickname));
    var main = R.el('div', 'msg__main');
    var meta = R.el('div', 'msg__meta');
    meta.appendChild(R.el('b', 'msg__nick', state.me.nickname));
    meta.appendChild(R.el('span', 'msg__time', 'sending…'));
    main.appendChild(meta);
    var body = R.el('div', 'msg__body');
    var text = R.el('span', 'msg__text');
    text.innerHTML = U.richText(pending.body);
    body.appendChild(text);
    main.appendChild(body);
    node.appendChild(main);
    return node;
  }

  function removePending(clientId) {
    state.outbox = state.outbox.filter(function (p) { return p.clientId !== clientId; });
    var node = listEl().querySelector('[data-client-id="' + clientId + '"]');
    if (node && node.parentNode) node.parentNode.removeChild(node);
  }

  /** Append one message to the live view (with day divider if needed). */
  function appendMessage(msg) {
    var list = listEl();
    // walk back to the last node that carries a timestamp
    var lastTs = null;
    for (var n = list.lastElementChild; n; n = n.previousElementSibling) {
      if (n.dataset && n.dataset.ts) { lastTs = Number(n.dataset.ts); break; }
    }
    if (lastTs == null || U.dayKey(lastTs) !== U.dayKey(msg.createdAt)) {
      list.appendChild(R.dayDivider(msg.createdAt));
    }
    var node = R.messageEl(msg, state.me.nickname);
    // keep pending bubbles at the very bottom
    var firstPending = list.querySelector('.msg--pending');
    if (firstPending) list.insertBefore(node, firstPending);
    else list.appendChild(node);
    return node;
  }

  function upsertMessage(target, msg) {
    var c = conv(target);
    var idx = -1;
    for (var i = c.messages.length - 1; i >= 0; i--) {
      if (c.messages[i].id === msg.id) { idx = i; break; }
    }
    if (idx >= 0) {
      c.messages[idx] = msg;
      if (state.target && state.target.id === target) {
        var node = listEl().querySelector('.msg[data-id="' + msg.id + '"]');
        if (node) R.paint(node, msg, state.me.nickname);
        else renderMessages();
      }
      return false;
    }
    c.messages.push(msg);
    if (state.target && state.target.id === target) {
      var stick = atBottom(120);
      appendMessage(msg);
      if (stick) scrollToBottom();
      else if (msg.nickname.toLowerCase() !== state.me.nickname.toLowerCase()) $('jump-latest').hidden = false;
    }
    return true;
  }

  /* ------------------------------------------------------ unread/title */

  function totalUnread() {
    return Object.keys(state.convs).reduce(function (sum, k) { return sum + (state.convs[k].unread || 0); }, 0);
  }

  function refreshBadges() {
    S.setUnreadTitle(totalUnread());
    renderRooms();
    renderDms();
  }

  function markCurrentRead() {
    if (!state.target) return;
    var c = conv(state.target.id);
    c.unread = 0;
    if (state.target.type === 'room' && state.socket) {
      state.socket.emit('room:read', { room: state.target.label });
    }
    refreshBadges();
  }

  /* ------------------------------------------------- target selection */

  function setHeader() {
    var t = state.target;
    if (!t) return;
    if (t.type === 'room') {
      $('chat-title').textContent = '#' + t.label;
      var room = state.allRooms.filter(function (r) { return r.name === t.label; })[0];
      $('chat-topic').textContent = (room && room.topic) || '';
      $('leave-room').hidden = false;
      $('member-count').hidden = false;
      $('input').placeholder = 'Message #' + t.label + ' — try /me or /shrug';
    } else {
      $('chat-title').textContent = '@' + t.peer;
      var u = state.online.filter(function (x) { return x.nickname.toLowerCase() === t.peer.toLowerCase(); })[0];
      $('chat-topic').textContent = u ? 'online' : 'last seen ' + U.relative(t.lastSeen);
      $('leave-room').hidden = true;
      $('member-count').hidden = true;
      $('input').placeholder = 'Message @' + t.peer;
    }
    renderTyping();
  }

  function selectRoom(name) {
    var id = roomTarget(name);
    var c = conv(id);
    state.target = { type: 'room', id: id, label: name };
    cancelReply();
    setHeader();
    renderMessages();
    refreshBadges();

    state.socket.emit('room:join', { room: name }, function (res) {
      if (!res || !res.ok) { toast((res && res.error) || 'Could not join the room.', 'error'); return; }
      c.messages = res.messages;
      c.hasMore = res.hasMore;
      c.loaded = true;
      state.members = res.members || [];
      $('member-count').textContent = String(state.members.length);
      if (state.target.id === id) {
        setHeader();
        renderMessages();
        scrollToBottom();
        markCurrentRead();
      }
      if (!state.rooms.some(function (r) { return r.name === name; })) refreshRooms();
    });
  }

  function selectDm(peer) {
    cancelReply();
    state.socket.emit('dm:open', { to: peer }, function (res) {
      if (!res || !res.ok) { toast((res && res.error) || 'Could not open the DM.', 'error'); return; }
      var key = res.dm.key;
      var c = conv(key);
      c.messages = res.messages;
      c.hasMore = res.hasMore;
      c.loaded = true;
      if (!state.dms.some(function (d) { return d.key === key; })) {
        state.dms.push({ peer: res.dm.peer, key: key });
      }
      state.target = { type: 'dm', id: key, label: res.dm.peer, peer: res.dm.peer, lastSeen: res.dm.lastSeen };
      setHeader();
      renderMessages();
      scrollToBottom();
      markCurrentRead();
      refreshBadges();
    });
  }

  function refreshRooms() {
    state.socket.emit('room:list', {}, function (res) {
      if (!res || !res.ok) return;
      state.rooms = res.rooms;
      state.allRooms = res.allRooms;
      res.rooms.forEach(function (r) {
        var c = conv(roomTarget(r.name));
        if (!c.loaded) c.unread = r.unread || 0;
      });
      refreshBadges();
    });
  }

  $('leave-room').addEventListener('click', function () {
    if (!state.target || state.target.type !== 'room') return;
    var name = state.target.label;
    state.socket.emit('room:leave', { room: name }, function (res) {
      if (!res || !res.ok) { toast((res && res.error) || 'Could not leave.', 'error'); return; }
      delete state.convs[roomTarget(name)];
      state.rooms = state.rooms.filter(function (r) { return r.name !== name; });
      toast('Left #' + name);
      var next = state.rooms[0];
      if (next) selectRoom(next.name);
      else { state.target = null; listEl().innerHTML = ''; $('chat-title').textContent = 'No room'; }
      refreshRooms();
    });
  });

  /* ---------------------------------------------------------- scrollback */

  function loadOlder() {
    if (!state.target) return;
    var c = conv(state.target.id);
    if (!c.hasMore || c.loading) return;
    var oldest = c.messages.length ? c.messages[0].id : null;
    if (!oldest) return;
    c.loading = true;
    $('load-older').disabled = true;

    var done = function (res) {
      c.loading = false;
      $('load-older').disabled = false;
      if (!res || !res.ok) return;
      var s = scrollEl();
      var prevHeight = s.scrollHeight;
      c.messages = res.messages.concat(c.messages);
      c.hasMore = res.hasMore;
      if (state.target && state.target.id === c.id) {
        renderMessages();
        s.scrollTop = s.scrollHeight - prevHeight + s.scrollTop;
      }
    };

    if (state.target.type === 'room') {
      state.socket.emit('room:history', { room: state.target.label, before: oldest }, done);
    } else {
      state.socket.emit('dm:history', { to: state.target.peer, before: oldest }, done);
    }
  }

  $('load-older').addEventListener('click', loadOlder);
  $('jump-latest').addEventListener('click', function () { scrollToBottom(true); });

  scrollEl().addEventListener('scroll', U.throttle(function () {
    if (scrollEl().scrollTop < 60) loadOlder();
    if (atBottom(40)) { $('jump-latest').hidden = true; markCurrentRead(); }
  }, 200));

  /* ------------------------------------------------------ message acts */

  listEl().addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action]');
    if (!btn) return;
    var msgNode = btn.closest('.msg');
    if (!msgNode) return;
    var id = Number(msgNode.dataset.id);
    var action = btn.dataset.action;

    if (action === 'react') {
      state.socket.emit('message:react', { id: id, emoji: btn.dataset.emoji }, function (res) {
        if (res && !res.ok) toast(res.error, 'error');
      });
    } else if (action === 'reply') {
      startReply(id);
    } else if (action === 'edit') {
      startEdit(msgNode, id);
    } else if (action === 'delete') {
      if (!confirm('Delete this message?')) return;
      state.socket.emit('message:delete', { id: id }, function (res) {
        if (res && !res.ok) toast(res.error, 'error');
      });
    } else if (action === 'goto') {
      var target = listEl().querySelector('.msg[data-id="' + btn.dataset.target + '"]');
      if (target) {
        if (typeof target.scrollIntoView === 'function') {
          target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
        target.classList.add('is-flash');
        setTimeout(function () { target.classList.remove('is-flash'); }, 1200);
      } else {
        toast('Scroll back to load that message.');
      }
    }
  });

  function findMessage(id) {
    var c = conv(state.target.id);
    for (var i = 0; i < c.messages.length; i++) if (c.messages[i].id === id) return c.messages[i];
    return null;
  }

  function startReply(id) {
    var msg = findMessage(id);
    if (!msg) return;
    state.replyTo = id;
    $('reply-nick').textContent = msg.nickname;
    $('reply-text').textContent = msg.body.slice(0, 120);
    $('reply-bar').hidden = false;
    $('input').focus();
  }

  function cancelReply() {
    state.replyTo = null;
    $('reply-bar').hidden = true;
  }
  $('reply-cancel').addEventListener('click', cancelReply);

  function startEdit(node, id) {
    if (state.editing) cancelEdit();
    var msg = findMessage(id);
    if (!msg) return;
    var body = node.querySelector('.msg__body');
    if (!body) return;
    var original = body.innerHTML;
    var ta = R.el('textarea', 'msg__edit');
    ta.value = msg.body;
    ta.maxLength = 2000;
    var hint = R.el('div', 'msg__edit-hint', 'Enter to save · Esc to cancel');
    body.innerHTML = '';
    body.appendChild(ta);
    body.appendChild(hint);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    state.editing = { id: id, node: node, body: body, original: original };

    ta.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        var value = ta.value.trim();
        if (!value) { cancelEdit(); return; }
        state.socket.emit('message:edit', { id: id, body: value }, function (res) {
          if (res && !res.ok) { toast(res.error, 'error'); cancelEdit(); }
          else state.editing = null;
        });
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        cancelEdit();
      }
    });
  }

  function cancelEdit() {
    if (!state.editing) return;
    var msg = findMessage(state.editing.id);
    if (msg) R.paint(state.editing.node, msg, state.me.nickname);
    else state.editing.body.innerHTML = state.editing.original;
    state.editing = null;
  }

  /* --------------------------------------------------------- composer */

  var input = $('input');

  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
  }

  var stopTyping = U.debounce(function () {
    if (!state.target || !state.socket) return;
    state.socket.emit('typing:stop', targetPayload());
  }, 1500);

  var startTyping = U.throttle(function () {
    if (!state.target || !state.socket) return;
    state.socket.emit('typing:start', targetPayload());
  }, 2000);

  function targetPayload() {
    if (!state.target) return {};
    return state.target.type === 'room' ? { room: state.target.label } : { to: state.target.peer };
  }

  input.addEventListener('input', function () {
    autosize();
    if (input.value.trim()) { startTyping(); stopTyping(); }
  });

  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('composer').requestSubmit ? $('composer').requestSubmit() : send();
    } else if (e.key === 'Escape') {
      cancelReply();
      closeEmoji();
    } else if (e.key === 'ArrowUp' && !input.value) {
      // quick-edit the last own message
      var c = conv(state.target.id);
      for (var i = c.messages.length - 1; i >= 0; i--) {
        var m = c.messages[i];
        if (!m.deleted && m.kind !== 'system' && m.nickname.toLowerCase() === state.me.nickname.toLowerCase()) {
          var node = listEl().querySelector('.msg[data-id="' + m.id + '"]');
          if (node) { e.preventDefault(); startEdit(node, m.id); }
          break;
        }
      }
    }
  });

  $('composer').addEventListener('submit', function (e) { e.preventDefault(); send(); });

  function send() {
    if (!state.target) { toast('Pick a room first.'); return; }
    var body = input.value.trim();
    if (!body) return;
    if (body.length > 2000) { toast('Message is too long (2000 characters max).', 'error'); return; }

    var pending = {
      clientId: U.uid(),
      target: state.target.id,
      body: body,
      replyTo: state.replyTo,
      payload: state.target.type === 'room'
        ? { room: state.target.label, body: body, replyTo: state.replyTo }
        : { to: state.target.peer, body: body, replyTo: state.replyTo }
    };
    pending.payload.clientId = pending.clientId;

    input.value = '';
    autosize();
    cancelReply();
    stopTyping.cancel();
    if (state.socket) state.socket.emit('typing:stop', targetPayload());

    state.outbox.push(pending);
    if (state.target.id === pending.target) {
      listEl().appendChild(pendingEl(pending));
      scrollToBottom();
    }
    flushOutbox();
  }

  function flushOutbox() {
    if (!state.connected || !state.socket) return;
    state.outbox.slice().forEach(function (pending) {
      if (pending.inFlight) return;
      pending.inFlight = true;
      state.socket.emit('message:send', pending.payload, function (res) {
        pending.inFlight = false;
        if (!res) return;                       // no ack (dropped) — retry on reconnect
        if (res.ok) { removePending(pending.clientId); return; }
        removePending(pending.clientId);
        toast(res.error || 'Message rejected.', 'error');
        if (res.code === 'RATE_LIMIT') S.beep('error');
      });
    });
  }

  /* ------------------------------------------------------ emoji picker */

  function buildEmoji() {
    var picker = $('emoji-picker');
    picker.innerHTML = '';
    U.EMOJI.forEach(function (e) {
      var b = R.el('button', 'emoji', e);
      b.type = 'button';
      b.dataset.emoji = e;
      picker.appendChild(b);
    });
    picker.addEventListener('click', function (ev) {
      var b = ev.target.closest('button[data-emoji]');
      if (!b) return;
      insertAtCursor(b.dataset.emoji);
      closeEmoji();
    });
  }

  function insertAtCursor(text) {
    var start = input.selectionStart || 0;
    var end = input.selectionEnd || 0;
    input.value = input.value.slice(0, start) + text + input.value.slice(end);
    input.selectionStart = input.selectionEnd = start + text.length;
    input.focus();
    autosize();
  }

  function closeEmoji() {
    $('emoji-picker').hidden = true;
    $('emoji-btn').setAttribute('aria-expanded', 'false');
  }

  $('emoji-btn').addEventListener('click', function (e) {
    e.stopPropagation();
    var picker = $('emoji-picker');
    picker.hidden = !picker.hidden;
    $('emoji-btn').setAttribute('aria-expanded', picker.hidden ? 'false' : 'true');
  });

  document.addEventListener('click', function (e) {
    if ($('emoji-picker').hidden) return;
    if (e.target.closest('#emoji-picker') || e.target.closest('#emoji-btn')) return;
    closeEmoji();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeEmoji(); if (!$('modal').hidden) closeModal(); }
  });

  /* ---------------------------------------------------------- typing UI */

  function renderTyping() {
    if (!state.target) { $('typing').textContent = ''; return; }
    var names = (state.typing[state.target.id] || []).filter(function (n) {
      return n.toLowerCase() !== state.me.nickname.toLowerCase();
    });
    $('typing').textContent = U.typingText(names);
  }

  /* ------------------------------------------------------------- socket */

  function setBanner(text, kind) {
    var b = $('banner');
    if (!text) { b.hidden = true; return; }
    $('banner-text').textContent = text;
    b.className = 'banner' + (kind ? ' banner--' + kind : '');
    b.hidden = false;
  }

  function channelToTarget(channel) {
    // server targets are '#room' or 'dm:a|b' already
    return channel;
  }

  function start(user) {
    state.me = user;
    showApp();
    $('me-nick').textContent = user.nickname + (user.isGuest ? ' (guest)' : '');
    var av = $('me-avatar');
    av.textContent = U.initials(user.nickname);
    av.style.setProperty('--hue', U.hueOf(user.nickname));
    buildEmoji();

    if (state.socket) { state.socket.removeAllListeners(); state.socket.disconnect(); }

    var socket = io({ withCredentials: true, reconnectionDelay: 500, reconnectionDelayMax: 4000 });
    state.socket = socket;

    socket.on('connect', function () {
      state.connected = true;
      setBanner(null);
    });

    socket.on('connect_error', function (err) {
      state.connected = false;
      if (err && err.message === 'NOT_AUTHENTICATED') {
        socket.disconnect();
        showSignin('Your session expired. Sign in again.');
        return;
      }
      setBanner('Reconnecting…', 'warn');
    });

    socket.on('disconnect', function (reason) {
      state.connected = false;
      state.outbox.forEach(function (p) { p.inFlight = false; });
      setBanner(reason === 'io server disconnect' ? 'Disconnected.' : 'Reconnecting…', 'warn');
    });

    socket.io.on('reconnect_attempt', function (n) {
      setBanner('Reconnecting… (attempt ' + n + ')', 'warn');
    });

    socket.on('session:ready', function (data) {
      state.me = data.user;
      state.rooms = data.rooms;
      state.allRooms = data.allRooms;
      state.online = data.online;
      renderOnline();

      data.rooms.forEach(function (r) {
        var c = conv(roomTarget(r.name));
        if (!c.loaded) c.unread = r.unread || 0;
      });
      refreshBadges();

      if (state.target) {
        // Reconnect: rejoin whatever we were looking at, then resend queued msgs.
        if (state.target.type === 'room') selectRoom(state.target.label);
        else selectDm(state.target.peer);
      } else {
        var first = state.rooms[0] || state.allRooms[0];
        if (first) selectRoom(first.name);
      }
      setTimeout(flushOutbox, 120);
    });

    var refreshRoomsSoon = U.debounce(refreshRooms, 150);
    socket.on('rooms:updated', function (data) {
      state.allRooms = data.rooms;
      renderRooms();
      refreshRoomsSoon();   // membership + unread counts are per-user
    });

    socket.on('room:created', function (data) {
      if (!state.allRooms.some(function (r) { return r.name === data.room.name; })) {
        state.allRooms.push(data.room);
      }
      renderRooms();
      if (data.by && state.me && data.by.toLowerCase() !== state.me.nickname.toLowerCase()) {
        toast(data.by + ' created #' + data.room.name);
      }
    });

    socket.on('room:members', function (data) {
      if (state.target && state.target.type === 'room' && state.target.label === data.room) {
        state.members = data.members;
        $('member-count').textContent = String(data.members.length);
        $('member-count').title = data.members.map(function (m) { return m.nickname; }).join(', ');
      }
    });

    socket.on('presence:online', function (data) {
      state.online = data.users;
      renderOnline();
      renderDms();
      if (state.target && state.target.type === 'dm') setHeader();
    });

    socket.on('typing:update', function (data) {
      var target = data.target.indexOf('room:') === 0 ? '#' + data.target.slice(5) : data.target;
      state.typing[target] = data.users;
      renderTyping();
    });

    socket.on('message:new', function (data) {
      var target = channelToTarget(data.target);
      var msg = data.message;

      if (data.dm && !state.dms.some(function (d) { return d.key === data.dm.key; })) {
        var other = data.dm.peer && data.dm.peer.toLowerCase() !== state.me.nickname.toLowerCase()
          ? data.dm.peer : data.dm.from;
        state.dms.push({ peer: other, key: data.dm.key });
        renderDms();
      }

      var isNew = upsertMessage(target, msg);
      if (!isNew) return;

      var mine = msg.nickname.toLowerCase() === state.me.nickname.toLowerCase();
      var active = state.target && state.target.id === target && !document.hidden;

      if (!mine && msg.kind !== 'system') {
        if (!active) {
          conv(target).unread += 1;
          refreshBadges();
        }
        if (!active || document.hidden) {
          var isDm = target.indexOf('dm:') === 0;
          S.beep(isDm ? 'dm' : 'message');
          var label = isDm ? msg.nickname + ' (DM)' : msg.nickname + ' in ' + target;
          S.notify(label, msg.body, function () {
            if (isDm) selectDm(msg.nickname); else selectRoom(target.slice(1));
          });
        }
      }
      if (active && atBottom(120)) markCurrentRead();
    });

    socket.on('message:updated', function (data) {
      var target = channelToTarget(data.target);
      var c = conv(target);
      for (var i = 0; i < c.messages.length; i++) {
        if (c.messages[i].id === data.message.id) {
          c.messages[i] = data.message;
          if (state.target && state.target.id === target) {
            var node = listEl().querySelector('.msg[data-id="' + data.message.id + '"]');
            if (node) R.paint(node, data.message, state.me.nickname);
          }
          return;
        }
      }
    });
  }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) markCurrentRead();
  });

  /* ------------------------------------------------------------- boot */

  api('/api/me').then(function (res) {
    if (res.ok) start(res.user);
    else showSignin();
  }).catch(function () { showSignin(); });

  global.__chat = state; // handy for debugging in the console
})(window);
