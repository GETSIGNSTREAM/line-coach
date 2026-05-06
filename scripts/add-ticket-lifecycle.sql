-- Ticket Lifecycle Migration
-- Run in Supabase SQL Editor

-- New columns for priority ordering and timing
ALTER TABLE lc_orders ADD COLUMN IF NOT EXISTS priority_rank INTEGER NOT NULL DEFAULT 30;
ALTER TABLE lc_orders ADD COLUMN IF NOT EXISTS toast_created_at TIMESTAMPTZ;
ALTER TABLE lc_orders ADD COLUMN IF NOT EXISTS estimated_ready_at TIMESTAMPTZ;

-- Index for priority-based sorting
CREATE INDEX IF NOT EXISTS idx_lc_orders_priority_rank ON lc_orders (priority_rank, fire_at);

-- Refresh view to include new columns
CREATE OR REPLACE VIEW lc_active_orders AS
SELECT *
FROM lc_orders
WHERE status = 'active'
  AND created_at > now() - INTERVAL '2 hours';
