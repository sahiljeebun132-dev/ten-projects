# Biraj Jeebun — Personal Portfolio

A polished, fully static personal portfolio site. One HTML file, one stylesheet,
one script — no build step, no framework, no CDN requests, no trackers. Drop it on
any static host and it works.

> The design is finished, but the *content* is intentionally placeholder. Anywhere a
> personal fact would go ("Replace with your own bio", employer names, links) is marked
> so you can swap in real details without accidentally shipping invented claims.

---

## Features

**Sections**
- Sticky, blurred header with smooth-scrolling in-page navigation
- Hero with name, tagline, two CTAs and an at-a-glance stat row
- About — bio placeholders, quick-facts list and a sticky profile card
- Skills — four groups of tag chips, rendered from data
- Projects — responsive grid of six cards (title, description, tech chips, links)
- Experience & education — vertical timeline with period, role, bullets and tags
- Contact — client-side validated form with an animated success state, plus
  alternative contact methods
- Footer with brand, nav and auto-updating copyright year

**Behaviour**
- **Light/dark theme toggle** — starts from `prefers-color-scheme`, follows OS changes
  until you click the toggle, then remembers your click **in a plain JS variable for the
  page session**. No `localStorage`, no `sessionStorage`, no cookies.
- **Scroll-reveal animations** via `IntersectionObserver` (opacity + transform only, so
  nothing reflows)
- **Mobile hamburger menu** — slide-in drawer with overlay, focus trap, `Escape` to close,
  and auto-close when the viewport widens
- **Active-link highlighting** as you scroll, with `aria-current`
- **Back-to-top button** that fades in past 500px
- **Reading-progress bar** under the header
- Character counter and per-field inline errors on the contact form

**Quality**
- Semantic landmarks (`header` / `nav` / `main` / `section` / `footer`), skip link,
  `aria-label`s, `role="alert"` on error messages, `aria-live` status region
- Visible 3px focus rings on every interactive element (`:focus-visible`)
- WCAG AA contrast in **both** themes — measured with a headless browser: body text
  18.6:1 (light) / 17.2:1 (dark), muted text ≥ 6.3:1, accent-on-background ≥ 5.8:1,
  and white-on-accent buttons 6.3:1. Every pairing clears AA (4.5:1) and most clear AAA.
- Zero layout shift: error lines and the character counter reserve their height, the
  success panel overlays the form, project covers use `aspect-ratio`, and no images or
  web fonts are loaded
- Responsive and checked at **360px**, **768px** and **1280px**
- `prefers-reduced-motion` honoured (all animation disabled)
- Print stylesheet included
- Graceful degradation: `.no-js` on `<html>` keeps all content visible if JS is off

---

## File structure

```
01-personal-portfolio/
├── index.html          # All markup: nav, hero, about, skills, projects,
│                       # experience, contact, footer
├── css/
│   └── styles.css      # Design tokens + all styling, organised in 16
│                       # numbered sections (see the comment header)
├── js/
│   └── main.js         # Content arrays at the top, behaviour below:
│                       # rendering, theme, reveal, nav, scroll UI, form
└── README.md
```

No `projects.json`, no fetch call — project data is a plain JS array so the site works
straight off the filesystem and has nothing extra to deploy.

---

## How to run

Any static server will do. From this directory:

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

Alternatives:

```bash
npx serve .          # Node
php -S localhost:8000
```

Opening `index.html` directly with `file://` also works, since nothing is fetched.

---

## How to customise

### 1. Your name and copy — `index.html`

Search for `Biraj Jeebun` and replace every occurrence (page title, meta description,
header brand, hero heading, profile card, footer). The two-letter monogram lives in the
`.brand-mark` spans and in the favicon `data:` URL in `<head>`.

Every placeholder sentence is marked with *"Replace with your own …"* — the About
paragraphs, the quick-facts list, the contact details and the timeline entries.

To use a real photo, replace the `<svg>` inside `.avatar` with:

```html
<img src="img/me.jpg" alt="" width="112" height="112" />
```

(keep `width`/`height` so nothing shifts while it loads).

### 2. Projects — `js/main.js`

Edit the `PROJECTS` array at the top of the file. Each entry:

```js
{
  title: 'Orbit Dashboard',
  badge: 'Web app',                       // small label on the cover
  year:  '2025',
  description: 'One or two sentences.',
  tech:  ['TypeScript', 'React'],         // rendered as chips
  links: [
    { label: 'Live demo', href: 'https://…', type: 'demo' },
    { label: 'Source',    href: 'https://…', type: 'code' }
  ],
  colors: ['#4f46e5', '#7c3aed']          // optional cover gradient
}
```

Add or remove entries freely — the grid reflows. Card covers are generated gradients
with the project's initials, so there are no image assets to manage.

### 3. Skills and timeline — `js/main.js`

`SKILL_GROUPS` takes `{ name, icon, items[] }`, where `icon` is one of `code`, `layout`,
`server`, `tool` (defined in the `ICONS` map — add your own SVG path there).

`TIMELINE` takes `{ period, kind, role, org, description, points[], tags[] }`. `kind` is
the small uppercase label, e.g. `Work`, `Freelance`, `Education`.

### 4. Colours and spacing — `css/styles.css`

Everything is a CSS custom property in section **1. DESIGN TOKENS**:

```css
:root {
  --accent:   #4f46e5;   /* brand colour                      */
  --accent-2: #7c3aed;   /* gradient partner                  */
  --bg, --bg-alt, --surface, --surface-2   /* backgrounds     */
  --text, --text-soft, --text-muted        /* type colours    */
  --radius, --space-*, --container         /* shape & rhythm  */
}
```

The dark palette is the `:root[data-theme="dark"]` block right below it. Change both if
you change the brand colour, and re-check contrast — aim for ≥ 4.5:1 for body text.

### 5. Contact form

The form is front-end only: it validates, shows a spinner, then reveals the success
panel. To actually receive messages, either point it at a form service:

```html
<form id="contact-form" action="https://formspree.io/f/xxxx" method="POST">
```

and delete the `e.preventDefault()` in `initContactForm`, or `fetch()` your own endpoint
inside the submit handler where the `setTimeout` currently sits. Validation rules live in
the `RULES` object.

---

## Deployment

### GitHub Pages
1. Push this folder to a repo (as the repo root, or into `/docs`).
2. **Settings → Pages → Build and deployment → Deploy from a branch.**
3. Pick `main` and `/ (root)` (or `/docs`), then save.
4. Site goes live at `https://<user>.github.io/<repo>/`.

All asset paths are relative (`css/styles.css`, `js/main.js`), so it works from a
project subpath without changes. For a custom domain, add a `CNAME` file containing your
domain next to `index.html`.

### Netlify
- **Drag and drop:** drop this folder onto <https://app.netlify.com/drop>. Done.
- **Git:** connect the repo, leave *Build command* empty and set
  *Publish directory* to `.` (or `01-personal-portfolio` if the folder sits inside a
  larger repo).

### Anything else
Vercel, Cloudflare Pages, S3 + CloudFront, or plain nginx all work the same way: there
is no build output — the folder *is* the site.

---

## Browser support

Modern evergreen browsers. The layout uses CSS Grid, custom properties, `aspect-ratio`
and `color-mix()`; fallbacks are declared where `color-mix()` and `backdrop-filter` are
used, so older engines degrade to a solid header rather than breaking.

## Licence

Use it, change it, ship it. Attribution appreciated but not required.
