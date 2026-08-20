/* Small dependency-free helpers shared by the front end. */
(function (global) {
  'use strict';

  var HTML_ESCAPES = {
    '&': '&amp;', '<': '&lt;', '>': '&gt;',
    '"': '&quot;', "'": '&#39;', '`': '&#96;'
  };

  /** Escape untrusted text for HTML. Everything user-supplied goes through this. */
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"'`]/g, function (ch) {
      return HTML_ESCAPES[ch];
    });
  }

  // Matches http(s) URLs and bare www.* — run AFTER escaping, so the input
  // can no longer contain raw markup.
  var URL_RE = /\b((?:https?:\/\/|www\.)[^\s<>"'`]+)/gi;
  var TRAILING = /[.,;:!?)\]}]+$/;

  /**
   * Turn URLs inside an ALREADY-ESCAPED string into anchors.
   * Only http/https are linked; the visible text is truncated for very long URLs.
   */
  function linkify(escaped) {
    return String(escaped).replace(URL_RE, function (match) {
      var trail = '';
      var url = match.replace(TRAILING, function (t) { trail = t; return ''; });
      var href = /^www\./i.test(url) ? 'https://' + url : url;
      if (!/^https?:\/\//i.test(href)) return match;
      var label = url.length > 64 ? url.slice(0, 61) + '…' : url;
      return '<a href="' + href + '" target="_blank" rel="noopener noreferrer nofollow">' + label + '</a>' + trail;
    });
  }

  /** Escape + linkify + keep newlines. Safe to assign to innerHTML. */
  function richText(raw) {
    return linkify(escapeHtml(raw)).replace(/\n/g, '<br />');
  }

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  function timeOf(ts) {
    var d = new Date(ts);
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function dayKey(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  /** "Today" / "Yesterday" / "12 March 2026" */
  function dayLabel(ts) {
    var d = new Date(ts);
    var today = new Date();
    var yest = new Date(today.getTime() - 86400000);
    if (dayKey(d) === dayKey(today)) return 'Today';
    if (dayKey(d) === dayKey(yest)) return 'Yesterday';
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  }

  /** "just now" / "5m ago" / "3h ago" / a date */
  function relative(ts) {
    if (!ts) return 'unknown';
    var diff = Date.now() - ts;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    if (diff < 604800000) return Math.floor(diff / 86400000) + 'd ago';
    return new Date(ts).toLocaleDateString();
  }

  function debounce(fn, wait) {
    var t = null;
    function wrapped() {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { t = null; fn.apply(self, args); }, wait);
    }
    wrapped.cancel = function () { clearTimeout(t); t = null; };
    wrapped.pending = function () { return t !== null; };
    return wrapped;
  }

  function throttle(fn, wait) {
    var last = 0;
    return function () {
      var now = Date.now();
      if (now - last < wait) return;
      last = now;
      fn.apply(this, arguments);
    };
  }

  /** Deterministic pastel-ish hue from a nickname, for avatars. */
  function hueOf(name) {
    var h = 0, s = String(name);
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    return h;
  }

  function initials(name) {
    var s = String(name || '?').trim();
    return (s[0] || '?').toUpperCase();
  }

  /** "Ann is typing…" / "Ann and Bo are typing…" / "3 people are typing…" */
  function typingText(names) {
    if (!names.length) return '';
    if (names.length === 1) return names[0] + ' is typing…';
    if (names.length === 2) return names[0] + ' and ' + names[1] + ' are typing…';
    if (names.length === 3) return names[0] + ', ' + names[1] + ' and ' + names[2] + ' are typing…';
    return names.length + ' people are typing…';
  }

  function uid() {
    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  var EMOJI = [
    '😀', '😄', '😁', '😅', '😂', '🙂', '😉', '😊', '😍', '😘',
    '🤔', '🤨', '😐', '😴', '😭', '😤', '😱', '🥳', '😎', '🤓',
    '👍', '👎', '👏', '🙌', '🙏', '👀', '💪', '🤝', '✌️', '🤞',
    '❤️', '🔥', '✨', '🎉', '🚀', '💡', '✅', '❌', '⚠️', '📌',
    '☕', '🍕', '🐛', '🧠', '🎧', '🌙', '☀️', '🌈', '💬', '🫠'
  ];

  global.Util = {
    escapeHtml: escapeHtml,
    linkify: linkify,
    richText: richText,
    timeOf: timeOf,
    dayKey: dayKey,
    dayLabel: dayLabel,
    relative: relative,
    debounce: debounce,
    throttle: throttle,
    hueOf: hueOf,
    initials: initials,
    typingText: typingText,
    uid: uid,
    EMOJI: EMOJI
  };
})(window);
