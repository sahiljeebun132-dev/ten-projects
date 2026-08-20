/**
 * Open-Meteo API layer. Both endpoints are free and need no API key.
 *   Geocoding: https://open-meteo.com/en/docs/geocoding-api
 *   Forecast:  https://open-meteo.com/en/docs
 */

const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

/** Variables requested from the forecast endpoint (metric; converted client-side). */
export const CURRENT_VARS = [
  'temperature_2m',
  'relative_humidity_2m',
  'apparent_temperature',
  'is_day',
  'precipitation',
  'weather_code',
  'wind_speed_10m',
  'wind_direction_10m',
  'surface_pressure'
];

export const HOURLY_VARS = [
  'temperature_2m',
  'precipitation_probability',
  'weather_code'
];

export const DAILY_VARS = [
  'weather_code',
  'temperature_2m_max',
  'temperature_2m_min',
  'sunrise',
  'sunset',
  'precipitation_sum',
  'wind_speed_10m_max',
  'uv_index_max'
];

/** Error carrying a machine-readable kind so the UI can pick the right message. */
export class WeatherError extends Error {
  constructor(kind, message, { cause } = {}) {
    super(message);
    this.name = 'WeatherError';
    this.kind = kind; // 'network' | 'notfound' | 'api' | 'geolocation'
    if (cause) this.cause = cause;
  }
}

async function getJSON(url, { signal } = {}) {
  let res;
  try {
    res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new WeatherError('network', 'Could not reach the weather service.', { cause: err });
  }

  if (!res.ok) {
    // Open-Meteo returns {error:true, reason:"..."} with a 4xx on bad params.
    let reason = `Request failed (HTTP ${res.status}).`;
    try {
      const body = await res.json();
      if (body?.reason) reason = body.reason;
    } catch { /* body was not JSON; keep the generic message */ }
    throw new WeatherError('api', reason);
  }

  const data = await res.json();
  if (data?.error) throw new WeatherError('api', data.reason || 'The weather service returned an error.');
  return data;
}

/**
 * City search. Returns [] when nothing matches (Open-Meteo omits `results`).
 * @returns {Promise<Array<{id,name,latitude,longitude,country,country_code,admin1,timezone}>>}
 */
export async function searchCities(query, { signal, count = 5 } = {}) {
  const q = query.trim();
  if (q.length < 2) return [];

  const url = `${GEO_URL}?name=${encodeURIComponent(q)}&count=${count}&language=en&format=json`;
  const data = await getJSON(url, { signal });
  return Array.isArray(data.results) ? data.results : [];
}

/**
 * Open-Meteo's geocoding API is forward-only (no reverse lookup), so a raw
 * coordinate pair is labelled with formatted degrees instead of a place name.
 */
export function coordinateLabel(lat, lon) {
  const ns = `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'}`;
  const ew = `${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`;
  return {
    name: `${ns}, ${ew}`,
    latitude: lat,
    longitude: lon,
    country: 'Your location',
    admin1: ''
  };
}

/** Full forecast bundle for a coordinate. */
export async function fetchForecast(lat, lon, { signal } = {}) {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: CURRENT_VARS.join(','),
    hourly: HOURLY_VARS.join(','),
    daily: DAILY_VARS.join(','),
    timezone: 'auto',
    forecast_days: '7'
  });

  const data = await getJSON(`${FORECAST_URL}?${params}`, { signal });

  if (!data?.current || !data?.hourly || !data?.daily) {
    throw new WeatherError('api', 'The forecast response was missing expected fields.');
  }
  return data;
}

/** Promise wrapper around navigator.geolocation with typed failures. */
export function getPosition({ timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new WeatherError('geolocation', 'This browser does not support location access.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      (err) => {
        const messages = {
          1: 'Location permission was denied. You can still search for a city by name.',
          2: 'Your position is unavailable right now. Try searching for a city instead.',
          3: 'Timed out while looking up your location. Try again or search by name.'
        };
        reject(new WeatherError('geolocation', messages[err?.code] ?? 'Could not determine your location.'));
      },
      { enableHighAccuracy: false, timeout, maximumAge: 5 * 60 * 1000 }
    );
  });
}
