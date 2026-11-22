// Small DOM helpers. Everything dynamic goes through esc() before hitting innerHTML.

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function toast(message, kind = 'info', ms = 3200) {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

export function starsHtml(n, max = 3) {
  let s = '';
  for (let i = 0; i < max; i++) s += i < n ? '★' : '<span class="off">★</span>';
  return `<span class="stars" aria-label="${n} of ${max} stars">${s}</span>`;
}

export function ringHtml(score, size = 200) {
  const r = size / 2 - 14;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, score)) / 100;
  const color = score >= 75 ? '#34d399' : score >= 60 ? '#fbbf24' : '#f87171';
  return `
  <div class="ring" style="width:${size}px;height:${size}px">
    <svg width="${size}" height="${size}">
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="14"/>
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="14" stroke-linecap="round"
        stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - pct)}" style="transition: stroke-dashoffset 1s ease"/>
    </svg>
    <div class="ring-val"><div><b>${Math.round(score)}</b><span class="muted small">score</span></div></div>
  </div>`;
}

export function modal(html, { onClose } = {}) {
  const root = document.getElementById('modal-root');
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  const close = () => {
    wrap.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (e) => e.key === 'Escape' && close();
  wrap.addEventListener('click', (e) => e.target === wrap && close());
  document.addEventListener('keydown', onKey);
  root.appendChild(wrap);
  return { el: wrap.firstElementChild, close };
}

export function fmtTime(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
