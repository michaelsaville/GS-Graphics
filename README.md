# GS-Graphics — Print Shop Storefront Framework

Multi-tenant campaign-based storefront for decorated apparel print shops.
Each deployment is a single client's isolated instance.

## Quick Start (Claude Code)

See `CLAUDE.md` for full automated deployment instructions.

## Manual Setup

```bash
npm install
cp .env.example .env
# Edit .env with your values
node scripts/hash-password.js yourAdminPassword
# Paste hash into .env as ADMIN_PASSWORD_HASH
node scripts/migrate.js
node app.js
```

## Features

- **Multi-store campaigns** — each school/team gets their own store at `/store/slug`
- **Store on/off switch** — close a store to stop orders instantly
- **Item variants** — colors + sizes per item, global size price modifiers
- **Personalization** — optional name/number printing with per-item upcharge
- **Guest checkout** — full contact capture (name, address, email, phone, cell)
- **Pickup events** — defined per store, customer selects at checkout
- **Square Checkout** — redirect-based payment flow, no card data on your server
- **Order report** — blank apparel order summary + personalization list + CSV export

## Deployment

One `.env` file per client deployment. Same codebase, isolated database per client.

See `CLAUDE.md` for step-by-step server deployment instructions.
