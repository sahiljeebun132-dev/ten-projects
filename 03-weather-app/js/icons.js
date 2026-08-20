/**
 * Hand-written inline SVG weather icons. No external images, no icon font.
 * Every icon draws on a 64x64 viewBox and inherits colour from CSS custom
 * properties so the same markup works on light and dark backgrounds.
 */

const SUN = (cx = 26, cy = 24, r = 11) => `
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="var(--sun)"/>
  <g stroke="var(--sun)" stroke-width="3" stroke-linecap="round">
    <path d="M${cx} ${cy - r - 8}v5"/>
    <path d="M${cx} ${cy + r + 3}v5"/>
    <path d="M${cx - r - 8} ${cy}h5"/>
    <path d="M${cx + r + 3} ${cy}h5"/>
    <path d="M${cx - r - 6} ${cy - r - 6}l3.5 3.5"/>
    <path d="M${cx + r + 2.5} ${cy + r + 2.5}l3.5 3.5"/>
    <path d="M${cx + r + 6} ${cy - r - 6}l-3.5 3.5"/>
    <path d="M${cx - r - 2.5} ${cy + r + 2.5}l-3.5 3.5"/>
  </g>`;

const MOON = (cx = 26, cy = 24) => `
  <path d="M${cx + 8} ${cy + 5}A12 12 0 0 1 ${cx - 6} ${cy - 9} 12.5 12.5 0 1 0 ${cx + 8} ${cy + 5}Z"
        fill="var(--moon)"/>`;

/* Main cloud body, parametrised by vertical offset and fill. */
const CLOUD_AT = (dy = 0, fill = 'var(--cloud)') => `
  <g transform="translate(0 ${dy})">
    <path d="M44 44H21.5A9.75 9.75 0 0 1 20 24.6 13.2 13.2 0 0 1 45.4 28.4 8 8 0 0 1 44 44Z" fill="${fill}"/>
  </g>`;

const rainDrops = (xs, dy = 0) => xs.map((x, i) => `
  <path d="M${x} ${48 + dy + (i % 2) * 3}v6" stroke="var(--rain)" stroke-width="3.4"
        stroke-linecap="round"/>`).join('');

const snowFlakes = (xs, dy = 0) => xs.map((x, i) => {
  const y = 52 + dy + (i % 2) * 4;
  return `<g stroke="var(--snow)" stroke-width="2.6" stroke-linecap="round">
      <path d="M${x} ${y - 3.5}v7"/>
      <path d="M${x - 3.2} ${y - 1.8}l6.4 3.6"/>
      <path d="M${x - 3.2} ${y + 1.8}l6.4-3.6"/>
    </g>`;
}).join('');

export const ICONS = {
  /* Full sun */
  clear: () => `${SUN(32, 30, 13)}`,

  /* Full moon */
  clearNight: () => `${MOON(32, 30)}`,

  /* Sun with a small cloud (mainly clear) */
  mostly: () => `${SUN(24, 22, 10)}${CLOUD_AT(6)}`,
  mostlyNight: () => `${MOON(24, 22)}${CLOUD_AT(6)}`,

  /* Sun/moon peeking behind a cloud */
  partly: () => `${SUN(23, 21, 9.5)}${CLOUD_AT(7)}`,
  partlyNight: () => `${MOON(23, 21)}${CLOUD_AT(7)}`,

  /* Solid overcast: back cloud + front cloud */
  cloud: () => `
    ${CLOUD_AT(-6, 'var(--cloud-dim)')}
    ${CLOUD_AT(4)}`,

  /* Fog: cloud with horizontal bars beneath */
  fog: () => `
    ${CLOUD_AT(-3)}
    <g stroke="var(--fog)" stroke-width="3.4" stroke-linecap="round">
      <path d="M14 50h36"/><path d="M19 57h27"/>
    </g>`,

  /* Light dashes */
  drizzle: () => `${CLOUD_AT(-4)}${rainDrops([24, 32, 40], -4)}`,

  /* Heavier, longer dashes */
  rain: () => `
    ${CLOUD_AT(-5)}
    <g stroke="var(--rain)" stroke-width="3.6" stroke-linecap="round">
      <path d="M22 44l-2.5 10"/><path d="M31 44l-2.5 12"/><path d="M40 44l-2.5 10"/>
    </g>`,

  /* Sun behind a shower */
  showers: () => `
    ${SUN(22, 18, 8.5)}
    ${CLOUD_AT(-1)}
    <g stroke="var(--rain)" stroke-width="3.4" stroke-linecap="round">
      <path d="M26 49l-2 8"/><path d="M35 49l-2 8"/>
    </g>`,

  /* Snow */
  snow: () => `${CLOUD_AT(-6)}${snowFlakes([23, 32, 41], -6)}`,

  /* Mixed rain + sleet */
  sleet: () => `
    ${CLOUD_AT(-6)}
    <g stroke="var(--rain)" stroke-width="3.4" stroke-linecap="round">
      <path d="M23 42l-2 8"/><path d="M40 42l-2 8"/>
    </g>
    ${snowFlakes([32], -8)}`,

  /* Thunderstorm: cloud + lightning bolt */
  thunder: () => `
    ${CLOUD_AT(-6, 'var(--cloud-dim)')}
    <path d="M34 39l-11 14h7l-3 11 12-15h-7l2-10Z" fill="var(--bolt)"/>`
};

/**
 * Render an icon to an SVG string.
 * @param {string} key   ICONS key (from the WMO table)
 * @param {boolean} isDay
 * @param {number} size  px
 * @param {string} title accessible name; omit for decorative use
 */
export function iconSVG(key, isDay = true, size = 64, title = '') {
  // Swap in the night variant when one exists and it is dark out.
  const nightKey = `${key}Night`;
  const chosen = !isDay && nightKey in ICONS ? nightKey : key;
  const draw = ICONS[chosen] ?? ICONS.cloud;

  const a11y = title
    ? `role="img" aria-label="${escapeAttr(title)}"`
    : 'aria-hidden="true"';

  return `<svg viewBox="0 0 64 64" width="${size}" height="${size}" ${a11y} focusable="false"
    class="wicon wicon--${chosen}">${draw()}</svg>`;
}

function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export { CLOUD_AT };
