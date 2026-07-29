-- Bird oven log: batches of rotisserie birds tracked from oven-in →
-- pulled (warmer) → resolved (used up or shredded). Chicken is the
-- critical-path cook item (30–35 min), so the display gives cooks a
-- countdown per batch, and warmer age drives "use for meals first" /
-- "past carve window — shred" guidance (the 40-minute carve window is
-- a Culinary OS locked rule).
-- Run in the Supabase SQL editor (WINGMAN project), like the other
-- scripts in this directory.
--
-- Lifecycle is timestamps, not a status column:
--   pulled_at IS NULL                       → cooking (countdown vs
--                                             hold_times.bird_cook_minutes)
--   pulled_at set, resolved_at NULL         → in warmer (carve window vs
--                                             hold_times.bird_carve_window_minutes)
--   resolved_at set                         → terminal; resolution is
--                                             'used' (carved into service)
--                                             or 'shredded'
-- Thresholds live in lc_brand_config.hold_times (admin Hold Times tab),
-- not here — the log stores facts, the display applies policy.

CREATE TABLE IF NOT EXISTS lc_bird_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id TEXT NOT NULL,
  qty INT NOT NULL CHECK (qty > 0 AND qty <= 24),
  in_oven_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  pulled_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  resolution TEXT CHECK (resolution IN ('used', 'shredded')),
  -- Which kiosk logged it (lc-device-id-* localStorage id) — asserted,
  -- not authenticated, same as bump / checklist writes.
  device_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lc_bird_batches_store_open
  ON lc_bird_batches (store_id, in_oven_at)
  WHERE resolved_at IS NULL;

ALTER TABLE lc_bird_batches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on lc_bird_batches"
  ON lc_bird_batches FOR ALL
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Anon can read bird batches"
  ON lc_bird_batches FOR SELECT
  USING (true);

-- NOT in the supabase_realtime publication: displays poll (30s idle /
-- 10s with the log open) and countdowns tick client-side.
