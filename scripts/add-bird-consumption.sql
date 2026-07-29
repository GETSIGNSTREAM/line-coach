-- Smart bird reduction: incoming orders that consume carved chicken
-- (Whole/Half/Quarter Bird, admin-tagged items) automatically draw
-- down warmer inventory so cooks see real availability without
-- walking to the warmer. Run in the Supabase SQL editor (WINGMAN
-- project) after add-bird-log.sql.
--
-- consumed_qty accumulates against a batch's qty (FIFO, oldest pulled
-- first — matches "use the oldest bird" coaching). The original qty
-- is never mutated, so the audit trail stays honest: qty = birds
-- cooked, consumed_qty = birds drawn by orders. A fully consumed
-- batch auto-resolves as 'used'.
--
-- Bird units per menu item come from menu_items[].bird_units (admin
-- Menu tab), with name-based defaults in lib/line-coach.js
-- (whole=1, half=0.5, quarter=0.25). Consumption fires ONCE per Toast
-- order (on first insert, not on webhook re-deliveries).

ALTER TABLE lc_bird_batches
  ADD COLUMN IF NOT EXISTS consumed_qty NUMERIC NOT NULL DEFAULT 0;

-- FIFO draw-down. Row locks (FOR UPDATE) make concurrent webhook
-- deliveries serialize instead of double-spending a batch. Returns
-- the units actually consumed (less than p_units when the warmer
-- runs dry — the display just shows an empty warmer; we don't track
-- unmet demand yet).
CREATE OR REPLACE FUNCTION lc_consume_birds(p_store_id TEXT, p_units NUMERIC)
RETURNS NUMERIC AS $$
DECLARE
  remaining NUMERIC := p_units;
  b RECORD;
  take NUMERIC;
BEGIN
  IF remaining IS NULL OR remaining <= 0 THEN RETURN 0; END IF;
  FOR b IN
    SELECT id, qty, consumed_qty FROM lc_bird_batches
    WHERE store_id = p_store_id AND pulled_at IS NOT NULL AND resolved_at IS NULL
    ORDER BY pulled_at ASC
    FOR UPDATE
  LOOP
    take := LEAST(b.qty - b.consumed_qty, remaining);
    IF take > 0 THEN
      UPDATE lc_bird_batches SET
        consumed_qty = consumed_qty + take,
        resolved_at = CASE WHEN consumed_qty + take >= qty THEN now() ELSE resolved_at END,
        resolution  = CASE WHEN consumed_qty + take >= qty THEN 'used' ELSE resolution END,
        updated_at = now()
      WHERE id = b.id;
      remaining := remaining - take;
    END IF;
    EXIT WHEN remaining <= 0;
  END LOOP;
  RETURN p_units - remaining;
END;
$$ LANGUAGE plpgsql;
