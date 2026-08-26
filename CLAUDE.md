# GS-Graphics — Working Notes

Multi-tenant print-shop storefront for one client (GS Graphics). Each "store" is a campaign (e.g. *West Eagles 2026*).
Live at https://gsgraphics.pcc2k.com.

## Stack & layout
- Node 20 / Express 4 / EJS / Postgres 16 / Square Checkout (sandbox by default)
- Containerized: `docker-compose.yml` defines `app` (port 3400) and `db` (loopback :5433).
- nginx vhost on `100.91.194.83` proxies `gsgraphics.pcc2k.com → 100.115.11.109:3400`. Let's Encrypt cert auto-renews.
- Repo root is `/home/msaville/GS-Graphics`.

## Module layout
| File | Purpose |
|---|---|
| `app.js` | Express bootstrapping, sessions, CSRF, maintenance gate, template globals |
| `config.js` | All env-var reads |
| `db.js` | pg Pool + `query()` helper |
| `csrf.js` | Token middleware + `csrfCheck` for multipart routes |
| `site-settings.js` | Cached reader for the `site_settings` row (30s TTL, `invalidate()` on save) |
| `mailer.js` | nodemailer SMTP wrapper. 4 functions: `sendContactEmail`, `sendCustomerStatusEmail`, `sendCustomerOrderReceipt`, `sendOperatorOrderAlert`. All return `{status, error}`; never throw. |
| `order-status.js` | Status vocabulary + display helpers; `STATUSES`, `MANUAL_CHOICES`, `isValid`, `info` |
| `routes/store.js` | Public storefront, cart, privacy, contact, /track, /favicon.svg |
| `routes/checkout.js` | Square sandbox short-circuit + production verification flow + post-order email |
| `routes/admin.js` | Everything under /admin: settings, stores, items, orders, reports, contact-submissions |
| `views/` | EJS templates. Customer pages under `views/store/`, admin under `views/admin/`, partials under `views/partials/`. |
| `scripts/migrate*.js` | Numbered migrations. Run via the temp-container recipe below. |
| `Dockerfile` | Lists every JS module that needs to be COPYed in. Update when adding files at repo root. |

## Database
Tables (after all migrations):
- `stores` (campaigns: name, slug, active, tax_rate, personalization_*_price, orders_close_at, order_deadline_message, image_url)
- `store_sizes`, `default_sizes`, `shop_defaults` — size templates per store
- `items`, `item_colors` — products + color options. `item_colors.image_url` (migration 013) is a per-colorway photo; empty means fall back to `items.image_url`. The item page swaps the photo when a color is picked.
- `pickup_events` — pickup dates per store
- `orders` (status, total_amount, tax_amount, square_order_id, admin_notes, customer_*)
- `order_items` (line items with personalization)
- `order_status_log` — audit log of status transitions
- `site_settings` (singleton row): brand_name, brand_color, logo_url, about_blurb, company_*, facebook_url, privacy_policy_html, contact_recipient_email, maintenance_enabled, maintenance_message
- `contact_submissions` — submissions from /contact form
- `session` — connect-pg-simple

## Running migrations
The container doesn't ship `prisma/`-style migrations; we hand-roll. To run a new migration:

```bash
docker run --rm --network gs-graphics_default \
  -v /home/msaville/GS-Graphics:/app -w /app \
  -e DB_HOST=db -e DB_PORT=5432 -e DB_NAME=gs_graphics_db \
  -e DB_USER=gs_graphics_user -e DB_PASSWORD=<pw-from-env> \
  node:20-alpine node scripts/migrate-NNN-description.js
```

DB password lives in `/home/msaville/GS-Graphics/.env` as `DB_PASSWORD`.

## Rebuild + restart
After editing any JS or view file, rebuild the image (Dockerfile uses COPY, not bind mount):

```bash
cd /home/msaville/GS-Graphics
docker compose up -d --build app
```

Static assets in `public/` are also COPYed at build time. `/uploads` is a named volume (`gs_graphics_uploads`) so user-uploaded logos and images survive rebuilds.

## Env vars (in `.env`)
Critical ones:
- `DB_*` — Postgres connection (DB_HOST=db inside compose network)
- `SESSION_SECRET` — long random string
- `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH` — admin login. Hash uses bcrypt. **In .env, escape every `$` with `$$`** because docker-compose interpolates `${VAR}` from env_file.
- `SQUARE_*` — sandbox by default. Set `SQUARE_ENVIRONMENT=production` + real creds to go live.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` — generic SMTP. If absent, all email sends short-circuit as `skipped`. Submissions/orders still record fine.
- `BRAND_*` — fallback only. Real brand values live in `site_settings` table.

## Square: how payment status is set
The `/checkout/callback?order_id=...` endpoint **does not trust** the redirect. It looks up the stored `square_order_id` on our orders row and calls `client.ordersApi.retrieveOrder(...)`. Only flips status to `paid` if Square reports `state === 'COMPLETED'`. Sandbox path short-circuits (creates as `paid` immediately). When SMTP is configured, both customer receipt and operator alert go out.

## Order lifecycle
Statuses (defined in `order-status.js`): `pending`, `paid`, `processing`, `ready`, `fulfilled`, `cancelled`, `refunded`, `failed`. Operators see only the manual ones in dropdowns. Each transition is logged in `order_status_log` with optional note. Admin can also add notes without changing status.

## CSRF
Session-backed token (32 bytes hex) issued on first request. Hidden field `_csrf` required on every POST except webhooks (none yet). Multipart routes call `csrfCheck` after `multer` because multer parses the body, not body-parser. To add a new POST form, include `<%- include('../partials/csrf') %>` inside the form. Admin file-upload routes need `csrfCheck` after `upload.single(...)`.

⚠ Adding a file input to an existing form makes it multipart, which silently moves it into that second category — the global CSRF middleware then sees an empty body. Both `/admin/stores/:storeId/items/:itemId/colors` routes hit this when per-color photos were added.

## Reports surface
Index at `/admin/reports`. Four reports:
- `/admin/reports/sales-tax` — date range, per-store tax + revenue. Paid orders only.
- `/admin/reports/blanks` — multi-select stores → aggregated `item × color × size → SUM(qty)`. Vendor blank order list. CSV export.
- `/admin/reports/customizations` — per store + optional pickup event → every personalized line with customer.
- `/admin/reports/sort` — per store + optional pickup event → grouped by garment-variant, list of customers per group with checkboxes for sort sheet.
- Per-store legacy report at `/admin/stores/:id/report` is still wired (blanks + personalizations for that store only).
- Pickup roster at `/admin/stores/:id/events/:eid/roster` is the day-of distribution sheet, with one-click "Mark fulfilled".

## Key admin URLs
- `/admin` — dashboard (counts + per-store cards + recent orders)
- `/admin/stores`, `/admin/stores/:id/edit`, `/admin/stores/:id/items`, `/admin/stores/:id/sizes`, `/admin/stores/:id/events`
- `/admin/orders` — searchable + filterable + bulk status change
- `/admin/orders/:id` — status change form, audit log, line-item edit/delete
- `/admin/reports` — index
- `/admin/contact-submissions` — inbox
- `/admin/settings` — branding, logo, company info, About blurb, privacy HTML, maintenance toggle
- `/admin/defaults` — shop defaults (default tax, default size template)

## Public URLs
- `/` — home with About blurb + active stores
- `/store/:slug`, `/store/:slug/:itemId`
- `/cart`, `/checkout`
- `/track` — order lookup by email + order #
- `/contact`, `/privacy`
- `/favicon.svg` — generated from brand color + first letter

## Maintenance mode
Toggle in `/admin/settings`. When on, every public path renders a 503 "back soon" page. Admin paths and `/admin/login` always pass through, so the operator can re-enable. Routes whitelisted: `/admin/*`, `/uploads/*`, `/css/*`, `/favicon.svg`.

## Things explicitly NOT yet built (so far)
- Inventory / stock tracking
- Refund integration with Square's API (only "refunded" status flag for now)
- Multi-currency / international addresses
- Customer accounts / order history (we have anonymous /track instead)
- Webhook for Square asynchronous payment events (callback-time API check covers it for now, but stuck-pending orders if user closes browser before redirect would need a manual admin nudge)

## Backups
DB volume: `gs_graphics_pgdata`. Take backups via `docker exec gs-graphics-db pg_dump -U gs_graphics_user gs_graphics_db > backup.sql`. Uploads volume: `gs_graphics_uploads`. Logo + store/item images live there.
