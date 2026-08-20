/* Progressive enhancement only — the site works fine without this file. */
(function () {
  'use strict';

  // Mobile navigation toggle -------------------------------------------------
  var toggle = document.querySelector('.nav-toggle');
  var nav = document.getElementById('site-nav');
  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      var open = nav.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', String(open));
    });
  }

  // Confirmation prompts (CSP-friendly: no inline handlers) -------------------
  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (form instanceof HTMLFormElement && form.dataset.confirm) {
      if (!window.confirm(form.dataset.confirm)) event.preventDefault();
    }
  });

  // Live slug preview + reading-time estimate on the editor -------------------
  var titleInput = document.getElementById('title');
  var slugInput = document.getElementById('slug');
  if (titleInput && slugInput) {
    var touched = slugInput.value.length > 0;
    slugInput.addEventListener('input', function () { touched = true; });
    titleInput.addEventListener('input', function () {
      if (touched) return;
      slugInput.value = titleInput.value
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
    });
  }

  var body = document.getElementById('body_md');
  if (body) {
    var meter = document.createElement('p');
    meter.className = 'hint editor-meter';
    body.insertAdjacentElement('afterend', meter);
    var update = function () {
      var words = body.value.split(/\s+/).filter(Boolean).length;
      meter.textContent = words + ' words · ~' + Math.max(1, Math.round(words / 200)) + ' min read';
    };
    body.addEventListener('input', update);
    update();
  }
})();
