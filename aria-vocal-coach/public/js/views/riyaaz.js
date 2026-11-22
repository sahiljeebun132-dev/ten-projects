// Riyaaz home: your Sa + tanpura, today's plan, stages, and the golden-voice meter.
import { esc, toast } from '../ui/dom.js';
import { engine, ensureContext } from '../engine.js';
import { noteName } from '../audio/notes.js';
import { swaraName, harmoniumScale } from '../audio/sargam.js';
import { state as store, riyaazSa, setSa, riyaazMinutesToday } from '../store.js';
import { EXERCISES, STAGES, stageOf, stageStatus, goldenVoice, suggestSa, today } from '../data/riyaaz.js';
import { goPractice, riyaazHandoff, nextRiyaaz } from '../runners.js';

export function riyaazView(el) {
  let tanpuraOn = false;

  function render() {
    const sa = riyaazSa();
    const r = store.riyaaz;
    const gold = goldenVoice(r, store.voice);
    const st = stageStatus(r);
    const stage = st.stage;
    const done = r.days[today()]?.done || {};
    const minutes = riyaazMinutesToday();
    const nextEx = sa != null ? nextRiyaaz() : null;
    const suggested = suggestSa(store.voice);

    el.innerHTML = `
      <h1>🪔 Riyaaz</h1>
      <p class="muted">Daily practice the Indian way — a tanpura on <em>your</em> Sa, sargam, kharaj, alankars and meend. A little every day, and the voice opens up and turns golden.</p>

      <section class="hero">
        <div class="card gold-card stack">
          <div class="row" style="gap:18px;align-items:center;flex-wrap:nowrap">
            ${goldRing(gold.score)}
            <div>
              <div class="small muted">Golden-voice meter</div>
              <h2 style="margin:2px 0 4px"><span class="gold-text">${esc(gold.tier.icon)} ${esc(gold.tier.name)}</span></h2>
              <div class="small muted">${esc(gold.tier.meaning)}${gold.nextTier ? ` · ${gold.nextTier.min - gold.score} points to <b>${esc(gold.nextTier.name)}</b>` : ' · the summit — keep it shining'}</div>
            </div>
          </div>
          <div class="gold-parts">
            ${gold.parts.map((p) => `<div class="skill"><span title="${esc(p.hint)}">${esc(p.label)} <span class="dim small">${esc(p.hint)}</span></span><div class="bar gold"><span style="width:${p.value ?? 0}%"></span></div><span class="val">${p.value ?? '–'}</span></div>`).join('')}
          </div>
          <p class="small dim" style="margin:0">Each part fills with steady riyaaz — one great take isn’t a golden voice; weeks of daily practice are.</p>
        </div>

        <div class="card stack">
          <h3>🎵 Your Sa</h3>
          ${
            sa == null
              ? `<p class="muted" style="margin:0">Sa is your home note — every swara is measured from it, and the tanpura is tuned to it. Take the range test so I can find a Sa that suits your voice.</p>
                 <a class="btn cyan" href="#/range">🔎 Find my Sa (range test)</a>
                 <div class="small muted">Or start with a typical Sa:</div>
                 <div class="row"><button class="btn ghost small" data-sa="49">Lower voice · C♯3</button><button class="btn ghost small" data-sa="56">Higher voice · G♯3</button></div>`
              : `<div class="row" style="align-items:center;gap:14px">
                   <div><div class="sa-big gold-text">${esc(noteName(sa))}</div><div class="small muted">${esc(harmoniumScale(sa))} on the harmonium</div></div>
                   <div class="row" style="gap:6px">
                     <button class="btn ghost small" id="sa-down" aria-label="Lower Sa">−</button>
                     <button class="btn ghost small" id="sa-up" aria-label="Raise Sa">+</button>
                     <button class="btn small ${tanpuraOn ? '' : 'ghost'}" id="tan">${tanpuraOn ? '■ Stop tanpura' : '🪕 Tanpura'}</button>
                   </div>
                 </div>
                 <div class="swara-strip">${saptakStrip(sa)}</div>
                 ${suggested != null && suggested !== sa ? `<div class="small muted">Suggested from your range: <b>${esc(noteName(suggested))}</b> <button class="btn ghost small" id="sa-suggest">Use it</button></div>` : ''}
                 <p class="small dim" style="margin:0">Hum along with the tanpura. If Sa feels low and growly or high and tight, move it a semitone.</p>`
          }
        </div>
      </section>

      ${
        sa == null
          ? ''
          : `
      <div class="section-title"><h2>📅 Aaj ka riyaaz</h2><span class="small muted">Today · ${minutes} min so far</span></div>
      <div class="card stack">
        <div class="row between">
          <span class="pill gold">${esc(stage.icon)} Stage ${stage.n} · ${esc(stage.name)} <span class="dim">(${esc(stage.meaning)})</span></span>
          ${nextEx ? `<button class="btn" id="go">▶ ${Object.keys(done).length ? 'Continue' : 'Start'} today’s riyaaz</button>` : '<span class="pill good">✅ Done for today</span>'}
        </div>
        ${minutes >= 45 ? '<p class="pill warn" style="white-space:normal;display:block;border-radius:12px;padding:10px 12px;margin:0">🌙 Bas, aaj ke liye kaafi — 45+ minutes today. Rest is part of riyaaz: tired vocal folds don’t improve, they get hurt.</p>' : ''}
        <div class="rx-list">
          ${stage.plan
            .map((id) => {
              const ex = EXERCISES.find((e) => e.id === id);
              const score = done[id];
              return `<div class="rx-row ${score != null ? 'done' : ''}">
                <span class="rx-ico">${ex.icon}</span>
                <span class="rx-meta"><b>${esc(ex.title)} <span class="dim small">${esc(ex.hindi)}</span></b><span>${esc(ex.subtitle)}</span></span>
                ${score != null ? `<span class="pill good">✓ ${score}</span>` : ''}
                <button class="btn small ${score != null ? 'ghost' : ''}" data-ex="${esc(id)}">${score != null ? 'Again' : 'Start'}</button>
              </div>`;
            })
            .join('')}
        </div>
        ${
          stage.need
            ? `<div>
                <div class="row between small muted"><span>To reach stage ${stage.n + 1} (${esc(stageOf(stage.n + 1).name)}): ${stage.need.days} riyaaz days, average ${stage.need.avg}+</span><span>${st.days}/${stage.need.days} days · avg ${st.avg || '–'}</span></div>
                <div class="bar gold" style="margin-top:6px"><span style="width:${Math.round(Math.min(1, st.days / stage.need.days) * 100)}%"></span></div>
                <p class="small dim" style="margin:6px 0 0">A riyaaz day = 3 or more exercises. Stages move with your consistency and your sur, not the calendar.</p>
              </div>`
            : '<p class="small muted" style="margin:0">✨ You’ve reached Swarna. A golden voice is kept golden by daily riyaaz — keep it going.</p>'
        }
      </div>

      <div class="section-title"><h2>🗺️ The path</h2></div>
      <div class="stage-road">
        ${STAGES.map((s) => `<div class="${s.n === stage.n ? 'on' : s.n < stage.n ? 'past' : ''}"><span class="s-ico">${s.icon}</span><b>${esc(s.name)}</b><br><span class="dim">${esc(s.meaning)}</span></div>`).join('')}
      </div>

      <div class="section-title"><h2>📿 All riyaaz exercises</h2></div>
      <div class="grid two">
        ${EXERCISES.map((ex) => {
          const locked = ex.stage > stage.n;
          return `<button class="card quick ${locked ? 'locked' : ''}" data-ex="${esc(ex.id)}" ${locked ? 'disabled' : ''} style="text-align:left;color:inherit;font:inherit;cursor:${locked ? 'default' : 'pointer'}">
            <span class="q-ico">${locked ? '🔒' : ex.icon}</span>
            <span><b>${esc(ex.title)}</b> <span class="dim small">${esc(ex.hindi)}</span><br><span class="small muted">${locked ? `Unlocks at stage ${ex.stage} · ${esc(stageOf(ex.stage).name)}` : esc(ex.subtitle)}</span></span>
          </button>`;
        }).join('')}
      </div>`
      }

      <div class="section-title"><h2>🩺 Swasthya — keep your voice healthy</h2></div>
      <div class="card">
        <ul class="insights">
          <li class="info"><span class="i-ico">🚫</span><span><b>Never “break” the voice by force.</b> Shouting, screaming or singing through a sore throat to change your voice damages the vocal folds (nodules, haemorrhage). The riyaaz here opens the voice gradually — that is the safe, traditional way.</span></li>
          <li class="info"><span class="i-ico">🔥</span><span>Warm up first (Omkar), and start soft. Loud singing comes last, never first.</span></li>
          <li class="info"><span class="i-ico">💧</span><span>Sip room-temperature water. Skip ice-cold drinks and heavy dairy right before riyaaz.</span></li>
          <li class="info"><span class="i-ico">😴</span><span>Take one lighter day a week, and stop if anything hurts or scratches. Pain is never part of riyaaz.</span></li>
          <li class="info"><span class="i-ico">🩺</span><span>Hoarseness that lasts more than two weeks, or pain when singing, needs an ENT doctor — not more practice.</span></li>
        </ul>
      </div>`;

    el.querySelectorAll('[data-sa]').forEach((b) =>
      b.addEventListener('click', () => {
        setSa(Number(b.dataset.sa));
        render();
      }),
    );
    const move = (d) => {
      setSa(riyaazSa() + d);
      if (tanpuraOn) engine.guide?.tanpura(riyaazSa());
      render();
    };
    el.querySelector('#sa-down')?.addEventListener('click', () => move(-1));
    el.querySelector('#sa-up')?.addEventListener('click', () => move(1));
    el.querySelector('#sa-suggest')?.addEventListener('click', () => move(suggested - riyaazSa()));
    el.querySelector('#tan')?.addEventListener('click', async () => {
      await ensureContext();
      tanpuraOn = !tanpuraOn;
      if (tanpuraOn) engine.guide.tanpura(riyaazSa());
      else engine.guide.stopTanpura();
      render();
    });
    const start = (id) => {
      const h = riyaazHandoff(id);
      if (!h) return toast('Set your Sa first.', 'error');
      goPractice(h);
    };
    el.querySelector('#go')?.addEventListener('click', () => nextEx && start(nextEx.id));
    el.querySelectorAll('[data-ex]').forEach((b) => b.addEventListener('click', () => !b.disabled && start(b.dataset.ex)));
  }

  render();
  return () => engine.guide?.stopTanpura();
}

/** Mandra Pa … taar Sa, with the Western note under each swara. */
function saptakStrip(sa) {
  return [-5, -3, -1, 0, 2, 4, 5, 7, 9, 11, 12]
    .map((o) => `<span class="${o % 12 === 0 ? 'sa' : ''}">${esc(swaraName(sa + o, sa))}<small>${esc(noteName(sa + o))}</small></span>`)
    .join('');
}

export function goldRing(score, size = 120) {
  const r = size / 2 - 10;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, score)) / 100;
  return `
  <div class="ring" style="width:${size}px;height:${size}px;flex-shrink:0">
    <svg width="${size}" height="${size}">
      <defs><linearGradient id="goldg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fde68a"/><stop offset=".6" stop-color="#f59e0b"/><stop offset="1" stop-color="#f97316"/></linearGradient></defs>
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="10"/>
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="url(#goldg)" stroke-width="10" stroke-linecap="round"
        stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - pct)}" style="transition: stroke-dashoffset 1s ease"/>
    </svg>
    <div class="ring-val"><div><b class="gold-text" style="font-size:2.2rem">${Math.round(score)}</b></div></div>
  </div>`;
}
