// Your progress: week-by-week charts from every take, and "then & now" — an old recording beside a
// new one of the same exercise, with the teacher saying what changed. Recordings stay on this
// device (takes.js); the teacher sees only the numbers and the pitch pictures, never the audio.
import { esc, toast } from '../ui/dom.js';
import { state as store, markProgressSeen } from '../store.js';
import { weeklyTrend, thenAndNow, monthlyNudge, expandPitch, takeSummary, keepReasons, DAY } from '../progress.js';
import { listTakes, deleteTake, setStarred, clearTakes } from '../takes.js';
import { takeImage } from '../ui/takeImage.js';
import { noteName } from '../audio/notes.js';
import { swaraName } from '../audio/sargam.js';
import { teacherStatus, compareTakes, buildTeacherContext, visibleText, createSpeaker } from '../teacherTalk.js';

const SERIES = [
  { key: 'inTune', label: 'In tune', unit: '%', color: '#3987e5' },
  { key: 'steadiness', label: 'Steadiness', unit: '', color: '#d95926' },
  { key: 'timing', label: 'Timing', unit: '', color: '#199e70' },
];
// Tone takes the next two palette slots, so no colour means two things on one page.
const TONE_SERIES = [
  { key: 'clarity', label: 'Clarity', unit: '', color: '#c98500' },
  { key: 'ring', label: 'Ring', unit: '', color: '#d55181' },
];
const MAX_PAIRS = 8;
const MAX_PICTURE = 190_000; // base64 characters the server accepts per picture, with room to spare

const fmtDate = (at) => new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const weekStart = (w) => {
  const [y, m, d] = w.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
};
const fairTone = (rec) => Boolean(rec.stats?.tone?.reliable && !rec.stats.tone.backing);
const mb = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const signed = (n, unit = '') => `${n > 0 ? '+' : ''}${n}${unit}`;

export function progressView(el) {
  const urls = [];
  const cleanups = [];
  let abort = null;
  let disposed = false;
  const speaker = createSpeaker();

  el.innerHTML = `
    <div class="practice-head"><a class="back" href="#/home">← Home</a></div>
    <h1>📈 Your progress</h1>
    <p class="muted">Aria scores every take and keeps the recordings worth hearing again: your first, your best, your latest, and your best of each week. They stay in this browser.</p>
    <section class="grid four" id="stats"></section>
    <div id="highlight"></div>
    <div class="section-title"><h2>Week by week</h2><span class="small muted">Last 12 weeks, every take</span></div>
    <section class="card" id="trend"></section>
    <div class="section-title"><h2>Tone, week by week</h2><span class="small muted">Clarity (clean tone, not air) and ring (2–4 kHz brightness)</span></div>
    <section class="card" id="tone-trend"></section>
    <div class="section-title"><h2>Then &amp; now</h2><span class="small muted">Where you started, beside your latest take</span></div>
    <section id="pairs" class="stack"><p class="muted">Loading your recordings…</p></section>
    <div class="section-title"><h2>Your recordings</h2><span class="small muted" id="usage"></span></div>
    <section id="library" class="stack"></section>`;

  const log = store.progress.log;
  const trend = weeklyTrend(log);
  renderStats(el.querySelector('#stats'), log, trend, null);
  cleanups.push(renderTrend(el.querySelector('#trend'), trend));
  cleanups.push(
    renderTrend(el.querySelector('#tone-trend'), trend, TONE_SERIES, {
      describe: 'Weekly tone readings for the last 12 weeks: clarity and ring.',
      empty: 'Tone readings start with your next microphone takes (in a quiet room, ideally with headphones).',
    }),
  );

  const teacherReady = teacherStatus().then((s) => Boolean(s.available));
  let libById = new Map(); // the takes the library list shows, by id

  async function load() {
    urls.splice(0).forEach((u) => URL.revokeObjectURL(u)); // everything below is drawn afresh
    let takes = [];
    try {
      takes = await listTakes();
    } catch {
      el.querySelector('#pairs').innerHTML = '<p class="muted">This browser can’t keep recordings (a private window, perhaps), so there’s nothing to compare yet.</p>';
      return;
    }
    if (disposed) return;
    const bytes = takes.reduce((n, t) => n + (t.bytes || 0), 0);
    renderStats(el.querySelector('#stats'), log, trend, { count: takes.length, bytes });
    el.querySelector('#usage').textContent = takes.length ? `${takes.length} kept · ${mb(bytes)}` : '';
    const pairs = thenAndNow(takes);
    const nudge = monthlyNudge(pairs, store.progress.seenAt);
    renderHighlight(nudge);
    await renderPairs(pairs, await teacherReady);
    renderLibrary(takes);
    if (nudge) markProgressSeen();
  }

  function audioFor(rec, label) {
    if (!rec.audio) return '<p class="small dim" style="margin:6px 0">No recording (sung with the demo voice).</p>';
    const u = URL.createObjectURL(rec.audio);
    urls.push(u);
    return `<audio controls preload="none" src="${esc(u)}" style="width:100%" aria-label="${esc(label)}"></audio>`;
  }

  function labelFor(rec) {
    return rec.sa != null && store.settings.notation === 'sargam' ? (m) => swaraName(m, rec.sa) : noteName;
  }

  function picture(rec) {
    return takeImage({
      title: `${rec.title} · ${fmtDate(rec.at)}`,
      targets: rec.targets,
      frames: expandPitch(rec.pitch),
      tolerance: rec.stats?.tolerance ?? 50,
      labelFn: labelFor(rec),
      tonicPc: rec.sa != null ? ((rec.sa % 12) + 12) % 12 : null,
    });
  }

  function renderHighlight(nudge) {
    const box = el.querySelector('#highlight');
    if (!nudge) {
      box.innerHTML = '';
      return;
    }
    const d = nudge.now.stats.score - nudge.then.stats.score;
    box.innerHTML = `
      <div class="card glow" style="margin-top:14px">
        <h3 style="margin:0 0 4px">⏪ ${Number(nudge.days)} days of singing</h3>
        <p class="muted" style="margin:0">You first sang <b>${esc(nudge.title)}</b> on ${esc(fmtDate(nudge.then.at))}. Play that take, then this week’s, and hear the difference${d > 0 ? ` (your score went from ${Number(nudge.then.stats.score)} to ${Number(nudge.now.stats.score)})` : ''}.</p>
        <a class="btn small" style="margin-top:10px" href="#/progress" data-jump="${esc(nudge.key)}">Hear then &amp; now ↓</a>
      </div>`;
    box.querySelector('[data-jump]').addEventListener('click', (e) => {
      e.preventDefault();
      el.querySelector(`[data-pair="${CSS.escape(nudge.key)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  async function renderPairs(pairs, canAsk) {
    const box = el.querySelector('#pairs');
    if (!pairs.length) {
      box.innerHTML = `<div class="card"><p class="muted" style="margin:0">Keep practising. Once an exercise has a take from at least a week ago, it shows up here beside your latest one, so you can hear how far you’ve come.</p></div>`;
      return;
    }
    const shown = pairs.slice(0, MAX_PAIRS);
    box.innerHTML = shown
      .map((pair, i) => {
        const { then, now } = pair;
        const side = (rec, which) => `
          <div class="pair-side">
            <div class="small muted">${which} · ${esc(fmtDate(rec.at))}</div>
            <div class="pair-score"><b>${Number(rec.stats.score)}</b><span class="small muted">score</span></div>
            <div class="small muted">In tune ${Number(rec.stats.accuracy)}% · Steadiness ${Number(rec.stats.stability)} · Timing ${Number(rec.stats.timing)}</div>
            ${rec.stats.tone ? `<div class="small muted">Tone: ${esc(rec.stats.tone.sound)}, ${esc(rec.stats.tone.colour)} · clarity ${Number(rec.stats.tone.clarity)} · ring ${Number(rec.stats.tone.ring)}${rec.stats.tone.reliable && !rec.stats.tone.backing ? '' : ' (rough)'}</div>` : ''}
            ${audioFor(rec, `${pair.title}, ${which.toLowerCase()}`)}
            <img class="pitch-pic" data-pic="${i}-${which === 'Then' ? 0 : 1}" alt="Pitch line of the ${which.toLowerCase()} take over the target notes">
          </div>`;
        const deltas = [
          ['Score', now.stats.score - then.stats.score, ''],
          ['In tune', now.stats.accuracy - then.stats.accuracy, ' pts'],
          ['Steadiness', now.stats.stability - then.stats.stability, ''],
          ...(fairTone(then) && fairTone(now) ? [['Clarity', now.stats.tone.clarity - then.stats.tone.clarity, '']] : []),
        ]
          .map(([name, d, unit]) => `<span class="pill ${d > 0 ? 'good' : d < 0 ? 'warn' : ''}">${name} ${d > 0 ? '▲' : d < 0 ? '▼' : '●'} ${esc(signed(Number(d), unit))}</span>`)
          .join('');
        return `
          <article class="card" data-pair="${esc(pair.key)}">
            <div class="row between"><h3 style="margin:0">${esc(pair.title)}</h3><span class="pill">${Number(pair.days)} days apart</span></div>
            <div class="pair-grid">${side(then, 'Then')}${side(now, 'Now')}</div>
            <div class="row" style="margin-top:10px">${deltas}</div>
            <div class="row" style="margin-top:12px">
              <button class="btn cyan small" data-ask="${i}" ${canAsk ? '' : 'disabled title="Connect the AI teacher (ANTHROPIC_API_KEY) to ask"'}>🧑‍🏫 What changed?</button>
              ${canAsk ? '' : '<span class="small dim">The AI teacher isn’t connected.</span>'}
            </div>
            <div class="teacher-say hidden" data-reply="${i}" style="margin-top:12px">
              <div class="t-avatar" aria-hidden="true">🧑‍🏫</div><div><b>Your teacher</b><p data-text aria-live="polite"></p></div>
            </div>
          </article>`;
      })
      .join('');
    // The pictures: drawn once, shown on the page and sent to the teacher.
    const pics = shown.map((pair) => [picture(pair.then), picture(pair.now)]);
    pics.forEach(([a, b], i) => {
      const set = (img, data) => (data ? img.setAttribute('src', `data:image/png;base64,${data}`) : img.remove());
      set(box.querySelector(`[data-pic="${i}-0"]`), a);
      set(box.querySelector(`[data-pic="${i}-1"]`), b);
    });
    box.querySelectorAll('[data-ask]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.ask);
        ask(shown[i], pics[i], btn, box.querySelector(`[data-reply="${i}"]`));
      }),
    );
  }

  async function ask(pair, [thenPic, nowPic], btn, reply) {
    abort?.abort();
    abort = new AbortController();
    const mine = abort;
    const out = reply.querySelector('[data-text]');
    reply.classList.remove('hidden');
    out.textContent = 'Listening to both…';
    btn.disabled = true;
    speaker.reset();
    const voice = store.settings.teacherVoice !== false;
    let text = '';
    const fit = (pic) => (pic && pic.length <= MAX_PICTURE ? pic : null);
    try {
      await compareTakes(
        {
          exercise: pair.title,
          daysApart: pair.days,
          then: { take: takeSummary(pair.then, Date.now(), labelFor(pair.then)), image: fit(thenPic) },
          now: { take: takeSummary(pair.now, Date.now(), labelFor(pair.now)), image: fit(nowPic) },
          context: buildTeacherContext(store),
        },
        {
          signal: mine.signal,
          onText: (chunk) => {
            text += chunk;
            const shown = visibleText(text);
            out.textContent = shown;
            if (voice) speaker.feed(shown);
          },
        },
      );
      if (voice) speaker.feed(visibleText(text), true);
      if (!text.trim()) out.textContent = 'Your teacher didn’t answer that time. Try again.';
    } catch (err) {
      if (mine.signal.aborted) return;
      out.textContent = err.message || 'I couldn’t reach your teacher.';
    } finally {
      if (!disposed) btn.disabled = false;
    }
  }

  function renderLibrary(takes) {
    const box = el.querySelector('#library');
    if (!takes.length) {
      box.innerHTML = '<div class="card"><p class="muted" style="margin:0">No recordings yet. Sing any lesson, riyaaz or song with the microphone and your takes appear here.</p></div>';
      return;
    }
    const reasons = keepReasons(takes);
    const groups = new Map();
    for (const t of takes) {
      if (!groups.has(t.key)) groups.set(t.key, []);
      groups.get(t.key).push(t);
    }
    const ordered = [...groups.values()].sort((a, b) => b[b.length - 1].at - a[a.length - 1].at);
    const why = (t) => {
      const r = reasons.get(t.id);
      return [r.has('starred') && '★ Kept', r.has('first') && 'First', r.has('best') && 'Best'].filter(Boolean);
    };
    box.innerHTML =
      ordered
        .map((g, gi) => {
          const latest = g[g.length - 1];
          const best = Math.max(...g.map((t) => Number(t.stats?.score) || 0));
          return `
            <details class="card lib-group" data-group="${gi}">
              <summary><b>${esc(latest.title)}</b><span class="small muted">${g.length} recording${g.length === 1 ? '' : 's'} · best ${best} · last ${esc(fmtDate(latest.at))}</span></summary>
              <div class="lib-rows">
                ${[...g]
                  .reverse()
                  .map(
                    (t) => `
                  <div class="lib-row" data-id="${esc(t.id)}">
                    <div><b>${Number(t.stats?.score) || 0}</b> <span class="small muted">${esc(fmtDate(t.at))}</span> ${why(t)
                      .map((w) => `<span class="pill">${esc(w)}</span>`)
                      .join(' ')}</div>
                    <div class="lib-audio" data-audio></div>
                    <div class="row" style="gap:6px">
                      <button class="btn ghost small" data-star aria-pressed="${t.starred ? 'true' : 'false'}" title="${t.starred ? 'Stop keeping this one for good' : 'Keep this one for good'}">${t.starred ? '★' : '☆'}</button>
                      <button class="btn ghost small" data-del title="Delete this recording">🗑</button>
                    </div>
                  </div>`,
                  )
                  .join('')}
              </div>
            </details>`;
        })
        .join('') +
      `<div class="row between"><p class="small dim" style="margin:0">Recordings never leave this device. Deleting them keeps your weekly chart.</p><button class="btn danger small" id="clear-all">Delete all recordings</button></div>`;

    const byId = (libById = new Map(takes.map((t) => [t.id, t])));
    // Audio players are made when a group is opened, not for every take up front.
    box.querySelectorAll('details.lib-group').forEach((d) =>
      d.addEventListener('toggle', () => {
        if (!d.open) return;
        d.querySelectorAll('.lib-row').forEach((row) => {
          const slot = row.querySelector('[data-audio]');
          if (slot.dataset.ready) return;
          slot.dataset.ready = '1';
          const t = byId.get(row.dataset.id);
          slot.innerHTML = audioFor(t, `${t.title}, ${fmtDate(t.at)}`);
        });
      }),
    );
  }

  // One listener for the library list, however often it's redrawn.
  el.querySelector('#library').addEventListener('click', async (e) => {
      const row = e.target.closest('.lib-row');
      if (e.target.closest('[data-star]') && row) {
        const t = libById.get(row.dataset.id);
        if (!t) return;
        const rec = await setStarred(t.id, !t.starred).catch(() => null);
        if (!rec || disposed) return;
        t.starred = rec.starred;
        const b = row.querySelector('[data-star]');
        b.textContent = rec.starred ? '★' : '☆';
        b.setAttribute('aria-pressed', String(rec.starred));
        toast(rec.starred ? 'Kept for good' : 'No longer kept for good', 'good');
      } else if (e.target.closest('[data-del]') && row) {
        if (!confirm('Delete this recording? This can’t be undone.')) return;
        await deleteTake(row.dataset.id).catch(() => null);
        if (!disposed) load();
      } else if (e.target.closest('#clear-all')) {
        if (!confirm('Delete every saved recording? Your scores and weekly chart stay. This can’t be undone.')) return;
        await clearTakes().catch(() => null);
        if (!disposed) load();
      }
  });

  load();

  return () => {
    disposed = true;
    abort?.abort();
    speaker.stop();
    cleanups.forEach((fn) => fn?.());
    urls.forEach((u) => URL.revokeObjectURL(u));
  };
}

/** Rolling windows, so a Monday morning doesn't read as "0 this week". */
function renderStats(box, log, trend, lib) {
  const now = Date.now();
  const within = (from, to) => log.filter((e) => e.at >= now - from * DAY && e.at < now - to * DAY);
  const avgTune = (es) => {
    const v = es.map((e) => e.acc).filter((x) => Number.isFinite(x));
    return v.length ? Math.round(v.reduce((s, x) => s + x, 0) / v.length) : null;
  };
  const last7 = within(7, 0);
  const prev7 = within(14, 7);
  const tune = avgTune(last7);
  const priorTune = avgTune(within(35, 7));
  const weeks = trend.filter((w) => w.takes).length;
  const delta = (d, vs) => (d == null || !Number.isFinite(d) ? '' : `<div class="delta ${d > 0 ? 'up' : d < 0 ? 'down' : ''}">${d > 0 ? '▲' : d < 0 ? '▼' : '●'} ${esc(signed(d))} ${esc(vs)}</div>`);
  box.innerHTML = `
    <div class="card stat"><div class="lbl">Takes, last 7 days</div><div class="num">${last7.length}</div>${delta(last7.length - prev7.length, 'vs the 7 days before')}</div>
    <div class="card stat"><div class="lbl">In tune, last 7 days</div><div class="num">${tune != null ? `${tune}%` : '–'}</div>${tune != null && priorTune != null ? delta(tune - priorTune, 'vs the 4 weeks before') : ''}</div>
    <div class="card stat"><div class="lbl">Weeks practised</div><div class="num">${weeks}<span class="small muted"> of 12</span></div></div>
    <div class="card stat"><div class="lbl">Recordings kept</div><div class="num">${lib ? lib.count : '…'}</div>${lib && lib.count ? `<div class="delta">${esc(mb(lib.bytes))} on this device</div>` : ''}</div>`;
}

/** The weekly line chart: one 0–100 axis, three series, a crosshair tooltip and a table view. */
function renderTrend(box, trend, series = SERIES, { describe = 'Weekly averages for the last 12 weeks: in tune, steadiness and timing.', empty = 'Sing a few takes and your week-by-week chart starts here.' } = {}) {
  if (!trend.some((w) => series.some((s) => w[s.key] != null))) {
    box.innerHTML = `<p class="muted" style="margin:0">${esc(empty)}</p>`;
    return null;
  }
  box.innerHTML = `
    <div class="viz-legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.label)}</span>`).join('')}</div>
    <div class="viz-wrap"><div class="viz-plot"></div><div class="viz-tip hidden" role="status"></div></div>
    <details class="viz-table"><summary class="small muted">Show as a table</summary>
      <table class="cmp"><thead><tr><th>Week of</th><th>Takes</th>${series.map((s) => `<th>${esc(s.label)}</th>`).join('')}</tr></thead>
      <tbody>${trend
        .map((w) => `<tr><td>${esc(fmtDate(weekStart(w.week)))}</td><td>${w.takes}</td>${series.map((s) => `<td>${w[s.key] ?? '–'}${w[s.key] != null ? s.unit : ''}</td>`).join('')}</tr>`)
        .join('')}</tbody></table>
    </details>`;
  const plot = box.querySelector('.viz-plot');
  const tip = box.querySelector('.viz-tip');
  let index = trend.length - 1;
  let geo = null;

  const draw = () => {
    const W = Math.max(280, Math.round(plot.clientWidth || 600));
    const H = 220;
    const narrow = W < 420; // phones: no room for end labels, so the legend and tooltip carry them
    const pad = { l: 34, r: narrow ? 14 : 92, t: 12, b: 28 };
    const pw = W - pad.l - pad.r;
    const ph = H - pad.t - pad.b;
    const x = (i) => pad.l + (trend.length === 1 ? pw / 2 : (i / (trend.length - 1)) * pw);
    const y = (v) => pad.t + (1 - v / 100) * ph;
    const every = W < 420 ? 3 : W < 600 ? 2 : 1;
    let svg = '';
    for (const v of [0, 25, 50, 75, 100]) {
      svg += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" class="viz-grid"/>`;
      svg += `<text x="${pad.l - 6}" y="${y(v)}" class="viz-axis" text-anchor="end" dominant-baseline="middle">${v}</text>`;
    }
    trend.forEach((w, i) => {
      if ((trend.length - 1 - i) % every) return;
      svg += `<text x="${x(i)}" y="${H - 8}" class="viz-axis" text-anchor="middle">${esc(fmtDate(weekStart(w.week)))}</text>`;
    });
    const ends = [];
    for (const s of series) {
      // Lines break across weeks with no takes; every week with data gets a marker.
      let d = '';
      let pen = false;
      trend.forEach((w, i) => {
        const v = w[s.key];
        if (v == null) {
          pen = false;
          return;
        }
        d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
        pen = true;
      });
      if (d) svg += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
      trend.forEach((w, i) => {
        if (w[s.key] != null) svg += `<circle cx="${x(i)}" cy="${y(w[s.key])}" r="4" fill="${s.color}" class="viz-dot"/>`;
      });
      const last = trend.map((w, i) => [w[s.key], i]).filter(([v]) => v != null).pop();
      if (last) ends.push({ s, v: last[0], yy: y(last[0]), xx: x(last[1]) });
    }
    // Direct end labels only when they don't collide; the legend and tooltip always carry identity.
    ends.sort((a, b) => a.yy - b.yy);
    const apart = !narrow && ends.every((e, i) => i === 0 || e.yy - ends[i - 1].yy >= 15);
    if (apart) for (const e of ends) svg += `<text x="${e.xx + 9}" y="${e.yy}" class="viz-label" dominant-baseline="middle">${esc(e.s.label)} ${e.v}</text>`;
    svg += `<line class="viz-cross hidden" y1="${pad.t}" y2="${H - pad.b}"/>`;
    plot.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" tabindex="0" role="img" aria-label="${esc(describe)} Use the arrow keys to read each week.">${svg}<rect x="${pad.l - 10}" y="0" width="${pw + 20}" height="${H}" fill="transparent" class="viz-hit"/></svg>`;
    geo = { x, W, pad };
    const el = plot.querySelector('svg');
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left;
      let best = 0;
      trend.forEach((_, i) => {
        if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i;
      });
      show(best);
    });
    el.addEventListener('pointerleave', hide);
    el.addEventListener('focus', () => show(index));
    el.addEventListener('blur', hide);
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      show(Math.max(0, Math.min(trend.length - 1, index + (e.key === 'ArrowRight' ? 1 : -1))));
    });
  };

  function show(i) {
    index = i;
    const w = trend[i];
    const cross = plot.querySelector('.viz-cross');
    cross.setAttribute('x1', geo.x(i));
    cross.setAttribute('x2', geo.x(i));
    cross.classList.remove('hidden');
    tip.replaceChildren();
    const head = document.createElement('div');
    head.className = 'small muted';
    head.textContent = `Week of ${fmtDate(weekStart(w.week))} · ${w.takes} take${w.takes === 1 ? '' : 's'}`;
    tip.appendChild(head);
    for (const s of series) {
      const row = document.createElement('div');
      row.className = 'viz-tip-row';
      const key = document.createElement('i');
      key.style.background = s.color;
      const val = document.createElement('b');
      val.textContent = w[s.key] != null ? `${w[s.key]}${s.unit}` : '–';
      const name = document.createElement('span');
      name.textContent = s.label;
      row.append(key, val, name);
      tip.appendChild(row);
    }
    tip.classList.remove('hidden');
    const left = geo.x(i) + 12;
    tip.style.left = `${Math.min(left, geo.W - tip.offsetWidth - 4)}px`;
    if (left > geo.W - tip.offsetWidth - 4) tip.style.left = `${Math.max(0, geo.x(i) - tip.offsetWidth - 12)}px`;
  }

  function hide() {
    tip.classList.add('hidden');
    plot.querySelector('.viz-cross')?.classList.add('hidden');
  }

  draw();
  let drawnWidth = plot.clientWidth;
  const ro =
    typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => {
          if (Math.abs(plot.clientWidth - drawnWidth) < 2) return;
          drawnWidth = plot.clientWidth;
          draw();
        })
      : null;
  ro?.observe(plot);
  return () => ro?.disconnect();
}
