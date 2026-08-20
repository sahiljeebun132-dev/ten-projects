/**
 * Skycast - app controller.
 *
 * Deliberately stores nothing: recent searches live in a module-scoped array
 * and vanish on reload. No localStorage / sessionStorage anywhere in this app.
 */

import {
  searchCities, fetchForecast, getPosition, coordinateLabel, WeatherError
} from './api.js';
import { describe } from './wmo.js';
import { iconSVG } from './icons.js';
import { hourlyChart, hourlySummary } from './chart.js';
import {
  UNITS, fmtTemp, fmtWind, fmtPrecip, fmtPressure, fmtPercent, fmtUV,
  compass, compassLong, fmtHour, fmtWeekday, fmtDayMonth, tempUnitLetter
} from './units.js';

/* ------------------------------------------------------------------ *
 * DOM references
 * ------------------------------------------------------------------ */
const $ = (sel) => document.querySelector(sel);

const el = {
  sky: $('#sky'),
  form: $('#search-form'),
  input: $('#city-input'),
  clearBtn: $('#clear-btn'),
  suggestions: $('#suggestions'),
  geoBtn: $('#geo-btn'),
  recentsWrap: $('#recents-wrap'),
  recents: $('#recents'),
  live: $('#live-status'),
  errorPanel: $('#error-panel'),
  errorTitle: $('#error-title'),
  errorText: $('#error-text'),
  errorRetry: $('#error-retry'),
  skeleton: $('#skeleton'),
  welcome: $('#welcome'),
  results: $('#results'),
  placeName: $('#place-name'),
  placeMeta: $('#place-meta'),
  updatedAt: $('#updated-at'),
  currentIcon: $('#current-icon'),
  currentTemp: $('#current-temp'),
  currentDesc: $('#current-desc'),
  currentFeels: $('#current-feels'),
  stats: $('#stats'),
  hourly: $('#hourly'),
  hourlyDesc: $('#hourly-desc'),
  daily: $('#daily')
};

/* ------------------------------------------------------------------ *
 * State (in memory only)
 * ------------------------------------------------------------------ */
const state = {
  place: null,     // { name, admin1, country, latitude, longitude }
  data: null,      // raw forecast payload
  recents: [],     // most-recent-first, max 6
  activeIndex: -1, // highlighted suggestion
  options: [],     // current suggestion list
  lastAction: null // replayed by the "Try again" button
};

let suggestController = null;   // aborts in-flight autocomplete
let forecastController = null;  // aborts in-flight forecast
let debounceTimer = 0;

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */
const show = (node) => node.classList.remove('is-hidden');
const hide = (node) => node.classList.add('is-hidden');

function announce(message) {
  // Re-assigning identical text would not re-announce; clear first.
  el.live.textContent = '';
  window.setTimeout(() => { el.live.textContent = message; }, 40);
}

function escapeHTML(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** "Paris, Île-de-France, France" */
function placeLabel(p) {
  return [p.name, p.admin1, p.country].filter(Boolean).join(', ');
}

/* ------------------------------------------------------------------ *
 * View switching
 * ------------------------------------------------------------------ */
function showLoading() {
  hide(el.welcome); hide(el.results); hide(el.errorPanel);
  show(el.skeleton);
  announce('Loading forecast…');
}

function showError(kind, message) {
  hide(el.skeleton); hide(el.welcome); hide(el.results);

  const titles = {
    network: 'No connection',
    notfound: 'City not found',
    geolocation: 'Location unavailable',
    api: 'Weather service error'
  };
  el.errorTitle.textContent = titles[kind] ?? 'Something went wrong';
  el.errorText.textContent = message;

  // Only offer a retry for things that might succeed on a second attempt.
  if (kind === 'notfound' || !state.lastAction) hide(el.errorRetry);
  else show(el.errorRetry);

  show(el.errorPanel);
  el.errorPanel.focus();
  announce(`${el.errorTitle.textContent}. ${message}`);
}

function showResults() {
  hide(el.skeleton); hide(el.welcome); hide(el.errorPanel);
  show(el.results);
}

/* ------------------------------------------------------------------ *
 * Background gradient: day/night + condition group
 * ------------------------------------------------------------------ */
function paintSky(code, isDay) {
  const { group } = describe(code);
  el.sky.dataset.group = group;
  el.sky.dataset.time = isDay ? 'day' : 'night';
  document.body.dataset.group = group;
  document.body.dataset.time = isDay ? 'day' : 'night';
}

/* ------------------------------------------------------------------ *
 * Autocomplete
 * ------------------------------------------------------------------ */
function closeSuggestions() {
  hide(el.suggestions);
  el.suggestions.innerHTML = '';
  el.input.setAttribute('aria-expanded', 'false');
  el.input.removeAttribute('aria-activedescendant');
  state.options = [];
  state.activeIndex = -1;
}

function renderSuggestions(list) {
  state.options = list;
  state.activeIndex = -1;

  if (!list.length) {
    el.suggestions.innerHTML =
      '<li class="suggestion suggestion--empty" role="presentation">No matching cities</li>';
    show(el.suggestions);
    el.input.setAttribute('aria-expanded', 'true');
    return;
  }

  el.suggestions.innerHTML = list.map((p, i) => `
    <li class="suggestion" role="option" id="opt-${i}" aria-selected="false" data-index="${i}">
      <span class="suggestion__name">${escapeHTML(p.name)}</span>
      <span class="suggestion__meta">${escapeHTML([p.admin1, p.country].filter(Boolean).join(', '))}</span>
    </li>`).join('');

  show(el.suggestions);
  el.input.setAttribute('aria-expanded', 'true');
}

function highlight(index) {
  const items = [...el.suggestions.querySelectorAll('[role="option"]')];
  if (!items.length) return;

  const next = (index + items.length) % items.length;
  items.forEach((li, i) => {
    const on = i === next;
    li.classList.toggle('is-active', on);
    li.setAttribute('aria-selected', String(on));
    // Guarded: not every embedding (or older engine) implements scrollIntoView.
    if (on && typeof li.scrollIntoView === 'function') {
      li.scrollIntoView({ block: 'nearest' });
    }
  });

  state.activeIndex = next;
  el.input.setAttribute('aria-activedescendant', `opt-${next}`);
}

async function runSuggest(query) {
  suggestController?.abort();
  suggestController = new AbortController();

  try {
    const results = await searchCities(query, { signal: suggestController.signal });
    renderSuggestions(results);
  } catch (err) {
    if (err?.name === 'AbortError') return;
    // A failing autocomplete should stay quiet; the form submit surfaces errors.
    closeSuggestions();
  }
}

el.input.addEventListener('input', () => {
  const q = el.input.value.trim();
  el.clearBtn.classList.toggle('is-hidden', q === '');

  window.clearTimeout(debounceTimer);
  if (q.length < 2) { closeSuggestions(); return; }
  debounceTimer = window.setTimeout(() => runSuggest(q), 280);
});

el.input.addEventListener('keydown', (e) => {
  const open = !el.suggestions.classList.contains('is-hidden') && state.options.length > 0;

  switch (e.key) {
    case 'ArrowDown':
      if (!open) return;
      e.preventDefault();
      highlight(state.activeIndex + 1);
      break;
    case 'ArrowUp':
      if (!open) return;
      e.preventDefault();
      highlight(state.activeIndex - 1);
      break;
    case 'Enter':
      if (open && state.activeIndex >= 0) {
        e.preventDefault();
        selectPlace(state.options[state.activeIndex]);
      }
      break;
    case 'Escape':
      if (open) { e.preventDefault(); closeSuggestions(); }
      break;
    case 'Tab':
      closeSuggestions();
      break;
    default:
      break;
  }
});

el.suggestions.addEventListener('mousedown', (e) => {
  // mousedown (not click) so the input's blur does not close the list first.
  const li = e.target.closest('[data-index]');
  if (!li) return;
  e.preventDefault();
  selectPlace(state.options[Number(li.dataset.index)]);
});

el.suggestions.addEventListener('mousemove', (e) => {
  const li = e.target.closest('[data-index]');
  if (li) highlight(Number(li.dataset.index));
});

el.input.addEventListener('blur', () => {
  // Delay so a mousedown on an option still registers.
  window.setTimeout(closeSuggestions, 120);
});

el.clearBtn.addEventListener('click', () => {
  el.input.value = '';
  hide(el.clearBtn);
  closeSuggestions();
  el.input.focus();
});

/* Submitting the form picks the highlighted option, else the first match. */
el.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = el.input.value.trim();
  if (q.length < 2) return;

  if (state.activeIndex >= 0 && state.options[state.activeIndex]) {
    selectPlace(state.options[state.activeIndex]);
    return;
  }

  closeSuggestions();
  showLoading();
  state.lastAction = () => el.form.requestSubmit();

  try {
    const results = await searchCities(q);
    if (!results.length) {
      showError('notfound', `No city matching “${q}” was found. Check the spelling, or try a larger nearby city.`);
      return;
    }
    await loadPlace(results[0]);
  } catch (err) {
    handleError(err);
  }
});

/* ------------------------------------------------------------------ *
 * Geolocation
 * ------------------------------------------------------------------ */
el.geoBtn.addEventListener('click', async () => {
  closeSuggestions();
  el.geoBtn.disabled = true;
  showLoading();
  announce('Requesting your location…');
  state.lastAction = () => el.geoBtn.click();

  try {
    const { lat, lon } = await getPosition();
    await loadPlace(coordinateLabel(lat, lon));
  } catch (err) {
    handleError(err);
  } finally {
    el.geoBtn.disabled = false;
  }
});

/* ------------------------------------------------------------------ *
 * Recent searches (in memory only)
 * ------------------------------------------------------------------ */
function rememberPlace(place) {
  const key = (p) => `${p.latitude.toFixed(3)},${p.longitude.toFixed(3)}`;
  state.recents = [place, ...state.recents.filter((p) => key(p) !== key(place))].slice(0, 6);
  renderRecents();
}

function renderRecents() {
  if (!state.recents.length) { hide(el.recentsWrap); return; }

  el.recents.innerHTML = state.recents.map((p, i) => `
    <li>
      <button type="button" class="chip" data-recent="${i}">
        ${escapeHTML(p.name)}${p.country_code ? `<span class="chip__cc">${escapeHTML(p.country_code)}</span>` : ''}
      </button>
    </li>`).join('');
  show(el.recentsWrap);
}

el.recents.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-recent]');
  if (!btn) return;
  const place = state.recents[Number(btn.dataset.recent)];
  if (place) selectPlace(place);
});

/* ------------------------------------------------------------------ *
 * Loading a place
 * ------------------------------------------------------------------ */
function selectPlace(place) {
  if (!place) return;
  el.input.value = place.name;
  el.clearBtn.classList.toggle('is-hidden', !place.name);
  closeSuggestions();
  loadPlace(place);
}

async function loadPlace(place) {
  showLoading();
  state.lastAction = () => loadPlace(place);

  forecastController?.abort();
  forecastController = new AbortController();

  try {
    const data = await fetchForecast(place.latitude, place.longitude, {
      signal: forecastController.signal
    });
    state.place = place;
    state.data = data;
    rememberPlace(place);
    render();
  } catch (err) {
    if (err?.name === 'AbortError') return;
    handleError(err);
  }
}

function handleError(err) {
  if (err instanceof WeatherError) {
    showError(err.kind, err.message);
  } else {
    showError('network', 'An unexpected error occurred. Please try again.');
    // Surface genuinely unexpected problems for debugging without breaking the UI.
    console.warn('Skycast:', err);
  }
}

el.errorRetry.addEventListener('click', () => {
  if (state.lastAction) state.lastAction();
});

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

/**
 * Open-Meteo timestamps are local to the queried location and share one
 * format, so plain string comparison orders them correctly.
 */
function isDayAt(timestamp, daily) {
  const day = timestamp.slice(0, 10);
  const idx = daily.time.indexOf(day);
  if (idx === -1) return true;
  const sunrise = daily.sunrise?.[idx];
  const sunset = daily.sunset?.[idx];
  if (!sunrise || !sunset) return true;
  return timestamp >= sunrise && timestamp < sunset;
}

/** The 24 hours starting at the current hour. */
function next24(data) {
  const { hourly, current, daily } = data;
  const nowKey = (current?.time ?? '').slice(0, 13); // "YYYY-MM-DDTHH"
  let start = hourly.time.findIndex((t) => t.slice(0, 13) >= nowKey);
  if (start === -1) start = 0;

  const end = Math.min(start + 24, hourly.time.length);
  const slice = (arr) => (Array.isArray(arr) ? arr.slice(start, end) : []);

  const hours = {
    time: slice(hourly.time),
    temperature_2m: slice(hourly.temperature_2m),
    precipitation_probability: slice(hourly.precipitation_probability),
    weather_code: slice(hourly.weather_code)
  };
  const flags = hours.time.map((t) => isDayAt(t, daily));
  return { hours, flags };
}

function render() {
  const { data, place } = state;
  if (!data || !place) return;

  const cur = data.current;
  const info = describe(cur.weather_code);
  const isDay = cur.is_day === 1 || cur.is_day === true;

  paintSky(cur.weather_code, isDay);

  /* --- header --- */
  el.placeName.textContent = place.name;
  el.placeMeta.textContent = [place.admin1, place.country].filter(Boolean).join(', ');
  el.updatedAt.textContent = `Updated ${fmtHour(cur.time)} local time`;

  /* --- current conditions --- */
  el.currentIcon.innerHTML = iconSVG(info.icon, isDay, 110, info.label);
  el.currentTemp.innerHTML =
    `${fmtTemp(cur.temperature_2m)}<span class="current__unit">${tempUnitLetter()}</span>`;
  el.currentDesc.textContent = info.label;
  el.currentFeels.textContent = `Feels like ${fmtTemp(cur.apparent_temperature, { withUnit: true })}`;

  const daily = data.daily;
  const dirAbbr = compass(cur.wind_direction_10m);
  const stats = [
    {
      label: 'Feels like', value: fmtTemp(cur.apparent_temperature, { withUnit: true }),
      icon: 'thermometer'
    },
    { label: 'Humidity', value: fmtPercent(cur.relative_humidity_2m), icon: 'drop' },
    {
      label: 'Wind',
      value: `${fmtWind(cur.wind_speed_10m)}${dirAbbr ? ` ${dirAbbr}` : ''}`,
      sr: `${fmtWind(cur.wind_speed_10m)} from the ${compassLong(cur.wind_direction_10m)}`,
      icon: 'wind'
    },
    { label: 'Pressure', value: fmtPressure(cur.surface_pressure), icon: 'gauge' },
    { label: 'Precipitation', value: fmtPrecip(cur.precipitation), icon: 'drop' },
    { label: 'UV index', value: fmtUV(daily.uv_index_max?.[0]), icon: 'uv' },
    { label: 'Sunrise', value: fmtHour(daily.sunrise?.[0]), icon: 'sunrise' },
    { label: 'Sunset', value: fmtHour(daily.sunset?.[0]), icon: 'sunset' }
  ];

  el.stats.innerHTML = stats.map((s) => `
    <div class="stat">
      <dt class="stat__label">${statIcon(s.icon)}<span>${escapeHTML(s.label)}</span></dt>
      <dd class="stat__value"${s.sr ? ` aria-label="${escapeHTML(s.sr)}"` : ''}>${escapeHTML(s.value)}</dd>
    </div>`).join('');

  /* --- hourly --- */
  const { hours, flags } = next24(data);
  // Keep the screen-reader paragraph; replace only the chart.
  el.hourly.innerHTML = hourlyChart(hours, flags);
  el.hourly.append(el.hourlyDesc);
  el.hourlyDesc.textContent = hourlySummary(hours);

  /* --- daily --- */
  el.daily.innerHTML = daily.time.map((day, i) => {
    const d = describe(daily.weather_code?.[i]);
    const hi = fmtTemp(daily.temperature_2m_max?.[i]);
    const lo = fmtTemp(daily.temperature_2m_min?.[i]);
    const rain = daily.precipitation_sum?.[i];
    const name = i === 0 ? 'Today' : fmtWeekday(day);

    return `
      <li class="day">
        <p class="day__name"><abbr title="${escapeHTML(fmtWeekday(day, { long: true }))}">${escapeHTML(name)}</abbr>
          <span class="day__date">${escapeHTML(fmtDayMonth(day))}</span></p>
        <span class="day__icon">${iconSVG(d.icon, true, 44, d.label)}</span>
        <p class="day__desc">${escapeHTML(d.label)}</p>
        <p class="day__temps">
          <span class="day__hi">${escapeHTML(hi)}</span>
          <span class="day__lo">${escapeHTML(lo)}</span>
        </p>
        <p class="day__rain ${typeof rain === 'number' && rain > 0 ? '' : 'is-dry'}">
          ${statIcon('drop')}<span>${escapeHTML(fmtPrecip(rain))}</span>
        </p>
      </li>`;
  }).join('');

  showResults();
  announce(
    `Weather for ${placeLabel(place)}: ${fmtTemp(cur.temperature_2m, { withUnit: true })}, ${info.label}. ` +
    `High ${fmtTemp(daily.temperature_2m_max?.[0], { withUnit: true })}, ` +
    `low ${fmtTemp(daily.temperature_2m_min?.[0], { withUnit: true })}.`
  );
}

/* Tiny inline glyphs for the stat rows. */
function statIcon(kind) {
  const paths = {
    thermometer: '<path d="M10 13.5V4a2 2 0 1 1 4 0v9.5a4 4 0 1 1-4 0Z"/>',
    drop: '<path d="M12 3.5s5.5 6 5.5 9.5a5.5 5.5 0 1 1-11 0C6.5 9.5 12 3.5 12 3.5Z"/>',
    wind: '<path d="M3 8h9a3 3 0 1 0-3-3"/><path d="M3 12h13a3 3 0 1 1-3 3"/><path d="M3 16h7"/>',
    gauge: '<path d="M4 18a8 8 0 1 1 16 0"/><path d="m12 18 4-6"/>',
    uv: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4"/>',
    sunrise: '<path d="M4 18h16"/><path d="M8 14a4 4 0 0 1 8 0"/><path d="M12 4v4"/><path d="m8.5 8.5-1-1"/><path d="m15.5 8.5 1-1"/>',
    sunset: '<path d="M4 18h16"/><path d="M8 14a4 4 0 0 1 8 0"/><path d="M12 8V4"/><path d="m9 5 3 3 3-3"/>'
  };
  return `<svg class="stat__icon" viewBox="0 0 24 24" width="17" height="17" fill="none"
    stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true" focusable="false">${paths[kind] ?? paths.drop}</svg>`;
}

/* ------------------------------------------------------------------ *
 * Unit toggles - convert in place, no refetch
 * ------------------------------------------------------------------ */
function wireToggle(attr, key) {
  const buttons = [...document.querySelectorAll(`[${attr}]`)];

  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const value = btn.getAttribute(attr);
      if (UNITS[key] === value) return;

      UNITS[key] = value;
      buttons.forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));

      if (state.data) render();
      announce(key === 'temp'
        ? `Temperature units changed to ${value === 'f' ? 'Fahrenheit' : 'Celsius'}.`
        : `Wind units changed to ${value === 'mph' ? 'miles per hour' : 'kilometres per hour'}.`);
    });
  });
}

wireToggle('data-unit-temp', 'temp');
wireToggle('data-unit-wind', 'wind');

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */
paintSky(0, true);
el.input.focus({ preventScroll: true });
