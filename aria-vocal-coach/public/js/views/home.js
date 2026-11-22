import { esc } from '../ui/dom.js';
import { state as store, tierInfo, nextLesson, practiceRange } from '../store.js';
import { noteName } from '../audio/notes.js';
import { buildWarmup } from '../data/curriculum.js';
import { handoff } from '../engine.js';

export function homeView(el) {
  const tier = tierInfo();
  const next = nextLesson();
  const v = store.voice;
  const sk = store.skills;
  const pct = Math.round((tier.passed / tier.total) * 100);
  const minutes = Math.round(store.practiceSeconds / 60);
  const greet = new Date().getHours() < 12 ? 'Good morning' : new Date().getHours() < 18 ? 'Good afternoon' : 'Good evening';
  const skill = (label, val) => `
    <div class="skill"><span>${label}</span><div class="bar"><span style="width:${val ?? 0}%"></span></div><span class="val">${val ?? '–'}</span></div>`;

  el.innerHTML = `
    <section class="hero">
      <div class="card glow stack">
        <div class="tier">
          <div class="tier-badge">${tier.badge}</div>
          <div>
            <div class="muted small">${greet} 👋</div>
            <h1>You’re a <span class="grad-text">${esc(tier.title)}</span></h1>
          </div>
        </div>
        <div>
          <div class="row between small muted"><span>Path to Master</span><span>${tier.passed}/${tier.total} lessons</span></div>
          <div class="bar" style="margin-top:6px"><span style="width:${pct}%"></span></div>
        </div>
        ${
          next
            ? `<div class="row"><a class="btn big" href="#/lesson/${esc(next.id)}">${next.id === 'range' ? '🔎 Start here: find your voice' : `▶ Continue: ${esc(next.title)}`}</a></div>`
            : `<div class="row"><a class="btn big" href="#/learn">👑 Path complete — polish your stars</a></div>`
        }
      </div>
      <div class="card stack">
        <h3>🎙️ Your voice</h3>
        ${
          v
            ? `<div class="row"><span class="pill brand">${esc(v.type)}</span><span class="pill">${noteName(v.low)} – ${noteName(v.high)}</span></div>
               <p class="small muted" style="margin:0">Exercises are pitched for you: ${noteName(practiceRange().low)} – ${noteName(practiceRange().high)}.</p>
               <a class="btn ghost small" href="#/range">Re-test my range</a>`
            : `<p class="muted" style="margin:0">Take the 1-minute range test so every exercise and song is pitched for <em>your</em> voice.</p>
               <a class="btn cyan" href="#/range">🔎 Test my range</a>`
        }
      </div>
    </section>

    <section class="grid four" style="margin-top:14px">
      <div class="card stat"><div class="num">🔥 ${store.streak.count}</div><div class="lbl">day streak</div></div>
      <div class="card stat"><div class="num">${store.xp}</div><div class="lbl">XP earned</div></div>
      <div class="card stat"><div class="num">${tier.passed}</div><div class="lbl">lessons passed</div></div>
      <div class="card stat"><div class="num">${minutes}</div><div class="lbl">minutes sung</div></div>
    </section>

    <div class="section-title"><h2>Quick start</h2></div>
    <section class="grid three">
      <button class="card quick" id="warmup" style="cursor:pointer;text-align:left;color:inherit;font:inherit">
        <span class="q-ico">🔥</span><span><b>Daily warm-up</b><br><span class="small muted">2 minutes: hold, siren, scale</span></span>
      </button>
      <a class="card quick" href="#/coach"><span class="q-ico">🎙️</span><span><b>Live coach</b><br><span class="small muted">Free-sing tuner & note matching</span></span></a>
      <a class="card quick" href="#/songs"><span class="q-ico">🎵</span><span><b>Sing a song</b><br><span class="small muted">Classics or search any song</span></span></a>
    </section>

    <div class="section-title"><h2>Your skills</h2><span class="small muted">Updated after every take</span></div>
    <section class="card">
      ${skill('🎯 Pitch', sk.pitch)}
      ${skill('🧘 Steadiness', sk.stability)}
      ${skill('⏱️ Timing', sk.timing)}
      ${skill('⚡ Agility', sk.agility)}
      ${sk.pitch == null ? '<p class="small dim" style="margin:8px 0 0">Complete a lesson to start tracking your skills.</p>' : ''}
    </section>`;

  el.querySelector('#warmup').addEventListener('click', () => {
    handoff.practice = {
      title: 'Daily warm-up',
      subtitle: 'Hold a note, siren, then a five-note scale. Listen first, then sing.',
      targets: buildWarmup(practiceRange()),
      tolerance: 50,
      bpm: 88,
      focus: 'pitch',
      guideOnSing: false,
      backHref: '#/home',
    };
    location.hash = '#/practice';
  });
}
