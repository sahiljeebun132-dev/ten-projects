# Task Board

A keyboard-friendly kanban board for tracking work across **Backlog → In Progress → Done**.
Everything runs in the browser: no account, no server, no network calls.

---

## Features

**Board**
- Three columns — Backlog, In Progress, Done — with native HTML5 drag and drop (no drag library).
- Every card also carries a **Move** menu, so the board is fully usable by keyboard and with a screen reader.
- Drop targets highlight while a card is over them.

**Tasks**
- Title, description, priority (low / medium / high), due date, tags, created date and status.
- Create, edit (in a modal), delete (with a confirmation step) and duplicate.
- Overdue and due-today dates are called out on the card; completed tasks are never marked overdue.

**Finding things**
- Free-text search across title, description and tags.
- Filter by priority and by tag.
- Sort by due date, priority or created date. Undated tasks always sort last.
- Filter choices are remembered between visits.

**Stats bar**
- Live counts per column, an overdue count, and a completion percentage with a progress bar.

**Comfort**
- Light and dark themes, defaulting to your operating system preference.
- Keyboard: <kbd>n</kbd> opens a new task, <kbd>Esc</kbd> closes any dialog, <kbd>Enter</kbd> submits the
  form (<kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>Enter</kbd> from inside the description box).
- Responsive: three columns on desktop, two on tablet, stacked on mobile.
- Respects `prefers-reduced-motion`.
- Seeded with eight example tasks on first run.

---

## Screenshots

<!--
Add images here once you have them, e.g.

| Light | Dark |
| ----- | ---- |
| ![Board in light theme](docs/screenshot-light.png) | ![Board in dark theme](docs/screenshot-dark.png) |
-->

_Screenshots to be added._

---

## Tech stack

| Piece | Choice |
| ----- | ------ |
| UI | React 18 |
| Language | TypeScript, `strict` mode (no `any` anywhere in `src/`) |
| Build | Vite 6 |
| Styling | Hand-written CSS with custom properties — no UI kit, no CSS framework |
| Drag and drop | Native HTML5 drag events |
| Storage | `localStorage`, behind a small abstraction |

Runtime dependencies are just `react` and `react-dom`.

---

## Getting started

```bash
npm install
npm run dev
```

Then open the URL Vite prints (http://localhost:5173 by default).

Other scripts:

```bash
npm run build      # type-check, then produce an optimised bundle in dist/
npm run preview    # serve the built bundle locally
npm run typecheck  # tsc --noEmit on its own
```

---

## Project structure

```
02-task-manager/
├── index.html               # Vite entry document
├── package.json
├── tsconfig.json            # strict TS config
├── vite.config.ts
└── src/
    ├── main.tsx             # mounts <App /> into #root
    ├── App.tsx              # wires state, dialogs and keyboard shortcuts together
    ├── types.ts             # Task/Status/Priority types, labels and type guards
    ├── styles.css           # design tokens plus every component style
    ├── components/
    │   ├── Header.tsx       # title, theme toggle, "New task"
    │   ├── StatsBar.tsx     # per-column counts, overdue, completion bar
    │   ├── FilterBar.tsx    # search, priority/tag filters, sort
    │   ├── Board.tsx        # lays out the columns, owns the drag state
    │   ├── Column.tsx       # one column plus its drop target
    │   ├── TaskCard.tsx     # a single task and its actions
    │   ├── MoveMenu.tsx     # keyboard alternative to dragging
    │   ├── TaskModal.tsx    # create/edit form in a focus-trapped dialog
    │   └── ConfirmDialog.tsx# delete confirmation
    ├── hooks/
    │   ├── useTasks.ts      # task CRUD, filtering, grouping, stats
    │   ├── useLocalStorage.ts # state mirrored into storage, with validation
    │   ├── useTheme.ts      # theme state, applied to <html data-theme>
    │   ├── useHotkeys.ts    # global single-key shortcuts
    │   └── useFocusTrap.ts  # dialog focus containment and restoration
    └── lib/
        ├── storage.ts       # the localStorage abstraction
        ├── tasks.ts         # pure task logic: dates, filter, sort, stats, parsing
        └── seed.ts          # the eight example tasks
```

Business logic lives in `src/lib/` as plain functions with no React imports, which keeps the
components small and makes the rules (what counts as overdue, how sorting breaks ties) easy to read
in one place.

---

## How your data is stored

All tasks live in your browser's `localStorage`, under these keys:

| Key | Contents |
| --- | -------- |
| `task-board:tasks:v1` | the task array, as JSON |
| `task-board:theme:v1` | `"light"` or `"dark"` |
| `task-board:filters:v1` | your current search, filter and sort choices |

Things worth knowing:

- **Nothing leaves your machine.** There is no backend and no analytics; the app makes no network
  requests after the page loads.
- **Storage is per browser and per profile.** Tasks saved in Chrome will not appear in Firefox, and
  clearing site data removes them. There is no sync and no backup.
- **Anything already stored is validated on read.** `src/lib/tasks.ts` re-checks every field coming
  out of storage, so a corrupt, truncated or hand-edited entry falls back to sane defaults instead of
  breaking the board.
- **Storage failures degrade gracefully.** If `localStorage` is unavailable — Safari private mode,
  blocked site data, a full quota — the app keeps working in memory for the session and says so in
  the footer.
- **The examples seed once.** They appear only when no task data is stored yet. Delete them all and
  they stay gone; the empty state offers a button to load them back.

The `:v1` suffix on each key is there so a future change to the task shape can migrate or ignore old
data rather than choke on it.
