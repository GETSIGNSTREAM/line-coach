-- Line Coach Tables
-- Run this in the Supabase SQL Editor for the shared instance (epfxzpemsbeljspfwuwe)
-- All tables use lc_ prefix to avoid conflicts

-- ══════════════════════════════════════════════════════════
-- Orders table
-- ══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS lc_orders (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  store_id TEXT NOT NULL,
  toast_order_id TEXT,
  order_number TEXT,
  items JSONB NOT NULL DEFAULT '[]',
  sides JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'bumped', 'cancelled')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('rush', 'normal')),
  fire_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  bumped_at TIMESTAMPTZ,
  notes TEXT,
  dining_option TEXT,
  customer_name TEXT
);

CREATE INDEX IF NOT EXISTS idx_lc_orders_store_status ON lc_orders (store_id, status);
CREATE INDEX IF NOT EXISTS idx_lc_orders_fire_at ON lc_orders (fire_at);
CREATE INDEX IF NOT EXISTS idx_lc_orders_toast_id ON lc_orders (toast_order_id);

-- ══════════════════════════════════════════════════════════
-- Active orders view (non-bumped, non-cancelled, last 2 hours)
-- ══════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW lc_active_orders AS
SELECT *
FROM lc_orders
WHERE status = 'active'
  AND created_at > now() - INTERVAL '2 hours';

-- ══════════════════════════════════════════════════════════
-- Config table (one row per store)
-- ══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS lc_config (
  store_id TEXT PRIMARY KEY,
  menu_items JSONB NOT NULL DEFAULT '[]',
  sides JSONB NOT NULL DEFAULT '[]',
  quality_tips JSONB NOT NULL DEFAULT '[]',
  hold_times JSONB NOT NULL DEFAULT '{"fire_now": 5, "staging": 15, "on_deck": 30}',
  settings JSONB NOT NULL DEFAULT '{"quality_coach_interval": 30, "side_batch_threshold": 3}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ══════════════════════════════════════════════════════════
-- Devices table (kiosk heartbeat tracking)
-- ══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS lc_devices (
  device_id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL,
  device_name TEXT,
  device_type TEXT DEFAULT 'kds',
  last_heartbeat TIMESTAMPTZ NOT NULL DEFAULT now(),
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  meta JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_lc_devices_store ON lc_devices (store_id);

-- ══════════════════════════════════════════════════════════
-- Enable Realtime on lc_orders
-- ══════════════════════════════════════════════════════════
ALTER PUBLICATION supabase_realtime ADD TABLE lc_orders;

-- ══════════════════════════════════════════════════════════
-- RLS Policies
-- ══════════════════════════════════════════════════════════
ALTER TABLE lc_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE lc_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE lc_devices ENABLE ROW LEVEL SECURITY;

-- Allow service role full access (API routes use service key)
CREATE POLICY "Service role full access" ON lc_orders FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON lc_config FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON lc_devices FOR ALL USING (true) WITH CHECK (true);

-- Allow anon read on orders (for realtime subscriptions on display)
CREATE POLICY "Anon can read orders" ON lc_orders FOR SELECT USING (true);
CREATE POLICY "Anon can read config" ON lc_config FOR SELECT USING (true);

-- ══════════════════════════════════════════════════════════
-- WILDBIRD Seed Data
-- ══════════════════════════════════════════════════════════
INSERT INTO lc_config (store_id, menu_items, sides, quality_tips, hold_times, settings)
VALUES (
  'hollywood',
  '[
    {"name": "Classic Smash Burger", "station": "grill", "cook_time": 6},
    {"name": "Double Smash Burger", "station": "grill", "cook_time": 7},
    {"name": "Crispy Chicken Sandwich", "station": "fryer", "cook_time": 8},
    {"name": "Grilled Chicken Sandwich", "station": "grill", "cook_time": 9},
    {"name": "Nashville Hot Chicken", "station": "fryer", "cook_time": 8},
    {"name": "Veggie Burger", "station": "grill", "cook_time": 6},
    {"name": "Chicken Tenders", "station": "fryer", "cook_time": 7},
    {"name": "Fish Sandwich", "station": "fryer", "cook_time": 8},
    {"name": "Hot Dog", "station": "grill", "cook_time": 5}
  ]'::jsonb,
  '[
    {"name": "French Fries", "station": "fryer", "cook_time": 4, "batch_size": 4},
    {"name": "Onion Rings", "station": "fryer", "cook_time": 4, "batch_size": 3},
    {"name": "Sweet Potato Fries", "station": "fryer", "cook_time": 5, "batch_size": 4},
    {"name": "Mac & Cheese", "station": "hot_hold", "cook_time": 0, "batch_size": 8},
    {"name": "Coleslaw", "station": "cold", "cook_time": 0, "batch_size": 8},
    {"name": "Side Salad", "station": "cold", "cook_time": 0, "batch_size": 6},
    {"name": "Loaded Fries", "station": "fryer", "cook_time": 5, "batch_size": 3},
    {"name": "Tater Tots", "station": "fryer", "cook_time": 4, "batch_size": 4},
    {"name": "Corn on the Cob", "station": "grill", "cook_time": 6, "batch_size": 4},
    {"name": "Pickles & Peppers", "station": "cold", "cook_time": 0, "batch_size": 10}
  ]'::jsonb,
  '[
    "Check burger patty thickness — should be 1/4 inch before pressing.",
    "Buns should be toasted golden, not pale or charred.",
    "Fry oil temp should be 350°F — check every 30 minutes.",
    "Lettuce and tomato should be prepped fresh every 2 hours.",
    "Wipe down the flat top between every 5th order.",
    "Check chicken internal temp — must hit 165°F.",
    "Shake the fry basket twice during cooking for even crispness.",
    "Sauce portions: 1 oz squeeze per sandwich, 2 oz for dipping.",
    "Wrap sandwiches tightly — no air gaps in the foil.",
    "Stack burgers: bottom bun → sauce → patty → cheese → toppings → top bun.",
    "Clear the bump bar every 10 minutes to keep the board accurate.",
    "Rotate stock: first in, first out for all proteins.",
    "Clean the thermometer probe between uses — food safety first.",
    "Side containers should be filled to the line, not over.",
    "Hot hold items max 30 minutes — toss and refresh after that.",
    "Keep the pass clean — no clutter between expo and window."
  ]'::jsonb,
  '{"fire_now": 5, "staging": 15, "on_deck": 30}'::jsonb,
  '{"quality_coach_interval": 30, "side_batch_threshold": 3}'::jsonb
)
ON CONFLICT (store_id) DO NOTHING;
