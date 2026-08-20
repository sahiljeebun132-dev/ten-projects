/**
 * Unit conversion + formatting.
 *
 * The app always fetches and stores metric values (°C, km/h, mm, hPa) and
 * converts at render time, so toggling units never triggers a network request.
 */

export const UNITS = {
  temp: 'c',   // 'c' | 'f'
  wind: 'kmh'  // 'kmh' | 'mph'
};

export const cToF = (c) => (c * 9) / 5 + 32;
export const kmhToMph = (k) => k * 0.621371;
export const mmToIn = (mm) => mm / 25.4;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Temperature with degree sign, e.g. "17°" or "63°". */
export function fmtTemp(celsius, { withUnit = false } = {}) {
  if (!isNum(celsius)) return '--';
  const v = UNITS.temp === 'f' ? cToF(celsius) : celsius;
  const label = UNITS.temp === 'f' ? 'F' : 'C';
  return `${Math.round(v)}°${withUnit ? label : ''}`;
}

/** Bare rounded number in the active temperature unit (for SVG labels). */
export function tempValue(celsius) {
  if (!isNum(celsius)) return null;
  return Math.round(UNITS.temp === 'f' ? cToF(celsius) : celsius);
}

export function tempUnitLabel() {
  return UNITS.temp === 'f' ? '°F' : '°C';
}

/** Just the letter, for use next to a value that already carries the ° sign. */
export function tempUnitLetter() {
  return UNITS.temp === 'f' ? 'F' : 'C';
}

/** Wind speed, e.g. "12 km/h". */
export function fmtWind(kmh) {
  if (!isNum(kmh)) return '--';
  const v = UNITS.wind === 'mph' ? kmhToMph(kmh) : kmh;
  return `${Math.round(v)} ${windUnitLabel()}`;
}

export function windUnitLabel() {
  return UNITS.wind === 'mph' ? 'mph' : 'km/h';
}

/**
 * Precipitation. Metric stays in mm; imperial wind implies imperial
 * precipitation, so it switches to inches with 2 decimals.
 */
export function fmtPrecip(mm) {
  if (!isNum(mm)) return '--';
  if (UNITS.wind === 'mph') {
    const inches = mmToIn(mm);
    return `${inches < 0.01 && inches > 0 ? '<0.01' : inches.toFixed(2)} in`;
  }
  return `${mm.toFixed(1)} mm`;
}

export function fmtPressure(hPa) {
  return isNum(hPa) ? `${Math.round(hPa)} hPa` : '--';
}

export function fmtPercent(p) {
  return isNum(p) ? `${Math.round(p)}%` : '--';
}

export function fmtUV(uv) {
  if (!isNum(uv)) return '--';
  return `${Math.round(uv * 10) / 10} (${uvLabel(uv)})`;
}

export function uvLabel(uv) {
  if (uv < 3) return 'Low';
  if (uv < 6) return 'Moderate';
  if (uv < 8) return 'High';
  if (uv < 11) return 'Very high';
  return 'Extreme';
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** Meteorological degrees -> 16-point compass abbreviation. */
export function compass(deg) {
  if (!isNum(deg)) return '';
  const idx = Math.round(((deg % 360) + 360) % 360 / 22.5) % 16;
  return COMPASS[idx];
}

const COMPASS_LONG = {
  N: 'north', NNE: 'north-northeast', NE: 'northeast', ENE: 'east-northeast',
  E: 'east', ESE: 'east-southeast', SE: 'southeast', SSE: 'south-southeast',
  S: 'south', SSW: 'south-southwest', SW: 'southwest', WSW: 'west-southwest',
  W: 'west', WNW: 'west-northwest', NW: 'northwest', NNW: 'north-northwest'
};

export function compassLong(deg) {
  return COMPASS_LONG[compass(deg)] ?? '';
}

/* ---------- date/time helpers ---------------------------------------- */

/**
 * Open-Meteo returns local-to-the-location timestamps without a zone suffix
 * ("2026-08-20T14:00"). Parsing them with `new Date()` would apply the
 * browser's zone, so we parse the parts by hand and format from those.
 */
export function parseLocal(ts) {
  if (typeof ts !== 'string') return null;
  const m = ts.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
  if (!m) return null;
  const [, y, mo, d, h = '0', mi = '0'] = m;
  return {
    year: +y, month: +mo, day: +d, hour: +h, minute: +mi,
    // A Date in UTC purely so we can ask it for the weekday name.
    date: new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi))
  };
}

/** "14:00" or "2 PM" depending on locale preference; we use 24h-free format. */
export function fmtHour(ts) {
  const p = parseLocal(ts);
  if (!p) return '--';
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric', minute: '2-digit', timeZone: 'UTC'
  }).format(p.date);
}

/** Just the hour, compact, for the chart axis: "14" / "2 PM". */
export function fmtHourShort(ts) {
  const p = parseLocal(ts);
  if (!p) return '--';
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', timeZone: 'UTC' })
    .format(p.date);
}

export function fmtWeekday(ts, { long = false } = {}) {
  const p = parseLocal(ts);
  if (!p) return '--';
  return new Intl.DateTimeFormat(undefined, {
    weekday: long ? 'long' : 'short', timeZone: 'UTC'
  }).format(p.date);
}

export function fmtDayMonth(ts) {
  const p = parseLocal(ts);
  if (!p) return '';
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric', month: 'short', timeZone: 'UTC'
  }).format(p.date);
}
