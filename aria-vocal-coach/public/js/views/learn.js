import { esc, starsHtml } from '../ui/dom.js';
import { LEVELS } from '../data/curriculum.js';
import { isUnlocked, lessonProgress, tierInfo } from '../store.js';

export function learnView(el) {
  const tier = tierInfo();
  el.innerHTML = `
    <h1>Your path to <span class="grad-text">mastery</span></h1>
    <p class="muted">Five levels from first note to solo performance. Pass a lesson (60+) to unlock the next. You’re at <b>${esc(tier.title)}</b> — ${tier.passed}/${tier.total} lessons passed.</p>
    ${LEVELS.map((lv) => {
      const open = isUnlocked(lv.lessons[0].id);
      return `
      <section class="level ${open ? 'unlocked' : ''}">
        <div class="level-head">
          <div class="level-num">${lv.n}</div>
          <div><h2 style="margin:0">${lv.badge} ${esc(lv.name)} <span class="pill" style="vertical-align:middle">${esc(lv.tier)}</span></h2>
          <div class="small muted">${esc(lv.blurb)} · tolerance ±${lv.tolerance}¢</div></div>
        </div>
        <div class="grid two">
          ${lv.lessons
            .map((l) => {
              const pr = lessonProgress(l.id);
              const unlocked = isUnlocked(l.id);
              const cls = !unlocked ? 'locked' : pr.stars ? 'done' : '';
              return `
              <a class="card lesson-card ${cls}" href="#/lesson/${esc(l.id)}" ${unlocked ? '' : 'aria-disabled="true" tabindex="-1"'}>
                <div class="lesson-ico">${unlocked ? l.icon : '🔒'}</div>
                <div class="lesson-meta"><h3>${esc(l.title)}</h3><p>${esc(l.subtitle)}</p></div>
                <div class="center">${starsHtml(pr.stars)}${pr.best ? `<div class="small dim">best ${pr.best}</div>` : ''}</div>
              </a>`;
            })
            .join('')}
        </div>
      </section>`;
    }).join('')}`;
}
