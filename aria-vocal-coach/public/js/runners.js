// Build a practice run and open the practice screen.
import { handoff } from './engine.js';
import { state as store, riyaazSa, riyaazRange, practiceRange, styleById, isUnlocked } from './store.js';
import { riyaazPractice, stageOf, today, exerciseById } from './data/riyaaz.js';
import { lessonById, lessonPractice } from './data/curriculum.js';
import { styleDrills } from './audio/style.js';
import { toast } from './ui/dom.js';

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

/**
 * The practice run for an exercise the teacher picked ({ kind, id, styleId }).
 * Returns { practice }, or { error } explaining (for the teacher) why it can't run for this student.
 */
export function practiceFor({ kind, id, styleId }) {
  if (kind === 'riyaaz') {
    const ex = exerciseById(id);
    if (!ex) return { error: `There is no riyaaz exercise "${id}".` };
    if (riyaazSa() == null) return { error: 'The student has no Sa yet, so riyaaz exercises can’t run. Use a lesson instead.' };
    if (ex.stage > store.riyaaz.stage) return { error: `${ex.title} unlocks at riyaaz stage ${ex.stage}; the student is at stage ${store.riyaaz.stage}.` };
    return { practice: riyaazHandoff(id) };
  }
  if (kind === 'lesson') {
    const lesson = lessonById(id);
    if (!lesson || lesson.kind === 'range') return { error: `There is no lesson "${id}" that can run inside a lesson.` };
    if (!isUnlocked(id)) return { error: `${lesson.title} is still locked for this student.` };
    return { practice: { ...lessonPractice(lesson, practiceRange()), title: `${lesson.icon} ${lesson.title}`, subtitle: lesson.subtitle, lessonId: id } };
  }
  if (kind === 'drill') {
    const practice = styleDrillHandoff(styleId, id);
    return practice ? { practice } : { error: 'That style drill isn’t available — the style may have been deleted.' };
  }
  return { error: 'Unknown kind of exercise.' };
}

/** Open an exercise from a teacher's button (chat reply or lesson homework), explaining locks. */
export function openExercise({ kind, id, styleId }) {
  if (kind === 'lesson') {
    if (!isUnlocked(id)) return toast('That lesson unlocks after the ones before it on the Learn path.', 'info');
    location.hash = `#/lesson/${id}`;
  } else if (kind === 'riyaaz') {
    const ex = exerciseById(id);
    if (riyaazSa() == null) {
      toast('First set your Sa on the Riyaaz page.', 'info');
      location.hash = '#/riyaaz';
    } else if (ex && ex.stage > store.riyaaz.stage) {
      toast(`${ex.title} unlocks at riyaaz stage ${ex.stage}.`, 'info');
    } else {
      const h = riyaazHandoff(id);
      if (h) goPractice(h);
    }
  } else if (kind === 'drill') {
    const h = styleDrillHandoff(styleId, id);
    if (h) goPractice(h);
  }
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
