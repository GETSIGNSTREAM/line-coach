-- Per-device auth + kill switch. Until now the only client was a
-- Raspberry Pi bolted to the wall behind the line, so "who is allowed
-- to bump?" was answered by the building. Putting the display on iPads
-- — mounted at the line, roaming at expo, carried by a GM — moves the
-- URL somewhere a wall can no longer protect it.
-- Run in the Supabase SQL editor (WINGMAN project), like the other
-- scripts in this directory.
--
-- Deliberately NOT a new table: the existing lc_devices row IS the
-- revocation record. Two things fall out of that:
--   * deleteDevice() (lib/line-coach.js) revokes for free, because
--     requireDevice requires the row to exist — the admin's existing
--     "Remove" button becomes a hard kill with no new wiring.
--   * token_issued_at makes re-issue implicitly revoke the prior token
--     (reject when payload.iat < token_issued_at), so "this iPad's link
--     got shared in a group chat" is one click and keeps the device's
--     heartbeat history intact.
--
-- Existing rows get NULLs and keep working: requireDevice treats a NULL
-- token_issued_at as "never paired", which only matters once
-- LC_REQUIRE_DEVICE_AUTH is flipped on. That ordering is what lets the
-- already-deployed kiosks keep running while devices are provisioned.

ALTER TABLE lc_devices
  -- Which slice of the board this screen shows. NULL = the full board.
  -- Values match ALLOWED_STATIONS (oven, grill, fryer, line, cold,
  -- hot_hold, grab); comma-separated is allowed so one expo screen can
  -- cover 'grill,fryer'. Read as a fallback when ?station= is absent.
  ADD COLUMN IF NOT EXISTS station         TEXT,
  -- Watermark for implicit revoke-on-reissue. Compared against the
  -- JWT's iat claim.
  ADD COLUMN IF NOT EXISTS token_issued_at TIMESTAMPTZ,
  -- The kill switch. Non-NULL = every token for this device is dead.
  ADD COLUMN IF NOT EXISTS revoked_at      TIMESTAMPTZ,
  -- Free text for the admin UI ("left in a rideshare", "Ana left").
  ADD COLUMN IF NOT EXISTS revoked_reason  TEXT;

-- requireDevice does one lookup per write (bump / unbump / heartbeat /
-- checklist / bird-log). device_id is already the PK, so that read is
-- covered; this partial index keeps the admin's "show me live devices"
-- filter cheap as revoked rows accumulate.
CREATE INDEX IF NOT EXISTS idx_lc_devices_active
  ON lc_devices (store_id)
  WHERE revoked_at IS NULL;

-- ══════════════════════════════════════════════════════════
-- Webhook auth telemetry
-- ══════════════════════════════════════════════════════════
-- The Toast webhook currently authenticates three ways, and one of them
-- is a User-Agent string containing 'Apache-HttpClient' with no secret
-- at all (webhook/route.js). That branch has to go, but deleting it
-- blind would stop order ingest brand-wide if Toast is actually relying
-- on it — the board would go empty mid-service at all six stores.
--
-- So: record how each inbound request authenticated, watch for 48-72h
-- across every store and both order-placed and order-modified events,
-- and only remove the bypass once the user_agent count is zero.
ALTER TABLE lc_webhook_log
  ADD COLUMN IF NOT EXISTS auth_method TEXT;  -- 'hmac' | 'bearer' | 'user_agent'
