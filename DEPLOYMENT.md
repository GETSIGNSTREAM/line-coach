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

Within ~2 minutes, the new Pi should appear in the device list with status **Online** (green dot). Rename it to something readable (e.g. "Hollywood Pi #1") via the DB or admin UI.

---

## Device pairing and the kill switch

Every screen that can **change** something — bump, unbump, sign a checklist, log a bird — now needs its own token. Read-only endpoints (orders, config) stay open, so an unpaired screen still renders the board; it just can't act on it.

This exists because the security model used to be "the Pi is bolted to the wall." Once screens move — an iPad at expo, one in a GM's hands — a URL that can clear a store's queue starts travelling, and there was previously no way to cut off one device.

### Pairing a screen

Admin → **Devices** → **+ Pair a screen**. Pick the store, optionally a station (blank = full board; comma-separated like `grill,fryer` for expo). The URL lands on your clipboard. Open it **once** on the target device.

The token is persisted to that device's `localStorage` on first load, so it survives a reload or a home-screen launch that drops the query string.

### Killing a lost or reassigned device

| Action | What it does | Use when |
|---|---|---|
| **Re-issue link** | New token, same device row and history. Every older link for that device stops working. | The URL got shared / texted around. |
| **Revoke** | Kills all its tokens, keeps the row visible and greyed out. Reversible via **Restore**. | iPad lost, someone left, screen temporarily out of service. |
| **Remove** | Deletes the row entirely. Also a permanent kill. | Decommissioned hardware. |

Revocation takes effect within ~30 seconds (there's a short in-memory cache on the auth lookup). **Revocation works even during the grace period below** — it is not gated by the enforcement flag.

### Rollout: `LC_REQUIRE_DEVICE_AUTH`

The six Pi kiosks are already live in stores pointed at untokenized URLs. Enforcing before they're paired would black out every kitchen, so enforcement is behind a flag.

**Phase 1 — deploy with the flag off (default).**
Unpaired writes are allowed and logged. Watch Vercel logs for `[device-auth] unauthenticated write allowed` to catch any writer you forgot about. Nothing changes for the kitchens.

**Phase 2 — pair every screen.**
Admin → Devices shows a gold **UNPAIRED** badge and a count banner for anything not yet paired. For each existing Pi, click **Pair**, copy the URL, then on the Pi:

```bash
ssh pi@line-coach-<store>.local
# Replace the URL in the kiosk autostart with the paired one
sed -i 's|https://wildbird.coach/?store=[^ ]*|<PASTE THE PAIRED URL HERE>|' \
  ~/.config/lxsession/LXDE-pi/autostart
# The watchdog unit has its own copy of the URL
sudo sed -i 's|https://wildbird.coach/?store=[^ ]*|<PASTE THE PAIRED URL HERE>|' \
  /etc/systemd/system/chromium-watchdog.service
sudo systemctl daemon-reload
sudo reboot
```

Confirm in Admin → Devices that the screen comes back **Online** with no UNPAIRED badge.

> Both files need the edit. The autostart handles a normal boot; the watchdog handles a Chromium crash. Miss the second one and the kiosk silently reverts to an unpaired URL the first time Chromium restarts.

**Phase 3 — enforce.**
Once no screen shows UNPAIRED, set `LC_REQUIRE_DEVICE_AUTH=1` in Vercel and **redeploy** (env changes don't reach warm instances without one). Rollback is flipping it back and redeploying.

After enforcement, an unpaired screen shows a red **"This screen is not paired"** banner rather than silently failing to bump.

> Note: opening the display from the admin's **View Display** button gives you an *unpaired* screen. It renders fine but won't bump once enforcement is on. Pair yourself a manager device if you need to act from it.

---

## Per-store kiosk: iPad setup

An iPad is a cheaper second (or replacement) screen than a kitchen-rated touchscreen, and it's the right hardware for an expo/prep station or a GM walking the floor. Line Coach runs as an installed web app — no App Store, no build.

**Landscape only.** Portrait doesn't have the horizontal room for the order column plus the sides rail, so the display shows a rotate prompt instead of a cramped layout. Mount accordingly.

### 1. Pair the screen first

Admin → **Devices** → **+ Pair a screen** (see *Device pairing and the kill switch* above). Copy the URL. You'll open it on the iPad in step 3.

### 2. iPad settings

| Setting | Value | Why |
|---|---|---|
| Settings → Display & Brightness → **Auto-Lock** | **Never** | Otherwise the board sleeps mid-service. |
| Settings → Accessibility → **Guided Access** | On, set a passcode | Pins the app; disables the home gesture. |
| Settings → Display & Brightness → **True Tone** | Off (optional) | Keeps food photos colour-accurate across screens. |

### 3. Install it

1. Open the paired URL in **Safari** (not Chrome — only Safari can install to the home screen).
2. Share → **Add to Home Screen** → name it *Line Coach*.
3. Launch from the home-screen icon. You should get **no Safari chrome** — no URL bar, no toolbars.
4. Tap the screen once. That's what unlocks audio: iOS blocks autoplay until a user gesture, so the first tap arms the new-order chime and the SLA alerts.
5. Confirm in Admin → Devices that it shows **Online** with no UNPAIRED badge.

The pairing token is saved to the iPad on first load, so the app stays paired even though iOS may drop the query string on later launches.

### 4. Lock it down

With Line Coach open, triple-click the side/home button → **Guided Access** → **Start**. Inside Guided Access options you can also disable the volume buttons and touch areas you don't want cooks hitting.

> **Guided Access does not survive a reboot.** After a power blip the iPad boots to the lock screen and a human has to unlock it and re-enter Guided Access. For a genuinely set-and-forget kiosk you need Apple Business Manager + an MDM (Jamf, Mosyle, Kandji) in **Single App Mode**, which re-arms itself automatically. Guided Access is the $0 option and it is meaningfully worse; MDM runs roughly $2–3/device/month. Worth deciding deliberately rather than discovering it after the first outage.

### What iOS will and won't do

| Works | Doesn't |
|---|---|
| Standalone launch, no browser chrome | Orientation lock — iOS ignores the manifest, hence the rotate prompt |
| Custom home-screen icon + charcoal splash | True fullscreen — the status bar is always visible |
| Audio alerts, after the first tap | Background execution — a backgrounded app has its timers throttled and drops the realtime socket |
| Safe-area padding around the notch | |

Backgrounding is handled: the display refetches on `visibilitychange`/`focus` and reconnects the Supabase channel with backoff, so a screen that sleeps and wakes catches up on its own.

### Troubleshooting

| Symptom | Fix |
|---|---|
| Red "This screen is not paired" banner | The token is missing, revoked, or superseded by a re-issue. Admin → Devices → **Re-issue link**, open it on the iPad. |
| Safari URL bar still visible | Launched from a Safari tab or a bookmark, not the home-screen icon. Re-add to home screen. |
| No sound | Tap the screen once. If still silent, check the mute switch and that Settings → Sounds volume isn't zero. |
| Screen dims mid-shift | Auto-Lock isn't set to Never. |
| Board looks cramped / rotate prompt shows | The iPad is in portrait. Rotate, and check the mount. |

---

## How deploys reach the kiosks

**The guarantee: a deploy reaches every kiosk by the next time that kitchen is quiet.** Not instantly.

The Pis launch Chromium once at boot against a fixed URL, and the watchdog only relaunches it if the process *dies*. Nothing about a Vercel deploy makes a running kiosk pick up new code on its own. Before this existed, a screen ran whatever bundle it downloaded at boot — for weeks — and the only remedy was SSHing into six machines to press F5. That is how the LEARN and RECIPES pills went missing in production after they shipped.

Now the display polls `/api/line-coach/version` every 5 minutes and reloads itself when the build id changes — **but only when the board is completely idle**:

- no tickets on the board, and it has been empty for at least 8 seconds (not just a gap between orders)
- no overlay open — checklist, bird log, recipes, order detail
- no bump in flight and no live undo window
- nobody mid hold-to-bump

If any of those is false the reload is **deferred, not cancelled** — it lands the moment the board goes quiet. Every store closes, so the worst case is overnight.

There is deliberately no nightly-reload cron: the idle gate already covers it, and a fixed schedule would make a fix shipped at noon wait until morning even when the kitchen was empty all afternoon.

**Verifying a deploy landed:** Admin → Devices shows each kiosk's last heartbeat, but heartbeats don't tell you the bundle version. The reliable check is to look at the screen. If you need it immediately, use the force-reload one-liner in the ops table.

**If a kiosk never seems to update**, the likely cause is `/api/line-coach/version` being cached somewhere — it ships `Cache-Control: no-store` precisely to prevent that. Confirm with `curl -sI https://wildbird.coach/api/line-coach/version | grep -i cache`.

---

## Feature gates: why a pill might not appear

Fresh code is necessary but not sufficient. Two header pills have gates that are **off by default**, and both are config, not code.

### LEARN pill

Requires `learn_mode_enabled` to be exactly `true` in **that store's** settings. It defaults to `false` and lives in `lc_config` (per store), not brand config.

→ Admin → **Settings** → select the store → tick **Learn Mode**. **Repeat for each store** — six times for the full estate.

### RECIPES pill

Requires at least one menu item or side to have non-empty `build_steps`. This is brand-wide, so it's a single action for the whole estate.

→ Admin → **Menu** → **Sync from Notion** (pulls build steps from the Culinary OS Line Build Guides). Or hand-enter via the CSV import's `build_steps_en` / `build_steps_es` columns.

### Propagation delay

The display polls config every 15 minutes, and the server caches brand config for 60 seconds. **A config change takes up to ~16 minutes to appear on a screen.** That is expected, not a fault. To see it immediately, force-reload that kiosk.

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
  - `NOTION_API_KEY` — internal Notion integration secret for Learn-mode recipe sync (`lib/recipe-sync.js`).
  - `NOTION_RECIPES_PAGE_ID` *(optional)* — override the Culinary OS page id if the Line Build Guides live elsewhere.
  - `LC_RECIPE_SYNC_MODEL` *(optional)* — override the translation model for recipe sync.

### Learn mode (Culinary OS → build steps → display)

Learn mode walks new hires through numbered entree build steps: in focus
mode the coaching panel becomes a BUILD STEPS walkthrough, and during slow
periods the display rotates flash-card walkthroughs (photo + name + steps).
Crew toggles it with the LEARN chip in the display header (per device);
the per-store master switch lives in Admin → Settings → Learn Mode
(default off — the chip is hidden until enabled).

Content comes from the Culinary OS in Notion (Layer 3 Line Build Guides):

1. Create an internal Notion integration (notion.so/my-integrations) and
   set `NOTION_API_KEY` on Vercel.
2. **Share the Culinary OS page with the integration** (page → ⋯ →
   Connections) — without this every sync call 404s.
3. Admin → Menu → **Sync from Notion**. The sync matches recipe titles to
   menu item names (unmatched titles are listed in the result), extracts
   the numbered steps from each build guide, and has Claude add Mexican
   Spanish translations. It overwrites hand edits.
4. Steps can also be hand-edited per item via Menu → Steps (N) — useful
   before Notion is wired up or for one-off overrides between syncs.

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
| Push a new deploy to the kiosks | Nothing — they self-update once the board is idle (see *How deploys reach the kiosks*) |
| Force a reload now (can't wait) | `for h in hollywood westwood ...; do ssh pi@line-coach-$h.local 'DISPLAY=:0 xdotool key F5'; done` |
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
