/* Builds message / list DOM. Nothing here ever assigns raw user input to
   innerHTML — text goes through textContent, bodies through Util.richText
   (escape → linkify → <br>). */
(function (global) {
  'use strict';

  var U = global.Util;
  var REACTIONS = ['👍', '❤️', '😂']; // 👍 ❤️ 😂

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function avatar(nick) {
    var a = el('span', 'avatar', U.initials(nick));
    a.style.setProperty('--hue', U.hueOf(nick));
    a.setAttribute('aria-hidden', 'true');
    return a;
  }

  function dayDivider(ts) {
    var wrap = el('div', 'day');
    wrap.dataset.day = U.dayKey(ts);
    wrap.appendChild(el('span', 'day__label', U.dayLabel(ts)));
    return wrap;
  }

  function systemEl(msg) {
    var node = el('div', 'system');
    node.dataset.id = msg.id;
    node.dataset.kind = 'system';
    node.dataset.ts = msg.createdAt;
    node.appendChild(el('span', 'system__text', msg.body));
    node.appendChild(el('time', 'system__time', U.timeOf(msg.createdAt)));
    return node;
  }

  function actionButton(label, title, action, emoji) {
    var b = el('button', 'msg__act', label);
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.dataset.action = action;
    if (emoji) b.dataset.emoji = emoji;
    return b;
  }

  function buildReactions(msg, me) {
    var wrap = el('div', 'reactions');
    var keys = Object.keys(msg.reactions || {});
    if (!keys.length) { wrap.hidden = true; return wrap; }
    keys.forEach(function (emoji) {
      var users = msg.reactions[emoji] || [];
      if (!users.length) return;
      var mine = users.some(function (n) { return n.toLowerCase() === String(me).toLowerCase(); });
      var chip = el('button', 'reaction' + (mine ? ' reaction--mine' : ''));
      chip.type = 'button';
      chip.dataset.action = 'react';
      chip.dataset.emoji = emoji;
      chip.title = users.join(', ');
      chip.appendChild(el('span', 'reaction__emoji', emoji));
      chip.appendChild(el('span', 'reaction__count', String(users.length)));
      wrap.appendChild(chip);
    });
    wrap.hidden = !wrap.childNodes.length;
    return wrap;
  }

  function buildReplyQuote(msg) {
    if (!msg.replyTo) return null;
    var q = el('button', 'quote');
    q.type = 'button';
    q.dataset.action = 'goto';
    q.dataset.target = msg.replyTo.id;
    q.appendChild(el('span', 'quote__nick', msg.replyTo.nickname));
    q.appendChild(el('span', 'quote__body', msg.replyTo.deleted ? 'message deleted' : msg.replyTo.body));
    return q;
  }

  /** Fill an existing .msg element from a message object (used for updates too). */
  function paint(node, msg, me) {
    var own = msg.nickname && me && msg.nickname.toLowerCase() === String(me).toLowerCase();
    node.className = 'msg' + (own ? ' msg--own' : '') +
      (msg.kind === 'me' ? ' msg--action' : '') +
      (msg.deleted ? ' msg--deleted' : '');
    node.dataset.id = msg.id;
    node.dataset.nick = msg.nickname;
    node.dataset.ts = msg.createdAt;
    node.dataset.kind = msg.kind;
    node.innerHTML = '';

    node.appendChild(avatar(msg.nickname));

    var main = el('div', 'msg__main');

    var meta = el('div', 'msg__meta');
    meta.appendChild(el('b', 'msg__nick', msg.nickname));
    var t = el('time', 'msg__time', U.timeOf(msg.createdAt));
    t.dateTime = new Date(msg.createdAt).toISOString();
    t.title = new Date(msg.createdAt).toLocaleString();
    meta.appendChild(t);
    if (msg.editedAt && !msg.deleted) meta.appendChild(el('span', 'msg__edited', '(edited)'));
    main.appendChild(meta);

    var quote = buildReplyQuote(msg);
    if (quote) main.appendChild(quote);

    var body = el('div', 'msg__body');
    if (msg.deleted) {
      body.appendChild(el('em', 'msg__gone', 'This message was deleted.'));
    } else if (msg.kind === 'me') {
      body.appendChild(el('b', 'msg__actor', msg.nickname + ' '));
      var span = el('span', 'msg__text');
      span.innerHTML = U.richText(msg.body); // body is escaped inside richText
      body.appendChild(span);
    } else {
      var text = el('span', 'msg__text');
      text.innerHTML = U.richText(msg.body);
      body.appendChild(text);
    }
    main.appendChild(body);

    main.appendChild(buildReactions(msg, me));
    node.appendChild(main);

    if (!msg.deleted) {
      var acts = el('div', 'msg__actions');
      REACTIONS.forEach(function (e) {
        acts.appendChild(actionButton(e, 'React ' + e, 'react', e));
      });
      acts.appendChild(actionButton('↩', 'Reply', 'reply'));
      if (own) {
        acts.appendChild(actionButton('✎', 'Edit', 'edit'));
        acts.appendChild(actionButton('🗑', 'Delete', 'delete'));
      }
      node.appendChild(acts);
    }
    return node;
  }

  function messageEl(msg, me) {
    if (msg.kind === 'system') return systemEl(msg);
    return paint(el('div', 'msg'), msg, me);
  }

  /* ------------------------------------------------------ sidebar lists */

  function roomItem(room, opts) {
    var li = el('li', 'list__item' + (opts.active ? ' is-active' : ''));
    var btn = el('button', 'list__btn');
    btn.type = 'button';
    btn.dataset.room = room.name;
    btn.title = room.topic || ('#' + room.name);

    btn.appendChild(el('span', 'list__hash', '#'));
    btn.appendChild(el('span', 'list__name', room.name));

    var right = el('span', 'list__right');
    if (typeof room.members === 'number') {
      right.appendChild(el('span', 'list__members', String(room.members)));
    }
    if (opts.unread > 0) {
      right.appendChild(el('span', 'badge', opts.unread > 99 ? '99+' : String(opts.unread)));
    }
    btn.appendChild(right);
    li.appendChild(btn);
    return li;
  }

  function dmItem(peer, opts) {
    var li = el('li', 'list__item' + (opts.active ? ' is-active' : ''));
    var btn = el('button', 'list__btn');
    btn.type = 'button';
    btn.dataset.dm = peer;
    btn.appendChild(avatar(peer));
    btn.appendChild(el('span', 'list__name', peer));
    var right = el('span', 'list__right');
    if (opts.online) right.appendChild(el('span', 'dot dot--on'));
    if (opts.unread > 0) right.appendChild(el('span', 'badge', opts.unread > 99 ? '99+' : String(opts.unread)));
    btn.appendChild(right);
    li.appendChild(btn);
    return li;
  }

  function userItem(user, opts) {
    var li = el('li', 'list__item');
    var btn = el('button', 'list__btn');
    btn.type = 'button';
    btn.dataset.user = user.nickname;
    btn.appendChild(avatar(user.nickname));
    btn.appendChild(el('span', 'list__name', user.nickname + (opts.isMe ? ' (you)' : '')));
    var right = el('span', 'list__right');
    right.appendChild(el('span', 'dot' + (user.online ? ' dot--on' : '')));
    btn.appendChild(right);
    btn.title = user.online
      ? user.nickname + ' — online'
      : user.nickname + ' — last seen ' + U.relative(user.lastSeen);
    li.appendChild(btn);
    return li;
  }

  function memberItem(user) {
    return userItem(user, { isMe: false });
  }

  global.Render = {
    el: el,
    avatar: avatar,
    dayDivider: dayDivider,
    messageEl: messageEl,
    paint: paint,
    roomItem: roomItem,
    dmItem: dmItem,
    userItem: userItem,
    memberItem: memberItem,
    REACTIONS: REACTIONS
  };
})(window);
