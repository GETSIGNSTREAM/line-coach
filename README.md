# Line Coach

Real-time kitchen display system for **WILDBIRD**. Replaces mental math and gut instinct with live, data-driven coaching — what to fire first, how to batch sides, when an order is going stale, and what to focus on during slow periods.

**Production:** https://wildbird.coach

---

## Status

| Layer | Status |
|-------|--------|
| Web app (Vercel) | **Live** in production |
| Database (Supabase) | **Live** — `lc_*` tables on the WINGMAN project |
| Toast POS integration | **Live** — receiving order webhooks from 6 stores |
| Pi kiosks | **Pending rollout** — see `DEPLOYMENT.md` |
| Real admin login | **Not started** — currently any password is accepted client-side; PUT/DELETE still validate JWT server-side |

---

## Features (shipped)

### Display (kitchen monitor)
- **Adaptive density**: focus mode for 1 order, list view for many
- **Per-entree coaching tips** in EN + ES (brand-wide, surfaced in focus mode)
- **Bilingual Quality Coach** during slow periods (full-screen rotating tips)
- **Allergy red banner** with pulse animation when notes contain allergen keywords
- **Fire sequence** sorted by priority + cook time
- **Side batching** that aggregates identical sides across all active orders
- **Ticket timers** with green / yellow (warning) / red (danger) thresholds
- **Audio alerts**: new-order chime, warning beep on yellow, escalating danger pulse on red
- **Stale-ticket auto-hide** based on `max_ticket_minutes` (default 60) — keeps the board clean when Toast doesn't send completion events
- **Persistent device_id** in localStorage — heartbeats every 60s, recovers automatically on disconnect
- **Customer name** extracted from delivery-app prefixes (DoorDash, UberEats, Grubhub, Postmates) and walk-in receipts

### Admin (web)
- **Menu** — brand-wide, with image upload + per-item bilingual coach tips, CSV import/export
- **Sides** — brand-wide, with image upload + batch sizes, CSV import/export
- **Tips** — bilingual (EN + ES) brand-wide quality tips with paired-input editor
- **Hold Times** — fire/staging/on-deck thresholds + max ticket minutes
- **Settings** — per-store: ticket warning/danger minutes, audio chime, focus rotation, Quality Coach interval
- **Devices** — see online/offline/stale, hide stale > 7d, remove abandoned rows
- **Webhooks** — POS integration health (healthy/warning/critical/silent per store) + filterable raw payload inspector
- **Analytics** — bump time KPIs (avg, p50/p90/p95), hourly volume chart, top items shipped
- **Maintenance** — DB row counts, on-demand purge of webhook logs, archive of old orders

### Backend
- **Toast webhook** with HMAC signature verification (and bearer-token fallback)
- **Diagnostic logging** for every inbound webhook (ok/ignored/unauthorized/invalid_json/parse_error/insert_error/rate_limited)
- **Brand-wide config** in `lc_brand_config` (single row), per-store overrides only for `settings`
- **Cold storage** — `lc_orders_archive` table + `lc_archive_orders()` SQL function
- **Retention** — `lc_purge_old_logs()` SQL function for webhook log rotation
- **Image upload** — `POST /api/line-coach/upload-image` writes to Supabase Storage `lc-images` bucket
- **Realtime** — Supabase Postgres changes feed drives display updates without polling
- **Sandbox simulator** — dedicated `sandbox` store, never appears on live displays

---

## To do — pre-rollout

| Priority | Item | Notes |
|----------|------|-------|
| P0 | Order 6 Raspberry Pi 4 + accessories | One per active store |
| P0 | Image one Pi end-to-end per `DEPLOYMENT.md` | Validate audio + autoplay flag works |
| P0 | Mount kitchen monitors at each store | Existing wall mounts may need replacement |
| P0 | Run on-site setup at each store | ~30 min each: Pi → monitor → power → Wi-Fi/Ethernet |
| P1 | Real admin login | Replace fake password input with JWT issuance via bcrypt-hashed admins table |
| P1 | Toast HMAC secret rotation runbook | If we ever need to roll the secret |
| P2 | pg_cron retention jobs scheduled | One-time SQL: `SELECT cron.schedule(...)` for purge + archive |
| P2 | Train one cook per store on display | What it shows, when to ignore, hardware mute path |
| P3 | Replace 5 MB upload limit if photos grow | Currently jpg/png/webp/gif up to 5 MB per image |

---

## To do — post-rollout

| Priority | Item | Why |
|----------|------|-----|
| P1 | Order overrides in admin | When Toast misfires, manually fire/bump/cancel from web |
| P1 | Per-station bump time analytics | Spot bottlenecks; current analytics is store-wide |
| P2 | Comparison windows in analytics | "This week vs last week" KPIs |
| P2 | Multi-tenant admin scoping | Restrict admins to specific stores via `lc_admins` table with `store_ids` array |
| P3 | Order detail click-through | Tap an item to see modifiers + special instructions |
| P3 | Station-filtered display URL | `?station=grill` to put a screen at each station |

---

## Tech stack

- **Framework:** Next.js 15 (App Router)
- **Hosting:** Vercel (`wildbirds-projects/line-coach`)
- **Database:** Supabase (Postgres 17, project `epfxzpemsbeljspfwuwe`)
- **Auth:** JWT (`lib/jwt.js`) for admin endpoints
- **POS:** Toast webhooks → `/api/line-coach/webhook`
- **In-store:** Raspberry Pi 4 + Chromium kiosk

---

## Architecture

```
lib/                 shared utilities (supabase client, auth, data layer)
app/api/line-coach/  API routes (webhook, orders, config, devices, bump, analytics, …)
app/page.js          entry point; routes via URL params (?store=, ?admin)
src/                 React components (Display, Admin, Simulator)
scripts/             SQL migrations
DEPLOYMENT.md        Pi setup + ops runbook
```

---

## Commands

| Command | Purpose |
|---------|---------|
| `npm run dev` | Local dev server |
| `npm run build` | Production build |
| `npm run lint` | Run ESLint |

---

## Database

All tables prefixed `lc_` to share a multi-product Supabase project safely.

| Table | Purpose |
|-------|---------|
| `lc_orders` | Active + recent orders (active filtered to last 2h via `lc_active_orders` view) |
| `lc_orders_archive` | Cold storage for old bumped/cancelled rows |
| `lc_brand_config` | Single-row brand-wide config (menu/sides/tips/hold_times) |
| `lc_config` | Per-store config (settings only) |
| `lc_devices` | Kiosk heartbeat tracking |
| `lc_webhook_log` | Inbound Toast webhook diagnostics |

Functions:
- `lc_purge_old_logs(days_to_keep INT)` — prune `lc_webhook_log`
- `lc_archive_orders(days_to_keep INT)` — move bumped/cancelled rows older than N days into archive

See `DEPLOYMENT.md` for full setup.
