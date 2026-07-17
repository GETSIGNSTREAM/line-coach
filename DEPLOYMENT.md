# Line Coach — Deployment Runbook

End-to-end setup for the kitchen display: Vercel (web app) + Supabase (data) + Raspberry Pi (in-store kiosk).

---

## Architecture

```
Toast POS  ──▶  /api/line-coach/webhook  (Vercel)
                       │
                       ▼
                 Supabase Postgres  ◀──  Admin UI (web)
                       │
                       ▼
                 Realtime channel
                       │
                       ▼
              Raspberry Pi kiosk  (Chromium full-screen)
              HDMI ▶ kitchen monitor
```

- **Web app** — Next.js 15, deployed on Vercel at `wildbird.coach`
- **Data** — Supabase (project `epfxzpemsbeljspfwuwe`, all tables prefixed `lc_`)
- **In-store** — Raspberry Pi 4 + HDMI monitor running Chromium kiosk against the Vercel URL

---

## Per-store kiosk: Raspberry Pi setup

### Hardware bill of materials (per store)

| Item | Notes |
|------|-------|
| Raspberry Pi 4 — 4 GB or 8 GB | 8 GB recommended for headroom |
| 32 GB+ microSD card (A2 rated) | SanDisk Extreme A2 is fine |
| Official Pi 4 PSU (5 V / 3 A USB-C) | Underpowered PSUs cause random reboots |
| Heatsink + fan case | Pi runs hot 24/7; passive-only fails over time |
| HDMI → HDMI cable (or micro-HDMI on Pi 4) | Pi 4 uses **micro-HDMI**, not full size |
| Kitchen-rated monitor 21"–32" | Any consumer 1080p TV/monitor works |
| Ethernet cable | Strongly preferred over Wi-Fi for kitchen RF noise |

### 1. Flash Raspberry Pi OS

Use **Raspberry Pi Imager** (https://www.raspberrypi.com/software/).

- OS: **Raspberry Pi OS (64-bit)** — full version (not Lite — we need a desktop session)
- Click the gear icon to pre-configure:
  - Hostname: `line-coach-{store}` (e.g. `line-coach-hollywood`)
  - Enable SSH (with password auth)
  - User: `pi`, password: store a generated one in 1Password
  - Wi-Fi if no Ethernet
  - Locale + timezone

Insert SD, boot the Pi, finish the desktop wizard, install updates.

### 2. Install kiosk dependencies

SSH in (`ssh pi@line-coach-hollywood.local`) and run:

```bash
sudo apt update
sudo apt install -y chromium-browser unclutter xdotool
```

### 3. Set audio output

```bash
sudo raspi-config
# → System Options → Audio → choose HDMI (or 3.5mm if external speaker)
```

Test:
```bash
speaker-test -t sine -f 1000 -l 1
```

If silent, fix this before continuing — browser audio depends on OS audio working first.

### 4. Set default volume

```bash
amixer set Master 85%
```

Staff adjust volume / mute at the **monitor** itself if needed.

### 5. Configure auto-launch

Create `~/.config/lxsession/LXDE-pi/autostart`:

```bash
mkdir -p ~/.config/lxsession/LXDE-pi
nano ~/.config/lxsession/LXDE-pi/autostart
```

Paste, replacing `hollywood` with the store slug:

```
@xset s off
@xset -dpms
@xset s noblank
@unclutter -idle 0
@chromium-browser --kiosk --noerrdialogs --disable-infobars --autoplay-policy=no-user-gesture-required --disable-features=TranslateUI --check-for-update-interval=31536000 https://wildbird.coach/?store=hollywood
```

The flag that matters: **`--autoplay-policy=no-user-gesture-required`** — this lets the chime/warning/danger beeps fire automatically without anyone tapping the screen.

### 6. Reboot

```bash
sudo reboot
```

The Pi should boot directly into the full-screen Line Coach display.

### 7. Auto-recovery (optional but recommended)

If Chromium ever crashes, restart it automatically. Create `/etc/systemd/system/chromium-watchdog.service`:

```ini
[Unit]
Description=Chromium kiosk watchdog
After=graphical.target

[Service]
ExecStart=/bin/bash -c 'while true; do pgrep chromium-browser > /dev/null || DISPLAY=:0 chromium-browser --kiosk --autoplay-policy=no-user-gesture-required https://wildbird.coach/?store=hollywood &; sleep 30; done'
Restart=always

[Install]
WantedBy=graphical.target
```

```bash
sudo systemctl enable chromium-watchdog
```

### 8. Verify in admin

Open `https://wildbird.coach/?store=hollywood&admin` → **Devices** tab.

Within ~2 minutes, the new Pi should appear in the device list with status **Online** (green dot) and a `display-hollywood-...` device ID. Rename it to something readable (e.g. "Hollywood Pi #1") via the DB or admin UI.

---

## Per-store store_id list

Hardcoded slugs (also in `lib/line-coach.js TOAST_LOCATION_MAP`):

| Store | URL parameter | Toast Location GUID |
|-------|---------------|---------------------|
| Hollywood | `?store=hollywood` | `8bc05d81-83ff-44ea-84e7-2c69c3e3f4c7` |
| Westwood | `?store=westwood` | `78575cd0-76ac-404b-90a1-2dd093d01c55` |
| 3rd & La Brea | `?store=3rd-la-brea` | `f5c0456a-7cfb-4e27-91fb-da1479c6bfa9` |
| Culver City | `?store=culver-city` | `6d44b706-08a6-49fc-a1e6-c79d66727105` |
| DTLA | `?store=dtla` | `d6a5e94b-d3cf-4a86-8022-47813e4c1d3b` |
| El Segundo | `?store=el-segundo` | `a06d8b87-37f4-4704-bbb8-acc92945d9fe` |
| Sandbox (simulator only) | `?store=sandbox` | — |

---

## Web app deployment (Vercel)

Auto-deploys from `main` branch on GitHub push.

- **Production URL:** https://wildbird.coach
- **Vercel project:** `wildbirds-projects/line-coach`
- **Env vars needed on Vercel:**
  - `NEXT_PUBLIC_SUPABASE_URL`
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  - `SUPABASE_SERVICE_ROLE_KEY`
  - `JWT_SECRET`
  - `TOAST_WEBHOOK_SECRET`
  - `ADMIN_PASSWORD` — shared admin-panel password. The login box posts it to `/api/line-coach/admin-login`, which returns a 30-day admin JWT. Rotate it to force all admins to re-login.
  - `CRON_SECRET` — bearer secret for the Vercel cron routes (`cleanup`, `daily-recap`, `feedback-tips/generate`). Vercel sends it automatically when set.
  - `ANTHROPIC_API_KEY` — Claude API key for feedback-tips generation (`lib/feedback-tips.js`). Without it the generate route reports per-store errors and displays fall back to curated tips.
  - `LC_FEEDBACK_TIPS_MODEL` *(optional)* — override the generation model (default `claude-opus-4-8`; set `claude-sonnet-5` or `claude-haiku-4-5` to cut cost).

### Feedback tips (Momos → Claude → display)

A daily cron (12:00 UTC, an hour before the daily recap) reads each store's
last 14 days of Momos reviews from this Supabase project, has Claude write
short bilingual reminders (coaching + positive reinforcement), and stores
them in `lc_feedback_tips`. Displays blend them into the slow-period
rotation labeled **CUSTOMER FEEDBACK**. Setup:

1. Run `scripts/add-feedback-tips.sql` in the Supabase SQL editor.
2. Confirm the Momos table/column names and location→slug map at the top of
   `lib/momos.js` against the live schema (placeholders until verified).
3. Set `ANTHROPIC_API_KEY` on Vercel.
4. Manual test: `curl -H "Authorization: Bearer $CRON_SECRET" "https://wildbird.coach/api/line-coach/feedback-tips/generate?store=hollywood&dry=1"`.
   Admins can also use **Feedback Tips → Regenerate Now** per store; the
   per-store on/off toggle is in **Settings**.

---

## Database (Supabase)

**Project:** `epfxzpemsbeljspfwuwe` (WINGMAN)

All tables / functions live in the SQL editor history. To bootstrap a fresh project, run `scripts/create-line-coach-tables.sql` end-to-end.

### Recommended pg_cron jobs

```sql
SELECT cron.schedule('lc-purge-logs', '0 3 * * *', $$SELECT lc_purge_old_logs(30)$$);
SELECT cron.schedule('lc-archive-orders', '15 3 * * *', $$SELECT lc_archive_orders(7)$$);
```

---

## Toast webhook configuration

Toast sends order events to: `https://wildbird.coach/api/line-coach/webhook`

Auth options the webhook accepts (in priority order):
1. `Toast-Signature` HMAC header (preferred) — verify with `TOAST_WEBHOOK_SECRET`
2. `Authorization: Bearer <TOAST_WEBHOOK_SECRET>` (legacy)
3. `User-Agent: Apache-HttpClient*` (Toast's default UA, kept for compat)

Every webhook hits the **lc_webhook_log** table for diagnostics. View in admin → **Webhooks** tab.

---

## Common operations

| Task | How |
|------|-----|
| Update menu / sides / tips brand-wide | Admin → Menu / Sides / Tips → edit → Save Changes |
| Hide stale orders past N min | Admin → Hold Times → `max_ticket_minutes` |
| Mute audio at one store | Use the monitor's hardware volume buttons |
| Reload all kiosks remotely | `for h in hollywood westwood ...; do ssh pi@line-coach-$h.local 'DISPLAY=:0 xdotool key F5'; done` |
| Check device health | Admin → Devices |
| Inspect Toast webhook flow | Admin → Webhooks (filter by status) |
| See bump times / volume | Admin → Analytics |
| Manual cleanup | Admin → Maintenance → Purge logs / Archive orders |

---

## Troubleshooting

**Display is blank / browser crashed**
- The watchdog service should restart Chromium within 30s. If not: `ssh pi@<host>.local 'sudo systemctl restart chromium-watchdog'` or power-cycle the Pi.

**Display is stuck on an old version**
- Hard reload: `ssh pi@<host>.local 'DISPLAY=:0 xdotool key ctrl+shift+r'`. If that doesn't help, kill and restart Chromium.

**No sound on chime**
- Test OS audio first: `speaker-test -t sine -f 1000 -l 1`
- Verify autoplay flag in autostart file
- Check monitor volume / mute

**Orders missing / not appearing**
- Admin → Webhooks tab → filter by status `parse_error` / `insert_error` / `unauthorized`
- Admin → Webhooks tab → POS Integration Health banner shows per-store last-success
- Confirm Toast is hitting the production URL, not a Vercel preview deploy

**Tickets piling up showing 60+ min**
- Admin → Hold Times → check `max_ticket_minutes` (default 60). Lower it if needed.
- One-time SQL cleanup of stuck rows: `UPDATE lc_orders SET status='bumped', bumped_at=now() WHERE status='active' AND created_at < now() - interval '30 minutes'`
