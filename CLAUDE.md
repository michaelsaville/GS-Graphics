# GS-Graphics — Claude Code Deployment Instructions

## Overview
This is a multi-tenant print shop storefront framework (Node.js/Express/PostgreSQL).
Deploy it **isolated** — its own database, its own port, its own process.
Do NOT touch any other databases or apps on this server.

---

## Pre-flight Checks
1. Confirm Node.js >= 18 is installed: `node --version`
2. Confirm PostgreSQL is running: `pg_isready`
3. Confirm ports 3400-3499 are checked — pick the first available one for this app
4. Note the server's primary IP address — you will report this at the end

---

## Step 1 — Install Dependencies
```bash
cd /path/to/GS-Graphics
npm install
```

---

## Step 2 — Create Isolated Database
Connect as postgres superuser and run:
```sql
CREATE DATABASE gs_graphics_db;
CREATE USER gs_graphics_user WITH PASSWORD 'GENERATE_A_STRONG_RANDOM_PASSWORD';
GRANT ALL PRIVILEGES ON DATABASE gs_graphics_db TO gs_graphics_user;
\c gs_graphics_db
GRANT ALL ON SCHEMA public TO gs_graphics_user;
```
Save the generated password — you will need it for .env.

---

## Step 3 — Configure Environment
Copy `.env.example` to `.env` and fill in all values:
```bash
cp .env.example .env
```

Required values to set:
- `PORT` — the available port you found in pre-flight
- `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` — from Step 2
- `SESSION_SECRET` — generate with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- `ADMIN_USERNAME` — set to `admin`
- `ADMIN_PASSWORD_HASH` — generate with: `node scripts/hash-password.js yourChosenPassword`
- `SQUARE_ACCESS_TOKEN` — placeholder for now, leave as `SQUARE_PLACEHOLDER`
- `SQUARE_LOCATION_ID` — placeholder for now, leave as `SQUARE_PLACEHOLDER`
- `SQUARE_ENVIRONMENT` — set to `sandbox` for now
- `BASE_URL` — set to `http://SERVER_IP:PORT`
- `BRAND_NAME` — set to `GS Graphics`
- `BRAND_COLOR` — set to `#e63946`

---

## Step 4 — Run Database Migrations
```bash
node scripts/migrate.js
```
This will create all tables in `gs_graphics_db`. Confirm it exits with "Migrations complete."

---

## Step 5 — Start the App
```bash
node app.js
```
Or if you want it to stay running:
```bash
npm install -g pm2
pm2 start app.js --name gs-graphics
pm2 save
```

---

## Step 6 — Verify & Report Back
1. Confirm the app is listening: `curl -s -o /dev/null -w "%{http_code}" http://localhost:PORT/`
   - Should return 200
2. Confirm admin login works: `curl -s -o /dev/null -w "%{http_code}" http://localhost:PORT/admin`
   - Should return 200 or 302

**Then report back to the user with:**
```
GS-Graphics is live for review.
URL: http://SERVER_IP:PORT
Admin panel: http://SERVER_IP:PORT/admin
Username: admin
Password: [the password chosen in Step 3]
Database: gs_graphics_db (isolated, dedicated user)
Process: pm2 / node (state it)
Status: Ready for review — NOT yet proxied through nginx
```

---

## What NOT to do
- Do NOT configure nginx or point a domain at it yet — user will review first
- Do NOT modify any other .env files or databases on this server
- Do NOT run on port 80 or 443
- Do NOT use the same database as any other application
