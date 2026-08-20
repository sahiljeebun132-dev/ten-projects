# Ten Projects

A portfolio of ten self-contained projects — front-end, full-stack, data and machine
learning. Every project runs locally with no paid API keys, ships its own README,
and was smoke-tested end to end before being committed.

| # | Project | Stack | What it is |
|---|---------|-------|------------|
| 01 | [Personal Portfolio](01-personal-portfolio) | HTML / CSS / vanilla JS | Responsive personal site: hero, projects grid, timeline, contact form, dark mode |
| 02 | [Task Manager](02-task-manager) | React 18 + TypeScript + Vite | Kanban board with drag-and-drop, filters, stats, local persistence |
| 03 | [Weather Forecast](03-weather-app) | Vanilla JS + Open-Meteo | City autocomplete, current conditions, hand-drawn SVG hourly chart, 7-day forecast |
| 04 | [Blogging Platform](04-blogging-platform) | Express + SQLite + EJS | Auth, markdown posts, tags, comments, FTS5 search, RSS, dashboard |
| 05 | [E-commerce Store](05-ecommerce) | Express + SQLite + EJS | Catalog, cart, multi-step **demo** checkout, orders, admin panel |
| 06 | [Chat Application](06-chat-app) | Express + Socket.IO + SQLite | Rooms, DMs, presence, typing indicators, reactions, message history |
| 07 | [Movie Recommender](07-movie-recommender) | Python + scikit-learn + Streamlit | Content-based, item-item CF, SVD and hybrid recommenders with evaluation |
| 08 | [Data Analysis](08-data-analysis) | Python + pandas + matplotlib | End-to-end e-commerce analysis: cleaning, RFM, cohorts, stats tests, 14 figures |
| 09 | [Password Manager](09-password-manager) | Python + cryptography | Offline vault: Argon2id + AES-256-GCM, generator, TOTP, strength audit |
| 10 | [Machine Learning](10-machine-learning) | Python + scikit-learn + FastAPI | Churn prediction: pipeline, model bake-off, cost-based threshold, REST API |

## Quick start

Each folder is independent. Open its `README.md` for full instructions.

```bash
# Static sites (01, 03)
cd 01-personal-portfolio && python3 -m http.server 8000

# Node projects (02, 04, 05, 06)
cd 04-blogging-platform && npm install && npm run seed && npm start

# Python projects (07, 08, 09, 10)
cd 10-machine-learning && pip install -r requirements.txt && make all
```

## Notes

- **All datasets are synthetic** and produced by the generator scripts committed
  alongside them (`data/generate_*.py`). No real customer or user data is included.
- **05 is a demo store.** Checkout simulates payment with public test card numbers
  and is not connected to any payment provider. It is not a real merchant site.
- **09 is a learning project.** The cryptography follows current best practice and is
  documented in its `SECURITY.md`, but it has not been independently audited — don't
  trust it with secrets that matter until you've reviewed it yourself.
- Seeded demo accounts (`admin@example.com` / `admin123`) exist only for local
  development and must be changed before any real deployment.

## Verification

Every project was checked before commit: builds and type-checks pass, test suites are
green (42 / 38 / 294 / 65 tests in projects 07–10, 43 socket assertions in 06), servers
boot and serve their key routes, and the numbers quoted in each README come from real
runs rather than being written by hand.
