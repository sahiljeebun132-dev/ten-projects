// Build a practice run and open the practice screen.
import { handoff } from './engine.js';
import { state as store, riyaazSa, riyaazRange, practiceRange, styleById } from './store.js';
import { riyaazPractice, stageOf, today, exerciseById } from './data/riyaaz.js';
import { styleDrills } from './audio/style.js';

let n = 0;

/** Open the practice screen (a fresh hash each time so re-running from practice works). */
export function goPractice(practice) {
  handoff.practice = practice;
  location.hash = `#/practice/${++n}`;
}

function daySeed() {
  return [...today()].reduce((s, c) => s * 31 + c.charCodeAt(0), 7) % 233280;
}

export function riyaazHandoff(id) {
  const sa = riyaazSa();
  if (sa == null) return null;
  return {
    ...riyaazPractice(id, { sa, ...riyaazRange(sa), stage: store.riyaaz.stage, voice: store.voice, seed: daySeed() }),
    backHref: '#/riyaaz',
  };
}

/** The next exercise in today's plan after `afterId` that isn't done yet. */
export function nextRiyaaz(afterId = null) {
  const plan = stageOf(store.riyaaz.stage).plan;
  const done = store.riyaaz.days[today()]?.done || {};
  const start = afterId ? plan.indexOf(afterId) + 1 : 0;
  const id = [...plan.slice(start), ...plan.slice(0, start)].find((x) => !(x in done) && x !== afterId);
  return id ? exerciseById(id) : null;
}

export function styleDrillHandoff(styleId, drillId) {
  const style = styleById(styleId);
  if (!style) return null;
  const drill = styleDrills(style.profile, practiceRange(), style.singer).find((d) => d.id === drillId);
  if (!drill) return null;
  return {
    title: `${drill.icon} ${drill.title}`,
    subtitle: `${style.singer} style — ${drill.subtitle}`,
    targets: drill.targets,
    tolerance: drill.tolerance,
    bpm: drill.bpm,
    focus: drill.focus,
    guideOnSing: drill.guideOnSing,
    style: { id: style.id, singer: style.singer },
    styleDrill: drill.id,
    backHref: '#/teacher',
  };
}
