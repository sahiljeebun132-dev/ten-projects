# Skycast — Weather Forecast

A 7-day weather forecast app in vanilla HTML, CSS and JavaScript. No build step,
no framework, no bundler, no API key, and nothing written to disk or browser
storage.

---

## Features

**Location input**
- **City search with live autocomplete** — a debounced (280 ms) dropdown backed by
  the Open-Meteo geocoding API. Fully keyboard navigable: `↓`/`↑` to move,
  `Enter` to choose, `Esc` to dismiss, `Tab` to close. Implemented with the
  ARIA combobox pattern (`role="combobox"` + `role="listbox"` +
  `aria-activedescendant`). In-flight requests are aborted when you keep typing.
- **Use my location** — one button, `navigator.geolocation`, with distinct
  messages for permission denied, position unavailable, and timeout.
- **Recent searches** — chips for the last 6 places, deduplicated by rounded
  coordinates. Held in a plain module-scoped array and gone on reload.

**Forecast display**
- **Current conditions card** — temperature, feels-like, condition icon and
  description, humidity, wind speed with 16-point compass direction, surface
  pressure, precipitation, UV index (with a Low/Moderate/High/Very high/Extreme
  band), sunrise and sunset.
- **24-hour strip** — a temperature line drawn as hand-written inline SVG with a
  gradient area fill, precipitation-probability bars underneath, a per-hour
  weather icon, and a `<title>` tooltip on every column. No chart library.
  Horizontally scrollable so 24 columns stay legible on a phone.
- **7-day cards** — weekday, date, icon, description, hi/lo, precipitation total.

**Presentation**
- **Unit toggles** — °C/°F and km/h/mph. All data is fetched and stored in metric
  and converted at render time, so switching units re-renders instantly without
  a network request. Switching to mph also switches precipitation to inches.
- **Dynamic background** — the page gradient responds to both the condition
  group (clear / cloud / rain / snow / storm / fog) and whether it is currently
  day or night at the queried location: twelve gradient pairings in total.
- **Hand-drawn SVG icons** — sun, moon, cloud, partly cloudy, fog, drizzle, rain,
  showers, snow, sleet and thunder, each written as SVG path data in
  `js/icons.js`. Clear/mainly-clear/partly-cloudy have separate night variants
  (moon instead of sun). No external images, no icon font, no sprite sheet.
- **Loading skeletons** — shimmering placeholders matched to the real layout.
- **Error states** — separate copy and headings for network failure, city not
  found, geolocation refusal, and an API-reported error, with a "Try again"
  button that replays the last action where a retry could plausibly help.

**Accessibility & quality**
- `role="status"` + `aria-live="polite"` region announcing forecast loads, unit
  changes and errors; the error panel is `role="alert"` and receives focus.
- Every control is labelled; the search field has an `aria-describedby` hint
  explaining the keyboard model.
- Visible `:focus-visible` rings throughout, plus a skip link.
- The SVG chart carries an `aria-label`, and a screen-reader-only paragraph
  summarises the temperature range and peak precipitation chance in words.
- Responsive from ~320 px upward; honours `prefers-reduced-motion` and
  `prefers-contrast: more`.
- All theming runs through CSS custom properties.
- All interpolated API strings are HTML-escaped before insertion.

---

## APIs used

Both endpoints are from [Open-Meteo](https://open-meteo.com/), are free for
non-commercial use, and **require no API key** — no signup, no token, no
`Authorization` header.

**Geocoding** — [docs](https://open-meteo.com/en/docs/geocoding-api)

```
https://geocoding-api.open-meteo.com/v1/search?name={q}&count=5&language=en&format=json
```

Returns a `results` array; each entry has `id`, `name`, `latitude`, `longitude`,
`country`, `country_code`, `admin1`, `timezone` (plus `elevation`, `population`,
`feature_code` and friends). When nothing matches, `results` is **omitted
entirely** rather than returned empty — the app treats a missing key as an empty
list and shows the "city not found" state.

**Forecast** — [docs](https://open-meteo.com/en/docs)

```
https://api.open-meteo.com/v1/forecast
  ?latitude=..&longitude=..
  &current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,
           precipitation,weather_code,wind_speed_10m,wind_direction_10m,surface_pressure
  &hourly=temperature_2m,precipitation_probability,weather_code
  &daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,
         precipitation_sum,wind_speed_10m_max,uv_index_max
  &timezone=auto&forecast_days=7
```

`timezone=auto` makes every timestamp local to the queried coordinates and
returned **without a UTC offset suffix** (`"2026-08-20T14:00"`). Passing those
strings to `new Date()` would silently reinterpret them in the browser's own
timezone, so `js/units.js` parses the components by hand and formats via
`Intl.DateTimeFormat` with `timeZone: 'UTC'`. Because every timestamp shares one
fixed-width format, plain string comparison also orders them correctly — that is
how the app slices the next 24 hours and decides whether a given hour falls
between sunrise and sunset.

Values are requested in metric and converted client-side, so the unit toggle
never refetches.

---

## How to run

The app uses ES modules, which browsers refuse to load over `file://`. Serve the
folder over HTTP:

```bash
cd 03-weather-app
python3 -m http.server 8803
```

Then open <http://localhost:8803>. Any static server works equally well
(`npx serve`, `php -S localhost:8803`, etc.). There is nothing to install or
compile.

Note that `navigator.geolocation` requires a secure context: it works on
`localhost` but will be refused over plain HTTP from another host.

---

## File structure

```
03-weather-app/
├── index.html          Markup, ARIA wiring, skeleton and error scaffolding
├── README.md
├── css/
│   └── styles.css      Custom properties, condition gradients, layout, skeletons
└── js/
    ├── app.js          Controller: state, autocomplete, geolocation, rendering
    ├── api.js          Open-Meteo fetch layer, WeatherError, geolocation wrapper
    ├── chart.js        Inline-SVG hourly temperature line + precipitation bars
    ├── icons.js        Hand-written SVG weather icons (day and night variants)
    ├── units.js        °C/°F, km/h/mph, mm/in conversion, compass, date helpers
    └── wmo.js          WMO 4677 weather-code table
```

---

## WMO code mapping

Open-Meteo reports conditions as a `weather_code` integer from the
**WMO 4677 present-weather** code table (the subset Open-Meteo publishes).
`js/wmo.js` contains the complete table — all 28 codes the forecast endpoint can
return — mapping each code to a human label, an icon key, and a coarse `group`
used to choose the background gradient:

| Code(s)        | Meaning                                        | Icon      | Group   |
| -------------- | ---------------------------------------------- | --------- | ------- |
| 0              | Clear sky                                      | `clear`   | clear   |
| 1              | Mainly clear                                   | `mostly`  | clear   |
| 2              | Partly cloudy                                  | `partly`  | cloud   |
| 3              | Overcast                                       | `cloud`   | cloud   |
| 45, 48         | Fog, depositing rime fog                       | `fog`     | fog     |
| 51, 53, 55     | Drizzle: light, moderate, dense                | `drizzle` | rain    |
| 56, 57         | Freezing drizzle: light, dense                 | `sleet`   | rain    |
| 61, 63, 65     | Rain: slight, moderate, heavy                  | `rain`    | rain    |
| 66, 67         | Freezing rain: light, heavy                    | `sleet`   | rain    |
| 71, 73, 75     | Snow fall: slight, moderate, heavy             | `snow`    | snow    |
| 77             | Snow grains                                    | `snow`    | snow    |
| 80, 81, 82     | Rain showers: slight, moderate, violent        | `showers` | rain    |
| 85, 86         | Snow showers: slight, heavy                    | `snow`    | snow    |
| 95             | Thunderstorm, slight or moderate               | `thunder` | storm   |
| 96, 99         | Thunderstorm with slight / heavy hail          | `thunder` | storm   |

Codes are looked up through `describe(code)`, which falls back to a neutral
"Unknown conditions" entry rather than throwing, so an unexpected value from the
API degrades gracefully instead of blanking the UI.

---

## Notes

- **No storage.** The app never calls `localStorage` or `sessionStorage`. Recent
  searches live in a JavaScript array for the lifetime of the page.
- **No telemetry.** The only network requests are the two Open-Meteo endpoints.
