/* Notification helpers: a WebAudio beep (no audio files) + Notification API. */
(function (global) {
  'use strict';

  var ctx = null;
  var enabled = localStorage.getItem('chat.sound') !== 'off';

  function audioContext() {
    if (ctx) return ctx;
    var AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    return ctx;
  }

  /**
   * Short two-tone blip, synthesised on the fly.
   * `kind`: 'message' (default) | 'dm' | 'error'
   */
  function beep(kind) {
    if (!enabled) return;
    var ac = audioContext();
    if (!ac) return;
    if (ac.state === 'suspended') ac.resume();

    var freqs = kind === 'dm' ? [880, 1320] : kind === 'error' ? [320, 220] : [660, 990];
    var t0 = ac.currentTime;

    freqs.forEach(function (f, i) {
      var osc = ac.createOscillator();
      var gain = ac.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f, t0 + i * 0.09);
      gain.gain.setValueAtTime(0.0001, t0 + i * 0.09);
      gain.gain.exponentialRampToValueAtTime(0.14, t0 + i * 0.09 + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.09 + 0.085);
      osc.connect(gain).connect(ac.destination);
      osc.start(t0 + i * 0.09);
      osc.stop(t0 + i * 0.09 + 0.1);
    });
  }

  function isEnabled() { return enabled; }

  function setEnabled(value) {
    enabled = !!value;
    localStorage.setItem('chat.sound', enabled ? 'on' : 'off');
    if (enabled) beep('message');
    return enabled;
  }

  /* ------------------------------------------------------- Notifications */

  function notifyPermission() {
    return global.Notification ? Notification.permission : 'unsupported';
  }

  function requestNotify() {
    if (!global.Notification) return Promise.resolve('unsupported');
    if (Notification.permission !== 'default') return Promise.resolve(Notification.permission);
    try {
      return Notification.requestPermission().then(function (p) { return p; });
    } catch (e) {
      return new Promise(function (resolve) { Notification.requestPermission(resolve); });
    }
  }

  /** Desktop notification — body is plain text, never HTML. */
  function notify(title, body, onClick) {
    if (!global.Notification || Notification.permission !== 'granted') return null;
    if (!document.hidden) return null;
    try {
      var n = new Notification(title, { body: String(body).slice(0, 180), tag: 'chat-' + title, silent: true });
      if (onClick) {
        n.onclick = function () { global.focus(); n.close(); onClick(); };
      }
      setTimeout(function () { n.close(); }, 8000);
      return n;
    } catch (e) {
      return null;
    }
  }

  /* -------------------------------------------------------- title badge */

  var baseTitle = document.title;

  function setUnreadTitle(count) {
    document.title = count > 0 ? '(' + (count > 99 ? '99+' : count) + ') ' + baseTitle : baseTitle;
  }

  global.Sound = {
    beep: beep,
    isEnabled: isEnabled,
    setEnabled: setEnabled,
    notify: notify,
    requestNotify: requestNotify,
    notifyPermission: notifyPermission,
    setUnreadTitle: setUnreadTitle
  };
})(window);
