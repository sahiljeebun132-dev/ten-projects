/**
 * Hourly strip: a temperature line + precipitation-probability bars, drawn as
 * inline SVG by hand. No chart library.
 *
 * The chart is horizontally scrollable: each hour gets a fixed column width so
 * 24 hours stay readable on a phone, and the SVG grows wider than its container.
 */

import { iconSVG } from './icons.js';
import { describe } from './wmo.js';
import { fmtHourShort, tempValue, tempUnitLabel } from './units.js';

const COL = 62;        // px per hour column
const PAD_TOP = 34;    // room for the temperature labels above the line
const LINE_H = 96;     // vertical space the temperature line may use
const GAP = 10;        // space between line area and bars
const BAR_H = 54;      // max bar height
const AXIS_H = 40;     // hour labels + icons
const HEIGHT = PAD_TOP + LINE_H + GAP + BAR_H + AXIS_H;

/**
 * @param {{time:string[],temperature_2m:number[],precipitation_probability:number[],weather_code:number[]}} hours
 * @param {boolean[]} isDayFlags per-hour day/night, for icon selection
 * @returns {string} SVG markup
 */
export function hourlyChart(hours, isDayFlags = []) {
  const n = hours.time.length;
  if (!n) return '<p class="empty">Hourly data is unavailable for this location.</p>';

  const width = n * COL;
  const temps = hours.temperature_2m.map(tempValue);
  const valid = temps.filter((t) => t !== null);

  // Pad the range so a flat line does not sit on the floor of the chart.
  let min = Math.min(...valid);
  let max = Math.max(...valid);
  if (!Number.isFinite(min) || !Number.isFinite(max)) { min = 0; max = 1; }
  if (max - min < 3) { const mid = (max + min) / 2; min = mid - 1.5; max = mid + 1.5; }
  const span = max - min;

  const x = (i) => i * COL + COL / 2;
  const y = (t) => PAD_TOP + LINE_H - ((t - min) / span) * LINE_H;

  const barTop = PAD_TOP + LINE_H + GAP;
  const axisY = barTop + BAR_H;

  /* ---- temperature line + area fill ---- */
  const pts = temps.map((t, i) => (t === null ? null : [x(i), y(t)])).filter(Boolean);
  const linePath = pts.map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${px.toFixed(1)} ${py.toFixed(1)}`).join(' ');
  const areaPath = pts.length
    ? `${linePath} L${pts[pts.length - 1][0].toFixed(1)} ${barTop} L${pts[0][0].toFixed(1)} ${barTop} Z`
    : '';

  /* ---- precipitation bars ---- */
  const bars = (hours.precipitation_probability ?? []).map((p, i) => {
    const pct = typeof p === 'number' && Number.isFinite(p) ? Math.max(0, Math.min(100, p)) : 0;
    const h = (pct / 100) * BAR_H;
    const bw = 20;
    if (h < 1) return '';
    return `<rect class="chart__bar" x="${(x(i) - bw / 2).toFixed(1)}" y="${(axisY - h).toFixed(1)}"
      width="${bw}" height="${h.toFixed(1)}" rx="4"><title>${pct}% chance of rain</title></rect>`;
  }).join('');

  /* ---- per-hour labels, dots, icons ---- */
  const marks = temps.map((t, i) => {
    const code = hours.weather_code?.[i];
    const info = describe(code);
    const isDay = isDayFlags[i] ?? true;
    const label = t === null ? '--' : `${t}°`;
    const pct = hours.precipitation_probability?.[i];

    const dot = t === null ? '' :
      `<circle class="chart__dot" cx="${x(i).toFixed(1)}" cy="${y(t).toFixed(1)}" r="3.5"/>`;

    const tempLabel = t === null ? '' :
      `<text class="chart__temp" x="${x(i).toFixed(1)}" y="${(y(t) - 12).toFixed(1)}"
        text-anchor="middle">${label}</text>`;

    const pctLabel = typeof pct === 'number' && pct >= 15
      ? `<text class="chart__pct" x="${x(i).toFixed(1)}" y="${(axisY - 6).toFixed(1)}"
          text-anchor="middle">${Math.round(pct)}%</text>`
      : '';

    const icon = `<g transform="translate(${(x(i) - 13).toFixed(1)} ${axisY + 4})">
        ${iconSVG(info.icon, isDay, 26)}
      </g>`;

    const hourLabel = `<text class="chart__hour" x="${x(i).toFixed(1)}" y="${axisY + 38}"
        text-anchor="middle">${fmtHourShort(hours.time[i])}</text>`;

    // A transparent hit area gives every column a native tooltip.
    const hit = `<rect x="${i * COL}" y="0" width="${COL}" height="${HEIGHT}" fill="transparent">
        <title>${fmtHourShort(hours.time[i])} — ${label}${tempUnitLabel()}, ${info.label}${
          typeof pct === 'number' ? `, ${Math.round(pct)}% chance of rain` : ''
        }</title>
      </rect>`;

    return dot + tempLabel + pctLabel + icon + hourLabel + hit;
  }).join('');

  return `
  <svg class="chart" viewBox="0 0 ${width} ${HEIGHT}" width="${width}" height="${HEIGHT}"
       role="img" aria-label="Temperature line and chance-of-rain bars for the next ${n} hours"
       preserveAspectRatio="xMinYMin meet" focusable="false">
    <defs>
      <linearGradient id="tempFill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--line)" stop-opacity=".38"/>
        <stop offset="100%" stop-color="var(--line)" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <line class="chart__axis" x1="0" y1="${axisY}" x2="${width}" y2="${axisY}"/>
    ${areaPath ? `<path class="chart__area" d="${areaPath}" fill="url(#tempFill)"/>` : ''}
    ${bars}
    ${linePath ? `<path class="chart__line" d="${linePath}"/>` : ''}
    ${marks}
  </svg>`;
}

/** Plain-text equivalent of the chart, announced to screen readers. */
export function hourlySummary(hours) {
  const n = hours.time.length;
  if (!n) return 'Hourly forecast unavailable.';
  const temps = hours.temperature_2m.map(tempValue).filter((t) => t !== null);
  if (!temps.length) return 'Hourly forecast unavailable.';

  const lo = Math.min(...temps);
  const hi = Math.max(...temps);
  const probs = (hours.precipitation_probability ?? []).filter((p) => typeof p === 'number');
  const peak = probs.length ? Math.max(...probs) : 0;
  const u = tempUnitLabel();

  return `Over the next ${n} hours temperatures range from ${lo}${u} to ${hi}${u}. ` +
    `Peak chance of precipitation is ${Math.round(peak)} percent.`;
}
