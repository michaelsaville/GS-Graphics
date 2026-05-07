# GS-Graphics — Print Shop Storefront

Multi-tenant storefront framework for a decorated apparel print shop. Each campaign (school, team, etc.) lives at `/store/<slug>`. Orders flow through pending → paid → processing → ready → fulfilled with audit log, customer status emails, and a per-pickup-event roster.

Live at https://gsgraphics.pcc2k.com.

## Quickstart (local dev)

```bash
cd /home/msaville/GS-Graphics
docker compose up -d --build
# admin at https://gsgraphics.pcc2k.com/admin
```

Migrations:

```bash
docker run --rm --network gs-graphics_default \
  -v /home/msaville/GS-Graphics:/app -w /app \
  -e DB_HOST=db -e DB_PORT=5432 -e DB_NAME=gs_graphics_db \
  -e DB_USER=gs_graphics_user -e DB_PASSWORD=$(grep DB_PASSWORD .env | cut -d= -f2) \
  node:20-alpine node scripts/migrate-NNN-name.js
```

## Feature surface

**Customer**
- Multi-store storefront, cart, checkout (Square)
- Order tracking (`/track`) by email + order #
- Per-store order deadlines that block new orders past the cutoff
- Editable About blurb, footer info, Facebook link
- Editable Privacy Policy, Contact form
- Maintenance mode toggle (full-site coming-soon)

**Operator (admin)**
- Stores, items, colors, sizes, pickup events
- Order list with filters (status / store / customer search / date range) + bulk status change
- Order detail with line-item edit, status workflow, audit log, customer notification
- Pickup-event roster with one-click "Mark fulfilled"
- Four reports: sales tax / vendor blank order / customization detail / sort & distribution
- Site settings: theme color, logo, company info, About, privacy, contact recipient
- Contact submissions inbox

**Security / quality**
- CSRF on every POST
- Square server-side payment verification (no trust in redirect query)
- Session-backed admin auth, bcrypt password hash
- Self-serve order tracking with no information leak

See `CLAUDE.md` for full architecture notes, file layout, and operational recipes.

## Stack
Node 20 / Express 4 / EJS / Postgres 16 / Square Checkout / nodemailer SMTP. All containerized via `docker-compose.yml`.
