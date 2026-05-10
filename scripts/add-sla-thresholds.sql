-- Set the brand-wide SLA + cleanup thresholds anchored on the 10-min
-- brand promise. Idempotent: re-running merges keys without clobbering
-- any other hold_times config the admin has saved.
--
--   sla_target_minutes (8)  → amber band (internal target)
--   sla_breach_minutes (10) → red band   (brand promise breach)
--   max_ticket_minutes (12) → hard cleanup cutoff (sweep cron)
--
-- The 12-min cleanup is the answer to phantom orders accumulating
-- without depending on Toast sending completion events.

UPDATE lc_brand_config
SET
  hold_times = COALESCE(hold_times, '{}'::jsonb) || jsonb_build_object(
    'sla_target_minutes', 8,
    'sla_breach_minutes', 10,
    'max_ticket_minutes', 12
  ),
  updated_at = NOW()
WHERE id = 1;

-- Verify
SELECT id, hold_times, updated_at FROM lc_brand_config WHERE id = 1;
