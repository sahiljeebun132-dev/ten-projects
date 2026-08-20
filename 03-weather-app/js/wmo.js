/**
 * WMO 4677 present-weather codes, as subset-published by Open-Meteo.
 * https://open-meteo.com/en/docs  ->  "Weather variable documentation"
 *
 * Every code the forecast API can return is listed here. Each entry carries:
 *   label  - human description
 *   icon   - key into ICONS (js/icons.js)
 *   group  - coarse bucket used to pick the page background gradient
 */
export const WMO = {
  0:  { label: 'Clear sky',                     icon: 'clear',    group: 'clear' },
  1:  { label: 'Mainly clear',                  icon: 'mostly',   group: 'clear' },
  2:  { label: 'Partly cloudy',                 icon: 'partly',   group: 'cloud' },
  3:  { label: 'Overcast',                      icon: 'cloud',    group: 'cloud' },

  45: { label: 'Fog',                           icon: 'fog',      group: 'fog' },
  48: { label: 'Depositing rime fog',           icon: 'fog',      group: 'fog' },

  51: { label: 'Light drizzle',                 icon: 'drizzle',  group: 'rain' },
  53: { label: 'Moderate drizzle',              icon: 'drizzle',  group: 'rain' },
  55: { label: 'Dense drizzle',                 icon: 'drizzle',  group: 'rain' },

  56: { label: 'Light freezing drizzle',        icon: 'sleet',    group: 'rain' },
  57: { label: 'Dense freezing drizzle',        icon: 'sleet',    group: 'rain' },

  61: { label: 'Slight rain',                   icon: 'rain',     group: 'rain' },
  63: { label: 'Moderate rain',                 icon: 'rain',     group: 'rain' },
  65: { label: 'Heavy rain',                    icon: 'rain',     group: 'rain' },

  66: { label: 'Light freezing rain',           icon: 'sleet',    group: 'rain' },
  67: { label: 'Heavy freezing rain',           icon: 'sleet',    group: 'rain' },

  71: { label: 'Slight snow fall',              icon: 'snow',     group: 'snow' },
  73: { label: 'Moderate snow fall',            icon: 'snow',     group: 'snow' },
  75: { label: 'Heavy snow fall',               icon: 'snow',     group: 'snow' },
  77: { label: 'Snow grains',                   icon: 'snow',     group: 'snow' },

  80: { label: 'Slight rain showers',           icon: 'showers',  group: 'rain' },
  81: { label: 'Moderate rain showers',         icon: 'showers',  group: 'rain' },
  82: { label: 'Violent rain showers',          icon: 'showers',  group: 'rain' },

  85: { label: 'Slight snow showers',           icon: 'snow',     group: 'snow' },
  86: { label: 'Heavy snow showers',            icon: 'snow',     group: 'snow' },

  95: { label: 'Thunderstorm',                  icon: 'thunder',  group: 'storm' },
  96: { label: 'Thunderstorm with slight hail', icon: 'thunder',  group: 'storm' },
  99: { label: 'Thunderstorm with heavy hail',  icon: 'thunder',  group: 'storm' }
};

const UNKNOWN = { label: 'Unknown conditions', icon: 'cloud', group: 'cloud' };

/** Look up a code, never throwing on an unexpected value. */
export function describe(code) {
  return WMO[code] ?? UNKNOWN;
}
