# Northwind Goods — a **demo** store (simulated payments only)

> ## ⚠️ This is a demo project. It is not a real shop.
>
> **Northwind Goods is a fictional brand invented for this learning project.** Nothing on this site
> is for sale, no goods exist, and no order will ever be fulfilled.
>
> **The checkout is a simulation.** There is no payment provider, no API key, no network request to
> anyone, and no card storage. The payment step accepts a short list of well-known public **test**
> card numbers (e.g. `4242 4242 4242 4242`), validates them in memory, throws the number away and
> writes a fake brand plus the test number's last four digits to the demo order row.
> **Never type a real card number into this application.**

A full-stack e-commerce teaching example: catalogue, filtering, cart, accounts, a four-step
simulated checkout, order history and an admin area — built with Node.js, Express 4, SQLite
(`better-sqlite3`) and EJS. No front-end build step and no external services.

---

## Setup

```bash
npm install
npm run seed        # creates db/store.sqlite, writes SVG placeholder images, adds demo accounts
npm start           # http://localhost:4005
```

Optional configuration — copy `.env.example` to `.env`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4005` | Port the demo server listens on |
| `SESSION_SECRET` | insecure fallback | Session cookie signing secret |
| `DB_PATH` | `db/store.sqlite` | Where the SQLite file lives |
| `NODE_ENV` | `development` | Set to `production` to require HTTPS for session cookies |

`npm run seed` is destructive: it drops and recreates every table.

## Demo accounts and demo data

| Role | Email | Password |
| --- | --- | --- |
| Admin | `admin@example.com` | `admin123` |
| Customer | `customer@example.com` | `customer123` |

These are throwaway logins for a demo. Do not reuse a real password when registering.

* **Promo code:** `SAVE10` — 10% off the subtotal.
* **Approved test card:** `4242 4242 4242 4242`, any future expiry (e.g. `12/34`), any 3–4 digit CVC.
* Other accepted test numbers: `5555 5555 5555 4444` and `4000 0565 5665 5556` (approved),
  `4000 0000 0000 0002` (simulated decline), `4000 0000 0000 9995` (simulated insufficient funds).
* Anything else is rejected with a reminder not to enter real card details.

## Features

**Catalogue and browsing**
* 25 fictional products across 5 categories, each with three locally generated SVG images.
* Grid browsing with category filter, min/max price range, in-stock filter, full-text search
  across name and description, sorting (newest, price ↑/↓, top rated, name) and pagination.
* Product pages with an image gallery, stock badge, quantity picker, spec list, related products,
  a review list and an "add review" form (sign-in required, one review per person per product).

**Cart**
* Guests get a session cart; signed-in users get a database-backed cart, and the guest cart is
  merged into it on login/registration.
* Add / update / remove / empty, live totals, per-line stock clamping (max 20 per line and never
  more than the stock on hand), promo code entry, and a free-shipping progress hint.
* Totals: subtotal → promo discount → shipping → 8% demo tax. All integer cents.

**Shipping rules**

| Method | Cost | Notes |
| --- | --- | --- |
| Standard | $5.99 | Free once the discounted subtotal reaches $75.00 |
| Express | $12.99 | 1–2 working days |
| Collect in store | Free | Fictional pickup point |

**Accounts**
* Register / sign in / sign out, passwords hashed with bcrypt (cost 10).
* Address book with a default address, order history and per-order detail pages.

**Checkout (simulated)**
1. **Address** — new address or one saved on the account; guests check out with just an email.
2. **Shipping method** — the three fictional options above.
3. **Demo payment** — clearly labelled fake card form, test numbers only.
4. **Confirmation** — order number (`NW-YYYYMMDD-XXXXXX`), totals and a repeat of the demo notice.

Placing an order runs in a single SQLite transaction: stock is re-checked and decremented with a
conditional `UPDATE … WHERE stock >= ?`, and the order plus its line items are inserted. If any
line has sold out in the meantime the whole transaction rolls back and nothing is written.

**Admin (`/admin`, admin role only)**
* Dashboard with catalogue/order/revenue counters and a low-stock list.
* Product CRUD, inline stock editing, and a "withdraw from sale instead of delete" rule for
  products that already appear in an order (so order history stays intact).
* Order list with status filters and guarded status transitions:
  `pending → paid → packed → shipped → delivered`, with `cancelled` available until dispatch.
  Cancelling an order returns its items to stock.

## Security notes

* **Parameterised queries everywhere** — every value reaches SQLite as a bound parameter; no
  string-built SQL.
* **CSRF tokens** — a per-session synchroniser token is required on every `POST`/`PUT`/`DELETE`
  (`middleware/csrf.js`), compared with `crypto.timingSafeEqual`.
* **Prices are never trusted from the client.** The browser only ever sends product IDs and
  quantities; unit prices, discounts, shipping, tax and totals are recomputed on the server from
  the `products` table on every request (`middleware/pricing.js`).
* **Quantities are validated server-side** and clamped to `min(20, stock)`.
* **Sessions** are `httpOnly`, `sameSite=lax`, and `secure` when `NODE_ENV=production`.
* **Output escaping** — EJS `<%= %>` interpolation escapes by default.
* **No card data is stored.** The card number lives only in the request body for the length of one
  validation function, and is never echoed back into the form after an error.
* Login failures return one message for both unknown emails and wrong passwords.

## Routes

| Method | Path | Access | Description |
| --- | --- | --- | --- |
| GET | `/` | public | Home: hero, categories, top rated, newest |
| GET | `/products` | public | Browse: `?q= &category= &min= &max= &in_stock=1 &sort= &page=` |
| GET | `/products/:slug` | public | Product detail, gallery, related items, reviews |
| POST | `/products/:slug/reviews` | user | Add a review (1–5 stars, one per product) |
| GET | `/cart` | public | Basket with live totals |
| POST | `/cart/add` | public | Add a product (quantity validated against stock) |
| POST | `/cart/update` | public | Set an absolute line quantity (0 removes) |
| POST | `/cart/remove` | public | Remove a line |
| POST | `/cart/clear` | public | Empty the basket |
| POST | `/cart/promo` | public | Apply or clear a promo code (`SAVE10`) |
| GET/POST | `/register` | guest | Create a demo account |
| GET/POST | `/login` | guest | Sign in (merges the guest cart) |
| POST | `/logout` | any | Destroy the session |
| GET | `/account` | user | Dashboard: recent orders, default address |
| GET/POST | `/account/addresses` | user | List / create addresses |
| POST | `/account/addresses/:id/default` | user | Set the default address |
| DELETE | `/account/addresses/:id` | user | Delete an address |
| GET | `/account/orders` | user | Order history |
| GET | `/account/orders/:number` | user | Order detail |
| GET | `/checkout` | cart | Redirects to step 1 |
| GET/POST | `/checkout/address` | cart | Step 1 — delivery address |
| GET/POST | `/checkout/shipping` | cart | Step 2 — delivery method |
| GET/POST | `/checkout/payment` | cart | Step 3 — **simulated** payment; places the order |
| GET | `/checkout/confirmation/:number` | owner | Step 4 — confirmation |
| GET | `/admin` | admin | Dashboard |
| GET | `/admin/products` | admin | Product list (`?q=`) |
| GET | `/admin/products/new` | admin | New product form |
| POST | `/admin/products` | admin | Create a product |
| GET | `/admin/products/:id/edit` | admin | Edit form |
| PUT | `/admin/products/:id` | admin | Update a product |
| POST | `/admin/products/:id/stock` | admin | Quick stock edit |
| DELETE | `/admin/products/:id` | admin | Delete, or withdraw if already ordered |
| GET | `/admin/orders` | admin | Order list (`?status=`) |
| GET | `/admin/orders/:id` | admin | Order detail |
| POST | `/admin/orders/:id/status` | admin | Guarded status transition |

`PUT`/`DELETE` are submitted from HTML forms via `method-override` (`?_method=PUT`).

## Schema summary

`db/schema.sql` — all money is stored as **integer cents**, all timestamps as SQLite `datetime`
text, and foreign keys are enforced.

| Table | Key columns |
| --- | --- |
| `users` | `email` (unique), `password_hash` (bcrypt), `name`, `role` (`customer`\|`admin`) |
| `addresses` | `user_id` →`users`, `label`, `full_name`, `line1/2`, `city`, `region`, `postal_code`, `country`, `is_default` |
| `categories` | `name`, `slug` (both unique), `description` |
| `products` | `name`, `slug` (unique), `description`, `price_cents`, `stock`, `category_id`, `rating`, `rating_count`, `is_active`, `created_at` |
| `product_images` | `product_id` →`products`, `url`, `alt`, `position` |
| `reviews` | `product_id`, `user_id`, `rating` (1–5), `title`, `body`, unique per (product, user) |
| `carts` / `cart_items` | one cart per signed-in user; `cart_items` unique per (cart, product) |
| `orders` | `order_number` (unique), `user_id` (nullable for guests), `email`, `status`, `subtotal/discount/shipping/tax/total_cents`, `promo_code`, `shipping_method`, `ship_*` address, `payment_brand`/`payment_last4` (fake demo values), `placed_at` |
| `order_items` | `order_id`, `product_id`, plus a snapshot of `name`, `slug`, `unit_price_cents`, `quantity`, `line_total_cents` |

Order items keep their own copy of the name and price so historical orders stay correct if a
product is later renamed, repriced or withdrawn.

## Project layout

```
05-ecommerce/
├── server.js              app wiring: sessions, flash, locals, CSRF, routes, error pages
├── db/
│   ├── schema.sql         table definitions
│   ├── index.js           better-sqlite3 connection (WAL, foreign keys on)
│   ├── images.js          writes the SVG placeholder images into public/img/
│   └── seed.js            demo catalogue, categories, accounts, reviews
├── middleware/
│   ├── auth.js            requireLogin / requireAdmin
│   ├── cart.js            session + DB carts, merge on login, quantity validation
│   ├── csrf.js            per-session synchroniser token
│   ├── flash.js           one-shot session messages
│   └── pricing.js         cents-only totals, promo codes, shipping rules, tax
├── routes/                shop, cart, auth, account, checkout, admin
├── views/                 EJS pages + partials (header, footer, flash, stars, cards, steps)
└── public/                css/style.css, js/app.js, img/*.svg (all generated locally)
```

All images are SVGs written by `db/images.js` during seeding — nothing is fetched from the
internet and the app makes no outbound requests at all.

## Front-end behaviour

`public/js/app.js` is progressive enhancement only: the gallery thumbnails, quantity steppers,
card-number formatting, the "fill in the demo test card" button and delete confirmations all
improve the experience, but every form works with JavaScript disabled.

---

### Once more, because it matters

This is a **learning project**. Northwind Goods does not exist, the checkout is **simulated**, no
payment provider is involved, and no money can be taken. If you deploy it anywhere public, keep
the demo banners intact so nobody can mistake it for a real merchant's payment page.
