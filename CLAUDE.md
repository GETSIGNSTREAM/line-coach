# Line Coach — Development Guidelines

## Project Overview
Line Coach is a real-time kitchen display system for WILDBIRD restaurants. It replaces mental math and gut instinct with live, data-driven instructions — showing what to fire first, how to batch sides, and surfacing quality standards during slow periods.

## Tech Stack
- **Framework**: Next.js 15 (App Router)
- **Database**: Supabase (shared instance `epfxzpemsbeljspfwuwe`, `lc_` table prefix)
- **Auth**: JWT-based (lib/jwt.js, lib/auth.js)
- **Rate Limiting**: In-memory (lib/rate-limit.js)

## Architecture
- `lib/` — shared utilities (supabase client, auth, data layer)
- `app/api/line-coach/` — API routes for webhook, orders, config, devices, bump
- `app/page.js` — entry point, routes via URL params (`?store=hollywood`, `?admin`)
- `src/` — React components (LineCoachDisplay, LineCoachAdmin)

## Commands
- `npm run dev` — start dev server
- `npm run build` — production build
- `npm run lint` — run ESLint

## Database
- All tables use `lc_` prefix to avoid conflicts on shared Supabase instance
- Run `scripts/create-line-coach-tables.sql` in Supabase SQL editor to set up tables
- Tables: `lc_orders`, `lc_config`, `lc_devices`
- View: `lc_active_orders`

## Key Patterns
- Toast POS webhook posts orders to `/api/line-coach/webhook`
- Display uses Supabase Realtime subscriptions for live updates
- Orders are classified into lanes: Fire Now, Staging, On Deck
- Side batching groups identical sides across orders
- Quality Coach mode shows rotating tips during slow periods
