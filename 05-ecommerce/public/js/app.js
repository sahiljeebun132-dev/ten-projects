/* Northwind Goods - demo store front-end helpers.
   Progressive enhancement only: every form works without JavaScript. */
(function () {
  'use strict';

  // ---------------------------------------------------------- gallery
  var thumbs = document.querySelectorAll('[data-gallery-thumb]');
  var mainImg = document.querySelector('[data-gallery-main]');
  if (mainImg && thumbs.length) {
    thumbs.forEach(function (btn) {
      btn.addEventListener('click', function () {
        mainImg.src = btn.getAttribute('data-src');
        mainImg.alt = btn.getAttribute('data-alt') || mainImg.alt;
        thumbs.forEach(function (b) { b.setAttribute('aria-current', 'false'); });
        btn.setAttribute('aria-current', 'true');
      });
    });
  }

  // ------------------------------------------------------ quantity +/-
  document.querySelectorAll('[data-qty]').forEach(function (widget) {
    var input = widget.querySelector('input');
    if (!input) return;
    widget.querySelectorAll('button[data-step]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var step = parseInt(btn.getAttribute('data-step'), 10) || 0;
        var min = parseInt(input.min, 10); if (isNaN(min)) min = 1;
        var max = parseInt(input.max, 10); if (isNaN(max)) max = 20;
        var next = (parseInt(input.value, 10) || min) + step;
        input.value = Math.max(min, Math.min(max, next));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
    });
  });

  // Cart quantity inputs submit their own row when changed.
  document.querySelectorAll('form[data-autosubmit] input[name="quantity"]').forEach(function (input) {
    input.addEventListener('change', function () {
      input.form.requestSubmit ? input.form.requestSubmit() : input.form.submit();
    });
  });

  // ------------------------------------------- demo card number helper
  var cardInput = document.querySelector('[data-card-number]');
  if (cardInput) {
    cardInput.addEventListener('input', function () {
      var digits = cardInput.value.replace(/\D/g, '').slice(0, 16);
      cardInput.value = digits.replace(/(.{4})/g, '$1 ').trim();
    });
  }
  var expiry = document.querySelector('[data-card-expiry]');
  if (expiry) {
    expiry.addEventListener('input', function () {
      var d = expiry.value.replace(/\D/g, '').slice(0, 4);
      expiry.value = d.length > 2 ? d.slice(0, 2) + '/' + d.slice(2) : d;
    });
  }
  document.querySelectorAll('[data-fill-demo-card]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var form = btn.closest('form');
      if (!form) return;
      form.querySelector('[name="card_name"]').value = 'Demo Shopper';
      form.querySelector('[name="card_number"]').value = '4242 4242 4242 4242';
      form.querySelector('[name="card_expiry"]').value = '12/34';
      form.querySelector('[name="card_cvc"]').value = '123';
    });
  });

  // ----------------------------------------------- destructive confirms
  document.querySelectorAll('form[data-confirm]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      if (!window.confirm(form.getAttribute('data-confirm'))) e.preventDefault();
    });
  });
})();
